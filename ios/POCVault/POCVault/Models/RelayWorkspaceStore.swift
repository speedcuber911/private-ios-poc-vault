import Combine
import Foundation

// MARK: - Workspace Tab Models

enum RelayWorkspaceTabKind: Hashable {
    case agent(launchID: UUID, title: String, provider: CodexProvider?, threadID: String?)
    case terminal(id: UUID, workspaceID: String, title: String)

    var isAgent: Bool {
        if case .agent = self { return true }
        return false
    }

    var isTerminal: Bool {
        if case .terminal = self { return true }
        return false
    }

    var launchID: UUID? {
        if case .agent(let launchID, _, _, _) = self { return launchID }
        return nil
    }

    var terminalID: UUID? {
        if case .terminal(let id, _, _) = self { return id }
        return nil
    }

    var provider: CodexProvider? {
        if case .agent(_, _, let provider, _) = self { return provider }
        return nil
    }

    var threadID: String? {
        if case .agent(_, _, _, let threadID) = self { return threadID }
        return nil
    }

    var terminalWorkspaceID: String? {
        if case .terminal(_, let workspaceID, _) = self { return workspaceID }
        return nil
    }
}

struct RelayWorkspaceTab: Identifiable, Hashable {
    let id: UUID
    var kind: RelayWorkspaceTabKind
    var title: String
    var isRunning: Bool
    var needsInput: Bool

    init(
        id: UUID = UUID(),
        kind: RelayWorkspaceTabKind,
        title: String,
        isRunning: Bool = false,
        needsInput: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.isRunning = isRunning
        self.needsInput = needsInput
    }
}

// MARK: - Project & Workspace Records

struct RelayWorkspaceRecord: Identifiable, Hashable {
    let id: String
    var workspaceID: String?
    var projectPath: String
    var projectName: String
    var path: String
    var name: String
    var branch: String?
    var isWorktree: Bool
    var isManagedWorktree: Bool
    var dirty: Bool
    var added: Int
    var deleted: Int
    var pr: RelayGitPRInfo?
    var threads: [CodexThreadFeedItem]

    init(
        id: String? = nil,
        workspaceID: String? = nil,
        projectPath: String,
        projectName: String,
        path: String,
        name: String,
        branch: String? = nil,
        isWorktree: Bool = false,
        isManagedWorktree: Bool = false,
        dirty: Bool = false,
        added: Int = 0,
        deleted: Int = 0,
        pr: RelayGitPRInfo? = nil,
        threads: [CodexThreadFeedItem] = []
    ) {
        let canonical = RelayWorkspaceStore.canonicalPath(path)
        self.id = id.map(RelayWorkspaceStore.canonicalPath) ?? canonical
        self.workspaceID = workspaceID?.trimmedNonEmpty
        self.projectPath = RelayWorkspaceStore.canonicalPath(projectPath)
        self.projectName = projectName
        self.path = canonical
        self.name = name
        self.branch = branch?.trimmedNonEmpty
        self.isWorktree = isWorktree
        self.isManagedWorktree = isManagedWorktree
        self.dirty = dirty
        self.added = added
        self.deleted = deleted
        self.pr = pr
        self.threads = threads
    }

    var isMainWorkspace: Bool { !isWorktree }

    var displayBranch: String {
        branch?.trimmedNonEmpty ?? name
    }

    var hasChanges: Bool {
        dirty || added > 0 || deleted > 0
    }

    var diffSummary: String? {
        guard added > 0 || deleted > 0 else { return nil }
        return "+\(added) -\(deleted)"
    }

    var hasRunningThread: Bool {
        threads.contains(where: \.isActive)
    }

    var needsInput: Bool {
        threads.contains { $0.status == .waitingForApproval }
    }

    var mostRecentActivity: Date? {
        threads.compactMap(\.updatedAt).max()
    }
}

struct RelayProjectRecord: Identifiable, Hashable {
    let id: String
    var name: String
    var rootPath: String
    var workspaceID: String?
    var workspaces: [RelayWorkspaceRecord]

    init(
        id: String? = nil,
        name: String,
        rootPath: String,
        workspaceID: String? = nil,
        workspaces: [RelayWorkspaceRecord] = []
    ) {
        let canonical = RelayWorkspaceStore.canonicalPath(rootPath)
        self.id = id.map(RelayWorkspaceStore.canonicalPath) ?? canonical
        self.name = name
        self.rootPath = canonical
        self.workspaceID = workspaceID?.trimmedNonEmpty
        self.workspaces = workspaces
    }

    var mainWorkspace: RelayWorkspaceRecord? {
        workspaces.first(where: { !$0.isWorktree }) ?? workspaces.first
    }

    var worktrees: [RelayWorkspaceRecord] {
        workspaces.filter(\.isWorktree)
    }

    var hasRunningActivity: Bool {
        workspaces.contains(where: \.hasRunningThread)
    }

    var needsInput: Bool {
        workspaces.contains(where: \.needsInput)
    }

