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

    func testInstanceTypeAndResizeUseThePairingCredential() async throws {
        let client = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(
                status: 200,
                body: #"{"ok":true,"power":{"nodeId":"node-abc","instanceState":"running","instanceType":"t3.medium","resizeOptions":["t3.small","t3.medium","t3.large"]}}"#
            ))
        )
        let state = try await client.state(nodeID: "node-abc", wakeToken: "pairing-wake-token")
        XCTAssertEqual(state.instanceType, "t3.medium")
        XCTAssertEqual(state.resizeOptions, ["t3.small", "t3.medium", "t3.large"])

        MockPowerURLProtocol.status = 202
        MockPowerURLProtocol.body = Data(#"{"ok":true,"power":{"nodeId":"node-abc","instanceState":"running","instanceType":"t3.medium","resize":{"targetType":"t3.large","stage":"requested"}}}"#.utf8)
        let accepted = try await client.resize(nodeID: "node-abc", wakeToken: "pairing-wake-token",
                                               from: "t3.medium", to: "t3.large")
        XCTAssertEqual(accepted.resize?.targetType, "t3.large")
        XCTAssertEqual(accepted.resize?.stage, "requested")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.url?.path, "/v1/power/node-abc/resize")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer pairing-wake-token")
        if let body = MockPowerURLProtocol.lastBody,
           let payload = try JSONSerialization.jsonObject(with: body) as? [String: String] {
            XCTAssertEqual(payload, ["expectedType": "t3.medium", "targetType": "t3.large"])
        } else {
            XCTFail("Expected JSON resize request body")
        }
    }

    func testPowerClientReadsMonthlyComputeEstimateAndResizeProgress() async throws {
        let client = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(
                status: 200,
                body: #"{"ok":true,"power":{"nodeId":"node-abc","region":"ap-south-1","instanceState":"running","instanceType":"m7i.2xlarge","resizeOptions":["m7i.large","m7i.2xlarge","m7i.4xlarge"],"pricing":{"currency":"USD","hoursPerMonth":730,"checkedAt":"2026-09-28","hourlyUSD":{"m7i.large":0.10605,"m7i.2xlarge":0.4242,"m7i.4xlarge":0.8484}},"resize":{"targetType":"m7i.4xlarge","stage":"waiting_stop","wasRunning":true}}}"#
            ))
        )

        let state = try await client.state(nodeID: "node-abc", wakeToken: "pairing-wake-token")
        XCTAssertEqual(state.pricing?.hourly(for: "m7i.2xlarge"), 0.4242)
        XCTAssertEqual(state.pricing?.monthly(for: "m7i.2xlarge") ?? 0, 309.666, accuracy: 0.0001)
        XCTAssertEqual(state.pricing?.monthly(for: "m7i.4xlarge") ?? 0, 619.332, accuracy: 0.0001)
        XCTAssertNil(state.pricing?.monthly(for: "m7i.8xlarge"))
        XCTAssertEqual(state.resize?.stage, "waiting_stop")
        XCTAssertEqual(state.resize?.wasRunning, true)
    }

    func testAutoStopReadsAndWritesThroughThePairingCredential() async throws {
        let client = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(
                status: 200,
                body: #"{"ok":true,"power":{"nodeId":"node-abc","instanceState":"running","autoStopEnabled":true}}"#
            ))
        )
        let read = try await client.state(nodeID: "node-abc", wakeToken: "pairing-wake-token")
        XCTAssertEqual(read.autoStopEnabled, true)

        MockPowerURLProtocol.body = Data(#"{"ok":true,"power":{"nodeId":"node-abc","instanceState":"running"}}"#.utf8)
        let older = try await client.state(nodeID: "node-abc", wakeToken: "pairing-wake-token")
        XCTAssertNil(older.autoStopEnabled, "a control plane without auto-stop must not invent a value")

        MockPowerURLProtocol.body = Data(#"{"ok":true,"power":{"nodeId":"node-abc","autoStopEnabled":false}}"#.utf8)
        let saved = try await client.setAutoStop(nodeID: "node-abc", wakeToken: "pairing-wake-token", enabled: false)
        XCTAssertEqual(saved.autoStopEnabled, false)
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.url?.path, "/v1/power/node-abc/autostop")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.httpMethod, "POST")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer pairing-wake-token")
        let body = try XCTUnwrap(MockPowerURLProtocol.lastBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: Bool], ["enabled": false])
    }

    @MainActor
    func testAutoStopSwitchRevertsOnFailureAndIgnoresLaggingTagReads() async {
        let store = ClientIdentityStore()
        store.storeWakeToken("wake-secret-token", nodeID: "node-abc")
        let fake = FakePowerClient(states: ["running"])
        fake.autoStop = true
        let model = RelayMachinePowerModel(powerClient: fake)
        model.configure(identityStore: store)
        await model.refresh()
        XCTAssertEqual(model.autoStopEnabled, true)

        fake.autoStopError = RelayMachinePowerError.rateLimited
        await model.setAutoStop(false)
        XCTAssertEqual(model.autoStopEnabled, true)
        XCTAssertFalse(model.isSavingAutoStop)
        XCTAssertNotNil(model.notice)

        fake.autoStopError = nil
        await model.setAutoStop(false)
        XCTAssertEqual(model.autoStopEnabled, false)
        XCTAssertEqual(fake.autoStopWrites, [false, false])

        // The fake still reports the old tag, as EC2 can just after a write.
        await model.refresh()
        XCTAssertEqual(model.autoStopEnabled, false)
    }

    // MARK: - Power notifications

    func testPowerPushSubscriptionUsesThePairingCredentialAlone() async throws {
        let client = RelayPowerClient(
            baseURL: URL(string: "https://relay.example")!,
            session: URLSession(configuration: urlSessionReturning(status: 200, body: #"{"ok":true}"#))
        )
        try await client.subscribePush(nodeID: "node-abc", wakeToken: "pairing-wake-token",
                                       apnsToken: "abcd", environment: "production")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.url?.path, "/v1/power/node-abc/push")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.httpMethod, "PUT")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.value(forHTTPHeaderField: "Authorization"),
                       "Bearer pairing-wake-token")
        let body = try XCTUnwrap(MockPowerURLProtocol.lastBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: String],
                       ["apnsToken": "abcd", "apnsEnvironment": "production"])

        try await client.unsubscribePush(nodeID: "node-abc", wakeToken: "pairing-wake-token", apnsToken: "abcd")
        XCTAssertEqual(MockPowerURLProtocol.lastRequest?.httpMethod, "DELETE")
        let removed = try XCTUnwrap(MockPowerURLProtocol.lastBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: removed) as? [String: String], ["apnsToken": "abcd"])
    }

    func testPowerPushesOpenTheMachineScreen() {
        for type in ["power.stopped", "power.ready"] {
            XCTAssertEqual(
                RelayPushService.route(from: ["relay": ["nodeId": "node-abc", "type": type]]),
                .machine(nodeID: "node-abc")
            )
        }
    }

    @MainActor
    func testPushServiceSubscribesThePairedMachineWithoutAnAccount() async throws {
        let suite = "power-push-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let identityStore = ClientIdentityStore(defaults: defaults)
        let authClient = RelayAuthClient(baseURL: try XCTUnwrap(URL(string: "https://cloud.test")))
        let accountStore = RelayAccountStore(client: authClient, identityStore: identityStore, defaults: defaults)
        XCTAssertNil(accountStore.currentSessionToken)
        let recorder = PowerPushRecorder()
        let service = RelayPushService(
            accountStore: accountStore,
            codexClient: CodexClient(baseURL: try XCTUnwrap(URL(string: "https://node.test")), identityStore: identityStore),
            identityStore: identityStore,
            powerPush: recorder,
            authBaseURL: try XCTUnwrap(URL(string: "https://cloud.test"))
        )

        await service.handleDeviceToken(Data([0xab, 0xcd]))
        XCTAssertTrue(recorder.subscribed.isEmpty, "nothing to subscribe to before pairing")

        identityStore.storeWakeToken("wake-1", nodeID: "node-abc")
        await service.registerPendingDeviceTokenIfNeeded()
        await service.registerPendingDeviceTokenIfNeeded()
        XCTAssertEqual(recorder.subscribed.count, 1, "unchanged credentials are not re-sent")
        XCTAssertEqual(recorder.subscribed.first?.nodeID, "node-abc")
        XCTAssertEqual(recorder.subscribed.first?.wakeToken, "wake-1")
        XCTAssertEqual(recorder.subscribed.first?.apnsToken, "abcd")

        identityStore.storeWakeToken("wake-2", nodeID: "node-abc")
        await service.registerPendingDeviceTokenIfNeeded()
        XCTAssertEqual(recorder.subscribed.count, 2, "a re-pair's new wake token subscribes again")

        identityStore.discardPairedMaterial()
        for _ in 0..<50 where recorder.unsubscribed.isEmpty { await Task.yield() }
        XCTAssertEqual(recorder.unsubscribed.first?.wakeToken, "wake-2")
        XCTAssertEqual(recorder.unsubscribed.first?.apnsToken, "abcd")
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
    var autoStop: Bool?
    var autoStopError: Error?
    private(set) var autoStopWrites: [Bool] = []

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
        return RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", instanceState: next,
                                      autoStopEnabled: autoStop)
    }

    func resize(nodeID: String, wakeToken: String, from: String, to: String) async throws -> RelayMachinePowerState {
        throw RelayMachinePowerError.invalidSize
    }

    func setAutoStop(nodeID: String, wakeToken: String, enabled: Bool) async throws -> RelayMachinePowerState {
        autoStopWrites.append(enabled)
        if let autoStopError { throw autoStopError }
        return RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", autoStopEnabled: enabled)
    }
}

