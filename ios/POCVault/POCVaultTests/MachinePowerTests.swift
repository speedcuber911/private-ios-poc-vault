import XCTest
@testable import POCVault

final class MachinePowerTests: XCTestCase {
    override func setUp() {
        super.setUp()
        ClientIdentityStore().forgetPairedMaterialForTesting()
    }

    override func tearDown() {
        ClientIdentityStore().forgetPairedMaterialForTesting()
        super.tearDown()
    }

    func testUnreachableClassifierAcceptsConnectionFailuresOnly() {
        XCTAssertTrue(RelayPowerClient.isMachineUnreachable(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost)
        ))
        XCTAssertTrue(RelayPowerClient.isMachineUnreachable(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut)
        ))
        XCTAssertTrue(RelayPowerClient.isMachineUnreachable(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost)
        ))
        XCTAssertFalse(RelayPowerClient.isMachineUnreachable(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet)
        ))
        XCTAssertFalse(RelayPowerClient.isMachineUnreachable(
            NSError(domain: NSURLErrorDomain, code: NSURLErrorSecureConnectionFailed)
        ))
        XCTAssertFalse(RelayPowerClient.isMachineUnreachable(
            NSError(domain: NSCocoaErrorDomain, code: 1)
        ))
    }

    func testWakeTokenPersistsInThePairedKeychainMaterial() {
        let store = ClientIdentityStore()
        store.forgetPairedMaterialForTesting()
        XCTAssertNil(store.wakeCredential())
        store.storeWakeToken("  wake-secret-token  ", nodeID: " node-abc ")
        XCTAssertEqual(store.wakeCredential()?.nodeID, "node-abc")
        XCTAssertEqual(store.wakeCredential()?.token, "wake-secret-token")

        let restored = ClientIdentityStore()
        XCTAssertEqual(restored.wakeCredential()?.nodeID, "node-abc")
        XCTAssertEqual(restored.wakeCredential()?.token, "wake-secret-token")
        restored.forgetPairedMaterialForTesting()
        XCTAssertNil(restored.wakeCredential())
    }

    func testPowerClientMapsControlPlaneErrors() async throws {
        let client = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(status: 401, body: #"{"error":"unauthorized"}"#))
        )
        do {
            _ = try await client.start(nodeID: "node-abc", wakeToken: "token-token-token-token")
            XCTFail("expected unauthorized")
        } catch let error as RelayMachinePowerError {
            XCTAssertEqual(error, .unauthorized)
        }

        let missing = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(status: 503, body: #"{"error":"power_unconfigured"}"#))
        )
        do {
            _ = try await missing.state(nodeID: "node-abc", wakeToken: "token-token-token-token")
            XCTFail("expected unconfigured")
        } catch let error as RelayMachinePowerError {
            XCTAssertEqual(error, .unconfigured)
        }

        let stopper = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(
                status: 200,
                body: #"{"ok":true,"power":{"nodeId":"node-abc","instanceState":"stopping"}}"#
            ))
        )
        let stopped = try await stopper.stop(nodeID: "node-abc", wakeToken: "token-token-token-token")
        XCTAssertEqual(stopped.instanceState, "stopping")
        XCTAssertTrue(stopped.isStopped)
        XCTAssertFalse(stopped.isRunning)
    }

    func testPowerSwitchTreatsStartingAsOnAndLocksWhileBusy() {
        XCTAssertTrue(RelayMachinePowerModel.Status.on.isPowered)
        XCTAssertTrue(RelayMachinePowerModel.Status.starting.isPowered)
        XCTAssertFalse(RelayMachinePowerModel.Status.off.isPowered)
        XCTAssertFalse(RelayMachinePowerModel.Status.stopping.isPowered)
        XCTAssertFalse(RelayMachinePowerModel.Status.unavailable.canToggle)
        XCTAssertFalse(RelayMachinePowerModel.Status.starting.canToggle)
        XCTAssertTrue(RelayMachinePowerModel.Status.off.canToggle)
        XCTAssertEqual(RelayMachinePowerModel.Status.starting.switchDetail, "Starting…")
        XCTAssertNil(RelayMachinePowerModel.Status.on.switchDetail)
    }

    private func urlSessionReturning(status: Int, body: String) -> URLSessionConfiguration {
        MockPowerURLProtocol.status = status
        MockPowerURLProtocol.body = Data(body.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockPowerURLProtocol.self]
        return configuration
    }
}

private final class MockPowerURLProtocol: URLProtocol {
    static var status = 200
    static var body = Data()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: Self.status,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Self.body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
