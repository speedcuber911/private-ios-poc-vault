import XCTest
@testable import POCVault

@MainActor
final class CLILinkTests: XCTestCase {
    func testParseUserCodeFromURLFragment() {
        XCTAssertEqual(
            CLILinkFlowModel.parseUserCode(from: "https://relay.example/cli-login#code=ABCD-EFGH"),
            "ABCD-EFGH"
        )
        XCTAssertEqual(
            CLILinkFlowModel.parseUserCode(from: "https://relay.example/cli-login#code=abcd-efgh"),
            "ABCD-EFGH"
        )
        XCTAssertEqual(
            CLILinkFlowModel.parseUserCode(from: "https://relay.example/cli-login#foo=1&code=WXYZ-2345"),
            "WXYZ-2345"
        )
    }

    func testParseBareUserCodeNormalizesCaseAndDashes() {
        XCTAssertEqual(CLILinkFlowModel.parseUserCode(from: "abcd-efgh"), "ABCD-EFGH")
        XCTAssertEqual(CLILinkFlowModel.parseUserCode(from: "abcdefgh"), "ABCD-EFGH")
        XCTAssertEqual(CLILinkFlowModel.parseUserCode(from: "  ABCD EFGH  "), "ABCD-EFGH")
    }

    func testParseRejectsGarbage() {
        XCTAssertNil(CLILinkFlowModel.parseUserCode(from: ""))
        XCTAssertNil(CLILinkFlowModel.parseUserCode(from: "ABC"))
        XCTAssertNil(CLILinkFlowModel.parseUserCode(from: "https://relay.example/cli-login"))
        // "TOO-SHORT" was the fixture here and it never tested what it claimed:
        // the dash is stripped before the length check, leaving TOOSHORT — eight
        // alphanumerics, i.e. a perfectly well-formed code, which parseUserCode
        // correctly returned as TOOS-HORT. Use a fragment that is genuinely the
        // wrong length so the rule under test is the one being exercised.
        XCTAssertNil(CLILinkFlowModel.parseUserCode(from: "https://relay.example/cli-login#code=TOOSHRT"))
        XCTAssertNil(CLILinkFlowModel.parseUserCode(from: "https://relay.example/cli-login#code=TOOLONGCODE"))
    }

    func testNormalizeUserCode() {
        XCTAssertEqual(CLILinkFlowModel.normalizeUserCode("ab-cd-ef-gh"), "ABCD-EFGH")
        XCTAssertNil(CLILinkFlowModel.normalizeUserCode("ABCDEFGHI"))
    }

    func testFlowInspectThenApproveHappyPath() async {
        let stub = StubCLILinkAuth()
        stub.inspectResult = DeviceCodeInspectResult(
            machineName: "dev-box",
            platform: "macos",
            createdAt: 1,
            expiresAt: 2
        )
        let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")

        await model.submitScannedPayload("https://relay.example/cli-login#code=ABCD-EFGH")
        XCTAssertEqual(model.step, .confirm(machineName: "dev-box", platform: "macos"))
        XCTAssertEqual(stub.lastInspectCode, "ABCD-EFGH")

        await model.confirmLink()
        XCTAssertEqual(model.step, .approved(machineName: "dev-box"))
        XCTAssertEqual(stub.lastApproveCode, "ABCD-EFGH")
    }

    func testFlowMapsUnknownCodeToUniformFailureCopy() async {
        let stub = StubCLILinkAuth()
        stub.inspectError = RelayAuthClientError.server(status: 404, code: "unknown_user_code", message: "x")
        let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")

        await model.submitManualCode()
        // empty manual → parse fail
        XCTAssertEqual(model.step, .failed(CLILinkFlowModel.staleCodeMessage))

        model.manualCode = "ABCD-EFGH"
        await model.submitManualCode()
        XCTAssertEqual(model.step, .failed(CLILinkFlowModel.staleCodeMessage))
    }

    func testFlowExplainsSingleComputerConflict() async {
        let stub = StubCLILinkAuth()
        stub.inspectError = RelayAuthClientError.server(
            status: 409,
            code: "computer_already_linked",
            message: "x"
        )
        let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")
        model.manualCode = "ABCD-EFGH"

        await model.submitManualCode()

        XCTAssertEqual(model.step, .failed(CLILinkFlowModel.alreadyLinkedMessage))
    }

