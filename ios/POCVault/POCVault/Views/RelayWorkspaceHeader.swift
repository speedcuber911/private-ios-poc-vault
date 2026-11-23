import SwiftUI

// MARK: - Workspace Tab Model

struct RelayWorkspaceTabItem: Identifiable, Hashable {
    enum Kind: Hashable {
        case agent(provider: CodexProvider?)
        case terminal
    }

    let id: String
    let kind: Kind
    let title: String
    let subtitle: String?
    let status: RelayStatusBucket
    let isActive: Bool

    init(
        id: String,
        kind: Kind,
        title: String,
        subtitle: String? = nil,
        status: RelayStatusBucket = .idle,
        isActive: Bool = false
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.subtitle = subtitle
        self.status = status
        self.isActive = isActive
    }

    var isTerminal: Bool {
        if case .terminal = kind { return true }
        return false
    }

    var provider: CodexProvider? {
        if case .agent(let provider) = kind { return provider }
        return nil
    }

    static func from(_ tab: RelayWorkspaceTab, activeTabID: UUID?) -> RelayWorkspaceTabItem {
        let kind: Kind = switch tab.kind {
        case .agent(_, _, let provider, _): .agent(provider: provider)
        case .terminal: .terminal
        }
        let status: RelayStatusBucket
        if tab.needsInput {
            status = .needsInput
        } else if tab.isRunning {
            status = .running
        } else {
            status = .idle
        }
        return RelayWorkspaceTabItem(
            id: tab.id.uuidString,
            kind: kind,
            title: tab.title,
            subtitle: tab.kind.isTerminal ? "Shell" : tab.kind.provider?.displayName,
            status: status,
            isActive: tab.id == activeTabID
        )
    }
}

// MARK: - 2-Tier Compact Workspace Header

/// Paseo's compact mobile top chrome:
/// - Row 1 (`48pt`): Hamburger button, inline `workspaceName  projectName` title group,
///   workspace overflow menu (`⋮`), and the rounded-square `±` Explorer/Changes toggle.
/// - Row 2 (`40pt`): Full-width tab switcher strip (`1pt` top & bottom borders) opening
///   `RelayWorkspaceTabSwitcherSheet` for all open Agent sessions and Terminals in the workspace.
struct RelayWorkspaceHeader: View {
    let workspaceName: String
    let projectName: String?
    let activeTab: RelayWorkspaceTabItem?
    let tabs: [RelayWorkspaceTabItem]
    var hasGitChanges: Bool
    var isExplorerOpen: Bool
    var pendingHandoffCount: Int
    var showsTabStrip: Bool

    let onOpenSidebar: () -> Void
    let onToggleExplorer: () -> Void
    var onTapWorkspaceTitle: (() -> Void)?
    var onSelectTab: ((RelayWorkspaceTabItem) -> Void)?
    var onNewAgent: (() -> Void)?
    var onNewTerminal: (() -> Void)?
    var onNewWorktree: (() -> Void)?
    var onRenameTab: ((RelayWorkspaceTabItem, String) -> Void)?
    var onReloadTab: ((RelayWorkspaceTabItem) -> Void)?
    var onCloseTab: ((RelayWorkspaceTabItem) -> Void)?
    var onOpenPreviews: (() -> Void)?
    var onOpenHandoffs: (() -> Void)?
    var onOpenMachineStatus: (() -> Void)?
    var onOpenSettings: (() -> Void)?

    @Environment(\.relayTheme) private var theme
    @State private var showingTabSwitcher = false

