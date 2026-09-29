import XCTest
@testable import POCVault

/// The Chats list: snapshot persistence, launch seeding, merge-as-arrives
/// refresh, request coalescing and the silent-machine deadline.
@MainActor
final class ChatsFeedTests: XCTestCase {
    private let machineA = URL(string: "https://10.0.0.5:8890")!
    private let machineB = URL(string: "https://10.0.0.6:8890")!
    private let savedAt = Date(timeIntervalSince1970: 1_790_000_000)

    // MARK: - Snapshot persistence

    func testSnapshotRoundTripKeepsRowsAndDropsOperationalFields() throws {
        let store = makeStore()
        let threads = [
            try makeThread("s1", updatedAt: "2026-09-28T10:00:00Z", prompt: "Fix the flaky build"),
            try makeThread("s2", updatedAt: "2026-09-28T11:00:00Z", prompt: "Ship the list", live: true),
        ]
        let job = try makeJob("j1", status: "running", prompt: "Draft the release notes", extra: [
            "stdout": "secret build log",
            "stderr": "warning: noisy",
            "certSubject": "CN=iphone",
            "attachments": [["id": "a1", "filename": "shot.png", "kind": "image"]],
        ])

        let snapshot = RelayChatsFeedSnapshot(threads: threads, jobs: [job])
        store.save(snapshot, savedAt: savedAt, for: machineA)
        store.waitForPendingWrites()
        let restored = try XCTUnwrap(store.load(for: machineA))

        XCTAssertEqual(restored.savedAt, savedAt)
        XCTAssertEqual(Set(restored.threads), Set(threads), "every thread field a row needs survives exactly")
        XCTAssertEqual(
            CodexThreadFeedItem.makeFeed(threads: restored.threads, jobs: restored.jobs).map(\.id),
            CodexThreadFeedItem.makeFeed(threads: threads, jobs: [job]).map(\.id)
        )
        XCTAssertEqual(
            CodexThreadFeedItem.makeFeed(threads: restored.threads, jobs: restored.jobs).map(\.title),
            CodexThreadFeedItem.makeFeed(threads: threads, jobs: [job]).map(\.title)
        )

        let restoredJob = try XCTUnwrap(restored.jobs.first)
        XCTAssertEqual(restoredJob.id, "j1")
        XCTAssertEqual(restoredJob.status, .running)
        XCTAssertEqual(restoredJob.prompt, "Draft the release notes")
        XCTAssertEqual(restoredJob.workspaceId, "scratch")
        XCTAssertNil(restoredJob.stdout)
        XCTAssertNil(restoredJob.stderr)
        XCTAssertNil(restoredJob.certSubject)
        XCTAssertTrue(restoredJob.attachments.isEmpty)

        let fileURL = try XCTUnwrap(store.fileURL(for: machineA))
        let written = try XCTUnwrap(String(data: Data(contentsOf: fileURL), encoding: .utf8))
        for forbidden in ["secret build log", "CN=iphone", "stdout", "stderr", "certSubject", "attachments", "token"] {
            XCTAssertFalse(written.contains(forbidden), "snapshot must not carry \(forbidden)")
        }
        XCTAssertFalse(fileURL.lastPathComponent.contains("10.0.0.5"), "the file name is a hash, not the host")
    }

    func testSnapshotKeepsOnlyTheNewestFeedRowsAndBoundsText() throws {
        let threads = try (0..<230).map { index in
            try makeThread("s\(index)", updatedAt: 1_790_000_000 + Double(index) * 60, prompt: "Chat \(index)")
        }
        let snapshot = RelayChatsFeedSnapshot(threads: threads, jobs: [])
        XCTAssertEqual(snapshot.threadRows.count, RelayChatsFeedSnapshot.itemLimit)
        let expected = CodexThreadFeedItem.makeFeed(threads: threads, jobs: [])
            .prefix(RelayChatsFeedSnapshot.itemLimit)
            .map(\.id)
        XCTAssertEqual(snapshot.threadRows.map { "thread-\($0.sessionId)" }, expected)
        XCTAssertFalse(snapshot.threadRows.contains { $0.sessionId == "s0" }, "the oldest rows are the ones dropped")

        let longPrompt = String(repeating: "word ", count: 1_000)
        let long = try makeThread("long", updatedAt: "2026-09-28T10:00:00Z", prompt: longPrompt)
        let bounded = RelayChatsFeedSnapshot(threads: [long], jobs: [])
        let row = try XCTUnwrap(bounded.threadRows.first)
        XCTAssertEqual(row.lastPrompt?.count, RelayChatsFeedSnapshot.textLimit)
        XCTAssertEqual(RelayChatsFeedSnapshot.bounded(row.lastPrompt), row.lastPrompt, "bounding is idempotent")

        // A restored snapshot projects back to the same rows, so seeding never
        // causes a rewrite on its own.
        let store = makeStore()
        store.save(bounded, savedAt: savedAt, for: machineA)
        store.waitForPendingWrites()
        let restored = try XCTUnwrap(store.load(for: machineA))
        XCTAssertEqual(RelayChatsFeedSnapshot(threads: restored.threads, jobs: restored.jobs), bounded)
    }