    func testDisconnectHidesFoldersAcrossRelaunchUntilAComputerIsLinkedAgain() async throws {
        let suite = "relay-computer-link-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        let accountID = "account-1"
        let computer = CLIComputerLink(
            id: "computer-1",
            machineName: "Komal's Mac",
            platform: "macos",
            status: .connected,
            connectedAt: 2,
            createdAt: 1
        )
        let stub = StubComputerLinkAuth(computer: computer)
        let store = RelayComputerLinkStore(client: stub, defaults: defaults)

        await store.refresh(bearerToken: "phone-session", accountID: accountID)
        XCTAssertEqual(store.computer, computer)
        XCTAssertFalse(store.suppressesFolderAccess(for: accountID))

        await store.disconnect(bearerToken: "phone-session", accountID: accountID)
        XCTAssertNil(store.computer)
        XCTAssertTrue(store.suppressesFolderAccess(for: accountID))
        XCTAssertEqual(stub.disconnectCount, 1)

        let relaunchedStub = StubComputerLinkAuth(computer: nil, foldersAvailable: false)
        let relaunchedStore = RelayComputerLinkStore(client: relaunchedStub, defaults: defaults)
        XCTAssertTrue(relaunchedStore.suppressesFolderAccess(for: accountID))

        relaunchedStub.computer = computer
        relaunchedStub.foldersAvailable = true
        await relaunchedStore.refresh(bearerToken: "phone-session", accountID: accountID)
        XCTAssertFalse(relaunchedStore.suppressesFolderAccess(for: accountID))
    }

    func testFreshInstallUsesBackendRevocationEvenWithoutLocalDisconnectHistory() async throws {
        let suite = "relay-computer-link-server-truth-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        let accountID = "account-server-truth"
        let stub = StubComputerLinkAuth(computer: nil, foldersAvailable: false)
        let store = RelayComputerLinkStore(client: stub, defaults: defaults)
        XCTAssertFalse(store.suppressesFolderAccess(for: accountID))

        await store.refresh(bearerToken: "phone-session", accountID: accountID)

        XCTAssertTrue(store.suppressesFolderAccess(for: accountID))
        XCTAssertNil(store.computer)
    }

    func testStaleLinkRefreshCannotRestoreFoldersAfterDisconnect() async throws {
        let suite = "relay-computer-link-race-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)
        defer { defaults.removePersistentDomain(forName: suite) }

        let accountID = "account-race"
        let computer = CLIComputerLink(
            id: "computer-race",
            machineName: "Slow Mac",
            platform: "macos",
            status: .connected,
            connectedAt: 2,
            createdAt: 1
        )
        let stub = StubComputerLinkAuth(computer: computer)
        stub.linkResponseDelay = 100_000_000
        let store = RelayComputerLinkStore(client: stub, defaults: defaults)

        let staleRefresh = Task {
            await store.refresh(bearerToken: "phone-session", accountID: accountID)
        }
        try await Task.sleep(nanoseconds: 10_000_000)
        await store.disconnect(bearerToken: "phone-session", accountID: accountID)
        await staleRefresh.value

        XCTAssertNil(store.computer)
        XCTAssertTrue(store.suppressesFolderAccess(for: accountID))
    }
}

private final class StubCLILinkAuth: CLILinkAuthClient {
    var inspectResult: DeviceCodeInspectResult?
    var inspectError: Error?
    var approveError: Error?
    var lastInspectCode: String?
    var lastApproveCode: String?

    func deviceInspect(userCode: String, bearerToken: String) async throws -> DeviceCodeInspectResult {
        lastInspectCode = userCode
        if let inspectError { throw inspectError }
        return inspectResult!
    }

    func deviceApprove(userCode: String, bearerToken: String) async throws {
        lastApproveCode = userCode
        if let approveError { throw approveError }
    }
}

private final class StubComputerLinkAuth: RelayComputerLinkAuthClient {
    var computer: CLIComputerLink?
    var foldersAvailable: Bool
    var linkResponseDelay: UInt64 = 0
    private(set) var disconnectCount = 0

    init(computer: CLIComputerLink?, foldersAvailable: Bool = true) {
        self.computer = computer
        self.foldersAvailable = foldersAvailable
    }

    func computerLinkState(bearerToken: String) async throws -> CLIComputerLinkState {
        let response = CLIComputerLinkState(
            computer: computer,
            foldersAvailable: foldersAvailable
        )
        if linkResponseDelay > 0 {
            try await Task.sleep(nanoseconds: linkResponseDelay)
        }
        return response
    }

    func disconnectComputer(bearerToken: String) async throws {
        disconnectCount += 1
        computer = nil
        foldersAvailable = false
    }
}
