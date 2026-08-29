import Foundation

/// The node-side surface the direct-login flow needs. `CodexClient` conforms;
/// tests substitute a stub. The first block is the modern path (harness login
/// ops with input/callback/cancel). The second block is what the fallback
/// rides on machines that predate those routes: a terminal (a real PTY),
/// bounded exec, and the harness status list.
protocol HarnessLoginClient: AnyObject {
    func startHarnessLogin(provider: CodexProvider) async throws -> RelayHarnessOp
    func fetchHarnessOp(id: String) async throws -> RelayHarnessOp
    func fetchHarnessOps(limit: Int) async throws -> [RelayHarnessOp]
    func sendHarnessLoginInput(id: String, text: String) async throws -> RelayHarnessOp
    func forwardHarnessLoginCallback(id: String, url: URL) async throws -> RelayHarnessOp
    func cancelHarnessOp(id: String) async throws -> RelayHarnessOp

    func fetchHarnesses() async throws -> [RelayHarnessStatus]
    func fetchCodexWorkspaces() async throws -> [CodexWorkspace]
    func createTerminal(workspaceID: String, cols: Int, rows: Int) async throws -> CodexTerminal
    func sendTerminalInput(id: String, text: String) async throws
    func closeTerminal(id: String) async throws
    func terminalEvents(id: String) -> AsyncThrowingStream<CodexTerminalStreamEvent, Error>
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
/// - **Terminal fallback** (any machine): run the CLI's login inside a
///   machine terminal — a real PTY, so CLIs that stay silent without one
///   print their link — scrape the URL/code from the output here, type the
///   pasted code back into that terminal, replay a captured localhost
///   callback via `POST /v1/exec`, and treat the harness list's
///   `loggedIn: true` as the machine's confirmation. The fallback engages
///   when the modern routes are missing (404), when the op dies before
///   producing a link, or when no link appears within `opLinkPatience`.
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
    static let noWorkspaceMessage =
        "Your machine reported no folders to host the sign-in. Open a folder once, then try again."

    let provider: CodexProvider
    @Published private(set) var step: Step = .idle
    @Published var pastedCode: String = ""

    /// Poll cadences and patience windows; tests shrink them.
    var pollInterval: Duration = .seconds(1)
    var connectedPollInterval: Duration = .seconds(3)
    var opLinkPatience: Duration = .seconds(8)
    var overallDeadline: Duration = .seconds(600)

    private enum Engine: Equatable {
        case op(id: String)
        case terminal(id: String)
    }

    private let client: HarnessLoginClient
    private var engine: Engine?
    private var pollTask: Task<Void, Never>?
    private var terminalTask: Task<Void, Never>?
    private var connectedWatchTask: Task<Void, Never>?
    private var fallbackTimerTask: Task<Void, Never>?
    private var terminalOutput = ""
    private var terminalCommandSent = false
    private var sawSignInArtifacts = false
    private var usedTerminalFallback = false

    init(client: HarnessLoginClient, provider: CodexProvider) {
        self.client = client
        self.provider = provider
    }

    deinit {
        pollTask?.cancel()
        terminalTask?.cancel()
        connectedWatchTask?.cancel()
        fallbackTimerTask?.cancel()
    }

    /// True when the flow should finish Codex-style: an in-app browser that
    /// captures the provider's redirect to its localhost login server. All
    /// other providers finish by pasting the code their sign-in page shows.
    var usesLocalCallback: Bool {
        provider == .codex
    }

    /// The command the terminal fallback runs — each provider's own login
    /// entry point, on the machine's PATH.
    var terminalLoginCommand: String {
        switch provider {
        case .claude:
            return "claude setup-token"
        case .cursor:
            return "cursor-agent login"
        case .kimi:
            return "kimi login"
        case .codex, .bedrock, .azure:
            return "codex login"
        }
    }

