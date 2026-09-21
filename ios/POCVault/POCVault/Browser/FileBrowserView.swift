import SwiftUI
import UIKit

private enum FileBrowserSection: String, CaseIterable, Hashable {
    case files
    case chats

    var title: String { self == .files ? "Files" : "Chats" }
    var systemImage: String { self == .files ? "doc.on.doc" : "bubble.left.and.bubble.right" }
}

private struct FileBrowserBreadcrumb: Identifiable {
    let id: String
    let label: String
    let path: String?
}

/// A phone-sized code explorer. Files stay in front while drilling through folders;
/// the folder's conversations remain one compact tab away instead of taking over each
/// newly pushed screen.
struct FileBrowserView: View {
    @StateObject private var viewModel: FileBrowserViewModel
    private let isRoot: Bool
    private let machineLabel: String?
    private let onOpenFolder: (String) -> Void
    private let onNavigateToFolder: (String?) -> Void
    private let onOpenFile: (CodexWorkspaceDirectoryEntry) -> Void
    private let onOpenChat: (_ folderPath: String?, _ workspaceID: String?) -> Void
    private let onOpenConversation: (CodexThreadFeedItem) -> Void
    private let onOpenTerminal: (_ workspaceID: String, _ workspaceName: String) -> Void
    private let onOpenDiagnostics: (() -> Void)?

    @State private var showingCreateFolder = false
    @State private var newFolderName = ""
    @State private var selectedSection = FileBrowserSection.files
    @FocusState private var filterIsFocused: Bool
    @AppStorage("relay.fileBrowser.showsHiddenFolders") private var showsHiddenFolders = false

    init(
        client: CodexClient,
        folderPath: String?,
        isRoot: Bool,
        machineLabel: String? = nil,
        onOpenFolder: @escaping (String) -> Void,
        onNavigateToFolder: @escaping (String?) -> Void,
        onOpenFile: @escaping (CodexWorkspaceDirectoryEntry) -> Void,
        onOpenChat: @escaping (_ folderPath: String?, _ workspaceID: String?) -> Void,
        onOpenConversation: @escaping (CodexThreadFeedItem) -> Void,
        onOpenTerminal: @escaping (_ workspaceID: String, _ workspaceName: String) -> Void,
        onOpenDiagnostics: (() -> Void)? = nil
    ) {
        _viewModel = StateObject(wrappedValue: FileBrowserViewModel(client: client, path: folderPath))
        self.isRoot = isRoot
        self.machineLabel = machineLabel
        self.onOpenFolder = onOpenFolder
        self.onNavigateToFolder = onNavigateToFolder
        self.onOpenFile = onOpenFile
        self.onOpenChat = onOpenChat
        self.onOpenConversation = onOpenConversation
        self.onOpenTerminal = onOpenTerminal
        self.onOpenDiagnostics = onOpenDiagnostics
    }

    var body: some View {
        ZStack {
            AppTheme.bgCanvas.ignoresSafeArea()
            VStack(spacing: 0) {
                explorerControls
                if activeSection == .chats {
                    conversationList
                } else {
                    listContent
                }
            }
        }
        .navigationTitle(isRoot ? "Explorer" : viewModel.folderName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbarBackground(AppTheme.canvasBottom, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .refreshable {
            await viewModel.refresh()
            if activeSection == .chats { await viewModel.refreshConversations() }
        }
        .task { await viewModel.loadIfNeeded() }
        .task(id: activeSection) {
            if activeSection == .chats { await viewModel.refreshConversations() }
        }
        .onChange(of: selectedSection) { _, _ in
            viewModel.searchText = ""
            filterIsFocused = false
        }
        .alert("New folder", isPresented: $showingCreateFolder) {
            TextField("folder-name", text: $newFolderName)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Create") {
                let name = newFolderName
                newFolderName = ""
                Task { await viewModel.createFolder(named: name) }
            }
            Button("Cancel", role: .cancel) { newFolderName = "" }
        } message: {
            Text("Create a folder inside \(viewModel.folderName).")
        }
    }

    private var activeSection: FileBrowserSection { isRoot ? .files : selectedSection }

    // MARK: - Explorer controls

    private var explorerControls: some View {
        VStack(spacing: 0) {
            pathBar
            if !isRoot { sectionSwitcher }
            filterField
        }
        .background(AppTheme.canvasBottom)
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
        }
    }