    var totalThreadCount: Int {
        workspaces.reduce(0) { $0 + $1.threads.count }
    }

    var mostRecentActivity: Date? {
        workspaces.compactMap(\.mostRecentActivity).max()
    }
}

// MARK: - Multi-Tab Workspace State Store

/// Owns Paseo's Project -> Workspaces -> Multi-Tab (Agent Sessions + Terminals) state
/// alongside per-workspace cached Git status for sidebar meta rows and header badges.
@MainActor
final class RelayWorkspaceStore: ObservableObject {
    @Published private(set) var projects: [RelayProjectRecord] = []
    @Published private(set) var gitStatusByPath: [String: RelayGitStatusResponse] = [:]
    @Published private(set) var tabsByWorkspacePath: [String: [RelayWorkspaceTab]] = [:]
    @Published private(set) var activeTabIDByWorkspacePath: [String: UUID] = [:]
    @Published private(set) var isRefreshing = false
    @Published private(set) var hasLoadedOnce = false
    @Published private(set) var lastRefreshedAt: Date?
    @Published private(set) var lastError: String?
    @Published var selectedWorkspacePath: String?

    private var generation = 0
    private var activeRefreshCount = 0
    private var knownWorkspaceIDsByPath: [String: String] = [:]
    private var lastFeedItems: [CodexThreadFeedItem] = []

    init() {}

    nonisolated static func canonicalPath(_ path: String) -> String {
        var trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.count > 1, trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return trimmed
    }

    // MARK: - Project & Workspace Refresh

