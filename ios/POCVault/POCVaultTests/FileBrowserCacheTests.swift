import XCTest
@testable import POCVault

/// The Folders tab must feel instant: a folder that was open before draws its last
/// contents on the first frame, background refreshes never swap content for a
/// spinner, and independent requests run side by side.
final class FileBrowserCacheTests: XCTestCase {
    private let machine = URL(string: "https://node.example.test:8890")!
    private let folder = "/srv/ws/app"

    // MARK: - Cache

    @MainActor
    func testSnapshotCacheEvictsLeastRecentlyUsedFolder() {
        let cache = FileBrowserSnapshotCache(capacity: 2)
        let a = FileBrowserSnapshotCache.Key(machine: machine, path: "/srv/ws/a")
        let b = FileBrowserSnapshotCache.Key(machine: machine, path: "/srv/ws/b")
        let c = FileBrowserSnapshotCache.Key(machine: machine, path: "/srv/ws/c")

        cache.update(a) { $0.hasLoadedConversations = true }
        cache.update(b) { $0.hasLoadedConversations = true }
        XCTAssertNotNil(cache.snapshot(for: a), "reading a folder marks it recently used")
        cache.update(c) { $0.hasLoadedConversations = true }

        XCTAssertEqual(cache.count, 2)
        XCTAssertNotNil(cache.snapshot(for: a))
        XCTAssertNil(cache.snapshot(for: b), "the least recently used folder is evicted")
        XCTAssertNotNil(cache.snapshot(for: c))
        XCTAssertEqual(FileBrowserSnapshotCache.defaultCapacity, 50)

        cache.removeAll()
        XCTAssertEqual(cache.count, 0)
    }

    @MainActor
    func testSnapshotCacheKeysByMachineAndNormalizedPath() {
        let other = URL(string: "https://other.example.test:8890")!
        XCTAssertEqual(
            FileBrowserSnapshotCache.Key(machine: machine, path: "/srv/ws/app/"),
            FileBrowserSnapshotCache.Key(machine: machine, path: " /srv/ws/app ")
        )
        XCTAssertEqual(
            FileBrowserSnapshotCache.Key(machine: machine, path: nil),
            FileBrowserSnapshotCache.Key(machine: machine, path: "  ")
        )
        XCTAssertNotEqual(
            FileBrowserSnapshotCache.Key(machine: machine, path: folder),
            FileBrowserSnapshotCache.Key(machine: other, path: folder),
            "a path on one machine says nothing about another"
        )
    }

    // MARK: - Seeding

    @MainActor
    func testPushedFolderSeedsSynchronouslyFromCacheWithoutASpinner() throws {
        let cache = FileBrowserSnapshotCache(capacity: 8)
        let listing = try makeListing()
        let thread = try makeThread(id: "t1", workspaceID: "dir-app")
        let gitStatus = try makeGitStatus()
        cache.update(FileBrowserSnapshotCache.Key(machine: machine, path: folder)) {
            $0.listing = listing
            $0.entries = listing.entries
            $0.gitStatus = gitStatus
            $0.workspace = CodexWorkspace(id: "dir-app", name: "app", path: self.folder)
            $0.conversations = [CodexThreadFeedItem(source: .thread(thread))]
            $0.hasLoadedConversations = true
        }
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: listing)

        let model = FileBrowserViewModel(client: source, path: folder, cache: cache)

