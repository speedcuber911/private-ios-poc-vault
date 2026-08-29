import Foundation

/// The node-side surface the direct-login flow needs. `CodexClient` conforms;
/// tests substitute a stub. The first block is the modern path (harness login
/// ops with input/callback/cancel). The second block is what the fallback
/// rides on any other machine: the harness status list and bounded exec —
/// deliberately nothing else, because everything richer (terminals, jobs)
/// runs through the Codex app-server, which itself needs an authenticated
/// codex — exactly what a fresh machine doesn't have yet.
protocol HarnessLoginClient: AnyObject {
    func startHarnessLogin(provider: CodexProvider) async throws -> RelayHarnessOp
    func fetchHarnessOp(id: String) async throws -> RelayHarnessOp
    func fetchHarnessOps(limit: Int) async throws -> [RelayHarnessOp]
    func sendHarnessLoginInput(id: String, text: String) async throws -> RelayHarnessOp
    func forwardHarnessLoginCallback(id: String, url: URL) async throws -> RelayHarnessOp
    func cancelHarnessOp(id: String) async throws -> RelayHarnessOp

    func fetchHarnesses() async throws -> [RelayHarnessStatus]
    func execCommand(_ command: String, timeoutMs: Int?) async throws -> CodexExecResult
}

extension CodexClient: HarnessLoginClient {}

/// Drives direct provider login on the machine from this iPhone, with no
/// laptop in the loop: start the provider CLI's own login on the node →
/// surface the sign-in URL (and user code, when the provider uses one) →
/// complete it either by relaying the localhost OAuth callback the in-app
/// browser captured (Codex) or by delivering the code the user pasted from
/// the provider's site (paste-back flows) → connected when the machine
/// confirms. Credentials land in the machine's runner home; nothing is
/// stored on the phone.
///
/// Two engines, chosen automatically:
/// - **Op mode** (modern relayd): `POST /v1/harness/:provider/login` plus the
///   op-scoped input/callback/cancel routes.
/// - **Exec fallback** (any machine): launch the CLI's login on the node via
///   `POST /v1/exec` under util-linux `script` — a real PTY, detached with
///   setsid, output flushed to a log file, stdin fed from a FIFO — then poll
///   that log through exec, scrape the URL/user code here, type the pasted
///   code into the FIFO, replay a captured localhost callback against the
///   node's loopback, and treat the harness list's `loggedIn: true` as the
///   machine's confirmation. Exec is the one primitive with no dependency on
///   an authenticated provider (Relay's terminals ride the Codex app-server,
///   which is the very thing a fresh machine can't run yet). The fallback
///   engages when the modern routes are missing (404), when the op dies
///   before producing a link, or when no link appears within
///   `opLinkPatience`.
///
/// Status is always explicit text (Editorial Ember) — never a colored dot.
@MainActor
final class ProviderLoginFlowModel: ObservableObject {
    enum Step: Equatable {
        case idle
        case starting
        /// The login is live on the machine. `verificationURL` may still be
        /// nil for the first moments while the CLI prints its output.
        case waitingForSignIn(RelayHarnessOp)
        case completing
        case succeeded
        case failed(String)
    }

    static let startFailedMessage =
        "Relay couldn't start the sign-in on your machine. Try again."
    static let notReachableMessage =
        "Couldn't reach your machine. Check your connection and try again."
    static let expiredMessage =
        "The sign-in timed out on the machine. Start it again when you're ready."
    static let cancelledMessage =
        "The sign-in was cancelled."
    static let failedMessage =
        "The sign-in didn't complete. Try again."
    static let completionFailedMessage =
        "Relay couldn't hand the sign-in result to your machine. Try again."

    let provider: CodexProvider
    @Published private(set) var step: Step = .idle
    @Published var pastedCode: String = ""
    /// What the flow is doing while there is nothing to show yet — surfaced
    /// under the waiting spinner so a stall names its stage instead of
    /// looking like a generic hang.
    @Published private(set) var progressDetail: String?
    /// Tail of the machine login's (ANSI-stripped) output while the fallback
    /// runs. Shown on the sheet whenever there is no link yet, so a stalled
    /// sign-in displays exactly what the machine said instead of a spinner
    /// with a secret.
    @Published private(set) var terminalTail: String?

