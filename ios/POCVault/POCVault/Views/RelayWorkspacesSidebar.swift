import SwiftUI

// MARK: - Sidebar View Models

struct RelaySidebarWorkspaceItem: Identifiable, Hashable {
    let id: String
    let workspaceID: String?
    let path: String?
    let title: String
    let branch: String?
    let isWorktree: Bool
    let isDirty: Bool
    let status: RelayStatusBucket
    let prNumber: Int?
    let prState: String?
    let added: Int
    let deleted: Int
    let activeSessionCount: Int
    let recentThread: CodexThreadFeedItem?

    init(
        id: String,
        workspaceID: String? = nil,
        path: String? = nil,
        title: String,
        branch: String? = nil,
        isWorktree: Bool = false,
        isDirty: Bool = false,
        status: RelayStatusBucket = .idle,
        prNumber: Int? = nil,
        prState: String? = nil,
        added: Int = 0,
        deleted: Int = 0,
        activeSessionCount: Int = 0,
        recentThread: CodexThreadFeedItem? = nil
    ) {
        self.id = id
        self.workspaceID = workspaceID
        self.path = path
        self.title = title
        self.branch = branch
        self.isWorktree = isWorktree
        self.isDirty = isDirty
        self.status = status
        self.prNumber = prNumber
        self.prState = prState
        self.added = added
        self.deleted = deleted
        self.activeSessionCount = activeSessionCount
        self.recentThread = recentThread
    }

    var displayTitle: String {
        if let branch = branch?.trimmedNonEmpty {
            return branch
        }
        return title
    }

    var hasDiffStat: Bool {
        added > 0 || deleted > 0
    }

    var formattedPRState: String? {
        guard let raw = prState?.trimmedNonEmpty else { return nil }
        switch raw.lowercased() {
        case "open": return "Open"
        case "merged": return "Merged"
        case "closed": return "Closed"
        case "draft": return "Draft"
        default: return raw.capitalized
        }
    }

    var prDisplayLabel: String? {
        guard let prNumber else { return nil }
        if let state = formattedPRState {
            return "#\(prNumber) · \(state)"
        }
        return "#\(prNumber)"
    }

    static func fromWorktree(
        _ worktree: RelayWorktreeDescriptor,
        workspaceID: String? = nil,
        status: RelayStatusBucket = .idle,
        pr: RelayGitPRInfo? = nil,
        activeSessionCount: Int = 0,
        recentThread: CodexThreadFeedItem? = nil
    ) -> RelaySidebarWorkspaceItem {
        RelaySidebarWorkspaceItem(
            id: worktree.path,
            workspaceID: workspaceID,
            path: worktree.path,
            title: worktree.branch ?? worktree.name,
            branch: worktree.branch,
            isWorktree: !worktree.isMain,
            isDirty: worktree.dirty,
            status: status,
            prNumber: pr?.number,
            prState: pr?.state,
            added: worktree.added,
            deleted: worktree.deleted,
            activeSessionCount: activeSessionCount,
            recentThread: recentThread
        )
    }

    static func from(_ record: RelayWorkspaceRecord) -> RelaySidebarWorkspaceItem {
        let bucket: RelayStatusBucket
        if record.needsInput {
            bucket = .needsInput
        } else if record.hasRunningThread {
            bucket = .running
        } else if let firstStatus = record.threads.first?.status {
            switch firstStatus {
            case .failed, .timeout: bucket = .error
            case .succeeded: bucket = .done
            default: bucket = .idle
            }
        } else {
            bucket = .idle
        }

        return RelaySidebarWorkspaceItem(
            id: record.id,
            workspaceID: record.workspaceID,
            path: record.path,
            title: record.name,
            branch: record.branch,
            isWorktree: record.isWorktree,
            isDirty: record.dirty,
            status: bucket,
            prNumber: record.pr?.number,
            prState: record.pr?.state,
            added: record.added,
            deleted: record.deleted,
            activeSessionCount: record.threads.filter(\.isActive).count,
            recentThread: record.threads.first
        )
    }
}

struct RelaySidebarProjectGroup: Identifiable, Hashable {
    let id: String
    let name: String
    let rootPath: String?
    let colorIndex: Int?
    let workspaces: [RelaySidebarWorkspaceItem]

    init(
        id: String,
        name: String,
        rootPath: String? = nil,
        colorIndex: Int? = nil,
        workspaces: [RelaySidebarWorkspaceItem]
    ) {
        self.id = id
        self.name = name
        self.rootPath = rootPath
        self.colorIndex = colorIndex
        self.workspaces = workspaces
    }

    static func from(_ project: RelayProjectRecord) -> RelaySidebarProjectGroup {
        RelaySidebarProjectGroup(
            id: project.id,
            name: project.name,
            rootPath: project.rootPath,
            colorIndex: nil,
            workspaces: project.workspaces.map(RelaySidebarWorkspaceItem.from)
        )
    }

