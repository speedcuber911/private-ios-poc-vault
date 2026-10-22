import XCTest
@testable import POCVault

final class RelayWatchTests: XCTestCase {
    func testPowerCommandsRequireTheCurrentMachineAndAnAvailableAction() throws {
        var value = snapshot()
        let start = RelayWatchCommand(kind: .powerOn, sourceID: value.sourceID)
        let stop = RelayWatchCommand(kind: .powerOff, sourceID: value.sourceID)
        XCTAssertThrowsError(try start.validate(against: value))
        for state in [RelayWatchMachine.State.starting, .stopping, .unavailable] {
            value.machine = RelayWatchMachine(name: "Mac", state: state, canControl: true)
            XCTAssertThrowsError(try start.validate(against: value))
            XCTAssertThrowsError(try stop.validate(against: value))
        }
        value.machine = RelayWatchMachine(name: "Mac", state: .off, canControl: true)
        XCTAssertNoThrow(try start.validate(against: value))
        XCTAssertThrowsError(try stop.validate(against: value))
        XCTAssertThrowsError(try send().validate(against: value))
        value.machine = RelayWatchMachine(name: "Mac", state: .on, canControl: true)
        XCTAssertNoThrow(try stop.validate(against: value))
        XCTAssertThrowsError(try start.validate(against: value))
        value.machine = RelayWatchMachine(name: "Mac", state: .on, canControl: false)
        XCTAssertThrowsError(try stop.validate(against: value))
        var stale = start
        stale.sourceID = "another-machine"
        XCTAssertThrowsError(try stale.validate(against: value))
        XCTAssertTrue(start.isMutation)
        XCTAssertTrue(stop.isMutation)
    }

    func testPowerSnapshotRetainsOnlySameMachineHistoryAndDropsStaleApprovals() throws {
        let previous = snapshot()
        let machine = RelayWatchMachine(name: "Mac", state: .off, canControl: true)
        let offline = RelayWatchProjection.powerSnapshot(sourceID: previous.sourceID, machine: machine, cached: previous)
        XCTAssertEqual(offline.threads, previous.threads)
        XCTAssertTrue(offline.approvals.isEmpty)
        XCTAssertEqual(offline.machine, machine)
        XCTAssertFalse(offline.hasSameContent(as: previous))
        let changed = RelayWatchProjection.powerSnapshot(sourceID: "machine-b", machine: machine, cached: previous)
        XCTAssertTrue(changed.threads.isEmpty)
        XCTAssertTrue(changed.models.isEmpty)
        XCTAssertTrue(changed.folders.isEmpty)
        let decoded = try RelayWatchWire.decode(RelayWatchSnapshot.self, from: RelayWatchWire.encode(offline))
        XCTAssertEqual(decoded, offline)
        // Old phones omit the optional power payload entirely.
        XCTAssertNil(try RelayWatchWire.decode(RelayWatchSnapshot.self, from: RelayWatchWire.encode(previous)).machine)
    }

