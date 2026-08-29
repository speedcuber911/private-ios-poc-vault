import XCTest
@testable import POCVault

/// Direct provider login from the phone: op decoding, the pure terminal
/// scrapers, and the `ProviderLoginFlowModel` state machine — both the modern
/// op engine and the legacy-machine terminal fallback — against a stubbed
/// node client.
final class ProviderLoginTests: XCTestCase {
    // MARK: - RelayHarnessOp decoding

    func testHarnessOpDecodesWaitingForUserWithSignInArtifacts() throws {
        let op = try Self.decodeOp(
            """
            {"op": {
              "id": "0a0b0c0d-0000-4000-8000-000000000001",
              "provider": "codex",
              "action": "login",
              "status": "waiting_for_user",
              "verificationUrl": "https://auth.example/oauth/authorize?client=x",
              "userCode": "ABCD-EFGH",
              "expiresAt": "2026-08-29T00:10:00Z",
              "createdAt": "2026-08-29T00:00:00Z",
              "updatedAt": "2026-08-29T00:00:01Z",
              "finishedAt": null,
              "error": null,
              "logTail": "Open https://auth.example/... in your browser"
            }}
            """
        )
        XCTAssertEqual(op.provider, .codex)
        XCTAssertEqual(op.action, "login")
        XCTAssertEqual(op.status, .waitingForUser)
        XCTAssertTrue(op.isActive)
        XCTAssertEqual(op.verificationURL?.absoluteString, "https://auth.example/oauth/authorize?client=x")
        XCTAssertEqual(op.userCode, "ABCD-EFGH")
    }

    func testHarnessOpDecodingIsLenientAboutUnknownsAndExtras() throws {
        // The callback route answers {op, upstreamStatus}; extra keys must not break decoding,
        // and a status this app version doesn't know must land on .unknown, not throw.
        let op = try Self.decodeOp(
            """
            {"op": {
              "id": "0a0b0c0d-0000-4000-8000-000000000002",
              "provider": "claude",
              "status": "brand_new_status",
              "verificationUrl": "not a url at all ://",
              "userCode": "  "
            }, "upstreamStatus": 200}
            """
        )
        XCTAssertEqual(op.provider, .claude)
        XCTAssertEqual(op.status, .unknown)
        XCTAssertFalse(op.isActive)
        XCTAssertNil(op.userCode)
    }

    // MARK: - Pure helpers

