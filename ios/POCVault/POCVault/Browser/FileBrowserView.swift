import SwiftUI
import UIKit

/// One folder screen of the workspace file browser — the app's root surface.
///
/// Rows are full-width with hairline dividers on the warm canvas gradient for a
/// Files-app feel. Folders drill in, files route to the viewer, the terminal toolbar
/// icon opens this folder's chat cover, and the root screen additionally exposes
/// Library / Status / Diagnostics behind the ellipsis menu.
struct FileBrowserView: View {
    @StateObject private var viewModel: FileBrowserViewModel
    private let isRoot: Bool
    private let onOpenFolder: (String) -> Void
    private let onOpenFile: (CodexWorkspaceDirectoryEntry) -> Void
    private let onOpenChat: (_ folderPath: String?, _ workspaceID: String?) -> Void
    private let onOpenLibrary: (() -> Void)?
    private let onOpenStatus: (() -> Void)?
    private let onOpenDiagnostics: (() -> Void)?

    @State private var showingCreateFolder = false
    @State private var newFolderName = ""

    init(
        client: CodexClient,
        folderPath: String?,
        isRoot: Bool,
        onOpenFolder: @escaping (String) -> Void,
        onOpenFile: @escaping (CodexWorkspaceDirectoryEntry) -> Void,
        onOpenChat: @escaping (_ folderPath: String?, _ workspaceID: String?) -> Void,
        onOpenLibrary: (() -> Void)? = nil,
        onOpenStatus: (() -> Void)? = nil,
        onOpenDiagnostics: (() -> Void)? = nil
    ) {
        _viewModel = StateObject(wrappedValue: FileBrowserViewModel(client: client, path: folderPath))
        self.isRoot = isRoot
        self.onOpenFolder = onOpenFolder
        self.onOpenFile = onOpenFile
        self.onOpenChat = onOpenChat
        self.onOpenLibrary = onOpenLibrary
        self.onOpenStatus = onOpenStatus
        self.onOpenDiagnostics = onOpenDiagnostics
    }

    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()
            listContent
        }
        .navigationTitle(viewModel.folderName)
        .navigationBarTitleDisplayMode(isRoot ? .large : .inline)
        .toolbar { toolbarContent }
        .searchable(text: $viewModel.searchText, prompt: "Search folders")
        .refreshable {
            await viewModel.refresh()
        }
        .task {
            await viewModel.loadIfNeeded()
        }
        .task(id: viewModel.searchText) {
            await viewModel.runSearchAfterDebounce()
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
                    .overlay(alignment: .top) {
                        Rectangle()
                            .fill(AppTheme.strokeSubtle)
                            .frame(height: 0.5)
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
                Label("Open chat here", systemImage: "apple.terminal")
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
                .font(AppTheme.uiFont(size: 16, weight: .semibold))
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
                .fill(AppTheme.strokeSubtle)
                .frame(height: 0.5)
        }
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                onOpenChat(viewModel.path, viewModel.listing?.selectedWorkspace?.id)
            } label: {
                Image(systemName: "apple.terminal")
            }
            .accessibilityLabel("Open chat for this folder")
            .accessibilityIdentifier("relay-open-chat")
        }

        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    newFolderName = ""
                    showingCreateFolder = true
                } label: {
                    Label("New folder", systemImage: "folder.badge.plus")
                }

                if isRoot {
                    Divider()
                    if let onOpenLibrary {
                        Button {
                            onOpenLibrary()
                        } label: {
                            Label("Library", systemImage: "square.grid.2x2")
                        }
                    }
                    if let onOpenStatus {
                        Button {
                            onOpenStatus()
                        } label: {
                            Label("Status", systemImage: "waveform.path.ecg")
                        }
                    }
                    if let onOpenDiagnostics {
                        Button {
                            onOpenDiagnostics()
                        } label: {
                            Label("Diagnostics", systemImage: "stethoscope")
                        }
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
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

/// A single full-width browser row: icon tile, name (+ workspace badge), metadata
/// subtitle, hairline bottom divider. Read-denied files render greyed out.
private struct FileBrowserRow: View {
    let entry: CodexWorkspaceDirectoryEntry
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        HStack(spacing: 13) {
            Image(systemName: entry.browserGlyph)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(entry.isDirectory ? AppTheme.accent : AppTheme.textSecondary)
                .frame(width: 40, height: 40)
                .background(
                    (entry.isDirectory ? AppTheme.accent.opacity(0.14) : AppTheme.bgSurface),
                    in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                )

            VStack(alignment: .leading, spacing: 3) {
                if dynamicTypeSize.isAccessibilitySize {
                    // Accessibility sizes: the badge wraps below the name so the
                    // folder name keeps the row's full width instead of truncating.
                    VStack(alignment: .leading, spacing: 4) {
                        nameText.lineLimit(2)
                        workspaceBadge
                    }
                } else {
                    HStack(spacing: 6) {
                        nameText.lineLimit(1)
                        workspaceBadge
                    }
                }
                Text(subtitle)
                    .font(AppTheme.uiFont(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
            }

            Spacer(minLength: 6)

            if entry.isDirectory {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .contentShape(Rectangle())
        .opacity(entry.readDenied ? 0.4 : 1)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(AppTheme.strokeSubtle)
                .frame(height: 0.5)
                .padding(.leading, 69)
        }
    }

    private var nameText: some View {
        Text(entry.displayName)
            .font(AppTheme.uiFont(size: 15, weight: .semibold))
            .foregroundStyle(AppTheme.textPrimary)
    }

    @ViewBuilder
    private var workspaceBadge: some View {
        if entry.isRegistered {
            Text("Workspace")
                .font(AppTheme.uiFont(size: 9, weight: .bold))
                .foregroundStyle(AppTheme.accent)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(AppTheme.accent.opacity(0.15), in: Capsule())
        }
    }

    private var subtitle: String {
        if entry.isDirectory {
            return entry.hasGit ? "Git repository" : "Folder"
        }
        if entry.readDenied {
            return "Not readable from the phone"
        }
        let parts = [entry.sizeLabel, entry.mtimeLabel].compactMap { $0 }
        return parts.isEmpty ? "File" : parts.joined(separator: " · ")
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
            .background(AppTheme.statusError.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
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