        // Everything is there on the first frame, before any request.
        XCTAssertTrue(source.calls.isEmpty)
        XCTAssertEqual(model.entries.map(\.displayName), ["src", "README.md"])
        XCTAssertEqual(model.gitStatus?.branchLabel, "main")
        XCTAssertEqual(model.workspace?.id, "dir-app")
        XCTAssertEqual(model.conversationCount, 1)
        XCTAssertFalse(model.showsListingSpinner)
        XCTAssertFalse(model.showsConversationSpinner)
    }

    @MainActor
    func testColdFolderShowsSpinnerOnlyUntilItsFirstLoadThenReopensWarm() async throws {
        let cache = FileBrowserSnapshotCache(capacity: 8)
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: try makeListing())

        let cold = FileBrowserViewModel(client: source, path: folder, cache: cache)
        XCTAssertTrue(cold.showsListingSpinner, "a never-listed folder has nothing else to show")
        XCTAssertTrue(cold.showsConversationSpinner)
        XCTAssertNil(cold.conversationCount)

        await cold.loadIfNeeded()
        XCTAssertFalse(cold.showsListingSpinner)
        XCTAssertEqual(cold.entries.count, 2)
        XCTAssertEqual(cold.workspace?.id, "dir-app")

        let snapshot = try XCTUnwrap(cache.snapshot(for: FileBrowserSnapshotCache.Key(machine: machine, path: folder)))
        XCTAssertEqual(snapshot.entries.count, 2)
        XCTAssertEqual(snapshot.workspace?.id, "dir-app")

        let warm = FileBrowserViewModel(client: source, path: folder, cache: cache)
        XCTAssertFalse(warm.showsListingSpinner)
        XCTAssertEqual(warm.entries.count, 2)
        XCTAssertEqual(warm.workspace?.id, "dir-app")
    }

    @MainActor
    func testWorkspaceSelectRunsAlongsideTheListing() async throws {
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: try makeListing())
        source.listingWaitsForSelect = true
        let model = FileBrowserViewModel(client: source, path: folder, cache: FileBrowserSnapshotCache(capacity: 8))

        await model.load()

        XCTAssertTrue(
            source.sawSelectWhileListing,
            "workspaces/select must not wait for fs/list: the folder path is known up front"
        )
        XCTAssertEqual(model.workspace?.id, "dir-app")
        XCTAssertEqual(source.count(of: "select"), 1)
    }

    // MARK: - Background refreshes keep content

    @MainActor
    func testChatsRefreshKeepsTheListAndItsCountWhileInFlight() async throws {
        let cache = FileBrowserSnapshotCache(capacity: 8)
        let listing = try makeListing()
        let first = try makeThread(id: "t1", workspaceID: "dir-app")
        cache.update(FileBrowserSnapshotCache.Key(machine: machine, path: folder)) {
            $0.listing = listing
            $0.entries = listing.entries
            $0.workspace = CodexWorkspace(id: "dir-app", name: "app", path: self.folder)
            $0.conversations = [CodexThreadFeedItem(source: .thread(first))]
            $0.hasLoadedConversations = true
        }
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: listing)
        source.threadsByWorkspace["dir-app"] = [first, try makeThread(id: "t2", workspaceID: "dir-app")]
        source.holdsThreads = true
        let model = FileBrowserViewModel(client: source, path: folder, cache: cache)

        let refresh = Task { await model.refreshConversations() }
        try await waitUntil { source.count(of: "threads") == 1 }

        XCTAssertTrue(model.isLoadingConversations)
        XCTAssertFalse(model.showsConversationSpinner, "a poll never replaces loaded chats with a spinner")
        XCTAssertEqual(model.conversationCount, 1, "the count stays visible during a poll")

        // A second caller joins the in-flight refresh rather than stacking another.
        let joined = Task { await model.refreshConversations() }
        source.holdsThreads = false
        await refresh.value
        await joined.value

        XCTAssertEqual(source.count(of: "threads"), 1)
        XCTAssertEqual(model.conversationCount, 2)
        XCTAssertEqual(
            cache.snapshot(for: FileBrowserSnapshotCache.Key(machine: machine, path: folder))?.conversations.count,
            2
        )
    }

    @MainActor
    func testFailedReloadKeepsTheLastListingOnScreen() async throws {
        let cache = FileBrowserSnapshotCache(capacity: 8)
        let listing = try makeListing()
        cache.update(FileBrowserSnapshotCache.Key(machine: machine, path: folder)) {
            $0.listing = listing
            $0.entries = listing.entries
        }
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: listing)
        source.listingError = URLError(.timedOut)
        let model = FileBrowserViewModel(client: source, path: folder, cache: cache)

        await model.refresh()

        XCTAssertEqual(model.entries.count, 2)
        XCTAssertFalse(model.showsListingSpinner)
        XCTAssertNotNil(model.errorMessage)
    }

    @MainActor
    func testRejectedCachedWorkspaceIsConfirmedAndRetriedOnce() async throws {
        let cache = FileBrowserSnapshotCache(capacity: 8)
        let listing = try makeListing()
        cache.update(FileBrowserSnapshotCache.Key(machine: machine, path: folder)) {
            $0.listing = listing
            $0.entries = listing.entries
            $0.workspace = CodexWorkspace(id: "dir-stale", name: "app", path: self.folder)
        }
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: listing)
        source.rejectedWorkspaceIDs = ["dir-stale"]
        source.threadsByWorkspace["dir-app"] = [try makeThread(id: "t1", workspaceID: "dir-app")]
        let model = FileBrowserViewModel(client: source, path: folder, cache: cache)

        await model.refreshConversations()

        XCTAssertNil(model.conversationError)
        XCTAssertEqual(model.workspace?.id, "dir-app")
        XCTAssertEqual(model.conversationCount, 1)
        XCTAssertEqual(source.count(of: "select"), 1)
        XCTAssertEqual(
            cache.snapshot(for: FileBrowserSnapshotCache.Key(machine: machine, path: folder))?.workspace?.id,
            "dir-app"
        )
    }

    // MARK: - Polling

    @MainActor
    func testOverlappingPollIsSkippedWhileOneIsInFlight() async throws {
        let cache = FileBrowserSnapshotCache(capacity: 8)
        let listing = try makeListing()
        cache.update(FileBrowserSnapshotCache.Key(machine: machine, path: folder)) {
            $0.listing = listing
            $0.entries = listing.entries
        }
        let source = ScriptedFileBrowserSource(baseURL: machine, listing: listing)
        source.gitStatus = try makeGitStatus()
        source.holdsGit = true
        let model = FileBrowserViewModel(client: source, path: folder, cache: cache)

        let first = Task { await model.pollOnce() }
        try await waitUntil { source.count(of: "git") == 1 && source.count(of: "list") == 1 }
        await model.pollOnce()
        XCTAssertEqual(source.count(of: "git"), 1, "a slow machine never gets stacked polls")
        XCTAssertEqual(source.count(of: "list"), 1)

        source.holdsGit = false
        await first.value
        XCTAssertEqual(model.gitStatus?.branchLabel, "main")
    }

    func testPollCadenceIsGentle() {
        XCTAssertGreaterThanOrEqual(FileBrowserViewModel.pollInterval, .seconds(5))
        XCTAssertLessThanOrEqual(FileBrowserViewModel.pollInterval, .seconds(10))
    }

    func testExplorerSpinnersFollowDataNotBackgroundLoadingFlags() throws {
        let browser = try AppSourceFixture.load("POCVault/Browser/FileBrowserView.swift")
        // The chats list and its count used to flip to "Loading chats…" on every poll.
        XCTAssertFalse(browser.contains("viewModel.isLoadingConversations"))
        XCTAssertFalse(browser.contains("viewModel.isResolvingWorkspace"))
        XCTAssertTrue(browser.contains("viewModel.showsConversationSpinner"))
        XCTAssertTrue(browser.contains("viewModel.conversationCount"))
        XCTAssertTrue(browser.contains("viewModel.showsListingSpinner"))

        let model = try AppSourceFixture.load("POCVault/Browser/FileBrowserViewModel.swift")
        XCTAssertTrue(model.contains("FileBrowserSnapshotCache"))
        XCTAssertFalse(model.contains(".seconds(2)"), "the explorer no longer refetches everything every 2 s")
    }

    // MARK: - Fixtures

    private func makeListing() throws -> CodexWorkspaceDirectoryListing {
        try CodexClient.makeDecoder().decode(
            CodexWorkspaceDirectoryListing.self,
            from: Data("""
            {
              "rootPath": "/srv/ws",
              "currentPath": "/srv/ws/app",
              "relativePath": "app",
              "entries": [
                { "name": "src", "kind": "dir", "path": "/srv/ws/app/src" },
                { "name": "README.md", "kind": "file", "path": "/srv/ws/app/README.md" }
              ],
              "truncated": false,
              "total": 2
            }
            """.utf8)
        )
    }

    private func makeGitStatus() throws -> RelayGitStatus {
        try CodexClient.makeDecoder().decode(
            RelayGitStatus.self,
            from: Data(#"{"git":true,"branch":"main","added":3,"deleted":1}"#.utf8)
        )
    }

    private func makeThread(id: String, workspaceID: String) throws -> CodexThread {
        try JSONDecoder().decode(
            CodexThread.self,
            from: Data("""
            { "id": "\(id)", "sessionId": "\(id)", "workspaceId": "\(workspaceID)", "lastPrompt": "fix the build" }
            """.utf8)
        )
    }

    @MainActor
    private func waitUntil(
        timeout: TimeInterval = 5,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("Timed out waiting for condition", file: file, line: line)
                return
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }
}

