import Foundation

/// One folder's worth of browser state. Every pushed browser screen owns exactly one of
/// these via `@StateObject`, so navigating deeper never disturbs the listings behind it.
///
/// Listing comes from the bounded jail listing endpoint (`/v1/codex/fs/list`) with
/// offset/limit paging. Search reuses the proven recursive `q` search on the
/// workspace-dirs endpoint (harvested from the old workspace picker sheet); results
/// replace the listing until the query clears.
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

    /// Bound to `.searchable`; the view debounces via `runSearchAfterDebounce()`.
    @Published var searchText = ""
    /// Non-nil while a server search is active; replaces `entries` in the UI.
    @Published private(set) var searchResults: [CodexWorkspaceDirectoryEntry]?
    @Published private(set) var isSearching = false

    init(client: CodexClient, path: String? = nil) {
        self.client = client
        self.path = path?.trimmedNonEmpty
    }

    /// Nav title: the folder's own name, or the app name at the jail root.
    var folderName: String {
        guard let path else { return "Relay" }
        return URL(fileURLWithPath: path).lastPathComponent
    }

    var isShowingSearchResults: Bool { searchResults != nil }

    var visibleEntries: [CodexWorkspaceDirectoryEntry] { searchResults ?? entries }

    /// True when the server bounded the current listing and more rows can be paged in.
    var showsTruncationBanner: Bool {
        guard searchResults == nil, let listing else { return false }
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
        guard listing == nil, !isLoading else { return }
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
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        await load()
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

    /// Debounced server-backed search; call from a `.task(id: searchText)` so edits cancel
    /// the previous pass. Empty query drops straight back to the plain listing.
    func runSearchAfterDebounce() async {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else {
            searchResults = nil
            isSearching = false
            return
        }
        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled else { return }
        await runSearch(query: query)
    }

    private func runSearch(query: String) async {
        isSearching = true
        defer { isSearching = false }
        do {
            let result = try await client.fetchWorkspaceDirectories(path: path, query: query)
            // Ignore stale responses if the query moved on while the request was in flight.
            guard searchText.trimmingCharacters(in: .whitespacesAndNewlines) == query else { return }
            searchResults = result.entries
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
}