    func start() async {
        cancelBackgroundWork()
        engine = nil
        sawSignInArtifacts = false
        usedTerminalFallback = false
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
                await startTerminalFallback()
            }
        } catch let error as CodexClientError where error.statusCode == 404 {
            // No harness login op route at all — drive it through a terminal.
            await startTerminalFallback()
        } catch {
            step = .failed(Self.notReachableMessage)
        }
    }

    /// Send the code the user pasted from the provider's sign-in page. Op
    /// mode types it into the login CLI's stdin via the machine API; the
    /// fallback types it straight into the terminal running the login.
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
                // feature). Rerun the login in a terminal, where typing works.
                await startTerminalFallback()
            } catch {
                stopEverythingKeepingStep()
                step = .failed(Self.completionFailedMessage)
            }
        case .terminal(let id):
            step = .completing
            do {
                try await client.sendTerminalInput(id: id, text: "\(text)\n")
                startConnectedWatcher()
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
        case .terminal:
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
        case .terminal(let id):
            try? await client.closeTerminal(id: id)
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
            // a CLI that won't talk without a TTY — the terminal fallback IS a
            // TTY, so try it once before reporting failure.
            if !sawSignInArtifacts && !usedTerminalFallback {
                Task { await startTerminalFallback() }
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
    /// TTY): switch to the terminal fallback instead of waiting forever.
    private func armOpLinkPatience() {
        fallbackTimerTask?.cancel()
        fallbackTimerTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(for: self.opLinkPatience)
            if Task.isCancelled { return }
            guard case .op = self.engine, !self.sawSignInArtifacts, !self.usedTerminalFallback else { return }
            if case .waitingForSignIn = self.step {
                await self.startTerminalFallback()
            } else if self.step == .starting {
                await self.startTerminalFallback()
            }
        }
    }

    // MARK: - Terminal fallback engine

    private func startTerminalFallback() async {
        guard !usedTerminalFallback else { return }
        usedTerminalFallback = true
        cancelBackgroundWork()
        engine = nil
        step = .starting

        // Clear any stray login process from earlier attempts — a silent
        // `codex login` still holds its localhost port. Best effort: machines
        // without pkill just skip this.
        _ = try? await client.execCommand(
            "pkill -f '\(terminalLoginCommand)' >/dev/null 2>&1; true",
            timeoutMs: 8000
        )

        let workspaceID: String
        do {
            guard let workspace = try await client.fetchCodexWorkspaces().first else {
                step = .failed(Self.noWorkspaceMessage)
                return
            }
            workspaceID = workspace.id
        } catch {
            step = .failed(Self.notReachableMessage)
            return
        }

        let terminal: CodexTerminal
        do {
            // Wide columns so the CLI never wraps its (long) sign-in URL.
            terminal = try await client.createTerminal(workspaceID: workspaceID, cols: 320, rows: 40)
        } catch {
            step = .failed(Self.startFailedMessage)
            return
        }

        engine = .terminal(id: terminal.id)
        terminalOutput = ""
        terminalCommandSent = false
        step = .waitingForSignIn(RelayHarnessOp(id: "terminal:\(terminal.id)", provider: provider))
        startTerminalReader(terminalID: terminal.id)

        terminalCommandSent = true
        do {
            try await client.sendTerminalInput(id: terminal.id, text: "\(terminalLoginCommand)\n")
        } catch {
            stopEverythingKeepingStep()
            step = .failed(Self.startFailedMessage)
            return
        }
        startConnectedWatcher()
    }

    private func startTerminalReader(terminalID: String) {
        terminalTask?.cancel()
        terminalTask = Task { [weak self] in
            guard let self else { return }
            do {
                for try await event in self.client.terminalEvents(id: terminalID) {
                    if Task.isCancelled { return }
                    guard case .terminal(id: terminalID) = self.engine else { return }
                    if case .output(let text) = event {
                        self.ingestTerminalOutput(text, terminalID: terminalID)
                    }
                }
            } catch {
                // Stream drop is not fatal: the connected watcher still
                // resolves the outcome from the machine's own status.
            }
        }
    }

    private func ingestTerminalOutput(_ chunk: String, terminalID: String) {
        guard terminalCommandSent else { return }
        terminalOutput = String((terminalOutput + chunk).suffix(64 * 1024))
        let artifacts = Self.scanSignInArtifacts(in: Self.strippedTerminalText(terminalOutput))
        guard artifacts.url != nil || artifacts.code != nil else { return }
        sawSignInArtifacts = true
        guard step != .completing, step != .succeeded else { return }
        let synthesized = RelayHarnessOp(
            id: "terminal:\(terminalID)",
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
        if case .terminal(let id) = current {
            Task { [client] in try? await client.closeTerminal(id: id) }
        }
        step = .succeeded
    }

    private func stopEverythingKeepingStep() {
        let current = engine
        cancelBackgroundWork()
        engine = nil
        if case .terminal(let id) = current {
            Task { [client] in try? await client.closeTerminal(id: id) }
        }
    }

    private func cancelBackgroundWork() {
        pollTask?.cancel()
        pollTask = nil
        terminalTask?.cancel()
        terminalTask = nil
        connectedWatchTask?.cancel()
        connectedWatchTask = nil
        fallbackTimerTask?.cancel()
        fallbackTimerTask = nil
    }

    // MARK: - Pure helpers (testable)

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
}