/// A machine that answers from fixtures, records every request, and can hold a
/// request open so a test can look at the screen while it is in flight.
private final class ScriptedFileBrowserSource: FileBrowserDataSource, @unchecked Sendable {
    let baseURL: URL
    private let lock = NSLock()
    private var state: State

    private struct State {
        var calls: [String] = []
        var listing: CodexWorkspaceDirectoryListing
        var listingError: Error?
        var listingWaitsForSelect = false
        var sawSelectWhileListing = false
        var gitStatus: RelayGitStatus?
        var holdsGit = false
        var holdsThreads = false
        var selected = CodexWorkspace(id: "dir-app", name: "app", path: "/srv/ws/app")
        var threadsByWorkspace: [String: [CodexThread]] = [:]
        var rejectedWorkspaceIDs: Set<String> = []
    }

    init(baseURL: URL, listing: CodexWorkspaceDirectoryListing) {
        self.baseURL = baseURL
        self.state = State(listing: listing)
    }

    private func locked<T>(_ body: (inout State) -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body(&state)
    }

    var calls: [String] { locked { $0.calls } }
    func count(of call: String) -> Int { locked { $0.calls.filter { $0 == call }.count } }
    var sawSelectWhileListing: Bool { locked { $0.sawSelectWhileListing } }

