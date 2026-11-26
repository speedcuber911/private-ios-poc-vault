import SafariServices
import SwiftUI
import UIKit

// MARK: - Scope & Review Target

enum RelayGitDiffScope: Hashable {
    case diff(RelayGitDiffMode)
    case commits

    var title: String {
        switch self {
        case .diff(let mode): return mode.title
        case .commits: return "Commits"
        }
    }

    var diffMode: RelayGitDiffMode? {
        guard case .diff(let mode) = self else { return nil }
        return mode
    }
}

private struct RelayDiffLineTarget: Identifiable, Hashable {
    let filePath: String
    let hunkIndex: Int
    let lineIndex: Int
    let line: RelayGitDiffLine

    var id: String { "\(filePath)#\(hunkIndex)#\(lineIndex)" }

    var lineLabel: String {
        let prefix = line.isDeletion ? "−" : "+"
        if let number = line.displayLineNumber {
            return "\(prefix)\(number)"
        }
        return line.isDeletion ? "deleted line" : "line"
    }

    var locationHeader: String {
        if let number = line.displayLineNumber {
            return "\(filePath):\(number)"
        }
        return filePath
    }
}

private enum RelayGitDiffSheet: Identifiable {
    case branchSwitcher
    case commit(pushDefault: Bool)
    case jumpToFile
    case commitDiff(RelayGitCommit)
    case review(RelayDiffLineTarget)
    case safari(URL)

    var id: String {
        switch self {
        case .branchSwitcher:
            return "branchSwitcher"
        case .commit(let pushDefault):
            return "commit:\(pushDefault)"
        case .jumpToFile:
            return "jumpToFile"
        case .commitDiff(let commit):
            return "commitDiff:\(commit.id)"
        case .review(let target):
            return "review:\(target.id)"
        case .safari(let url):
            return "safari:\(url.absoluteString)"
        }
    }
}

private enum RelayGitDiffAlert: Identifiable {
    case discardFile(RelayGitDiffFile)
    case discardAll

    var id: String {
        switch self {
        case .discardFile(let file):
            return "discardFile:\(file.id)"
        case .discardAll:
            return "discardAll"
        }
    }

    var title: String {
        switch self {
        case .discardFile:
            return "Discard changes?"
        case .discardAll:
            return "Discard all uncommitted changes?"
        }
    }

    var message: String {
        switch self {
        case .discardFile(let file):
            return "Revert uncommitted changes in \(file.path)? This cannot be undone."
        case .discardAll:
            return "This reverts every modified file in this workspace. This cannot be undone."
        }
    }
}

// MARK: - ViewModel

@MainActor
final class RelayGitDiffViewModel: ObservableObject {
    let workspacePath: String
    private let gitAPI: (any RelayGitAPI)?
    private let onStatusChanged: ((RelayGitStatusResponse?) -> Void)?

    @Published private(set) var status: RelayGitStatusResponse?
    @Published private(set) var diff: RelayGitDiffResponse?
    @Published private(set) var commits: [RelayGitCommit] = []
    @Published private(set) var branchesResponse: RelayGitBranchesResponse?
    @Published var scope: RelayGitDiffScope = .diff(.uncommitted)

    @Published private(set) var isLoadingStatus = false
    @Published private(set) var isLoadingDiff = false
    @Published private(set) var isLoadingCommits = false
    @Published private(set) var isLoadingBranches = false
    @Published private(set) var isPerformingAction = false

    @Published private(set) var isRouteUnsupported = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var actionNotice: String?
    @Published private(set) var actionNoticeIsError = false

    @Published var collapsedFiles: Set<String> = []
    @Published var wrapLines = false

    private var hasLoadedOnce = false
    private var noticeDismissTask: Task<Void, Never>?

    init(
        workspacePath: String,
        gitAPI: (any RelayGitAPI)?,
        onStatusChanged: ((RelayGitStatusResponse?) -> Void)? = nil
    ) {
        self.workspacePath = workspacePath
        self.gitAPI = gitAPI
        self.onStatusChanged = onStatusChanged
        if gitAPI == nil {
            self.isRouteUnsupported = true
        }
    }

    var activeBranchName: String? {
        status?.branch?.trimmedNonEmpty ?? diff?.branch?.trimmedNonEmpty
    }

    var activeBaseBranchName: String? {
        status?.baseBranch?.trimmedNonEmpty ?? diff?.baseBranch?.trimmedNonEmpty
    }

    var diffFiles: [RelayGitDiffFile] {
        diff?.files ?? []
    }

    var allFilesCollapsed: Bool {
        !diffFiles.isEmpty && diffFiles.allSatisfy { collapsedFiles.contains($0.path) }
    }

    func loadIfNeeded() async {
        guard !hasLoadedOnce else { return }
        hasLoadedOnce = true
        await refresh()
    }

    func refresh() async {
        guard let gitAPI else {
            isRouteUnsupported = true
            return
        }
        isRouteUnsupported = false
        errorMessage = nil

        async let statusTask: Void = fetchStatus(using: gitAPI)
        async let contentTask: Void = fetchActiveScope(using: gitAPI)
        _ = await (statusTask, contentTask)
    }

    func selectScope(_ next: RelayGitDiffScope) async {
        guard scope != next else { return }
        scope = next
        errorMessage = nil
        guard let gitAPI else {
            isRouteUnsupported = true
            return
        }
        await fetchActiveScope(using: gitAPI)
    }

    func loadBranches() async {
        guard let gitAPI else { return }
        isLoadingBranches = true
        defer { isLoadingBranches = false }
        do {
            branchesResponse = try await gitAPI.fetchGitBranches(path: workspacePath)
        } catch {
            guard !isCancellation(error) else { return }
            if Self.isUnsupportedRouteError(error) {
                isRouteUnsupported = true
            } else {
                showNotice(error.localizedDescription, isError: true)
            }
        }
    }

