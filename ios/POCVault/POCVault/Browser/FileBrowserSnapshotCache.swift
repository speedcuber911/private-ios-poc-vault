import Foundation
import UIKit

/// What the Folders tab reads from a paired machine. `CodexClient` is the only
/// production conformer; tests substitute a scripted source so the browser's
/// caching and refresh rules can be exercised without a network.
protocol FileBrowserDataSource: AnyObject {
    var baseURL: URL { get }
    func folderListing(path: String?, offset: Int, limit: Int) async throws -> CodexWorkspaceDirectoryListing
    func folderGitStatus(path: String?) async throws -> RelayGitStatus
    func selectFolderWorkspace(path: String) async throws -> CodexWorkspace
    func createFolderWorkspace(parentPath: String, name: String) async throws -> CodexWorkspace
    func folderThreads(workspaceID: String, limit: Int) async throws -> [CodexThread]
    func folderJobs(workspaceID: String, limit: Int) async throws -> [CodexJob]
}

/// Forwards by name so the client's own signatures (and their defaulted options)
/// can grow without breaking this conformance.
extension CodexClient: FileBrowserDataSource {
    func folderListing(path: String?, offset: Int, limit: Int) async throws -> CodexWorkspaceDirectoryListing {
        try await fetchDirectory(path: path, offset: offset, limit: limit)
    }

    func folderGitStatus(path: String?) async throws -> RelayGitStatus {
        try await fetchGitStatus(path: path)
    }

    func selectFolderWorkspace(path: String) async throws -> CodexWorkspace {
        try await selectWorkspace(path: path)
    }

    func createFolderWorkspace(parentPath: String, name: String) async throws -> CodexWorkspace {
        try await createWorkspace(parentPath: parentPath, name: name)
    }

    func folderThreads(workspaceID: String, limit: Int) async throws -> [CodexThread] {
        try await fetchThreads(workspaceID: workspaceID, limit: limit)
    }

    func folderJobs(workspaceID: String, limit: Int) async throws -> [CodexJob] {
        try await fetchJobs(workspaceID: workspaceID, limit: limit)
    }
}

/// The last thing one folder showed: its open listing (including any pages the user
/// paged in), git status, the workspace `workspaces/select` confirmed for it, and its
/// chats. A pushed folder seeds from this synchronously, so reopening a folder
/// draws its last contents on the first frame and revalidates behind them.
struct FileBrowserSnapshot: Equatable {
    var listing: CodexWorkspaceDirectoryListing?
    var entries: [CodexWorkspaceDirectoryEntry] = []
    var gitStatus: RelayGitStatus?
    var workspace: CodexWorkspace?
    var conversations: [CodexThreadFeedItem] = []
    /// Distinguishes "this folder has no chats" from "chats never loaded here".
    var hasLoadedConversations = false
}

/// App-wide, in-memory, bounded store of folder snapshots keyed by machine and path.
/// Nothing here is persisted: it only has to outlive one pushed screen, and a
/// memory warning simply empties it.
@MainActor
final class FileBrowserSnapshotCache {
    static let shared = FileBrowserSnapshotCache()
    nonisolated static let defaultCapacity = 50

    struct Key: Hashable {
        let machine: String
        let path: String

        /// A path is meaningless on another machine, so the machine's base URL is part
        /// of the key. The jail root is the empty path.
        init(machine: URL, path: String?) {
            self.machine = Self.normalized(machine.absoluteString)
            self.path = Self.normalized(path?.trimmedNonEmpty ?? "")
        }

        private static func normalized(_ value: String) -> String {
            var value = value
            while value.count > 1, value.hasSuffix("/") { value.removeLast() }
            return value
        }
    }

    let capacity: Int
    private var snapshots: [Key: FileBrowserSnapshot] = [:]
    /// Least recently used first.
    private var recency: [Key] = []
    private var memoryWarningObserver: NSObjectProtocol?

    init(capacity: Int = FileBrowserSnapshotCache.defaultCapacity) {
        self.capacity = max(1, capacity)
        memoryWarningObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.removeAll() }
        }
    }

    deinit {
        if let memoryWarningObserver {
            NotificationCenter.default.removeObserver(memoryWarningObserver)
        }
    }

    var count: Int { snapshots.count }

    /// The folder's last snapshot, marking it most recently used.
    func snapshot(for key: Key) -> FileBrowserSnapshot? {
        guard let snapshot = snapshots[key] else { return nil }
        touch(key)
        return snapshot
    }

    func update(_ key: Key, _ change: (inout FileBrowserSnapshot) -> Void) {
        var snapshot = snapshots[key] ?? FileBrowserSnapshot()
        change(&snapshot)
        snapshots[key] = snapshot
        touch(key)
        while recency.count > capacity {
            snapshots.removeValue(forKey: recency.removeFirst())
        }
    }

    func removeAll() {
        snapshots.removeAll()
        recency.removeAll()
    }

    private func touch(_ key: Key) {
        if let index = recency.firstIndex(of: key) {
            recency.remove(at: index)
        }
        recency.append(key)
    }
}