    /// Derives Projects -> Workspaces directly from `StatusFeedViewModel.feedItems` so the
    /// sidebar always shows real live data even before worktrees are fetched or configured.
    static func fallbackProjects(
        from feedItems: [CodexThreadFeedItem],
        approvals: [CodexApproval] = []
    ) -> [RelaySidebarProjectGroup] {
        guard !feedItems.isEmpty else { return [] }

        let approvalJobIDs = Set(approvals.map(\.jobId))
        var groupedOrder: [String] = []
        var groupedItems: [String: [CodexThreadFeedItem]] = [:]

        for item in feedItems {
            let groupKey = item.workspaceID?.trimmedNonEmpty
                ?? item.folderPath?.trimmedNonEmpty
                ?? item.workspaceLabel
            if groupedItems[groupKey] == nil {
                groupedOrder.append(groupKey)
            }
            groupedItems[groupKey, default: []].append(item)
        }

        return groupedOrder.compactMap { key in
            guard let items = groupedItems[key], let latest = items.first else { return nil }
            let projectName = latest.workspaceLabel.trimmedNonEmpty ?? key
            let rootPath = latest.folderPath

            // Group distinct folders inside the same workspace if worktree paths are present.
            var folderOrder: [String] = []
            var byFolder: [String: [CodexThreadFeedItem]] = [:]
            for item in items {
                let folderKey = item.folderPath ?? key
                if byFolder[folderKey] == nil {
                    folderOrder.append(folderKey)
                }
                byFolder[folderKey, default: []].append(item)
            }

            let workspaces: [RelaySidebarWorkspaceItem] = folderOrder.compactMap { folderKey in
                guard let folderItems = byFolder[folderKey], let topItem = folderItems.first else {
                    return nil
                }
                let activeCount = folderItems.filter(\.isActive).count
                let bucket = dominantStatus(for: folderItems, approvalJobIDs: approvalJobIDs)
                let folderPath = topItem.folderPath
                let isWorktree = folderOrder.count > 1 && folderKey != rootPath
                let title: String
                if isWorktree, let folderPath {
                    title = URL(fileURLWithPath: folderPath).lastPathComponent
                } else {
                    title = "main"
                }

                return RelaySidebarWorkspaceItem(
                    id: "\(key)::\(folderKey)",
                    workspaceID: topItem.workspaceID,
                    path: folderPath,
                    title: title,
                    branch: nil,
                    isWorktree: isWorktree,
                    isDirty: false,
                    status: bucket,
                    prNumber: nil,
                    prState: nil,
                    added: 0,
                    deleted: 0,
                    activeSessionCount: activeCount,
                    recentThread: topItem
                )
            }

            return RelaySidebarProjectGroup(
                id: key,
                name: projectName,
                rootPath: rootPath,
                colorIndex: nil,
                workspaces: workspaces
            )
        }
    }

    private static func dominantStatus(
        for items: [CodexThreadFeedItem],
        approvalJobIDs: Set<String>
    ) -> RelayStatusBucket {
        if items.contains(where: { item in
            item.status == .waitingForApproval
                || (item.jobID.map { approvalJobIDs.contains($0) } ?? false)
        }) {
            return .needsInput
        }
        if items.contains(where: \.isActive) {
            return .running
        }
        if let first = items.first {
            switch first.status {
            case .failed, .timeout:
                return .error
            case .succeeded:
                return .done
            default:
                return .idle
            }
        }
        return .idle
    }
}

// MARK: - New Workspace Request

struct RelayNewWorkspaceRequest: Equatable, Hashable {
    enum Isolation: String, CaseIterable, Identifiable {
        case projectDirectory
        case newGitWorktree

        var id: String { rawValue }

        var title: String {
            switch self {
            case .projectDirectory: return "Project directory"
            case .newGitWorktree: return "New git worktree"
            }
        }

        var subtitle: String {
            switch self {
            case .projectDirectory: return "Work directly in the main project folder"
            case .newGitWorktree: return "Create an isolated branch and directory"
            }
        }
    }

    enum LaunchMode: String, CaseIterable, Identifiable {
        case agent
        case terminal

        var id: String { rawValue }

        var title: String {
            switch self {
            case .agent: return "Agent"
            case .terminal: return "Terminal"
            }
        }

        var systemImage: String {
            switch self {
            case .agent: return "bubble.left.and.bubble.right"
            case .terminal: return "terminal"
            }
        }
    }

    let projectID: String?
    let projectName: String
    let projectRootPath: String?
    let isolation: Isolation
    let branchName: String?
    let baseBranch: String?
    let launchMode: LaunchMode
}

// MARK: - Workspaces Sidebar

/// Paseo-inspired Projects -> Workspaces left sidebar (`surfaceSidebar`, calm precision).
/// Renders grouped projects and worktrees with fixed-rail live status indicators, PR badges,
/// diff stats, row overflow menus, searchable sessions, and a fixed multi-host footer.
struct RelayWorkspacesSidebar: View {
    @ObservedObject var feed: StatusFeedViewModel
    @ObservedObject var nodeStore: RelayNodeStore
    var identityStore: ClientIdentityStore?
    var powerModel: RelayMachinePowerModel?
    var projects: [RelaySidebarProjectGroup]
    var selectedWorkspaceID: String?
    var selectedWorkspacePath: String?
    var selectedThreadID: String?
    var pendingHandoffCount: Int

    let onSelectWorkspace: (RelaySidebarWorkspaceItem) -> Void
    let onSelectThread: (CodexThreadFeedItem) -> Void
    var onNewAgent: ((RelaySidebarWorkspaceItem) -> Void)?
    var onOpenTerminal: ((RelaySidebarWorkspaceItem) -> Void)?
    var onViewChanges: ((RelaySidebarWorkspaceItem) -> Void)?
    var onArchiveWorkspace: ((RelaySidebarWorkspaceItem) -> Void)?
    var onCreateWorkspace: ((RelayNewWorkspaceRequest) -> Void)?
    var onNewChat: (() -> Void)?
    var onOpenSessions: (() -> Void)?
    var onBrowseFolders: (() -> Void)?
    var onOpenHandoffs: (() -> Void)?
    var onSelectHost: ((RelayPairedNode) -> Void)?
    var onAddHost: (() -> Void)?
    let onOpenSettings: () -> Void

    @Environment(\.relayTheme) private var theme

    @State private var isSearchVisible = false
    @State private var showingInlineSessions = false
    @State private var searchText = ""
    @State private var showingHostSwitcher = false
    @State private var showingNewWorkspaceSheet = false
    @State private var newWorkspacePreselectedProject: RelaySidebarProjectGroup?
    @State private var newWorkspaceInitialIsolation: RelayNewWorkspaceRequest.Isolation = .newGitWorktree
    @State private var workspacePendingArchive: RelaySidebarWorkspaceItem?