    /// True while the exec fallback engine is driving the login.
    var isUsingTerminalEngine: Bool {
        if case .exec = engine { return true }
        return false
    }

    /// Poll cadences and patience windows; tests shrink them.
    var pollInterval: Duration = .seconds(1)
    var connectedPollInterval: Duration = .seconds(3)
    var opLinkPatience: Duration = .seconds(8)
    var overallDeadline: Duration = .seconds(600)

    private enum Engine: Equatable {
        case op(id: String)
        case exec(logPath: String, inputPath: String, launchCommand: String)
    }

    private let client: HarnessLoginClient
    private var engine: Engine?
    private var pollTask: Task<Void, Never>?
    private var connectedWatchTask: Task<Void, Never>?
    private var fallbackTimerTask: Task<Void, Never>?
    private var sawSignInArtifacts = false
    private var usedExecFallback = false

    init(client: HarnessLoginClient, provider: CodexProvider) {
        self.client = client
        self.provider = provider
    }

    deinit {
        pollTask?.cancel()
        connectedWatchTask?.cancel()
        fallbackTimerTask?.cancel()
    }

    /// True when the flow should finish Codex-style: an in-app browser that
    /// captures the provider's redirect to its localhost login server. All
    /// other providers finish by pasting the code their sign-in page shows.
    var usesLocalCallback: Bool {
        provider == .codex
    }

    /// Each provider's CLI binary and login entry point. The command is the
    /// logical form ("codex login"); the fallback launches an absolute path
    /// when it can resolve one, because a headless machine's PATH often
    /// misses the npm-global bin dir (the exact incident STATUS.md records
    /// for /opt/node/bin).
    var loginBinaryName: String {
        switch provider {
        case .claude:
            return "claude"
        case .cursor:
            return "cursor-agent"
        case .kimi:
            return "kimi"
        case .codex, .bedrock, .azure:
            return "codex"
        }
    }

    private var loginArgument: String {
        provider == .claude ? "setup-token" : "login"
    }

    var terminalLoginCommand: String {
        "\(loginBinaryName) \(loginArgument)"
    }

    func start() async {
        cancelBackgroundWork()
        engine = nil
        sawSignInArtifacts = false
        usedExecFallback = false
        progressDetail = nil
        terminalTail = nil
        step = .starting
        do {
            adoptOp(try await client.startHarnessLogin(provider: provider))
        } catch let error as CodexClientError where error.statusCode == 409 {
            // A login for this provider is already running on the machine —
            // usually an earlier attempt from this phone. Adopt it instead of
            // failing so the user never has to wait out the old op.
            if let existing = try? await client.fetchHarnessOps(limit: 50)
                .first(where: { $0.provider == provider && $0.action == "login" && $0.isActive }) {
                adoptOp(existing)
            } else {
                await startExecFallback()
            }
        } catch let error as CodexClientError where error.statusCode == 404 {
            // No harness login op route at all — drive it through exec.
            await startExecFallback()
        } catch {
            step = .failed(Self.notReachableMessage)
        }
    }

    /// Send the code the user pasted from the provider's sign-in page. Op
    /// mode types it into the login CLI's stdin via the machine API; the
    /// fallback writes it into the FIFO feeding the login's PTY.
    func submitPastedCode() async {
        let text = pastedCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        switch engine {
        case .op(let id):
            step = .completing
            do {
                _ = try await client.sendHarnessLoginInput(id: id, text: text)
                startConnectedWatcher()
            } catch let error as CodexClientError where error.statusCode == 404 {
                // This machine can't reach that stdin (route predates the
                // feature). Rerun the login through exec, where typing works.
                await startExecFallback()
            } catch {
                stopEverythingKeepingStep()
                step = .failed(Self.completionFailedMessage)
            }
        case .exec(_, let inputPath, _):
            guard let quoted = Self.shellSingleQuoted(text) else {
                step = .failed(Self.completionFailedMessage)
                return
            }
            step = .completing
            do {
                let result = try await client.execCommand("printf '%s\\n' \(quoted) > \(inputPath)", timeoutMs: 8000)
                if result.exitCode == 0 {
                    startConnectedWatcher()
                } else {
                    stopEverythingKeepingStep()
                    step = .failed(Self.completionFailedMessage)
                }
            } catch {
                stopEverythingKeepingStep()
                step = .failed(Self.completionFailedMessage)
            }
        case nil:
            break
        }
    }