    /// Fetches registered workspaces, workspace root directories, persistent worktrees,
    /// and per-workspace Git status (gracefully tolerating 404 from older `relayd` builds),
    /// then combines them with `feedItems` into `projects`.
    func refreshProjects(client: CodexClient, feedItems: [CodexThreadFeedItem]) async {
        let refreshGeneration = generation
        lastFeedItems = feedItems
        activeRefreshCount += 1
        isRefreshing = true
        defer {
            activeRefreshCount = max(0, activeRefreshCount - 1)
            if activeRefreshCount == 0 {
                isRefreshing = false
            }
        }

        let budget = CodexRequestBudget.statusRead

        async let workspacesResult: Result<[CodexWorkspace], Error> = {
            do {
                return .success(try await client.fetchWorkspaces(budget: budget))
            } catch {
                return .failure(error)
            }
        }()

        async let dirsResult: Result<CodexWorkspaceDirectoryListing, Error> = {
            do {
                return .success(try await client.fetchWorkspaceDirectories(path: nil, query: nil, budget: budget))
            } catch {
                return .failure(error)
            }
        }()

        let (resolvedWorkspaces, resolvedDirs) = await (workspacesResult, dirsResult)
        guard refreshGeneration == generation, !Task.isCancelled else { return }

        var registeredWorkspaces: [CodexWorkspace] = []
        var rootListing: CodexWorkspaceDirectoryListing?
        var rootErrors: [Error] = []

        switch resolvedWorkspaces {
        case .success(let list):
            registeredWorkspaces = list
        case .failure(let error):
            if !isCancellation(error) {
                rootErrors.append(error)
            }
        }

        switch resolvedDirs {
        case .success(let listing):
            rootListing = listing
        case .failure(let error):
            if !isCancellation(error) {
                rootErrors.append(error)
            }
        }

        // If every discovery call failed (e.g., transient network drop), preserve
        // already-loaded projects while refreshing thread associations locally.
        if registeredWorkspaces.isEmpty && rootListing == nil {
            if let firstError = rootErrors.first {
                lastError = firstError.localizedDescription
            }
            if !projects.isEmpty {
                updateFeedItems(feedItems)
            }
            return
        }

        // Build deduplicated candidate project roots keyed by canonical path.
        var seedsByPath: [String: ProjectSeed] = [:]
        var defaultPaths: Set<String> = []

        for workspace in registeredWorkspaces {
            guard let rawPath = workspace.path?.trimmedNonEmpty else { continue }
            let canonical = Self.canonicalPath(rawPath)
            knownWorkspaceIDsByPath[canonical] = workspace.id
            if workspace.isDefault {
                defaultPaths.insert(canonical)
            }
            guard !Self.isManagedWorktreeSubpath(canonical) else { continue }
            seedsByPath[canonical] = ProjectSeed(
                rootPath: canonical,
                name: workspace.name.trimmedNonEmpty ?? Self.lastPathComponent(canonical),
                workspaceID: workspace.id,
                isDefault: workspace.isDefault,
                hasGitHint: true
            )
        }

        if let entries = rootListing?.entries {
            for entry in entries where entry.isDirectory && !entry.isHiddenFolder {
                let canonical = Self.canonicalPath(entry.path)
                guard !canonical.isEmpty, !Self.isManagedWorktreeSubpath(canonical) else { continue }
                if let workspaceID = entry.workspaceId?.trimmedNonEmpty {
                    knownWorkspaceIDsByPath[canonical] = workspaceID
                }
                if var existing = seedsByPath[canonical] {
                    if existing.workspaceID == nil {
                        existing.workspaceID = entry.workspaceId?.trimmedNonEmpty
                    }
                    if entry.hasGit {
                        existing.hasGitHint = true
                    }
                    seedsByPath[canonical] = existing
                } else {
                    seedsByPath[canonical] = ProjectSeed(
                        rootPath: canonical,
                        name: entry.workspaceName?.trimmedNonEmpty ?? entry.displayName,
                        workspaceID: entry.workspaceId?.trimmedNonEmpty,
                        isDefault: false,
                        hasGitHint: entry.hasGit
                    )
                }
            }
        }

        let seedPaths = Array(seedsByPath.keys)

        // Fetch worktrees per candidate project root concurrently; tolerate 404 / non-git.
        let worktreesByRoot: [String: [RelayWorktreeDescriptor]] = await withTaskGroup(
            of: (String, [RelayWorktreeDescriptor]).self
        ) { group in
            for rootPath in seedPaths {
                group.addTask {
                    do {
                        let list = try await client.fetchWorktrees(path: rootPath, budget: budget)
                        return (rootPath, list)
                    } catch {
                        return (rootPath, [])
                    }
                }
            }
            var collected: [String: [RelayWorktreeDescriptor]] = [:]
            for await (rootPath, list) in group {
                collected[rootPath] = list
            }
            return collected
        }

        guard refreshGeneration == generation, !Task.isCancelled else { return }

        // If a sibling directory in workspace root is actually a non-main worktree of
        // another project, collapse it under that project rather than duplicating it.
        var nonMainWorktreePaths: Set<String> = []
        for (_, descriptors) in worktreesByRoot {
            for descriptor in descriptors where !descriptor.isMain {
                nonMainWorktreePaths.insert(Self.canonicalPath(descriptor.path))
            }
        }

        let topLevelSeeds = seedsByPath.values.filter { !nonMainWorktreePaths.contains($0.rootPath) }

        // Collect every workspace path whose git status should be queried.
        var allWorkspacePaths: Set<String> = []
        for seed in topLevelSeeds {
            allWorkspacePaths.insert(seed.rootPath)
            for descriptor in worktreesByRoot[seed.rootPath] ?? [] {
                allWorkspacePaths.insert(Self.canonicalPath(descriptor.path))
            }
        }

        // Fetch full repository git status per workspace path concurrently; tolerate 404.
        let fetchedStatuses: [String: RelayGitStatusResponse] = await withTaskGroup(
            of: (String, RelayGitStatusResponse?).self
        ) { group in
            for workspacePath in allWorkspacePaths {
                group.addTask {
                    do {
                        let status = try await client.fetchRepoGitStatus(path: workspacePath, budget: budget)
                        return (workspacePath, status)
                    } catch {
                        return (workspacePath, nil)
                    }
                }
            }
            var collected: [String: RelayGitStatusResponse] = [:]
            for await (workspacePath, status) in group {
                if let status {
                    collected[workspacePath] = status
                }
            }
            return collected
        }

        guard refreshGeneration == generation, !Task.isCancelled else { return }

        // Merge newly fetched statuses into cache (retain previous entries for paths not refreshed).
        var updatedGitCache = gitStatusByPath
        for (workspacePath, status) in fetchedStatuses {
            updatedGitCache[workspacePath] = status
        }

        // Assemble projects and workspace records.
        var assembledProjects: [RelayProjectRecord] = []
        for seed in topLevelSeeds {
            let descriptors = worktreesByRoot[seed.rootPath] ?? []
            var workspaceRecords: [RelayWorkspaceRecord] = []
            var seenWorkspacePaths: Set<String> = []

            if descriptors.isEmpty {
                let status = updatedGitCache[seed.rootPath]
                let record = RelayWorkspaceRecord(
                    workspaceID: seed.workspaceID ?? knownWorkspaceIDsByPath[seed.rootPath],
                    projectPath: seed.rootPath,
                    projectName: seed.name,
                    path: seed.rootPath,
                    name: status?.branch ?? Self.lastPathComponent(seed.rootPath),
                    branch: status?.branch,
                    isWorktree: false,
                    isManagedWorktree: false,
                    dirty: status?.dirty ?? false,
                    added: status?.added ?? 0,
                    deleted: status?.deleted ?? 0,
                    pr: status?.pr,
                    threads: []
                )
                workspaceRecords.append(record)
                seenWorkspacePaths.insert(seed.rootPath)
            } else {
                for descriptor in descriptors {
                    let wtPath = Self.canonicalPath(descriptor.path)
                    guard seenWorkspacePaths.insert(wtPath).inserted else { continue }
                    let status = updatedGitCache[wtPath]
                    let isWorktree = !descriptor.isMain
                    let resolvedWorkspaceID: String? = if !isWorktree {
                        seed.workspaceID ?? knownWorkspaceIDsByPath[wtPath]
                    } else {
                        knownWorkspaceIDsByPath[wtPath]
                    }
                    let displayName: String = if descriptor.isMain {
                        status?.branch ?? descriptor.branch ?? descriptor.name
                    } else {
                        descriptor.name.trimmedNonEmpty ?? status?.branch ?? descriptor.branch ?? Self.lastPathComponent(wtPath)
                    }
                    let record = RelayWorkspaceRecord(
                        workspaceID: resolvedWorkspaceID,
                        projectPath: seed.rootPath,
                        projectName: seed.name,
                        path: wtPath,
                        name: displayName,
                        branch: status?.branch ?? descriptor.branch,
                        isWorktree: isWorktree,
                        isManagedWorktree: descriptor.isManaged,
                        dirty: status?.dirty ?? descriptor.dirty,
                        added: status?.added ?? descriptor.added,
                        deleted: status?.deleted ?? descriptor.deleted,
                        pr: status?.pr,
                        threads: []
                    )
                    workspaceRecords.append(record)
                }

                // Guarantee main project root is present even if worktree list omitted it.
                if !seenWorkspacePaths.contains(seed.rootPath) {
                    let status = updatedGitCache[seed.rootPath]
                    let mainRecord = RelayWorkspaceRecord(
                        workspaceID: seed.workspaceID ?? knownWorkspaceIDsByPath[seed.rootPath],
                        projectPath: seed.rootPath,
                        projectName: seed.name,
                        path: seed.rootPath,
                        name: status?.branch ?? Self.lastPathComponent(seed.rootPath),
                        branch: status?.branch,
                        isWorktree: false,
                        isManagedWorktree: false,
                        dirty: status?.dirty ?? false,
                        added: status?.added ?? 0,
                        deleted: status?.deleted ?? 0,
                        pr: status?.pr,
                        threads: []
                    )
                    workspaceRecords.insert(mainRecord, at: 0)
                }
            }

            assembledProjects.append(
                RelayProjectRecord(
                    name: seed.name,
                    rootPath: seed.rootPath,
                    workspaceID: seed.workspaceID,
                    workspaces: workspaceRecords
                )
            )
        }

        // Attach feed items to matching workspaces and sort cleanly.
        assembledProjects = Self.attachThreads(feedItems, to: assembledProjects)
        assembledProjects = Self.sortProjects(assembledProjects, defaultPaths: defaultPaths)

        if gitStatusByPath != updatedGitCache {
            gitStatusByPath = updatedGitCache
        }
        if projects != assembledProjects {
            projects = assembledProjects
        }
        reconcileTabStates(with: feedItems)
        hasLoadedOnce = true
        lastRefreshedAt = Date()
        lastError = nil
    }

