import Foundation

/// One folder's worth of browser state. Every pushed browser screen owns exactly one of
/// these via `@StateObject`, so navigating deeper never disturbs the listings behind it.
///
/// Listing comes from the bounded jail listing endpoint (`/v1/codex/fs/list`) with
/// offset/limit paging. The visible page is filtered locally so the explorer responds
/// immediately and files do not disappear from results just because the older
/// workspace-directory search endpoint only knows about directories.
@MainActor
final class FileBrowserViewModel: ObservableObject {
    static let pageSize = 200

    /// Folder being listed; nil means the workspace jail root.
    let path: String?
    private let client: CodexClient

    @Published private(set) var listing: CodexWorkspaceDirectoryListing?
    /// Accumulated entries across "load more" pages (dirs first, then files, server-ordered).
    @Published private(set) var entries: [CodexWorkspaceDirectoryEntry] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var isCreatingFolder = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var conversations: [CodexThreadFeedItem] = []
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

    init(client: CodexClient, path: String? = nil) {
        self.client = client
        self.path = path?.trimmedNonEmpty
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

    func loadIfNeeded() async {
        if listing != nil { return }
        if isLoading {
            await waitWhileListingLoads()
            return
        }
        await load()
    }

    /// (Re)load the first page, resetting pagination.
    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await client.fetchDirectory(path: path, offset: 0, limit: Self.pageSize)
            listing = loaded
            entries = loaded.entries
            errorMessage = nil
            await resolveWorkspaceIfNeeded(from: loaded)
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        await load()
    }

    /// Poll the folder's branch, diff counts, and listing while the explorer is
    /// on screen. A daemon without `/v1/codex/fs/git` still refreshes the files.
    func watchGitStatus() async {
        var gitUnavailable = false
        while !Task.isCancelled {
            if !gitUnavailable {
                switch await refreshGitStatus() {
                case .cancelled:
                    return
                case .unavailable:
                    gitUnavailable = true
                case .ok:
                    break
                }
            }
            await refreshListingQuietly()
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private enum GitPoll { case ok, unavailable, cancelled }

    /// `.unavailable` when this daemon has no git route. `.cancelled` ends the watch.
    private func refreshGitStatus() async -> GitPoll {
        do {
            let status = try await client.fetchGitStatus(path: path)
            let next = status.showsBar ? status : nil
            if gitStatus != next { gitStatus = next }
            return .ok
        } catch {
            if isCancellation(error) { return .cancelled }
            if (error as? CodexClientError)?.isGenericRouteNotFound == true {
                gitStatus = nil
                return .unavailable
            }
            return .ok
        }
    }

    /// Replace the open page when the machine's files change, without flashing
    /// the loading state or dropping a page the user already asked for.
    private func refreshListingQuietly() async {
        guard !isLoading, !isLoadingMore else { return }
        let limit = min(500, max(Self.pageSize, entries.count))
        do {
            let loaded = try await client.fetchDirectory(path: path, offset: 0, limit: limit)
            guard loaded.entries != entries else { return }
            listing = loaded
            entries = loaded.entries
        } catch {
            return
        }
    }

    /// The daemon includes saved CLI transcripts as well as runs started by Relay.
    /// `fs/list` may only *describe* a dynamic workspace, so explicitly select this
    /// path before using its id in a workspace-scoped endpoint. This is what prevents
    /// the intermittent `workspaceId is not registered` response in nested folders.
    func refreshConversations() async {
        if listing == nil {
            await loadIfNeeded()
        }
        await waitWhileListingLoads()
        guard let workspace = await ensureWorkspaceResolved() else { return }
        let workspaceID = workspace.id
        isLoadingConversations = true
        defer { isLoadingConversations = false }
        do {
            async let threads = client.fetchThreads(workspaceID: workspaceID, limit: 200)
            async let jobs = client.fetchJobs(workspaceID: workspaceID, limit: 100)
            let items = try await CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs, workspaceID: workspaceID)
            guard self.workspace?.id == workspaceID else { return }
            conversations = items
            conversationError = nil
        } catch {
            guard !isCancellation(error) else { return }
            conversationError = error.localizedDescription
        }
    }

    /// Page in the next chunk of a truncated listing.
    func loadMore() async {
        guard showsTruncationBanner, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        do {
            let next = try await client.fetchDirectory(path: path, offset: entries.count, limit: Self.pageSize)
            listing = next
            let knownIDs = Set(entries.map(\.id))
            entries.append(contentsOf: next.entries.filter { !knownIDs.contains($0.id) })
            errorMessage = nil
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
            _ = try await client.createWorkspace(parentPath: currentFolderPath, name: trimmed)
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

    private func ensureWorkspaceResolved() async -> CodexWorkspace? {
        if let workspace { return workspace }
        if isLoading {
            await waitWhileListingLoads()
        }
        if isResolvingWorkspace {
            while isResolvingWorkspace, !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000)
            }
            return workspace
        }
        guard let listing else {
            conversationError = errorMessage ?? "This folder is still loading."
            return nil
        }
        await resolveWorkspaceIfNeeded(from: listing)
        return workspace
    }

    private func resolveWorkspaceIfNeeded(from listing: CodexWorkspaceDirectoryListing) async {
        guard workspace == nil,
              !isResolvingWorkspace,
              listing.currentPath != listing.rootPath,
              !listing.currentPath.isEmpty else { return }

        isResolvingWorkspace = true
        defer { isResolvingWorkspace = false }
        do {
            workspace = try await client.selectWorkspace(path: listing.currentPath)
            conversationError = nil
        } catch {
            guard !isCancellation(error) else { return }
            conversationError = "Chats are unavailable in this folder: \(error.localizedDescription)"
        }
    }
}
