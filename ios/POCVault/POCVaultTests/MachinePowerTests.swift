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

        // One failed read is routine (the first request after foregrounding
        // often dies on a closed socket) and is retried, so it stays quiet.
        fake.stateError = RelayMachinePowerError.timeout
        await model.refresh()
        XCTAssertEqual(model.status, .on)
        XCTAssertNil(model.notice)

        await model.refresh()
        XCTAssertEqual(model.status, .on)
        XCTAssertNotNil(model.notice)

        fake.stateError = nil
        await model.refresh()
        XCTAssertNil(model.notice, "a read that lands clears what the failed ones said")
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

    // MARK: - Staying in sync with a machine that moves on its own

    /// The machine is started and stopped behind the app's back (idle
    /// auto-stop, a node request's auto-wake, another phone). A read on appear
    /// that lands on `pending` used to leave the switch on "Starting…" for
    /// good, because nothing read again.
    @MainActor
    func testWatchFollowsAMachineItDidNotStart() async {
        let (model, _) = makeModel(states: ["pending", "pending", "running"])

        let watching = Task { await model.watch() }
        defer { watching.cancel() }
        await waitUntil { model.status == .starting }
        XCTAssertEqual(model.status, .starting)
        await waitUntil { model.status == .on }
        XCTAssertEqual(model.status, .on)
    }

    @MainActor
    func testWatchRetriesAReadThatFailed() async {
        let (model, fake) = makeModel(states: ["stopped"])
        fake.stateFailures = 2

        let watching = Task { await model.watch() }
        defer { watching.cancel() }
        await waitUntil { model.status == .off }
        XCTAssertEqual(model.status, .off)
        XCTAssertNil(model.notice)
    }

    /// A refused start is not evidence the machine is off. The usual cause is
    /// the 15 s rate limit after a node request's auto-wake already started it.
    @MainActor
    func testRefusedStartReadsTheMachineInsteadOfGuessingOff() async {
        let (model, fake) = makeModel(states: ["stopped", "pending", "running"])
        await model.refresh()
        XCTAssertEqual(model.status, .off)

        fake.startError = RelayMachinePowerError.rateLimited
        await model.start()
        XCTAssertEqual(model.status, .on)
        XCTAssertNil(model.notice, "the machine is doing what the tap asked for")
    }

    @MainActor
    func testRefusedStartOnAStoppedMachineSaysSoAndStaysOff() async {
        let (model, fake) = makeModel(states: ["stopped"])
        await model.refresh()

        fake.startError = RelayMachinePowerError.awsFailed
        await model.start()
        XCTAssertEqual(model.status, .off)
        XCTAssertEqual(model.notice, RelayMachinePowerError.awsFailed.errorDescription)

        // The complaint outlives the reads that follow it, until the machine moves.
        await model.refresh()
        XCTAssertNotNil(model.notice)
    }

    /// A stop whose reply was lost may still have been carried out. Claiming
    /// On here is how a stopped machine came to be shown as running.
    @MainActor
    func testStopWithALostReplyDoesNotClaimTheMachineIsOn() async {
        let (model, fake) = makeModel(states: ["running", "stopping", "stopped"])
        await model.refresh()
        XCTAssertEqual(model.status, .on)

        fake.stopError = RelayMachinePowerError.invalidEndpoint
        await model.stop()
        XCTAssertEqual(model.status, .off)
        XCTAssertNil(model.notice)
    }

    @MainActor
    func testOneFailedPollDoesNotAbortAStart() async {
        let (model, fake) = makeModel(states: ["pending", "running"])
        fake.stateFailures = 1

        await model.start()
        XCTAssertEqual(model.status, .on)
        XCTAssertNil(model.notice)
    }

    @MainActor
    func testStopHoldsStoppingUntilTheMachineHasStopped() async {
        let (model, _) = makeModel(states: ["running", "stopping", "stopped"])
        await model.refresh()

        let stopping = Task { await model.stop() }
        await waitUntil { model.status == .stopping }
        XCTAssertEqual(model.status, .stopping)
        await stopping.value
        XCTAssertEqual(model.status, .off)
    }

    /// Any node request to a stopped machine starts it, and EC2 goes on
    /// answering `stopped` for the first seconds. The switch must not read
    /// that as Off for a machine the app is bringing up.
    @MainActor
    func testAutoWakeIsNotReadAsOff() async {
        let (model, fake) = makeModel(states: ["stopped"])
        await model.refresh()
        XCTAssertEqual(model.status, .off)

        model.machineWakeBegan()
        await waitUntil { model.status == .starting }
        XCTAssertEqual(model.status, .starting)

        fake.replaceStates(["running"])
        model.machineWakeEnded()
        await waitUntil { model.status == .on }
        XCTAssertEqual(model.status, .on)
    }

    @MainActor
    func testAFailedAutoWakeFallsBackToWhatEC2Says() async {
        let (model, _) = makeModel(states: ["stopped"])
        await model.refresh()

        model.machineWakeBegan()
        await waitUntil { model.status == .starting }
        model.machineWakeEnded()
        await waitUntil { model.status == .off }
        XCTAssertEqual(model.status, .off)
    }

    @MainActor
    func testPairingAnotherMachineDropsTheLastOnesState() async {
        let store = ClientIdentityStore()
        store.storeWakeToken("wake-secret-token", nodeID: "node-abc")
        let fake = FakePowerClient(states: ["running"])
        fake.stateError = nil
        let model = RelayMachinePowerModel(powerClient: fake, settleInterval: .milliseconds(5),
                                           steadyInterval: .milliseconds(20))
        model.configure(identityStore: store)
        await model.refresh()
        XCTAssertEqual(model.status, .on)

        store.storeWakeToken("other-wake-token", nodeID: "node-xyz")
        fake.stateError = RelayMachinePowerError.timeout
        await model.refresh()
        XCTAssertEqual(model.status, .unknown, "the first machine's On is not carried over")
        XCTAssertEqual(fake.lastNodeID, "node-xyz")
    }

    /// One model, owned by the app. Two screens each holding their own was
    /// how Settings and Usage came to disagree about the same machine.
    func testSettingsAndUsageShareOnePowerModel() throws {
        let app = try AppSourceFixture.load("POCVault/POCVaultApp.swift")
        let settings = try AppSourceFixture.load("POCVault/Views/AccountSettingsView.swift")
        let usage = try AppSourceFixture.load("POCVault/Views/RelayMachineMonitorView.swift")
        XCTAssertEqual(app.components(separatedBy: "RelayMachinePowerModel()").count - 1, 1)
        XCTAssertFalse(settings.contains("RelayMachinePowerModel()"))
        XCTAssertFalse(usage.contains("RelayMachinePowerModel()"))
        XCTAssertTrue(settings.contains("await powerModel.watch()"))
        XCTAssertTrue(usage.contains("await powerModel.watch()"))
        XCTAssertTrue(app.contains("codexClient.onMachineWake"))
    }

    /// The switch only displays. A two-way binding let a tap move it before
    /// the model agreed, and it was then pulled back.
    func testPowerSwitchIsDrawnFromTheModelAlone() throws {
        let settings = try AppSourceFixture.load("POCVault/Views/AccountSettingsView.swift")
        XCTAssertTrue(settings.contains("Toggle(\"Power\", isOn: .constant(model.status.isPowered))"))
        XCTAssertTrue(settings.contains(".allowsHitTesting(false)"))
        XCTAssertTrue(settings.contains("Button(action: requestToggle)"))
    }

    /// Screens that report on the machine must not be what powers it on:
    /// opening Settings used to start a stopped machine under an Off switch.
    func testStatusScreensDoNotWakeTheMachine() throws {
        let client = try AppSourceFixture.load("POCVault/Networking/CodexClient.swift")
        let settings = try AppSourceFixture.load("POCVault/Views/AccountSettingsView.swift")
        XCTAssertTrue(settings.contains("fetchHarnesses(budget: .statusRead)"))
        XCTAssertFalse(CodexRequestBudget.statusRead.allowsMachineWake)
        let stats = try XCTUnwrap(client.range(of: "path: \"/v1/machine/stats\","))
        XCTAssertTrue(client[stats.upperBound...].prefix(160).contains("allowWake: false"))
    }

    @MainActor
    private func makeModel(states: [String]) -> (RelayMachinePowerModel, FakePowerClient) {
        let store = ClientIdentityStore()
        store.storeWakeToken("wake-secret-token", nodeID: "node-abc")
        let fake = FakePowerClient(states: states)
        let model = RelayMachinePowerModel(powerClient: fake, settleInterval: .milliseconds(5),
                                           steadyInterval: .milliseconds(20))
        model.configure(identityStore: store)
        return (model, fake)
    }

    @MainActor
    private func waitUntil(_ condition: () -> Bool) async {
        for _ in 0..<400 where !condition() {
            try? await Task.sleep(for: .milliseconds(5))
        }
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
    /// Reads that fail before the next one is allowed through.
    var stateFailures = 0
    var startError: Error?
    var stopError: Error?
    private(set) var lastNodeID: String?
    var autoStop: Bool?
    var autoStopError: Error?
    private(set) var autoStopWrites: [Bool] = []

    init(states: [String]) {
        self.states = states
    }

    func replaceStates(_ next: [String]) {
        states = next
    }

    func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        if let startError { throw startError }
        return RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", instanceState: startState)
    }

    func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        if let stopError { throw stopError }
        return RelayMachinePowerState(nodeID: nodeID, instanceID: "i-1", region: "ap-south-1", instanceState: stopState)
    }

    func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
        lastNodeID = nodeID
        if let stateError { throw stateError }
        if stateFailures > 0 {
            stateFailures -= 1
            throw RelayMachinePowerError.invalidEndpoint
        }
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
