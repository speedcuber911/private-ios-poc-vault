import SwiftUI
import UIKit

// MARK: - Explorer Tab & File Target

enum RelayExplorerTab: String, CaseIterable, Identifiable, Hashable {
    case changes
    case files
    case previews

    var id: String { rawValue }

    var title: String {
        switch self {
        case .changes: return "Changes"
        case .files: return "Files"
        case .previews: return "Previews"
        }
    }
}

struct RelayWorkspaceFileTarget: Identifiable, Hashable {
    let path: String
    let relativePath: String
    let displayName: String
    let size: Int64?
    let mime: String?
    let readDenied: Bool

    var id: String { path }

    init(
        path: String,
        relativePath: String,
        displayName: String? = nil,
        size: Int64? = nil,
        mime: String? = nil,
        readDenied: Bool = false
    ) {
        self.path = path
        self.relativePath = relativePath
        self.displayName = displayName?.trimmedNonEmpty ?? URL(fileURLWithPath: path).lastPathComponent
        self.size = size
        self.mime = mime
        self.readDenied = readDenied
    }

    init(entry: CodexWorkspaceDirectoryEntry, workspaceRoot: String) {
        self.path = entry.path
        self.relativePath = Self.makeRelativePath(absolutePath: entry.path, workspaceRoot: workspaceRoot)
            ?? entry.relativePath?.trimmedNonEmpty
            ?? entry.displayName
        self.displayName = entry.displayName
        self.size = entry.size
        self.mime = entry.mime
        self.readDenied = entry.readDenied
    }

    var fileExtension: String {
        URL(fileURLWithPath: displayName).pathExtension.lowercased()
    }

    var isMarkdown: Bool {
        let lowerMime = mime?.lowercased() ?? ""
        return lowerMime.hasPrefix("text/markdown") || ["md", "markdown", "mdown", "mdx"].contains(fileExtension)
    }

    var isHTML: Bool {
        let lowerMime = mime?.lowercased() ?? ""
        return lowerMime.hasPrefix("text/html") || lowerMime.hasPrefix("application/xhtml")
            || fileExtension == "html" || fileExtension == "htm"
    }

    var isPDF: Bool {
        let lowerMime = mime?.lowercased() ?? ""
        return lowerMime.hasPrefix("application/pdf") || fileExtension == "pdf"
    }

    var isImage: Bool {
        let lowerMime = mime?.lowercased() ?? ""
        let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "ico"]
        return lowerMime.hasPrefix("image/") || imageExts.contains(fileExtension)
    }

    var isWebRendered: Bool {
        !readDenied && (isHTML || isPDF)
    }

    var sizeLabel: String? {
        guard let size else { return nil }
        return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    static func makeRelativePath(absolutePath: String, workspaceRoot: String) -> String? {
        let cleanRoot = workspaceRoot.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard !cleanRoot.isEmpty else { return nil }
        if absolutePath == cleanRoot { return "" }
        let prefix = cleanRoot + "/"
        if absolutePath.hasPrefix(prefix) {
            return String(absolutePath.dropFirst(prefix.count))
        }
        return nil
    }
}

// MARK: - Right Explorer Drawer

/// Paseo-inspired mobile Right Explorer Drawer hosting three workspace surfaces:
/// - `Changes`: native syntax-highlighted unified diffs, branch switcher, PR & commit actions
/// - `Files`: workspace directory tree with compact syntax-highlighted file sheet
/// - `Previews`: workspace artifacts and live app previews one tap away
struct RelayExplorerDrawerView: View {
    @Environment(\.relayTheme) private var theme

    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore
    let workspacePath: String
    let workspaceName: String?
    let workspaceID: String?
    let workspaceAccessIsAvailable: Bool
    let gitAPI: (any RelayGitAPI)?
    let onClose: () -> Void
    let onAttachFileToChat: (String) -> Void
    let onSendReviewComment: (String) -> Void
    let onOpenJob: (CodexJob) -> Void
    let onHorizontalDragActive: ((Bool) -> Void)?

    @State private var selectedTab: RelayExplorerTab
    @State private var dirtyFileCount = 0
    @State private var gitRepoRoot: String?
    @State private var selectedFile: RelayWorkspaceFileTarget?
    @StateObject private var previewsModel: RelayPreviewsModel

    init(
        client: CodexClient,
        identityStore: ClientIdentityStore,
        workspacePath: String,
        workspaceName: String? = nil,
        workspaceID: String? = nil,
        workspaceAccessIsAvailable: Bool = true,
        gitAPI: (any RelayGitAPI)? = nil,
        initialTab: RelayExplorerTab = .changes,
        onClose: @escaping () -> Void,
        onAttachFileToChat: @escaping (String) -> Void,
        onSendReviewComment: @escaping (String) -> Void,
        onOpenJob: @escaping (CodexJob) -> Void,
        onHorizontalDragActive: ((Bool) -> Void)? = nil
    ) {
        self.client = client
        self.identityStore = identityStore
        self.workspacePath = workspacePath
        self.workspaceName = workspaceName
        self.workspaceID = workspaceID
        self.workspaceAccessIsAvailable = workspaceAccessIsAvailable
        // Cast via AnyObject so this compiles cleanly with zero warnings both before
        // and after CodexClient conforms to RelayGitAPI.
        self.gitAPI = gitAPI ?? ((client as AnyObject) as? any RelayGitAPI)
        self.onClose = onClose
        self.onAttachFileToChat = onAttachFileToChat
        self.onSendReviewComment = onSendReviewComment
        self.onOpenJob = onOpenJob
        self.onHorizontalDragActive = onHorizontalDragActive
        _selectedTab = State(initialValue: initialTab)
        _previewsModel = StateObject(wrappedValue: RelayPreviewsModel(client: client))
    }

