import Foundation

/// One folder's worth of browser state. Every pushed browser screen owns exactly one of
/// these via `@StateObject`, so navigating deeper never disturbs the listings behind it.
///
/// Listing comes from the bounded jail listing endpoint (`/v1/codex/fs/list`) with
/// offset/limit paging. The visible page is filtered locally so the explorer responds
/// immediately and files do not disappear from results just because the older
/// workspace-directory search endpoint only knows about directories.
///
/// A new screen seeds itself synchronously from `FileBrowserSnapshotCache`, so a folder
/// that was open before draws its last listing, git status and chats on the first frame
/// and revalidates behind them. Only a folder with nothing to show gets a spinner.
@MainActor
final class FileBrowserViewModel: ObservableObject {
    nonisolated static let pageSize = 200
    /// How often an on-screen folder quietly revalidates its git status and open page.
    nonisolated static let pollInterval: Duration = .seconds(6)
    /// How often the Chats sub-tab revalidates while it is showing.
    nonisolated static let conversationPollInterval: Duration = .seconds(4)

    /// Folder being listed; nil means the workspace jail root.
    let path: String?
    private let client: FileBrowserDataSource
    private let cache: FileBrowserSnapshotCache
    private let cacheKey: FileBrowserSnapshotCache.Key

    @Published private(set) var listing: CodexWorkspaceDirectoryListing?
    /// Accumulated entries across "load more" pages (dirs first, then files, server-ordered).
    @Published private(set) var entries: [CodexWorkspaceDirectoryEntry] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var isCreatingFolder = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var conversations: [CodexThreadFeedItem] = []
    /// True once this folder has produced a chat list, on this screen or an earlier one.
    /// Separates "no chats here" from "chats never loaded here".
    @Published private(set) var hasLoadedConversations = false
    @Published private(set) var isLoadingConversations = false
    @Published private(set) var conversationError: String?

    /// The workspace identity returned by `POST /workspaces/select`. A plain file
    /// listing can describe a dynamic workspace without materializing it in relayd;
    /// jobs, threads, skills and terminals must only receive this confirmed identity.
    @Published private(set) var workspace: CodexWorkspace?

    /// Bound to the explorer's compact filter field.
    @Published var searchText = ""
    @Published private(set) var isResolvingWorkspace = false
    /// Branch and working-tree counts for this folder. Nil outside a repository
    /// and on a daemon that does not serve `/v1/codex/fs/git` yet.
    @Published private(set) var gitStatus: RelayGitStatus?

    /// The Files list is on screen. The poll leaves the listing alone while Chats shows.
    var isListingVisible = true

    /// A seeded workspace id predates this screen; it counts as confirmed only after
    /// this screen's own `workspaces/select` answers.
    private var workspaceIsConfirmed = false
    private var didReconfirmSeededWorkspace = false
    private var workspaceRequest: Task<Result<CodexWorkspace, Error>, Never>?
    private var conversationRequest: Task<Void, Never>?
    private var isPolling = false
    private var gitRouteUnavailable = false

    init(
        client: FileBrowserDataSource,
        path: String? = nil,
        cache: FileBrowserSnapshotCache? = nil
    ) {
        self.client = client
        self.path = path?.trimmedNonEmpty
        let cache = cache ?? .shared
        self.cache = cache
        self.cacheKey = FileBrowserSnapshotCache.Key(machine: client.baseURL, path: path)
        if let snapshot = cache.snapshot(for: cacheKey) {
            listing = snapshot.listing
            entries = snapshot.entries
            gitStatus = snapshot.gitStatus
            workspace = snapshot.workspace
            conversations = snapshot.conversations
            hasLoadedConversations = snapshot.hasLoadedConversations
        }
    }

    /// Nav title: the folder's own name, or the app name at the jail root.
    var folderName: String {
        guard let path else { return "Relay" }
        return URL(fileURLWithPath: path).lastPathComponent
    }

    var isShowingSearchResults: Bool { searchText.trimmedNonEmpty != nil }

    var hiddenFolderCount: Int {
        entries.reduce(into: 0) { count, entry in
            if entry.isHiddenFolder { count += 1 }
        }
    }

    // MARK: - What the screen shows

