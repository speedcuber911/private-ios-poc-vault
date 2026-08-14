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
            expiresAt: 2,
            client: .cli
        )
        let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")

        await model.submitScannedPayload("https://relay.example/cli-login#code=ABCD-EFGH")
        XCTAssertEqual(model.step, .confirm(machineName: "dev-box", platform: "macos", client: .cli))
        XCTAssertEqual(stub.lastInspectCode, "ABCD-EFGH")

        await model.confirmLink()
        XCTAssertEqual(model.step, .approved(machineName: "dev-box", client: .cli))
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

    func testFlowWebClientUsesBrowserConfirmCopy() async {
        let stub = StubCLILinkAuth()
        stub.inspectResult = DeviceCodeInspectResult(
            machineName: "This browser",
            platform: "web",
            createdAt: 1,
            expiresAt: 2,
            client: .web
        )
        let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")
        await model.submitScannedPayload("https://relay.example/cli-login#code=ABCD-EFGH")
        XCTAssertEqual(
            model.step,
            .confirm(machineName: "This browser", platform: "web", client: .web)
        )
        await model.confirmLink()
        XCTAssertEqual(model.step, .approved(machineName: "This browser", client: .web))
    }

    func testWebStaleCopyDoesNotMentionRelayLogin() {
        XCTAssertFalse(CLILinkFlowModel.staleCodeMessage(for: .web).contains("`relay login`"))
        XCTAssertTrue(CLILinkFlowModel.staleCodeMessage(for: .cli).contains("`relay login`"))
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