    /// Synchronously re-attaches updated feed items to the current projects list and
    /// refreshes live running/needs-input tab badges without issuing network requests.
    func updateFeedItems(_ feedItems: [CodexThreadFeedItem]) {
        lastFeedItems = feedItems
        if !projects.isEmpty {
            let updated = Self.attachThreads(feedItems, to: projects)
            if projects != updated {
                projects = updated
            }
        }
        reconcileTabStates(with: feedItems)
    }

    // MARK: - Git Status Cache Helpers

    func gitStatus(for workspacePath: String) -> RelayGitStatusResponse? {
        gitStatusByPath[Self.canonicalPath(workspacePath)]
    }

    /// Updates cached git status for a single workspace path and immediately mirrors
    /// branch, dirty flag, line counts, and PR info onto the matching `RelayWorkspaceRecord`.
    func cacheGitStatus(_ status: RelayGitStatusResponse, for workspacePath: String) {
        let key = Self.canonicalPath(workspacePath)
        gitStatusByPath[key] = status
        applyGitStatusToProjects(status, forCanonicalPath: key)
    }

    /// Refreshes git status for one workspace path (e.g., after commit, checkout, or discard).
    @discardableResult
    func refreshGitStatus(client: CodexClient, path: String) async -> RelayGitStatusResponse? {
        let key = Self.canonicalPath(path)
        do {
            let status = try await client.fetchRepoGitStatus(path: key, budget: .statusRead)
            cacheGitStatus(status, for: key)
            return status
        } catch {
            return gitStatusByPath[key]
        }
    }

    // MARK: - Workspace Lookup & Identity Adoption

    func workspace(forPath path: String) -> RelayWorkspaceRecord? {
        let key = Self.canonicalPath(path)
        for project in projects {
            if let match = project.workspaces.first(where: { $0.path == key }) {
                return match
            }
        }
        return nil
    }

    func project(forWorkspacePath path: String) -> RelayProjectRecord? {
        let key = Self.canonicalPath(path)
        return projects.first { project in
            project.rootPath == key || project.workspaces.contains(where: { $0.path == key })
        }
    }

