import XCTest
@testable import POCVault

/// Direct provider login from the phone: op decoding plus the
/// `ProviderLoginFlowModel` state machine against a stubbed node client.
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

    // MARK: - Local-callback detection

    func testLocalLoginCallbackDetection() {
        XCTAssertTrue(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "http://localhost:1455/auth/callback?code=x")!))
        XCTAssertTrue(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "http://127.0.0.1:1455/auth/callback")!))
        XCTAssertFalse(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "https://auth.example/oauth/authorize")!))
        XCTAssertFalse(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "https://localhost/auth/callback")!),
                       "only plain-http localhost is the CLI's login server")
        XCTAssertFalse(ProviderLoginFlowModel.isLocalLoginCallback(URL(string: "relay://localhost/auth")!))
    }

    // MARK: - Flow model

    @MainActor
    func testFlowReachesWaitingThenSucceedsFromPolling() async throws {
        let stub = StubHarnessLoginClient()
        stub.startResult = try Self.op(id: "op-1", provider: "claude", status: "running")
        stub.currentOp = try Self.op(
            id: "op-1", provider: "claude", status: "waiting_for_user",
            url: "https://provider.example/authorize?flow=paste"
        )
        let flow = ProviderLoginFlowModel(client: stub, provider: .claude)
        flow.pollInterval = .milliseconds(10)

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
        let flow = ProviderLoginFlowModel(client: stub, provider: .claude)
        flow.pollInterval = .milliseconds(10)

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
        let flow = ProviderLoginFlowModel(client: stub, provider: .claude)
        flow.pollInterval = .milliseconds(10)

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
        let flow = ProviderLoginFlowModel(client: stub, provider: .codex)
        flow.pollInterval = .milliseconds(10)
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
        let waiting = try Self.op(id: "op-1", provider: "claude", status: "waiting_for_user")
        stub.startResult = waiting
        stub.currentOp = waiting
        let flow = ProviderLoginFlowModel(client: stub, provider: .claude)
        flow.pollInterval = .milliseconds(10)

        await flow.start()
        await flow.cancel()
        XCTAssertEqual(stub.cancelledOpIDs, ["op-1"])
        XCTAssertEqual(flow.step, .idle)
    }

    // MARK: - Helpers

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

    var startResult: RelayHarnessOp?
    var startError: Error?
    var currentOp: RelayHarnessOp?
    var listedOps: [RelayHarnessOp] = []
    private(set) var sentInputs: [SentInput] = []
    private(set) var forwardedCallbacks: [ForwardedCallback] = []
    private(set) var cancelledOpIDs: [String] = []

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
        forwardedCallbacks.append(ForwardedCallback(opID: id, url: url))
        guard let currentOp else { throw CodexClientError.emptyResponse }
        return currentOp
    }

    func cancelHarnessOp(id: String) async throws -> RelayHarnessOp {
        cancelledOpIDs.append(id)
        guard let currentOp else { throw CodexClientError.emptyResponse }
        return currentOp
    }
}
