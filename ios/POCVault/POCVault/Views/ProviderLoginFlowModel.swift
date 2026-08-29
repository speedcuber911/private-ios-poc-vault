import Foundation

/// The node-side surface the direct-login flow needs. `CodexClient` conforms;
/// tests substitute a stub.
protocol HarnessLoginClient: AnyObject {
    func startHarnessLogin(provider: CodexProvider) async throws -> RelayHarnessOp
    func fetchHarnessOp(id: String) async throws -> RelayHarnessOp
    func fetchHarnessOps(limit: Int) async throws -> [RelayHarnessOp]
    func sendHarnessLoginInput(id: String, text: String) async throws -> RelayHarnessOp
    func forwardHarnessLoginCallback(id: String, url: URL) async throws -> RelayHarnessOp
    func cancelHarnessOp(id: String) async throws -> RelayHarnessOp
}

extension CodexClient: HarnessLoginClient {}

/// Drives direct provider login on the machine from this iPhone, with no
/// laptop in the loop: start the provider CLI's own login on the node →
/// surface the sign-in URL (and user code, when the provider uses one) →
/// complete it either by relaying the localhost OAuth callback the in-app
/// browser captured (Codex) or by delivering the code the user pasted from
/// the provider's site (paste-back flows) → connected when the CLI exits
/// cleanly. Credentials land in the machine's runner home; nothing is stored
/// on the phone. Status is always explicit text (Editorial Ember) — never a
/// colored dot.
@MainActor
final class ProviderLoginFlowModel: ObservableObject {
    enum Step: Equatable {
        case idle
        case starting
        /// The login op is live on the machine. `verificationURL` may still be
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

    /// Poll cadence for op progress; tests shrink it.
    var pollInterval: Duration = .seconds(1)

    private let client: HarnessLoginClient
    private var opID: String?
    private var pollTask: Task<Void, Never>?

    init(client: HarnessLoginClient, provider: CodexProvider) {
        self.client = client
        self.provider = provider
    }

    deinit {
        pollTask?.cancel()
    }

    /// True when the flow should finish Codex-style: an in-app browser that
    /// captures the provider's redirect to its localhost login server. All
    /// other providers finish by pasting the code their sign-in page shows.
    var usesLocalCallback: Bool {
        provider == .codex
    }

    func start() async {
        pollTask?.cancel()
        step = .starting
        do {
            adopt(try await client.startHarnessLogin(provider: provider))
        } catch let error as CodexClientError where error.statusCode == 409 {
            // A login for this provider is already running on the machine —
            // usually an earlier attempt from this phone. Adopt it instead of
            // failing so the user never has to wait out the old op.
            if let existing = try? await client.fetchHarnessOps(limit: 50)
                .first(where: { $0.provider == provider && $0.action == "login" && $0.isActive }) {
                adopt(existing)
            } else {
                step = .failed(Self.startFailedMessage)
            }
        } catch {
            step = .failed(Self.notReachableMessage)
        }
    }

    /// Send the code the user pasted from the provider's sign-in page to the
    /// login CLI's stdin on the machine. The op stays live until the CLI
    /// confirms by exiting; the poll loop lands the terminal state.
    func submitPastedCode() async {
        let text = pastedCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let opID, !text.isEmpty else { return }
        step = .completing
        do {
            apply(try await client.sendHarnessLoginInput(id: opID, text: text), keepCompleting: true)
        } catch {
            stopPolling()
            step = .failed(Self.completionFailedMessage)
        }
    }

    /// Relay a captured localhost redirect (the provider's OAuth callback) to
    /// the CLI's login server on the machine.
    func deliverBrowserCallback(_ url: URL) async {
        guard let opID else { return }
        step = .completing
        do {
            apply(try await client.forwardHarnessLoginCallback(id: opID, url: url), keepCompleting: true)
        } catch {
            stopPolling()
            step = .failed(Self.completionFailedMessage)
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
        stopPolling()
        if let opID {
            _ = try? await client.cancelHarnessOp(id: opID)
        }
        opID = nil
        step = .idle
    }

    private func adopt(_ op: RelayHarnessOp) {
        opID = op.id
        apply(op, keepCompleting: false)
        startPolling()
    }

    private func apply(_ op: RelayHarnessOp, keepCompleting: Bool) {
        switch op.status {
        case .queued, .running, .waitingForUser:
            // After the code/callback went in, the CLI needs a moment to
            // finish; don't bounce the UI back to the sign-in screen.
            if keepCompleting || step == .completing { return }
            step = .waitingForSignIn(op)
        case .succeeded:
            stopPolling()
            step = .succeeded
        case .expired:
            stopPolling()
            step = .failed(Self.expiredMessage)
        case .cancelled:
            stopPolling()
            step = .failed(Self.cancelledMessage)
        case .failed, .unknown:
            stopPolling()
            step = .failed(Self.failedMessage)
        }
    }

    private func startPolling() {
        pollTask?.cancel()
        guard let opID else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                try? await Task.sleep(for: self.pollInterval)
                if Task.isCancelled { return }
                guard let current = try? await self.client.fetchHarnessOp(id: opID) else { continue }
                self.apply(current, keepCompleting: false)
                if !current.isActive { return }
            }
        }
    }

    private func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