    /// Records a `workspaceID` confirmed by `POST /v1/codex/workspaces/select` for a workspace path.
    func adoptWorkspaceID(_ workspaceID: String, forPath path: String) {
        guard let trimmed = workspaceID.trimmedNonEmpty else { return }
        let key = Self.canonicalPath(path)
        knownWorkspaceIDsByPath[key] = trimmed
        for pIndex in projects.indices {
            if projects[pIndex].rootPath == key && projects[pIndex].workspaceID == nil {
                projects[pIndex].workspaceID = trimmed
            }
            for wIndex in projects[pIndex].workspaces.indices where projects[pIndex].workspaces[wIndex].path == key {
                projects[pIndex].workspaces[wIndex].workspaceID = trimmed
            }
        }
    }

    // MARK: - Per-Workspace Multi-Tab Management

    func tabs(for workspacePath: String) -> [RelayWorkspaceTab] {
        tabsByWorkspacePath[Self.canonicalPath(workspacePath)] ?? []
    }

    func activeTabID(for workspacePath: String) -> UUID? {
        let key = Self.canonicalPath(workspacePath)
        let workspaceTabs = tabsByWorkspacePath[key] ?? []
        if let activeID = activeTabIDByWorkspacePath[key],
           workspaceTabs.contains(where: { $0.id == activeID }) {
            return activeID
        }
        return workspaceTabs.first?.id
    }

    func activeTab(for workspacePath: String) -> RelayWorkspaceTab? {
        guard let activeID = activeTabID(for: workspacePath) else { return nil }
        return tabs(for: workspacePath).first(where: { $0.id == activeID })
    }

    func selectTab(_ tabID: UUID, in workspacePath: String) {
        let key = Self.canonicalPath(workspacePath)
        guard let workspaceTabs = tabsByWorkspacePath[key],
              workspaceTabs.contains(where: { $0.id == tabID }) else {
            return
        }
        if activeTabIDByWorkspacePath[key] != tabID {
            activeTabIDByWorkspacePath[key] = tabID
        }
    }

    @discardableResult
    func openAgentTab(
        in workspacePath: String,
        launchID: UUID = UUID(),
        title: String,
        provider: CodexProvider? = nil,
        threadID: String? = nil
    ) -> RelayWorkspaceTab {
        let key = Self.canonicalPath(workspacePath)
        let cleanedTitle = title.trimmedNonEmpty ?? "New Chat"
        let cleanedThreadID = threadID?.trimmedNonEmpty
        var workspaceTabs = tabsByWorkspacePath[key] ?? []

        // Reuse an already-open tab for the same thread or launch ID so tapping
        // a sidebar thread focuses it instead of spawning duplicate tabs.
        if let existingIndex = workspaceTabs.firstIndex(where: { tab in
            if tab.id == launchID { return true }
            if let cleanedThreadID, tab.kind.threadID == cleanedThreadID { return true }
            return false
        }) {
            var existing = workspaceTabs[existingIndex]
            let resolvedProvider = provider ?? existing.kind.provider
            let resolvedThreadID = cleanedThreadID ?? existing.kind.threadID
            let resolvedLaunchID = existing.kind.launchID ?? existing.id
            existing.title = cleanedTitle
            existing.kind = .agent(
                launchID: resolvedLaunchID,
                title: cleanedTitle,
                provider: resolvedProvider,
                threadID: resolvedThreadID
            )
            workspaceTabs[existingIndex] = existing
            tabsByWorkspacePath[key] = workspaceTabs
            activeTabIDByWorkspacePath[key] = existing.id
            return existing
        }

        let matchedFeedItem = cleanedThreadID.flatMap { targetID in
            lastFeedItems.first(where: { $0.sessionID == targetID })
        }
        let tab = RelayWorkspaceTab(
            id: launchID,
            kind: .agent(
                launchID: launchID,
                title: cleanedTitle,
                provider: provider,
                threadID: cleanedThreadID
            ),
            title: cleanedTitle,
            isRunning: matchedFeedItem?.isActive ?? false,
            needsInput: matchedFeedItem?.status == .waitingForApproval
        )
        workspaceTabs.append(tab)
        tabsByWorkspacePath[key] = workspaceTabs
        activeTabIDByWorkspacePath[key] = tab.id
        return tab
    }

    @discardableResult
    func openTerminalTab(
        in workspacePath: String,
        workspaceID: String,
        title: String? = nil
    ) -> RelayWorkspaceTab {
        let key = Self.canonicalPath(workspacePath)
        var workspaceTabs = tabsByWorkspacePath[key] ?? []
        let terminalCount = workspaceTabs.filter { $0.kind.isTerminal }.count
        let resolvedTitle = title?.trimmedNonEmpty ?? (terminalCount == 0 ? "Terminal" : "Terminal \(terminalCount + 1)")
        let tabID = UUID()
        let tab = RelayWorkspaceTab(
            id: tabID,
            kind: .terminal(id: tabID, workspaceID: workspaceID, title: resolvedTitle),
            title: resolvedTitle,
            isRunning: false,
            needsInput: false
        )
        workspaceTabs.append(tab)
        tabsByWorkspacePath[key] = workspaceTabs
        activeTabIDByWorkspacePath[key] = tab.id
        return tab
    }