    /// A centred spinner belongs only to a folder that has never been listed and has
    /// nothing to show. Reloads and polls keep the last listing on screen.
    var showsListingSpinner: Bool {
        listing == nil && entries.isEmpty && errorMessage == nil
    }

    /// Same rule for chats: once this folder has produced a list, here or on an earlier
    /// visit, refreshes keep that list on screen.
    var showsConversationSpinner: Bool {
        !hasLoadedConversations && conversationError == nil && errorMessage == nil
    }

    /// The Chats sub-tab count. It stays put while a refresh is in flight.
    var conversationCount: Int? {
        guard hasLoadedConversations, !conversations.isEmpty else { return nil }
        return conversations.count
    }

    /// Local listing filter: hide dot-directories unless the explorer toggle is
    /// on, then apply the compact name filter.
    func displayedEntries(showingHiddenFolders: Bool) -> [CodexWorkspaceDirectoryEntry] {
        Self.displayedEntries(
            from: entries,
            searchText: searchText,
            showingHiddenFolders: showingHiddenFolders
        )
    }

    nonisolated static func displayedEntries(
        from entries: [CodexWorkspaceDirectoryEntry],
        searchText: String,
        showingHiddenFolders: Bool
    ) -> [CodexWorkspaceDirectoryEntry] {
        let unhidden = showingHiddenFolders ? entries : entries.filter { !$0.isHiddenFolder }
        guard let query = searchText.trimmedNonEmpty?.lowercased() else { return unhidden }
        return unhidden.filter { entry in
            entry.displayName.lowercased().contains(query)
                || (entry.relativePath?.lowercased().contains(query) ?? false)
        }
    }

    /// True when the server bounded the current listing and more rows can be paged in.
    var showsTruncationBanner: Bool {
        guard searchText.trimmedNonEmpty == nil, let listing else { return false }
        return listing.truncated
    }

    var truncationLabel: String {
        guard let listing else { return "" }
        if let total = listing.total {
            return "Showing \(entries.count) of \(total)"
        }
        return "Showing the first \(entries.count) items"
    }

    // MARK: - Listing

    /// First appearance. A folder seeded from the cache is already drawn; the poll
    /// revalidates it, and only its borrowed workspace id is confirmed here.
    func loadIfNeeded() async {
        if listing != nil {
            await reconfirmSeededWorkspace()
            return
        }
        if isLoading {
            await waitWhileListingLoads()
            return
        }
        await load()
    }