    var listingError: Error? {
        get { locked { $0.listingError } }
        set { locked { $0.listingError = newValue } }
    }
    var listingWaitsForSelect: Bool {
        get { locked { $0.listingWaitsForSelect } }
        set { locked { $0.listingWaitsForSelect = newValue } }
    }
    var gitStatus: RelayGitStatus? {
        get { locked { $0.gitStatus } }
        set { locked { $0.gitStatus = newValue } }
    }
    var holdsGit: Bool {
        get { locked { $0.holdsGit } }
        set { locked { $0.holdsGit = newValue } }
    }
    var holdsThreads: Bool {
        get { locked { $0.holdsThreads } }
        set { locked { $0.holdsThreads = newValue } }
    }
    var threadsByWorkspace: [String: [CodexThread]] {
        get { locked { $0.threadsByWorkspace } }
        set { locked { $0.threadsByWorkspace = newValue } }
    }
    var rejectedWorkspaceIDs: Set<String> {
        get { locked { $0.rejectedWorkspaceIDs } }
        set { locked { $0.rejectedWorkspaceIDs = newValue } }
    }

    private func hold(while held: () -> Bool) async {
        let deadline = Date().addingTimeInterval(5)
        while held(), Date() < deadline {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    func folderListing(path: String?, offset: Int, limit: Int) async throws -> CodexWorkspaceDirectoryListing {
        locked { $0.calls.append("list") }
        if listingWaitsForSelect {
            await hold { self.count(of: "select") == 0 }
            locked { $0.sawSelectWhileListing = $0.calls.contains("select") }
        }
        if let error = listingError { throw error }
        return locked { $0.listing }
    }

    func folderGitStatus(path: String?) async throws -> RelayGitStatus {
        locked { $0.calls.append("git") }
        await hold { self.holdsGit }
        guard let status = gitStatus else { throw CodexClientError.httpFailure(404, "not found") }
        return status
    }

    func selectFolderWorkspace(path: String) async throws -> CodexWorkspace {
        locked {
            $0.calls.append("select")
            return $0.selected
        }
    }

    func createFolderWorkspace(parentPath: String, name: String) async throws -> CodexWorkspace {
        locked { $0.calls.append("create") }
        return CodexWorkspace(id: "dir-\(name)", name: name, path: "\(parentPath)/\(name)")
    }

    func folderThreads(workspaceID: String, limit: Int) async throws -> [CodexThread] {
        locked { $0.calls.append("threads") }
        await hold { self.holdsThreads }
        if rejectedWorkspaceIDs.contains(workspaceID) {
            throw CodexClientError.httpFailure(400, "workspaceId is not registered")
        }
        return threadsByWorkspace[workspaceID] ?? []
    }

    func folderJobs(workspaceID: String, limit: Int) async throws -> [CodexJob] {
        locked { $0.calls.append("jobs") }
        if rejectedWorkspaceIDs.contains(workspaceID) {
            throw CodexClientError.httpFailure(400, "workspaceId is not registered")
        }
        return []
    }
}