    func closeTab(_ tabID: UUID, in workspacePath: String) {
        let key = Self.canonicalPath(workspacePath)
        guard var workspaceTabs = tabsByWorkspacePath[key],
              let removedIndex = workspaceTabs.firstIndex(where: { $0.id == tabID }) else {
            return
        }

        workspaceTabs.remove(at: removedIndex)
        if workspaceTabs.isEmpty {
            tabsByWorkspacePath.removeValue(forKey: key)
            activeTabIDByWorkspacePath.removeValue(forKey: key)
            return
        }

        tabsByWorkspacePath[key] = workspaceTabs
        if activeTabIDByWorkspacePath[key] == tabID {
            let nextIndex = min(removedIndex, workspaceTabs.count - 1)
            activeTabIDByWorkspacePath[key] = workspaceTabs[nextIndex].id
        }
    }

    func renameTab(_ tabID: UUID, title: String, in workspacePath: String) {
        guard let cleanedTitle = title.trimmedNonEmpty else { return }
        let key = Self.canonicalPath(workspacePath)
        guard var workspaceTabs = tabsByWorkspacePath[key],
              let index = workspaceTabs.firstIndex(where: { $0.id == tabID }) else {
            return
        }

        var updated = workspaceTabs[index]
        updated.title = cleanedTitle
        switch updated.kind {
        case .agent(let launchID, _, let provider, let threadID):
            updated.kind = .agent(launchID: launchID, title: cleanedTitle, provider: provider, threadID: threadID)
        case .terminal(let id, let workspaceID, _):
            updated.kind = .terminal(id: id, workspaceID: workspaceID, title: cleanedTitle)
        }
        workspaceTabs[index] = updated
        tabsByWorkspacePath[key] = workspaceTabs
    }

    /// Updates live metadata on an open tab (such as binding a newly created `threadID`
    /// or updating `isRunning` / `needsInput` indicators).
    func updateTabState(
        _ tabID: UUID,
        in workspacePath: String,
        title: String? = nil,
        provider: CodexProvider? = nil,
        threadID: String? = nil,
        isRunning: Bool? = nil,
        needsInput: Bool? = nil
    ) {
        let key = Self.canonicalPath(workspacePath)
        guard var workspaceTabs = tabsByWorkspacePath[key],
              let index = workspaceTabs.firstIndex(where: { $0.id == tabID }) else {
            return
        }

        var updated = workspaceTabs[index]
        if let cleanedTitle = title?.trimmedNonEmpty {
            updated.title = cleanedTitle
        }
        if let isRunning {
            updated.isRunning = isRunning
        }
        if let needsInput {
            updated.needsInput = needsInput
        }
        switch updated.kind {
        case .agent(let launchID, let existingTitle, let existingProvider, let existingThreadID):
            updated.kind = .agent(
                launchID: launchID,
                title: title?.trimmedNonEmpty ?? existingTitle,
                provider: provider ?? existingProvider,
                threadID: threadID?.trimmedNonEmpty ?? existingThreadID
            )
        case .terminal(let id, let workspaceID, let existingTitle):
            updated.kind = .terminal(
                id: id,
                workspaceID: workspaceID,
                title: title?.trimmedNonEmpty ?? existingTitle
            )
        }

        if workspaceTabs[index] != updated {
            workspaceTabs[index] = updated
            tabsByWorkspacePath[key] = workspaceTabs
        }
    }

    // MARK: - Worktree Lifecycle