    func testSnapshotStoreIsPerMachineProtectedAndForgettable() throws {
        let store = makeStore()
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("a1")], jobs: []), savedAt: savedAt, for: machineA)
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("b1")], jobs: []), savedAt: savedAt, for: machineB)
        store.waitForPendingWrites()

        XCTAssertEqual(store.load(for: machineA)?.threads.map(\.sessionId), ["a1"])
        XCTAssertEqual(store.load(for: machineB)?.threads.map(\.sessionId), ["b1"])
        XCTAssertEqual(
            store.load(for: URL(string: "https://10.0.0.5:8890/")!)?.threads.map(\.sessionId),
            ["a1"],
            "a trailing slash is the same machine"
        )

        let fileURL = try XCTUnwrap(store.fileURL(for: machineA))
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        if let protection = attributes[.protectionKey] as? FileProtectionType {
            XCTAssertEqual(protection, .completeUntilFirstUserAuthentication)
        }
        let directory = fileURL.deletingLastPathComponent()
        XCTAssertEqual(try directory.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)

        store.remove(for: machineA)
        store.waitForPendingWrites()
        XCTAssertNil(store.load(for: machineA))
        XCTAssertEqual(store.load(for: machineB)?.threads.map(\.sessionId), ["b1"], "forgetting one machine keeps the others")
    }

    func testUnreadableOrForeignSnapshotIsDiscarded() throws {
        let store = makeStore()
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("a1")], jobs: []), savedAt: savedAt, for: machineA)
        store.waitForPendingWrites()
        let fileURL = try XCTUnwrap(store.fileURL(for: machineA))

        try Data("not json".utf8).write(to: fileURL)
        XCTAssertNil(store.load(for: machineA))
        XCTAssertFalse(FileManager.default.fileExists(atPath: fileURL.path), "a corrupt snapshot is removed")

        try Data(#"{"version":99,"savedAt":1790000000,"threads":[],"jobs":[]}"#.utf8).write(to: fileURL)
        XCTAssertNil(store.load(for: machineA), "another format version is not guessed at")
    }

    // MARK: - Pure merge state

    func testStateMergesEachSourceAsItArrives() throws {
        var state = RelayChatsFeedState()
        XCTAssertTrue(state.isAwaitingFirstList)

        let landed = Date(timeIntervalSince1970: 1_790_000_100)
        state.land(threads: [try makeThread("s1")], at: landed)
        XCTAssertEqual(state.feedItems.map(\.id), ["thread-s1"], "threads render without waiting for jobs")
        XCTAssertFalse(state.isAwaitingFirstList)
        XCTAssertFalse(state.listHasSettled, "jobs have not answered yet")

        state.fail(.jobs, message: "offline")
        XCTAssertEqual(state.feedItems.map(\.id), ["thread-s1"], "a failing source never blanks another")
        XCTAssertTrue(state.listIsStale)
        XCTAssertNil(state.blockingFailureMessage, "rows on screen are kept instead of an error")

        state.land(jobs: [try makeJob("j1", status: "running")], at: landed.addingTimeInterval(1))
        XCTAssertEqual(Set(state.feedItems.map(\.id)), ["thread-s1", "job-j1"])
        XCTAssertFalse(state.listIsStale)

        state.fail(.approvals, message: "approvals down")
        XCTAssertFalse(state.listIsStale, "an approvals failure does not mark the list stale")
        XCTAssertEqual(state.feedItems.count, 2)

        XCTAssertNotNil(state.activity(maxAge: 5, now: landed.addingTimeInterval(3)))
        XCTAssertNil(state.activity(maxAge: 5, now: landed.addingTimeInterval(60)))
    }

    func testSeededRowsNeverFeedTheCompletionMonitor() throws {
        let seed = RelayChatsFeedSnapshot.Restored(threads: [try makeThread("s1", live: true)], jobs: [], savedAt: savedAt)
        let state = RelayChatsFeedState(seed: seed)
        XCTAssertEqual(state.feedItems.map(\.id), ["thread-s1"])
        XCTAssertFalse(state.isAwaitingFirstList)
        XCTAssertEqual(state.listAsOf, savedAt)
        XCTAssertNil(state.activity(maxAge: .infinity, now: savedAt), "disk rows would read as completions")
    }

    func testFailureWithNothingOnScreenIsTheOnlyBlockingError() {
        var state = RelayChatsFeedState()
        state.fail(.threads, message: "The request timed out.")
        XCTAssertNil(state.blockingFailureMessage, "jobs may still bring rows")
        XCTAssertTrue(state.isAwaitingFirstList)
        state.land(jobs: [], at: savedAt)
        XCTAssertEqual(state.blockingFailureMessage, "The request timed out.")
        XCTAssertFalse(state.isAwaitingFirstList)
        XCTAssertFalse(state.listIsStale, "stale means rows are on screen")
    }

    func testDecidedApprovalDoesNotReturnFromAnOlderList() throws {
        var state = RelayChatsFeedState()
        let first = try makeApproval("ap1")
        let second = try makeApproval("ap2")
        state.land(approvals: [first, second], at: savedAt)
        state.markDecided(approvalID: "ap1")
        XCTAssertEqual(state.approvals.map(\.id), ["ap2"])
        state.land(approvals: [first, second], at: savedAt)
        XCTAssertEqual(state.approvals.map(\.id), ["ap2"], "a list fetched before the decision must not revive it")
        state.land(approvals: [second], at: savedAt)
        XCTAssertTrue(state.decidedApprovalIDs.isEmpty)
    }

    // MARK: - View model

    func testLaunchPaintsFromSnapshotBeforeAnyRequest() throws {
        let store = makeStore()
        let threads = [try makeThread("s1"), try makeThread("s2", updatedAt: "2026-09-28T12:00:00Z")]
        store.save(RelayChatsFeedSnapshot(threads: threads, jobs: []), savedAt: savedAt, for: machineA)
        store.waitForPendingWrites()
        let source = FakeChatsFeedSource()

        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: store, deadline: nil)

        XCTAssertEqual(model.feedItems.map(\.id), ["thread-s2", "thread-s1"])
        XCTAssertFalse(model.isAwaitingFirstList, "cached rows mean no spinner")
        XCTAssertFalse(model.isListStale, "revalidation is quiet until it fails")
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(source.calls(.threads), 0, "seeding is synchronous and makes no request")
    }

    func testFirstLaunchWithoutSnapshotAwaitsFirstList() async throws {
        let source = FakeChatsFeedSource()
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: makeStore(), deadline: nil)
        XCTAssertTrue(model.isAwaitingFirstList)

        await model.refresh()
        XCTAssertFalse(model.isAwaitingFirstList)
        XCTAssertNil(model.errorMessage)
        XCTAssertTrue(model.feedItems.isEmpty)
    }

    func testThreadsRenderBeforeSlowJobsAndApprovalsLand() async throws {
        let jobsGate = Gate()
        let approvalsGate = Gate()
        let source = FakeChatsFeedSource()
        let thread = try makeThread("s1")
        let job = try makeJob("j1", status: "running")
        source.threads = { [thread] }
        source.jobs = { await jobsGate.wait(); return [job] }
        source.approvals = { await approvalsGate.wait(); throw URLError(.timedOut) }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: makeStore(), deadline: nil)

        let refresh = Task { await model.refresh() }
        try await waitUntil("threads land") { !model.feedItems.isEmpty }
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-s1"])
        XCTAssertTrue(model.jobs.isEmpty, "jobs are still in flight")
        XCTAssertFalse(model.isAwaitingFirstList)

        await jobsGate.open()
        try await waitUntil("jobs merge in") { !model.jobs.isEmpty }
        XCTAssertEqual(Set(model.feedItems.map(\.id)), ["thread-s1", "job-j1"])

        await approvalsGate.open()
        await refresh.value
        XCTAssertEqual(Set(model.feedItems.map(\.id)), ["thread-s1", "job-j1"], "a failed approvals call blanks nothing")
        XCTAssertFalse(model.isListStale)
        XCTAssertNil(model.errorMessage)
    }

    func testFailedRefreshKeepsRowsAndSaysNotUpdated() async throws {
        let store = makeStore()
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("s1")], jobs: []), savedAt: savedAt, for: machineA)
        store.waitForPendingWrites()
        let source = FakeChatsFeedSource()
        source.threads = { throw URLError(.timedOut) }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: store, deadline: nil)

        await model.refresh()
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-s1"], "a refresh never replaces rows")
        XCTAssertTrue(model.isListStale)
        XCTAssertEqual(model.staleListAsOf, savedAt, "the rows are as old as the snapshot")
        XCTAssertNil(model.errorMessage, "rows on screen get the quiet status, not the error")

        let fresh = try makeThread("s2", updatedAt: "2026-09-28T12:00:00Z")
        source.threads = { [fresh] }
        await model.refresh()
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-s2"])
        XCTAssertFalse(model.isListStale)
        XCTAssertNil(model.staleListAsOf)
    }

    func testFailureWithNothingCachedShowsTheError() async {
        let source = FakeChatsFeedSource()
        source.threads = { throw URLError(.cannotConnectToHost) }
        source.jobs = { throw URLError(.cannotConnectToHost) }
        source.approvals = { throw URLError(.cannotConnectToHost) }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: makeStore(), deadline: nil)

        await model.refresh()
        XCTAssertFalse(model.isAwaitingFirstList)
        XCTAssertEqual(model.errorMessage, URLError(.cannotConnectToHost).localizedDescription)
        XCTAssertFalse(model.isListStale)
    }

    func testConcurrentCallersShareOneRequest() async throws {
        let gate = Gate()
        let source = FakeChatsFeedSource()
        let thread = try makeThread("s1")
        source.threads = { await gate.wait(); return [thread] }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: makeStore(), deadline: nil)

        let pull = Task { await model.refresh() }
        let poll = Task { await model.refresh(ifOlderThan: StatusFeedViewModel.pollInterval) }
        let monitor = Task { await model.activitySnapshot(maxAge: RelayChatSessionStore.activityFeedMaxAge) }
        try await waitUntil("the request starts") { source.calls(.threads) == 1 }
        try await Task.sleep(nanoseconds: 50_000_000)
        await gate.open()
        await pull.value
        await poll.value
        let activity = await monitor.value

        XCTAssertEqual(source.calls(.threads), 1, "Chats, a pull and the monitor share one /threads request")
        XCTAssertEqual(source.calls(.jobs), 1)
        XCTAssertEqual(source.calls(.approvals), 1)
        XCTAssertEqual(activity?.threads.map(\.sessionId), ["s1"])

        await model.refresh(ifOlderThan: 60)
        _ = await model.activitySnapshot(maxAge: 60)
        XCTAssertEqual(source.calls(.threads), 1, "a fresh answer is reused, not refetched")
        XCTAssertEqual(source.budgets.first, CodexRequestBudget.listPoll)
        XCTAssertEqual(source.budgets.first?.allowsMachineWake, false, "a list poll never wakes a machine")
    }

    func testSilentMachineIsBoundedByTheDeadline() async throws {
        let store = makeStore()
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("s1")], jobs: []), savedAt: savedAt, for: machineA)
        store.waitForPendingWrites()
        let source = FakeChatsFeedSource()
        source.threads = { try await Task.sleep(nanoseconds: 30_000_000_000); return [] }
        source.jobs = { try await Task.sleep(nanoseconds: 30_000_000_000); return [] }
        source.approvals = { try await Task.sleep(nanoseconds: 30_000_000_000); return [] }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: store, deadline: 0.2)

        let started = Date()
        await model.refresh()
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "a silent machine costs the deadline, not minutes")
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-s1"])
        XCTAssertTrue(model.isListStale)
        XCTAssertNil(model.errorMessage)
    }

    func testRefreshPersistsOnlyOnceThreadsAnswer() async throws {
        let store = makeStore()
        let source = FakeChatsFeedSource()
        let job = try makeJob("j1", status: "failed")
        source.threads = { throw URLError(.timedOut) }
        source.jobs = { [job] }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: store, deadline: nil)

        await model.refresh()
        store.waitForPendingWrites()
        XCTAssertNil(store.load(for: machineA), "no snapshot is written until threads have answered")

        let thread = try makeThread("s1")
        source.threads = { [thread] }
        await model.refresh()
        store.waitForPendingWrites()
        let restored = try XCTUnwrap(store.load(for: machineA))
        XCTAssertEqual(restored.threads.map(\.sessionId), ["s1"])
        XCTAssertEqual(restored.jobs.map(\.id), ["j1"])
        XCTAssertNil(store.load(for: machineB))
    }

    func testSwitchingMachinesReseedsAndDropsTheOldMachinesAnswer() async throws {
        let store = makeStore()
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("a1")], jobs: []), savedAt: savedAt, for: machineA)
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("b1")], jobs: []), savedAt: savedAt, for: machineB)
        store.waitForPendingWrites()
        let gate = Gate()
        let source = FakeChatsFeedSource()
        let late = try makeThread("a2")
        source.threads = { await gate.wait(); return [late] }
        let model = StatusFeedViewModel(source: source, machineURL: machineA, snapshotStore: store, deadline: nil)
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-a1"])

        let refresh = Task { await model.refresh() }
        try await waitUntil("the request starts") { source.calls(.threads) == 1 }
        model.switchMachine(to: machineB)
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-b1"])

        await gate.open()
        await refresh.value
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-b1"], "machine A's late answer is dropped")
        store.waitForPendingWrites()
        XCTAssertEqual(store.load(for: machineA)?.threads.map(\.sessionId), ["a1"], "and is not persisted either")
    }

    func testForgettingTheCurrentMachineClearsItsRowsAndFile() throws {
        let store = makeStore()
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("a1")], jobs: []), savedAt: savedAt, for: machineA)
        store.save(RelayChatsFeedSnapshot(threads: [try makeThread("b1")], jobs: []), savedAt: savedAt, for: machineB)
        store.waitForPendingWrites()
        let model = StatusFeedViewModel(source: FakeChatsFeedSource(), machineURL: machineA, snapshotStore: store, deadline: nil)

        model.forgetSnapshot(for: machineB)
        XCTAssertEqual(model.feedItems.map(\.id), ["thread-a1"], "forgetting another machine leaves this list alone")

        model.forgetSnapshot(for: machineA)
        store.waitForPendingWrites()
        XCTAssertNil(store.load(for: machineA))
        XCTAssertNil(store.load(for: machineB))
        XCTAssertTrue(model.feedItems.isEmpty)
        XCTAssertTrue(model.isAwaitingFirstList)
    }

    // MARK: - Source contracts

    func testChatsHasOneOwnerForTheAppWideThreadsRequest() throws {
        let root = try AppSourceFixture.load("POCVault/POCVaultApp.swift")
        let store = try AppSourceFixture.load("POCVault/Views/RelayChatSessionStore.swift")
        let feed = try AppSourceFixture.load("POCVault/Views/RelayChatsFeedModel.swift")

        XCTAssertFalse(store.contains("fetchThreads("), "the completion monitor reads through the Chats feed")
        XCTAssertFalse(store.contains("fetchJobs("))
        XCTAssertTrue(store.contains("activityFeed?.activitySnapshot(maxAge:"))
        XCTAssertFalse(root.contains("fetchThreads("))
        XCTAssertFalse(root.contains("onActivitySnapshot"))
        XCTAssertEqual(feed.components(separatedBy: "fetchThreads(").count - 1, 1)

        // Polls only while the list is on screen, at the gentler cadence.
        XCTAssertTrue(root.contains("await statusFeedViewModel.pollWhileVisible()"))
        XCTAssertTrue(root.contains("guard scenePhase == .active, chatLaunch == nil else { return }"))
        XCTAssertFalse(root.contains("Task.sleep(for: .seconds(2))"))
        XCTAssertGreaterThanOrEqual(StatusFeedViewModel.pollInterval, 4)
        XCTAssertLessThanOrEqual(StatusFeedViewModel.pollInterval, 5)

        // Spinner only for a genuinely empty first load; stale is a word.
        XCTAssertTrue(root.contains("if feedViewModel.isAwaitingFirstList"))
        XCTAssertTrue(root.contains("RelayCapsLabel(text: \"Not updated\", color: AppTheme.statusWarn)"))
        XCTAssertTrue(root.contains("statusFeedViewModel.switchMachine(to: newBaseURL)"))
        XCTAssertTrue(root.contains("statusFeedViewModel.forgetSnapshot(for: previousURL)"))
    }

    // MARK: - Helpers

    private func makeStore() -> RelayChatsFeedSnapshotStore {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ChatsFeedTests-\(UUID().uuidString)", isDirectory: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        return RelayChatsFeedSnapshotStore(directory: directory)
    }

    private func waitUntil(
        _ description: String,
        timeout: TimeInterval = 3,
        _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("Timed out waiting: \(description)")
                return
            }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
    }

    private func makeThread(
        _ sessionID: String,
        updatedAt: String = "2026-09-28T10:00:00Z",
        prompt: String = "Fix the build",
        live: Bool = false
    ) throws -> CodexThread {
        try decode(CodexThread.self, [
            "id": sessionID,
            "sessionId": sessionID,
            "provider": "claude",
            "mode": "task",
            "workspaceId": "scratch",
            "workspaceName": "Scratch",
            "cwd": "/srv/codex-workspaces/scratch",
            "timestamp": updatedAt,
            "updatedAt": updatedAt,
            "model": "sonnet",
            "jobCount": 2,
            "live": live,
            "lastJobId": "job-\(sessionID)",
            "lastJobStatus": live ? "running" : "succeeded",
            "lastPrompt": prompt,
            "lastResult": "Done.",
        ])
    }

    private func makeThread(_ sessionID: String, updatedAt: Double, prompt: String) throws -> CodexThread {
        try decode(CodexThread.self, [
            "id": sessionID,
            "sessionId": sessionID,
            "provider": "codex",
            "updatedAt": updatedAt,
            "lastPrompt": prompt,
        ])
    }

    private func makeJob(_ id: String, status: String, prompt: String = "Run it", extra: [String: Any] = [:]) throws -> CodexJob {
        var object: [String: Any] = [
            "id": id,
            "provider": "codex",
            "status": status,
            "prompt": prompt,
            "workspaceId": "scratch",
            "workspaceName": "Scratch",
            "workspacePath": "/srv/codex-workspaces/scratch",
            "createdAt": "2026-09-28T09:00:00Z",
            "updatedAt": "2026-09-28T09:30:00Z",
        ]
        object.merge(extra) { _, new in new }
        return try decode(CodexJob.self, object)
    }

    private func makeApproval(_ id: String) throws -> CodexApproval {
        try decode(CodexApproval.self, [
            "id": id,
            "jobId": "job-1",
            "provider": "codex",
            "kind": "command",
            "title": "Run tests",
            "status": "pending",
            "availableDecisions": ["accept", "decline"],
        ])
    }

    private func decode<T: Decodable>(_ type: T.Type, _ object: [String: Any]) throws -> T {
        let data = try JSONSerialization.data(withJSONObject: object)
        return try CodexClient.makeDecoder().decode(type, from: data)
    }
}