    init(
        workspaceName: String,
        projectName: String? = nil,
        activeTab: RelayWorkspaceTabItem? = nil,
        tabs: [RelayWorkspaceTabItem] = [],
        hasGitChanges: Bool = false,
        isExplorerOpen: Bool = false,
        pendingHandoffCount: Int = 0,
        showsTabStrip: Bool = true,
        onOpenSidebar: @escaping () -> Void,
        onToggleExplorer: @escaping () -> Void,
        onTapWorkspaceTitle: (() -> Void)? = nil,
        onSelectTab: ((RelayWorkspaceTabItem) -> Void)? = nil,
        onNewAgent: (() -> Void)? = nil,
        onNewTerminal: (() -> Void)? = nil,
        onNewWorktree: (() -> Void)? = nil,
        onRenameTab: ((RelayWorkspaceTabItem, String) -> Void)? = nil,
        onReloadTab: ((RelayWorkspaceTabItem) -> Void)? = nil,
        onCloseTab: ((RelayWorkspaceTabItem) -> Void)? = nil,
        onOpenPreviews: (() -> Void)? = nil,
        onOpenHandoffs: (() -> Void)? = nil,
        onOpenMachineStatus: (() -> Void)? = nil,
        onOpenSettings: (() -> Void)? = nil
    ) {
        self.workspaceName = workspaceName
        self.projectName = projectName
        self.activeTab = activeTab
        self.tabs = tabs
        self.hasGitChanges = hasGitChanges
        self.isExplorerOpen = isExplorerOpen
        self.pendingHandoffCount = pendingHandoffCount
        self.showsTabStrip = showsTabStrip
        self.onOpenSidebar = onOpenSidebar
        self.onToggleExplorer = onToggleExplorer
        self.onTapWorkspaceTitle = onTapWorkspaceTitle
        self.onSelectTab = onSelectTab
        self.onNewAgent = onNewAgent
        self.onNewTerminal = onNewTerminal
        self.onNewWorktree = onNewWorktree
        self.onRenameTab = onRenameTab
        self.onReloadTab = onReloadTab
        self.onCloseTab = onCloseTab
        self.onOpenPreviews = onOpenPreviews
        self.onOpenHandoffs = onOpenHandoffs
        self.onOpenMachineStatus = onOpenMachineStatus
        self.onOpenSettings = onOpenSettings
    }

    private var resolvedActiveTab: RelayWorkspaceTabItem? {
        activeTab ?? tabs.first(where: \.isActive) ?? tabs.first
    }

    private var showProjectSubtitle: Bool {
        guard let project = projectName?.trimmedNonEmpty else { return false }
        return project.caseInsensitiveCompare(workspaceName) != .orderedSame
    }