    func createWorktree(
        client: CodexClient,
        projectPath: String,
        name: String? = nil,
        branch: String? = nil,
        baseBranch: String? = nil,
        action: String = "branch-off"
    ) async throws -> RelayWorkspaceRecord {
        let canonicalProjectPath = Self.canonicalPath(projectPath)
        let descriptor = try await client.createWorktree(
            projectPath: canonicalProjectPath,
            name: name,
            branch: branch,
            baseBranch: baseBranch,
            action: action
        )
        let worktreePath = Self.canonicalPath(descriptor.path)

        // Best-effort workspace registration so terminals & jobs can target this worktree immediately.
        let selectedWorkspace = try? await client.selectWorkspace(path: worktreePath)
        if let workspaceID = selectedWorkspace?.id.trimmedNonEmpty {
            knownWorkspaceIDsByPath[worktreePath] = workspaceID
        }

        // Best-effort initial git status warm-up.
        let initialStatus = try? await client.fetchRepoGitStatus(path: worktreePath, budget: .statusRead)
        if let initialStatus {
            gitStatusByPath[worktreePath] = initialStatus
        }

        let existingProject = projects.first(where: { $0.rootPath == canonicalProjectPath })
        let projectName = existingProject?.name ?? Self.lastPathComponent(canonicalProjectPath)

        let record = RelayWorkspaceRecord(
            workspaceID: selectedWorkspace?.id ?? knownWorkspaceIDsByPath[worktreePath],
            projectPath: canonicalProjectPath,
            projectName: projectName,
            path: worktreePath,
            name: descriptor.name.trimmedNonEmpty ?? descriptor.branch ?? Self.lastPathComponent(worktreePath),
            branch: initialStatus?.branch ?? descriptor.branch,
            isWorktree: !descriptor.isMain,
            isManagedWorktree: descriptor.isManaged,
            dirty: initialStatus?.dirty ?? descriptor.dirty,
            added: initialStatus?.added ?? descriptor.added,
            deleted: initialStatus?.deleted ?? descriptor.deleted,
            pr: initialStatus?.pr,
            threads: []
        )

        if let projectIndex = projects.firstIndex(where: { $0.rootPath == canonicalProjectPath }) {
            var project = projects[projectIndex]
            if let existingIndex = project.workspaces.firstIndex(where: { $0.path == worktreePath }) {
                project.workspaces[existingIndex] = record
            } else {
                project.workspaces.append(record)
            }
            projects[projectIndex] = project
        } else {
            let mainRecord = RelayWorkspaceRecord(
                workspaceID: knownWorkspaceIDsByPath[canonicalProjectPath],
                projectPath: canonicalProjectPath,
                projectName: projectName,
                path: canonicalProjectPath,
                name: Self.lastPathComponent(canonicalProjectPath),
                branch: nil,
                isWorktree: false,
                isManagedWorktree: false
            )
            projects.append(
                RelayProjectRecord(
                    name: projectName,
                    rootPath: canonicalProjectPath,
                    workspaceID: knownWorkspaceIDsByPath[canonicalProjectPath],
                    workspaces: [mainRecord, record]
                )
            )
        }

        return record
    }

    func archiveWorktree(client: CodexClient, path: String, force: Bool = false) async throws {
        let canonical = Self.canonicalPath(path)
        try await client.removeWorktree(path: canonical, force: force)

        var fallbackSelection: String?
        for projectIndex in projects.indices {
            if let removedIndex = projects[projectIndex].workspaces.firstIndex(where: { $0.path == canonical }) {
                projects[projectIndex].workspaces.remove(at: removedIndex)
                fallbackSelection = projects[projectIndex].mainWorkspace?.path
            }
        }

        gitStatusByPath.removeValue(forKey: canonical)
        tabsByWorkspacePath.removeValue(forKey: canonical)
        activeTabIDByWorkspacePath.removeValue(forKey: canonical)
        knownWorkspaceIDsByPath.removeValue(forKey: canonical)

        if let selected = selectedWorkspacePath, Self.canonicalPath(selected) == canonical {
            selectedWorkspacePath = fallbackSelection
        }
    }

    /// Clears all machine-scoped workspace, cache, and tab state (e.g., when switching machines).
    func reset() {
        generation += 1
        projects = []
        gitStatusByPath = [:]
        tabsByWorkspacePath = [:]
        activeTabIDByWorkspacePath = [:]
        knownWorkspaceIDsByPath = [:]
        lastFeedItems = []
        selectedWorkspacePath = nil
        hasLoadedOnce = false
        lastRefreshedAt = nil
        lastError = nil
    }

    // MARK: - Internal Helpers

    private struct ProjectSeed {
        let rootPath: String
        var name: String
        var workspaceID: String?
        var isDefault: Bool
        var hasGitHint: Bool
    }

    private func applyGitStatusToProjects(_ status: RelayGitStatusResponse, forCanonicalPath key: String) {
        var didChange = false
        var updatedProjects = projects
        for pIndex in updatedProjects.indices {
            for wIndex in updatedProjects[pIndex].workspaces.indices
                where updatedProjects[pIndex].workspaces[wIndex].path == key {
                var ws = updatedProjects[pIndex].workspaces[wIndex]
                ws.branch = status.branch ?? ws.branch
                ws.dirty = status.dirty
                ws.added = status.added
                ws.deleted = status.deleted
                ws.pr = status.pr
                if !ws.isWorktree, let branch = status.branch?.trimmedNonEmpty {
                    ws.name = branch
                }
                if updatedProjects[pIndex].workspaces[wIndex] != ws {
                    updatedProjects[pIndex].workspaces[wIndex] = ws
                    didChange = true
                }
            }
        }
        if didChange {
            projects = updatedProjects
        }
    }