    init(
        feed: StatusFeedViewModel,
        nodeStore: RelayNodeStore,
        identityStore: ClientIdentityStore? = nil,
        powerModel: RelayMachinePowerModel? = nil,
        projects: [RelaySidebarProjectGroup] = [],
        selectedWorkspaceID: String? = nil,
        selectedWorkspacePath: String? = nil,
        selectedThreadID: String? = nil,
        pendingHandoffCount: Int = 0,
        onSelectWorkspace: @escaping (RelaySidebarWorkspaceItem) -> Void,
        onSelectThread: @escaping (CodexThreadFeedItem) -> Void,
        onNewAgent: ((RelaySidebarWorkspaceItem) -> Void)? = nil,
        onOpenTerminal: ((RelaySidebarWorkspaceItem) -> Void)? = nil,
        onViewChanges: ((RelaySidebarWorkspaceItem) -> Void)? = nil,
        onArchiveWorkspace: ((RelaySidebarWorkspaceItem) -> Void)? = nil,
        onCreateWorkspace: ((RelayNewWorkspaceRequest) -> Void)? = nil,
        onNewChat: (() -> Void)? = nil,
        onOpenSessions: (() -> Void)? = nil,
        onBrowseFolders: (() -> Void)? = nil,
        onOpenHandoffs: (() -> Void)? = nil,
        onSelectHost: ((RelayPairedNode) -> Void)? = nil,
        onAddHost: (() -> Void)? = nil,
        onOpenSettings: @escaping () -> Void
    ) {
        self.feed = feed
        self.nodeStore = nodeStore
        self.identityStore = identityStore
        self.powerModel = powerModel
        self.projects = projects
        self.selectedWorkspaceID = selectedWorkspaceID
        self.selectedWorkspacePath = selectedWorkspacePath
        self.selectedThreadID = selectedThreadID
        self.pendingHandoffCount = pendingHandoffCount
        self.onSelectWorkspace = onSelectWorkspace
        self.onSelectThread = onSelectThread
        self.onNewAgent = onNewAgent
        self.onOpenTerminal = onOpenTerminal
        self.onViewChanges = onViewChanges
        self.onArchiveWorkspace = onArchiveWorkspace
        self.onCreateWorkspace = onCreateWorkspace
        self.onNewChat = onNewChat
        self.onOpenSessions = onOpenSessions
        self.onBrowseFolders = onBrowseFolders
        self.onOpenHandoffs = onOpenHandoffs
        self.onSelectHost = onSelectHost
        self.onAddHost = onAddHost
        self.onOpenSettings = onOpenSettings
    }

    private var effectiveProjects: [RelaySidebarProjectGroup] {
        if !projects.isEmpty {
            return projects
        }
        return RelaySidebarProjectGroup.fallbackProjects(
            from: feed.feedItems,
            approvals: feed.approvals
        )
    }

    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var isFiltering: Bool {
        !trimmedQuery.isEmpty
    }

    private var filteredProjects: [RelaySidebarProjectGroup] {
        guard isFiltering else { return effectiveProjects }
        return effectiveProjects.compactMap { project in
            if project.name.localizedCaseInsensitiveContains(trimmedQuery) {
                return project
            }
            let matchingWorkspaces = project.workspaces.filter { workspace in
                workspace.displayTitle.localizedCaseInsensitiveContains(trimmedQuery)
                    || workspace.title.localizedCaseInsensitiveContains(trimmedQuery)
                    || (workspace.recentThread?.title.localizedCaseInsensitiveContains(trimmedQuery) ?? false)
            }
            guard !matchingWorkspaces.isEmpty else { return nil }
            return RelaySidebarProjectGroup(
                id: project.id,
                name: project.name,
                rootPath: project.rootPath,
                colorIndex: project.colorIndex,
                workspaces: matchingWorkspaces
            )
        }
    }

    private var filteredSessions: [CodexThreadFeedItem] {
        guard isFiltering else { return feed.feedItems }
        return feed.feedItems.filter { item in
            item.title.localizedCaseInsensitiveContains(trimmedQuery)
                || item.workspaceLabel.localizedCaseInsensitiveContains(trimmedQuery)
                || item.preview.localizedCaseInsensitiveContains(trimmedQuery)
        }
    }

    private var activeSessionTotal: Int {
        feed.feedItems.filter(\.isActive).count
    }

    private var activeHostName: String {
        if let name = nodeStore.pairedNode?.nodeName.trimmedNonEmpty {
            return name
        }
        if AppConfiguration.hasConfiguredPersonalInstall {
            return AppConfiguration.codexBaseURL.host ?? "Linked machine"
        }
        return "No host"
    }

    private var activeHostStatusBucket: RelayStatusBucket {
        guard nodeStore.hasMachine else { return .idle }
        guard let powerModel else { return .done }
        switch powerModel.status {
        case .on, .unknown, .unavailable:
            return .done
        case .starting, .stopping, .loading:
            return .needsInput
        case .off:
            return .error
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            headerSection

            Rectangle()
                .fill(theme.border)
                .frame(height: 1)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if showingInlineSessions || isFiltering {
                        sessionsSearchContent
                    } else {
                        projectsContent
                    }

                    if feed.isListStale {
                        Text("Showing saved sessions")
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .padding(.horizontal, 14)
                            .padding(.top, 4)
                    }
                }
                .padding(.horizontal, 8)
                .padding(.top, 12)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)