    /// (Re)load the first page, resetting pagination. A pushed folder's path is known
    /// up front, so its workspace is selected alongside the listing rather than after it.
    func load() async {
        isLoading = true
        defer { isLoading = false }
        async let selection = selectWorkspaceIfUnconfirmed()
        do {
            let loaded = try await client.folderListing(path: path, offset: 0, limit: Self.pageSize)
            listing = loaded
            entries = loaded.entries
            errorMessage = nil
            rememberListing()
        } catch {
            if !isCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
        // Without a listing there is nothing to add: the listing error already says why.
        if case .failure(let error)? = await selection, listing != nil {
            reportWorkspaceFailure(error)
        }
    }

    /// Pull to refresh: the first page and git status together, plus this folder's chats
    /// when that tab is showing. Rows already on screen stay there throughout.
    func refresh(includingConversations: Bool = false) async {
        async let files: Void = load()
        async let git: Void = refreshGitStatus()
        if includingConversations {
            await refreshConversations()
        }
        _ = await (files, git)
    }

    /// Revalidate the folder's branch, diff counts, and open page while the explorer is
    /// on screen, every `pollInterval`. A daemon without `/v1/codex/fs/git` still
    /// refreshes the files.
    func watchGitStatus() async {
        while !Task.isCancelled {
            await pollOnce()
            try? await Task.sleep(for: Self.pollInterval)
        }
    }

    /// One quiet pass: git status and the open page, concurrently. A pass that starts
    /// while the previous one is still waiting on a slow machine is skipped, not stacked.
    func pollOnce() async {
        guard !isPolling else { return }
        isPolling = true
        defer { isPolling = false }
        async let git: Void = refreshGitStatus()
        async let files: Void = refreshListingQuietly()
        _ = await (git, files)
    }

    private func refreshGitStatus() async {
        guard !gitRouteUnavailable else { return }
        do {
            let status = try await client.folderGitStatus(path: path)
            let next = status.showsBar ? status : nil
            guard gitStatus != next else { return }
            gitStatus = next
            remember { $0.gitStatus = next }
        } catch {
            guard (error as? CodexClientError)?.isGenericRouteNotFound == true else { return }
            gitRouteUnavailable = true
            if gitStatus != nil {
                gitStatus = nil
                remember { $0.gitStatus = nil }
            }
        }
    }

    /// Replace the open page when the machine's files change, without flashing
    /// the loading state or dropping a page the user already asked for.
    private func refreshListingQuietly() async {
        guard isListingVisible, !isLoading, !isLoadingMore else { return }
        guard listing != nil else {
            // Nothing listed yet: the first load failed or has not started.
            await loadIfNeeded()
            return
        }
        let limit = min(500, max(Self.pageSize, entries.count))
        do {
            let loaded = try await client.folderListing(path: path, offset: 0, limit: limit)
            // A reload or a "load more" that landed meanwhile owns the page now.
            guard !isLoading, !isLoadingMore, entries.count <= limit else { return }
            guard loaded.entries != entries else { return }
            listing = loaded
            entries = loaded.entries
            rememberListing()
        } catch {
            return
        }
    }

    /// Page in the next chunk of a truncated listing.
    func loadMore() async {
        guard showsTruncationBanner, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let next = try await client.folderListing(path: path, offset: entries.count, limit: Self.pageSize)
            listing = next
            let knownIDs = Set(entries.map(\.id))
            entries.append(contentsOf: next.entries.filter { !knownIDs.contains($0.id) })
            errorMessage = nil
            rememberListing()
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Safe folder creation inside the current folder (server-registered), then reload.
    func createFolder(named name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isCreatingFolder else { return }
        isCreatingFolder = true
        defer { isCreatingFolder = false }
        do {
            _ = try await client.createFolderWorkspace(parentPath: currentFolderPath, name: trimmed)
            errorMessage = nil
            await load()
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Concrete path of this folder for chat scoping and creation ("" lets the server use
    /// its root until the first listing reports the resolved path).
    var currentFolderPath: String {
        path ?? listing?.currentPath ?? listing?.rootPath ?? ""
    }

    private func waitWhileListingLoads() async {
        while isLoading, listing == nil, !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 20_000_000)
        }
    }

    // MARK: - Chats

    /// The daemon includes saved CLI transcripts as well as runs started by Relay.
    /// `fs/list` may only *describe* a dynamic workspace, so this path is explicitly
    /// selected before its id goes to a workspace-scoped endpoint. That is what prevents
    /// the intermittent `workspaceId is not registered` response in nested folders.
    ///
    /// Callers that arrive while a refresh is in flight share it instead of stacking a
    /// second threads + jobs round trip.
    func refreshConversations() async {
        if let conversationRequest {
            await conversationRequest.value
            return
        }
        let request = Task { await self.reloadConversations() }
        conversationRequest = request
        await request.value
        if conversationRequest == request { conversationRequest = nil }
    }

    private func reloadConversations() async {
        guard let resolved = await ensureWorkspaceResolved() else {
            // The jail root has no workspace and therefore no chats of its own.
            if isJailRoot, conversationError == nil { hasLoadedConversations = true }
            return
        }
        isLoadingConversations = true
        defer { isLoadingConversations = false }
        do {
            let (workspaceID, items) = try await fetchConversationsConfirmingSeededWorkspace(resolved)
            guard workspace?.id == workspaceID else { return }
            if conversations != items { conversations = items }
            hasLoadedConversations = true
            conversationError = nil
            remember {
                $0.conversations = items
                $0.hasLoadedConversations = true
            }
        } catch {
            guard !isCancellation(error) else { return }
            conversationError = error.localizedDescription
        }
    }

    /// A workspace id borrowed from the cache can predate a relayd restart. If the
    /// machine rejects it, confirm the folder once and retry before reporting anything.
    private func fetchConversationsConfirmingSeededWorkspace(
        _ resolved: CodexWorkspace
    ) async throws -> (String, [CodexThreadFeedItem]) {
        let wasConfirmed = workspaceIsConfirmed
        do {
            return (resolved.id, try await fetchConversations(workspaceID: resolved.id))
        } catch {
            guard !wasConfirmed, let path, Self.isRejectedWorkspace(error) else { throw error }
            let confirmed = try await selectWorkspace(at: path).get()
            return (confirmed.id, try await fetchConversations(workspaceID: confirmed.id))
        }
    }

    private func fetchConversations(workspaceID: String) async throws -> [CodexThreadFeedItem] {
        async let threads = client.folderThreads(workspaceID: workspaceID, limit: 200)
        async let jobs = client.folderJobs(workspaceID: workspaceID, limit: 100)
        return try await CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs, workspaceID: workspaceID)
    }

    nonisolated static func isRejectedWorkspace(_ error: Error) -> Bool {
        guard let status = (error as? CodexClientError)?.statusCode else { return false }
        return status == 400 || status == 404
    }

    // MARK: - Workspace

    /// True for the jail root, which `workspaces/select` refuses by design.
    private var isJailRoot: Bool {
        guard let listing else { return path == nil }
        return listing.currentPath.isEmpty || listing.currentPath == listing.rootPath
    }

    private func ensureWorkspaceResolved() async -> CodexWorkspace? {
        if let workspace { return workspace }
        guard let path, !isJailRoot else { return nil }
        switch await selectWorkspace(at: path) {
        case .success(let resolved):
            return resolved
        case .failure(let error):
            reportWorkspaceFailure(error)
            return nil
        }
    }

    private func selectWorkspaceIfUnconfirmed() async -> Result<CodexWorkspace, Error>? {
        guard !workspaceIsConfirmed, let path else { return nil }
        return await selectWorkspace(at: path)
    }

    /// Confirm a cached workspace id once in the background, so terminals and new chats
    /// started from this screen carry an id relayd has materialized.
    private func reconfirmSeededWorkspace() async {
        guard !workspaceIsConfirmed, !didReconfirmSeededWorkspace, let path else { return }
        didReconfirmSeededWorkspace = true
        _ = await selectWorkspace(at: path)
    }

    /// One `workspaces/select` at a time per folder; concurrent callers share it.
    private func selectWorkspace(at folderPath: String) async -> Result<CodexWorkspace, Error> {
        if let workspaceRequest {
            let result = await workspaceRequest.value
            applyWorkspaceSelection(result)
            return result
        }
        let client = self.client
        let request = Task { () -> Result<CodexWorkspace, Error> in
            do {
                return .success(try await client.selectFolderWorkspace(path: folderPath))
            } catch {
                return .failure(error)
            }
        }
        workspaceRequest = request
        isResolvingWorkspace = true
        let result = await request.value
        if workspaceRequest == request {
            workspaceRequest = nil
            isResolvingWorkspace = false
        }
        applyWorkspaceSelection(result)
        return result
    }

    private func applyWorkspaceSelection(_ result: Result<CodexWorkspace, Error>) {
        guard case .success(let resolved) = result else { return }
        workspaceIsConfirmed = true
        guard workspace != resolved else { return }
        workspace = resolved
        conversationError = nil
        remember { $0.workspace = resolved }
    }

    private func reportWorkspaceFailure(_ error: Error) {
        // A seeded workspace keeps working when only its reconfirmation failed, and the
        // jail root is not selectable by design; neither is a chat failure.
        guard !isCancellation(error), workspace == nil, !isJailRoot else { return }
        conversationError = "Chats are unavailable in this folder: \(error.localizedDescription)"
    }

    // MARK: - Snapshot cache

    private func rememberListing() {
        let listing = listing
        let entries = entries
        remember {
            $0.listing = listing
            $0.entries = entries
        }
    }

    private func remember(_ change: (inout FileBrowserSnapshot) -> Void) {
        // A client retargeted at another machine no longer answers for this folder.
        guard FileBrowserSnapshotCache.Key(machine: client.baseURL, path: path) == cacheKey else { return }
        cache.update(cacheKey, change)
    }
}