    /// Relay a captured localhost redirect (the provider's OAuth callback) to
    /// the CLI's login server on the machine.
    func deliverBrowserCallback(_ url: URL) async {
        switch engine {
        case .op(let id):
            step = .completing
            do {
                _ = try await client.forwardHarnessLoginCallback(id: id, url: url)
            } catch let error as CodexClientError where error.statusCode == 404 {
                // Route predates the feature — the login server still runs on
                // the machine's loopback, so replay the callback through exec.
                await replayCallbackViaExec(url)
            } catch {
                stopEverythingKeepingStep()
                step = .failed(Self.completionFailedMessage)
            }
        case .exec:
            step = .completing
            await replayCallbackViaExec(url)
        case nil:
            break
        }
    }

    /// The in-app browser asks this for every navigation: a redirect to the
    /// provider's localhost login server must never load on the phone —
    /// nothing listens there — and is handed to the machine instead.
    nonisolated static func isLocalLoginCallback(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http", let host = url.host?.lowercased() else { return false }
        return host == "localhost" || host == "127.0.0.1"
    }

    func cancel() async {
        let current = engine
        cancelBackgroundWork()
        engine = nil
        switch current {
        case .op(let id):
            _ = try? await client.cancelHarnessOp(id: id)
        case .exec:
            await cleanUpExecLogin()
        case nil:
            break
        }
        step = .idle
    }

    // MARK: - Op engine

    private func adoptOp(_ op: RelayHarnessOp) {
        engine = .op(id: op.id)
        applyOp(op, keepCompleting: false)
        startOpPolling(opID: op.id)
        armOpLinkPatience()
    }

    private func applyOp(_ op: RelayHarnessOp, keepCompleting: Bool) {
        guard case .op(id: op.id) = engine else { return }
        if op.verificationURL != nil || op.userCode != nil { sawSignInArtifacts = true }
        switch op.status {
        case .queued, .running, .waitingForUser:
            // After the code/callback went in, the CLI needs a moment to
            // finish; don't bounce the UI back to the sign-in screen.
            if keepCompleting || step == .completing { return }
            step = .waitingForSignIn(op)
        case .succeeded:
            finishConnected()
        case .expired, .failed, .cancelled, .unknown:
            // A login that died before it ever produced a link is the shape of
            // a CLI that won't talk without a TTY — the exec fallback gives it
            // one, so try that once before reporting failure.
            if !sawSignInArtifacts && !usedExecFallback {
                Task { await startExecFallback() }
                return
            }
            stopEverythingKeepingStep()
            switch op.status {
            case .expired:
                step = .failed(Self.expiredMessage)
            case .cancelled:
                step = .failed(Self.cancelledMessage)
            default:
                step = .failed(Self.failedMessage)
            }
        }
    }