    func checkoutBranch(_ branch: String, create: Bool) async -> String? {
        guard let gitAPI else { return "Git actions are unavailable." }
        let trimmed = branch.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Branch name cannot be empty." }
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await gitAPI.checkoutGitBranch(path: workspacePath, branch: trimmed, create: create)
            collapsedFiles.removeAll()
            await refresh()
            showNotice(create ? "Created and switched to \(trimmed)" : "Switched to \(trimmed)", isError: false)
            return nil
        } catch {
            if isCancellation(error) { return nil }
            return error.localizedDescription
        }
    }

    func commitChanges(message: String, stageAll: Bool, push: Bool) async -> String? {
        guard let gitAPI else { return "Git actions are unavailable." }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Enter a commit message." }
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            let result = try await gitAPI.commitGitChanges(
                path: workspacePath,
                message: trimmed,
                stageAll: stageAll,
                push: push
            )
            collapsedFiles.removeAll()
            await refresh()
            let shaText = result.shortSha.map { " \($0)" } ?? ""
            let suffix = (result.pushed ?? push) ? " and pushed" : ""
            showNotice("Committed\(shaText)\(suffix)", isError: false)
            return nil
        } catch {
            if isCancellation(error) { return nil }
            return error.localizedDescription
        }
    }

    func discardFiles(_ files: [String]) async {
        guard let gitAPI, !files.isEmpty else { return }
        isPerformingAction = true
        defer { isPerformingAction = false }
        do {
            try await gitAPI.discardGitFiles(path: workspacePath, files: files)
            await refresh()
            let label = files.count == 1 ? "Discarded changes to \(URL(fileURLWithPath: files[0]).lastPathComponent)" : "Discarded \(files.count) files"
            showNotice(label, isError: false)
        } catch {
            guard !isCancellation(error) else { return }
            showNotice(error.localizedDescription, isError: true)
        }
    }

    func discardAllChanges() async {
        let targets: [String]
        if let statusFiles = status?.files, !statusFiles.isEmpty {
            targets = statusFiles.map(\.path)
        } else if let diffFiles = diff?.files, !diffFiles.isEmpty {
            targets = diffFiles.map(\.path)
        } else {
            return
        }
        await discardFiles(targets)
    }

    func fetchCommitDiff(sha: String) async throws -> RelayGitDiffResponse {
        guard let gitAPI else {
            throw CodexClientError.httpFailure(404, "Git endpoints unavailable")
        }
        return try await gitAPI.fetchGitCommitDiff(path: workspacePath, sha: sha)
    }

    func toggleFileCollapsed(_ path: String) {
        if collapsedFiles.contains(path) {
            collapsedFiles.remove(path)
        } else {
            collapsedFiles.insert(path)
        }
    }

    func expandFile(_ path: String) {
        collapsedFiles.remove(path)
    }

    func toggleCollapseAll() {
        if allFilesCollapsed {
            collapsedFiles.removeAll()
        } else {
            collapsedFiles = Set(diffFiles.map(\.path))
        }
    }

    func dismissNotice() {
        noticeDismissTask?.cancel()
        noticeDismissTask = nil
        actionNotice = nil
    }

    // MARK: - Private Fetches

    private func fetchStatus(using gitAPI: any RelayGitAPI) async {
        isLoadingStatus = true
        defer { isLoadingStatus = false }
        do {
            let loaded = try await gitAPI.fetchGitStatus(path: workspacePath)
            status = loaded
            onStatusChanged?(loaded)
        } catch {
            guard !isCancellation(error) else { return }
            if Self.isUnsupportedRouteError(error) {
                isRouteUnsupported = true
                onStatusChanged?(nil)
            } else if status == nil {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func fetchActiveScope(using gitAPI: any RelayGitAPI) async {
        switch scope {
        case .diff(let mode):
            await fetchDiff(mode: mode, using: gitAPI)
        case .commits:
            await fetchCommits(using: gitAPI)
        }
    }

    private func fetchDiff(mode: RelayGitDiffMode, using gitAPI: any RelayGitAPI) async {
        isLoadingDiff = true
        defer { isLoadingDiff = false }
        do {
            let loaded = try await gitAPI.fetchGitDiff(path: workspacePath, mode: mode, file: nil)
            guard scope == .diff(mode) else { return }
            diff = loaded
            errorMessage = nil
        } catch {
            guard !isCancellation(error) else { return }
            if Self.isUnsupportedRouteError(error) {
                isRouteUnsupported = true
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func fetchCommits(using gitAPI: any RelayGitAPI) async {
        isLoadingCommits = true
        defer { isLoadingCommits = false }
        do {
            let loaded = try await gitAPI.fetchGitCommits(path: workspacePath, limit: 30)
            guard scope == .commits else { return }
            commits = loaded.commits
            errorMessage = nil
        } catch {
            guard !isCancellation(error) else { return }
            if Self.isUnsupportedRouteError(error) {
                isRouteUnsupported = true
            } else {
                errorMessage = error.localizedDescription
            }
        }
    }

    private func showNotice(_ text: String, isError: Bool) {
        noticeDismissTask?.cancel()
        actionNotice = text
        actionNoticeIsError = isError
        noticeDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3.5))
            guard !Task.isCancelled else { return }
            self?.actionNotice = nil
        }
    }

    private static func isUnsupportedRouteError(_ error: Error) -> Bool {
        if let clientError = error as? CodexClientError {
            return clientError.isGenericRouteNotFound || clientError.statusCode == 404
        }
        return false
    }
}

// MARK: - Main Diff View

struct RelayGitDiffView: View {
    @Environment(\.relayTheme) private var theme
    @StateObject private var viewModel: RelayGitDiffViewModel

    private let onOpenFile: ((String) -> Void)?
    private let onAttachFileToChat: ((String) -> Void)?
    private let onSendReviewComment: ((String) -> Void)?
    private let onHorizontalDragActive: ((Bool) -> Void)?

    @State private var activeSheet: RelayGitDiffSheet?
    @State private var activeAlert: RelayGitDiffAlert?
    @State private var pendingScrollFilePath: String?
    @State private var pendingOpenFileAfterSheetDismiss: String?

    init(
        workspacePath: String,
        gitAPI: (any RelayGitAPI)?,
        onOpenFile: ((String) -> Void)? = nil,
        onAttachFileToChat: ((String) -> Void)? = nil,
        onSendReviewComment: ((String) -> Void)? = nil,
        onStatusChanged: ((RelayGitStatusResponse?) -> Void)? = nil,
        onHorizontalDragActive: ((Bool) -> Void)? = nil
    ) {
        _viewModel = StateObject(
            wrappedValue: RelayGitDiffViewModel(
                workspacePath: workspacePath,
                gitAPI: gitAPI,
                onStatusChanged: onStatusChanged
            )
        )
        self.onOpenFile = onOpenFile
        self.onAttachFileToChat = onAttachFileToChat
        self.onSendReviewComment = onSendReviewComment
        self.onHorizontalDragActive = onHorizontalDragActive
    }

    var body: some View {
        VStack(spacing: 0) {
            if !viewModel.isRouteUnsupported && viewModel.status?.isGitRepo != false {
                branchActionBar
                diffControlsToolbar
            }
            if let notice = viewModel.actionNotice {
                actionNoticeBar(notice, isError: viewModel.actionNoticeIsError)
            }
            contentBody
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(theme.surface0)
        .task {
            await viewModel.loadIfNeeded()
        }
        .onChange(of: activeSheet?.id) { _, id in
            if id != nil {
                onHorizontalDragActive?(false)
            }
        }
        .onChange(of: activeAlert?.id) { _, id in
            if id != nil {
                onHorizontalDragActive?(false)
            }
        }
        .onDisappear {
            onHorizontalDragActive?(false)
        }
        .sheet(item: $activeSheet, onDismiss: {
            if let path = pendingOpenFileAfterSheetDismiss {
                pendingOpenFileAfterSheetDismiss = nil
                onOpenFile?(path)
            }
        }) { sheet in
            switch sheet {
            case .branchSwitcher:
                RelayBranchSwitcherSheet(
                    currentBranch: viewModel.activeBranchName,
                    branchesResponse: viewModel.branchesResponse,
                    isLoading: viewModel.isLoadingBranches,
                    onReload: { await viewModel.loadBranches() },
                    onSelectBranch: { name, create in
                        await viewModel.checkoutBranch(name, create: create)
                    }
                )
            case .commit(let pushDefault):
                RelayGitCommitSheet(
                    branchName: viewModel.activeBranchName,
                    changedFileCount: viewModel.status?.files.count ?? viewModel.diffFiles.count,
                    added: viewModel.status?.added ?? viewModel.diff?.totalAdded ?? 0,
                    deleted: viewModel.status?.deleted ?? viewModel.diff?.totalDeleted ?? 0,
                    pushByDefault: pushDefault,
                    onCommit: { message, stageAll, push in
                        await viewModel.commitChanges(message: message, stageAll: stageAll, push: push)
                    }
                )
            case .jumpToFile:
                RelayJumpToFileSheet(files: viewModel.diffFiles) { path in
                    viewModel.expandFile(path)
                    pendingScrollFilePath = path
                }
            case .commitDiff(let commit):
                RelayCommitDiffSheet(
                    commit: commit,
                    fetchDiff: { try await viewModel.fetchCommitDiff(sha: commit.sha) },
                    onOpenFile: onOpenFile == nil ? nil : { path in
                        pendingOpenFileAfterSheetDismiss = path
                        activeSheet = nil
                    },
                    onAttachFileToChat: onAttachFileToChat == nil ? nil : { path in
                        activeSheet = nil
                        onAttachFileToChat?(path)
                    },
                    onSendReviewComment: onSendReviewComment
                )
            case .review(let target):
                RelayDiffReviewCommentSheet(target: target) { formatted in
                    onSendReviewComment?(formatted)
                }
            case .safari(let url):
                RelayGitSafariSheet(url: url)
                    .ignoresSafeArea()
            }
        }
        .alert(
            activeAlert?.title ?? "",
            isPresented: Binding(
                get: { activeAlert != nil },
                set: { if !$0 { activeAlert = nil } }
            ),
            presenting: activeAlert
        ) { alert in
            switch alert {
            case .discardFile(let file):
                Button("Discard", role: .destructive) {
                    let paths = [file.path, file.oldPath].compactMap { $0 }
                    activeAlert = nil
                    Task { await viewModel.discardFiles(paths) }
                }
                Button("Cancel", role: .cancel) {
                    activeAlert = nil
                }
            case .discardAll:
                Button("Discard all", role: .destructive) {
                    activeAlert = nil
                    Task { await viewModel.discardAllChanges() }
                }
                Button("Cancel", role: .cancel) {
                    activeAlert = nil
                }
            }
        } message: { alert in
            Text(alert.message)
        }
    }

    // MARK: - Row 1: Branch + PR/Commit Split Action Bar

    private var branchActionBar: some View {
        HStack(spacing: 10) {
            Button {
                activeSheet = .branchSwitcher
                Task { await viewModel.loadBranches() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(theme.foregroundMuted)
                    Text(viewModel.activeBranchName ?? (viewModel.isLoadingStatus ? "Loading…" : "HEAD"))
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    if let status = viewModel.status, status.ahead > 0 || status.behind > 0 {
                        HStack(spacing: 3) {
                            if status.ahead > 0 {
                                Text("↑\(status.ahead)")
                            }
                            if status.behind > 0 {
                                Text("↓\(status.behind)")
                            }
                        }
                        .font(RelayTheme.monoFont(11, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .fixedSize()
                    }
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Switch branch")

            Spacer(minLength: 8)

            splitForgeOrCommitControl
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
        .background(theme.surface0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    @ViewBuilder
    private var splitForgeOrCommitControl: some View {
        let pr = viewModel.status?.pr
        let isDirty = viewModel.status?.dirty == true || !viewModel.diffFiles.isEmpty

        HStack(spacing: 0) {
            if let pr {
                Button {
                    if let url = pr.resolvedURL {
                        activeSheet = .safari(url)
                    } else {
                        UIPasteboard.general.string = pr.url
                    }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: prIconName(for: pr.state))
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(prTint(for: pr.state))
                        Text(pr.shortLabel)
                            .font(RelayTheme.uiFont(13, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open \(pr.shortLabel)")
            } else {
                Button {
                    activeSheet = .commit(pushDefault: false)
                } label: {
                    HStack(spacing: 5) {
                        if viewModel.isPerformingAction {
                            ProgressView()
                                .controlSize(.mini)
                                .tint(theme.foreground)
                        } else {
                            Image(systemName: "checkmark.circle")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(theme.foregroundMuted)
                        }
                        Text("Commit")
                            .font(RelayTheme.uiFont(13, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 10)
                    .frame(height: 30)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!isDirty || viewModel.isPerformingAction)
                .opacity((!isDirty || viewModel.isPerformingAction) ? 0.5 : 1)
                .accessibilityLabel("Commit changes")
            }

            Rectangle()
                .fill(theme.borderAccent)
                .frame(width: 1, height: 30)

            Menu {
                if let pr {
                    if let url = pr.resolvedURL {
                        Button {
                            activeSheet = .safari(url)
                        } label: {
                            Label("Open \(pr.shortLabel)", systemImage: "safari")
                        }
                    }
                    Button {
                        UIPasteboard.general.string = pr.url
                    } label: {
                        Label("Copy PR link", systemImage: "link")
                    }
                    Divider()
                }

                Button {
                    activeSheet = .commit(pushDefault: false)
                } label: {
                    Label("Commit…", systemImage: "checkmark.circle")
                }
                .disabled(!isDirty)

                Button {
                    activeSheet = .commit(pushDefault: true)
                } label: {
                    Label("Commit & Push…", systemImage: "arrow.up.circle")
                }
                .disabled(!isDirty)

                Button {
                    Task { await viewModel.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }

                if isDirty {
                    Divider()
                    Button(role: .destructive) {
                        activeAlert = .discardAll
                    } label: {
                        Label("Discard all changes…", systemImage: "arrow.uturn.backward")
                    }
                }
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 28, height: 30)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("More git actions")
        }
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .stroke(theme.borderAccent, lineWidth: 1)
        )
        .fixedSize()
    }

    private func prIconName(for state: String) -> String {
        switch state.lowercased() {
        case "merged": return "arrow.triangle.merge"
        case "closed": return "xmark.circle"
        default: return "arrow.triangle.pull"
        }
    }

    private func prTint(for state: String) -> Color {
        switch state.lowercased() {
        case "merged": return theme.statusMerged
        case "closed": return theme.statusDanger
        case "draft": return theme.foregroundMuted
        default: return theme.statusSuccess
        }
    }

    // MARK: - Row 2: Diff Controls Toolbar

    private var diffControlsToolbar: some View {
        HStack(spacing: 8) {
            Menu {
                ForEach(RelayGitDiffMode.allCases) { mode in
                    Button {
                        Task { await viewModel.selectScope(.diff(mode)) }
                    } label: {
                        if viewModel.scope == .diff(mode) {
                            Label(mode.title, systemImage: "checkmark")
                        } else {
                            Text(mode.title)
                        }
                    }
                }
                Divider()
                Button {
                    Task { await viewModel.selectScope(.commits) }
                } label: {
                    if viewModel.scope == .commits {
                        Label("Commits", systemImage: "checkmark")
                    } else {
                        Label("Commits", systemImage: "clock.arrow.circlepath")
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    Text(viewModel.scope.title)
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                    Image(systemName: "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
                .padding(.vertical, 6)
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
            }
            .accessibilityLabel("Diff scope: \(viewModel.scope.title)")

            if viewModel.scope != .commits, let diff = viewModel.diff, !diff.files.isEmpty {
                RelayDiffStatView(additions: diff.totalAdded, deletions: diff.totalDeleted)
            }

            Spacer(minLength: 4)

            if viewModel.scope != .commits {
                HStack(spacing: 2) {
                    toolbarIconButton(
                        systemImage: "list.bullet.indent",
                        accessibilityLabel: "Jump to file",
                        isActive: false,
                        isDisabled: viewModel.diffFiles.isEmpty
                    ) {
                        activeSheet = .jumpToFile
                    }

                    toolbarIconButton(
                        systemImage: viewModel.allFilesCollapsed ? "rectangle.expand.vertical" : "rectangle.compress.vertical",
                        accessibilityLabel: viewModel.allFilesCollapsed ? "Expand all files" : "Collapse all files",
                        isActive: false,
                        isDisabled: viewModel.diffFiles.isEmpty
                    ) {
                        viewModel.toggleCollapseAll()
                    }

                    toolbarIconButton(
                        systemImage: "arrow.turn.down.left",
                        accessibilityLabel: viewModel.wrapLines ? "Disable line wrap" : "Wrap long lines",
                        isActive: viewModel.wrapLines,
                        isDisabled: false
                    ) {
                        viewModel.wrapLines.toggle()
                    }
                }
            } else {
                toolbarIconButton(
                    systemImage: "arrow.clockwise",
                    accessibilityLabel: "Refresh commits",
                    isActive: false,
                    isDisabled: viewModel.isLoadingCommits
                ) {
                    Task { await viewModel.refresh() }
                }
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 38)
        .background(theme.surface0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private func toolbarIconButton(
        systemImage: String,
        accessibilityLabel: String,
        isActive: Bool,
        isDisabled: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(isActive ? theme.foreground : theme.foregroundMuted)
                .frame(width: 32, height: 32)
                .background(
                    isActive ? theme.interactionHighlight : Color.clear,
                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .opacity(isDisabled ? 0.4 : 1)
        .accessibilityLabel(accessibilityLabel)
    }

    private func actionNoticeBar(_ text: String, isError: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: isError ? "exclamationmark.triangle" : "checkmark.circle")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(isError ? theme.statusDanger : theme.statusSuccess)
            Text(text)
                .font(RelayTheme.uiFont(12, weight: .regular))
                .foregroundStyle(theme.foreground)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                viewModel.dismissNotice()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(isError ? theme.statusDangerTint : theme.statusSuccessTint)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    // MARK: - Content Body

    @ViewBuilder
    private var contentBody: some View {
        if viewModel.isRouteUnsupported {
            emptyState(
                icon: "arrow.triangle.branch",
                title: "Git diff requires updated relayd",
                message: "Update relayd on your computer to inspect diffs, switch branches, and commit from your phone.",
                primaryAction: ("Retry", { Task { await viewModel.refresh() } }),
                secondaryAction: nil
            )
        } else if viewModel.status?.isGitRepo == false {
            emptyState(
                icon: "folder",
                title: "Not a git repository",
                message: "This workspace folder is not tracked by git.",
                primaryAction: nil,
                secondaryAction: nil
            )
        } else if viewModel.scope == .commits {
            commitsBody
        } else {
            diffBody
        }
    }

    @ViewBuilder
    private var diffBody: some View {
        if viewModel.isLoadingDiff && viewModel.diff == nil {
            VStack(spacing: 10) {
                ProgressView()
                    .tint(theme.foregroundMuted)
                Text("Loading changes…")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = viewModel.errorMessage, viewModel.diffFiles.isEmpty {
            emptyState(
                icon: "exclamationmark.triangle",
                title: "Couldn't load changes",
                message: error,
                primaryAction: ("Try again", { Task { await viewModel.refresh() } }),
                secondaryAction: nil
            )
        } else if viewModel.diffFiles.isEmpty {
            cleanDiffEmptyState
        } else {
            RelayUnifiedDiffDocumentView(
                files: viewModel.diffFiles,
                truncated: viewModel.diff?.truncated == true,
                collapsedFiles: viewModel.collapsedFiles,
                wrapLines: viewModel.wrapLines,
                allowsDiscard: viewModel.scope == .diff(.uncommitted),
                scrollToFilePath: $pendingScrollFilePath,
                onToggleCollapse: { viewModel.toggleFileCollapsed($0) },
                onOpenFile: onOpenFile,
                onAttachFileToChat: onAttachFileToChat,
                onDiscardFile: { activeAlert = .discardFile($0) },
                onTapLine: { target in
                    guard onSendReviewComment != nil else { return }
                    activeSheet = .review(target)
                },
                onHorizontalDragActive: onHorizontalDragActive,
                onRefresh: { await viewModel.refresh() }
            )
        }
    }

    @ViewBuilder
    private var cleanDiffEmptyState: some View {
        switch viewModel.scope {
        case .diff(.uncommitted):
            emptyState(
                icon: "checkmark.circle",
                title: "No uncommitted changes",
                message: "Your working tree is clean.",
                primaryAction: ("Committed changes", {
                    Task { await viewModel.selectScope(.diff(.committed)) }
                }),
                secondaryAction: ("Recent commits", {
                    Task { await viewModel.selectScope(.commits) }
                })
            )
        case .diff(.committed):
            emptyState(
                icon: "arrow.triangle.branch",
                title: "No committed changes",
                message: viewModel.activeBaseBranchName.map { "This branch has no commits ahead of \($0)." }
                    ?? "No committed changes compared to the base branch.",
                primaryAction: ("Recent commits", {
                    Task { await viewModel.selectScope(.commits) }
                }),
                secondaryAction: ("Uncommitted", {
                    Task { await viewModel.selectScope(.diff(.uncommitted)) }
                })
            )
        case .diff(.all):
            emptyState(
                icon: "checkmark.circle",
                title: "No changes on this branch",
                message: "No uncommitted or committed differences found.",
                primaryAction: ("Recent commits", {
                    Task { await viewModel.selectScope(.commits) }
                }),
                secondaryAction: nil
            )
        case .commits:
            EmptyView()
        }
    }

    @ViewBuilder
    private var commitsBody: some View {
        if viewModel.isLoadingCommits && viewModel.commits.isEmpty {
            VStack(spacing: 10) {
                ProgressView().tint(theme.foregroundMuted)
                Text("Loading commits…")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = viewModel.errorMessage, viewModel.commits.isEmpty {
            emptyState(
                icon: "exclamationmark.triangle",
                title: "Couldn't load commits",
                message: error,
                primaryAction: ("Try again", { Task { await viewModel.refresh() } }),
                secondaryAction: nil
            )
        } else if viewModel.commits.isEmpty {
            emptyState(
                icon: "clock.arrow.circlepath",
                title: "No commits yet",
                message: "Commits on this branch will appear here.",
                primaryAction: nil,
                secondaryAction: nil
            )
        } else {
            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(viewModel.commits) { commit in
                        Button {
                            activeSheet = .commitDiff(commit)
                        } label: {
                            commitRow(commit)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.bottom, 24)
            }
            .refreshable {
                await viewModel.refresh()
            }
        }
    }

    private func commitRow(_ commit: RelayGitCommit) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text(commit.shortSha)
                .font(RelayTheme.monoFont(11, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(theme.surface2, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 4) {
                Text(commit.subject.trimmedNonEmpty ?? "(no commit message)")
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)

                HStack(spacing: 6) {
                    if !commit.author.isEmpty {
                        Text(commit.author)
                            .lineLimit(1)
                    }
                    if !commit.author.isEmpty && !commit.relativeDate.isEmpty {
                        Text("·")
                    }
                    if !commit.relativeDate.isEmpty {
                        Text(commit.relativeDate)
                            .lineLimit(1)
                    }
                }
                .font(RelayTheme.uiFont(12, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(theme.foregroundExtraMuted)
                .padding(.top, 4)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private func emptyState(
        icon: String,
        title: String,
        message: String,
        primaryAction: (String, () -> Void)?,
        secondaryAction: (String, () -> Void)?
    ) -> some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 24, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)

            VStack(spacing: 4) {
                Text(title)
                    .font(RelayTheme.uiFont(15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .multilineTextAlignment(.center)
                Text(message)
                    .font(RelayTheme.uiFont(13, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .multilineTextAlignment(.center)
            }

            if primaryAction != nil || secondaryAction != nil {
                HStack(spacing: 8) {
                    if let primaryAction {
                        Button(action: primaryAction.1) {
                            Text(primaryAction.0)
                                .font(RelayTheme.uiFont(13, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .padding(.horizontal, 14)
                                .frame(height: 34)
                                .background(theme.surface2, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                    if let secondaryAction {
                        Button(action: secondaryAction.1) {
                            Text(secondaryAction.0)
                                .font(RelayTheme.uiFont(13, weight: .medium))
                                .foregroundStyle(theme.foregroundMuted)
                                .padding(.horizontal, 14)
                                .frame(height: 34)
                                .overlay(Capsule().stroke(theme.borderAccent, lineWidth: 1))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(.horizontal, 28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Unified Diff Document (Shared by Main Diff & Commit Diff Sheet)

private struct RelayUnifiedDiffDocumentView: View {
    @Environment(\.relayTheme) private var theme

    let files: [RelayGitDiffFile]
    let truncated: Bool
    let collapsedFiles: Set<String>
    let wrapLines: Bool
    let allowsDiscard: Bool
    @Binding var scrollToFilePath: String?
    let onToggleCollapse: (String) -> Void
    let onOpenFile: ((String) -> Void)?
    let onAttachFileToChat: ((String) -> Void)?
    let onDiscardFile: ((RelayGitDiffFile) -> Void)?
    let onTapLine: (RelayDiffLineTarget) -> Void
    let onHorizontalDragActive: ((Bool) -> Void)?
    let onRefresh: (() async -> Void)?

    @GestureState private var isHorizontalDragging = false
    @State private var isReportingHorizontalDrag = false

    private static let gutterWidth: CGFloat = 42
    private static let lineHeight: CGFloat = 21
    private static let horizontalChunkSize = 60

    var body: some View {
        GeometryReader { geometry in
            let codeMinWidth = max(120, geometry.size.width - Self.gutterWidth)
            ScrollViewReader { proxy in
                ScrollView(.vertical, showsIndicators: true) {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        ForEach(files) { file in
                            Section {
                                if !collapsedFiles.contains(file.path) {
                                    fileBody(file, codeMinWidth: codeMinWidth)
                                }
                            } header: {
                                fileHeader(file)
                                    .id(fileAnchorID(file.path))
                            }
                        }

                        if truncated {
                            truncatedBanner
                        }
                    }
                    .padding(.bottom, 32)
                }
                .refreshable {
                    await onRefresh?()
                }
                .onChange(of: scrollToFilePath) { _, targetPath in
                    guard let targetPath else { return }
                    withAnimation(.easeOut(duration: 0.22)) {
                        proxy.scrollTo(fileAnchorID(targetPath), anchor: .top)
                    }
                    scrollToFilePath = nil
                }
            }
        }
        .onChange(of: isHorizontalDragging) { _, active in
            if active {
                if !isReportingHorizontalDrag {
                    isReportingHorizontalDrag = true
                    onHorizontalDragActive?(true)
                }
            } else {
                resetHorizontalDragIfNeeded()
            }
        }
        .onChange(of: wrapLines) { _, wrapped in
            if wrapped {
                resetHorizontalDragIfNeeded()
            }
        }
        .onDisappear {
            isReportingHorizontalDrag = false
            onHorizontalDragActive?(false)
        }
    }

    private func resetHorizontalDragIfNeeded() {
        guard isReportingHorizontalDrag else { return }
        isReportingHorizontalDrag = false
        onHorizontalDragActive?(false)
    }

    private func fileAnchorID(_ path: String) -> String {
        "relay-diff-file::\(path)"
    }

    // MARK: Sticky File Header

    private func fileHeader(_ file: RelayGitDiffFile) -> some View {
        let isCollapsed = collapsedFiles.contains(file.path)
        return HStack(spacing: 6) {
            Button {
                onToggleCollapse(file.path)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .frame(width: 12)

                    Text(file.fileName)
                        .font(RelayTheme.uiFont(13, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                        .layoutPriority(1)

                    if let dir = file.directoryPath {
                        Text(dir)
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    Spacer(minLength: 4)
                }
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            RelayDiffStatView(additions: file.added, deletions: file.deleted)
                .fixedSize()

            Menu {
                if !file.isDeleted, let onOpenFile {
                    Button {
                        onOpenFile(file.path)
                    } label: {
                        Label("Open file", systemImage: "doc.text")
                    }
                }
                if let onAttachFileToChat {
                    Button {
                        onAttachFileToChat(file.path)
                    } label: {
                        Label("Ask agent about file", systemImage: "bubble.left")
                    }
                }
                Button {
                    UIPasteboard.general.string = file.path
                } label: {
                    Label("Copy path", systemImage: "doc.on.doc")
                }
                if allowsDiscard, let onDiscardFile {
                    Divider()
                    Button(role: .destructive) {
                        onDiscardFile(file)
                    } label: {
                        Label("Discard changes", systemImage: "arrow.uturn.backward")
                    }
                }
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 28, height: 32)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("File actions for \(file.fileName)")
        }
        .padding(.leading, 10)
        .padding(.trailing, 6)
        .frame(height: 38)
        .background(theme.surface1)
        .overlay(alignment: .top) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    // MARK: File Hunks & Lines

    @ViewBuilder
    private func fileBody(_ file: RelayGitDiffFile, codeMinWidth: CGFloat) -> some View {
        if file.binary {
            Text("Binary file changed")
                .font(RelayTheme.monoFont(11, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.surface0)
        } else if file.hunks.isEmpty {
            Text(file.status.lowercased() == "renamed" ? "File renamed without content changes" : "No textual diff available")
                .font(RelayTheme.monoFont(11, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(theme.surface0)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(Array(file.hunks.enumerated()), id: \.offset) { hunkIndex, hunk in
                    VStack(alignment: .leading, spacing: 0) {
                        hunkHeaderRow(hunk.header)
                        if wrapLines {
                            ForEach(Array(hunk.lines.enumerated()), id: \.offset) { lineIndex, line in
                                wrappedDiffLineRow(
                                    filePath: file.path,
                                    hunkIndex: hunkIndex,
                                    lineIndex: lineIndex,
                                    line: line
                                )
                            }
                        } else {
                            let slices = chunkIndices(count: hunk.lines.count, chunkSize: Self.horizontalChunkSize)
                            ForEach(Array(slices.enumerated()), id: \.offset) { _, range in
                                unwrappedDiffSlice(
                                    filePath: file.path,
                                    hunkIndex: hunkIndex,
                                    lines: hunk.lines,
                                    range: range,
                                    codeMinWidth: codeMinWidth
                                )
                                .id("\(file.path)::h\(hunkIndex)::s\(range.lowerBound)")
                            }
                        }
                    }
                    .id("\(file.path)::hunk-\(hunkIndex)")
                }
            }
        }
    }

    private func hunkHeaderRow(_ header: String) -> some View {
        HStack(spacing: 0) {
            Color.clear
                .frame(width: Self.gutterWidth)
            Text(header)
                .font(RelayTheme.monoFont(11, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
                .lineLimit(1)
                .truncationMode(.tail)
                .padding(.leading, 6)
                .padding(.trailing, 12)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.diffHunkBg)
    }

    private func unwrappedDiffSlice(
        filePath: String,
        hunkIndex: Int,
        lines: [RelayGitDiffLine],
        range: Range<Int>,
        codeMinWidth: CGFloat
    ) -> some View {
        HStack(alignment: .top, spacing: 0) {
            // Pinned line-number gutter
            VStack(alignment: .trailing, spacing: 0) {
                ForEach(range, id: \.self) { lineIndex in
                    let line = lines[lineIndex]
                    Button {
                        onTapLine(RelayDiffLineTarget(filePath: filePath, hunkIndex: hunkIndex, lineIndex: lineIndex, line: line))
                    } label: {
                        Text(line.displayLineNumber.map(String.init) ?? "")
                            .font(RelayTheme.monoFont(11, weight: .regular))
                            .monospacedDigit()
                            .foregroundStyle(lineNumberColor(for: line))
                            .frame(width: Self.gutterWidth - 10, height: Self.lineHeight, alignment: .trailing)
                            .padding(.trailing, 10)
                            .frame(width: Self.gutterWidth, height: Self.lineHeight, alignment: .trailing)
                            .background(rowBackground(for: line))
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(width: Self.gutterWidth)

            // Horizontally scrollable syntax-highlighted code column
            ScrollView(.horizontal, showsIndicators: false) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(range, id: \.self) { lineIndex in
                        let line = lines[lineIndex]
                        Button {
                            onTapLine(RelayDiffLineTarget(filePath: filePath, hunkIndex: hunkIndex, lineIndex: lineIndex, line: line))
                        } label: {
                            Text(RelaySyntaxHighlighter.highlight(line: line.text, filePath: filePath, theme: theme))
                                .font(RelayTheme.monoFont(12, weight: .regular))
                                .lineLimit(1)
                                .fixedSize(horizontal: true, vertical: false)
                                .padding(.leading, 6)
                                .padding(.trailing, 16)
                                .frame(minWidth: codeMinWidth, maxWidth: .infinity, minHeight: Self.lineHeight, maxHeight: Self.lineHeight, alignment: .leading)
                                .background(rowBackground(for: line))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(minWidth: codeMinWidth, alignment: .leading)
            }
            .simultaneousGesture(
                DragGesture(minimumDistance: 6)
                    .updating($isHorizontalDragging) { value, state, _ in
                        guard onHorizontalDragActive != nil else { return }
                        if !state && abs(value.translation.width) > abs(value.translation.height) {
                            state = true
                        }
                    }
                    .onChanged { value in
                        guard onHorizontalDragActive != nil else { return }
                        if !isReportingHorizontalDrag,
                           abs(value.translation.width) > abs(value.translation.height) {
                            isReportingHorizontalDrag = true
                            onHorizontalDragActive?(true)
                        }
                    }
                    .onEnded { _ in
                        resetHorizontalDragIfNeeded()
                    }
            )
            .onDisappear {
                resetHorizontalDragIfNeeded()
            }
        }
        .background(theme.surface0)
    }

    private func wrappedDiffLineRow(
        filePath: String,
        hunkIndex: Int,
        lineIndex: Int,
        line: RelayGitDiffLine
    ) -> some View {
        Button {
            onTapLine(RelayDiffLineTarget(filePath: filePath, hunkIndex: hunkIndex, lineIndex: lineIndex, line: line))
        } label: {
            HStack(alignment: .top, spacing: 0) {
                Text(line.displayLineNumber.map(String.init) ?? "")
                    .font(RelayTheme.monoFont(11, weight: .regular))
                    .monospacedDigit()
                    .foregroundStyle(lineNumberColor(for: line))
                    .frame(width: Self.gutterWidth - 10, alignment: .trailing)
                    .padding(.trailing, 10)
                    .padding(.top, 3)

                Text(RelaySyntaxHighlighter.highlight(line: line.text, filePath: filePath, theme: theme))
                    .font(RelayTheme.monoFont(12, weight: .regular))
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.leading, 6)
                    .padding(.trailing, 12)
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(minHeight: Self.lineHeight)
            .background(rowBackground(for: line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var truncatedBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "info.circle")
                .font(.system(size: 13))
                .foregroundStyle(theme.foregroundMuted)
            Text("Some large files were omitted to keep diff rendering fast.")
                .font(RelayTheme.uiFont(12))
                .foregroundStyle(theme.foregroundMuted)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface1)
        .overlay(alignment: .top) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private func rowBackground(for line: RelayGitDiffLine) -> Color {
        if line.isAddition { return theme.diffAdditionBg }
        if line.isDeletion { return theme.diffDeletionBg }
        return Color.clear
    }

    private func lineNumberColor(for line: RelayGitDiffLine) -> Color {
        if line.isAddition { return theme.diffAddition }
        if line.isDeletion { return theme.diffDeletion }
        return theme.foregroundExtraMuted
    }

    private func chunkIndices(count: Int, chunkSize: Int) -> [Range<Int>] {
        guard count > 0 else { return [] }
        var ranges: [Range<Int>] = []
        var start = 0
        while start < count {
            let end = min(start + chunkSize, count)
            ranges.append(start..<end)
            start = end
        }
        return ranges
    }
}

// MARK: - Inline Review Comment Sheet

private struct RelayDiffReviewCommentSheet: View {
    @Environment(\.relayTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let target: RelayDiffLineTarget
    let onSend: (String) -> Void

    @State private var commentText = ""
    @FocusState private var isFocused: Bool

    private var canSend: Bool {
        !commentText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Sheet Header
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Comment on \(URL(fileURLWithPath: target.filePath).lastPathComponent)")
                        .font(RelayTheme.uiFont(15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    Text("\(target.filePath) · \(target.lineLabel)")
                        .font(RelayTheme.monoFont(11, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .background(theme.surface2, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .bottom) {
                Rectangle().fill(theme.border).frame(height: 1)
            }

            // Quoted line context
            HStack(spacing: 0) {
                Rectangle()
                    .fill(target.line.isAddition ? theme.diffAddition : (target.line.isDeletion ? theme.diffDeletion : theme.borderAccent))
                    .frame(width: 3)
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(RelaySyntaxHighlighter.highlight(line: target.line.text, filePath: target.filePath, theme: theme))
                        .font(RelayTheme.monoFont(12))
                        .lineLimit(1)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                }
            }
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(theme.border, lineWidth: 1)
            )
            .padding(.horizontal, 16)
            .padding(.top, 14)

            // Comment input
            ZStack(alignment: .topLeading) {
                if commentText.isEmpty {
                    Text("Ask the agent to adjust or explain this change…")
                        .font(RelayTheme.uiFont(15))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .allowsHitTesting(false)
                }
                TextEditor(text: $commentText)
                    .font(RelayTheme.uiFont(15))
                    .foregroundStyle(theme.foreground)
                    .scrollContentBackground(.hidden)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .focused($isFocused)
            }
            .frame(maxWidth: .infinity, minHeight: 110)
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(theme.border, lineWidth: 1)
            )
            .padding(.horizontal, 16)
            .padding(.top, 12)

            Spacer(minLength: 12)

            // Action footer
            HStack(spacing: 10) {
                Button { dismiss() } label: {
                    Text("Cancel")
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .frame(maxWidth: .infinity, minHeight: 42)
                        .background(theme.surface3, in: Capsule())
                }
                .buttonStyle(.plain)

                Button {
                    let trimmed = commentText.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    let snippet = target.line.text.trimmingCharacters(in: .newlines)
                    let formatted = """
                    Regarding `\(target.locationHeader)` (\(target.lineLabel)):
                    ```
                    \(snippet)
                    ```
                    \(trimmed)
                    """
                    onSend(formatted)
                    dismiss()
                } label: {
                    Text("Send to chat")
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.accentForeground)
                        .frame(maxWidth: .infinity, minHeight: 42)
                        .background(theme.accent, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .opacity(canSend ? 1 : 0.5)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .overlay(alignment: .top) {
                Rectangle().fill(theme.border).frame(height: 1)
            }
        }
        .background(theme.surface0.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear {
            isFocused = true
        }
    }
}

// MARK: - Branch Switcher Sheet

private struct RelayBranchSwitcherSheet: View {
    @Environment(\.relayTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let currentBranch: String?
    let branchesResponse: RelayGitBranchesResponse?
    let isLoading: Bool
    let onReload: () async -> Void
    let onSelectBranch: (String, Bool) async -> String?

    @State private var searchText = ""
    @State private var switchingBranch: String?
    @State private var errorMessage: String?

    private var allBranches: [RelayGitBranch] {
        branchesResponse?.branches ?? []
    }

    private var trimmedQuery: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredLocal: [RelayGitBranch] {
        let local = allBranches.filter { !$0.isRemote }
        guard !trimmedQuery.isEmpty else { return local }
        return local.filter { $0.name.localizedCaseInsensitiveContains(trimmedQuery) }
    }

    private var filteredRemote: [RelayGitBranch] {
        let remote = allBranches.filter { $0.isRemote }
        guard !trimmedQuery.isEmpty else { return remote }
        return remote.filter { $0.name.localizedCaseInsensitiveContains(trimmedQuery) }
    }

    private var canCreateBranchFromQuery: Bool {
        guard !trimmedQuery.isEmpty,
              !trimmedQuery.contains(where: \.isWhitespace),
              !trimmedQuery.contains("..") else { return false }
        return !allBranches.contains { !$0.isRemote && $0.name.caseInsensitiveCompare(trimmedQuery) == .orderedSame }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Switch branch")
                    .font(RelayTheme.uiFont(16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .background(theme.surface2, in: Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .bottom) {
                Rectangle().fill(theme.border).frame(height: 1)
            }

            // Search / new branch field
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 14))
                    .foregroundStyle(theme.foregroundMuted)
                TextField("Find or create branch…", text: $searchText)
                    .font(RelayTheme.uiFont(14))
                    .foregroundStyle(theme.foreground)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                if !searchText.isEmpty {
                    Button { searchText = "" } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 40)
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(theme.border, lineWidth: 1)
            )
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)

            if let errorMessage {
                Text(errorMessage)
                    .font(RelayTheme.uiFont(12))
                    .foregroundStyle(theme.statusDanger)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
            }

            if isLoading && allBranches.isEmpty {
                VStack(spacing: 10) {
                    ProgressView().tint(theme.foregroundMuted)
                    Text("Loading branches…")
                        .font(RelayTheme.uiFont(13))
                        .foregroundStyle(theme.foregroundMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if canCreateBranchFromQuery {
                            Button {
                                performCheckout(branch: trimmedQuery, create: true)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "plus.circle")
                                        .font(.system(size: 15, weight: .medium))
                                        .foregroundStyle(theme.accent)
                                    Text("Create branch \"\(trimmedQuery)\"")
                                        .font(RelayTheme.uiFont(14, weight: .medium))
                                        .foregroundStyle(theme.foreground)
                                        .lineLimit(1)
                                    Spacer()
                                    if switchingBranch == trimmedQuery {
                                        ProgressView().controlSize(.small)
                                    }
                                }
                                .padding(.horizontal, 16)
                                .frame(minHeight: 46)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(switchingBranch != nil)
                            Rectangle().fill(theme.border).frame(height: 1)
                        }

                        if !filteredLocal.isEmpty {
                            sectionHeader("Local")
                            ForEach(filteredLocal) { branch in
                                branchRow(branch)
                            }
                        }

                        if !filteredRemote.isEmpty {
                            sectionHeader("Remote")
                            ForEach(filteredRemote) { branch in
                                branchRow(branch)
                            }
                        }

                        if filteredLocal.isEmpty && filteredRemote.isEmpty && !canCreateBranchFromQuery {
                            Text("No matching branches")
                                .font(RelayTheme.uiFont(13))
                                .foregroundStyle(theme.foregroundMuted)
                                .frame(maxWidth: .infinity)
                                .padding(.top, 40)
                        }
                    }
                    .padding(.bottom, 24)
                }
                .refreshable {
                    await onReload()
                }
            }
        }
        .background(theme.surface0.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(RelayTheme.uiFont(12, weight: .medium))
            .foregroundStyle(theme.foregroundMuted)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }

    private func branchRow(_ branch: RelayGitBranch) -> some View {
        let isCurrent = branch.isCurrent || branch.name == currentBranch
        let isBase = branch.name == branchesResponse?.baseBranch
        return Button {
            guard !isCurrent else {
                dismiss()
                return
            }
            performCheckout(branch: branch.name, create: false)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(isCurrent ? theme.statusSuccess : theme.foregroundMuted)

                VStack(alignment: .leading, spacing: 2) {
                    Text(branch.name)
                        .font(RelayTheme.monoFont(13, weight: isCurrent ? .medium : .regular))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                    if let upstream = branch.upstream {
                        Text(upstream)
                            .font(RelayTheme.monoFont(11))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if isBase {
                    Text("base")
                        .font(RelayTheme.monoFont(10, weight: .medium))
                        .foregroundStyle(theme.foregroundMuted)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(theme.surface2, in: Capsule())
                }

                if switchingBranch == branch.name {
                    ProgressView().controlSize(.small)
                } else if isCurrent {
                    Image(systemName: "checkmark")
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(theme.statusSuccess)
                }
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 46)
            .background(isCurrent ? theme.surface1 : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(switchingBranch != nil)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private func performCheckout(branch: String, create: Bool) {
        switchingBranch = branch
        errorMessage = nil
        Task {
            let error = await onSelectBranch(branch, create)
            switchingBranch = nil
            if let error {
                errorMessage = error
            } else {
                dismiss()
            }
        }
    }
}

// MARK: - Commit Sheet

private struct RelayGitCommitSheet: View {
    @Environment(\.relayTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let branchName: String?
    let changedFileCount: Int
    let added: Int
    let deleted: Int
    let onCommit: (String, Bool, Bool) async -> String?

    @State private var message = ""
    @State private var stageAll = true
    @State private var pushAfterCommit: Bool
    @State private var isSubmitting = false
    @State private var errorMessage: String?
    @FocusState private var messageFocused: Bool

    init(
        branchName: String?,
        changedFileCount: Int,
        added: Int,
        deleted: Int,
        pushByDefault: Bool,
        onCommit: @escaping (String, Bool, Bool) async -> String?
    ) {
        self.branchName = branchName
        self.changedFileCount = changedFileCount
        self.added = added
        self.deleted = deleted
        self.onCommit = onCommit
        _pushAfterCommit = State(initialValue: pushByDefault)
    }

    private var canSubmit: Bool {
        !message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSubmitting
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pushAfterCommit ? "Commit & push" : "Commit changes")
                        .font(RelayTheme.uiFont(16, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    HStack(spacing: 6) {
                        if let branchName {
                            Text(branchName)
                                .font(RelayTheme.monoFont(11))
                                .foregroundStyle(theme.foregroundMuted)
                        }
                        if changedFileCount > 0 {
                            Text("· \(changedFileCount) \(changedFileCount == 1 ? "file" : "files")")
                                .font(RelayTheme.uiFont(12))
                                .foregroundStyle(theme.foregroundMuted)
                        }
                        if added > 0 || deleted > 0 {
                            RelayDiffStatView(additions: added, deletions: deleted)
                        }
                    }
                }
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .background(theme.surface2, in: Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .bottom) {
                Rectangle().fill(theme.border).frame(height: 1)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("Commit message")
                            .font(RelayTheme.uiFont(13, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)

                        ZStack(alignment: .topLeading) {
                            if message.isEmpty {
                                Text("Summarize your changes…")
                                    .font(RelayTheme.uiFont(15))
                                    .foregroundStyle(theme.foregroundExtraMuted)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 12)
                                    .allowsHitTesting(false)
                            }
                            TextEditor(text: $message)
                                .font(RelayTheme.uiFont(15))
                                .foregroundStyle(theme.foreground)
                                .scrollContentBackground(.hidden)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .focused($messageFocused)
                        }
                        .frame(minHeight: 96)
                        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(theme.border, lineWidth: 1)
                        )
                    }

                    VStack(spacing: 0) {
                        Toggle(isOn: $stageAll) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Stage all changes")
                                    .font(RelayTheme.uiFont(14))
                                    .foregroundStyle(theme.foreground)
                                Text("Include unstaged and untracked files")
                                    .font(RelayTheme.uiFont(12))
                                    .foregroundStyle(theme.foregroundMuted)
                            }
                        }
                        .tint(theme.accent)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)

                        Rectangle().fill(theme.border).frame(height: 1)

                        Toggle(isOn: $pushAfterCommit) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Push after commit")
                                    .font(RelayTheme.uiFont(14))
                                    .foregroundStyle(theme.foreground)
                                Text("Push this branch to its remote upstream")
                                    .font(RelayTheme.uiFont(12))
                                    .foregroundStyle(theme.foregroundMuted)
                            }
                        }
                        .tint(theme.accent)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                    }
                    .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .stroke(theme.border, lineWidth: 1)
                    )

                    if let errorMessage {
                        Text(errorMessage)
                            .font(RelayTheme.uiFont(12))
                            .foregroundStyle(theme.statusDanger)
                    }
                }
                .padding(16)
            }

            HStack(spacing: 10) {
                Button { dismiss() } label: {
                    Text("Cancel")
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .frame(maxWidth: .infinity, minHeight: 42)
                        .background(theme.surface3, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(isSubmitting)

                Button {
                    submit()
                } label: {
                    HStack(spacing: 8) {
                        if isSubmitting {
                            ProgressView()
                                .controlSize(.small)
                                .tint(theme.accentForeground)
                        }
                        Text(isSubmitting ? "Committing…" : (pushAfterCommit ? "Commit & Push" : "Commit"))
                            .font(RelayTheme.uiFont(14, weight: .medium))
                            .foregroundStyle(theme.accentForeground)
                    }
                    .frame(maxWidth: .infinity, minHeight: 42)
                    .background(theme.accent, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .opacity(canSubmit ? 1 : 0.5)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .overlay(alignment: .top) {
                Rectangle().fill(theme.border).frame(height: 1)
            }
        }
        .background(theme.surface0.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .onAppear {
            messageFocused = true
        }
    }

    private func submit() {
        isSubmitting = true
        errorMessage = nil
        Task {
            let error = await onCommit(message, stageAll, pushAfterCommit)
            isSubmitting = false
            if let error {
                errorMessage = error
            } else {
                dismiss()
            }
        }
    }
}

// MARK: - Jump To File Sheet

private struct RelayJumpToFileSheet: View {
    @Environment(\.relayTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let files: [RelayGitDiffFile]
    let onSelectFile: (String) -> Void

    @State private var query = ""

    private var filteredFiles: [RelayGitDiffFile] {
        guard let needle = query.trimmedNonEmpty else { return files }
        return files.filter { $0.path.localizedCaseInsensitiveContains(needle) }
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("Changed files (\(files.count))")
                    .font(RelayTheme.uiFont(15, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(width: 32, height: 32)
                        .background(theme.surface2, in: Circle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .overlay(alignment: .bottom) {
                Rectangle().fill(theme.border).frame(height: 1)
            }

            if files.count > 6 {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13))
                        .foregroundStyle(theme.foregroundMuted)
                    TextField("Filter files…", text: $query)
                        .font(RelayTheme.uiFont(14))
                        .foregroundStyle(theme.foreground)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                .padding(.horizontal, 12)
                .frame(height: 38)
                .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(theme.border, lineWidth: 1)
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }

            ScrollView {
                LazyVStack(spacing: 0) {
                    ForEach(filteredFiles) { file in
                        Button {
                            onSelectFile(file.path)
                            dismiss()
                        } label: {
                            HStack(spacing: 10) {
                                Text(file.shortStatusBadge)
                                    .font(RelayTheme.monoFont(11, weight: .semibold))
                                    .foregroundStyle(badgeColor(for: file.status))
                                    .frame(width: 22, height: 22)
                                    .background(theme.surface2, in: RoundedRectangle(cornerRadius: 5, style: .continuous))

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(file.fileName)
                                        .font(RelayTheme.uiFont(14, weight: .regular))
                                        .foregroundStyle(theme.foreground)
                                        .lineLimit(1)
                                    if let dir = file.directoryPath {
                                        Text(dir)
                                            .font(RelayTheme.uiFont(12))
                                            .foregroundStyle(theme.foregroundMuted)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)

                                RelayDiffStatView(additions: file.added, deletions: file.deleted)
                                    .fixedSize()
                            }
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .overlay(alignment: .bottom) {
                            Rectangle().fill(theme.border).frame(height: 1)
                        }
                    }
                }
                .padding(.bottom, 24)
            }
        }
        .background(theme.surface0.ignoresSafeArea())
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func badgeColor(for status: String) -> Color {
        switch status.lowercased() {
        case "added", "untracked": return theme.statusSuccess
        case "deleted": return theme.statusDanger
        case "renamed": return theme.accent
        default: return theme.statusWarning
        }
    }
}

// MARK: - Commit Diff Sheet

private struct RelayCommitDiffSheet: View {
    private enum ActiveSheet: Identifiable {
        case jumpToFile
        case review(RelayDiffLineTarget)

        var id: String {
            switch self {
            case .jumpToFile:
                return "jumpToFile"
            case .review(let target):
                return "review:\(target.id)"
            }
        }
    }

    @Environment(\.relayTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    let commit: RelayGitCommit
    let fetchDiff: () async throws -> RelayGitDiffResponse
    let onOpenFile: ((String) -> Void)?
    let onAttachFileToChat: ((String) -> Void)?
    let onSendReviewComment: ((String) -> Void)?

    @State private var diff: RelayGitDiffResponse?
    @State private var isLoading = true
    @State private var errorMessage: String?
    @State private var collapsedFiles: Set<String> = []
    @State private var wrapLines = false
    @State private var activeSheet: ActiveSheet?
    @State private var pendingScrollFilePath: String?
    @State private var dismissAfterNestedSheet = false

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(spacing: 6) {
                        Text(commit.shortSha)
                            .font(RelayTheme.monoFont(11, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(theme.surface2, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
                        if !commit.relativeDate.isEmpty {
                            Text(commit.relativeDate)
                                .font(RelayTheme.uiFont(12))
                                .foregroundStyle(theme.foregroundMuted)
                        }
                        if let diff {
                            RelayDiffStatView(additions: diff.totalAdded, deletions: diff.totalDeleted)
                        }
                    }
                    Text(commit.subject.trimmedNonEmpty ?? "(no commit message)")
                        .font(RelayTheme.uiFont(15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(2)
                    if !commit.author.isEmpty {
                        Text(commit.author)
                            .font(RelayTheme.uiFont(12))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 4) {
                    if let diff, !diff.files.isEmpty {
                        Button { activeSheet = .jumpToFile } label: {
                            Image(systemName: "list.bullet.indent")
                                .font(.system(size: 14))
                                .foregroundStyle(theme.foregroundMuted)
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Jump to file")

                        Button { wrapLines.toggle() } label: {
                            Image(systemName: "arrow.turn.down.left")
                                .font(.system(size: 14))
                                .foregroundStyle(wrapLines ? theme.foreground : theme.foregroundMuted)
                                .frame(width: 32, height: 32)
                                .background(
                                    wrapLines ? theme.interactionHighlight : Color.clear,
                                    in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                )
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Toggle line wrap")
                    }

                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(width: 32, height: 32)
                            .background(theme.surface2, in: Circle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Close commit diff")
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .overlay(alignment: .bottom) {
                Rectangle().fill(theme.border).frame(height: 1)
            }

            // Diff content
            if isLoading {
                VStack(spacing: 10) {
                    ProgressView().tint(theme.foregroundMuted)
                    Text("Loading commit diff…")
                        .font(RelayTheme.uiFont(13))
                        .foregroundStyle(theme.foregroundMuted)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let errorMessage {
                VStack(spacing: 10) {
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 24))
                        .foregroundStyle(theme.statusDanger)
                    Text("Couldn't load commit diff")
                        .font(RelayTheme.uiFont(15, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    Text(errorMessage)
                        .font(RelayTheme.uiFont(13))
                        .foregroundStyle(theme.foregroundMuted)
                        .multilineTextAlignment(.center)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let diff, !diff.files.isEmpty {
                RelayUnifiedDiffDocumentView(
                    files: diff.files,
                    truncated: diff.truncated,
                    collapsedFiles: collapsedFiles,
                    wrapLines: wrapLines,
                    allowsDiscard: false,
                    scrollToFilePath: $pendingScrollFilePath,
                    onToggleCollapse: { path in
                        if collapsedFiles.contains(path) {
                            collapsedFiles.remove(path)
                        } else {
                            collapsedFiles.insert(path)
                        }
                    },
                    onOpenFile: onOpenFile,
                    onAttachFileToChat: onAttachFileToChat,
                    onDiscardFile: nil,
                    onTapLine: { target in
                        guard onSendReviewComment != nil else { return }
                        activeSheet = .review(target)
                    },
                    onHorizontalDragActive: nil,
                    onRefresh: nil
                )
            } else {
                Text("No file changes in this commit.")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(theme.surface0.ignoresSafeArea())
        .task {
            isLoading = true
            errorMessage = nil
            do {
                diff = try await fetchDiff()
            } catch {
                if !isCancellation(error) {
                    errorMessage = error.localizedDescription
                }
            }
            isLoading = false
        }
        .sheet(item: $activeSheet, onDismiss: {
            if dismissAfterNestedSheet {
                dismissAfterNestedSheet = false
                dismiss()
            }
        }) { sheet in
            switch sheet {
            case .jumpToFile:
                RelayJumpToFileSheet(files: diff?.files ?? []) { path in
                    collapsedFiles.remove(path)
                    pendingScrollFilePath = path
                }
            case .review(let target):
                RelayDiffReviewCommentSheet(target: target) { formatted in
                    onSendReviewComment?(formatted)
                    dismissAfterNestedSheet = true
                }
            }
        }
    }
}

// MARK: - Safari Sheet for PRs

private struct RelayGitSafariSheet: UIViewControllerRepresentable {
    let url: URL

    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }

    func updateUIViewController(_ controller: SFSafariViewController, context: Context) {}
}