    private var pathBar: some View {
        HStack(spacing: 6) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(breadcrumbs.enumerated()), id: \.element.id) { index, crumb in
                        if index > 0 {
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                                .foregroundStyle(AppTheme.textFaint)
                        }
                        Button { onNavigateToFolder(crumb.path) } label: {
                            HStack(spacing: 6) {
                                if index == 0 {
                                    Image(systemName: "folder")
                                        .font(.system(size: 13, weight: .medium))
                                }
                                if !crumb.label.isEmpty { Text(crumb.label).lineLimit(1) }
                            }
                            .font(AppTheme.monoFont(
                                size: 12,
                                weight: index == breadcrumbs.count - 1 ? .semibold : .regular
                            ))
                            .foregroundStyle(index == breadcrumbs.count - 1 ? AppTheme.textPrimary : AppTheme.textSecondary)
                            .frame(minHeight: 36)
                        }
                        .buttonStyle(.plain)
                        .disabled(index == breadcrumbs.count - 1)
                    }
                }
                .padding(.leading, 16)
            }
            folderOptionsMenu.padding(.trailing, 6)
        }
        .frame(height: 38)
    }

    private var sectionSwitcher: some View {
        HStack(spacing: 24) {
            ForEach(FileBrowserSection.allCases, id: \.self) { section in
                Button {
                    withAnimation(.easeOut(duration: 0.18)) { selectedSection = section }
                } label: {
                    HStack(spacing: 7) {
                        Image(systemName: section.systemImage)
                            .font(.system(size: 13, weight: .medium))
                        Text(section.title)
                            .font(AppTheme.uiFont(size: 14, weight: selectedSection == section ? .semibold : .regular))
                        if let count = itemCount(for: section) {
                            Text(String(count))
                                .font(AppTheme.monoFont(size: 10, weight: .medium))
                                .foregroundStyle(AppTheme.textTertiary)
                        }
                    }
                    .foregroundStyle(selectedSection == section ? AppTheme.textPrimary : AppTheme.textSecondary)
                    .frame(minHeight: 40)
                    .overlay(alignment: .bottom) {
                        Rectangle()
                            .fill(selectedSection == section ? AppTheme.accent : Color.clear)
                            .frame(height: 2)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier(section == .files ? "relay-folder-files" : "relay-folder-chats")
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
        }
    }

    private var filterField: some View {
        HStack(spacing: 8) {
            HStack(spacing: 9) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(filterIsFocused ? AppTheme.textSecondary : AppTheme.textTertiary)
                TextField(filterPrompt, text: $viewModel.searchText)
                    .font(AppTheme.uiFont(size: 15))
                    .foregroundStyle(AppTheme.textPrimary)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .focused($filterIsFocused)
                    .submitLabel(.done)
                    .onSubmit { filterIsFocused = false }
                if !viewModel.searchText.isEmpty {
                    Button { viewModel.searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 15))
                            .foregroundStyle(AppTheme.textTertiary)
                            .frame(width: 32, height: 32)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear filter")
                }
            }
            .padding(.leading, 12)
            .padding(.trailing, viewModel.searchText.isEmpty ? 12 : 4)
            .frame(height: 40)
            .background(AppTheme.textPrimary.opacity(0.045), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(filterIsFocused ? AppTheme.hairlineStrong : AppTheme.hairline, lineWidth: 1)
            }

            if activeSection == .files {
                hiddenFoldersToggle
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }

    private var hiddenFoldersToggle: some View {
        Button {
            showsHiddenFolders.toggle()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: showsHiddenFolders ? "eye" : "eye.slash")
                    .font(.system(size: 12, weight: .semibold))
                Text("Hidden")
                    .font(AppTheme.uiFont(size: 12, weight: .semibold))
            }
            .foregroundStyle(showsHiddenFolders ? AppTheme.textPrimary : AppTheme.textTertiary)
            .padding(.horizontal, 10)
            .frame(height: 40)
            .background(
                AppTheme.textPrimary.opacity(showsHiddenFolders ? 0.10 : 0.045),
                in: RoundedRectangle(cornerRadius: 10, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(showsHiddenFolders ? AppTheme.hairlineStrong : AppTheme.hairline, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(showsHiddenFolders ? "Hide hidden folders" : "Show hidden folders")
        .accessibilityAddTraits(showsHiddenFolders ? [.isSelected] : [])
        .accessibilityIdentifier("relay-folder-show-hidden")
    }

    private var filterPrompt: String {
        activeSection == .chats ? "Search this folder’s chats" : "Filter this folder"
    }

    private var displayedEntries: [CodexWorkspaceDirectoryEntry] {
        viewModel.displayedEntries(showingHiddenFolders: showsHiddenFolders)
    }

    private var hiddenFoldersCountLabel: String {
        let count = viewModel.hiddenFolderCount
        return count == 1 ? "1 hidden folder" : "\(count) hidden folders"
    }

    private func itemCount(for section: FileBrowserSection) -> Int? {
        switch section {
        case .files:
            return viewModel.listing == nil ? nil : displayedEntries.count
        case .chats:
            guard !viewModel.isLoadingConversations else { return nil }
            return viewModel.conversations.isEmpty ? nil : viewModel.conversations.count
        }
    }

    private var breadcrumbs: [FileBrowserBreadcrumb] {
        var result = [FileBrowserBreadcrumb(id: "browser-root", label: isRoot ? "Workspaces" : "", path: nil)]
        guard !isRoot else { return result }
        if let listing = viewModel.listing,
           let relativePath = listing.relativePath?.trimmedNonEmpty {
            var accumulatedPath = listing.rootPath
            for segment in relativePath.split(separator: "/").map(String.init) {
                accumulatedPath = URL(fileURLWithPath: accumulatedPath).appendingPathComponent(segment).path
                result.append(FileBrowserBreadcrumb(id: accumulatedPath, label: segment, path: accumulatedPath))
            }
        } else if let path = viewModel.path {
            result.append(FileBrowserBreadcrumb(id: path, label: viewModel.folderName, path: path))
        }
        return result
    }

    // MARK: - Chats

    private var conversationList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let error = viewModel.conversationError ?? viewModel.errorMessage {
                    FileBrowserErrorBanner(text: error)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                    Button("Try again") {
                        Task {
                            await viewModel.loadIfNeeded()
                            await viewModel.refreshConversations()
                        }
                    }
                    .font(AppTheme.uiFont(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.statusError)
                    .padding(.horizontal, 18)
                    .padding(.top, 10)
                } else if viewModel.isLoading || viewModel.isResolvingWorkspace || viewModel.isLoadingConversations {
                    ProgressView("Loading chats…")
                        .tint(AppTheme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 64)
                } else if filteredConversations.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: viewModel.searchText.isEmpty ? "bubble.left" : "magnifyingglass")
                            .font(.system(size: 26, weight: .regular))
                            .foregroundStyle(AppTheme.textTertiary)
                        Text(viewModel.searchText.isEmpty ? "No chats in this folder" : "No matching chats")
                            .font(AppTheme.uiFont(size: 17, weight: .medium))
                            .foregroundStyle(AppTheme.textPrimary)
                        if viewModel.searchText.isEmpty {
                            Button("Start a chat") {
                                onOpenChat(viewModel.path, viewModel.workspace?.id)
                            }
                            .font(AppTheme.uiFont(size: 14, weight: .semibold))
                            .foregroundStyle(AppTheme.accentBright)
                            .padding(.top, 2)
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 28)
                    .padding(.top, 58)
                } else {
                    ForEach(filteredConversations) { item in
                        Button { onOpenConversation(item) } label: {
                            RelayConversationRow(item: item).padding(.horizontal, 18)
                        }
                        .buttonStyle(FileBrowserRowButtonStyle())
                    }
                }
            }
            .padding(.bottom, 20)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var filteredConversations: [CodexThreadFeedItem] {
        guard let query = viewModel.searchText.trimmedNonEmpty else { return viewModel.conversations }
        return viewModel.conversations.filter { $0.title.localizedCaseInsensitiveContains(query) }
    }

    // MARK: - Files

    private var listContent: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let error = viewModel.errorMessage {
                    FileBrowserErrorBanner(text: error)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                }
                if displayedEntries.isEmpty {
                    if viewModel.isLoading {
                        ProgressView().tint(AppTheme.accent).padding(.top, 64)
                    } else if viewModel.errorMessage == nil {
                        emptyState
                    }
                } else {
                    ForEach(displayedEntries) { entry in entryRow(entry) }
                    if showsHiddenFoldersFooter { hiddenFoldersRow }
                }
                if viewModel.showsTruncationBanner { truncationRow }
            }
            .padding(.top, 4)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func entryRow(_ entry: CodexWorkspaceDirectoryEntry) -> some View {
        Button { open(entry) } label: { FileBrowserRow(entry: entry) }
            .buttonStyle(FileBrowserRowButtonStyle())
            .contextMenu { contextMenuItems(for: entry) }
    }

    private func open(_ entry: CodexWorkspaceDirectoryEntry) {
        if entry.isDirectory {
            UISelectionFeedbackGenerator().selectionChanged()
            onOpenFolder(entry.path)
            return
        }
        guard !entry.readDenied else { return }
        onOpenFile(entry)
    }

    @ViewBuilder
    private func contextMenuItems(for entry: CodexWorkspaceDirectoryEntry) -> some View {
        if entry.isDirectory {
            Button {
                // A described dynamic id is not necessarily registered. The folder path
                // lets the chat register it safely on first use.
                onOpenChat(entry.path, entry.isRegistered ? entry.workspaceId : nil)
            } label: {
                Label("New chat in folder", systemImage: "square.and.pencil")
            }
        } else if !entry.readDenied {
            Button { onOpenFile(entry) } label: { Label("View", systemImage: "eye") }
        }
        Button { UIPasteboard.general.string = entry.path } label: {
            Label("Copy path", systemImage: "doc.on.doc")
        }
    }

    private var emptyState: some View {
        Group {
            if !viewModel.isShowingSearchResults && !showsHiddenFolders && viewModel.hiddenFolderCount > 0 {
                Button { showsHiddenFolders = true } label: {
                    VStack(spacing: 10) {
                        Image(systemName: "eye.slash")
                            .font(.system(size: 27, weight: .regular))
                            .foregroundStyle(AppTheme.textTertiary)
                        Text(hiddenFoldersCountLabel)
                            .font(AppTheme.uiFont(size: 17, weight: .medium))
                            .foregroundStyle(AppTheme.textPrimary)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Show \(hiddenFoldersCountLabel)")
                .accessibilityIdentifier("relay-folder-show-hidden-empty")
            } else {
                VStack(spacing: 10) {
                    Image(systemName: viewModel.isShowingSearchResults ? "magnifyingglass" : "folder")
                        .font(.system(size: 27, weight: .regular))
                        .foregroundStyle(AppTheme.textTertiary)
                    Text(viewModel.isShowingSearchResults ? "No matches" : "Empty folder")
                        .font(AppTheme.uiFont(size: 17, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(viewModel.isShowingSearchResults
                         ? "Nothing here matches \u{201C}\(viewModel.searchText)\u{201D}."
                         : "Create a folder or ask an agent to add files here.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                        .multilineTextAlignment(.center)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 72)
    }

    private var showsHiddenFoldersFooter: Bool {
        !showsHiddenFolders
            && !viewModel.isShowingSearchResults
            && viewModel.hiddenFolderCount > 0
    }

    private var hiddenFoldersRow: some View {
        Button { showsHiddenFolders = true } label: {
            HStack(spacing: 8) {
                Image(systemName: "eye.slash")
                    .font(.system(size: 12, weight: .medium))
                Text(hiddenFoldersCountLabel)
                    .font(AppTheme.uiFont(size: 12, weight: .medium))
            }
            .foregroundStyle(AppTheme.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
        }
        .accessibilityLabel("Show \(hiddenFoldersCountLabel)")
        .accessibilityIdentifier("relay-folder-show-hidden-footer")
    }

    private var truncationRow: some View {
        VStack(spacing: 8) {
            Text(viewModel.truncationLabel)
                .font(AppTheme.uiFont(size: 12))
                .foregroundStyle(AppTheme.textSecondary)
            Button { Task { await viewModel.loadMore() } } label: {
                if viewModel.isLoadingMore {
                    ProgressView().controlSize(.small).tint(AppTheme.accent)
                } else {
                    Text("Load more")
                        .font(AppTheme.uiFont(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                }
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isLoadingMore)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .overlay(alignment: .top) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
        }
    }

    // MARK: - Actions

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(isRoot ? "Explorer" : viewModel.folderName)
                    .font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .headline).weight(.semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                if isRoot, let machineLabel {
                    Text(machineLabel)
                        .font(.custom("DMSans-9ptRegular", size: 11, relativeTo: .caption))
                        .foregroundStyle(AppTheme.textPrimary.opacity(0.65))
                        .lineLimit(1)
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { onOpenChat(viewModel.path, viewModel.workspace?.id) } label: {
                Image(systemName: "square.and.pencil")
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("New chat in this folder")
            .accessibilityIdentifier("relay-open-chat")
        }
    }

    private var folderOptionsMenu: some View {
        Menu {
            if let workspace = viewModel.workspace {
                Button { onOpenTerminal(workspace.id, workspace.name) } label: {
                    Label("Open terminal", systemImage: "terminal")
                }
                .accessibilityIdentifier("relay-open-terminal")
            }
            Button {
                newFolderName = ""
                showingCreateFolder = true
            } label: {
                Label("New folder", systemImage: "folder.badge.plus")
            }
            Toggle("Show hidden folders", isOn: $showsHiddenFolders)
            if isRoot {
                Divider()
                if let onOpenDiagnostics {
                    Button { onOpenDiagnostics() } label: {
                        Label("Diagnostics", systemImage: "stethoscope")
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 40, height: 36)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("Folder options")
    }
}

private struct FileBrowserRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AppTheme.textPrimary.opacity(0.07) : Color.clear)
    }
}

/// Compact explorer row inspired by code editors: disclosure, type glyph, filename and
/// only the metadata useful while scanning. The whole 46pt row remains the tap target.
private struct FileBrowserRow: View {
    let entry: CodexWorkspaceDirectoryEntry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if entry.isDirectory {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                } else {
                    Color.clear
                }
            }
            .foregroundStyle(AppTheme.textTertiary)
            .frame(width: 12, height: 20)

            Image(systemName: entry.browserGlyph)
                .font(.system(size: 16, weight: entry.isDirectory ? .medium : .regular))
                .foregroundStyle(entry.isDirectory ? AppTheme.accentBright.opacity(0.85) : AppTheme.textSecondary)
                .frame(width: 22)

            Text(entry.displayName)
                .font(AppTheme.uiFont(size: 15, weight: entry.isDirectory ? .medium : .regular))
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                .frame(maxWidth: .infinity, alignment: .leading)

            if entry.hasGit {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.textTertiary)
                    .accessibilityLabel("Git repository")
            } else if entry.readDenied {
                Image(systemName: "lock.fill")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(AppTheme.textTertiary)
                    .accessibilityLabel("Not readable from the phone")
            } else if !dynamicTypeSize.isAccessibilitySize, let size = entry.sizeLabel {
                Text(size)
                    .font(AppTheme.monoFont(size: 10))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: dynamicTypeSize.isAccessibilitySize ? 54 : 46)
        .contentShape(Rectangle())
        .opacity(entry.readDenied ? 0.55 : 1)
        .accessibilityElement(children: .combine)
    }
}

private struct FileBrowserErrorBanner: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 13, weight: .semibold))
                .padding(.top, 1)
            Text(text)
                .font(AppTheme.uiFont(size: 13))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .foregroundStyle(AppTheme.statusError)
        .padding(.horizontal, 12)
        .padding(.vertical, 11)
        .background(AppTheme.statusError.opacity(0.07))
        .overlay(alignment: .leading) {
            Rectangle().fill(AppTheme.statusError.opacity(0.7)).frame(width: 2)
        }
    }
}

extension CodexWorkspaceDirectoryEntry {
    /// Per-type SF Symbol used by browser rows and the file viewer.
    var browserGlyph: String {
        if isDirectory { return "folder.fill" }
        if readDenied { return "lock.doc" }
        switch fileCategory {
        case .code: return "curlybraces"
        case .text: return "doc.text"
        case .markdown: return "doc.richtext"
        case .image: return "photo"
        case .pdf: return "doc.text.image"
        case .binary: return "doc"
        }
    }
}
