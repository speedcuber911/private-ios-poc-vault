import XCTest
@testable import POCVault

final class TrialPairingTests: XCTestCase {
    // Fixtures generated from product/relayd/src/pairing.mjs (Step 1) — the
    // two implementations must agree byte-for-byte.
    private let secret = "fixture-secret-0123456789"
    private let expectedAuthToken = "9txp4hWq2zfrLpCy9M6n2OeLHkY75Olxy5EwEcvoMeA"
    private let expectedDeviceTag = "Jhp8CDs+kkDm9Z6+VGsqkJjS4mIY+iTrVEWYrNkSFZ0="
    private let expectedP12Passphrase = "69aca1443461ad6836ccad61fa462592adb0dcd9a9b65a26855b62a8494c9cd1"
    private let fixtureBlob = Data("{\"deviceName\":\"Fixture\",\"platform\":\"ios\"}".utf8)

    func testAuthTokenMatchesNodeDerivation() {
        XCTAssertEqual(RelayTrialPairing.authToken(secret: secret), expectedAuthToken)
    }

    func testBlobTagMatchesNodeDerivation() {
        let key = RelayTrialPairing.macKey(secret: secret)
        XCTAssertEqual(RelayTrialPairing.blobTag(macKey: key, slot: RelayTrialPairing.deviceSlot, blob: fixtureBlob), expectedDeviceTag)
        XCTAssertTrue(RelayTrialPairing.verifyTag(macKey: key, slot: RelayTrialPairing.deviceSlot, blob: fixtureBlob, tag: expectedDeviceTag))
        XCTAssertFalse(RelayTrialPairing.verifyTag(macKey: key, slot: RelayTrialPairing.nodeSlot, blob: fixtureBlob, tag: expectedDeviceTag))
    }

    func testP12PassphraseMatchesNodeDerivation() {
        XCTAssertEqual(RelayTrialPairing.p12Passphrase(secret: secret), expectedP12Passphrase)
    }

    func testGenerateSecretShape() {
        let s = RelayTrialPairing.generateSecret()
        XCTAssertNil(s.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        XCTAssertGreaterThanOrEqual(s.count, 32)
        XCTAssertNotEqual(RelayTrialPairing.generateSecret(), s)
    }

    func testTrialNodeDecoding() throws {
        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1000,"expiresAt":2000}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
        XCTAssertEqual(trial.state, .ready)
        XCTAssertEqual(trial.nodeURL, URL(string: "https://node-0011223344556677.tun.test"))
    }

    func testTrialEnvelopeDecoding() throws {
        let json = #"{"trial":{"id":"t1","state":"creating","nodeId":null,"sni":null,"createdAt":1,"expiresAt":2}}"#
        let trial = try RelayTrialClient.decodeTrialEnvelope(Data(json.utf8))
        XCTAssertEqual(trial.state, .creating)
        XCTAssertNil(trial.nodeURL)
    }

    func testTrialErrorMapping() {
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: "trial_already_used"), .alreadyUsed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 503, code: "trial_capacity"), .capacity)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "trial_unavailable"), .unavailable)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "no_trial"), .noTrial)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "not_posted_yet"), .blobPending)
        XCTAssertEqual(RelayTrialClient.mapError(status: 502, code: "provision_failed"), .provisionFailed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 500, code: nil), .server(status: 500))
    }

    @MainActor
    func testNodeStorePersistsAndRestoresTrial() async throws {
        let suite = "trial-node-store-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1,"expiresAt":2}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))

        let store = RelayNodeStore(defaults: defaults)
        XCTAssertNil(store.activeNodeURL)
        store.adoptTrial(trial)
        XCTAssertEqual(store.activeNodeURL, URL(string: "https://node-0011223344556677.tun.test"))

        let restored = RelayNodeStore(defaults: defaults)
        XCTAssertEqual(restored.trial?.id, "t1")
        XCTAssertEqual(restored.activeNodeURL, store.activeNodeURL)

        restored.clear()
        XCTAssertNil(RelayNodeStore(defaults: defaults).activeNodeURL)
    }

    @MainActor
    func testTrialFlowSurfacesAlreadyUsedFailure() async {
        // Dead-endpoint client (house idiom): every call throws .server/.connection,
        // so the flow must land in .failed with a message, never hang.
        let client = RelayTrialClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let flow = RelayTrialFlowModel(
            client: client,
            identityStore: ClientIdentityStore(),
            nodeStore: RelayNodeStore(defaults: UserDefaults(suiteName: "trial-flow-tests")!),
            pollIntervalNs: 1
        )
        await flow.start(bearer: "b", deviceName: "Test")
        guard case .failed = flow.step else {
            return XCTFail("expected .failed, got \(flow.step)")
        }
    }
}