    var body: some View {
        VStack(spacing: 0) {
            // Row 1: Compact Workspace Header (48pt)
            workspaceChromeRow

            // Row 2: Compact Tab Switcher Strip (40pt, bordered top & bottom)
            if showsTabStrip {
                Rectangle()
                    .fill(theme.border)
                    .frame(height: 1)

                tabSwitcherRow

                Rectangle()
                    .fill(theme.border)
                    .frame(height: 1)
            } else {
                Rectangle()
                    .fill(theme.border)
                    .frame(height: 1)
            }
        }
        .background(theme.surface0)
        .sheet(isPresented: $showingTabSwitcher) {
            RelayWorkspaceTabSwitcherSheet(
                workspaceName: workspaceName,
                projectName: projectName,
                tabs: effectiveSheetTabs,
                activeTabID: resolvedActiveTab?.id,
                onSelectTab: { tab in
                    showingTabSwitcher = false
                    onSelectTab?(tab)
                },
                onNewAgent: {
                    showingTabSwitcher = false
                    onNewAgent?()
                },
                onNewTerminal: {
                    showingTabSwitcher = false
                    onNewTerminal?()
                },
                onRenameTab: onRenameTab,
                onReloadTab: { tab in
                    showingTabSwitcher = false
                    onReloadTab?(tab)
                },
                onCloseTab: onCloseTab
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
    }

    private var effectiveSheetTabs: [RelayWorkspaceTabItem] {
        if !tabs.isEmpty {
            return tabs
        }
        if let resolvedActiveTab {
            return [resolvedActiveTab]
        }
        return []
    }

    // MARK: - Row 1: Workspace Chrome

    private var workspaceChromeRow: some View {
        HStack(spacing: 4) {
            RelayToolbarIconButton(
                systemImage: "line.3.horizontal",
                accessibilityLabel: "Open workspaces",
                iconSize: 17,
                weight: .regular,
                action: onOpenSidebar
            )
            .accessibilityIdentifier("relay-header-menu")

            Button {
                if let onTapWorkspaceTitle {
                    onTapWorkspaceTitle()
                } else {
                    onOpenSidebar()
                }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(workspaceName)
                        .font(RelayTheme.uiFont(15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(1)

                    if showProjectSubtitle, let projectName {
                        Text(projectName)
                            .font(RelayTheme.uiFont(14, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(showProjectSubtitle ? "\(workspaceName), \(projectName ?? "")" : workspaceName)
            .accessibilityIdentifier("relay-header-workspace-title")

            HStack(spacing: 0) {
                workspaceOverflowMenu
                explorerToggleButton
            }
        }
        .padding(.horizontal, 8)
        .frame(height: 48)
        .background(theme.surface0)
    }

    private var workspaceOverflowMenu: some View {
        Menu {
            if let onNewAgent {
                Button {
                    onNewAgent()
                } label: {
                    Label("New agent", systemImage: "bubble.left.and.bubble.right")
                }
            }

            if let onNewTerminal {
                Button {
                    onNewTerminal()
                } label: {
                    Label("New terminal", systemImage: "terminal")
                }
            }

            if let onNewWorktree {
                Button {
                    onNewWorktree()
                } label: {
                    Label("New worktree", systemImage: "arrow.triangle.branch")
                }
            }

            if onOpenPreviews != nil || onOpenHandoffs != nil || onOpenMachineStatus != nil {
                Divider()
            }

            if let onOpenPreviews {
                Button {
                    onOpenPreviews()
                } label: {
                    Label("Workspace previews", systemImage: "rectangle.on.rectangle")
                }
            }

            if let onOpenHandoffs {
                Button {
                    onOpenHandoffs()
                } label: {
                    if pendingHandoffCount > 0 {
                        Label("Handoffs (\(pendingHandoffCount))", systemImage: "laptopcomputer.and.iphone")
                    } else {
                        Label("Handoffs", systemImage: "laptopcomputer.and.iphone")
                    }
                }
            }

            if let onOpenMachineStatus {
                Button {
                    onOpenMachineStatus()
                } label: {
                    Label("Machine status", systemImage: "cpu")
                }
            }

            if let onOpenSettings {
                Divider()
                Button {
                    onOpenSettings()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 15, weight: .medium))
                .rotationEffect(.degrees(90))
                .foregroundStyle(theme.foregroundMuted)
                .frame(width: 36, height: 36)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace menu")
        .accessibilityIdentifier("relay-header-overflow")
    }

    /// Rounded-square `±` Explorer/Changes glyph matching Paseo's top-right compact button,
    /// with a subtle dirty-tree indicator dot when git reports pending changes.
    private var explorerToggleButton: some View {
        Button(action: onToggleExplorer) {
            ZStack(alignment: .topTrailing) {
                ZStack {
                    RoundedRectangle(cornerRadius: 4.5, style: .continuous)
                        .strokeBorder(
                            isExplorerOpen ? theme.foreground : theme.foregroundMuted,
                            lineWidth: 1.35
                        )
                        .frame(width: 19, height: 19)

                    Image(systemName: "plus.forwardslash.minus")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(isExplorerOpen ? theme.foreground : theme.foregroundMuted)
                }

                if hasGitChanges {
                    Circle()
                        .fill(theme.statusDotWarning)
                        .frame(width: 6, height: 6)
                        .overlay {
                            Circle()
                                .stroke(theme.surface0, lineWidth: 1.5)
                        }
                        .offset(x: 3, y: -3)
                }
            }
            .frame(width: 36, height: 36)
        }
        .buttonStyle(RelayExplorerGlyphButtonStyle(theme: theme, isSelected: isExplorerOpen))
        .accessibilityLabel(hasGitChanges ? "Changes and files (uncommitted changes)" : "Changes and files")
        .accessibilityIdentifier("relay-header-explorer-toggle")
    }

    // MARK: - Row 2: Tab Switcher Strip

    private var tabSwitcherRow: some View {
        Button {
            showingTabSwitcher = true
        } label: {
            HStack(spacing: 8) {
                tabLeadingGlyph(for: resolvedActiveTab)

                Text(resolvedActiveTab?.title ?? "New agent")
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)

                Spacer(minLength: 8)

                if tabs.count > 1 {
                    Text("\(tabs.count)")
                        .font(RelayTheme.monoFont(11, weight: .medium))
                        .monospacedDigit()
                        .foregroundStyle(theme.foregroundMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(theme.surface2, in: Capsule())
                        .overlay {
                            Capsule()
                                .strokeBorder(theme.border, lineWidth: 1)
                        }
                }

                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .contentShape(Rectangle())
        }
        .buttonStyle(RelayTabStripPressStyle(highlight: theme.interactionHighlight))
        .accessibilityLabel("Active tab: \(resolvedActiveTab?.title ?? "New agent")")
        .accessibilityHint("Switch tabs or create a new agent or terminal")
        .accessibilityIdentifier("relay-header-tab-switcher")
    }

    @ViewBuilder
    private func tabLeadingGlyph(for tab: RelayWorkspaceTabItem?) -> some View {
        HStack(spacing: 6) {
            if let tab {
                switch tab.kind {
                case .terminal:
                    Image(systemName: "terminal")
                        .font(.system(size: 13.5, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                case .agent(let provider):
                    if let provider {
                        RelayProviderMark(provider: provider, size: 15)
                    } else {
                        Image(systemName: "bubble.left")
                            .font(.system(size: 13.5, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                }

                if tab.status == .running {
                    RelayStatusRing(isActive: true, size: 11, lineWidth: 1.4, showsCenterDot: true)
                } else if tab.status == .needsInput || tab.status == .error {
                    RelayStatusDot(bucket: tab.status, size: 6)
                }
            } else {
                Image(systemName: "bubble.left")
                    .font(.system(size: 13.5, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
            }
        }
    }
}

// MARK: - Mobile Workspace Tab Switcher Sheet

struct RelayWorkspaceTabSwitcherSheet: View {
    let workspaceName: String
    let projectName: String?
    let tabs: [RelayWorkspaceTabItem]
    let activeTabID: String?
    let onSelectTab: (RelayWorkspaceTabItem) -> Void
    var onNewAgent: (() -> Void)?
    var onNewTerminal: (() -> Void)?
    var onRenameTab: ((RelayWorkspaceTabItem, String) -> Void)?
    var onReloadTab: ((RelayWorkspaceTabItem) -> Void)?
    var onCloseTab: ((RelayWorkspaceTabItem) -> Void)?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme

    @State private var tabBeingRenamed: RelayWorkspaceTabItem?
    @State private var renameDraft: String = ""

    private var agentTabs: [RelayWorkspaceTabItem] {
        tabs.filter { !$0.isTerminal }
    }

    private var terminalTabs: [RelayWorkspaceTabItem] {
        tabs.filter(\.isTerminal)
    }

    var body: some View {
        VStack(spacing: 0) {
            RelaySheetHeader(
                "Tabs",
                subtitle: [workspaceName, projectName].compactMap { $0?.trimmedNonEmpty }.joined(separator: " · "),
                systemImage: "square.stack",
                onClose: { dismiss() }
            )

            // Quick creation bar
            HStack(spacing: 10) {
                if let onNewAgent {
                    RelayButton(
                        "New agent",
                        variant: .secondary,
                        size: .sm,
                        systemImage: "plus",
                        isFullWidth: true,
                        action: onNewAgent
                    )
                    .accessibilityIdentifier("relay-tab-switcher-new-agent")
                }

                if let onNewTerminal {
                    RelayButton(
                        "New terminal",
                        variant: .outline,
                        size: .sm,
                        systemImage: "terminal",
                        isFullWidth: true,
                        action: onNewTerminal
                    )
                    .accessibilityIdentifier("relay-tab-switcher-new-terminal")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(theme.surface0)

            Rectangle()
                .fill(theme.border)
                .frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if tabs.isEmpty {
                        RelayEmptyStateView("No open tabs in this workspace")
                    } else if !agentTabs.isEmpty && !terminalTabs.isEmpty {
                        RelaySettingsSection("Agents") {
                            RelaySettingsCard {
                                ForEach(Array(agentTabs.enumerated()), id: \.element.id) { index, tab in
                                    tabRow(tab, showsTopDivider: index > 0)
                                }
                            }
                        }

                        RelaySettingsSection("Terminals", flush: true) {
                            RelaySettingsCard {
                                ForEach(Array(terminalTabs.enumerated()), id: \.element.id) { index, tab in
                                    tabRow(tab, showsTopDivider: index > 0)
                                }
                            }
                        }
                    } else {
                        RelaySettingsSection(terminalTabs.isEmpty ? "Agents" : "Terminals", flush: true) {
                            RelaySettingsCard {
                                ForEach(Array(tabs.enumerated()), id: \.element.id) { index, tab in
                                    tabRow(tab, showsTopDivider: index > 0)
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)
                .padding(.bottom, 24)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(theme.surface0.ignoresSafeArea())
        .preferredColorScheme(theme.colorScheme)
        .alert("Rename tab", isPresented: Binding(
            get: { tabBeingRenamed != nil },
            set: { if !$0 { tabBeingRenamed = nil } }
        )) {
            TextField("Tab name", text: $renameDraft)
            Button("Save") {
                if let tab = tabBeingRenamed,
                   let trimmed = renameDraft.trimmedNonEmpty {
                    onRenameTab?(tab, trimmed)
                }
                tabBeingRenamed = nil
            }
            Button("Cancel", role: .cancel) {
                tabBeingRenamed = nil
            }
        }
    }

    private func tabRow(_ tab: RelayWorkspaceTabItem, showsTopDivider: Bool) -> some View {
        let isSelected = tab.id == activeTabID || (activeTabID == nil && tab.isActive)

        return VStack(spacing: 0) {
            if showsTopDivider {
                RelaySettingsDivider()
            }

            HStack(spacing: 8) {
                Button {
                    onSelectTab(tab)
                } label: {
                    HStack(spacing: 12) {
                        ZStack {
                            switch tab.kind {
                            case .terminal:
                                Image(systemName: "terminal")
                                    .font(.system(size: 14, weight: .regular))
                                    .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                            case .agent(let provider):
                                if let provider {
                                    RelayProviderMark(provider: provider, size: 16)
                                } else {
                                    Image(systemName: "bubble.left")
                                        .font(.system(size: 14, weight: .regular))
                                        .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                                }
                            }
                        }
                        .frame(width: 22, alignment: .center)

                        VStack(alignment: .leading, spacing: 2) {
                            Text(tab.title)
                                .font(RelayTheme.uiFont(15, weight: .regular))
                                .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                                .lineLimit(1)
                                .truncationMode(.tail)

                            if let subtitle = tab.subtitle?.trimmedNonEmpty {
                                Text(subtitle)
                                    .font(RelayTheme.uiFont(12, weight: .regular))
                                    .foregroundStyle(theme.foregroundExtraMuted)
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)

                        // Live status indicator
                        if tab.status == .running {
                            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                        } else if tab.status != .idle {
                            RelayStatusDot(bucket: tab.status, size: 7)
                        }

                        if isSelected {
                            Image(systemName: "checkmark")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundStyle(theme.accentBright)
                        }
                    }
                    .padding(.leading, 14)
                    .padding(.vertical, 12)
                    .frame(minHeight: 50, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if onRenameTab != nil || onReloadTab != nil || onCloseTab != nil {
                    Menu {
                        if onRenameTab != nil {
                            Button {
                                renameDraft = tab.title
                                tabBeingRenamed = tab
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                        }

                        if let onReloadTab {
                            Button {
                                onReloadTab(tab)
                            } label: {
                                Label("Reload", systemImage: "arrow.clockwise")
                            }
                        }

                        if let onCloseTab {
                            Divider()
                            Button(role: .destructive) {
                                onCloseTab(tab)
                            } label: {
                                Label("Close tab", systemImage: "xmark")
                            }
                        }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 13, weight: .medium))
                            .rotationEffect(.degrees(90))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .frame(width: 32, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Options for \(tab.title)")
                }

                if let onCloseTab, tabs.count > 1 {
                    RelayToolbarIconButton(
                        systemImage: "xmark",
                        accessibilityLabel: "Close \(tab.title)",
                        iconSize: 12,
                        weight: .medium,
                        isMuted: true
                    ) {
                        onCloseTab(tab)
                    }
                }
            }
            .padding(.trailing, 8)
            .background(isSelected ? theme.surfaceSidebarSelected.opacity(0.65) : Color.clear)
        }
    }
}

// MARK: - Button Styles

private struct RelayExplorerGlyphButtonStyle: ButtonStyle {
    let theme: RelayThemePalette
    let isSelected: Bool

    func makeBody(configuration: Configuration) -> some View {
        let highlighted = configuration.isPressed || isSelected
        configuration.label
            .background(highlighted ? theme.interactionHighlight : Color.clear, in: Circle())
            .contentShape(Circle())
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct RelayTabStripPressStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? highlight : Color.clear)
            .animation(.easeOut(duration: 0.10), value: configuration.isPressed)
    }
}