    private var previewCount: Int {
        previewsModel.results?.count ?? 0
    }

    var body: some View {
        VStack(spacing: 0) {
            topHeaderBar
            tabBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.surface0.ignoresSafeArea())
        .task(id: workspaceAccessIsAvailable) {
            if workspaceAccessIsAvailable {
                await previewsModel.refresh()
            } else {
                previewsModel.discard()
            }
        }
        .onChange(of: selectedTab) { _, tab in
            if tab != .changes {
                onHorizontalDragActive?(false)
            }
        }
        .onDisappear {
            onHorizontalDragActive?(false)
        }
        .sheet(item: $selectedFile) { target in
            RelayWorkspaceFileSheet(
                client: client,
                identityStore: identityStore,
                target: target,
                onAttachToChat: { formattedRef in
                    selectedFile = nil
                    guard !formattedRef.isEmpty else { return }
                    onAttachFileToChat(formattedRef)
                }
            )
        }
    }

    // MARK: - Top Header Bar

    private var topHeaderBar: some View {
        HStack(spacing: 8) {
            HStack(spacing: 4) {
                ForEach(RelayExplorerTab.allCases) { tab in
                    tabButton(for: tab)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                onHorizontalDragActive?(false)
                selectedFile = nil
                onClose()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 36, height: 36)
                    .background(theme.surface1.opacity(0.001), in: Circle())
                    .contentShape(Circle())
            }
            .buttonStyle(RelayDrawerIconButtonStyle(highlight: theme.interactionHighlight))
            .accessibilityLabel("Close explorer")
            .accessibilityIdentifier("relay-explorer-close")
        }
        .padding(.leading, 10)
        .padding(.trailing, 8)
        .frame(height: 48)
        .background(theme.surface0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private func tabButton(for tab: RelayExplorerTab) -> some View {
        let isSelected = selectedTab == tab
        return Button {
            withAnimation(.easeOut(duration: 0.16)) {
                selectedTab = tab
            }
        } label: {
            HStack(spacing: 5) {
                Text(tab.title)
                    .font(RelayTheme.uiFont(14, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)

                if tab == .changes, dirtyFileCount > 0 {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(theme.statusDotWarning)
                            .frame(width: 5, height: 5)
                        Text("\(dirtyFileCount)")
                            .font(RelayTheme.monoFont(11, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                } else if tab == .previews, previewCount > 0 {
                    Text("\(previewCount)")
                        .font(RelayTheme.monoFont(10, weight: .medium))
                        .foregroundStyle(isSelected ? theme.foreground : theme.accentBright)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(
                            isSelected ? theme.surface3 : theme.surface2,
                            in: Capsule()
                        )
                }
            }
            .padding(.horizontal, 11)
            .frame(height: 32)
            .background(
                isSelected ? theme.surface2 : Color.clear,
                in: RoundedRectangle(cornerRadius: 8, style: .continuous)
            )
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
        .accessibilityIdentifier("relay-explorer-tab-\(tab.rawValue)")
    }

    // MARK: - Tab Content

    @ViewBuilder
    private var tabBody: some View {
        switch selectedTab {
        case .changes:
            RelayGitDiffView(
                workspacePath: workspacePath,
                gitAPI: gitAPI,
                onOpenFile: { relativePath in
                    openRelativeFile(relativePath)
                },
                onAttachFileToChat: { relativePath in
                    onAttachFileToChat(Self.formatChatFileReference(relativePath))
                },
                onSendReviewComment: onSendReviewComment,
                onStatusChanged: { status in
                    gitRepoRoot = status?.repoRoot
                    if let status {
                        dirtyFileCount = !status.files.isEmpty ? status.files.count : (status.dirty ? 1 : 0)
                    } else {
                        dirtyFileCount = 0
                    }
                },
                onHorizontalDragActive: onHorizontalDragActive
            )

        case .files:
            RelayExplorerFilesTab(
                client: client,
                workspacePath: workspacePath,
                workspaceName: workspaceName,
                onSelectFile: { entry in
                    selectedFile = RelayWorkspaceFileTarget(entry: entry, workspaceRoot: workspacePath)
                },
                onAttachFileToChat: { entry in
                    let rel = RelayWorkspaceFileTarget.makeRelativePath(
                        absolutePath: entry.path,
                        workspaceRoot: workspacePath
                    ) ?? entry.relativePath?.trimmedNonEmpty ?? entry.displayName
                    onAttachFileToChat(Self.formatChatFileReference(rel))
                }
            )

        case .previews:
            RelayExplorerPreviewsTab(
                model: previewsModel,
                client: client,
                identityStore: identityStore,
                workspaceID: workspaceID,
                workspaceName: workspaceName,
                workspaceAccessIsAvailable: workspaceAccessIsAvailable,
                onOpenJob: onOpenJob
            )
        }
    }

    private func openRelativeFile(_ relativePath: String) {
        let base = (gitRepoRoot?.trimmedNonEmpty ?? workspacePath).trimmingCharacters(in: .whitespacesAndNewlines)
        let fullPath: String
        if relativePath.hasPrefix("/") || base.isEmpty {
            fullPath = relativePath
        } else {
            fullPath = URL(fileURLWithPath: base).appendingPathComponent(relativePath).path
        }
        selectedFile = RelayWorkspaceFileTarget(
            path: fullPath,
            relativePath: relativePath
        )
    }

    static func formatChatFileReference(_ relativePath: String) -> String {
        let trimmed = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        return trimmed.hasPrefix("@") ? trimmed : "@\(trimmed)"
    }
}

private struct RelayDrawerIconButtonStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                configuration.isPressed ? highlight : Color.clear,
                in: Circle()
            )
    }
}

// MARK: - Files Tab

@MainActor
private final class RelayExplorerFilesViewModel: ObservableObject {
    private static let pageSize = 200

    let client: CodexClient
    let rootPath: String
    let rootDisplayName: String

    @Published private(set) var currentPath: String
    @Published private(set) var listing: CodexWorkspaceDirectoryListing?
    @Published private(set) var entries: [CodexWorkspaceDirectoryEntry] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    @Published private(set) var errorMessage: String?
    @Published var searchText = ""

    private var hasLoadedCurrentPath = false

    init(client: CodexClient, rootPath: String, rootDisplayName: String?) {
        self.client = client
        let cleaned = rootPath.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        self.rootPath = cleaned
        self.currentPath = cleaned
        self.rootDisplayName = rootDisplayName?.trimmedNonEmpty
            ?? (cleaned.isEmpty ? "Workspace" : URL(fileURLWithPath: cleaned).lastPathComponent)
    }

    struct Breadcrumb: Identifiable, Hashable {
        let id: String
        let title: String
        let path: String
    }

    var breadcrumbs: [Breadcrumb] {
        var crumbs = [Breadcrumb(id: rootPath.isEmpty ? "__root__" : rootPath, title: rootDisplayName, path: rootPath)]
        guard !currentPath.isEmpty, currentPath != rootPath else { return crumbs }

        let relative: String
        if !rootPath.isEmpty, currentPath.hasPrefix(rootPath + "/") {
            relative = String(currentPath.dropFirst(rootPath.count + 1))
        } else {
            relative = URL(fileURLWithPath: currentPath).lastPathComponent
        }

        var accumulated = rootPath
        for segment in relative.split(separator: "/").map(String.init) where !segment.isEmpty {
            accumulated = accumulated.isEmpty
                ? "/\(segment)"
                : URL(fileURLWithPath: accumulated).appendingPathComponent(segment).path
            crumbs.append(Breadcrumb(id: accumulated, title: segment, path: accumulated))
        }
        return crumbs
    }

    var showsTruncationBanner: Bool {
        searchText.trimmedNonEmpty == nil && listing?.truncated == true
    }

    var hiddenFolderCount: Int {
        entries.reduce(into: 0) { count, entry in
            if entry.isHiddenFolder { count += 1 }
        }
    }

    func displayedEntries(showingHiddenFolders: Bool) -> [CodexWorkspaceDirectoryEntry] {
        let visible = showingHiddenFolders ? entries : entries.filter { !$0.isHiddenFolder }
        guard let needle = searchText.trimmedNonEmpty?.lowercased() else { return visible }
        return visible.filter {
            $0.displayName.lowercased().contains(needle)
                || ($0.relativePath?.lowercased().contains(needle) ?? false)
        }
    }

    func loadIfNeeded() async {
        guard !hasLoadedCurrentPath else { return }
        await load(path: currentPath)
    }

    func navigate(to path: String) async {
        let cleaned = path.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard cleaned != currentPath || !hasLoadedCurrentPath else { return }
        searchText = ""
        currentPath = cleaned
        entries = []
        listing = nil
        await load(path: cleaned)
    }

    func refresh() async {
        await load(path: currentPath)
    }

    func loadMore() async {
        guard showsTruncationBanner, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let queryPath = currentPath.isEmpty ? nil : currentPath
        do {
            let next = try await client.fetchDirectory(path: queryPath, offset: entries.count, limit: Self.pageSize)
            guard currentPath == (queryPath ?? "") else { return }
            listing = next
            let existingIDs = Set(entries.map(\.id))
            entries.append(contentsOf: next.entries.filter { !existingIDs.contains($0.id) })
            errorMessage = nil
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func load(path: String) async {
        isLoading = true
        defer { isLoading = false }
        let queryPath = path.isEmpty ? nil : path
        do {
            let loaded = try await client.fetchDirectory(path: queryPath, offset: 0, limit: Self.pageSize)
            guard currentPath == path else { return }
            listing = loaded
            entries = loaded.entries
            hasLoadedCurrentPath = true
            errorMessage = nil
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct RelayExplorerFilesTab: View {
    @Environment(\.relayTheme) private var theme
    @StateObject private var viewModel: RelayExplorerFilesViewModel
    @AppStorage("relay.explorer.showsHiddenFolders") private var showsHiddenFolders = false
    @FocusState private var filterFocused: Bool

    let onSelectFile: (CodexWorkspaceDirectoryEntry) -> Void
    let onAttachFileToChat: (CodexWorkspaceDirectoryEntry) -> Void

    init(
        client: CodexClient,
        workspacePath: String,
        workspaceName: String?,
        onSelectFile: @escaping (CodexWorkspaceDirectoryEntry) -> Void,
        onAttachFileToChat: @escaping (CodexWorkspaceDirectoryEntry) -> Void
    ) {
        _viewModel = StateObject(
            wrappedValue: RelayExplorerFilesViewModel(
                client: client,
                rootPath: workspacePath,
                rootDisplayName: workspaceName
            )
        )
        self.onSelectFile = onSelectFile
        self.onAttachFileToChat = onAttachFileToChat
    }

    private var displayedEntries: [CodexWorkspaceDirectoryEntry] {
        viewModel.displayedEntries(showingHiddenFolders: showsHiddenFolders)
    }

    var body: some View {
        VStack(spacing: 0) {
            breadcrumbBar
            searchBar
            filesList
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.surface0)
        .task {
            await viewModel.loadIfNeeded()
        }
    }

    private var breadcrumbBar: some View {
        HStack(spacing: 4) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 5) {
                    ForEach(Array(viewModel.breadcrumbs.enumerated()), id: \.element.id) { index, crumb in
                        if index > 0 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(theme.foregroundExtraMuted)
                        }
                        let isLast = index == viewModel.breadcrumbs.count - 1
                        Button {
                            guard !isLast else { return }
                            Task { await viewModel.navigate(to: crumb.path) }
                        } label: {
                            HStack(spacing: 5) {
                                if index == 0 {
                                    Image(systemName: "folder")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(theme.foregroundMuted)
                                }
                                Text(crumb.title)
                                    .font(RelayTheme.monoFont(12, weight: isLast ? .medium : .regular))
                                    .foregroundStyle(isLast ? theme.foreground : theme.foregroundMuted)
                                    .lineLimit(1)
                            }
                            .frame(minHeight: 32)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isLast)
                    }
                }
                .padding(.leading, 12)
                .padding(.trailing, 4)
            }

            HStack(spacing: 2) {
                Button {
                    showsHiddenFolders.toggle()
                } label: {
                    Image(systemName: showsHiddenFolders ? "eye" : "eye.slash")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(showsHiddenFolders ? theme.foreground : theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .background(
                            showsHiddenFolders ? theme.interactionHighlight : Color.clear,
                            in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel(showsHiddenFolders ? "Hide hidden folders" : "Show hidden folders")

                Button {
                    Task { await viewModel.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isLoading)
                .opacity(viewModel.isLoading ? 0.45 : 1)
                .accessibilityLabel("Refresh folder")
            }
            .padding(.trailing, 8)
        }
        .frame(height: 38)
        .background(theme.surface0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private var searchBar: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(filterFocused ? theme.foreground : theme.foregroundMuted)
            TextField("Filter files…", text: $viewModel.searchText)
                .font(RelayTheme.uiFont(14))
                .foregroundStyle(theme.foreground)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .focused($filterFocused)
                .submitLabel(.done)
                .onSubmit { filterFocused = false }
            if !viewModel.searchText.isEmpty {
                Button { viewModel.searchText = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 14))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear filter")
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 36)
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(theme.border, lineWidth: 1)
        )
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private var filesList: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let error = viewModel.errorMessage {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 13))
                            .foregroundStyle(theme.statusDanger)
                        Text(error)
                            .font(RelayTheme.uiFont(12))
                            .foregroundStyle(theme.foreground)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        Button("Retry") {
                            Task { await viewModel.refresh() }
                        }
                        .font(RelayTheme.uiFont(12, weight: .medium))
                        .foregroundStyle(theme.accentBright)
                    }
                    .padding(12)
                    .background(theme.statusDangerTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                }

                if displayedEntries.isEmpty {
                    if viewModel.isLoading {
                        ProgressView()
                            .tint(theme.foregroundMuted)
                            .padding(.top, 56)
                    } else if viewModel.errorMessage == nil {
                        emptyFolderState
                    }
                } else {
                    ForEach(displayedEntries) { entry in
                        fileRow(entry)
                    }

                    if !showsHiddenFolders && viewModel.searchText.trimmedNonEmpty == nil && viewModel.hiddenFolderCount > 0 {
                        Button {
                            showsHiddenFolders = true
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: "eye.slash")
                                    .font(.system(size: 12))
                                Text(viewModel.hiddenFolderCount == 1 ? "1 hidden folder" : "\(viewModel.hiddenFolderCount) hidden folders")
                                    .font(RelayTheme.uiFont(12))
                            }
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                        }
                        .buttonStyle(.plain)
                    }

                    if viewModel.showsTruncationBanner {
                        Button {
                            Task { await viewModel.loadMore() }
                        } label: {
                            HStack(spacing: 8) {
                                if viewModel.isLoadingMore {
                                    ProgressView().controlSize(.small).tint(theme.foregroundMuted)
                                } else {
                                    Text("Load more files")
                                        .font(RelayTheme.uiFont(13, weight: .medium))
                                        .foregroundStyle(theme.accentBright)
                                }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                        }
                        .buttonStyle(.plain)
                        .disabled(viewModel.isLoadingMore)
                    }
                }
            }
            .padding(.bottom, 28)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable {
            await viewModel.refresh()
        }
    }

    private func fileRow(_ entry: CodexWorkspaceDirectoryEntry) -> some View {
        let icon = RelayFileIconResolver.resolve(for: entry, theme: theme)
        return Button {
            filterFocused = false
            if entry.isDirectory {
                UISelectionFeedbackGenerator().selectionChanged()
                Task { await viewModel.navigate(to: entry.path) }
            } else if !entry.readDenied {
                onSelectFile(entry)
            }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: icon.symbol)
                    .font(.system(size: 15, weight: entry.isDirectory ? .medium : .regular))
                    .foregroundStyle(icon.color)
                    .frame(width: 22)

                Text(entry.displayName)
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(entry.readDenied ? theme.foregroundExtraMuted : theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if entry.isDirectory {
                    if entry.hasGit {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 11))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                } else if entry.readDenied {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(theme.foregroundExtraMuted)
                } else if let sizeLabel = entry.sizeLabel {
                    Text(sizeLabel)
                        .font(RelayTheme.monoFont(11))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            .opacity(entry.readDenied ? 0.55 : 1)
        }
        .buttonStyle(RelayExplorerRowButtonStyle(highlight: theme.interactionHighlight))
        .contextMenu {
            if !entry.isDirectory && !entry.readDenied {
                Button {
                    onSelectFile(entry)
                } label: {
                    Label("Open file", systemImage: "doc.text")
                }
                Button {
                    onAttachFileToChat(entry)
                } label: {
                    Label("Add to chat", systemImage: "plus.bubble")
                }
            }
            Button {
                UIPasteboard.general.string = entry.path
            } label: {
                Label("Copy path", systemImage: "doc.on.doc")
            }
        }
    }

    private var emptyFolderState: some View {
        VStack(spacing: 10) {
            Image(systemName: viewModel.searchText.trimmedNonEmpty != nil ? "magnifyingglass" : "folder")
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
            Text(viewModel.searchText.trimmedNonEmpty != nil ? "No matching files" : "Empty folder")
                .font(RelayTheme.uiFont(15, weight: .medium))
                .foregroundStyle(theme.foreground)
            if viewModel.searchText.trimmedNonEmpty == nil && !showsHiddenFolders && viewModel.hiddenFolderCount > 0 {
                Button("Show hidden folders") {
                    showsHiddenFolders = true
                }
                .font(RelayTheme.uiFont(13, weight: .medium))
                .foregroundStyle(theme.accentBright)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 64)
        .padding(.horizontal, 28)
    }
}

private struct RelayExplorerRowButtonStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? highlight : Color.clear)
    }
}

// MARK: - Language-Colored File Icon Resolver

private enum RelayFileIconResolver {
    struct Icon {
        let symbol: String
        let color: Color
    }

