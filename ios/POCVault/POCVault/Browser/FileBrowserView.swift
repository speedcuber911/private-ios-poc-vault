import SwiftUI
import UIKit

/// Compact native file browser, one tap from recent chats. Folder navigation,
/// file previews, and the current folder's new-chat action keep their existing routes.
struct FileBrowserView: View {
    @StateObject private var viewModel: FileBrowserViewModel
    private let isRoot: Bool
    private let machineLabel: String?
    private let onOpenFolder: (String) -> Void
    private let onOpenFile: (CodexWorkspaceDirectoryEntry) -> Void
    private let onOpenChat: (_ folderPath: String?, _ workspaceID: String?) -> Void
    private let onOpenConversation: (CodexThreadFeedItem) -> Void
    private let onOpenTerminal: (_ workspaceID: String, _ workspaceName: String) -> Void
    private let onOpenDiagnostics: (() -> Void)?

    @State private var showingCreateFolder = false
    @State private var newFolderName = ""
    @State private var showingConversations = true

    init(
        client: CodexClient,
        folderPath: String?,
        isRoot: Bool,
        machineLabel: String? = nil,
        onOpenFolder: @escaping (String) -> Void,
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
                if !isRoot {
                    Picker("Folder content", selection: $showingConversations) {
                        Text("Chats").tag(true)
                        Text("Files").tag(false)
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 8)
                }
                if !isRoot && showingConversations {
                    conversationList
                } else {
                    listContent
                }
            }
        }
        .navigationTitle(isRoot ? "Folders" : viewModel.folderName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .searchable(text: $viewModel.searchText, prompt: !isRoot && showingConversations ? "Search this folder’s chats" : "Search folders")
        .refreshable {
            await viewModel.refresh()
            if !isRoot { await viewModel.refreshConversations() }
        }
        .task {
            await viewModel.loadIfNeeded()
        }
        .task(id: viewModel.searchText) {
            guard isRoot || !showingConversations else { return }
            await viewModel.runSearchAfterDebounce()
        }
        .task(id: viewModel.listing?.selectedWorkspace?.id) {
            if !isRoot { await viewModel.refreshConversations() }
        }
        .onChange(of: showingConversations) { _, _ in
            viewModel.searchText = ""
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
            Button("Cancel", role: .cancel) {
                newFolderName = ""
            }
        } message: {
            Text("Create a folder inside \(viewModel.folderName).")
        }
    }

    // MARK: - List

    private var conversationList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let error = viewModel.conversationError ?? viewModel.errorMessage {
                    FileBrowserErrorBanner(text: error)
                        .padding(18)
                    Button("Try again") {
                        Task {
                            await viewModel.loadIfNeeded()
                            await viewModel.refreshConversations()
                        }
                    }
                    .padding(.horizontal, 18)
                } else if viewModel.isLoading || viewModel.isLoadingConversations {
                    ProgressView("Loading chats…")
                        .frame(maxWidth: .infinity)
                        .padding(.top, 64)
                } else if filteredConversations.isEmpty {
                    VStack(spacing: 12) {
                        Text(viewModel.searchText.isEmpty ? "No chats in this folder yet" : "No matching chats")
                            .font(.title3.weight(.medium))
                        Text("Saved Codex conversations on this machine appear here alongside chats started in Relay.")
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.textPrimary.opacity(0.7))
                        if viewModel.searchText.isEmpty {
                            Button("New chat") {
                                onOpenChat(viewModel.path, viewModel.listing?.selectedWorkspace?.id)
                            }
                            .buttonStyle(RelayOutlineButtonStyle())
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 28)
                    .padding(.top, 56)
                } else {
                    ForEach(filteredConversations) { item in
                        Button { onOpenConversation(item) } label: {
                            RelayConversationRow(item: item)
                                .padding(.horizontal, 18)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.bottom, 20)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var filteredConversations: [CodexThreadFeedItem] {
        let query = viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return viewModel.conversations.filter { query.isEmpty || $0.title.localizedCaseInsensitiveContains(query) }
    }

    private var listContent: some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                if let error = viewModel.errorMessage {
                    FileBrowserErrorBanner(text: error)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                }

                if viewModel.visibleEntries.isEmpty {
                    if viewModel.isLoading || viewModel.isSearching {
                        ProgressView()
                            .tint(AppTheme.accent)
                            .padding(.top, 64)
                    } else if viewModel.errorMessage == nil {
                        emptyState
                    }
                } else {
                    ForEach(viewModel.visibleEntries) { entry in
                        entryRow(entry)
                    }
                }

                if viewModel.showsTruncationBanner {
                    truncationRow
                }
            }
            .padding(.top, 4)
            .padding(.bottom, 32)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private func entryRow(_ entry: CodexWorkspaceDirectoryEntry) -> some View {
        Button {
            open(entry)
        } label: {
            FileBrowserRow(entry: entry)
        }
        .buttonStyle(FileBrowserRowButtonStyle())
        .contextMenu {
            contextMenuItems(for: entry)
        }
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
                onOpenChat(entry.path, entry.workspaceId)
            } label: {
                Label("New chat in folder", systemImage: "square.and.pencil")
            }
        } else if !entry.readDenied {
            Button {
                onOpenFile(entry)
            } label: {
                Label("View", systemImage: "eye")
            }
        }
        Button {
            UIPasteboard.general.string = entry.path
        } label: {
            Label("Copy path", systemImage: "doc.on.doc")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: viewModel.isShowingSearchResults ? "magnifyingglass" : "folder")
                .font(.system(size: 30, weight: .medium))
                .foregroundStyle(AppTheme.textTertiary)
            Text(viewModel.isShowingSearchResults ? "No matches" : "Empty folder")
                .font(.title3.weight(.medium))
                .foregroundStyle(AppTheme.textPrimary)
            Text(viewModel.isShowingSearchResults
                 ? "No folders match \u{201C}\(viewModel.searchText)\u{201D}."
                 : "Create a folder here or open the chat to have an agent add files.")
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 72)
    }

    private var truncationRow: some View {
        VStack(spacing: 8) {
            Text(viewModel.truncationLabel)
                .font(AppTheme.uiFont(size: 12))
                .foregroundStyle(AppTheme.textSecondary)
            Button {
                Task { await viewModel.loadMore() }
            } label: {
                if viewModel.isLoadingMore {
                    ProgressView()
                        .controlSize(.small)
                        .tint(AppTheme.accent)
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
            Rectangle()
                .fill(AppTheme.hairline)
                .frame(height: 0.5)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 2) {
                Text(isRoot ? "Folders" : viewModel.folderName)
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
            Button {
                onOpenChat(viewModel.path, viewModel.listing?.selectedWorkspace?.id)
            } label: {
                Image(systemName: "square.and.pencil")
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("New chat in this folder")
            .accessibilityIdentifier("relay-open-chat")
        }

        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                if let workspace = viewModel.listing?.selectedWorkspace {
                    Button {
                        onOpenTerminal(workspace.id, workspace.name)
                    } label: {
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

                if isRoot {
                    Divider()
                    if let onOpenDiagnostics {
                        Button {
                            onOpenDiagnostics()
                        } label: {
                            Label("Diagnostics", systemImage: "stethoscope")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(minWidth: 44, minHeight: 44)
            }
            .accessibilityLabel("Folder options")
        }
    }
}

/// Standard row press feedback: a subtle full-row highlight while touched, matching
/// the system list/Files-app press state that `.plain` suppresses on custom rows.
private struct FileBrowserRowButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? AppTheme.textPrimary.opacity(0.07) : Color.clear)
    }
}

/// A quiet folder/file row. Type is carried by the symbol; metadata only appears
/// when it adds information, rather than repeating "Folder" underneath every name.
private struct FileBrowserRow: View {
    let entry: CodexWorkspaceDirectoryEntry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: entry.browserGlyph)
                .font(.system(size: 19, weight: .regular))
                .foregroundStyle(AppTheme.textPrimary.opacity(0.65))
                .frame(width: 24)

            VStack(alignment: .leading, spacing: 3) {
                Text(entry.displayName)
                    .font(.custom("DMSans-9ptRegular", size: 16, relativeTo: .body))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 1)
                if let subtitle {
                    Text(subtitle)
                        .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption))
                        .foregroundStyle(AppTheme.textPrimary.opacity(0.65))
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if entry.isDirectory {
                Image(systemName: "chevron.right")
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary.opacity(0.45))
            }
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 11)
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .opacity(entry.readDenied ? 0.5 : 1)
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String? {
        if entry.isDirectory {
            return entry.hasGit ? "Git repository" : nil
        }
        if entry.readDenied {
            return "Not readable from the phone"
        }
        let parts = [entry.sizeLabel, entry.mtimeLabel].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

private struct FileBrowserErrorBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .font(AppTheme.uiFont(size: 13))
            .foregroundStyle(AppTheme.statusError)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(AppTheme.statusError.opacity(0.3), lineWidth: 1)
            }
    }
}

extension CodexWorkspaceDirectoryEntry {
    /// Per-type SF Symbol used by browser rows and the file viewer.
    var browserGlyph: String {
        if isDirectory {
            return hasGit ? "arrow.triangle.branch" : "folder.fill"
        }
        if readDenied {
            return "lock.doc"
        }
        switch fileCategory {
        case .code:
            return "curlybraces"
        case .text:
            return "doc.text"
        case .markdown:
            return "doc.richtext"
        case .image:
            return "photo"
        case .pdf:
            return "doc.text.image"
        case .binary:
            return "doc"
        }
    }
}