    private func startOpPolling(opID: String) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: self.pollInterval)
                if Task.isCancelled { return }
                guard case .op(id: opID) = self.engine else { return }
                guard let current = try? await self.client.fetchHarnessOp(id: opID) else { continue }
                self.applyOp(current, keepCompleting: false)
                if !current.isActive { return }
            }
        }
    }

    /// A live op that produces no link within the patience window is the
    /// stalled shape (old machine build, or a login variant that needs a
    /// TTY): switch to the exec fallback instead of waiting forever.
    private func armOpLinkPatience() {
        fallbackTimerTask?.cancel()
        fallbackTimerTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.opLinkPatience)
            if Task.isCancelled { return }
            guard case .op = self.engine, !self.sawSignInArtifacts, !self.usedExecFallback else { return }
            if case .waitingForSignIn = self.step {
                await self.startExecFallback()
            } else if self.step == .starting {
                await self.startExecFallback()
            }
        }
    }

    // MARK: - Exec fallback engine

    private var execLogPath: String { "/tmp/relay-phone-login-\(provider.rawValue).log" }
    private var execInputPath: String { "/tmp/relay-phone-login-\(provider.rawValue).in" }

    private func startExecFallback() async {
        guard !usedExecFallback else { return }
        usedExecFallback = true
        cancelBackgroundWork()
        engine = nil
        step = .starting
        progressDetail = "Preparing the sign-in on your machine…"

        // Clear any stray login from earlier attempts — a silent
        // `codex login` still holds its localhost port. Best effort.
        _ = try? await client.execCommand(
            "pkill -f '\(loginBinaryName) \(loginArgument)' >/dev/null 2>&1; true",
            timeoutMs: 8000
        )

        // A headless machine's PATH often misses the npm-global bin dir;
        // resolve an absolute path so the launch can't die as "command not
        // found".
        var binary = loginBinaryName
        if let resolved = await resolveLoginBinaryPath() {
            binary = resolved
        }

        let launch = Self.execLaunchCommand(
            binary: binary,
            argument: loginArgument,
            logPath: execLogPath,
            inputPath: execInputPath
        )
        do {
            let result = try await client.execCommand(launch, timeoutMs: 15000)
            guard result.exitCode == 0 else {
                step = .failed(Self.startFailedMessage)
                return
            }
        } catch {
            step = .failed(Self.notReachableMessage)
            return
        }

        engine = .exec(logPath: execLogPath, inputPath: execInputPath, launchCommand: launch)
        step = .waitingForSignIn(RelayHarnessOp(id: "exec:\(provider.rawValue)", provider: provider))
        progressDetail = "Running `\(terminalLoginCommand)` on your machine…"
        startLogPolling(logPath: execLogPath)
        startConnectedWatcher()
    }

    private func startLogPolling(logPath: String) {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: self.pollInterval)
                if Task.isCancelled { return }
                guard case .exec(let currentLog, _, _) = self.engine, currentLog == logPath else { return }
                guard let result = try? await self.client.execCommand(
                    "tail -c 4000 \(logPath) 2>/dev/null; true",
                    timeoutMs: 8000
                ) else { continue }
                self.ingestLoginOutput(result.stdout)
            }
        }
    }

    private func ingestLoginOutput(_ text: String) {
        let stripped = Self.strippedTerminalText(text)
        let tail = String(stripped.suffix(360)).trimmingCharacters(in: .whitespacesAndNewlines)
        terminalTail = tail.isEmpty ? nil : tail

        // A login that errored will never produce a link — surface the
        // machine's own words now instead of spinning until the deadline.
        if !sawSignInArtifacts, step != .completing, step != .succeeded,
           let errorLine = Self.firstMachineError(in: stripped) {
            stopEverythingKeepingStep()
            step = .failed("The sign-in failed on the machine: \(errorLine)")
            return
        }

        let artifacts = Self.scanSignInArtifacts(in: stripped)
        guard artifacts.url != nil || artifacts.code != nil else { return }
        sawSignInArtifacts = true
        progressDetail = nil
        guard step != .completing, step != .succeeded else { return }
        let synthesized = RelayHarnessOp(
            id: "exec:\(provider.rawValue)",
            provider: provider,
            verificationURL: artifacts.url,
            userCode: artifacts.code
        )
        if case .waitingForSignIn(let current) = step,
           current.verificationURL == synthesized.verificationURL,
           current.userCode == synthesized.userCode {
            return
        }
        step = .waitingForSignIn(synthesized)
    }

    /// Resolve the provider CLI's absolute path on the machine, via one
    /// bounded exec: PATH lookup first, then the conventional headless
    /// locations (node's own bin dir is where npm-global CLIs live).
    private func resolveLoginBinaryPath() async -> String? {
        let name = loginBinaryName
        let probe = "command -v \(name) 2>/dev/null || "
            + "for d in \"$(dirname \"$(command -v node 2>/dev/null || echo /nonexistent)\")\" "
            + "/opt/node/bin /opt/node22/bin /usr/local/bin /usr/bin; do "
            + "[ -x \"$d/\(name)\" ] && { echo \"$d/\(name)\"; break; }; done"
        guard let result = try? await client.execCommand(probe, timeoutMs: 8000) else { return nil }
        let line = result.stdout
            .split(whereSeparator: \.isNewline)
            .first
            .map { $0.trimmingCharacters(in: .whitespaces) }
        guard let line, line.hasPrefix("/"), !line.contains(" "), !line.contains("'") else { return nil }
        return line
    }

    private func cleanUpExecLogin() async {
        _ = try? await client.execCommand(
            "pkill -f '\(loginBinaryName) \(loginArgument)' >/dev/null 2>&1; rm -f \(execLogPath) \(execInputPath); true",
            timeoutMs: 8000
        )
    }

    // MARK: - Shared completion

    private func replayCallbackViaExec(_ url: URL) async {
        guard let command = Self.execReplayCommand(for: url) else {
            stopEverythingKeepingStep()
            step = .failed(Self.completionFailedMessage)
            return
        }
        do {
            let result = try await client.execCommand(command, timeoutMs: 15000)
            if result.exitCode == 0 {
                startConnectedWatcher()
            } else {
                stopEverythingKeepingStep()
                step = .failed(Self.completionFailedMessage)
            }
        } catch {
            stopEverythingKeepingStep()
            step = .failed(Self.completionFailedMessage)
        }
    }

    /// The machine's own answer is the source of truth for both engines: the
    /// harness list flips `loggedIn` the moment the CLI stores its session.
    private func startConnectedWatcher() {
        connectedWatchTask?.cancel()
        connectedWatchTask = Task { [weak self] in
            guard let self else { return }
            let started = ContinuousClock.now
            while !Task.isCancelled {
                try? await Task.sleep(for: self.connectedPollInterval)
                if Task.isCancelled { return }
                if let statuses = try? await self.client.fetchHarnesses(),
                   statuses.first(where: { $0.provider == self.provider })?.loggedIn == true {
                    self.finishConnected()
                    return
                }
                if ContinuousClock.now - started > self.overallDeadline {
                    if self.step == .completing || self.isWaiting {
                        self.stopEverythingKeepingStep()
                        self.step = .failed(Self.expiredMessage)
                    }
                    return
                }
            }
        }
    }

    private var isWaiting: Bool {
        if case .waitingForSignIn = step { return true }
        return false
    }

    private func finishConnected() {
        let current = engine
        cancelBackgroundWork()
        engine = nil
        if case .exec = current {
            Task { await self.cleanUpExecLogin() }
        }
        progressDetail = nil
        step = .succeeded
    }

    private func stopEverythingKeepingStep() {
        let current = engine
        cancelBackgroundWork()
        engine = nil
        if case .exec = current {
            Task { await self.cleanUpExecLogin() }
        }
    }

    private func cancelBackgroundWork() {
        pollTask?.cancel()
        pollTask = nil
        connectedWatchTask?.cancel()
        connectedWatchTask = nil
        fallbackTimerTask?.cancel()
        fallbackTimerTask = nil
    }

    // MARK: - Pure helpers (testable)

    /// The one-shot launcher the fallback runs through `POST /v1/exec`:
    /// - a FIFO feeds the login's stdin so paste-back codes can be typed later
    ///   (a persistent writer fd keeps it open so the CLI never sees EOF);
    /// - util-linux `script` gives the CLI a real PTY and flushes every write
    ///   to the log (`-f`), which is what the phone polls; a machine without
    ///   `script` falls back to plain redirection;
    /// - `setsid` detaches the whole thing from exec's process group so the
    ///   endpoint's timeout kill can't take the login with it.
    nonisolated static func execLaunchCommand(
        binary: String,
        argument: String,
        logPath: String,
        inputPath: String
    ) -> String {
        let command = "\(binary) \(argument)"
        return "rm -f \(logPath) \(inputPath) && mkfifo \(inputPath) && "
            + "if command -v script >/dev/null 2>&1; then "
            + "setsid bash -c 'exec 3>\(inputPath); exec script -qefc \"\(command)\" \(logPath) < \(inputPath)' >/dev/null 2>&1 & "
            + "else "
            + "setsid bash -c 'exec 3>\(inputPath); exec \(command) < \(inputPath) >> \(logPath) 2>&1' >/dev/null 2>&1 & "
            + "fi; echo launched"
    }

    /// Remove ANSI control sequences (CSI, OSC, and lone escapes) plus
    /// carriage returns, so URL/code scanning sees plain text.
    nonisolated static func strippedTerminalText(_ text: String) -> String {
        var output = text
        for pattern in [
            "\u{1B}\\[[0-9;:?]*[ -/]*[@-~]", // CSI … final byte
            "\u{1B}\\][^\u{07}\u{1B}]*(\u{07}|\u{1B}\\\\)", // OSC … BEL / ST
            "\u{1B}[@-Z\\\\^_\\-]", // two-byte escapes
            "\r",
        ] {
            output = output.replacingOccurrences(of: pattern, with: "", options: .regularExpression)
        }
        return output
    }

    /// The failure shapes a login command prints instead of a link. Bounded
    /// to one trimmed line so the sheet can quote the machine verbatim.
    nonisolated static func firstMachineError(in text: String) -> String? {
        let markers = [
            "command not found",
            "No such file or directory",
            "Permission denied",
            "address already in use",
            "EADDRINUSE",
        ]
        for rawLine in text.split(whereSeparator: \.isNewline) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if markers.contains(where: { line.localizedCaseInsensitiveContains($0) }) {
                return String(line.prefix(160))
            }
        }
        return nil
    }

    /// Mirror of relayd's login-output scrape: first https URL, first
    /// XXXX-YYYY user code — with URLs removed before the code scan so a
    /// code-shaped fragment inside a long OAuth URL is never shown as one.
    nonisolated static func scanSignInArtifacts(in text: String) -> (url: URL?, code: String?) {
        let urlPattern = "https?://[^ \t\n\"'<>]+"
        var url: URL?
        if let range = text.range(of: urlPattern, options: .regularExpression) {
            url = URL(string: String(text[range]))
        }
        let withoutURLs = text.replacingOccurrences(of: urlPattern, with: " ", options: .regularExpression)
        var code: String?
        if let range = withoutURLs.range(of: "\\b[A-Z0-9]{4,8}-[A-Z0-9]{4,8}\\b", options: .regularExpression) {
            code = String(withoutURLs[range])
        }
        return (url, code)
    }

    /// A captured localhost callback, rebuilt as one bounded command the
    /// machine runs against its own loopback. Returns nil for anything that
    /// is not a plain-http localhost URL or that can't be quoted safely.
    nonisolated static func execReplayCommand(for url: URL) -> String? {
        guard isLocalLoginCallback(url),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let port = components.port ?? 80
        var pathAndQuery = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        if let query = components.percentEncodedQuery { pathAndQuery += "?\(query)" }
        let replay = "http://127.0.0.1:\(port)\(pathAndQuery)"
        guard !replay.contains("'"), !replay.contains("\\"), !replay.contains("\u{0}") else { return nil }
        let script = "fetch(process.argv[1],{signal:AbortSignal.timeout(8000)})"
            + ".then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
        return "node -e '\(script)' '\(replay)'"
    }

    /// Single-quote text for a bash command line; nil when it cannot be
    /// quoted safely (the pasted code is user input).
    nonisolated static func shellSingleQuoted(_ text: String) -> String? {
        guard !text.contains("'"), !text.contains("\\"), !text.contains("\u{0}"),
              text.rangeOfCharacter(from: .newlines) == nil else { return nil }
        return "'\(text)'"
    }
}