private final class MockPowerURLProtocol: URLProtocol {
    static var status = 200
    static var body = Data()
    static var lastRequest: URLRequest?
    static var lastBody: Data?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lastRequest = request
        if let body = request.httpBody {
            Self.lastBody = body
        } else if let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var bytes = [UInt8](repeating: 0, count: 4096)
            var collected = Data()
            while stream.hasBytesAvailable {
                let count = stream.read(&bytes, maxLength: bytes.count)
                if count <= 0 { break }
                collected.append(contentsOf: bytes.prefix(count))
            }
            Self.lastBody = collected
        } else {
            Self.lastBody = nil
        }
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

private final class PowerPushRecorder: RelayPowerPushSubscribing {
    struct Call: Equatable {
        var nodeID: String
        var wakeToken: String
        var apnsToken: String
    }
    var subscribed: [Call] = []
    var unsubscribed: [Call] = []

    func subscribePush(nodeID: String, wakeToken: String, apnsToken: String, environment: String) async throws {
        subscribed.append(Call(nodeID: nodeID, wakeToken: wakeToken, apnsToken: apnsToken))
    }

    func unsubscribePush(nodeID: String, wakeToken: String, apnsToken: String) async throws {
        unsubscribed.append(Call(nodeID: nodeID, wakeToken: wakeToken, apnsToken: apnsToken))
    }
}