    func testPowerTransitionsRefreshQuicklyOnlyWhileWatchIsVisible() {
        var value = snapshot()
        value.machine = RelayWatchMachine(name: "Mac", state: .starting, canControl: true)
        XCTAssertEqual(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
            watchedJobID: nil, snapshot: value, failures: 0), 5)
        XCTAssertNil(RelayWatchRefreshPolicy.interval(isActive: false, isComposing: false,
            watchedJobID: nil, snapshot: value, failures: 0))
        XCTAssertEqual(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
            watchedJobID: nil, snapshot: value, failures: 2), 60)
    }

    func testPowerProjectionLocksControlsDuringResizeAndPreservesUnknownState() {
        var power = RelayMachinePowerState(nodeID: "node", instanceState: "pending")
        XCTAssertEqual(RelayWatchProjection.machine(name: "Mac", state: power).state, .starting)
        power.instanceState = "stopping"
        XCTAssertEqual(RelayWatchProjection.machine(name: "Mac", state: power).state, .stopping)
        power.instanceState = nil
        XCTAssertEqual(RelayWatchProjection.machine(name: "Mac", state: power).state, .unknown)
        power.instanceState = "running"
        power.resize = .init(targetType: "t3.large", stage: "stopping")
        XCTAssertFalse(RelayWatchProjection.machine(name: "Mac", state: power).canStop)
    }

    @MainActor
    func testWatchCanReadAndStartAStoppedMachineWithoutItsNodeAPI() async throws {
        let (bridge, power, _, _) = try powerBridge()
        let reply = await bridge.handle(RelayWatchCommand(kind: .refresh))
        XCTAssertEqual(reply.outcome, .ok)
        XCTAssertEqual(reply.snapshot?.machine?.state, .off)
        XCTAssertTrue(reply.snapshot?.threads.isEmpty == true)
        XCTAssertEqual(power.starts, 0)
        let command = RelayWatchCommand(kind: .powerOn, sourceID: bridge.sourceID)
        let started = await bridge.handle(command)
        XCTAssertEqual(started.outcome, .ok)
        XCTAssertEqual(started.snapshot?.machine?.state, .starting)
        XCTAssertEqual(power.starts, 1)
        XCTAssertEqual(power.lastNodeID, "watch-power-node")
        let wire = String(decoding: try JSONEncoder().encode(started), as: UTF8.self)
        XCTAssertFalse(wire.contains("watch-test-token"))
        XCTAssertFalse(wire.contains("unreachable.invalid"))
        power.instanceState = "stopped"
        let staleRead = await bridge.handle(.init(kind: .refresh))
        XCTAssertEqual(staleRead.snapshot?.machine?.state, .starting)
        let secondStart = await bridge.handle(.init(kind: .powerOn, sourceID: bridge.sourceID))
        XCTAssertEqual(secondStart.outcome, .rejected)
        // Duplicate delivery and a receipt lookup must never start it again.
        _ = await bridge.handle(command)
        var lookup = RelayWatchCommand(kind: .delivery, sourceID: bridge.sourceID)
        lookup.originalRequestID = command.id
        let receipt = await bridge.handle(lookup)
        XCTAssertEqual(receipt.outcome, .ok)
        XCTAssertEqual(power.starts, 1)
    }

    @MainActor
    func testWatchCanStopWithoutReadingChatsAndKeepsUncertainWritesFromRetrying() async throws {
        let (bridge, power, _, _) = try powerBridge()
        power.instanceState = "running"
        let stopped = await bridge.handle(.init(kind: .powerOff, sourceID: bridge.sourceID))
        XCTAssertEqual(stopped.outcome, .ok)
        XCTAssertEqual(stopped.snapshot?.machine?.state, .stopping)
        XCTAssertEqual(power.stops, 1)
        power.instanceState = "running"
        let staleRead = await bridge.handle(.init(kind: .refresh))
        XCTAssertEqual(staleRead.snapshot?.machine?.state, .stopping)
        power.instanceState = "stopped"
        power.writeError = URLError(.timedOut)
        let command = RelayWatchCommand(kind: .powerOn, sourceID: bridge.sourceID)
        let uncertain = await bridge.handle(command)
        XCTAssertEqual(uncertain.outcome, .uncertain)
        _ = await bridge.handle(command)
        XCTAssertEqual(power.starts, 1)
    }

    @MainActor
    func testWatchRejectsChangedPairingAndMismatchedPowerCredentials() async throws {
        let (bridge, power, nodes, identity) = try powerBridge()
        identity.storeWakeToken("wrong-node-token", nodeID: "another-node")
        let mismatched = await bridge.handle(.init(kind: .powerOn, sourceID: bridge.sourceID))
        XCTAssertEqual(mismatched.outcome, .rejected)
        XCTAssertEqual(power.reads, 0)
        XCTAssertEqual(power.starts, 0)
        identity.storeWakeToken("watch-test-token", nodeID: "watch-power-node")
        let original = bridge.sourceID
        power.onRead = {
            nodes.adopt(RelayPairedNode(nodeID: "watch-power-node", nodeName: "Mac",
                apiBaseURL: nodes.effectiveBaseURL, deviceID: "new-pairing"))
        }
        let changed = await bridge.handle(.init(kind: .powerOn, sourceID: original))
        XCTAssertEqual(changed.outcome, .rejected)
        XCTAssertEqual(power.starts, 0)
    }

    @MainActor
    private func powerBridge() throws -> (RelayWatchBridge, WatchPowerStub, RelayNodeStore, ClientIdentityStore) {
        let suite = "relay-watch-power-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        let nodes = RelayNodeStore(defaults: defaults)
        let identity = ClientIdentityStore()
        identity.forgetPairedMaterialForTesting()
        identity.storeWakeToken("watch-test-token", nodeID: "watch-power-node")
        let url = try XCTUnwrap(URL(string: "https://unreachable.invalid"))
        nodes.adopt(RelayPairedNode(nodeID: "watch-power-node", nodeName: "Development Mac",
            apiBaseURL: url, deviceID: "watch-test-device"))
        let power = WatchPowerStub()
        let receipts = FileManager.default.temporaryDirectory.appendingPathComponent("watch-\(UUID().uuidString).json")
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suite)
            identity.forgetPairedMaterialForTesting()
            try? FileManager.default.removeItem(at: receipts)
        }
        return (RelayWatchBridge(client: CodexClient(baseURL: url, identityStore: identity, powerClient: power),
            nodes: nodes, identityStore: identity, powerClient: power, receiptURL: receipts, connectsWatch: false), power, nodes, identity)
    }

    private final class WatchPowerStub: RelayMachinePowering {
        var instanceState = "stopped"
        var reads = 0
        var starts = 0
        var stops = 0
        var lastNodeID: String?
        var writeError: Error?
        var onRead: (() -> Void)?
        func state(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
            reads += 1
            onRead?()
            return .init(nodeID: nodeID, instanceState: instanceState)
        }
        func start(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
            starts += 1
            lastNodeID = nodeID
            if let writeError { throw writeError }
            instanceState = "pending"
            return .init(nodeID: nodeID, instanceState: instanceState)
        }
        func stop(nodeID: String, wakeToken: String) async throws -> RelayMachinePowerState {
            stops += 1
            if let writeError { throw writeError }
            instanceState = "stopping"
            return .init(nodeID: nodeID, instanceState: instanceState)
        }
        func resize(nodeID: String, wakeToken: String, from: String, to: String) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }
        func setAutoStop(nodeID: String, wakeToken: String, enabled: Bool) async throws -> RelayMachinePowerState {
            throw RelayMachinePowerError.unconfigured
        }
    }

    func testDictationBatchesRejectMissingRepeatedAndMalformedAudio() throws {
        var ledger = RelayWatchAudioLedger()
        let pcm = Data(repeating: 0, count: RelayWatchDictationWire.chunkBytes)
        XCTAssertThrowsError(try ledger.accept(pcm, sequence: 1))
        XCTAssertEqual(ledger.nextSequence, 0)
        try ledger.accept(pcm, sequence: 0)
        XCTAssertThrowsError(try ledger.accept(pcm, sequence: 0))
        XCTAssertThrowsError(try ledger.accept(Data([0]), sequence: 1))
        XCTAssertThrowsError(try ledger.accept(Data(), sequence: 1))
        XCTAssertThrowsError(try ledger.accept(Data(repeating: 0, count: pcm.count + 2), sequence: 1))
        XCTAssertEqual(ledger.audioBytes, pcm.count)
        try ledger.accept(Data([0, 0]), sequence: 1)
        XCTAssertEqual(ledger.nextSequence, 2)
    }

    func testDictationCapsAudioAtOneMinuteAndFitsTheTransport() throws {
        var ledger = RelayWatchAudioLedger()
        let pcm = Data(repeating: 0, count: RelayWatchDictationWire.chunkBytes)
        for sequence in 0..<120 { try ledger.accept(pcm, sequence: sequence) }
        XCTAssertThrowsError(try ledger.accept(pcm, sequence: 120))
        let request = RelayWatchDictationRequest(sessionID: UUID().uuidString, sourceID: "machine-a", kind: .audio, audio: pcm)
        let wire = try RelayWatchDictationWire.encode(request)
        XCTAssertLessThan(try XCTUnwrap(wire[RelayWatchDictationWire.key] as? Data).count, RelayWatchWire.maximumBytes)
        let copy = try RelayWatchDictationWire.decode(RelayWatchDictationRequest.self, from: wire)
        XCTAssertEqual(copy.audio, pcm)
        XCTAssertEqual(copy.sessionID, request.sessionID)
    }

    @MainActor
    func testWatchDictationUsesExternalAudioAndFlushesOnlyAfterAllBatches() async {
        let speech = WatchSpeechStub()
        let bridge = RelayWatchDictationBridge(transcriber: speech, managesBackgroundTime: false)
        let id = UUID().uuidString
        let begin = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .begin))
        XCTAssertNil(begin.error)
        _ = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .begin))
        XCTAssertEqual(speech.starts, 1)
        let partial = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .audio, audio: Data([0, 0])))
        XCTAssertEqual(partial.transcript, "Fix the login")
        XCTAssertEqual(partial.nextSequence, 1)
        let final = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .finish, sequence: 1))
        XCTAssertTrue(final.finished)
        XCTAssertNil(final.error)
        XCTAssertEqual(final.transcript, "Fix the login screen.")
        XCTAssertEqual(speech.finishes, 1)
        XCTAssertEqual(speech.audio, [Data([0, 0])])
        _ = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .finish, sequence: 1))
        XCTAssertEqual(speech.finishes, 1)
        let staleMachine = await bridge.handle(.init(sessionID: id, sourceID: "machine-b", kind: .finish, sequence: 1))
        XCTAssertNotNil(staleMachine.error)
        XCTAssertTrue(staleMachine.transcript.isEmpty)
    }

    @MainActor
    func testWatchDictationCancellationAndExpiryCannotRestartFromLateAudio() async {
        for reason in [nil, "iPhone paused dictation"] as [String?] {
            let speech = WatchSpeechStub()
            let bridge = RelayWatchDictationBridge(transcriber: speech, managesBackgroundTime: false)
            let id = UUID().uuidString
            _ = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .begin))
            _ = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .audio, audio: Data([0, 0])))
            bridge.cancel(reason: reason)
            let late = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .audio, sequence: 1, audio: Data([0, 0])))
            XCTAssertTrue(late.finished)
            XCTAssertEqual(late.error, reason)
            XCTAssertEqual(late.transcript, "Fix the login")
            XCTAssertEqual(speech.audio.count, 1)
            XCTAssertEqual(speech.finishes, 0)
            XCTAssertGreaterThan(speech.cancels, 0)
        }
    }

    @MainActor
    func testWrongSourceAndOutOfOrderAudioNeverReachTheTranscriber() async {
        let speech = WatchSpeechStub()
        let bridge = RelayWatchDictationBridge(transcriber: speech, managesBackgroundTime: false)
        let id = UUID().uuidString
        _ = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .begin))
        let wrongSource = await bridge.handle(.init(sessionID: id, sourceID: "machine-b", kind: .audio, audio: Data([0, 0])))
        XCTAssertNotNil(wrongSource.error)
        let gap = await bridge.handle(.init(sessionID: id, sourceID: "machine-a", kind: .audio, sequence: 2, audio: Data([0, 0])))
        XCTAssertNotNil(gap.error)
        XCTAssertTrue(speech.audio.isEmpty)
    }

    @MainActor
    private final class WatchSpeechStub: RelayWatchTranscribing {
        var transcript = ""
        var starts = 0
        var finishes = 0
        var cancels = 0
        var audio: [Data] = []
        func startExternalAudio() throws { starts += 1; transcript = "" }
        func appendExternalAudio(_ data: Data) async throws { audio.append(data); transcript = "Fix the login" }
        func finishExternalAudio() async throws -> String { finishes += 1; transcript = "Fix the login screen."; return transcript }
        func cancel() { cancels += 1 }
    }

    func testCompanionMutationsRejectAChangedMachineBeforeNetworking() async throws {
        let original = try XCTUnwrap(URL(string: "https://original.invalid"))
        let client = CodexClient(baseURL: try XCTUnwrap(URL(string: "https://changed.invalid")), identityStore: ClientIdentityStore())
        let request = CodexCreateJobRequest(workspaceId: "registered-folder", prompt: "Fix tests", timeoutMs: nil)
        let mutations: [() async throws -> Void] = [
            { _ = try await client.createJob(request, expectedBaseURL: original) },
            { _ = try await client.decideApproval(id: "approval", decision: .accept, expectedBaseURL: original) },
            { _ = try await client.cancelJob(id: "job", expectedBaseURL: original) }
        ]
        for mutate in mutations {
            do { try await mutate(); XCTFail("A stale watch command must not reach the new machine.") }
            catch let error as URLError { XCTAssertEqual(error.code, .cancelled) }
        }
    }

    func testDeliveryLookupIsReadOnlyAndDraftIdentitySurvivesRetry() {
        let command = send()
        var lookup = RelayWatchCommand(kind: .delivery, sourceID: command.sourceID)
        lookup.originalRequestID = command.id
        XCTAssertFalse(lookup.isMutation)
        XCTAssertTrue(command.isMutation)
        XCTAssertEqual(command.draftKey, "relay.watch.draft.machine-a.new")
    }

    func testBackgroundAndComposerDisableAutomaticRefreshEvenDuringARun() {
        let running = snapshot(active: true)
        XCTAssertNil(RelayWatchRefreshPolicy.interval(isActive: false, isComposing: false,
            watchedJobID: "job", snapshot: running, failures: 0))
        XCTAssertNil(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: true,
            watchedJobID: "job", snapshot: running, failures: 0))
        XCTAssertNil(RelayWatchRefreshPolicy.interval(isActive: false, isComposing: true,
            watchedJobID: "job", snapshot: running, failures: 5))
    }

    func testRefreshSlowsWhenLeavingARunningThreadAndWhenItCompletes() {
        let running = snapshot(active: true)
        XCTAssertEqual(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
            watchedJobID: "job", snapshot: running, failures: 0), 15)
        XCTAssertEqual(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
            watchedJobID: nil, snapshot: running, failures: 0), 30)
        XCTAssertEqual(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
            watchedJobID: "job", snapshot: snapshot(), failures: 0), 120)
    }

    func testUnavailablePhoneBacksOffInsteadOfRepeatedFastPolling() {
        let running = snapshot(active: true)
        let delays = (1...6).map {
            RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
                watchedJobID: "job", snapshot: running, failures: $0)
        }
        XCTAssertEqual(delays, [30, 60, 120, 240, 300, 300])
        XCTAssertEqual(RelayWatchRefreshPolicy.interval(isActive: true, isComposing: false,
            watchedJobID: "job", snapshot: running, failures: 0), 15)
    }

    func testFetchTimeAloneDoesNotCauseAnotherBackgroundSnapshotTransfer() {
        let original = snapshot()
        var refreshed = RelayWatchSnapshot(sourceID: original.sourceID,
            updatedAt: original.updatedAt.addingTimeInterval(120), models: original.models,
            folders: original.folders, threads: original.threads, approvals: original.approvals)
        XCTAssertTrue(refreshed.hasSameContent(as: original))
        refreshed.threads[0].excerpt = "Ready for your review."
        XCTAssertFalse(refreshed.hasSameContent(as: original))
        let anotherMachine = RelayWatchSnapshot(sourceID: "machine-b", updatedAt: original.updatedAt,
            models: original.models, folders: original.folders, threads: original.threads, approvals: original.approvals)
        XCTAssertFalse(anotherMachine.hasSameContent(as: original))
    }

    private func snapshot(active: Bool = false, requiresPhone: Bool = false) -> RelayWatchSnapshot {
        RelayWatchSnapshot(
            sourceID: "machine-a", updatedAt: Date(),
            models: [RelayWatchModel(id: "codex-model", label: "Codex", provider: "codex", efforts: ["low", "high"])],
            folders: [RelayWatchFolder(id: "registered-folder", name: "Relay")],
            threads: [RelayWatchThread(id: "row", sessionID: "session", jobID: "job", workspaceID: "registered-folder", provider: "codex", title: "Fix tests", status: "Ready", isActive: active, excerpt: "Which test?")],
            approvals: [RelayWatchApproval(id: "approval", jobID: "job", title: "Run command", detail: "npm test", decisions: ["accept", "decline"], requiresPhone: requiresPhone)]
        )
    }

    private func send() -> RelayWatchCommand {
        var command = RelayWatchCommand(kind: .send, sourceID: "machine-a")
        command.prompt = "Fix the failing test"
        command.workspaceID = "registered-folder"
        command.modelID = "codex-model"
        command.effort = "high"
        return command
    }

    func testRegisteredFolderAndCatalogEffortAreRequired() throws {
        var command = send()
        XCTAssertNoThrow(try command.validate(against: snapshot()))
        command.workspaceID = "/tmp/arbitrary-folder"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.workspaceID = "registered-folder"
        command.effort = "invented-effort"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.effort = nil
        XCTAssertNoThrow(try command.validate(against: snapshot()))
    }

    func testOldMachineAndProtocolCannotRunCommands() {
        var command = send()
        command.sourceID = "machine-b"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.sourceID = "machine-a"
        command.version += 1
        XCTAssertThrowsError(try command.validate(against: snapshot()))
    }

    func testReplyCannotChangeProviderFolderOrOverlapActiveRun() {
        var command = send()
        command.sessionID = "session"
        XCTAssertNoThrow(try command.validate(against: snapshot()))
        XCTAssertThrowsError(try command.validate(against: snapshot(active: true)))
        command.sessionID = "some-other-session"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.sessionID = "session"
        let original = snapshot()
        let anotherProvider = RelayWatchSnapshot(sourceID: original.sourceID, updatedAt: Date(),
            models: [RelayWatchModel(id: "codex-model", label: "Claude", provider: "claude", efforts: ["high"])],
            folders: original.folders, threads: original.threads, approvals: [])
        XCTAssertThrowsError(try command.validate(against: anotherProvider))
    }

    func testApprovalMustStillExistAndBeFullyVisible() {
        var command = RelayWatchCommand(kind: .decide, sourceID: "machine-a")
        command.approvalID = "approval"
        command.jobID = "job"
        command.decision = "accept"
        XCTAssertNoThrow(try command.validate(against: snapshot()))
        XCTAssertThrowsError(try command.validate(against: snapshot(requiresPhone: true)))
        command.jobID = "other-job"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.jobID = "job"
        command.decision = "acceptForSession"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.decision = "decline"
        command.approvalID = "expired-approval"
        XCTAssertThrowsError(try command.validate(against: snapshot()))
    }

    func testCancelOnlyTargetsAnActiveKnownJob() {
        var command = RelayWatchCommand(kind: .cancel, sourceID: "machine-a")
        command.jobID = "job"
        XCTAssertNoThrow(try command.validate(against: snapshot(active: true)))
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.jobID = "missing"
        XCTAssertThrowsError(try command.validate(against: snapshot(active: true)))
    }

    func testVoiceTranscriptCannotSendBlankOrOversizedInput() {
        var command = send()
        command.prompt = " \n "
        XCTAssertThrowsError(try command.validate(against: snapshot()))
        command.prompt = String(repeating: "a", count: 8_001)
        XCTAssertThrowsError(try command.validate(against: snapshot()))
    }

    func testWatchPayloadIsBoundedAndRoundTrips() throws {
        let original = snapshot()
        let decoded = try RelayWatchWire.decode(RelayWatchSnapshot.self, from: RelayWatchWire.encode(original))
        XCTAssertEqual(original, decoded)
        XCTAssertThrowsError(try RelayWatchWire.encode(String(repeating: "a", count: RelayWatchWire.maximumBytes)))
        XCTAssertThrowsError(try RelayWatchWire.decode(RelayWatchSnapshot.self, from: [:]))
    }

    func testExcerptKeepsConcludingQuestionAndDoesNotSendCodeBlocks() {
        let question = "Should I update the tests?"
        let text = "Progress\n" + String(repeating: "Changes made. ", count: 100) + "\n" + question
        let excerpt = RelayWatchText.excerpt(text)
        XCTAssertLessThanOrEqual(excerpt.count, 700)
        XCTAssertTrue(excerpt.hasSuffix(question))
        XCTAssertEqual(RelayWatchText.excerpt("Done\n```swift\nlet secret = 1\n```"), "Done\n[Code on iPhone]")
    }

    func testProjectionUsesCatalogAndNeverCopiesRawJobLogs() throws {
        let models = try CodexClient.makeDecoder().decode([CodexModelDescriptor].self, from: Data("""
        [
          {"id":"task","label":"Available model","provider":"codex","modes":["task"],"effortLevels":["low","high"]},
          {"id":"chat","provider":"codex","modes":["chat"]},
          {"id":"aws","provider":"bedrock","modes":["task"]}
        ]
        """.utf8))
        let job = try CodexClient.makeDecoder().decode(CodexJob.self, from: Data("""
        {"id":"job","provider":"codex","workspaceId":"registered-folder","status":"running",
         "prompt":"Fix tests","stdout":"RAW-LOG-MUST-NOT-TRANSFER","stderr":"RAW-ERROR-MUST-NOT-TRANSFER"}
        """.utf8))
        let projected = RelayWatchProjection.snapshot(sourceID: "machine-a", models: models,
            folders: [CodexWorkspace(id: "registered-folder", name: "Relay")], threads: [], jobs: [job], approvals: [])
        XCTAssertEqual(projected.models.map(\.id), ["task"])
        XCTAssertEqual(projected.models.first?.efforts, ["low", "high"])
        XCTAssertEqual(projected.threads.count, 1)
        let encoded = String(decoding: try JSONEncoder().encode(projected), as: UTF8.self)
        XCTAssertFalse(encoded.contains("RAW-LOG"))
        XCTAssertFalse(encoded.contains("RAW-ERROR"))
    }

    func testLargeApprovalIsReadOnlyOnWatch() throws {
        let input: [String: Any] = ["id": "approval", "jobId": "job", "provider": "codex", "kind": "command",
            "title": "Run command", "command": String(repeating: "x", count: 1_401), "status": "pending", "availableDecisions": ["accept", "decline"]]
        let approval = try CodexClient.makeDecoder().decode(CodexApproval.self, from: JSONSerialization.data(withJSONObject: input))
        let projected = RelayWatchProjection.approval(approval)
        XCTAssertTrue(projected.requiresPhone)
        XCTAssertLessThanOrEqual(projected.detail.count, 700)
    }

    func testProgressProjectsAgentProseAndCountsWithoutToolOutput() throws {
        var timeline = RelayTimeline()
        let lines = [
            #"{"type":"step","id":"step","kind":"command","title":"Run tests","status":"failed","output":"PRIVATE TOOL OUTPUT"}"#,
            #"{"type":"text","id":"reply","delta":"One test failed. Investigating."}"#
        ]
        for (index, line) in lines.enumerated() {
            timeline.apply(try JSONDecoder().decode(RelayTimelineEvent.self, from: Data(line.utf8)), seq: index + 1)
        }
        var row = snapshot(active: true).threads[0]
        RelayWatchProjection.update(&row, from: timeline)
        XCTAssertEqual(row.excerpt, "One test failed. Investigating.")
        XCTAssertTrue(row.progress?.contains("1 failed") == true)
        XCTAssertFalse(String(decoding: try JSONEncoder().encode(row), as: UTF8.self).contains("PRIVATE TOOL OUTPUT"))
    }
}