            footerSection
        }
        .background(theme.surfaceSidebar.ignoresSafeArea(edges: .vertical))
        .accessibilityIdentifier("relay-workspaces-sidebar")
        .sheet(isPresented: $showingHostSwitcher) {
            RelayHostSwitcherSheet(
                nodeStore: nodeStore,
                identityStore: identityStore,
                powerModel: powerModel,
                onSelectHost: { host in
                    showingHostSwitcher = false
                    onSelectHost?(host)
                },
                onAddHost: {
                    showingHostSwitcher = false
                    onAddHost?()
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingNewWorkspaceSheet) {
            RelayNewWorkspaceSheet(
                projects: effectiveProjects,
                preselectedProject: newWorkspacePreselectedProject,
                initialIsolation: newWorkspaceInitialIsolation,
                onSubmit: { request in
                    showingNewWorkspaceSheet = false
                    if let onCreateWorkspace {
                        onCreateWorkspace(request)
                    } else {
                        onNewChat?()
                    }
                }
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .confirmationDialog(
            "Archive \(workspacePendingArchive?.displayTitle ?? "workspace")?",
            isPresented: Binding(
                get: { workspacePendingArchive != nil },
                set: { if !$0 { workspacePendingArchive = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let target = workspacePendingArchive {
                Button("Archive workspace", role: .destructive) {
                    workspacePendingArchive = nil
                    onArchiveWorkspace?(target)
                }
            }
            Button("Cancel", role: .cancel) {
                workspacePendingArchive = nil
            }
        } message: {
            Text("This workspace has uncommitted changes. Archiving removes the worktree directory from disk.")
        }
    }

    // MARK: - Header Actions

    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Button {
                    if let onOpenSessions {
                        onOpenSessions()
                    } else {
                        withAnimation(.easeOut(duration: 0.16)) {
                            showingInlineSessions.toggle()
                            if showingInlineSessions {
                                isSearchVisible = true
                            } else if trimmedQuery.isEmpty {
                                isSearchVisible = false
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "bubble.left.and.bubble.right")
                            .font(.system(size: 15, weight: .regular))
                            .foregroundStyle(showingInlineSessions ? theme.foreground : theme.foregroundMuted)
                            .frame(width: 20, alignment: .center)

                        Text("Sessions")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(showingInlineSessions ? theme.foreground : theme.foregroundMuted)
                            .lineLimit(1)

                        if activeSessionTotal > 0 {
                            RelayStatusBadge(
                                "\(activeSessionTotal)",
                                bucket: .running,
                                showsDot: true,
                                compact: true
                            )
                        }

                        Spacer(minLength: 4)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 40)
                    .background(
                        showingInlineSessions ? theme.surfaceSidebarSelected : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8, style: .continuous)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(RelaySidebarPressStyle(highlight: theme.surfaceSidebarHover))
                .accessibilityIdentifier("relay-sidebar-sessions")

                RelayToolbarIconButton(
                    systemImage: isSearchVisible ? "xmark" : "magnifyingglass",
                    accessibilityLabel: isSearchVisible ? "Close search" : "Search sessions and workspaces",
                    iconSize: 15,
                    isSelected: isSearchVisible && !showingInlineSessions,
                    isMuted: true
                ) {
                    withAnimation(.easeOut(duration: 0.16)) {
                        if isSearchVisible {
                            searchText = ""
                            isSearchVisible = false
                            showingInlineSessions = false
                        } else {
                            isSearchVisible = true
                        }
                    }
                }
            }

            if let onBrowseFolders {
                Button(action: onBrowseFolders) {
                    HStack(spacing: 10) {
                        Image(systemName: "folder")
                            .font(.system(size: 15, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(width: 20, alignment: .center)

                        Text("Browse folders")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineLimit(1)

                        Spacer(minLength: 4)
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 38)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RelaySidebarPressStyle(highlight: theme.surfaceSidebarHover))
                .accessibilityIdentifier("relay-sidebar-browse-folders")
            }

            if isSearchVisible {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)

                    TextField(
                        "Search workspaces & sessions",
                        text: $searchText,
                        prompt: Text("Search workspaces & sessions")
                            .foregroundStyle(theme.foregroundMuted)
                    )
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foreground)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("relay-sidebar-search")

                    if !searchText.isEmpty {
                        Button {
                            searchText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 14))
                                .foregroundStyle(theme.foregroundExtraMuted)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Clear search")
                    }
                }
                .padding(.horizontal, 10)
                .frame(height: 36)
                .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(theme.border, lineWidth: 1)
                }
                .padding(.horizontal, 4)
                .transition(.opacity.combined(with: .move(edge: .top)))
            }

            if pendingHandoffCount > 0, let onOpenHandoffs {
                Button(action: onOpenHandoffs) {
                    HStack(spacing: 10) {
                        Image(systemName: "laptopcomputer.and.iphone")
                            .font(.system(size: 14, weight: .regular))
                            .foregroundStyle(theme.accentBright)
                            .frame(width: 20, alignment: .center)

                        Text("Handoffs")
                            .font(RelayTheme.uiFont(14, weight: .regular))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)

                        Spacer(minLength: 4)

                        RelayStatusBadge(
                            "\(pendingHandoffCount)",
                            bucket: .needsInput,
                            showsDot: true,
                            compact: true
                        )
                    }
                    .padding(.horizontal, 10)
                    .frame(minHeight: 36)
                    .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(RelaySidebarPressStyle(highlight: theme.surfaceSidebarHover))
                .padding(.horizontal, 4)
                .accessibilityIdentifier("relay-sidebar-handoffs")
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    // MARK: - Projects -> Workspaces Tree

    @ViewBuilder
    private var projectsContent: some View {
        if effectiveProjects.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("No workspaces yet")
                    .font(RelayTheme.uiFont(14, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Text("Start an agent or open a project folder to see workspaces here.")
                    .font(RelayTheme.uiFont(13, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .fixedSize(horizontal: false, vertical: true)
                RelayButton("New workspace", variant: .secondary, size: .sm, systemImage: "plus") {
                    presentNewWorkspace(for: nil, isolation: .projectDirectory)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            }
            .padding(.horizontal, 6)
            .padding(.top, 8)
        } else {
            ForEach(effectiveProjects) { project in
                projectSection(project)
            }
        }
    }

    private func projectSection(_ project: RelaySidebarProjectGroup) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            // Project header row
            HStack(spacing: 10) {
                RelayProjectIcon(
                    name: project.name,
                    seed: project.rootPath ?? project.name,
                    colorIndex: project.colorIndex,
                    size: 20
                )

                Text(project.name)
                    .font(RelayTheme.uiFont(15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 4)

                Button {
                    presentNewWorkspace(for: project, isolation: .newGitWorktree)
                } label: {
                    Image(systemName: "folder.badge.plus")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .contentShape(Rectangle())
                }
                .buttonStyle(RelaySidebarIconPressStyle(highlight: theme.interactionHighlight))
                .accessibilityLabel("New workspace in \(project.name)")
            }
            .padding(.leading, 8)
            .padding(.trailing, 2)
            .frame(minHeight: 34)

            // Workspace child rows
            VStack(alignment: .leading, spacing: 2) {
                ForEach(project.workspaces) { workspace in
                    workspaceRow(workspace, in: project)
                }
            }
        }
    }

    private func workspaceRow(
        _ workspace: RelaySidebarWorkspaceItem,
        in project: RelaySidebarProjectGroup
    ) -> some View {
        let selected = isWorkspaceSelected(workspace)

        return HStack(alignment: .center, spacing: 4) {
            Button {
                onSelectWorkspace(workspace)
            } label: {
                HStack(alignment: .top, spacing: 10) {
                    // Fixed 18pt leading status rail — prevents any horizontal shift across states.
                    workspaceLeadingIndicator(workspace, isSelected: selected)
                        .frame(width: 18, height: 18, alignment: .center)
                        .padding(.top, 1)

                    VStack(alignment: .leading, spacing: 3) {
                        Text(workspace.displayTitle)
                            .font(RelayTheme.uiFont(14.5, weight: .regular))
                            .foregroundStyle(selected ? theme.foreground : theme.foregroundMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if hasMetaLine(for: workspace) {
                            workspaceMetaLine(workspace)
                        }
                    }
                }
                .padding(.leading, 18)
                .padding(.trailing, 4)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            // Trailing vertical kebab menu
            Menu {
                Button {
                    if let onNewAgent {
                        onNewAgent(workspace)
                    } else {
                        onSelectWorkspace(workspace)
                    }
                } label: {
                    Label("New agent", systemImage: "bubble.left.and.bubble.right")
                }

                if let onOpenTerminal {
                    Button {
                        onOpenTerminal(workspace)
                    } label: {
                        Label("Open terminal", systemImage: "terminal")
                    }
                }

                Button {
                    presentNewWorkspace(for: project, isolation: .newGitWorktree)
                } label: {
                    Label("New worktree", systemImage: "arrow.triangle.branch")
                }

                if let onViewChanges {
                    Button {
                        onViewChanges(workspace)
                    } label: {
                        Label("View changes", systemImage: "plus.forwardslash.minus")
                    }
                }

                if onArchiveWorkspace != nil {
                    Divider()
                    Button(role: .destructive) {
                        handleArchiveRequest(workspace)
                    } label: {
                        Label("Archive workspace", systemImage: "archivebox")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .medium))
                    .rotationEffect(.degrees(90))
                    .foregroundStyle(theme.foregroundExtraMuted)
                    .frame(width: 30, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Actions for \(workspace.displayTitle)")
        }
        .background(
            selected ? theme.surfaceSidebarSelected : Color.clear,
            in: RoundedRectangle(cornerRadius: 8, style: .continuous)
        )
        .accessibilityIdentifier("relay-sidebar-workspace-\(workspace.id)")
    }

    @ViewBuilder
    private func workspaceLeadingIndicator(
        _ workspace: RelaySidebarWorkspaceItem,
        isSelected: Bool
    ) -> some View {
        switch workspace.status {
        case .running:
            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
        case .needsInput:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(theme.statusDotWarning)
        case .done:
            RelayStatusDot(bucket: .done, size: 7)
        case .error:
            RelayStatusDot(bucket: .error, size: 7)
        case .idle:
            Image(systemName: workspace.isWorktree ? "arrow.triangle.branch" : "desktopcomputer")
                .font(.system(size: 12, weight: .regular))
                .foregroundStyle(isSelected ? theme.foregroundMuted : theme.foregroundExtraMuted)
        }
    }

    private func hasMetaLine(for workspace: RelaySidebarWorkspaceItem) -> Bool {
        if workspace.status == .needsInput { return true }
        if workspace.prDisplayLabel != nil { return true }
        if workspace.hasDiffStat { return true }
        if workspace.activeSessionCount > 1 { return true }
        if let title = workspace.recentThread?.title.trimmedNonEmpty,
           title.caseInsensitiveCompare(workspace.displayTitle) != .orderedSame {
            return true
        }
        return false
    }

    @ViewBuilder
    private func workspaceMetaLine(_ workspace: RelaySidebarWorkspaceItem) -> some View {
        HStack(spacing: 7) {
            if workspace.status == .needsInput {
                Text("Approval needed")
                    .font(RelayTheme.uiFont(12, weight: .regular))
                    .foregroundStyle(theme.statusWarning)
                    .lineLimit(1)
            }

            if let prLabel = workspace.prDisplayLabel {
                HStack(spacing: 3) {
                    Image(systemName: prIconName(for: workspace.prState))
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(prColor(for: workspace.prState))
                    Text(prLabel)
                        .font(RelayTheme.uiFont(12, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineLimit(1)
                }
                .fixedSize()
            }

            if workspace.hasDiffStat {
                RelayDiffStatView(additions: workspace.added, deletions: workspace.deleted)
            }

            if workspace.status != .needsInput,
               workspace.prDisplayLabel == nil,
               !workspace.hasDiffStat {
                if let previewTitle = workspace.recentThread?.title.trimmedNonEmpty,
                   previewTitle.caseInsensitiveCompare(workspace.displayTitle) != .orderedSame {
                    Text(previewTitle)
                        .font(RelayTheme.uiFont(12, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                } else if workspace.activeSessionCount > 1 {
                    Text("\(workspace.activeSessionCount) active")
                        .font(RelayTheme.uiFont(12, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineLimit(1)
                }
            }
        }
    }

    private func prIconName(for state: String?) -> String {
        switch state?.lowercased() {
        case "merged": return "arrow.triangle.merge"
        default: return "arrow.triangle.pull"
        }
    }

    private func prColor(for state: String?) -> Color {
        switch state?.lowercased() {
        case "open": return theme.statusSuccess
        case "merged": return theme.statusMerged
        case "closed": return theme.statusDanger
        default: return theme.foregroundMuted
        }
    }

    private func isWorkspaceSelected(_ workspace: RelaySidebarWorkspaceItem) -> Bool {
        if let selectedPath = selectedWorkspacePath?.trimmedNonEmpty,
           let itemPath = workspace.path?.trimmedNonEmpty {
            return selectedPath == itemPath
        }
        if let selectedWorkspaceID = selectedWorkspaceID?.trimmedNonEmpty {
            if let itemWorkspaceID = workspace.workspaceID?.trimmedNonEmpty,
               itemWorkspaceID == selectedWorkspaceID {
                return true
            }
            if workspace.id == selectedWorkspaceID {
                return true
            }
        }
        if let selectedThreadID = selectedThreadID?.trimmedNonEmpty,
           workspace.recentThread?.id == selectedThreadID {
            return true
        }
        return false
    }

    // MARK: - Search & All Sessions Inline Content

    @ViewBuilder
    private var sessionsSearchContent: some View {
        if isFiltering && !filteredProjects.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text("Workspaces")
                    .font(RelayTheme.uiFont(12, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                    .padding(.horizontal, 10)

                ForEach(filteredProjects) { project in
                    projectSection(project)
                }
            }
        }

        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(isFiltering ? "Matching sessions" : "All sessions")
                    .font(RelayTheme.uiFont(12, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                Spacer()
                if showingInlineSessions && !isFiltering {
                    Button("Workspaces") {
                        withAnimation(.easeOut(duration: 0.16)) {
                            showingInlineSessions = false
                            isSearchVisible = false
                        }
                    }
                    .font(RelayTheme.uiFont(12, weight: .medium))
                    .foregroundStyle(theme.accentBright)
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, isFiltering && !filteredProjects.isEmpty ? 6 : 0)

            if filteredSessions.isEmpty {
                Text(isFiltering ? "No matching sessions" : "No sessions yet")
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 16)
            } else {
                ForEach(filteredSessions) { item in
                    sessionRow(item)
                }
            }
        }
    }

    private func sessionRow(_ item: CodexThreadFeedItem) -> some View {
        let isSelected = selectedThreadID == item.id
        let bucket = statusBucket(for: item)

        return Button {
            onSelectThread(item)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Group {
                    if bucket == .running {
                        RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                    } else if bucket == .needsInput {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(theme.statusDotWarning)
                    } else {
                        RelayProviderMark(provider: provider(for: item), size: 14)
                    }
                }
                .frame(width: 18, height: 18, alignment: .center)
                .padding(.top, 2)

                VStack(alignment: .leading, spacing: 3) {
                    Text(item.title)
                        .font(RelayTheme.uiFont(14.5, weight: .regular))
                        .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 6) {
                        Text(item.workspaceLabel)
                            .lineLimit(1)
                        if item.status == .waitingForApproval {
                            Text("· Approval needed")
                                .foregroundStyle(theme.statusWarning)
                        } else if item.isActive {
                            Text("· Running")
                                .foregroundStyle(theme.statusDotRunning)
                        } else if item.status == .failed || item.status == .timeout {
                            Text("· \(item.status?.label ?? "Failed")")
                                .foregroundStyle(theme.statusDanger)
                        }
                    }
                    .font(RelayTheme.uiFont(12, weight: .regular))
                    .foregroundStyle(theme.foregroundExtraMuted)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .background(
                isSelected ? theme.surfaceSidebarSelected : Color.clear,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(RelaySidebarPressStyle(highlight: theme.surfaceSidebarHover))
        .accessibilityIdentifier("relay-recent-chat-\(item.id)")
    }

    private func provider(for item: CodexThreadFeedItem) -> CodexProvider {
        switch item.source {
        case .thread(let thread): return thread.provider
        case .pendingJob(let job): return job.provider
        }
    }

    private func statusBucket(for item: CodexThreadFeedItem) -> RelayStatusBucket {
        if item.status == .waitingForApproval { return .needsInput }
        if item.isActive { return .running }
        if item.status == .failed || item.status == .timeout { return .error }
        if item.status == .succeeded { return .done }
        return .idle
    }

    // MARK: - Fixed Footer

    private var footerSection: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.border)
                .frame(height: 1)

            HStack(spacing: 4) {
                Button {
                    showingHostSwitcher = true
                } label: {
                    HStack(spacing: 8) {
                        RelayStatusDot(bucket: activeHostStatusBucket, size: 7)

                        Text(activeHostName)
                            .font(RelayTheme.uiFont(14, weight: .regular))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(RelaySidebarPressStyle(highlight: theme.interactionHighlight))
                .accessibilityLabel("Active host: \(activeHostName)")
                .accessibilityHint("Switch paired machine")
                .accessibilityIdentifier("relay-sidebar-host-pill")

                Spacer(minLength: 4)

                RelayToolbarIconButton(
                    systemImage: "plus",
                    accessibilityLabel: "New workspace",
                    iconSize: 17,
                    weight: .regular,
                    isMuted: true
                ) {
                    if effectiveProjects.isEmpty, let onNewChat, onCreateWorkspace == nil {
                        onNewChat()
                    } else {
                        presentNewWorkspace(for: effectiveProjects.first, isolation: .projectDirectory)
                    }
                }
                .accessibilityIdentifier("relay-new-chat")

                RelayToolbarIconButton(
                    systemImage: "gearshape",
                    accessibilityLabel: "Settings",
                    iconSize: 17,
                    weight: .regular,
                    isMuted: true,
                    action: onOpenSettings
                )
                .accessibilityIdentifier("relay-sidebar-settings")
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 8)
            .background(theme.surfaceSidebar)
        }
    }

    // MARK: - Helpers

    private func presentNewWorkspace(
        for project: RelaySidebarProjectGroup?,
        isolation: RelayNewWorkspaceRequest.Isolation
    ) {
        newWorkspacePreselectedProject = project ?? effectiveProjects.first
        newWorkspaceInitialIsolation = isolation
        showingNewWorkspaceSheet = true
    }

    private func handleArchiveRequest(_ workspace: RelaySidebarWorkspaceItem) {
        // Paseo design rule §14: confirm archive only when worktree has uncommitted changes.
        if workspace.isDirty {
            workspacePendingArchive = workspace
        } else {
            onArchiveWorkspace?(workspace)
        }
    }
}

// MARK: - New Workspace / Worktree Sheet

struct RelayNewWorkspaceSheet: View {
    let projects: [RelaySidebarProjectGroup]
    let preselectedProject: RelaySidebarProjectGroup?
    let initialIsolation: RelayNewWorkspaceRequest.Isolation
    let onSubmit: (RelayNewWorkspaceRequest) -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme

    @State private var selectedProjectID: String
    @State private var customProjectName: String = ""
    @State private var isolation: RelayNewWorkspaceRequest.Isolation
    @State private var branchName: String = ""
    @State private var baseBranch: String = "main"
    @State private var launchMode: RelayNewWorkspaceRequest.LaunchMode = .agent

    init(
        projects: [RelaySidebarProjectGroup],
        preselectedProject: RelaySidebarProjectGroup? = nil,
        initialIsolation: RelayNewWorkspaceRequest.Isolation = .newGitWorktree,
        onSubmit: @escaping (RelayNewWorkspaceRequest) -> Void
    ) {
        self.projects = projects
        self.preselectedProject = preselectedProject
        self.initialIsolation = initialIsolation
        self.onSubmit = onSubmit
        let initialID = preselectedProject?.id ?? projects.first?.id ?? ""
        _selectedProjectID = State(initialValue: initialID)
        _isolation = State(initialValue: initialIsolation)
    }

    private var selectedProject: RelaySidebarProjectGroup? {
        projects.first(where: { $0.id == selectedProjectID }) ?? preselectedProject ?? projects.first
    }

    private var canSubmit: Bool {
        if selectedProject != nil { return true }
        return !customProjectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            RelaySheetHeader(
                "New workspace",
                subtitle: selectedProject?.name,
                systemImage: "folder.badge.plus",
                onClose: { dismiss() }
            )

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    RelaySettingsSection("Project") {
                        RelaySettingsCard {
                            if projects.isEmpty {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Project name")
                                        .font(RelayTheme.uiFont(13, weight: .medium))
                                        .foregroundStyle(theme.foregroundMuted)
                                    TextField("e.g. my-app", text: $customProjectName)
                                        .font(RelayTheme.uiFont(15, weight: .regular))
                                        .foregroundStyle(theme.foreground)
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 13)
                            } else {
                                ForEach(Array(projects.enumerated()), id: \.element.id) { index, project in
                                    let isSelected = project.id == selectedProjectID
                                    RelaySettingsRow(
                                        project.name,
                                        subtitle: project.rootPath,
                                        showsTopDivider: index > 0,
                                        action: { selectedProjectID = project.id }
                                    ) {
                                        HStack(spacing: 10) {
                                            RelayProjectIcon(
                                                name: project.name,
                                                seed: project.rootPath ?? project.name,
                                                colorIndex: project.colorIndex,
                                                size: 20
                                            )
                                            if isSelected {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 13, weight: .semibold))
                                                    .foregroundStyle(theme.accentBright)
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }

                    RelaySettingsSection("Isolation") {
                        RelaySettingsCard {
                            ForEach(Array(RelayNewWorkspaceRequest.Isolation.allCases.enumerated()), id: \.element.id) { index, option in
                                let isSelected = isolation == option
                                RelaySettingsRow(
                                    option.title,
                                    subtitle: option.subtitle,
                                    systemImage: option == .projectDirectory ? "desktopcomputer" : "arrow.triangle.branch",
                                    iconColor: isSelected ? theme.foreground : theme.foregroundMuted,
                                    showsTopDivider: index > 0,
                                    action: { isolation = option }
                                ) {
                                    if isSelected {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(theme.accentBright)
                                    }
                                }
                            }
                        }
                    }

                    if isolation == .newGitWorktree {
                        RelaySettingsSection("Git branch") {
                            RelaySettingsCard {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Branch name")
                                        .font(RelayTheme.uiFont(13, weight: .medium))
                                        .foregroundStyle(theme.foregroundMuted)
                                    TextField("Optional — auto-generated if blank", text: $branchName)
                                        .font(RelayTheme.monoFont(14, weight: .regular))
                                        .foregroundStyle(theme.foreground)
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)

                                RelaySettingsDivider()

                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Base branch")
                                        .font(RelayTheme.uiFont(13, weight: .medium))
                                        .foregroundStyle(theme.foregroundMuted)
                                    TextField("main", text: $baseBranch)
                                        .font(RelayTheme.monoFont(14, weight: .regular))
                                        .foregroundStyle(theme.foreground)
                                        .textInputAutocapitalization(.never)
                                        .autocorrectionDisabled()
                                }
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                            }
                        }
                    }

                    RelaySettingsSection("Launch", flush: true) {
                        HStack(spacing: 8) {
                            ForEach(RelayNewWorkspaceRequest.LaunchMode.allCases) { mode in
                                let selected = launchMode == mode
                                Button {
                                    launchMode = mode
                                } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: mode.systemImage)
                                            .font(.system(size: 14, weight: .regular))
                                        Text(mode.title)
                                            .font(RelayTheme.uiFont(14, weight: .medium))
                                    }
                                    .foregroundStyle(selected ? theme.foreground : theme.foregroundMuted)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 44)
                                    .background(
                                        selected ? theme.surface3 : theme.surface1,
                                        in: RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    )
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                                            .strokeBorder(selected ? theme.borderAccent : theme.border, lineWidth: 1)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)

            // Primary action bar
            VStack(spacing: 0) {
                Rectangle()
                    .fill(theme.border)
                    .frame(height: 1)

                HStack(spacing: 10) {
                    RelayButton("Cancel", variant: .outline) {
                        dismiss()
                    }
                    RelayButton(
                        launchMode == .agent ? "Start agent" : "Open terminal",
                        variant: .primary,
                        isFullWidth: true,
                        isDisabled: !canSubmit
                    ) {
                        let resolvedName = selectedProject?.name
                            ?? customProjectName.trimmingCharacters(in: .whitespacesAndNewlines)
                        let request = RelayNewWorkspaceRequest(
                            projectID: selectedProject?.id,
                            projectName: resolvedName,
                            projectRootPath: selectedProject?.rootPath,
                            isolation: isolation,
                            branchName: branchName.trimmedNonEmpty,
                            baseBranch: baseBranch.trimmedNonEmpty,
                            launchMode: launchMode
                        )
                        onSubmit(request)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(theme.surface0)
            }
        }
        .background(theme.surface0.ignoresSafeArea())
        .preferredColorScheme(theme.colorScheme)
    }
}

// MARK: - Compact Multi-Host Switcher Sheet

struct RelayHostSwitcherSheet: View {
    @ObservedObject var nodeStore: RelayNodeStore
    var identityStore: ClientIdentityStore?
    var powerModel: RelayMachinePowerModel?
    let onSelectHost: (RelayPairedNode) -> Void
    let onAddHost: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            RelaySheetHeader(
                "Hosts",
                subtitle: "Select the active machine",
                systemImage: "server.rack",
                onClose: { dismiss() }
            )

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if nodeStore.hosts.isEmpty {
                        if AppConfiguration.hasConfiguredPersonalInstall {
                            RelaySettingsCard {
                                RelaySettingsRow(
                                    "Linked computer",
                                    subtitle: AppConfiguration.codexBaseURL.host ?? AppConfiguration.codexBaseURL.absoluteString,
                                    systemImage: "desktopcomputer"
                                ) {
                                    HStack(spacing: 8) {
                                        RelayStatusDot(bucket: .done, size: 7)
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 13, weight: .semibold))
                                            .foregroundStyle(theme.accentBright)
                                    }
                                }
                            }
                        } else {
                            RelayEmptyStateView("No paired hosts yet")
                        }
                    } else {
                        RelaySettingsCard {
                            ForEach(Array(nodeStore.hosts.enumerated()), id: \.element.id) { index, host in
                                let isActive = host.nodeID == nodeStore.activeHostID
                                RelaySettingsRow(
                                    host.nodeName,
                                    subtitle: host.apiBaseURL.host ?? host.apiBaseURL.absoluteString,
                                    showsTopDivider: index > 0,
                                    action: {
                                        if !isActive {
                                            identityStore?.activateHostMaterial(for: host.host ?? host.nodeID)
                                            nodeStore.selectHost(id: host.nodeID)
                                        }
                                        onSelectHost(host)
                                    }
                                ) {
                                    HStack(spacing: 10) {
                                        RelayStatusDot(bucket: statusBucket(for: host, isActive: isActive), size: 7)
                                        Image(systemName: isLocalHost(host.apiBaseURL) ? "desktopcomputer" : "globe")
                                            .font(.system(size: 14, weight: .regular))
                                            .foregroundStyle(theme.foregroundMuted)
                                        if isActive {
                                            Image(systemName: "checkmark")
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundStyle(theme.accentBright)
                                        }
                                    }
                                }
                            }
                        }
                    }

                    if let powerModel, (identityStore?.wakeCredential() != nil || powerModel.status != .unavailable) {
                        RelaySettingsSection("Machine power & size") {
                            RelaySettingsCard {
                                RelayMachinePowerSwitch(
                                    model: powerModel,
                                    confirmStop: { Task { await powerModel.stop() } },
                                    accessibilityIdentifier: "relay-host-switcher-power"
                                )
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)

                                RelaySettingsDivider()

                                RelayMachineSizeControl(model: powerModel)
                                    .padding(.horizontal, 16)
                                    .padding(.vertical, 12)

                                if powerModel.autoStopEnabled != nil || !powerModel.status.isResolved {
                                    RelaySettingsDivider()
                                    RelayMachineAutoStopToggle(model: powerModel)
                                        .padding(.horizontal, 16)
                                        .padding(.vertical, 12)
                                }
                            }
                        }
                    }

                    RelayButton(
                        "Add host",
                        variant: .outline,
                        systemImage: "plus",
                        isFullWidth: true,
                        action: onAddHost
                    )
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(theme.surface0.ignoresSafeArea())
        .preferredColorScheme(theme.colorScheme)
    }

    private func statusBucket(for host: RelayPairedNode, isActive: Bool) -> RelayStatusBucket {
        guard isActive else { return .idle }
        guard let powerModel else { return .done }
        switch powerModel.status {
        case .on, .unknown, .unavailable: return .done
        case .starting, .stopping, .loading: return .needsInput
        case .off: return .error
        }
    }

    private func isLocalHost(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host.hasSuffix(".local")
            || host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.hasPrefix("192.168.")
            || host.hasPrefix("10.")
    }
}

// MARK: - Sidebar Press Styles

private struct RelaySidebarPressStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? highlight : Color.clear,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .animation(.easeOut(duration: 0.10), value: configuration.isPressed)
    }
}

private struct RelaySidebarIconPressStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? highlight : Color.clear,
                in: RoundedRectangle(cornerRadius: 6, style: .continuous)
            )
            .animation(.easeOut(duration: 0.10), value: configuration.isPressed)
    }
}