    private func reconcileTabStates(with feedItems: [CodexThreadFeedItem]) {
        guard !tabsByWorkspacePath.isEmpty else { return }
        var itemsBySessionID: [String: CodexThreadFeedItem] = [:]
        for item in feedItems {
            if let sessionID = item.sessionID?.trimmedNonEmpty {
                itemsBySessionID[sessionID] = item
            }
        }

        var updatedMap = tabsByWorkspacePath
        var didChange = false
        for (workspacePath, workspaceTabs) in updatedMap {
            var nextTabs = workspaceTabs
            for index in nextTabs.indices {
                guard let threadID = nextTabs[index].kind.threadID,
                      let matched = itemsBySessionID[threadID] else {
                    continue
                }
                let running = matched.isActive
                let needsInput = matched.status == .waitingForApproval
                if nextTabs[index].isRunning != running || nextTabs[index].needsInput != needsInput {
                    nextTabs[index].isRunning = running
                    nextTabs[index].needsInput = needsInput
                    didChange = true
                }
            }
            updatedMap[workspacePath] = nextTabs
        }
        if didChange {
            tabsByWorkspacePath = updatedMap
        }
    }

    private static func attachThreads(
        _ feedItems: [CodexThreadFeedItem],
        to projects: [RelayProjectRecord]
    ) -> [RelayProjectRecord] {
        // Index all workspace paths (longest first so worktree paths beat parent repo paths)
        // and workspace IDs for threads whose payload omits `cwd`.
        var workspacePaths: [String] = []
        var workspacePathByID: [String: String] = [:]

        for project in projects {
            for workspace in project.workspaces {
                workspacePaths.append(workspace.path)
                if let workspaceID = workspace.workspaceID?.trimmedNonEmpty {
                    workspacePathByID[workspaceID] = workspace.path
                }
            }
        }
        workspacePaths.sort { $0.count > $1.count }

        var threadsByWorkspacePath: [String: [CodexThreadFeedItem]] = [:]

        for item in feedItems {
            var matchedPath: String?

            if let rawFolder = item.folderPath?.trimmedNonEmpty {
                let canonicalFolder = canonicalPath(rawFolder)
                if let exact = workspacePaths.first(where: { $0 == canonicalFolder }) {
                    matchedPath = exact
                } else if let nested = workspacePaths.first(where: { canonicalFolder.hasPrefix("\($0)/") }) {
                    matchedPath = nested
                }
            }

            if matchedPath == nil, let workspaceID = item.workspaceID?.trimmedNonEmpty {
                matchedPath = workspacePathByID[workspaceID]
            }

            if let matchedPath {
                threadsByWorkspacePath[matchedPath, default: []].append(item)
            }
        }

        return projects.map { project in
            var updatedProject = project
            updatedProject.workspaces = project.workspaces.map { workspace in
                var updatedWorkspace = workspace
                let sortedThreads = (threadsByWorkspacePath[workspace.path] ?? []).sorted { lhs, rhs in
                    if lhs.isActive != rhs.isActive { return lhs.isActive && !rhs.isActive }
                    return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
                }
                updatedWorkspace.threads = sortedThreads
                return updatedWorkspace
            }
            // Main checkout first, then worktrees ordered by live activity, recency, and name.
            updatedProject.workspaces.sort { lhs, rhs in
                if lhs.isWorktree != rhs.isWorktree { return !lhs.isWorktree && rhs.isWorktree }
                if lhs.hasRunningThread != rhs.hasRunningThread { return lhs.hasRunningThread && !rhs.hasRunningThread }
                if lhs.dirty != rhs.dirty { return lhs.dirty && !rhs.dirty }
                let lhsDate = lhs.mostRecentActivity ?? .distantPast
                let rhsDate = rhs.mostRecentActivity ?? .distantPast
                if lhsDate != rhsDate { return lhsDate > rhsDate }
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return updatedProject
        }
    }

    private static func sortProjects(
        _ projects: [RelayProjectRecord],
        defaultPaths: Set<String>
    ) -> [RelayProjectRecord] {
        projects.sorted { lhs, rhs in
            if lhs.hasRunningActivity != rhs.hasRunningActivity {
                return lhs.hasRunningActivity && !rhs.hasRunningActivity
            }
            let lhsDefault = defaultPaths.contains(lhs.rootPath)
            let rhsDefault = defaultPaths.contains(rhs.rootPath)
            if lhsDefault != rhsDefault {
                return lhsDefault && !rhsDefault
            }
            let lhsHasWorktrees = !lhs.worktrees.isEmpty
            let rhsHasWorktrees = !rhs.worktrees.isEmpty
            if lhsHasWorktrees != rhsHasWorktrees {
                return lhsHasWorktrees && !rhsHasWorktrees
            }
            let lhsDate = lhs.mostRecentActivity ?? .distantPast
            let rhsDate = rhs.mostRecentActivity ?? .distantPast
            if lhsDate != rhsDate {
                return lhsDate > rhsDate
            }
            return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
        }
    }

    private static func isManagedWorktreeSubpath(_ path: String) -> Bool {
        path.contains("/.relay/worktrees/")
    }

    private static func lastPathComponent(_ path: String) -> String {
        let component = URL(fileURLWithPath: path).lastPathComponent
        return component.isEmpty || component == "/" ? path : component
    }

    private func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }
}
