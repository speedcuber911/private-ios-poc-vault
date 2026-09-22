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

    func testLoadingIsNeitherOnNorOffAndCannotBeToggled() {
        let loading = RelayMachinePowerModel.Status.loading
        XCTAssertFalse(loading.isResolved)
        XCTAssertFalse(loading.canToggle)
        XCTAssertFalse(loading.isPowered)
        XCTAssertEqual(loading.switchDetail, "Checking…")
        XCTAssertTrue(RelayMachinePowerModel.Status.on.isResolved)
        XCTAssertTrue(RelayMachinePowerModel.Status.off.isResolved)
    }

    @MainActor
    func testSwitchStaysLoadingUntilTheFirstReadLands() async {
        let store = ClientIdentityStore()
        store.storeWakeToken("wake-secret-token", nodeID: "node-abc")
        let fake = FakePowerClient(states: ["running"])
        let model = RelayMachinePowerModel(powerClient: fake)
        model.configure(identityStore: store)

        XCTAssertEqual(model.status, .loading)
        await model.refresh()
        XCTAssertEqual(model.status, .on)
    }

    /// A read that fails says nothing about the machine, so the switch must
    /// keep the position it earned instead of falling back to off.
    @MainActor
    func testFailedReadKeepsTheLastKnownPosition() async {
        let store = ClientIdentityStore()
        store.storeWakeToken("wake-secret-token", nodeID: "node-abc")
        let fake = FakePowerClient(states: ["running"])
        let model = RelayMachinePowerModel(powerClient: fake)
        model.configure(identityStore: store)
        await model.refresh()
        XCTAssertEqual(model.status, .on)

        fake.stateError = RelayMachinePowerError.timeout
        await model.refresh()
        XCTAssertEqual(model.status, .on)
        XCTAssertNotNil(model.notice)
    }

    /// The glitch this guards: EC2 still answers `stopped` for a few seconds
    /// after a start is accepted, and a read landing in that window used to
    /// flip the switch off before the next poll turned it back on.
    @MainActor
    func testStaleReadDuringStartCannotFlipTheSwitchOff() async {
        let store = ClientIdentityStore()
        store.storeWakeToken("wake-secret-token", nodeID: "node-abc")
        let fake = FakePowerClient(states: ["stopped", "running"])
        fake.startState = "stopped"
        let model = RelayMachinePowerModel(powerClient: fake)
        model.configure(identityStore: store)

        let starting = Task { await model.start() }
        try? await Task.sleep(for: .milliseconds(100))
        XCTAssertEqual(model.status, .starting)
        await model.refresh()
        XCTAssertEqual(model.status, .starting, "a concurrent read must not interrupt a start")
        await starting.value
        XCTAssertEqual(model.status, .on)
    }

    private func urlSessionReturning(status: Int, body: String) -> URLSessionConfiguration {
        MockPowerURLProtocol.status = status
        MockPowerURLProtocol.body = Data(body.utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MockPowerURLProtocol.self]
        return configuration
    }
}

private final class FakePowerClient: RelayMachinePowering, @unchecked Sendable {
    private var states: [String]
    var startState = "pending"
    var stopState = "stopping"
    var stateError: Error?

    init(states: [String]) {
        self.states = states
    }

    func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", instanceState: startState)
    }

    func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", instanceState: stopState)
    }

    func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        if let stateError { throw stateError }
        let next = states.count > 1 ? states.removeFirst() : (states.first ?? "running")
        return RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", instanceState: next)
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