    static func resolve(for entry: CodexWorkspaceDirectoryEntry, theme: RelayThemePalette) -> Icon {
        if entry.isDirectory {
            return Icon(
                symbol: "folder.fill",
                color: entry.isHiddenFolder ? theme.foregroundMuted : theme.accent
            )
        }
        if entry.readDenied {
            return Icon(symbol: "lock.doc", color: theme.foregroundExtraMuted)
        }
        return resolve(fileName: entry.displayName, category: entry.fileCategory, theme: theme)
    }

    static func resolve(fileName: String, category: CodexFileCategory? = nil, theme: RelayThemePalette) -> Icon {
        let ext = URL(fileURLWithPath: fileName).pathExtension.lowercased()
        switch ext {
        case "swift":
            return Icon(symbol: "swift", color: theme.syntaxOperator)
        case "ts", "tsx", "mts":
            return Icon(symbol: "curlybraces", color: theme.syntaxType)
        case "js", "jsx", "mjs", "cjs":
            return Icon(symbol: "curlybraces", color: theme.syntaxFunction)
        case "py", "pyi":
            return Icon(symbol: "chevron.left.forwardslash.chevron.right", color: theme.syntaxKeyword)
        case "go":
            return Icon(symbol: "cpu", color: theme.syntaxType)
        case "rs":
            return Icon(symbol: "gearshape.2", color: theme.syntaxString)
        case "c", "h", "cc", "cpp", "hpp", "m", "mm":
            return Icon(symbol: "chevron.left.forwardslash.chevron.right", color: theme.syntaxProperty)
        case "json", "jsonc", "yaml", "yml", "toml", "plist":
            return Icon(symbol: "doc.badge.gearshape", color: theme.syntaxNumber)
        case "sh", "bash", "zsh", "fish":
            return Icon(symbol: "terminal", color: theme.statusSuccess)
        case "md", "markdown", "mdx":
            return Icon(symbol: "doc.richtext", color: theme.syntaxProperty)
        case "html", "htm", "xml", "svg":
            return Icon(symbol: "globe", color: theme.syntaxString)
        case "css", "scss", "sass", "less":
            return Icon(symbol: "paintbrush", color: theme.syntaxKeyword)
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "ico":
            return Icon(symbol: "photo", color: theme.statusMerged)
        case "pdf":
            return Icon(symbol: "doc.text.image", color: theme.statusDanger)
        default:
            switch category {
            case .code: return Icon(symbol: "curlybraces", color: theme.syntaxType)
            case .markdown: return Icon(symbol: "doc.richtext", color: theme.syntaxProperty)
            case .image: return Icon(symbol: "photo", color: theme.statusMerged)
            case .pdf: return Icon(symbol: "doc.text.image", color: theme.statusDanger)
            case .text: return Icon(symbol: "doc.text", color: theme.foregroundMuted)
            case .binary, .none: return Icon(symbol: "doc", color: theme.foregroundMuted)
            }
        }
    }
}

// MARK: - Native Compact File Viewer Sheet

struct RelayWorkspaceFileSheet: View {
    @Environment(\.relayTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore
    let target: RelayWorkspaceFileTarget
    let onAttachToChat: (String) -> Void

    @State private var data = Data()
    @State private var text = ""
    @State private var lines: [String] = []
    @State private var image: UIImage?
    @State private var isLoading = false
    @State private var isLoadingMore = false
    @State private var hasMoreBytes = false
    @State private var errorMessage: String?
    @State private var wrapLines = false
    @State private var showRawMarkdown = false
    @State private var didCopy = false
    @State private var copyResetTask: Task<Void, Never>?

    private static let chunkByteCount: Int64 = 512 * 1024
    private static let gutterWidth: CGFloat = 44
    private static let lineHeight: CGFloat = 21
    private static let sliceSize = 60

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader
            sheetBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.surface0.ignoresSafeArea())
        .task(id: target.path) {
            guard !target.isWebRendered && !target.readDenied else { return }
            await loadFile()
        }
        .onDisappear {
            copyResetTask?.cancel()
        }
    }