/// A machine whose three list calls the test scripts.
private final class FakeChatsFeedSource: RelayChatsFeedSource, @unchecked Sendable {
    enum Call: Hashable {
        case threads
        case jobs
        case approvals
    }

    var threads: @Sendable () async throws -> [CodexThread] = { [] }
    var jobs: @Sendable () async throws -> [CodexJob] = { [] }
    var approvals: @Sendable () async throws -> [CodexApproval] = { [] }

    private let lock = NSLock()
    private var counts: [Call: Int] = [:]
    private var recordedBudgets: [CodexRequestBudget] = []

    func calls(_ call: Call) -> Int {
        lock.withLock { counts[call, default: 0] }
    }

    var budgets: [CodexRequestBudget] {
        lock.withLock { recordedBudgets }
    }

    private func record(_ call: Call, _ budget: CodexRequestBudget) {
        lock.withLock {
            counts[call, default: 0] += 1
            recordedBudgets.append(budget)
        }
    }

    func fetchChatsThreads(budget: CodexRequestBudget) async throws -> [CodexThread] {
        record(.threads, budget)
        return try await threads()
    }

    func fetchChatsJobs(budget: CodexRequestBudget) async throws -> [CodexJob] {
        record(.jobs, budget)
        return try await jobs()
    }

    func fetchChatsApprovals(budget: CodexRequestBudget) async throws -> [CodexApproval] {
        record(.approvals, budget)
        return try await approvals()
    }

    func decideApproval(id: String, decision: CodexApprovalDecision, message: String?) async throws -> CodexApproval {
        throw URLError(.unsupportedURL)
    }
}

/// Holds a scripted call until the test lets it through.
private actor Gate {
    private var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        waiters.forEach { $0.resume() }
        waiters.removeAll()
    }
}