    func testLocalLoginCallbackDetection() {
        XCTAssertTrue(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "http://localhost:1455/auth/callback?code=x")!))
        XCTAssertTrue(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "http://127.0.0.1:1455/auth/callback")!))
        XCTAssertFalse(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "https://auth.example/oauth/authorize")!))
        XCTAssertFalse(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "https://localhost/auth/callback")!),
                       "only plain-http localhost is the CLI's login server")
        XCTAssertFalse(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "relay://localhost/auth")!))
    }

    func testTerminalTextStrippingAndArtifactScan() {
        let raw = "\u{1B}[1;32mprompt$\u{1B}[0m codex login\r\n"
            + "\u{1B}]0;title\u{07}Open \u{1B}[4mhttps://auth.example/oauth/authorize?state=ABCD-1234&x=1\u{1B}[24m in your browser\r\n"
            + "then enter code WXYZ-2345 to continue\r\n"
        let stripped = ProviderLoginFlowModel.strippedTerminalText(raw)
        XCTAssertFalse(stripped.contains("\u{1B}"), "ANSI sequences must be gone")
        XCTAssertFalse(stripped.contains("\r"))

        let artifacts = ProviderLoginFlowModel.scanSignInArtifacts(in: stripped)
        XCTAssertEqual(artifacts.url?.absoluteString, "https://auth.example/oauth/authorize?state=ABCD-1234&x=1")
        XCTAssertEqual(artifacts.code, "WXYZ-2345", "the code inside the URL must not win over the real one")
    }

    func testExecReplayCommandBuildsLoopbackFetchAndRejectsBadInput() {
        let command = ProviderLoginFlowModel.execReplayCommand(
            for: URL(string: "http://localhost:1455/auth/callback?code=abc123&state=st")!
        )
        XCTAssertNotNil(command)
        XCTAssertTrue(command?.contains("'http://127.0.0.1:1455/auth/callback?code=abc123&state=st'") == true)
        XCTAssertTrue(command?.hasPrefix("node -e ") == true)

        XCTAssertNil(ProviderLoginFlowModel.execReplayCommand(for: URL(string: "https://evil.example/auth/callback")!))
        XCTAssertNil(ProviderLoginFlowModel.execReplayCommand(for: URL(string: "http://localhost:1455/auth/callback?code=a'b")!))
    }

    // MARK: - Op engine

    @MainActor
    func testFlowReachesWaitingThenSucceedsFromPolling() async throws {
        let stub = StubHarnessLoginClient()
        stub.startResult = try Self.op(id: "op-1", provider: "claude", status: "running")
        stub.currentOp = try Self.op(
            id: "op-1", provider: "claude", status: "waiting_for_user",
            url: "https://provider.example/authorize?flow=paste"
        )
        let flow = Self.makeFastFlow(client: stub, provider: .claude)

        await flow.start()
        try await Self.waitUntil { if case .waitingForSignIn = flow.step { return true }; return false }

        stub.currentOp = try Self.op(id: "op-1", provider: "claude", status: "succeeded")
        try await Self.waitUntil { flow.step == .succeeded }
    }

    @MainActor
    func testFlowAdoptsAlreadyRunningLoginOnConflict() async throws {
        let stub = StubHarnessLoginClient()
        stub.startError = CodexClientError.httpFailure(409, "a login operation is already running for claude")
        let existing = try Self.op(
            id: "op-existing", provider: "claude", status: "waiting_for_user",
            url: "https://provider.example/authorize"
        )
        stub.listedOps = [
            try Self.op(id: "op-other", provider: "codex", status: "waiting_for_user"),
            try Self.op(id: "op-done", provider: "claude", status: "succeeded"),
            existing,
        ]
        stub.currentOp = existing
        let flow = Self.makeFastFlow(client: stub, provider: .claude)

        await flow.start()
        guard case .waitingForSignIn(let op) = flow.step else {
            return XCTFail("expected waitingForSignIn, got \(flow.step)")
        }
        XCTAssertEqual(op.id, "op-existing", "must adopt the live login for the same provider")
    }

    @MainActor
    func testSubmitPastedCodeSendsTrimmedTextAndHoldsCompleting() async throws {
        let stub = StubHarnessLoginClient()
        let waiting = try Self.op(
            id: "op-1", provider: "claude", status: "waiting_for_user",
            url: "https://provider.example/authorize"
        )
        stub.startResult = waiting
        stub.currentOp = waiting
        let flow = Self.makeFastFlow(client: stub, provider: .claude)

        await flow.start()
        flow.pastedCode = "  the-pasted-code#state \n"
        await flow.submitPastedCode()

        XCTAssertEqual(stub.sentInputs, [StubHarnessLoginClient.SentInput(opID: "op-1", text: "the-pasted-code#state")])
        XCTAssertEqual(flow.step, .completing, "the CLI needs a moment to confirm; don't bounce back to sign-in")

        stub.currentOp = try Self.op(id: "op-1", provider: "claude", status: "succeeded")
        try await Self.waitUntil { flow.step == .succeeded }
    }

    @MainActor
    func testBrowserCallbackIsForwardedAndTerminalFailureSurfaces() async throws {
        let stub = StubHarnessLoginClient()
        let waiting = try Self.op(
            id: "op-9", provider: "codex", status: "waiting_for_user",
            url: "https://auth.example/oauth/authorize"
        )
        stub.startResult = waiting
        stub.currentOp = waiting
        let flow = Self.makeFastFlow(client: stub, provider: .codex)
        XCTAssertTrue(flow.usesLocalCallback)

        await flow.start()
        let callback = URL(string: "http://localhost:1455/auth/callback?code=abc")!
        await flow.deliverBrowserCallback(callback)
        XCTAssertEqual(stub.forwardedCallbacks, [StubHarnessLoginClient.ForwardedCallback(opID: "op-9", url: callback)])
        XCTAssertEqual(flow.step, .completing)

        stub.currentOp = try Self.op(id: "op-9", provider: "codex", status: "failed", error: "login exited with code 1")
        try await Self.waitUntil { flow.step == .failed(ProviderLoginFlowModel.failedMessage) }
    }

    @MainActor
    func testCancelTellsTheMachineAndResets() async throws {
        let stub = StubHarnessLoginClient()
        let waiting = try Self.op(id: "op-1", provider: "claude", status: "waiting_for_user", url: "https://p.example/a")
        stub.startResult = waiting
        stub.currentOp = waiting
        let flow = Self.makeFastFlow(client: stub, provider: .claude)

        await flow.start()
        await flow.cancel()
        XCTAssertEqual(stub.cancelledOpIDs, ["op-1"])
        XCTAssertEqual(flow.step, .idle)
    }

    // MARK: - Terminal fallback engine (legacy machines)

    @MainActor
    func testMissingOpRoutesFallBackToTerminalLoginEndToEnd() async throws {
        let stub = StubHarnessLoginClient()
        stub.startError = CodexClientError.httpFailure(404, "not found")
        stub.workspaces = try Self.workspaces()
        let flow = Self.makeFastFlow(client: stub, provider: .claude)

        await flow.start()
        XCTAssertEqual(stub.createdTerminals.count, 1, "a legacy machine gets a terminal-driven login")
        XCTAssertEqual(stub.terminalInputs.first?.text, "claude setup-token\n")
        XCTAssertTrue(stub.execCommands.first?.contains("pkill") == true, "stray logins are cleared first")

        // The CLI prints its link (with ANSI noise) into the terminal.
        stub.pushTerminalOutput("\u{1B}[1mVisit\u{1B}[0m https://provider.example/authorize?flow=paste and paste the code\r\n")
        try await Self.waitUntil {
            if case .waitingForSignIn(let op) = flow.step { return op.verificationURL != nil }
            return false
        }
        XCTAssertTrue(flow.terminalTail?.contains("Visit") == true,
                      "the sheet surfaces the machine's own output while a link is pending")

        // Pasting types the code into the same terminal.
        flow.pastedCode = " paste-code-123 "
        await flow.submitPastedCode()
        XCTAssertEqual(stub.terminalInputs.last?.text, "paste-code-123\n")
        XCTAssertEqual(flow.step, .completing)

        // The machine's own status is the confirmation.
        stub.harnesses = [try Self.harness(provider: "claude", loggedIn: true)]
        try await Self.waitUntil { flow.step == .succeeded }
        // Terminal cleanup is fire-and-forget; wait for it rather than racing it.
        try await Self.waitUntil { stub.closedTerminalIDs == [stub.createdTerminals[0].id] }
    }

    @MainActor
    func testOpCallback404FallsBackToExecReplay() async throws {
        let stub = StubHarnessLoginClient()
        let waiting = try Self.op(
            id: "op-9", provider: "codex", status: "waiting_for_user",
            url: "https://auth.example/oauth/authorize"
        )
        stub.startResult = waiting
        stub.currentOp = waiting
        stub.forwardError = CodexClientError.httpFailure(404, "not found")
        let flow = Self.makeFastFlow(client: stub, provider: .codex)

        await flow.start()
        await flow.deliverBrowserCallback(URL(string: "http://localhost:1455/auth/callback?code=abc")!)

        let replay = stub.execCommands.last
        XCTAssertTrue(replay?.contains("http://127.0.0.1:1455/auth/callback?code=abc") == true,
                      "an old machine still gets the callback, via exec: \(replay ?? "<none>")")
        XCTAssertEqual(flow.step, .completing)

        stub.harnesses = [try Self.harness(provider: "codex", loggedIn: true)]
        try await Self.waitUntil { flow.step == .succeeded }
    }

    @MainActor
    func testTerminalLoginUsesResolvedAbsoluteBinaryPath() async throws {
        let stub = StubHarnessLoginClient()
        stub.startError = CodexClientError.httpFailure(404, "not found")
        stub.workspaces = try Self.workspaces()
        // The machine resolves the CLI to its npm-global location.
        stub.execResults = [(contains: "command -v claude", result: CodexExecResult(exitCode: 0, stdout: "/opt/node/bin/claude\n"))]
        let flow = Self.makeFastFlow(client: stub, provider: .claude)

        await flow.start()
        XCTAssertEqual(stub.terminalInputs.first?.text, "/opt/node/bin/claude setup-token\n",
                       "the typed command must survive a PATH that misses the CLI")
    }

    @MainActor
    func testTerminalErrorLineFailsFastWithTheMachinesWords() async throws {
        let stub = StubHarnessLoginClient()
        stub.startError = CodexClientError.httpFailure(404, "not found")
        stub.workspaces = try Self.workspaces()
        let flow = Self.makeFastFlow(client: stub, provider: .codex)

        await flow.start()
        stub.pushTerminalOutput("sh: 1: codex: command not found\r\n")
        try await Self.waitUntil {
            if case .failed(let message) = flow.step { return message.contains("command not found") }
            return false
        }
    }

    @MainActor
    func testOpThatDiesWithoutALinkRetriesThroughTerminal() async throws {
        let stub = StubHarnessLoginClient()
        // The op starts but the CLI dies instantly (the no-TTY shape).
        stub.startResult = try Self.op(id: "op-1", provider: "codex", status: "running")
        stub.currentOp = try Self.op(id: "op-1", provider: "codex", status: "failed", error: "login exited with code 1")
        stub.workspaces = try Self.workspaces()
        let flow = Self.makeFastFlow(client: stub, provider: .codex)

        await flow.start()
        try await Self.waitUntil { stub.createdTerminals.count == 1 }
        XCTAssertEqual(stub.terminalInputs.first?.text, "codex login\n")
    }

    // MARK: - Helpers

    @MainActor
    private static func makeFastFlow(client: StubHarnessLoginClient, provider: CodexProvider) -> ProviderLoginFlowModel {
        let flow = ProviderLoginFlowModel(client: client, provider: provider)
        flow.pollInterval = .milliseconds(10)
        flow.connectedPollInterval = .milliseconds(10)
        flow.opLinkPatience = .milliseconds(200)
        return flow
    }

    private static func decodeOp(_ json: String) throws -> RelayHarnessOp {
        try CodexClient.makeDecoder().decode(CodexHarnessOpEnvelope.self, from: Data(json.utf8)).op
    }

    private static func op(
        id: String,
        provider: String,
        status: String,
        url: String? = nil,
        code: String? = nil,
        error: String? = nil
    ) throws -> RelayHarnessOp {
        var fields: [String: Any] = ["id": id, "provider": provider, "action": "login", "status": status]
        if let url { fields["verificationUrl"] = url }
        if let code { fields["userCode"] = code }
        if let error { fields["error"] = error }
        let data = try JSONSerialization.data(withJSONObject: ["op": fields])
        return try CodexClient.makeDecoder().decode(CodexHarnessOpEnvelope.self, from: data).op
    }

    private static func harness(provider: String, loggedIn: Bool) throws -> RelayHarnessStatus {
        try CodexClient.makeDecoder().decode(
            RelayHarnessStatus.self,
            from: JSONSerialization.data(withJSONObject: [
                "provider": provider, "installed": true, "loggedIn": loggedIn, "authKind": "subscription",
            ])
        )
    }

    private static func workspaces() throws -> [CodexWorkspace] {
        try CodexClient.makeDecoder().decode(
            [CodexWorkspace].self,
            from: Data(#"[{"id": "scratch", "name": "Scratch"}]"#.utf8)
        )
    }

    /// Wait for a condition the flow's poll loop will land; the deadline is a
    /// hang detector, not a synchronization primitive.
    @MainActor
    private static func waitUntil(
        deadline: TimeInterval = 10,
        _ condition: @MainActor () -> Bool
    ) async throws {
        let start = Date()
        while !condition() {
            if Date().timeIntervalSince(start) > deadline {
                XCTFail("condition not reached within \(deadline)s")
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }
}

@MainActor
private final class StubHarnessLoginClient: HarnessLoginClient {
    struct SentInput: Equatable {
        let opID: String
        let text: String
    }

    struct ForwardedCallback: Equatable {
        let opID: String
        let url: URL
    }

    struct TerminalInput: Equatable {
        let terminalID: String
        let text: String
    }

    var startResult: RelayHarnessOp?
    var startError: Error?
    var forwardError: Error?
    var currentOp: RelayHarnessOp?
    var listedOps: [RelayHarnessOp] = []
    var harnesses: [RelayHarnessStatus] = []
    var workspaces: [CodexWorkspace] = []
    /// First entry whose key is contained in the exec command wins; other
    /// commands get an empty success.
    var execResults: [(contains: String, result: CodexExecResult)] = []
    private(set) var sentInputs: [SentInput] = []
    private(set) var forwardedCallbacks: [ForwardedCallback] = []
    private(set) var cancelledOpIDs: [String] = []
    private(set) var createdTerminals: [CodexTerminal] = []
    private(set) var terminalInputs: [TerminalInput] = []
    private(set) var closedTerminalIDs: [String] = []
    private(set) var execCommands: [String] = []
    private var terminalContinuations: [AsyncThrowingStream<CodexTerminalStreamEvent, Error>.Continuation] = []
    private var bufferedTerminalOutput = ""

    func pushTerminalOutput(_ text: String) {
        bufferedTerminalOutput += text
        for continuation in terminalContinuations {
            continuation.yield(.output(text))
        }
    }

    func startHarnessLogin(provider: CodexProvider) async throws -> RelayHarnessOp {
        if let startError { throw startError }
        guard let startResult else { throw CodexClientError.emptyResponse }
        return startResult
    }

    func fetchHarnessOp(id: String) async throws -> RelayHarnessOp {
        guard let currentOp, currentOp.id == id else { throw CodexClientError.httpFailure(404, "not found") }
        return currentOp
    }

    func fetchHarnessOps(limit: Int) async throws -> [RelayHarnessOp] {
        listedOps
    }

    func sendHarnessLoginInput(id: String, text: String) async throws -> RelayHarnessOp {
        sentInputs.append(SentInput(opID: id, text: text))
        guard let currentOp else { throw CodexClientError.emptyResponse }
        return currentOp
    }

    func forwardHarnessLoginCallback(id: String, url: URL) async throws -> RelayHarnessOp {
        if let forwardError { throw forwardError }
        forwardedCallbacks.append(ForwardedCallback(opID: id, url: url))
        guard let currentOp else { throw CodexClientError.emptyResponse }
        return currentOp
    }

    func cancelHarnessOp(id: String) async throws -> RelayHarnessOp {
        cancelledOpIDs.append(id)
        guard let currentOp else { throw CodexClientError.emptyResponse }
        return currentOp
    }

    func fetchHarnesses() async throws -> [RelayHarnessStatus] {
        harnesses
    }

    func fetchCodexWorkspaces() async throws -> [CodexWorkspace] {
        workspaces
    }

    func createTerminal(workspaceID: String, cols: Int, rows: Int) async throws -> CodexTerminal {
        let terminal = CodexTerminal(
            id: "term-\(createdTerminals.count + 1)",
            workspaceId: workspaceID,
            workspaceName: workspaceID,
            status: "running",
            createdAt: nil,
            updatedAt: nil,
            finishedAt: nil,
            exitCode: nil,
            cols: cols,
            rows: rows
        )
        createdTerminals.append(terminal)
        return terminal
    }

    func sendTerminalInput(id: String, text: String) async throws {
        terminalInputs.append(TerminalInput(terminalID: id, text: text))
    }

    func closeTerminal(id: String) async throws {
        closedTerminalIDs.append(id)
    }

    nonisolated func terminalEvents(id: String) -> AsyncThrowingStream<CodexTerminalStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            Task { @MainActor in
                // Mirror the real server: the opening snapshot carries every
                // byte that landed in the buffer before the stream attached.
                if let terminal = self.createdTerminals.last {
                    continuation.yield(.snapshot(terminal: terminal, output: self.bufferedTerminalOutput))
                }
                self.terminalContinuations.append(continuation)
            }
        }
    }

    func execCommand(_ command: String, timeoutMs: Int?) async throws -> CodexExecResult {
        execCommands.append(command)
        if let match = execResults.first(where: { command.contains($0.contains) }) {
            return match.result
        }
        return CodexExecResult(exitCode: 0)
    }
}