    private var sheetHeader: some View {
        let icon = RelayFileIconResolver.resolve(fileName: target.displayName, theme: theme)
        return VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: icon.symbol)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(icon.color)
                    .frame(width: 22)

                VStack(alignment: .leading, spacing: 2) {
                    Text(target.displayName)
                        .font(RelayTheme.uiFont(15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    Text(target.relativePath)
                        .font(RelayTheme.monoFont(11))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .background(theme.surface2, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close file")
            }
            .padding(.horizontal, 14)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // Action strip
            HStack(spacing: 8) {
                Button {
                    let ref = RelayExplorerDrawerView.formatChatFileReference(
                        target.relativePath.trimmedNonEmpty ?? target.displayName
                    )
                    dismiss()
                    if !ref.isEmpty {
                        onAttachToChat(ref)
                    }
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "plus.bubble")
                            .font(.system(size: 12, weight: .medium))
                        Text("Add to chat")
                            .font(RelayTheme.uiFont(12, weight: .medium))
                    }
                    .foregroundStyle(theme.accentForeground)
                    .padding(.horizontal, 11)
                    .frame(height: 30)
                    .background(theme.accent, in: Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-file-sheet-add-to-chat")

                if !text.isEmpty {
                    Button {
                        UIPasteboard.general.string = text
                        didCopy = true
                        copyResetTask?.cancel()
                        copyResetTask = Task {
                            try? await Task.sleep(for: .seconds(1.5))
                            guard !Task.isCancelled else { return }
                            didCopy = false
                        }
                    } label: {
                        HStack(spacing: 5) {
                            Image(systemName: didCopy ? "checkmark" : "doc.on.doc")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(didCopy ? theme.statusSuccess : theme.foregroundMuted)
                            Text(didCopy ? "Copied" : "Copy")
                                .font(RelayTheme.uiFont(12, weight: .medium))
                                .foregroundStyle(theme.foreground)
                        }
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(theme.surface2, in: Capsule())
                    }
                    .buttonStyle(.plain)
                }

                Spacer(minLength: 4)

                if target.isMarkdown && !text.isEmpty {
                    Button {
                        showRawMarkdown.toggle()
                    } label: {
                        Image(systemName: showRawMarkdown ? "doc.richtext" : "curlybraces")
                            .font(.system(size: 13))
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(width: 30, height: 30)
                            .background(theme.surface2, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(showRawMarkdown ? "Show rendered markdown" : "Show raw markdown")
                }

                if !target.isImage && !target.isWebRendered && (!target.isMarkdown || showRawMarkdown) {
                    Button {
                        wrapLines.toggle()
                    } label: {
                        Image(systemName: "arrow.turn.down.left")
                            .font(.system(size: 13))
                            .foregroundStyle(wrapLines ? theme.foreground : theme.foregroundMuted)
                            .frame(width: 30, height: 30)
                            .background(
                                wrapLines ? theme.interactionHighlight : theme.surface2,
                                in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                            )
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(wrapLines ? "Disable line wrap" : "Wrap long lines")
                }
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 10)
        }
        .background(theme.surface0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    @ViewBuilder
    private var sheetBody: some View {
        if target.readDenied {
            placeholderView(
                symbol: "lock.doc",
                title: "File is not readable",
                message: "This file cannot be read from the phone."
            )
        } else if target.isWebRendered, let url = client.fileWebViewURL(path: target.path) {
            AuthenticatedWebView(url: url, title: target.displayName, identityStore: identityStore)
        } else if isLoading && data.isEmpty {
            VStack(spacing: 10) {
                ProgressView().tint(theme.foregroundMuted)
                Text("Loading file…")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let errorMessage, data.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 24))
                    .foregroundStyle(theme.statusDanger)
                Text("Couldn't open file")
                    .font(RelayTheme.uiFont(15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Text(errorMessage)
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
                    .multilineTextAlignment(.center)
                Button("Try again") {
                    Task { await loadFile() }
                }
                .font(RelayTheme.uiFont(13, weight: .medium))
                .foregroundStyle(theme.accentBright)
            }
            .padding(28)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if target.isImage, let image {
            ScrollView {
                VStack(spacing: 12) {
                    Image(uiImage: image)
                        .resizable()
                        .aspectRatio(contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .padding(16)
                    let pxW = Int((image.size.width * image.scale).rounded())
                    let pxH = Int((image.size.height * image.scale).rounded())
                    Text("\(pxW) × \(pxH) px · \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))")
                        .font(RelayTheme.monoFont(11))
                        .foregroundStyle(theme.foregroundMuted)
                }
                .frame(maxWidth: .infinity)
            }
        } else if looksBinary(data) && !target.isImage {
            placeholderView(
                symbol: "doc",
                title: "Binary file",
                message: target.sizeLabel ?? ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
            )
        } else if target.isMarkdown && !showRawMarkdown {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    RelayMarkdownText(text: text, userAligned: false)
                        .padding(16)
                    loadMoreFooter
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if text.isEmpty {
            placeholderView(symbol: "doc.text", title: "Empty file", message: target.relativePath)
        } else {
            codeBody
        }
    }

    private var codeBody: some View {
        GeometryReader { geometry in
            let codeMinWidth = max(120, geometry.size.width - Self.gutterWidth)
            ScrollView(.vertical, showsIndicators: true) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if wrapLines {
                        ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                            HStack(alignment: .top, spacing: 0) {
                                Text("\(index + 1)")
                                    .font(RelayTheme.monoFont(11))
                                    .monospacedDigit()
                                    .foregroundStyle(theme.foregroundExtraMuted)
                                    .frame(width: Self.gutterWidth - 10, alignment: .trailing)
                                    .padding(.trailing, 10)
                                    .padding(.top, 3)

                                Text(RelaySyntaxHighlighter.highlight(line: line, filePath: target.displayName, theme: theme))
                                    .font(RelayTheme.monoFont(12))
                                    .multilineTextAlignment(.leading)
                                    .fixedSize(horizontal: false, vertical: true)
                                    .padding(.leading, 6)
                                    .padding(.trailing, 12)
                                    .padding(.vertical, 2)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .frame(minHeight: Self.lineHeight)
                        }
                    } else {
                        let slices = chunkIndices(count: lines.count, size: Self.sliceSize)
                        ForEach(slices, id: \.lowerBound) { range in
                            HStack(alignment: .top, spacing: 0) {
                                VStack(alignment: .trailing, spacing: 0) {
                                    ForEach(range, id: \.self) { index in
                                        Text("\(index + 1)")
                                            .font(RelayTheme.monoFont(11))
                                            .monospacedDigit()
                                            .foregroundStyle(theme.foregroundExtraMuted)
                                            .frame(width: Self.gutterWidth - 10, height: Self.lineHeight, alignment: .trailing)
                                            .padding(.trailing, 10)
                                    }
                                }
                                .frame(width: Self.gutterWidth)
                                .overlay(alignment: .trailing) {
                                    Rectangle().fill(theme.border).frame(width: 1)
                                }

                                ScrollView(.horizontal, showsIndicators: false) {
                                    VStack(alignment: .leading, spacing: 0) {
                                        ForEach(range, id: \.self) { index in
                                            Text(RelaySyntaxHighlighter.highlight(line: lines[index], filePath: target.displayName, theme: theme))
                                                .font(RelayTheme.monoFont(12))
                                                .lineLimit(1)
                                                .fixedSize(horizontal: true, vertical: false)
                                                .padding(.leading, 8)
                                                .padding(.trailing, 16)
                                                .frame(minWidth: codeMinWidth, maxWidth: .infinity, minHeight: Self.lineHeight, maxHeight: Self.lineHeight, alignment: .leading)
                                        }
                                    }
                                    .frame(minWidth: codeMinWidth, alignment: .leading)
                                }
                            }
                        }
                    }

                    loadMoreFooter
                }
                .padding(.vertical, 8)
                .padding(.bottom, 24)
            }
        }
    }

    @ViewBuilder
    private var loadMoreFooter: some View {
        if hasMoreBytes {
            VStack(spacing: 6) {
                Text("Loaded \(ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file))")
                    .font(RelayTheme.uiFont(12))
                    .foregroundStyle(theme.foregroundMuted)
                Button {
                    Task { await loadMore() }
                } label: {
                    if isLoadingMore {
                        ProgressView().controlSize(.small).tint(theme.foregroundMuted)
                    } else {
                        Text("Load more")
                            .font(RelayTheme.uiFont(13, weight: .medium))
                            .foregroundStyle(theme.accentBright)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isLoadingMore)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .overlay(alignment: .top) {
                Rectangle().fill(theme.border).frame(height: 1)
            }
        }
    }

    private func placeholderView(symbol: String, title: String, message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 26, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
            Text(title)
                .font(RelayTheme.uiFont(15, weight: .medium))
                .foregroundStyle(theme.foreground)
            Text(message)
                .font(RelayTheme.monoFont(12))
                .foregroundStyle(theme.foregroundMuted)
                .multilineTextAlignment(.center)
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func loadFile() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await client.fetchFile(path: target.path)
            data = result.data
            hasMoreBytes = FileViewerViewModel.remainingBytesExist(
                responseTruncated: result.truncated,
                receivedByteCount: result.data.count,
                loadedByteCount: data.count,
                knownFileSize: target.size
            )
            errorMessage = nil
            applyDecodedContent()
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func loadMore() async {
        guard hasMoreBytes, !isLoadingMore else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let start = Int64(data.count)
        let range = start...(start + Self.chunkByteCount - 1)
        do {
            let result = try await client.fetchFile(path: target.path, range: range)
            data.append(result.data)
            hasMoreBytes = FileViewerViewModel.remainingBytesExist(
                responseTruncated: result.truncated,
                requestedByteCount: Self.chunkByteCount,
                receivedByteCount: result.data.count,
                loadedByteCount: data.count,
                knownFileSize: target.size
            )
            applyDecodedContent()
        } catch {
            if (error as? CodexClientError)?.statusCode == 416 {
                hasMoreBytes = false
                return
            }
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func applyDecodedContent() {
        if target.isImage {
            image = UIImage(data: data)
        } else if !looksBinary(data) {
            text = String(decoding: data, as: UTF8.self)
            lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        }
    }

    private func looksBinary(_ raw: Data) -> Bool {
        let sample = raw.prefix(4096)
        return sample.contains(0)
    }

    private func chunkIndices(count: Int, size: Int) -> [Range<Int>] {
        guard count > 0 else { return [] }
        var result: [Range<Int>] = []
        var start = 0
        while start < count {
            let end = min(start + size, count)
            result.append(start..<end)
            start = end
        }
        return result
    }
}

// MARK: - Previews Tab

private enum RelayExplorerPreviewCover: Identifiable {
    case artifact(CodexJobArtifact)
    case remotePreview(RelayRemotePreviewRequest)

    var id: String {
        switch self {
        case .artifact(let artifact):
            return "artifact:\(artifact.id)"
        case .remotePreview(let request):
            return "remote:\(request.id.uuidString)"
        }
    }
}

private struct RelayExplorerPreviewsTab: View {
    @Environment(\.relayTheme) private var theme

    @ObservedObject var model: RelayPreviewsModel
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore
    let workspaceID: String?
    let workspaceName: String?
    let workspaceAccessIsAvailable: Bool
    let onOpenJob: (CodexJob) -> Void

    @State private var activeCover: RelayExplorerPreviewCover?

    private var partitionedResults: (current: [WorkspacePreviewResult], other: [WorkspacePreviewResult]) {
        guard let all = model.results else { return ([], []) }
        let normalizedID = workspaceID?.trimmedNonEmpty
        let normalizedName = workspaceName?.trimmedNonEmpty?.lowercased()
        guard normalizedID != nil || normalizedName != nil else {
            return (all, [])
        }
        var current: [WorkspacePreviewResult] = []
        var other: [WorkspacePreviewResult] = []
        for item in all {
            let matchesID = normalizedID != nil && item.job.workspaceId == normalizedID
            let matchesName = normalizedName != nil && item.workspaceLabel.lowercased() == normalizedName
            if matchesID || matchesName {
                current.append(item)
            } else {
                other.append(item)
            }
        }
        return (current, other)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                if !workspaceAccessIsAvailable {
                    emptyState(
                        symbol: "desktopcomputer.trianglebadge.exclamationmark",
                        title: "Computer disconnected",
                        message: "Reconnect your machine to load workspace artifacts and live previews."
                    )
                } else if let results = model.results {
                    if let failure = model.failure, !model.isLoading {
                        failureBanner(failure)
                    }
                    if results.isEmpty {
                        emptyState(
                            symbol: "doc.richtext",
                            title: "No previews yet",
                            message: "Artifacts and localhost app previews generated by agent runs appear here."
                        )
                    } else {
                        let groups = partitionedResults
                        if !groups.current.isEmpty {
                            sectionTitle("This workspace")
                            ForEach(groups.current) { result in
                                previewCard(result)
                            }
                        }
                        if !groups.other.isEmpty {
                            sectionTitle(groups.current.isEmpty ? "Recent workspace outputs" : "Other workspaces")
                            ForEach(groups.other) { result in
                                previewCard(result)
                            }
                        }
                    }
                } else if let failure = model.failure, !model.isLoading {
                    VStack(spacing: 12) {
                        emptyState(
                            symbol: failure.isUnreachable ? "desktopcomputer.trianglebadge.exclamationmark" : "exclamationmark.triangle",
                            title: failure.title,
                            message: failure.message
                        )
                        Button {
                            Task { await model.refresh() }
                        } label: {
                            Text("Try again")
                                .font(RelayTheme.uiFont(13, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .padding(.horizontal, 16)
                                .frame(height: 36)
                                .background(theme.surface2, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    VStack(spacing: 10) {
                        ProgressView().tint(theme.foregroundMuted)
                        Text("Loading previews…")
                            .font(RelayTheme.uiFont(13))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 56)
                }
            }
            .padding(14)
            .padding(.bottom, 24)
        }
        .background(theme.surface0)
        .refreshable {
            guard workspaceAccessIsAvailable else { return }
            await model.refresh()
        }
        .fullScreenCover(item: $activeCover) { cover in
            switch cover {
            case .artifact(let artifact):
                RelayArtifactViewer(artifact: artifact, client: client, identityStore: identityStore)
            case .remotePreview(let request):
                RelayRemotePreviewViewer(request: request, client: client, identityStore: identityStore)
            }
        }
        .onChange(of: workspaceAccessIsAvailable) { _, available in
            guard !available else { return }
            activeCover = nil
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        HStack {
            Text(text)
                .font(RelayTheme.uiFont(12, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
            Spacer()
            if model.isLoading {
                ProgressView()
                    .controlSize(.mini)
                    .tint(theme.foregroundMuted)
            }
        }
        .padding(.top, 2)
    }

    private func failureBanner(_ failure: RelayPreviewsLoadFailure) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 13))
                .foregroundStyle(theme.statusWarning)
            Text(failure.message)
                .font(RelayTheme.uiFont(12))
                .foregroundStyle(theme.foregroundMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button("Retry") {
                Task { await model.refresh() }
            }
            .font(RelayTheme.uiFont(12, weight: .medium))
            .foregroundStyle(theme.accentBright)
        }
        .padding(10)
        .background(theme.statusWarningTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    private func previewCard(_ result: WorkspacePreviewResult) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(result.workspaceLabel)
                        .font(RelayTheme.monoFont(11, weight: .medium))
                        .foregroundStyle(theme.accentBright)
                    if let date = result.job.completedAt ?? result.job.updatedAt ?? result.job.createdAt {
                        Text("· \(date.formatted(date: .abbreviated, time: .shortened))")
                            .font(RelayTheme.uiFont(11))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                }
                Text(result.title)
                    .font(RelayTheme.uiFont(14, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(2)
            }
            .padding(12)

            ForEach(result.job.artifacts) { artifact in
                Rectangle().fill(theme.border).frame(height: 1)
                Button {
                    activeCover = .artifact(artifact)
                } label: {
                    previewRow(
                        symbol: "doc.richtext",
                        title: artifact.title?.trimmedNonEmpty ?? artifact.filename,
                        subtitle: artifact.filename
                    )
                }
                .buttonStyle(RelayExplorerRowButtonStyle(highlight: theme.interactionHighlight))
            }

            ForEach(result.liveURLs, id: \.absoluteString) { url in
                Rectangle().fill(theme.border).frame(height: 1)
                Button {
                    activeCover = .remotePreview(RelayRemotePreviewRequest(jobID: result.job.id, sourceURL: url))
                } label: {
                    previewRow(
                        symbol: "safari",
                        title: "Open live app",
                        subtitle: url.absoluteString
                    )
                }
                .buttonStyle(RelayExplorerRowButtonStyle(highlight: theme.interactionHighlight))
            }

            Rectangle().fill(theme.border).frame(height: 1)
            Button {
                onOpenJob(result.job)
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.text.bubble.right")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.foregroundMuted)
                    Text("Open source session")
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(RelayExplorerRowButtonStyle(highlight: theme.interactionHighlight))
        }
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(theme.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func previewRow(symbol: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(theme.foregroundMuted)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                Text(subtitle)
                    .font(RelayTheme.monoFont(11))
                    .foregroundStyle(theme.foregroundMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "arrow.up.right")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
    }

    private func emptyState(symbol: String, title: String, message: String) -> some View {
        VStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
            Text(title)
                .font(RelayTheme.uiFont(15, weight: .medium))
                .foregroundStyle(theme.foreground)
                .multilineTextAlignment(.center)
            Text(message)
                .font(RelayTheme.uiFont(13))
                .foregroundStyle(theme.foregroundMuted)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 56)
        .padding(.horizontal, 20)
    }
}
