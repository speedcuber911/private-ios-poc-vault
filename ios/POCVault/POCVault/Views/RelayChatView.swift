import AVFoundation
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers
import UIKit

/// Shared legacy style tokens kept for compatibility with sibling views
/// (`RelayApprovalCard`, `RelayComposerSheets`, `RelayMarkdownViews`).
enum RelayChatStyle {
    static let secondary = AppTheme.textPrimary.opacity(0.72)
    static let surface = AppTheme.textPrimary.opacity(0.06)
    static let bodyFont = Font.body
    static let labelFont = Font.subheadline
}

// MARK: - Local Queued Draft & @File Mention Context

private struct RelayLocalQueuedDraft: Identifiable, Equatable {
    let id: UUID
    var text: String
    let createdAt: Date

    init(id: UUID = UUID(), text: String, createdAt: Date = Date()) {
        self.id = id
        self.text = text
        self.createdAt = createdAt
    }
}

/// The `@file` mention fragment touching the current caret. Starts at the
/// beginning of the draft or after whitespace so email addresses never trigger it.
private struct RelayMentionContext: Equatable {
    let range: NSRange
    let query: String

    static func find(in text: String, selection: NSRange) -> RelayMentionContext? {
        let value = text as NSString
        guard selection.length == 0, selection.location >= 0, selection.location <= value.length else {
            return nil
        }

        let whitespace = CharacterSet.whitespacesAndNewlines
        var start = selection.location
        while start > 0 {
            let scalar = value.character(at: start - 1)
            guard let unicode = UnicodeScalar(scalar), !whitespace.contains(unicode) else { break }
            start -= 1
        }
        guard start < value.length, value.substring(with: NSRange(location: start, length: 1)) == "@" else {
            return nil
        }
        if start > 0 {
            let previous = value.character(at: start - 1)
            guard let scalar = UnicodeScalar(previous), whitespace.contains(scalar) else { return nil }
        }

        var end = selection.location
        while end < value.length {
            let scalar = value.character(at: end)
            guard let unicode = UnicodeScalar(scalar), !whitespace.contains(unicode) else { break }
            end += 1
        }

        let typedRange = NSRange(location: start, length: selection.location - start)
        let typed = value.substring(with: typedRange)
        return RelayMentionContext(
            range: NSRange(location: start, length: end - start),
            query: String(typed.dropFirst()).lowercased()
        )
    }
}

// MARK: - Server Queued Inputs View (public/internal compatibility)

struct RelayQueuedInputs: View {
    let messages: [RelayJobInputMessage]
    let provider: CodexProvider?
    let canSteer: Bool
    let isSending: Bool
    let onSendNow: (RelayJobInputMessage) -> Void
    @Environment(\.relayTheme) private var theme
    @State private var contentHeight: CGFloat = 68

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(messages) { message in
                    HStack(alignment: .center, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(message.status == "failed" ? "Delivery not confirmed" : message.status == "sending" ? "Sending…" : "Queued")
                                .font(RelayTheme.uiFont(11.5, weight: .medium))
                                .foregroundStyle(message.status == "failed" ? theme.statusDanger : theme.foregroundMuted)
                            Text(message.text)
                                .font(RelayTheme.uiFont(13.5))
                                .foregroundStyle(theme.foreground)
                                .lineLimit(2)
                            if let error = message.error {
                                Text(error)
                                    .font(RelayTheme.uiFont(11.5))
                                    .foregroundStyle(theme.foregroundExtraMuted)
                            }
                        }
                        Spacer(minLength: 4)
                        if message.status == "queued", canSteer {
                            Button(provider == .codex ? "Steer now" : "Send now") {
                                onSendNow(message)
                            }
                            .font(RelayTheme.uiFont(12.5, weight: .medium))
                            .foregroundStyle(theme.accentBright)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 32)
                            .background(theme.surface2, in: Capsule())
                            .disabled(isSending)
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: RelayInputQueueHeight.self, value: geometry.size.height)
            })
        }
        .frame(height: min(contentHeight, 132))
        .onPreferenceChange(RelayInputQueueHeight.self) { height in
            if height > 0 { contentHeight = height }
        }
        .tint(theme.accent)
        .accessibilityIdentifier("relay-queued-inputs")
    }
}

private struct RelayInputQueueHeight: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

extension View {
    func relayHiddenListRow() -> some View {
        self
            .listRowSeparator(.hidden)
            .listSectionSeparator(.hidden)
            .listRowBackground(AppTheme.bgCanvas)
    }
}

// MARK: - RelayChatView

struct RelayChatView: View {
    @Environment(\.relayTheme) private var theme
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject var viewModel: RelayChatViewModel
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore
    /// Set when the chat is presented as a folder's full-screen cover; shows the
    /// dismiss chevron in the top bar. Dismissing never cancels streams (VM-owned).
    var onDismiss: (() -> Void)? = nil
    var onOpenSidebar: (() -> Void)? = nil
    var onNewChat: (() -> Void)? = nil
    var onChooseProject: (() -> Void)? = nil
    /// Raised by the root when a handoff push is tapped: open the threads list,
    /// which is where handoff cards live.
    var threadsRequest: Binding<Bool> = .constant(false)
    /// Continue from a handoff opened in the wrong chat (the root, after a push)
    /// rebinds the cover to that checkout folder, then resumes there.
    var onBindChatToFolder: ((_ folderPath: String, _ workspaceID: String?, _ card: RelayHandoffCard) -> Void)? = nil
    /// New-session entry points ask for the owning agent/model after the server catalog
    /// has loaded. Existing-thread and push entry points leave the picker closed.
    var presentsProviderPickerOnAppear = false
    /// Source-job inspection never replays its historical request to show an app.
    var automaticallyOpensPreviews = true
    /// The app's one power model: whether the machine is up decides what the
    /// composer says and whether background refreshes run at all.
    @ObservedObject var powerModel: RelayMachinePowerModel
    var machineName = RelayMachineLabel.fallback

    // MARK: Paseo 3-panel shell & composer integration parameters (all optional with defaults)
    var embedsOwnHeader: Bool = true
    var onOpenExplorer: (() -> Void)? = nil
    var workspaceFiles: [String] = []
    var onForkConversation: ((String) -> Void)? = nil
    var activeTerminalContent: (() -> AnyView)? = nil

    @ObservedObject private var themeStore = RelayThemeStore.shared

    @State private var showingThreads = false
    @State private var threadsPreferLarge = false
    @State private var fullLogRequest: RelayFullLogRequest?
    @State private var artifactRequest: CodexJobArtifact?
    @State private var attachmentRequest: RelayDisplayedAttachment?
    @State private var remotePreviewRequest: RelayRemotePreviewRequest?
    @State private var automaticallyOpenedPreviews: Set<String> = []
    @State private var modelPickerRequest = 0
    @State private var didHandleInitialProviderPicker = false
    @State private var aiDataConsentRequest: RelayAIDataConsentRequest?
    @State private var sendImmediately = false
    @State private var providerLoginRequest: CodexProvider?
    @State private var activityRequest: RelayActivityRequest?
    @State private var showingSubagentsSheet = false
    @State private var showingTasksSheet = false
    @State private var showingTerminalSheet = false
    @State private var showingUsage = false
    @State private var localQueue: [RelayLocalQueuedDraft] = []
    @State private var fetchedWorkspaceFiles: [String] = []
    @State private var fetchedFilesScopePath: String?
    @StateObject private var scroller = RelayTranscriptScroller()
    @State private var backSwipeOffset: CGFloat = 0
    @State private var viewportWidth: CGFloat = 0
    @State private var finishingBackSwipe = false

    private var isTurnRunning: Bool {
        viewModel.isStreaming || viewModel.hasActiveConversationJob
    }

    private var effectiveWorkspaceFiles: [String] {
        workspaceFiles.isEmpty ? fetchedWorkspaceFiles : workspaceFiles
    }

    private var activeTodoItems: [RelayTodoItem] {
        for item in viewModel.messages.reversed() {
            if let job = item.job, let timeline = viewModel.timeline(forJobID: job.id) {
                let todos = timeline.latestTodoItems
                if !todos.isEmpty { return todos }
            }
            if let timeline = item.historyTimeline {
                let todos = timeline.latestTodoItems
                if !todos.isEmpty { return todos }
            }
        }
        return []
    }

    var body: some View {
        let subagents = viewModel.subagents
        let todos = activeTodoItems

        NavigationStack {
            ZStack {
                theme.surface0.ignoresSafeArea()

                VStack(spacing: 0) {
                    if embedsOwnHeader {
                        VStack(spacing: 0) {
                            topBar
                            Rectangle()
                                .fill(theme.border)
                                .frame(height: 1)
                        }
                        .background(theme.surface0.ignoresSafeArea(edges: .top))
                        .overlay(alignment: .bottom) {
                            LinearGradient(
                                colors: [theme.surface0, theme.surface0.opacity(0)],
                                startPoint: .top,
                                endPoint: .bottom
                            )
                            .frame(height: Self.headerFade)
                            .offset(y: Self.headerFade)
                            .allowsHitTesting(false)
                        }
                        .zIndex(1)
                        .simultaneousGesture(keyboardDismissTap)
                    }

                    ZStack {
                        if isEmptyConversation {
                            welcomeCanvas
                        } else {
                            messageList
                        }
                    }
                    .layoutPriority(1)
                    .contentShape(Rectangle())
                    .simultaneousGesture(keyboardDismissTap)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !showingThreads {
                    VStack(alignment: .leading, spacing: 0) {
                        if !subagents.isEmpty || !todos.isEmpty || activeTerminalContent != nil {
                            floatingTracksRow(subagents: subagents, todos: todos)
                        }

                        if let onChooseProject {
                            if viewModel.messages.isEmpty {
                                Button(action: onChooseProject) { projectContextLabel }
                                    .buttonStyle(.plain)
                                    .disabled(viewModel.isSending)
                                    .accessibilityIdentifier("relay-chat-project")
                            } else {
                                projectContextLabel
                            }
                        }

                        RelayComposer(
                            text: $viewModel.prompt,
                            attachments: $viewModel.draftAttachments,
                            sections: viewModel.pickerSections,
                            selectedChoice: viewModel.selectedChoice,
                            modelPickerRequest: modelPickerRequest,
                            threadProvider: viewModel.currentSessionProvider,
                            efforts: viewModel.availableEfforts,
                            selectedEffort: viewModel.effectiveEffort,
                            provider: viewModel.selectedTaskProvider,
                            harnessStatus: viewModel.selectedHarnessStatus,
                            skills: viewModel.availableSkills,
                            selectedSkillIDs: viewModel.selectedSkillIDs,
                            claudePermissionMode: viewModel.claudePermissionMode,
                            codexApprovalPolicy: viewModel.codexApprovalPolicy,
                            codexSandbox: viewModel.codexSandbox,
                            isSending: viewModel.isSending,
                            isStreaming: viewModel.isStreaming,
                            isTurnRunning: isTurnRunning,
                            sendWhileRunning: themeStore.sendWhileRunning,
                            workspaceFiles: effectiveWorkspaceFiles,
                            localQueue: localQueue,
                            serverPendingInputs: viewModel.pendingInputs,
                            canSteerServerInputs: viewModel.canSteerConversation,
                            onPickChoice: { viewModel.selectChoice($0) },
                            onPickEffort: { viewModel.selectEffort($0) },
                            onToggleSkill: { viewModel.toggleSkill($0) },
                            onPickClaudePermission: { viewModel.claudePermissionMode = $0 },
                            onPickCodexApproval: { viewModel.codexApprovalPolicy = $0 },
                            onPickCodexSandbox: { viewModel.selectCodexSandbox($0) },
                            onNewConversation: { startNewConversation() },
                            onClearConversation: { startNewConversation() },
                            onCompactConversation: { triggerCompactPrompt() },
                            onSend: {
                                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                                handlePrimarySendTap()
                            },
                            onStop: {
                                UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                                stopActiveRun()
                            },
                            onConnectProvider: { provider in
                                providerLoginRequest = provider
                            },
                            onAddAttachments: { viewModel.addDraftAttachments($0) },
                            onRemoveAttachment: { viewModel.removeDraftAttachment(id: $0) },
                            machineState: composerMachineState,
                            isDeliveringPrompt: viewModel.isDeliveringPrompt,
                            activeRunProvider: viewModel.canSteerConversation ? viewModel.activeConversationJob?.provider : nil,
                            onSendNow: {
                                requestPromptSend(now: true)
                            },
                            onEnqueueLocal: { text in
                                enqueueLocalDraft(text)
                            },
                            onEditLocalQueue: { draft in
                                editLocalQueuedDraft(draft)
                            },
                            onSendLocalQueueNow: { draft in
                                sendLocalQueuedDraftNow(draft)
                            },
                            onRemoveLocalQueue: { draft in
                                localQueue.removeAll { $0.id == draft.id }
                            },
                            onSendServerQueueNow: { message in
                                Task { await viewModel.sendQueuedInputNow(message) }
                            },
                            onRequestWorkspaceFiles: {
                                Task { await loadWorkspaceFilesIfNeeded() }
                            }
                        )
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .modifier(RelayChatLifecycleModifier(
            viewModel: viewModel,
            powerModel: powerModel,
            presentsProviderPickerOnAppear: presentsProviderPickerOnAppear,
            threadsRequest: threadsRequest,
            latestSignInFailureJobID: latestSignInFailureJobID,
            isTurnRunning: isTurnRunning,
            automaticPreviewCandidateKey: automaticPreviewCandidate?.key,
            didHandleInitialProviderPicker: $didHandleInitialProviderPicker,
            modelPickerRequest: $modelPickerRequest,
            activityRequest: $activityRequest,
            showingSubagentsSheet: $showingSubagentsSheet,
            showingTasksSheet: $showingTasksSheet,
            localQueue: $localQueue,
            onHonorThreadsRequest: honorThreadsRequest,
            onLoadWorkspaceFilesIfNeeded: { await loadWorkspaceFilesIfNeeded() },
            onDrainNextLocalQueuedDraftIfReady: drainNextLocalQueuedDraftIfReady,
            onOpenRequestedPreviewIfNeeded: openRequestedPreviewIfNeeded
        ))
        .modifier(RelayChatPresentationsModifier(
            viewModel: viewModel,
            client: client,
            identityStore: identityStore,
            powerModel: powerModel,
            theme: theme,
            activeTodoItems: todos,
            activeTerminalContent: activeTerminalContent,
            threadsPreferLarge: threadsPreferLarge,
            providerLoginRequest: $providerLoginRequest,
            showingThreads: $showingThreads,
            fullLogRequest: $fullLogRequest,
            showingUsage: $showingUsage,
            activityRequest: $activityRequest,
            showingSubagentsSheet: $showingSubagentsSheet,
            showingTasksSheet: $showingTasksSheet,
            showingTerminalSheet: $showingTerminalSheet,
            aiDataConsentRequest: $aiDataConsentRequest,
            artifactRequest: $artifactRequest,
            attachmentRequest: $attachmentRequest,
            remotePreviewRequest: $remotePreviewRequest,
            onContinueHandoff: { card in await continueHandoff(card) },
            onSendPrompt: sendPrompt
        ))
        .preferredColorScheme(theme.colorScheme)
        .background {
            GeometryReader { geometry in
                Color.clear
                    .onAppear { viewportWidth = geometry.size.width }
                    .onChange(of: geometry.size.width) { _, width in viewportWidth = width }
            }
            .allowsHitTesting(false)
        }
        .offset(x: reduceMotion ? 0 : backSwipeOffset)
        .presentationBackground(.clear)
        .simultaneousGesture(backSwipeGesture)
    }

    // MARK: - Floating Tracks Above Composer

    private func floatingTracksRow(subagents: [RelaySubagent], todos: [RelayTodoItem]) -> some View {
        HStack(spacing: 8) {
            if !subagents.isEmpty {
                RelayFloatingSubagentsPill(subagents: subagents) {
                    dismissKeyboard()
                    showingSubagentsSheet = true
                }
            }

            if !todos.isEmpty {
                RelayFloatingTasksPill(items: todos) {
                    dismissKeyboard()
                    showingTasksSheet = true
                }
            }

            if activeTerminalContent != nil {
                Button {
                    dismissKeyboard()
                    showingTerminalSheet = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "terminal")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)
                        Text("Terminal")
                            .font(RelayTheme.uiFont(13, weight: .medium))
                            .foregroundStyle(theme.foreground)
                    }
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(theme.surface2, in: Capsule())
                    .overlay {
                        Capsule().strokeBorder(theme.border, lineWidth: 1)
                    }
                    .shadow(color: Color.black.opacity(theme.isDark ? 0.28 : 0.10), radius: 8, y: 3)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-floating-terminal-pill")
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.bottom, 6)
        .padding(.top, 2)
    }

    // MARK: - Queue & Turn Controls

    private func handlePrimarySendTap() {
        let trimmed = viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if isTurnRunning {
            switch themeStore.sendWhileRunning {
            case .queue:
                if viewModel.canSteerConversation && viewModel.draftAttachments.isEmpty {
                    requestPromptSend(now: false)
                } else if !trimmed.isEmpty {
                    enqueueLocalDraft(trimmed)
                    viewModel.prompt = ""
                }
            case .interrupt:
                stopActiveRun()
                requestPromptSend(now: false)
            case .steer:
                if viewModel.canSteerConversation {
                    requestPromptSend(now: false)
                } else if !trimmed.isEmpty {
                    enqueueLocalDraft(trimmed)
                    viewModel.prompt = ""
                }
            }
            return
        }
        requestPromptSend(now: false)
    }

    private func stopActiveRun() {
        if viewModel.isStreaming {
            viewModel.stopStreaming()
        }
        if let activeJob = viewModel.activeConversationJob {
            Task { await viewModel.cancel(job: activeJob) }
        }
    }

    private func enqueueLocalDraft(_ rawText: String) {
        let trimmed = rawText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        withAnimation(.easeOut(duration: 0.16)) {
            localQueue.append(RelayLocalQueuedDraft(text: trimmed))
        }
    }

    private func editLocalQueuedDraft(_ draft: RelayLocalQueuedDraft) {
        withAnimation(.easeOut(duration: 0.16)) {
            localQueue.removeAll { $0.id == draft.id }
        }
        if viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            viewModel.prompt = draft.text
        } else {
            viewModel.prompt += "\n" + draft.text
        }
    }

    private func sendLocalQueuedDraftNow(_ draft: RelayLocalQueuedDraft) {
        withAnimation(.easeOut(duration: 0.16)) {
            localQueue.removeAll { $0.id == draft.id }
        }
        if viewModel.canSteerConversation {
            viewModel.prompt = draft.text
            requestPromptSend(now: true)
        } else {
            stopActiveRun()
            viewModel.prompt = draft.text
            requestPromptSend(now: false)
        }
    }

    private func drainNextLocalQueuedDraftIfReady() {
        guard !isTurnRunning, !viewModel.isSending, !localQueue.isEmpty else { return }
        let next = localQueue.removeFirst()
        viewModel.prompt = next.text
        requestPromptSend(now: false)
    }

    // MARK: - Fork & Compact Helpers

    private func forkConversation(upTo itemID: String?, fallbackText: String) {
        dismissKeyboard()
        let curatedPrompt = buildForkPrompt(upTo: itemID, fallbackText: fallbackText)
        if let onForkConversation {
            onForkConversation(curatedPrompt)
            return
        }
        startNewConversation()
        viewModel.prompt = curatedPrompt
    }

    private func buildForkPrompt(upTo itemID: String?, fallbackText: String) -> String {
        var contextLines: [String] = []
        let items: [RelayConversationItem]
        if let itemID, let idx = viewModel.messages.firstIndex(where: { $0.id == itemID }) {
            items = Array(viewModel.messages.prefix(idx + 1).suffix(6))
        } else {
            items = Array(viewModel.messages.suffix(6))
        }
        for item in items {
            let body: String
            if let job = item.job {
                let prose = viewModel.timeline(forJobID: job.id)?.proseText.trimmedNonEmpty
                    ?? job.displayOutput?.trimmedNonEmpty ?? ""
                body = prose
            } else {
                body = item.text.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            guard !body.isEmpty else { continue }
            let speaker = item.role == .user ? "User" : "Assistant"
            let snippet = body.count > 420 ? String(body.prefix(420)) + "…" : body
            contextLines.append("\(speaker): \(snippet)")
        }
        let summary = contextLines.isEmpty ? fallbackText : contextLines.joined(separator: "\n\n")
        return "Continuing from a forked conversation:\n\n\(summary)\n\nNext step: "
    }

    private func triggerCompactPrompt() {
        viewModel.prompt = "Summarize our progress so far, key decisions, modified files, and remaining next steps so we can continue cleanly."
    }

    // MARK: - Workspace File Index for @files Autocomplete

    private func loadWorkspaceFilesIfNeeded() async {
        guard workspaceFiles.isEmpty, !powerModel.isDown else { return }
        let scope = viewModel.workspacePath ?? ""
        if fetchedFilesScopePath == scope && !fetchedWorkspaceFiles.isEmpty { return }
        fetchedFilesScopePath = scope
        do {
            let root = try await client.fetchDirectory(path: viewModel.workspacePath, offset: 0, limit: 150)
            var paths: [String] = []
            for entry in root.entries {
                let display = entry.relativePath?.trimmedNonEmpty ?? entry.name
                paths.append(entry.kind == .dir ? "\(display)/" : display)
            }
            // Also fetch one level down for top source directories so `@files` feels immediate.
            let candidateDirs = root.entries
                .filter { $0.kind == .dir && !$0.name.hasPrefix(".") && $0.name != "node_modules" && $0.name != "build" && $0.name != "dist" }
                .prefix(4)
            for dir in candidateDirs {
                if let sub = try? await client.fetchDirectory(path: dir.path, offset: 0, limit: 60) {
                    for entry in sub.entries {
                        let rel = entry.relativePath?.trimmedNonEmpty ?? "\(dir.name)/\(entry.name)"
                        paths.append(entry.kind == .dir ? "\(rel)/" : rel)
                    }
                }
            }
            fetchedWorkspaceFiles = Array(NSOrderedSet(array: paths).compactMap { $0 as? String })
        } catch {
            // Silently skip; workspace file autocomplete will stay quiet offline.
        }
    }

    /// What the composer says about the machine while EC2 has it down.
    private var composerMachineState: RelayComposerMachineState? {
        guard powerModel.isDown else { return nil }
        return RelayComposerMachineState(
            status: powerModel.status,
            machineName: machineName,
            onStart: { Task { await powerModel.start() } }
        )
    }

    private var latestSignInFailureJobID: String? {
        viewModel.messages.last(where: { $0.job?.needsProviderSignIn == true })?.job?.id
    }

    private var backSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 16, coordinateSpace: .global)
            .onChanged { value in
                guard onDismiss != nil || onOpenSidebar != nil, !finishingBackSwipe,
                      value.startLocation.x <= 24,
                      value.translation.width > abs(value.translation.height) * 1.5 else { return }
                if onOpenSidebar == nil { backSwipeOffset = max(0, value.translation.width) }
            }
            .onEnded { value in
                if let onOpenSidebar, value.startLocation.x <= 24,
                   value.translation.width > 70, value.translation.width > abs(value.translation.height) * 1.5 {
                    onOpenSidebar()
                    return
                }
                guard backSwipeOffset > 0, let onDismiss, !finishingBackSwipe else { return }
                let isHorizontal = value.translation.width > abs(value.translation.height) * 1.5
                if isHorizontal && (value.translation.width > 100 || (value.translation.width > 40 && value.predictedEndTranslation.width > 220)) {
                    finishingBackSwipe = true
                    dismissKeyboard()
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) {
                        backSwipeOffset = max(viewportWidth, backSwipeOffset)
                    }
                    Task { @MainActor in
                        if !reduceMotion { try? await Task.sleep(for: .milliseconds(180)) }
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) { onDismiss() }
                    }
                } else {
                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.18)) { backSwipeOffset = 0 }
                }
            }
    }

    private var projectContextLabel: some View {
        HStack(spacing: 8) {
            if let name = viewModel.projectLabel {
                RelayProjectIcon(name: name, seed: viewModel.workspacePath ?? name, size: 18)
                Text(name)
                    .font(RelayTheme.uiFont(14, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
            } else {
                Image(systemName: "folder")
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                Text("Choose project")
                    .font(RelayTheme.uiFont(14, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
        .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
        .padding(.horizontal, 18)
        .contentShape(Rectangle())
    }

    private var isEmptyConversation: Bool {
        viewModel.messages.isEmpty && !viewModel.isLoadingThreadDetail && viewModel.errorMessage == nil
    }

    private var welcomeCanvas: some View {
        VStack(spacing: 10) {
            Spacer()
            if let project = viewModel.projectLabel {
                HStack(spacing: 8) {
                    RelayProjectIcon(name: project, seed: viewModel.workspacePath ?? project, size: 22)
                    Text(project)
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.foregroundMuted)
                }
                .padding(.bottom, 4)
            }
            Text("What are we\nworking on?")
                .font(RelayTheme.uiFont(28, weight: .medium))
                .foregroundStyle(theme.foreground)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
                .padding(.horizontal, 28)
                .accessibilityIdentifier("relay-chat-welcome")
            Spacer()
            Spacer().frame(maxHeight: 56)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Paseo compact standalone header (shown when `embedsOwnHeader == true`).
    private var topBar: some View {
        HStack(spacing: 6) {
            Button {
                dismissKeyboard()
                if let onOpenSidebar { onOpenSidebar() }
                else if let onDismiss { onDismiss() }
                else { showingThreads = true }
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 18, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 36, height: 36)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Open threads sidebar")
            .accessibilityIdentifier("relay-threads")

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(viewModel.messages.isEmpty ? "Relay" : viewModel.conversationTitle)
                    .font(RelayTheme.uiFont(16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .lineLimit(1)
                    .truncationMode(.tail)

                if !viewModel.messages.isEmpty,
                   let project = viewModel.projectLabel,
                   project != viewModel.conversationTitle {
                    Text(project)
                        .font(RelayTheme.uiFont(14, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            HStack(spacing: 2) {
                if !viewModel.messages.isEmpty, let provider = viewModel.selectedChoice?.model.provider {
                    Menu {
                        Button("Usage", systemImage: "chart.pie") { showingUsage = true }
                        Button("Fork in new chat", systemImage: "arrow.triangle.branch") {
                            forkConversation(upTo: nil, fallbackText: viewModel.conversationTitle)
                        }
                        if let path = viewModel.folderPathLabel {
                            Button("Copy folder path", systemImage: "doc.on.doc") { UIPasteboard.general.string = path }
                        }
                        Button("AI data sharing") { presentAIDataConsent(for: provider, purpose: .review) }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 16, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                    .accessibilityIdentifier("relay-chat-overflow")
                    .accessibilityLabel("Chat options")
                }

                if let onOpenExplorer {
                    RelayToolbarIconButton(
                        systemImage: "plusminus",
                        accessibilityLabel: "Open files and changes",
                        iconSize: 16,
                        isMuted: true,
                        action: onOpenExplorer
                    )
                }

                RelayToolbarIconButton(
                    systemImage: "square.and.pencil",
                    accessibilityLabel: "New chat",
                    iconSize: 17,
                    isMuted: true,
                    action: startNewConversation
                )
                .accessibilityIdentifier("relay-new-chat")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 48)
    }

    private func honorThreadsRequest() {
        guard threadsRequest.wrappedValue else { return }
        threadsRequest.wrappedValue = false
        threadsPreferLarge = true
        showingThreads = true
    }

    private func startNewConversation() {
        dismissKeyboard()
        localQueue.removeAll()
        if let onNewChat { onNewChat() }
        else { viewModel.startNewConversation() }
    }

    private func requestPromptSend(now: Bool = false) {
        sendImmediately = now
        if viewModel.needsProjectForTask, let onChooseProject {
            dismissKeyboard()
            onChooseProject()
            return
        }
        guard let provider = viewModel.activeConversationJob?.provider ?? viewModel.selectedChoice?.model.provider else {
            sendPrompt()
            return
        }
        guard RelayAIDataConsentStore.hasConsent(for: provider) else {
            presentAIDataConsent(for: provider, purpose: .sendPrompt)
            return
        }
        sendPrompt()
    }

    /// Sending always returns the reader to the end of the transcript, where
    /// their message and its answer appear once the machine accepts it.
    private func sendPrompt() {
        scroller.jumpToLatest()
        let now = sendImmediately
        sendImmediately = false
        Task {
            if now { await viewModel.sendActivePrompt(now: true) }
            else { await viewModel.sendCurrentPrompt() }
        }
    }

    private func presentAIDataConsent(
        for provider: CodexProvider? = nil,
        purpose: RelayAIDataConsentPurpose
    ) {
        guard let provider = provider ?? viewModel.selectedChoice?.model.provider else { return }
        dismissKeyboard()
        aiDataConsentRequest = RelayAIDataConsentRequest(provider: provider, purpose: purpose)
    }

    private func continueHandoff(_ card: RelayHandoffCard) async {
        if let target = await viewModel.resolveHandoffFolder(card),
           target.path != viewModel.workspacePath,
           let onBindChatToFolder {
            showingThreads = false
            onBindChatToFolder(target.path, target.workspaceID, card)
            return
        }
        await viewModel.continueHandoff(card)
        showingThreads = false
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private var keyboardDismissTap: some Gesture {
        TapGesture().onEnded {
            dismissKeyboard()
        }
    }

    private var messageList: some View {
        let continuing = RelayTranscriptLayout.continuationIDs(in: viewModel.messages)
        let inlineApprovalJobs = Set(viewModel.messages.compactMap { item -> String? in
            guard let job = item.job, !item.hidesJobAnswer,
                  viewModel.timeline(forJobID: job.id) != nil else { return nil }
            return job.id
        })
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let control = viewModel.sessionControl {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Open in \(control.owner). Close it there to continue here.")
                                .font(RelayTheme.uiFont(14))
                                .foregroundStyle(theme.foregroundMuted)
                            if let url = control.claudeURL {
                                Link("Continue in Claude", destination: url)
                                    .font(RelayTheme.uiFont(14, weight: .medium))
                                    .tint(theme.accentBright)
                            }
                        }
                        .padding(.top, Self.turnSpacing)
                    }
                    if let error = viewModel.errorMessage {
                        RelayStatusBanner(text: error)
                            .padding(.top, Self.turnSpacing)
                    }

                    if viewModel.isLoadingThreadDetail {
                        if powerModel.isDown {
                            RelayMachineDownView(
                                powerModel: powerModel,
                                machineName: machineName,
                                purpose: "this conversation"
                            )
                            .frame(minHeight: 160)
                            .padding(.top, Self.turnSpacing)
                        } else {
                            ProgressView("Loading conversation…")
                                .tint(theme.accent)
                                .foregroundStyle(theme.foregroundMuted)
                                .frame(maxWidth: .infinity, minHeight: 120)
                                .padding(.top, Self.turnSpacing)
                        }
                    }

                    if viewModel.messages.isEmpty, !viewModel.isLoadingThreadDetail, viewModel.errorMessage == nil {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Start a conversation")
                                .font(RelayTheme.uiFont(20, weight: .medium))
                                .foregroundStyle(theme.foreground)
                            Text("Ask a question, mention @files, or type / for commands.")
                                .font(RelayTheme.uiFont(15))
                                .foregroundStyle(theme.foregroundMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(.top, 48)
                        .padding(.bottom, 24)
                    }

                    ForEach(viewModel.messages) { item in
                        let continues = continuing.contains(item.id)
                        transcriptRow(
                            item,
                            showsByline: false,
                            approvals: item.job.map { job in
                                inlineApprovalJobs.contains(job.id)
                                    ? viewModel.pendingApprovals.filter { $0.jobId == job.id }
                                    : []
                            } ?? []
                        )
                        .id(item.id)
                        .padding(.top, continues ? Self.blockSpacing : Self.turnSpacing)
                    }

                    ForEach(viewModel.pendingApprovals) { approval in
                        if !inlineApprovalJobs.contains(approval.jobId) {
                            RelayApprovalCard(approval: approval) { decision, answers in
                                Task { await viewModel.decideApproval(approval, decision, answers: answers) }
                            }
                            .id(approval.id)
                            .padding(.top, Self.turnSpacing)
                            .accessibilityIdentifier("relay-chat-approval")
                        }
                    }

                    Color.clear.frame(height: 1).id(Self.bottomAnchor)
                }
                .padding(.horizontal, RelayTranscriptStyle.gutter)
                .padding(.bottom, 16)
                .background {
                    RelayScrollViewFinder(scroller: scroller)
                    GeometryReader { content in
                        let frame = content.frame(in: .named(Self.scrollSpace))
                        Color.clear
                            .onAppear { scroller.measured(content: frame) }
                            .onChange(of: frame) { _, frame in scroller.measured(content: frame) }
                    }
                }
            }
            .coordinateSpace(name: Self.scrollSpace)
            .refreshable {
                await viewModel.refreshThreads()
                await viewModel.refreshWatchedThreadIfNeeded()
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .background {
                GeometryReader { viewport in
                    Color.clear
                        .onAppear { scroller.viewportHeight = viewport.size.height }
                        .onChange(of: viewport.size) { _, size in
                            scroller.viewportHeight = size.height
                            scroller.viewportChanged()
                        }
                        .onChange(of: viewport.safeAreaInsets.bottom) { _, _ in scroller.viewportChanged() }
                }
            }
            .onAppear {
                scroller.fallbackScroll = { animated in
                    if animated {
                        withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
                    } else {
                        proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
                    }
                }
                scroller.land()
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
                scroller.viewportChanged()
            }
            .onChange(of: viewModel.messages.first?.id) { _, _ in scroller.land() }
            .overlay(alignment: .bottom) {
                if !scroller.isAtBottom {
                    ZStack(alignment: .bottom) {
                        LinearGradient(
                            colors: [theme.surface0.opacity(0), theme.surface0],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                        .frame(height: 56)
                        .allowsHitTesting(false)
                        RelayJumpToLatestButton { scroller.jumpToLatest() }
                            .padding(.bottom, 8)
                    }
                    .transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.18), value: scroller.isAtBottom)
        }
    }

    @ViewBuilder
    private func transcriptRow(
        _ item: RelayConversationItem,
        showsByline: Bool,
        approvals: [CodexApproval]
    ) -> some View {
        if let job = item.job {
            if let timeline = viewModel.timeline(forJobID: job.id) {
                RelayJobTurn(
                    job: job,
                    timeline: timeline,
                    client: client,
                    hidesAnswer: item.hidesJobAnswer,
                    showsByline: showsByline,
                    isCancelling: viewModel.cancellingJobIDs.contains(job.id),
                    approvals: approvals,
                    onDecide: { approval, decision, answers in
                        Task { await viewModel.decideApproval(approval, decision, answers: answers) }
                    },
                    onCancel: {
                        Task { await viewModel.cancel(job: job) }
                    },
                    onFullLog: {
                        fullLogRequest = RelayFullLogRequest(jobID: job.id)
                    },
                    onArtifact: { artifact in
                        artifactRequest = artifact
                    },
                    onLoopbackURL: { url in
                        remotePreviewRequest = RelayRemotePreviewRequest(jobID: job.id, sourceURL: url)
                    },
                    onOpenBlock: { blockID in
                        activityRequest = RelayActivityRequest(source: .job(job.id), root: .block(blockID))
                    },
                    onOpenStep: { stepID in
                        activityRequest = RelayActivityRequest(source: .job(job.id), root: .step(stepID))
                    },
                    onFork: {
                        let fallback = timeline.proseText.trimmedNonEmpty ?? job.displayOutput ?? ""
                        forkConversation(upTo: item.id, fallbackText: fallback)
                    },
                    onSignIn: { providerLoginRequest = job.provider }
                )
                .equatable()
            } else {
                RelayJobCard(
                    job: job,
                    client: client,
                    liveTail: viewModel.liveJobTails[job.id],
                    hidesAnswer: item.hidesJobAnswer,
                    showsByline: showsByline,
                    isCancelling: viewModel.cancellingJobIDs.contains(job.id),
                    onCancel: {
                        Task { await viewModel.cancel(job: job) }
                    },
                    onFullLog: {
                        fullLogRequest = RelayFullLogRequest(jobID: job.id)
                    },
                    onArtifact: { artifact in
                        artifactRequest = artifact
                    },
                    onLoopbackURL: { url in
                        remotePreviewRequest = RelayRemotePreviewRequest(
                            jobID: job.id,
                            sourceURL: url
                        )
                    },
                    onFork: {
                        forkConversation(upTo: item.id, fallbackText: job.displayOutput ?? "")
                    },
                    onSignIn: { providerLoginRequest = job.provider }
                )
            }
        } else {
            RelayChatBubble(
                item: item,
                client: client,
                showsByline: showsByline,
                showsActions: isLastProseInTurn(item),
                onOpenAttachment: { attachment in
                    attachmentRequest = attachment
                },
                onOpenActivity: { blockID in
                    activityRequest = RelayActivityRequest(source: .message(item.id), root: .block(blockID))
                },
                onOpenStep: { stepID in
                    activityRequest = RelayActivityRequest(source: .message(item.id), root: .step(stepID))
                },
                onFork: {
                    forkConversation(upTo: item.id, fallbackText: item.text)
                }
            )
            .equatable()
        }
    }

    private func isLastProseInTurn(_ item: RelayConversationItem) -> Bool {
        guard !item.isStreaming, let index = viewModel.messages.firstIndex(where: { $0.id == item.id }) else { return false }
        for later in viewModel.messages.dropFirst(index + 1) {
            if later.role == .user { break }
            if !later.text.isEmpty || later.job?.status.isActive == true { return false }
        }
        return !viewModel.isSending && !viewModel.hasActiveConversationJob
    }

    private static let turnSpacing: CGFloat = 18
    private static let blockSpacing: CGFloat = 8
    private static let headerFade: CGFloat = 18
    private static let bottomAnchor = "relay-transcript-bottom"
    private static let scrollSpace = "relay-transcript-scroll"

    private var automaticPreviewCandidate: RelayAutomaticPreviewCandidate? {
        guard automaticallyOpensPreviews else { return nil }
        let jobs = viewModel.messages.compactMap(\.job).reversed()
        guard let triggerJob = jobs.first(where: {
            $0.status == .succeeded && relaySharedContract.requestsAutomaticPreview(prompt: $0.prompt)
        }) else { return nil }

        if let output = triggerJob.displayOutput,
           let sourceURL = RelayOutputURLPolicy.loopbackURLs(in: output).first {
            return RelayAutomaticPreviewCandidate(
                triggerJobID: triggerJob.id,
                previewJobID: triggerJob.id,
                sourceURL: sourceURL
            )
        }

        for sourceJob in jobs {
            if let output = sourceJob.displayOutput,
               let sourceURL = RelayOutputURLPolicy.loopbackURLs(in: output).first {
                return RelayAutomaticPreviewCandidate(
                    triggerJobID: triggerJob.id,
                    previewJobID: sourceJob.id,
                    sourceURL: sourceURL
                )
            }
        }
        return nil
    }

    private func openRequestedPreviewIfNeeded() {
        guard let candidate = automaticPreviewCandidate,
              automaticallyOpenedPreviews.insert(candidate.key).inserted else { return }
        remotePreviewRequest = RelayRemotePreviewRequest(
            jobID: candidate.previewJobID,
            sourceURL: candidate.sourceURL
        )
    }
}

// MARK: - Floating Tasks Pill & Sheet

private struct RelayFloatingTasksPill: View {
    let items: [RelayTodoItem]
    let action: () -> Void
    @Environment(\.relayTheme) private var theme

    private var completedCount: Int {
        items.filter {
            let norm = ($0.status ?? "").lowercased()
            return norm == "completed" || norm == "done"
        }.count
    }

    private var hasInProgress: Bool {
        items.contains {
            let norm = ($0.status ?? "").lowercased()
            return norm == "in_progress" || norm == "doing" || norm == "running"
        }
    }

    private var label: String {
        "\(completedCount)/\(items.count) tasks"
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if hasInProgress {
                    RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                } else {
                    Image(systemName: "checklist")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(completedCount == items.count ? theme.statusSuccess : theme.foregroundMuted)
                }
                Text(label)
                    .font(RelayTheme.uiFont(13, weight: .medium))
                    .foregroundStyle(theme.foreground)
                    .monospacedDigit()
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
            .background(theme.surface2, in: Capsule())
            .overlay {
                Capsule().strokeBorder(theme.border, lineWidth: 1)
            }
            .shadow(color: Color.black.opacity(theme.isDark ? 0.28 : 0.10), radius: 8, y: 3)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-floating-tasks-pill")
    }
}

private struct RelayTasksSheet: View {
    let items: [RelayTodoItem]
    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme

    private var completedCount: Int {
        items.filter {
            let norm = ($0.status ?? "").lowercased()
            return norm == "completed" || norm == "done"
        }.count
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "checklist")
                    .font(.system(size: 16))
                    .foregroundStyle(theme.foregroundMuted)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Tasks")
                        .font(RelayTheme.uiFont(16, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    Text("\(completedCount) of \(items.count) completed")
                        .font(RelayTheme.uiFont(12.5))
                        .foregroundStyle(theme.foregroundMuted)
                }
                Spacer()
                RelayToolbarIconButton(
                    systemImage: "xmark",
                    accessibilityLabel: "Close tasks",
                    iconSize: 14,
                    weight: .medium,
                    isMuted: true
                ) {
                    dismiss()
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Rectangle().fill(theme.border).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                        let norm = (item.status ?? "").lowercased()
                        let isDone = norm == "completed" || norm == "done"
                        let isActive = norm == "in_progress" || norm == "doing" || norm == "running"
                        HStack(alignment: .top, spacing: 12) {
                            Group {
                                if isDone {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundStyle(theme.statusSuccess)
                                } else if isActive {
                                    RelayStatusRing(isActive: true, size: 13, lineWidth: 1.5, showsCenterDot: true)
                                } else {
                                    Circle()
                                        .strokeBorder(theme.foregroundExtraMuted, lineWidth: 1.3)
                                        .frame(width: 12, height: 12)
                                }
                            }
                            .frame(width: 18, height: 20, alignment: .center)

                            Text(item.text)
                                .font(RelayTheme.uiFont(14.5))
                                .foregroundStyle(isDone ? theme.foregroundMuted : theme.foreground)
                                .strikethrough(isDone, color: theme.foregroundExtraMuted)
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)

                        if index + 1 < items.count {
                            Rectangle()
                                .fill(theme.border)
                                .frame(height: 1)
                                .padding(.leading, 46)
                        }
                    }
                }
                .padding(.vertical, 6)
            }
        }
        .background(theme.surface0)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationBackground(theme.surface0)
        .preferredColorScheme(theme.colorScheme)
    }
}

// MARK: - Shallow Chat Lifecycle & Presentation Modifiers

private struct RelayChatLifecycleModifier: ViewModifier {
    @ObservedObject var viewModel: RelayChatViewModel
    @ObservedObject var powerModel: RelayMachinePowerModel
    let presentsProviderPickerOnAppear: Bool
    let threadsRequest: Binding<Bool>
    let latestSignInFailureJobID: String?
    let isTurnRunning: Bool
    let automaticPreviewCandidateKey: String?

    @Binding var didHandleInitialProviderPicker: Bool
    @Binding var modelPickerRequest: Int
    @Binding var activityRequest: RelayActivityRequest?
    @Binding var showingSubagentsSheet: Bool
    @Binding var showingTasksSheet: Bool
    @Binding var localQueue: [RelayLocalQueuedDraft]

    let onHonorThreadsRequest: () -> Void
    let onLoadWorkspaceFilesIfNeeded: () async -> Void
    let onDrainNextLocalQueuedDraftIfReady: () -> Void
    let onOpenRequestedPreviewIfNeeded: () -> Void

    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task {
                onHonorThreadsRequest()
                await viewModel.bootstrap()
                if presentsProviderPickerOnAppear, !didHandleInitialProviderPicker {
                    didHandleInitialProviderPicker = true
                    modelPickerRequest += 1
                }
                await onLoadWorkspaceFilesIfNeeded()
            }
            .task(id: "\(scenePhase)-\(viewModel.watchedSessionID ?? "")") {
                guard scenePhase == .active, viewModel.watchedSessionID != nil else { return }
                while !Task.isCancelled {
                    if !powerModel.isDown { await viewModel.refreshWatchedThreadIfNeeded() }
                    do { try await Task.sleep(for: .seconds(viewModel.nativeWatchPollInterval)) }
                    catch { return }
                    if Task.isCancelled { return }
                    if powerModel.isDown { continue }
                    if viewModel.watchedSessionID == nil { return }
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active, !powerModel.isDown {
                    Task { await viewModel.refreshModels() }
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(60)) }
                    catch { return }
                    if powerModel.isDown { continue }
                    await viewModel.refreshModels()
                }
            }
            .onChange(of: powerModel.isDown) { wasDown, isDown in
                guard wasDown, !isDown else { return }
                Task {
                    await viewModel.refreshHarnesses()
                    await viewModel.refreshModels()
                }
            }
            .onChange(of: latestSignInFailureJobID) { _, jobID in
                guard jobID != nil else { return }
                Task { await viewModel.refreshHarnesses() }
            }
            .onChange(of: threadsRequest.wrappedValue) { _, _ in
                onHonorThreadsRequest()
            }
            .onChange(of: viewModel.conversationSelectionID) { _, _ in
                activityRequest = nil
                showingSubagentsSheet = false
                showingTasksSheet = false
                localQueue.removeAll()
            }
            .onChange(of: isTurnRunning) { wasRunning, running in
                if wasRunning && !running {
                    onDrainNextLocalQueuedDraftIfReady()
                }
            }
            .onChange(of: automaticPreviewCandidateKey) { _, _ in
                onOpenRequestedPreviewIfNeeded()
            }
    }
}

private struct RelayChatPresentationsModifier: ViewModifier {
    @ObservedObject var viewModel: RelayChatViewModel
    let client: CodexClient
    let identityStore: ClientIdentityStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    let theme: RelayThemePalette
    let activeTodoItems: [RelayTodoItem]
    let activeTerminalContent: (() -> AnyView)?
    let threadsPreferLarge: Bool

    @Binding var providerLoginRequest: CodexProvider?
    @Binding var showingThreads: Bool
    @Binding var fullLogRequest: RelayFullLogRequest?
    @Binding var showingUsage: Bool
    @Binding var activityRequest: RelayActivityRequest?
    @Binding var showingSubagentsSheet: Bool
    @Binding var showingTasksSheet: Bool
    @Binding var showingTerminalSheet: Bool
    @Binding var aiDataConsentRequest: RelayAIDataConsentRequest?
    @Binding var artifactRequest: CodexJobArtifact?
    @Binding var attachmentRequest: RelayDisplayedAttachment?
    @Binding var remotePreviewRequest: RelayRemotePreviewRequest?

    let onContinueHandoff: (RelayHandoffCard) async -> Void
    let onSendPrompt: () -> Void

    func body(content: Content) -> some View {
        content
            .sheet(item: $providerLoginRequest, onDismiss: {
                Task {
                    await viewModel.refreshHarnesses()
                    await viewModel.refreshModels()
                }
            }) { provider in
                ProviderLoginView(client: client, provider: provider)
            }
            .sheet(isPresented: $showingThreads) {
                RelayThreadDrawer(
                    viewModel: viewModel,
                    onContinueHandoff: { card in
                        Task { await onContinueHandoff(card) }
                    }
                )
                .presentationDetents(threadsPreferLarge ? [.large] : [.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .sheet(item: $fullLogRequest) { request in
                RelayFullLogSheet(jobID: request.jobID, viewModel: viewModel)
            }
            .sheet(isPresented: $showingUsage) {
                RelayConversationUsageSheet(viewModel: viewModel)
            }
            .sheet(item: $activityRequest) { request in
                RelayActivitySheet(request: request, viewModel: viewModel)
            }
            .sheet(isPresented: $showingSubagentsSheet) {
                RelaySubagentsSheet(
                    subagents: viewModel.subagents,
                    client: client,
                    parentModel: viewModel,
                    powerModel: powerModel,
                    isLoading: viewModel.isLoadingThreadDetail,
                    errorMessage: viewModel.errorMessage
                )
            }
            .sheet(isPresented: $showingTasksSheet) {
                RelayTasksSheet(items: activeTodoItems)
            }
            .modifier(RelayChatSecondaryPresentationsModifier(
                client: client,
                identityStore: identityStore,
                theme: theme,
                activeTerminalContent: activeTerminalContent,
                showingTerminalSheet: $showingTerminalSheet,
                aiDataConsentRequest: $aiDataConsentRequest,
                artifactRequest: $artifactRequest,
                attachmentRequest: $attachmentRequest,
                remotePreviewRequest: $remotePreviewRequest,
                onSendPrompt: onSendPrompt
            ))
    }
}

private struct RelayChatSecondaryPresentationsModifier: ViewModifier {
    let client: CodexClient
    let identityStore: ClientIdentityStore
    let theme: RelayThemePalette
    let activeTerminalContent: (() -> AnyView)?

    @Binding var showingTerminalSheet: Bool
    @Binding var aiDataConsentRequest: RelayAIDataConsentRequest?
    @Binding var artifactRequest: CodexJobArtifact?
    @Binding var attachmentRequest: RelayDisplayedAttachment?
    @Binding var remotePreviewRequest: RelayRemotePreviewRequest?

    let onSendPrompt: () -> Void

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $showingTerminalSheet) {
                if let terminalContent = activeTerminalContent {
                    VStack(spacing: 0) {
                        HStack(spacing: 10) {
                            Image(systemName: "terminal")
                                .font(.system(size: 16))
                                .foregroundStyle(theme.foregroundMuted)
                            Text("Terminal")
                                .font(RelayTheme.uiFont(16, weight: .medium))
                                .foregroundStyle(theme.foreground)
                            Spacer()
                            RelayToolbarIconButton(
                                systemImage: "xmark",
                                accessibilityLabel: "Close terminal",
                                iconSize: 14,
                                weight: .medium,
                                isMuted: true
                            ) {
                                showingTerminalSheet = false
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(theme.surface0)
                        Rectangle().fill(theme.border).frame(height: 1)
                        terminalContent()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                    .background(theme.surface0)
                    .presentationDetents([.fraction(0.6), .large])
                    .presentationDragIndicator(.visible)
                    .presentationBackground(theme.surface0)
                    .preferredColorScheme(theme.colorScheme)
                }
            }
            .sheet(item: $aiDataConsentRequest) { request in
                RelayAIDataConsentSheet(
                    provider: request.provider,
                    purpose: request.purpose,
                    isConsentGranted: RelayAIDataConsentStore.hasConsent(for: request.provider),
                    onAllow: {
                        RelayAIDataConsentStore.grantConsent(for: request.provider)
                        aiDataConsentRequest = nil
                        if request.purpose == .sendPrompt {
                            onSendPrompt()
                        }
                    },
                    onCancel: {
                        aiDataConsentRequest = nil
                    }
                )
                .interactiveDismissDisabled()
            }
            .fullScreenCover(item: $artifactRequest) { artifact in
                RelayArtifactViewer(
                    artifact: artifact,
                    client: client,
                    identityStore: identityStore
                )
            }
            .fullScreenCover(item: $attachmentRequest) { attachment in
                RelayAttachmentViewer(
                    attachment: attachment,
                    client: client
                )
            }
            .fullScreenCover(item: $remotePreviewRequest) { request in
                RelayRemotePreviewViewer(
                    request: request,
                    client: client,
                    identityStore: identityStore
                )
            }
    }
}

// MARK: - Composer Commands

private struct RelayComposerCommand: Identifiable {
    enum Action {
        case model
        case permissions
        case skills
        case newConversation
        case clearConversation
        case compact
        case review
        case skill(CodexSkillDescriptor)
    }

    let id: String
    let command: String
    let title: String
    let detail: String
    let source: String
    let action: Action
}

// MARK: - Paseo Composer

private struct RelayComposer: View {
    private enum Layout {
        static let horizontalInset: CGFloat = 12
        static let controlHeight: CGFloat = 40
        static let actionSize: CGFloat = 36
        static let discSize: CGFloat = 36
        static let cardRadius: CGFloat = 22
        static let rowSpacing: CGFloat = 8
        static let bottomPadding: CGFloat = 8
        static let fadeHeight: CGFloat = 24
    }

    @Environment(\.relayTheme) private var theme
    @Binding var text: String
    @Binding var attachments: [RelayDraftAttachment]
    let sections: RelayModelPickerSections
    let selectedChoice: RelayModelChoice?
    let modelPickerRequest: Int
    let threadProvider: CodexProvider?
    let efforts: [CodexReasoningEffort]
    let selectedEffort: CodexReasoningEffort?
    let provider: CodexProvider?
    let harnessStatus: RelayHarnessStatus?
    let skills: [CodexSkillDescriptor]
    let selectedSkillIDs: Set<String>
    let claudePermissionMode: RelayClaudePermissionMode
    let codexApprovalPolicy: RelayCodexApprovalPolicy
    let codexSandbox: RelayCodexSandbox
    let isSending: Bool
    let isStreaming: Bool
    var isTurnRunning: Bool = false
    var sendWhileRunning: RelaySendWhileRunningBehavior = .steer
    var workspaceFiles: [String] = []
    var localQueue: [RelayLocalQueuedDraft] = []
    var serverPendingInputs: [RelayJobInputMessage] = []
    var canSteerServerInputs: Bool = false
    let onPickChoice: (RelayModelChoice) -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onToggleSkill: (CodexSkillDescriptor) -> Void
    let onPickClaudePermission: (RelayClaudePermissionMode) -> Void
    let onPickCodexApproval: (RelayCodexApprovalPolicy) -> Void
    let onPickCodexSandbox: (RelayCodexSandbox) -> Void
    let onNewConversation: () -> Void
    var onClearConversation: () -> Void = {}
    var onCompactConversation: () -> Void = {}
    let onSend: () -> Void
    let onStop: () -> Void
    var onConnectProvider: ((CodexProvider) -> Void)? = nil
    var onAddAttachments: ([RelayDraftAttachment]) -> Void = { _ in }
    var onRemoveAttachment: (UUID) -> Void = { _ in }
    var machineState: RelayComposerMachineState? = nil
    var isDeliveringPrompt = false
    var activeRunProvider: CodexProvider? = nil
    var onSendNow: () -> Void = {}
    var onEnqueueLocal: (String) -> Void = { _ in }
    var onEditLocalQueue: (RelayLocalQueuedDraft) -> Void = { _ in }
    var onSendLocalQueueNow: (RelayLocalQueuedDraft) -> Void = { _ in }
    var onRemoveLocalQueue: (RelayLocalQueuedDraft) -> Void = { _ in }
    var onSendServerQueueNow: (RelayJobInputMessage) -> Void = { _ in }
    var onRequestWorkspaceFiles: () -> Void = {}

    @State private var showingSendOptions = false
    @State private var isFocused = false
    @State private var editorSelection = NSRange(location: 0, length: 0)
    @State private var editorHeight: CGFloat = 28
    @State private var showingModelPicker = false
    @State private var addSheetStart: RelayAddSheetPage?
    @State private var pendingAttachmentSource: RelayAttachmentSource?
    @State private var showingPhotoPicker = false
    @State private var showingFileImporter = false
    @State private var showingCamera = false
    @State private var photoPickerItems: [PhotosPickerItem] = []
    @StateObject private var dictation = RelayStreamingTranscriber()
    @State private var dictationPrefix = ""
    @State private var dictationDiscarded = false
    @State private var sendWhenTranscribed = false
    @State private var dictationStartError: String?

    private var visibleSections: RelayModelPickerSections {
        sections.restricted(to: threadProvider)
    }

    private var slashContext: RelaySlashContext? {
        RelaySlashContext.find(in: text, selection: editorSelection)
    }

    private var mentionContext: RelayMentionContext? {
        guard slashContext == nil else { return nil }
        return RelayMentionContext.find(in: text, selection: editorSelection)
    }

    private var filteredMentionFiles: [String] {
        guard let query = mentionContext?.query else { return [] }
        if query.isEmpty {
            return Array(workspaceFiles.prefix(24))
        }
        let scored: [(path: String, rank: Int)] = workspaceFiles.compactMap { path in
            let lower = path.lowercased()
            let fileName = (path as NSString).lastPathComponent.lowercased()
            if fileName.hasPrefix(query) { return (path, 0) }
            if fileName.contains(query) { return (path, 1) }
            if lower.contains(query) { return (path, 2) }
            return nil
        }
        return scored
            .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.path.count < $1.path.count }
            .prefix(24)
            .map(\.path)
    }

    private var slashCommands: [RelayComposerCommand] {
        var commands = [
            RelayComposerCommand(
                id: "relay:new",
                command: "/new",
                title: "New chat",
                detail: "Start a clean session in this workspace",
                source: "Client",
                action: .newConversation
            ),
            RelayComposerCommand(
                id: "relay:clear",
                command: "/clear",
                title: "Clear chat",
                detail: "Reset the current conversation view",
                source: "Client",
                action: .clearConversation
            ),
            RelayComposerCommand(
                id: "relay:compact",
                command: "/compact",
                title: "Compact context",
                detail: "Summarize progress and remaining next steps",
                source: "Client",
                action: .compact
            ),
            RelayComposerCommand(
                id: "relay:model",
                command: "/model",
                title: "Model & permissions",
                detail: "Choose agent, model, effort, and permissions",
                source: "Client",
                action: .model
            ),
            RelayComposerCommand(
                id: "relay:review",
                command: "/review",
                title: "Review changes",
                detail: "Ask the selected agent for a focused code review",
                source: "Client",
                action: .review
            )
        ]

        if let provider {
            if provider.hasTaskPermissionControls {
                commands.append(RelayComposerCommand(
                    id: "relay:permissions:\(provider.rawValue)",
                    command: "/permissions",
                    title: provider.relayPresentation.permissionsTitle ?? "Permissions",
                    detail: provider == .claude
                        ? "Choose the Claude Code permission mode"
                        : "Choose the Codex runner's approval policy",
                    source: RelayModelChoice.harnessTitle(for: provider),
                    action: .permissions
                ))
            }
            commands.append(RelayComposerCommand(
                id: "relay:skills:\(provider.rawValue)",
                command: "/skills",
                title: "Installed skills",
                detail: "Choose from this machine's \(RelayModelChoice.harnessTitle(for: provider)) skills",
                source: RelayModelChoice.harnessTitle(for: provider),
                action: .skills
            ))
        }

        commands.append(contentsOf: skills.map { skill in
            RelayComposerCommand(
                id: "skill:\(skill.provider.rawValue):\(skill.id)",
                command: "/\(skill.name)",
                title: skill.title,
                detail: skill.description,
                source: skill.isCommand ? "Command" : "Skill",
                action: .skill(skill)
            )
        })

        guard let query = slashContext?.query, !query.isEmpty else { return commands }
        return commands.filter {
            $0.command.dropFirst().lowercased().contains(query)
                || $0.title.lowercased().contains(query)
                || $0.detail.lowercased().contains(query)
        }
    }

    private var providerReady: Bool {
        harnessStatus?.isConfirmedUnavailable != true
    }

    private var hasDraftContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }

    private var canSend: Bool {
        RelayComposerLogic.canSend(
            text: text,
            hasAttachments: !attachments.isEmpty,
            isSending: isSending,
            isListening: dictation.phase == .listening,
            providerReady: harnessStatus?.isConfirmedUnavailable != true
        )
    }

    private var effortLabel: String? {
        RelayComposerLogic.effortLabel(efforts: efforts, selected: selectedEffort)
    }

    private var selectedSkills: [CodexSkillDescriptor] {
        skills.filter { selectedSkillIDs.contains($0.id) }
    }

    private var dictationError: String? {
        if case .failed(let message) = dictation.phase { return message }
        return dictationStartError
    }

    private var effectiveRunning: Bool {
        isStreaming || isTurnRunning
    }

    private var hasQueuedItems: Bool {
        !localQueue.isEmpty || !serverPendingInputs.isEmpty
    }

    // MARK: - Queue Track Inside Composer

    private var queueTrackLane: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(localQueue) { draft in
                    HStack(alignment: .center, spacing: 8) {
                        Image(systemName: "clock")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .frame(width: 14)

                        Text(draft.text)
                            .font(RelayTheme.uiFont(13.5))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        HStack(spacing: 2) {
                            Button {
                                onEditLocalQueue(draft)
                            } label: {
                                Image(systemName: "pencil")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(theme.foregroundMuted)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Edit queued message")

                            Button {
                                onSendLocalQueueNow(draft)
                            } label: {
                                Image(systemName: "arrow.up.circle")
                                    .font(.system(size: 13.5, weight: .medium))
                                    .foregroundStyle(theme.accentBright)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Send queued message now")

                            Button {
                                onRemoveLocalQueue(draft)
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundStyle(theme.foregroundExtraMuted)
                                    .frame(width: 28, height: 28)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel("Remove queued message")
                        }
                    }
                }

                if !serverPendingInputs.isEmpty {
                    RelayQueuedInputs(
                        messages: serverPendingInputs,
                        provider: activeRunProvider,
                        canSteer: canSteerServerInputs,
                        isSending: isSending,
                        onSendNow: onSendServerQueueNow
                    )
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(theme.surface2.opacity(0.45))

            Rectangle()
                .fill(theme.border)
                .frame(height: 1)
        }
        .accessibilityIdentifier("relay-composer-queue-track")
    }

    // MARK: - Skill Chips

    private var skillChips: some View {
        RelayFlowLayout(spacing: 6, lineSpacing: 0) {
            ForEach(selectedSkills) { skill in
                Button {
                    onToggleSkill(skill)
                } label: {
                    HStack(spacing: 6) {
                        Text("/\(skill.name)")
                            .font(RelayTheme.monoFont(11.5, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .padding(.leading, 10)
                    .padding(.trailing, 9)
                    .frame(height: 28)
                    .background(theme.surface2, in: Capsule())
                    .overlay {
                        Capsule().strokeBorder(theme.border, lineWidth: 1)
                    }
                    .frame(height: 34)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remove skill \(skill.name)")
            }
        }
        .padding(.horizontal, 10)
        .accessibilityIdentifier("relay-draft-skills")
    }

    // MARK: - Paseo Rounded 22pt Composer Card

    private var card: some View {
        VStack(spacing: 0) {
            if hasQueuedItems {
                queueTrackLane
            }

            VStack(spacing: 6) {
                if let dictationError {
                    Text(dictationError)
                        .font(RelayTheme.uiFont(12.5))
                        .foregroundStyle(theme.statusWarning)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .accessibilityIdentifier("relay-dictation-error")
                }

                if !attachments.isEmpty {
                    RelayDraftAttachmentStrip(
                        attachments: attachments,
                        onRemove: onRemoveAttachment
                    )
                    .padding(.horizontal, 8)
                }

                if !selectedSkills.isEmpty {
                    skillChips
                }

                ZStack(alignment: .leading) {
                    if text.isEmpty {
                        Text("Message, @files, /commands")
                            .font(RelayTheme.contentFont(16))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .lineLimit(1)
                            .allowsHitTesting(false)
                    }
                    RelayCommandTextEditor(
                        text: $text,
                        selection: $editorSelection,
                        isFocused: $isFocused,
                        height: $editorHeight,
                        textColor: dictation.phase == .listening ? theme.accentBright : theme.foreground,
                        tintColor: theme.accent,
                        onPasteImages: isSending || effectiveRunning ? nil : onAddAttachments
                    )
                    .frame(height: editorHeight)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.top, 2)

                controlBar
                    .padding(.horizontal, 6)
            }
            .padding(.top, 10)
            .padding(.bottom, 8)
        }
        .background(theme.surface1)
        .clipShape(RoundedRectangle(cornerRadius: Layout.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: Layout.cardRadius, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(theme.isDark ? 0.24 : 0.06), radius: 10, x: 0, y: 4)
    }

    // MARK: - 40pt Bottom Toolbar Rail

    private var controlBar: some View {
        HStack(alignment: .center, spacing: 2) {
            if dictation.isActive {
                RelayDictationControls(
                    levels: dictation.levels,
                    elapsed: dictation.elapsed,
                    finalizing: dictation.phase == .finalizing,
                    onCancel: cancelDictation,
                    onStop: stopDictation
                )
            } else {
                addButton
                modelPill
                Spacer(minLength: 0)
                if AppConfiguration.supportsDictation {
                    micButton
                }
            }
            trailingActionDisc
        }
        .frame(height: Layout.controlHeight)
    }

    private var addButton: some View {
        Menu {
            Button {
                isFocused = false
                showingPhotoPicker = true
            } label: {
                Label("Photos", systemImage: "photo.on.rectangle")
            }
            .disabled(isSending || effectiveRunning)

            Button {
                isFocused = false
                showingFileImporter = true
            } label: {
                Label("Files", systemImage: "folder")
            }
            .disabled(isSending || effectiveRunning)

            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    isFocused = false
                    showingCamera = true
                } label: {
                    Label("Camera", systemImage: "camera")
                }
                .disabled(isSending || effectiveRunning)
            }

            Button {
                pasteImageFromClipboard()
            } label: {
                Label("Paste image", systemImage: "doc.on.clipboard")
            }
            .disabled(isSending || effectiveRunning || !UIPasteboard.general.hasImages)

            Divider()

            Button {
                isFocused = false
                addSheetStart = .root
            } label: {
                Label("Permissions & Skills…", systemImage: "slider.horizontal.3")
            }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
                .frame(width: Layout.actionSize, height: Layout.actionSize)
                .contentShape(Circle())
        }
        .accessibilityIdentifier("relay-add")
        .accessibilityLabel("Add photos, files, permissions and skills")
    }

    private var modelPill: some View {
        Button {
            isFocused = false
            showingModelPicker = true
        } label: {
            HStack(spacing: 6) {
                if let provider = selectedChoice?.executionProvider {
                    RelayComposerProviderMark(provider: provider, size: 15, color: theme.foregroundMuted)
                }
                Text(selectedChoice?.shortModelLabel ?? "Choose model")
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 9.5, weight: .medium))
                    .foregroundStyle(theme.foregroundExtraMuted)
            }
            .padding(.horizontal, 8)
            .frame(height: Layout.actionSize)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-model-chip")
        .accessibilityLabel(RelayComposerLogic.pillAccessibilityLabel(
            model: selectedChoice?.shortModelLabel,
            effort: effortLabel
        ))
    }

    private var micButton: some View {
        Button(action: startDictation) {
            Image(systemName: "mic")
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(theme.foreground)
                .frame(width: Layout.actionSize, height: Layout.actionSize)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(isSending)
        .accessibilityIdentifier("relay-dictate")
        .accessibilityLabel("Dictate prompt")
    }

    /// Trailing 36pt circular disc that morphs smoothly without shifting layout:
    /// - Running & empty draft → Stop disc (`■`)
    /// - Has text/attachments or listening → Send/Steer/Queue filled disc (`↑`) in `theme.accent`
    /// - Idle & empty draft → Waveform voice-ready disc (`waveform`)
    private var trailingActionDisc: some View {
        let listening = dictation.phase == .listening
        let showsStop = effectiveRunning && !hasDraftContent && !listening
        let showsSend = hasDraftContent || listening
        let showsWaveform = !showsStop && !showsSend && AppConfiguration.supportsDictation

        let sendLive = listening ? (providerReady && !isSending) : canSend
        let isEnabled = showsStop || (showsSend && sendLive && !sendWhenTranscribed) || (showsWaveform && !isSending)

        return Button {
            if showsStop {
                isFocused = false
                onStop()
            } else if listening {
                sendDictated()
            } else if showsSend {
                isFocused = false
                if activeRunProvider != nil && sendWhileRunning == .steer {
                    showingSendOptions = true
                } else {
                    onSend()
                }
            } else if showsWaveform {
                startDictation()
            }
        } label: {
            ZStack {
                if showsStop {
                    Circle()
                        .fill(theme.foreground)
                        .frame(width: Layout.discSize, height: Layout.discSize)
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(theme.surface0)
                        .frame(width: 11, height: 11)
                } else if showsSend {
                    Circle()
                        .fill(sendLive ? theme.accent : theme.surface3)
                        .frame(width: Layout.discSize, height: Layout.discSize)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(sendLive ? theme.accentForeground : theme.foregroundExtraMuted)
                } else if showsWaveform {
                    Image(systemName: "waveform")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .frame(width: Layout.discSize, height: Layout.discSize)
                } else {
                    Circle()
                        .fill(theme.surface2)
                        .frame(width: Layout.discSize, height: Layout.discSize)
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
            }
            .frame(width: Layout.actionSize, height: Layout.actionSize)
            .contentShape(Circle())
            .animation(.easeOut(duration: 0.14), value: showsStop)
            .animation(.easeOut(duration: 0.14), value: showsSend)
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .accessibilityIdentifier(showsStop ? "relay-stop" : "relay-send")
        .accessibilityLabel(
            showsStop ? "Stop"
                : !providerReady ? "Provider connection required"
                : listening ? "Send what was said"
                : showsWaveform ? "Voice prompt"
                : activeRunProvider != nil ? "Send follow-up" : "Send"
        )
        .confirmationDialog("Send follow-up", isPresented: $showingSendOptions, titleVisibility: .visible) {
            Button("Queue after this turn") {
                if activeRunProvider != nil {
                    onSend()
                } else {
                    let draft = text
                    text = ""
                    onEnqueueLocal(draft)
                }
            }
            Button(activeRunProvider == .codex ? "Steer now" : "Send now") { onSendNow() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(activeRunProvider == .claude
                 ? "Send now interrupts the current turn and continues with your message."
                 : "Steer now adds your message to the current turn.")
        }
    }

    // MARK: - Body

    var body: some View {
        VStack(spacing: Layout.rowSpacing) {
            if slashContext != nil {
                slashPalette
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            } else if mentionContext != nil {
                fileMentionPalette
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let machineState {
                HStack(alignment: .center, spacing: 8) {
                    Text(machineState.message)
                        .font(RelayTheme.uiFont(13.5))
                        .foregroundStyle(theme.statusWarning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if machineState.status == .off {
                        Button("Start", action: machineState.onStart)
                            .font(RelayTheme.uiFont(13.5, weight: .semibold))
                            .foregroundStyle(theme.accentBright)
                            .frame(minWidth: 44, minHeight: 40)
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("relay-machine-start")
                    } else {
                        ProgressView()
                            .controlSize(.small)
                            .tint(theme.accent)
                            .frame(minWidth: 44, minHeight: 40)
                    }
                }
                .padding(.horizontal, 6)
                .accessibilityIdentifier("relay-machine-readiness")
            } else if isDeliveringPrompt {
                HStack(alignment: .center, spacing: 8) {
                    Text("Sending…")
                        .font(RelayTheme.uiFont(13.5))
                        .foregroundStyle(theme.foregroundMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    RelayStatusRing(isActive: true, size: 13, lineWidth: 1.5, showsCenterDot: true)
                        .frame(minWidth: 36, minHeight: 32)
                }
                .padding(.horizontal, 6)
                .accessibilityIdentifier("relay-prompt-sending")
            } else if let harnessStatus, harnessStatus.isConfirmedUnavailable {
                HStack(alignment: .center, spacing: 8) {
                    Text(harnessStatus.actionMessage ?? "This provider is not ready on the linked computer.")
                        .font(RelayTheme.uiFont(13.5))
                        .foregroundStyle(theme.statusWarning)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let onConnectProvider, harnessStatus.supportsDirectLogin, harnessStatus.loggedIn == false {
                        Button("Sign in") { onConnectProvider(harnessStatus.provider) }
                            .font(RelayTheme.uiFont(13.5, weight: .semibold))
                            .foregroundStyle(theme.accentBright)
                            .frame(minWidth: 44, minHeight: 40)
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("relay-provider-connect")
                    }
                }
                .padding(.horizontal, 6)
                .accessibilityIdentifier("relay-provider-readiness")
            }

            card
        }
        .padding(.horizontal, Layout.horizontalInset)
        .padding(.top, 4)
        .padding(.bottom, Layout.bottomPadding)
        .background(theme.surface0)
        .background(alignment: .top) {
            LinearGradient(
                colors: [theme.surface0.opacity(0), theme.surface0],
                startPoint: .top,
                endPoint: .bottom
            )
            .frame(height: Layout.fadeHeight)
            .offset(y: -Layout.fadeHeight)
            .allowsHitTesting(false)
        }
        .animation(.easeOut(duration: 0.16), value: slashContext)
        .animation(.easeOut(duration: 0.16), value: mentionContext)
        .animation(.easeOut(duration: 0.18), value: dictation.isActive)
        .onChange(of: mentionContext) { _, ctx in
            if ctx != nil && workspaceFiles.isEmpty {
                onRequestWorkspaceFiles()
            }
        }
        .onChange(of: dictation.transcript) { _, transcript in
            applyDictation(transcript)
        }
        .onDisappear { dictation.cancel() }
        .sheet(isPresented: $showingModelPicker) {
            RelayPaseoModelOptionsSheet(
                visibleSections: visibleSections,
                selectedChoice: selectedChoice,
                threadProvider: threadProvider,
                efforts: efforts,
                selectedEffort: selectedEffort,
                provider: provider,
                claudePermissionMode: claudePermissionMode,
                codexApprovalPolicy: codexApprovalPolicy,
                codexSandbox: codexSandbox,
                onPickChoice: requestChoice,
                onPickEffort: onPickEffort,
                onPickClaudePermission: onPickClaudePermission,
                onPickCodexApproval: onPickCodexApproval,
                onPickCodexSandbox: onPickCodexSandbox,
                onClose: { showingModelPicker = false }
            )
        }
        .sheet(item: $addSheetStart, onDismiss: startPendingAttachmentSource) { start in
            RelayAddSheet(
                startPage: start,
                provider: provider,
                cameraAvailable: UIImagePickerController.isSourceTypeAvailable(.camera),
                attachDisabled: isSending || effectiveRunning,
                claudePermissionMode: claudePermissionMode,
                codexApprovalPolicy: codexApprovalPolicy,
                codexSandbox: codexSandbox,
                skills: skills,
                selectedSkillIDs: selectedSkillIDs,
                onPickSource: { source in
                    pendingAttachmentSource = source
                    addSheetStart = nil
                },
                onPickClaudePermission: onPickClaudePermission,
                onPickCodexApproval: onPickCodexApproval,
                onPickCodexSandbox: onPickCodexSandbox,
                onToggleSkill: onToggleSkill,
                onClose: { addSheetStart = nil }
            )
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $photoPickerItems,
            maxSelectionCount: max(1, RelayAttachmentLimits.maxCount - attachments.count),
            matching: .any(of: [.images, .screenshots])
        )
        .onChange(of: photoPickerItems) { _, items in
            guard !items.isEmpty else { return }
            Task { await importPhotoPickerItems(items) }
        }
        .fileImporter(
            isPresented: $showingFileImporter,
            allowedContentTypes: [.item],
            allowsMultipleSelection: true
        ) { result in
            importPickedFiles(result)
        }
        .fullScreenCover(isPresented: $showingCamera) {
            RelayCameraPicker { image in
                showingCamera = false
                if let image, let attachment = RelayDraftAttachment.make(
                    filename: "photo.jpg",
                    data: image.jpegData(compressionQuality: 0.82) ?? Data(),
                    contentType: "image/jpeg"
                ) {
                    onAddAttachments([attachment])
                }
            }
            .ignoresSafeArea()
        }
        .onChange(of: modelPickerRequest) { _, _ in
            showingModelPicker = true
        }
    }

    // MARK: - Inline @files Autocomplete Popover

    private var fileMentionPalette: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(mentionContext?.query.isEmpty == false ? "Matching files" : "Workspace files")
                    .font(RelayTheme.uiFont(12, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                Spacer()
                Text("@files")
                    .font(RelayTheme.monoFont(11))
                    .foregroundStyle(theme.foregroundExtraMuted)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)

            Rectangle().fill(theme.border).frame(height: 1)

            if filteredMentionFiles.isEmpty {
                Text(workspaceFiles.isEmpty ? "No workspace files indexed yet." : "No file matches \"\(mentionContext?.query ?? "")\".")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
                    .padding(12)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(filteredMentionFiles, id: \.self) { path in
                            let isDir = path.hasSuffix("/")
                            let cleanPath = isDir ? String(path.dropLast()) : path
                            let fileName = (cleanPath as NSString).lastPathComponent
                            let dirName = (cleanPath as NSString).deletingLastPathComponent
                            Button {
                                insertFileMention(path)
                            } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: isDir ? "folder" : Self.fileSymbol(for: fileName))
                                        .font(.system(size: 13, weight: .regular))
                                        .foregroundStyle(theme.foregroundMuted)
                                        .frame(width: 18)

                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(isDir ? "\(fileName)/" : fileName)
                                            .font(RelayTheme.monoFont(12.5, weight: .medium))
                                            .foregroundStyle(theme.foreground)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                        if !dirName.isEmpty && dirName != "." {
                                            Text(dirName)
                                                .font(RelayTheme.monoFont(11))
                                                .foregroundStyle(theme.foregroundExtraMuted)
                                                .lineLimit(1)
                                                .truncationMode(.head)
                                        }
                                    }

                                    Spacer(minLength: 0)
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 9)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if path != filteredMentionFiles.last {
                                Rectangle().fill(theme.border).frame(height: 1).padding(.leading, 40)
                            }
                        }
                    }
                }
                .frame(maxHeight: 220)
            }
        }
        .background(theme.surface1)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(theme.isDark ? 0.30 : 0.10), radius: 10, y: 4)
        .accessibilityIdentifier("relay-file-mention-palette")
    }

    private func insertFileMention(_ path: String) {
        guard let context = mentionContext else { return }
        let replacement = "@\(path) "
        let value = NSMutableString(string: text)
        value.replaceCharacters(in: context.range, with: replacement)
        text = value as String
        editorSelection = NSRange(
            location: context.range.location + (replacement as NSString).length,
            length: 0
        )
    }

    private static func fileSymbol(for filename: String) -> String {
        switch URL(fileURLWithPath: filename).pathExtension.lowercased() {
        case "swift", "ts", "tsx", "js", "jsx", "py", "rs", "go", "c", "h", "cpp", "m", "sh", "mjs":
            return "chevron.left.forwardslash.chevron.right"
        case "png", "jpg", "jpeg", "gif", "webp", "svg":
            return "photo"
        case "json", "yml", "yaml", "toml", "plist":
            return "curlybraces"
        case "md", "txt":
            return "doc.plaintext"
        default:
            return "doc.text"
        }
    }

    // MARK: - Inline /commands Autocomplete Popover

    private var slashPalette: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(slashContext?.query.isEmpty == false ? "Matching commands" : "Commands and skills")
                    .font(RelayTheme.uiFont(12, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                Spacer()
                if let provider {
                    Text(RelayModelChoice.harnessTitle(for: provider))
                        .font(RelayTheme.uiFont(11.5))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)

            Rectangle().fill(theme.border).frame(height: 1)

            if slashCommands.isEmpty {
                Text("No command or skill matches this text.")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
                    .padding(12)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(slashCommands) { command in
                            Button {
                                apply(command)
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Text(command.command)
                                        .font(RelayTheme.monoFont(12, weight: .medium))
                                        .foregroundStyle(theme.accentBright)
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                        .frame(width: 106, alignment: .leading)

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(command.title)
                                            .font(RelayTheme.uiFont(13.5, weight: .medium))
                                            .foregroundStyle(theme.foreground)
                                        Text(command.detail)
                                            .font(RelayTheme.uiFont(12))
                                            .foregroundStyle(theme.foregroundMuted)
                                            .lineLimit(2)
                                    }
                                    Spacer(minLength: 0)

                                    if isSelectedSkill(command) {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 12, weight: .semibold))
                                            .foregroundStyle(theme.accentBright)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if command.id != slashCommands.last?.id {
                                Rectangle().fill(theme.border).frame(height: 1).padding(.leading, 128)
                            }
                        }
                    }
                }
                .frame(maxHeight: 240)
            }
        }
        .background(theme.surface1)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .shadow(color: Color.black.opacity(theme.isDark ? 0.30 : 0.10), radius: 10, y: 4)
        .accessibilityIdentifier("relay-slash-palette")
    }

    private func isSelectedSkill(_ command: RelayComposerCommand) -> Bool {
        guard case .skill(let skill) = command.action else { return false }
        return selectedSkillIDs.contains(skill.id)
    }

    private func apply(_ command: RelayComposerCommand) {
        switch command.action {
        case .model:
            replaceSlashToken(with: "")
            showingModelPicker = true
        case .permissions:
            replaceSlashToken(with: "")
            addSheetStart = RelayComposerLogic.permissionsStartPage(for: provider)
        case .skills:
            replaceSlashToken(with: "")
            addSheetStart = .skills
        case .newConversation:
            replaceSlashToken(with: "")
            onNewConversation()
        case .clearConversation:
            replaceSlashToken(with: "")
            onClearConversation()
        case .compact:
            replaceSlashToken(with: "")
            onCompactConversation()
        case .review:
            replaceSlashToken(with: "Review the current changes for correctness, regressions, and missing tests.")
        case .skill(let skill):
            replaceSlashToken(with: "")
            onToggleSkill(skill)
        }
    }

    private func replaceSlashToken(with replacement: String) {
        guard let context = slashContext else { return }
        let value = NSMutableString(string: text)
        value.replaceCharacters(in: context.range, with: replacement)
        text = value as String
        editorSelection = NSRange(
            location: context.range.location + (replacement as NSString).length,
            length: 0
        )
    }

    private func requestChoice(_ choice: RelayModelChoice) {
        guard threadProvider == nil || choice.executionProvider == threadProvider else { return }
        onPickChoice(choice)
    }

    private func startPendingAttachmentSource() {
        guard let source = pendingAttachmentSource else { return }
        pendingAttachmentSource = nil
        switch source {
        case .camera: showingCamera = true
        case .photos: showingPhotoPicker = true
        case .files: showingFileImporter = true
        }
    }

    private func pasteImageFromClipboard() {
        let pasteboard = UIPasteboard.general
        guard pasteboard.hasImages else { return }
        let items = IndexSet(integersIn: 0..<pasteboard.numberOfItems)
        let plan = RelayComposerLogic.pastePlan(itemTypes: pasteboard.types(forItemSet: items) ?? [])
        var attached: [RelayDraftAttachment] = []
        for image in plan.images {
            for identifier in image.typeIdentifiers {
                guard let data = pasteboard.data(forPasteboardType: identifier, inItemSet: IndexSet(integer: image.item))?.first,
                      UIImage(data: data) != nil else { continue }
                let type = UTType(identifier)
                if let draft = RelayDraftAttachment.make(
                    filename: "pasted-image.\(type?.preferredFilenameExtension ?? "png")",
                    data: data,
                    contentType: type?.preferredMIMEType
                ) {
                    attached.append(draft)
                    break
                }
            }
        }
        if !attached.isEmpty {
            onAddAttachments(attached)
        }
    }

    /// Starting to dictate leaves keyboard focus exactly where it was.
    private func startDictation() {
        dictationPrefix = text
        dictationDiscarded = false
        sendWhenTranscribed = false
        dictationStartError = nil
        Task {
            do {
                try await dictation.start()
            } catch {
                dictationStartError = (error as? LocalizedError)?.errorDescription
                    ?? "Dictation could not start."
            }
        }
    }

    private func stopDictation() {
        Task { await dictation.stop() }
    }

    private func cancelDictation() {
        dictationDiscarded = true
        sendWhenTranscribed = false
        dictation.cancel()
        text = dictationPrefix
    }

    private func sendDictated() {
        sendWhenTranscribed = true
        Task {
            let settled = await dictation.stop()
            applyDictation(settled)
            let shouldSend = RelayComposerLogic.shouldSendAfterDictation(
                text: text,
                hasAttachments: !attachments.isEmpty,
                isSending: isSending,
                providerReady: providerReady,
                stillWanted: sendWhenTranscribed
            )
            sendWhenTranscribed = false
            guard shouldSend else { return }
            isFocused = false
            onSend()
        }
    }

    private func applyDictation(_ transcript: String) {
        guard !dictationDiscarded,
              let next = RelayComposerLogic.dictatedText(prefix: dictationPrefix, transcript: transcript)
        else { return }
        text = next
    }

    @MainActor
    private func importPhotoPickerItems(_ items: [PhotosPickerItem]) async {
        var imported: [RelayDraftAttachment] = []
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let filename = item.itemIdentifier?.split(separator: "/").last.map(String.init) ?? "photo.jpg"
            if let attachment = RelayDraftAttachment.make(filename: filename, data: data, contentType: nil) {
                imported.append(attachment)
            }
        }
        photoPickerItems = []
        onAddAttachments(imported)
    }

    private func importPickedFiles(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        var imported: [RelayDraftAttachment] = []
        for url in urls {
            let accessed = url.startAccessingSecurityScopedResource()
            defer { if accessed { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            if let attachment = RelayDraftAttachment.make(
                filename: url.lastPathComponent,
                data: data,
                contentType: (try? url.resourceValues(forKeys: [.contentTypeKey]))?.contentType?.preferredMIMEType
            ) {
                imported.append(attachment)
            }
        }
        onAddAttachments(imported)
    }
}

// MARK: - Combined Paseo Model / Effort / Permissions Sheet

private struct RelayPaseoModelOptionsSheet: View {
    let visibleSections: RelayModelPickerSections
    let selectedChoice: RelayModelChoice?
    let threadProvider: CodexProvider?
    let efforts: [CodexReasoningEffort]
    let selectedEffort: CodexReasoningEffort?
    let provider: CodexProvider?
    let claudePermissionMode: RelayClaudePermissionMode
    let codexApprovalPolicy: RelayCodexApprovalPolicy
    let codexSandbox: RelayCodexSandbox
    let onPickChoice: (RelayModelChoice) -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onPickClaudePermission: (RelayClaudePermissionMode) -> Void
    let onPickCodexApproval: (RelayCodexApprovalPolicy) -> Void
    let onPickCodexSandbox: (RelayCodexSandbox) -> Void
    let onClose: () -> Void

    @Environment(\.relayTheme) private var theme
    @State private var pickedTab: RelayModelSheetTab?

    private var tabs: [RelayModelSheetTab] { RelayModelSheetTab.tabs(for: visibleSections) }

    private var activeTab: RelayModelSheetTab? {
        if let pickedTab, tabs.contains(pickedTab) { return pickedTab }
        return RelayModelSheetTab.initial(for: visibleSections, selectedChoice: selectedChoice)
    }

    private var showsEffort: Bool {
        !efforts.isEmpty && RelayModelSheetTab.showsEffort(
            visibleTab: activeTab,
            sections: visibleSections,
            selectedChoice: selectedChoice,
            threadProvider: threadProvider
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                if let p = selectedChoice?.executionProvider {
                    RelayComposerProviderMark(provider: p, size: 17, color: theme.foregroundMuted)
                }
                Text("Model & Controls")
                    .font(RelayTheme.uiFont(16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                RelayToolbarIconButton(
                    systemImage: "xmark",
                    accessibilityLabel: "Close",
                    iconSize: 14,
                    weight: .medium,
                    isMuted: true,
                    action: onClose
                )
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Rectangle().fill(theme.border).frame(height: 1)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if threadProvider == nil, tabs.count > 1 {
                        HStack(spacing: 8) {
                            ForEach(tabs) { candidate in
                                let isSelected = candidate == activeTab
                                Button {
                                    pickedTab = candidate
                                } label: {
                                    HStack(spacing: 6) {
                                        if case .agent(let p) = candidate {
                                            RelayComposerProviderMark(
                                                provider: p,
                                                size: 13,
                                                color: isSelected ? theme.foreground : theme.foregroundMuted
                                            )
                                        }
                                        Text(candidate.title)
                                            .font(RelayTheme.uiFont(13.5, weight: isSelected ? .medium : .regular))
                                            .lineLimit(1)
                                    }
                                    .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                                    .padding(.horizontal, 12)
                                    .frame(height: 34)
                                    .background(isSelected ? theme.surface2 : Color.clear, in: Capsule())
                                    .overlay {
                                        Capsule().strokeBorder(isSelected ? theme.borderAccent : theme.border, lineWidth: 1)
                                    }
                                }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("relay-model-agent-\(candidate.id)")
                            }
                        }
                    }

                    if let tab = activeTab {
                        let choices = tab.choices(in: visibleSections)
                        RelaySettingsCard {
                            ForEach(Array(choices.enumerated()), id: \.element.id) { index, choice in
                                let isSelected = choice == selectedChoice
                                RelaySettingsRow(
                                    tab.rowTitle(for: choice),
                                    showsTopDivider: index > 0,
                                    action: {
                                        withAnimation(.easeOut(duration: 0.16)) { onPickChoice(choice) }
                                    }
                                ) {
                                    if isSelected {
                                        Image(systemName: "checkmark")
                                            .font(.system(size: 14, weight: .semibold))
                                            .foregroundStyle(theme.accentBright)
                                    }
                                }
                            }
                        }
                    }

                    if showsEffort {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Reasoning Effort")
                                .font(RelayTheme.uiFont(13, weight: .medium))
                                .foregroundStyle(theme.foregroundMuted)
                                .padding(.horizontal, 4)

                            HStack(spacing: 6) {
                                ForEach(efforts) { effort in
                                    let isSelected = effort == (selectedEffort ?? efforts.first)
                                    Button {
                                        onPickEffort(effort)
                                    } label: {
                                        Text(effort.label)
                                            .font(RelayTheme.uiFont(13, weight: isSelected ? .medium : .regular))
                                            .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                                            .frame(maxWidth: .infinity)
                                            .frame(height: 36)
                                            .background(isSelected ? theme.surface2 : theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                                            .overlay {
                                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                                    .strokeBorder(isSelected ? theme.borderAccent : theme.border, lineWidth: 1)
                                            }
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                            .accessibilityIdentifier("relay-effort-chip")
                        }
                    }

                    if let provider, provider.hasTaskPermissionControls {
                        if provider == .claude {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Permissions")
                                    .font(RelayTheme.uiFont(13, weight: .medium))
                                    .foregroundStyle(theme.foregroundMuted)
                                    .padding(.horizontal, 4)
                                RelaySettingsCard {
                                    ForEach(Array(RelayClaudePermissionMode.allCases.enumerated()), id: \.element.id) { index, mode in
                                        RelaySettingsRow(
                                            mode.label,
                                            subtitle: mode.detail,
                                            showsTopDivider: index > 0,
                                            action: { onPickClaudePermission(mode) }
                                        ) {
                                            if mode == claudePermissionMode {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 14, weight: .semibold))
                                                    .foregroundStyle(theme.accentBright)
                                            }
                                        }
                                    }
                                }
                                .accessibilityIdentifier("relay-permission-chip")
                            }
                        } else {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Approvals")
                                    .font(RelayTheme.uiFont(13, weight: .medium))
                                    .foregroundStyle(theme.foregroundMuted)
                                    .padding(.horizontal, 4)
                                RelaySettingsCard {
                                    ForEach(Array(RelayCodexApprovalPolicy.allCases.enumerated()), id: \.element.id) { index, policy in
                                        RelaySettingsRow(
                                            policy.label,
                                            subtitle: policy.detail,
                                            showsTopDivider: index > 0,
                                            action: { onPickCodexApproval(policy) }
                                        ) {
                                            if policy == codexApprovalPolicy {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 14, weight: .semibold))
                                                    .foregroundStyle(theme.accentBright)
                                            }
                                        }
                                    }
                                }
                                .accessibilityIdentifier("relay-approval-chip")
                            }

                            VStack(alignment: .leading, spacing: 8) {
                                Text("File Access")
                                    .font(RelayTheme.uiFont(13, weight: .medium))
                                    .foregroundStyle(theme.foregroundMuted)
                                    .padding(.horizontal, 4)
                                let effectiveSandbox = codexApprovalPolicy.effectiveSandbox(codexSandbox)
                                RelaySettingsCard {
                                    ForEach(Array(RelayCodexSandbox.allCases.enumerated()), id: \.element.id) { index, level in
                                        RelaySettingsRow(
                                            level.label,
                                            subtitle: level.detail,
                                            showsTopDivider: index > 0,
                                            action: { onPickCodexSandbox(level) }
                                        ) {
                                            if level == effectiveSandbox {
                                                Image(systemName: "checkmark")
                                                    .font(.system(size: 14, weight: .semibold))
                                                    .foregroundStyle(theme.accentBright)
                                            }
                                        }
                                    }
                                }
                                .accessibilityIdentifier("relay-permission-chip")
                            }
                        }
                    }
                }
                .padding(16)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(theme.surface0)
        .presentationDetents([.fraction(0.6), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(28)
        .presentationBackground(theme.surface0)
        .preferredColorScheme(theme.colorScheme)
    }
}

#if DEBUG
/// The composer over fixture values, for previews and snapshot tests.
struct RelayComposerPreviewHost: View {
    @State var text: String
    var sections: RelayModelPickerSections
    var selectedChoice: RelayModelChoice?
    var threadProvider: CodexProvider? = nil
    var efforts: [CodexReasoningEffort] = []
    var selectedEffort: CodexReasoningEffort? = nil
    var skills: [CodexSkillDescriptor] = []
    var selectedSkillIDs: Set<String> = []
    var isStreaming = false
    var activeRunProvider: CodexProvider? = nil
    @State private var attachments: [RelayDraftAttachment] = []

    var body: some View {
        RelayComposer(
            text: $text,
            attachments: $attachments,
            sections: sections,
            selectedChoice: selectedChoice,
            modelPickerRequest: 0,
            threadProvider: threadProvider,
            efforts: efforts,
            selectedEffort: selectedEffort,
            provider: selectedChoice?.executionProvider,
            harnessStatus: nil,
            skills: skills,
            selectedSkillIDs: selectedSkillIDs,
            claudePermissionMode: .acceptEdits,
            codexApprovalPolicy: .onRequest,
            codexSandbox: .workspace,
            isSending: false,
            isStreaming: isStreaming,
            isTurnRunning: isStreaming,
            sendWhileRunning: .steer,
            onPickChoice: { _ in },
            onPickEffort: { _ in },
            onToggleSkill: { _ in },
            onPickClaudePermission: { _ in },
            onPickCodexApproval: { _ in },
            onPickCodexSandbox: { _ in },
            onNewConversation: {},
            onSend: {},
            onStop: {},
            activeRunProvider: activeRunProvider
        )
    }
}
#endif

// MARK: - Command Text Editor

struct RelayCommandTextEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var isFocused: Bool
    @Binding var height: CGFloat
    var textColor: Color = AppTheme.textPrimary
    var tintColor: Color? = nil
    var onPasteImages: (([RelayDraftAttachment]) -> Void)? = nil

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> RelayComposerTextView {
        let view = RelayComposerTextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textColor = UIColor(textColor)
        view.tintColor = UIColor(tintColor ?? AppTheme.accent)
        view.font = UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: 16))
        view.textContainerInset = UIEdgeInsets(top: 3, left: 0, bottom: 3, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = "Message"
        view.accessibilityHint = "Type a message, mention files with @, paste an image, or type slash for commands."
        view.accessibilityIdentifier = "relay-message-editor"
        view.keyboardDismissMode = .interactive
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: RelayComposerTextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.isApplyingUpdate = true
        defer { context.coordinator.isApplyingUpdate = false }
        view.onPasteImages = onPasteImages
        if view.text != text {
            view.text = text
        }
        let resolved = UIColor(textColor)
        if view.textColor != resolved {
            view.textColor = resolved
        }
        if let tintColor {
            let resolvedTint = UIColor(tintColor)
            if view.tintColor != resolvedTint {
                view.tintColor = resolvedTint
            }
        }
        let textLength = (view.text as NSString).length
        let safeLocation = max(0, min(selection.location, textLength))
        let safeSelection = NSRange(location: safeLocation, length: max(0, min(selection.length, textLength - safeLocation)))
        if view.markedTextRange == nil, view.selectedRange != safeSelection {
            view.selectedRange = safeSelection
        }
        if isFocused, !view.isFirstResponder {
            view.becomeFirstResponder()
        } else if !isFocused, view.isFirstResponder {
            view.resignFirstResponder()
        }
        context.coordinator.updateHeight(for: view)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: RelayCommandTextEditor
        var isApplyingUpdate = false

        init(parent: RelayCommandTextEditor) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            guard !isApplyingUpdate else { return }
            parent.isFocused = true
            parent.selection = textView.selectedRange
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            guard !isApplyingUpdate else { return }
            parent.isFocused = false
            parent.selection = textView.selectedRange
        }

        func textViewDidChange(_ textView: UITextView) {
            guard !isApplyingUpdate else { return }
            parent.text = textView.text
            parent.selection = textView.selectedRange
            updateHeight(for: textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            guard !isApplyingUpdate else { return }
            parent.selection = textView.selectedRange
        }

        func updateHeight(for textView: UITextView) {
            let width = max(textView.bounds.width, 120)
            let fitting = textView.sizeThatFits(
                CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            ).height
            let next = min(max(fitting, 28), 120)
            textView.isScrollEnabled = fitting > 120
            guard abs(parent.height - next) > 0.5 else { return }
            DispatchQueue.main.async { [weak self] in
                self?.parent.height = next
            }
        }
    }
}

final class RelayComposerTextView: UITextView {
    var onPasteImages: (([RelayDraftAttachment]) -> Void)?
    var pasteboard: UIPasteboard = .general

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), onPasteImages != nil, pasteboard.hasImages {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        guard let onPasteImages, pasteboard.hasImages else {
            super.paste(sender)
            return
        }
        let items = IndexSet(integersIn: 0..<pasteboard.numberOfItems)
        let plan = RelayComposerLogic.pastePlan(itemTypes: pasteboard.types(forItemSet: items) ?? [])
        if plan.pastesText {
            super.paste(sender)
        }
        let attachments = plan.images.compactMap(pastedAttachment)
        if !attachments.isEmpty {
            onPasteImages(attachments)
        }
    }

    private func pastedAttachment(_ image: RelayPastedImage) -> RelayDraftAttachment? {
        for identifier in image.typeIdentifiers {
            guard let data = pasteboard.data(forPasteboardType: identifier, inItemSet: IndexSet(integer: image.item))?.first,
                  UIImage(data: data) != nil
            else { continue }
            let type = UTType(identifier)
            return RelayDraftAttachment.make(
                filename: "pasted-image.\(type?.preferredFilenameExtension ?? "png")",
                data: data,
                contentType: type?.preferredMIMEType
            )
        }
        return nil
    }
}

// MARK: - Chat Bubble

struct RelayChatBubble: View, Equatable {
    let item: RelayConversationItem
    let client: CodexClient
    var showsByline = true
    var showsActions = true
    var onOpenAttachment: (RelayDisplayedAttachment) -> Void
    var onOpenActivity: (String) -> Void = { _ in }
    var onOpenStep: (String) -> Void = { _ in }
    var onFork: (() -> Void)? = nil

    @Environment(\.relayTheme) private var theme
    @State private var showCopied = false
    @State private var selectingText = false

    static func == (lhs: RelayChatBubble, rhs: RelayChatBubble) -> Bool {
        lhs.item == rhs.item && lhs.showsByline == rhs.showsByline && lhs.showsActions == rhs.showsActions
    }

    private var isWaitingForFirstToken: Bool { item.isStreaming && item.text.isEmpty && item.attachments.isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 44) }

            Group {
                if isUser {
                    messageColumn
                        .padding(.horizontal, item.attachments.isEmpty || !item.text.isEmpty ? 14 : 8)
                        .padding(.vertical, item.attachments.isEmpty || !item.text.isEmpty ? 10 : 8)
                        .background(theme.surface2)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                } else {
                    messageColumn
                        .padding(.vertical, 2)
                }
            }
            .contextMenu {
                Button {
                    UIPasteboard.general.string = item.text
                    flashCopied()
                } label: { Label("Copy", systemImage: "doc.on.doc") }
                if !item.text.isEmpty {
                    Button("Select text", systemImage: "text.cursor") { selectingText = true }
                }
                if !isUser, let onFork {
                    Button("Fork in new chat", systemImage: "arrow.triangle.branch") { onFork() }
                }
            }

            if !isUser { Spacer(minLength: 0) }
        }
        .sheet(isPresented: $selectingText) { RelayTextSelectionSheet(text: item.text) }
    }

    private var messageColumn: some View {
        VStack(alignment: isUser ? .trailing : .leading, spacing: 7) {
            if (!isUser && showsByline) || showCopied {
                HStack(spacing: 6) {
                    if !isUser && showsByline {
                        RelayTurnByline(provider: item.provider)
                    }
                    if showCopied {
                        Text("Copied")
                            .font(RelayTheme.uiFont(11, weight: .medium))
                            .foregroundStyle(theme.statusSuccess)
                            .transition(.opacity)
                    }
                }
            }

            if let timeline = item.historyTimeline {
                RelayTimelineBlocks(
                    timeline: timeline, isActive: !timeline.runningSteps.isEmpty,
                    onOpenBlock: onOpenActivity, onOpenStep: onOpenStep
                )
            }

            if !item.attachments.isEmpty {
                RelayMessageAttachmentStrip(
                    attachments: item.attachments,
                    client: client,
                    alignment: isUser ? .trailing : .leading,
                    onOpen: onOpenAttachment
                )
            }

            if isWaitingForFirstToken {
                RelayLiveRowLabel(word: "Thinking", since: item.timestamp)
            } else if isUser, !item.text.isEmpty {
                Text(verbatim: item.text)
                    .font(RelayTheme.contentFont(16))
                    .foregroundStyle(theme.foreground)
                    .lineSpacing(3.5)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else if !item.text.isEmpty {
                RelayTurnProse(
                    text: item.text,
                    isStreaming: item.isStreaming
                )
                .equatable()
            }

            if !isUser, showsActions, !item.isStreaming, !item.text.isEmpty {
                RelayMessageActions(text: item.text, onFork: onFork)
            }

            if let footer = footerText {
                Text(footer)
                    .font(RelayTheme.monoFont(10.5))
                    .foregroundStyle(theme.foregroundExtraMuted)
            }
        }
    }

    private func flashCopied() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation(.easeOut(duration: 0.2)) { showCopied = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            withAnimation(.easeOut(duration: 0.3)) { showCopied = false }
        }
    }

    private var footerText: String? {
        guard !item.isStreaming else { return nil }
        var parts: [String] = []
        if let usage = item.usage, !usage.isEmpty {
            let tin = usage.inputTokens.map { "\($0) in" }
            let tout = usage.outputTokens.map { "\($0) out" }
            let toks = [tin, tout].compactMap { $0 }.joined(separator: " · ")
            if !toks.isEmpty { parts.append(toks) }
        }
        if let secs = item.elapsedSeconds, secs >= 0.05, !isUser {
            parts.append(String(format: "%.1fs", secs))
        }
        return parts.isEmpty ? nil : parts.joined(separator: "  ·  ")
    }

    private var isUser: Bool { item.role == .user }
}

// MARK: - Attachment Strips & Viewers

private struct RelayDraftAttachmentStrip: View {
    let attachments: [RelayDraftAttachment]
    let onRemove: (UUID) -> Void

    var body: some View {
        RelayFlowLayout(spacing: 8, lineSpacing: 8) {
            ForEach(attachments) { attachment in
                RelayDraftAttachmentChip(attachment: attachment) {
                    onRemove(attachment.id)
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("relay-draft-attachments")
    }
}

private struct RelayDraftAttachmentChip: View {
    let attachment: RelayDraftAttachment
    let onRemove: () -> Void
    @Environment(\.relayTheme) private var theme

    var body: some View {
        ZStack(alignment: .topTrailing) {
            if attachment.isImage, let image = UIImage(data: attachment.data) {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
                    .frame(width: 60, height: 60)
                    .clipped()
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    Image(systemName: "doc")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(theme.foregroundMuted)
                    Text(attachment.filename)
                        .font(RelayTheme.uiFont(10.5, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(2)
                }
                .frame(width: 86, height: 60, alignment: .leading)
                .padding(.horizontal, 8)
                .background(theme.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(theme.border, lineWidth: 1)
                }
            }

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 16))
                    .foregroundStyle(theme.foreground, theme.surface0)
            }
            .buttonStyle(.plain)
            .offset(x: 4, y: -4)
            .accessibilityLabel("Remove \(attachment.filename)")
        }
    }
}

private struct RelayMessageAttachmentStrip: View {
    let attachments: [RelayDisplayedAttachment]
    let client: CodexClient
    var alignment: HorizontalAlignment = .leading
    let onOpen: (RelayDisplayedAttachment) -> Void
    @Environment(\.relayTheme) private var theme

    var body: some View {
        VStack(alignment: alignment, spacing: 8) {
            let images = attachments.filter { $0.kind == .image }
            let files = attachments.filter { $0.kind != .image }
            if !images.isEmpty {
                HStack(spacing: 6) {
                    ForEach(images) { attachment in
                        RelayAttachmentThumb(attachment: attachment, client: client)
                            .onTapGesture { onOpen(attachment) }
                    }
                }
            }
            ForEach(files) { attachment in
                Button {
                    onOpen(attachment)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "doc")
                            .font(.system(size: 13, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.filename)
                                .font(RelayTheme.uiFont(12.5, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .lineLimit(1)
                            if let bytes = attachment.byteCount {
                                Text(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))
                                    .font(RelayTheme.monoFont(10.5))
                                    .foregroundStyle(theme.foregroundMuted)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .accessibilityIdentifier("relay-message-attachments")
    }
}

private struct RelayAttachmentThumb: View {
    let attachment: RelayDisplayedAttachment
    let client: CodexClient
    @Environment(\.relayTheme) private var theme
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(theme.surface1)
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else if failed {
                Image(systemName: "photo")
                    .foregroundStyle(theme.foregroundMuted)
            } else {
                ProgressView().tint(theme.accent).scaleEffect(0.7)
            }
        }
        .frame(width: 128, height: 128)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .task(id: attachment.id) { await load() }
    }

    @MainActor
    private func load() async {
        if case .local(let data) = attachment.payload {
            image = UIImage(data: data)
            failed = image == nil
            return
        }
        guard let url = attachment.remoteURL else {
            failed = true
            return
        }
        do {
            let result = try await client.fetchArtifact(url)
            image = UIImage(data: result.data)
            failed = image == nil
        } catch {
            failed = true
        }
    }
}

struct RelayAttachmentViewer: View {
    let attachment: RelayDisplayedAttachment
    let client: CodexClient
    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme
    @State private var image: UIImage?
    @State private var errorMessage: String?
    @State private var isLoading = false

    var body: some View {
        NavigationStack {
            ZStack {
                theme.surface0.ignoresSafeArea()
                content
            }
            .navigationTitle(attachment.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(theme.accentBright)
                }
            }
            .task(id: attachment.id) { await load() }
        }
        .preferredColorScheme(theme.colorScheme)
    }

    @ViewBuilder
    private var content: some View {
        if isLoading, image == nil, errorMessage == nil {
            ProgressView().tint(theme.accent)
        } else if let image {
            GeometryReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
                }
            }
        } else {
            VStack(spacing: 10) {
                Image(systemName: attachment.kind == .image ? "photo" : "doc")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                Text(attachment.filename)
                    .font(RelayTheme.uiFont(16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                if let errorMessage {
                    Text(errorMessage)
                        .font(RelayTheme.uiFont(13.5))
                        .foregroundStyle(theme.foregroundMuted)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(32)
        }
    }

    @MainActor
    private func load() async {
        if case .local(let data) = attachment.payload {
            image = UIImage(data: data)
            if image == nil { errorMessage = "Relay could not preview this file." }
            return
        }
        guard let url = attachment.remoteURL else {
            errorMessage = "This attachment is no longer available on the linked computer."
            return
        }
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await client.fetchArtifact(url)
            image = UIImage(data: result.data)
            if image == nil {
                errorMessage = "Relay received the file but could not preview it here."
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct RelayCameraPicker: UIViewControllerRepresentable {
    var onCapture: (UIImage?) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCapture: onCapture)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        picker.allowsEditing = false
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UINavigationControllerDelegate, UIImagePickerControllerDelegate {
        let onCapture: (UIImage?) -> Void

        init(onCapture: @escaping (UIImage?) -> Void) {
            self.onCapture = onCapture
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            onCapture(nil)
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            onCapture(info[.originalImage] as? UIImage)
        }
    }
}

// MARK: - Job Turn & Legacy Job Card

private struct RelayJobTurn: View, Equatable {
    let job: CodexJob
    let timeline: RelayTimeline
    let client: CodexClient
    let hidesAnswer: Bool
    let showsByline: Bool
    let isCancelling: Bool
    var approvals: [CodexApproval] = []
    var onDecide: (CodexApproval, CodexApprovalDecision, _ answers: [String: String]?) -> Void = { _, _, _ in }
    let onCancel: () -> Void
    let onFullLog: () -> Void
    let onArtifact: (CodexJobArtifact) -> Void
    let onLoopbackURL: (URL) -> Void
    let onOpenBlock: (String) -> Void
    let onOpenStep: (String) -> Void
    var onFork: (() -> Void)? = nil
    var onSignIn: () -> Void = {}

    @Environment(\.relayTheme) private var theme

    static func == (lhs: RelayJobTurn, rhs: RelayJobTurn) -> Bool {
        lhs.job == rhs.job
            && lhs.timeline == rhs.timeline
            && lhs.approvals == rhs.approvals
            && lhs.hidesAnswer == rhs.hidesAnswer
            && lhs.showsByline == rhs.showsByline
            && lhs.isCancelling == rhs.isCancelling
    }

    private var isWaiting: Bool { job.status == .waitingForApproval || !approvals.isEmpty }

    private var idleWord: String {
        switch job.status {
        case .queued: return "Queued"
        case .waitingForApproval: return "Waiting"
        case .canceling: return "Stopping"
        default: return "Working"
        }
    }

    private var fallbackAnswer: String? {
        guard !job.status.isActive, timeline.proseText.isEmpty else { return nil }
        return job.displayOutput?.trimmedNonEmpty
    }

    private var previewSourceURL: URL? {
        guard !job.status.isActive else { return nil }
        return RelayOutputURLPolicy.loopbackURLs(in: job.displayOutput ?? timeline.proseText).first
    }

    private var copyableAnswer: String? {
        guard !hidesAnswer, !job.status.isActive else { return nil }
        return (fallbackAnswer ?? timeline.proseText).trimmedNonEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !hidesAnswer {
                if showsByline {
                    RelayTurnByline(provider: job.provider)
                }
                RelayTimelineBlocks(
                    timeline: timeline,
                    isActive: job.status.isActive,
                    idleWord: idleWord,
                    idleSince: job.startedAt ?? job.createdAt,
                    isWaiting: isWaiting,
                    onOpenLoopbackURL: onLoopbackURL,
                    onOpenBlock: onOpenBlock,
                    onOpenStep: onOpenStep
                )
                .contextMenu {
                    Button {
                        UIPasteboard.general.string = timeline.proseText
                    } label: { Label("Copy", systemImage: "doc.on.doc") }
                    if let onFork {
                        Button("Fork in new chat", systemImage: "arrow.triangle.branch") { onFork() }
                    }
                }
                ForEach(approvals) { approval in
                    RelayApprovalCard(approval: approval) { decision, answers in
                        onDecide(approval, decision, answers)
                    }
                    .accessibilityIdentifier("relay-chat-approval")
                }
                if let fallbackAnswer {
                    RelayTurnProse(text: fallbackAnswer, isStreaming: false, onOpenLoopbackURL: onLoopbackURL)
                        .equatable()
                }
                if job.status == .failed || job.status == .timeout,
                   let error = job.errorMessage?.trimmedNonEmpty,
                   error != timeline.proseText.trimmedNonEmpty {
                    Text(error)
                        .font(RelayTheme.uiFont(13.5))
                        .foregroundStyle(theme.statusDanger)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.top, 8)
                }
                if job.needsProviderSignIn {
                    RelaySignInAgainRow(provider: job.provider, action: onSignIn)
                        .padding(.top, 10)
                }
            }

            if let previewSourceURL {
                RelayAppPreviewNotice { onLoopbackURL(previewSourceURL) }
                    .padding(.top, 12)
            }
            if !job.artifacts.isEmpty {
                RelayJobArtifacts(artifacts: job.artifacts, client: client, onOpen: onArtifact)
                    .padding(.top, 14)
            }

            RelayTurnFooter(
                job: job,
                isCancelling: isCancelling,
                onFullLog: onFullLog,
                onCancel: onCancel,
                copyText: copyableAnswer,
                onFork: onFork
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("relay-job-turn")
        .onChange(of: job.status.isActive) { _, isActive in
            if !isActive {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }
}

private struct RelayJobCard: View {
    let job: CodexJob
    let client: CodexClient
    let liveTail: String?
    var hidesAnswer = false
    var showsByline = false
    let isCancelling: Bool
    let onCancel: () -> Void
    let onFullLog: () -> Void
    let onArtifact: (CodexJobArtifact) -> Void
    let onLoopbackURL: (URL) -> Void
    var onFork: (() -> Void)? = nil
    var onSignIn: () -> Void = {}

    @Environment(\.relayTheme) private var theme
    @State private var activityExpanded = false

    private var activeTailText: String? {
        liveTail?.trimmedNonEmpty ?? job.displayOutput?.trimmedNonEmpty
    }

    private var activityBlocks: [RelayRunLogBlock] {
        RelayRunLogParser.parse(activeTailText ?? "")
    }

    private var latestCommand: String? {
        activityBlocks.reversed().compactMap { block in
            if case .step(let command, _, _) = block.kind { return command }
            return nil
        }.first
    }

    private var leadingProse: String? {
        guard activeTailText?.contains("[relay-step] ") == true,
              let first = activityBlocks.first,
              case .prose(let prose) = first.kind else { return nil }
        return prose
    }

    private var activityTitle: String {
        switch job.status {
        case .queued: return "Waiting to start"
        case .waitingForApproval: return "Waiting for your approval"
        case .canceling: return "Stopping run"
        case .succeeded: return "Activity"
        case .failed: return "Run failed"
        case .timeout: return "Run timed out"
        case .canceled: return "Run stopped"
        default:
            if let latestCommand, latestCommand.count <= 80 { return latestCommand }
            return "Working on your request"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showsByline { RelayTurnByline(provider: job.provider) }

            if job.status.isActive, let prose = leadingProse {
                RelayTurnProse(text: prose, isStreaming: true, onOpenLoopbackURL: onLoopbackURL)
                    .equatable()
            }

            if !job.status.isActive,
               let text = job.displayOutput?.trimmedNonEmpty {
                if !hidesAnswer {
                    RelayTurnProse(text: text, isStreaming: false, onOpenLoopbackURL: onLoopbackURL)
                        .equatable()
                    RelayMessageActions(text: text, onFork: onFork)
                }
                if let sourceURL = RelayOutputURLPolicy.loopbackURLs(in: text).first {
                    RelayAppPreviewNotice { onLoopbackURL(sourceURL) }
                }
            }

            if job.needsProviderSignIn {
                RelaySignInAgainRow(provider: job.provider, action: onSignIn)
            }

            if !job.artifacts.isEmpty {
                RelayJobArtifacts(artifacts: job.artifacts, client: client, onOpen: onArtifact)
            }

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    activityExpanded.toggle()
                } label: {
                    HStack(spacing: 10) {
                        if job.status.isActive {
                            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                        } else {
                            Image(systemName: "terminal")
                                .font(.system(size: 13))
                                .foregroundStyle(theme.foregroundExtraMuted)
                        }
                        VStack(alignment: .leading, spacing: 3) {
                            Text(activityTitle)
                                .font(RelayTheme.uiFont(14, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            RelayChatRunStatus(job: job)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: activityExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    }
                    .padding(.vertical, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-job-activity")
                .accessibilityLabel("\(activityTitle), \(job.status.label)")
                .accessibilityValue(activityExpanded ? "Expanded" : "Collapsed")

                if activityExpanded {
                    if let model = job.model?.trimmedNonEmpty {
                        Text(model)
                            .font(RelayTheme.uiFont(12.5))
                            .foregroundStyle(theme.foregroundMuted)
                            .padding(.bottom, 10)
                    }
                    if job.status.isActive {
                        ForEach(activityBlocks) { block in
                            activityBlock(block)
                        }
                        if activityBlocks.isEmpty {
                            Text("No output yet.")
                                .font(RelayTheme.uiFont(13))
                                .foregroundStyle(theme.foregroundMuted)
                                .padding(.bottom, 10)
                        }
                    } else {
                        Text("Open the full log for commands, output, and run details.")
                            .font(RelayTheme.uiFont(13))
                            .foregroundStyle(theme.foregroundMuted)
                            .padding(.bottom, 10)
                    }
                }

                if job.status.isActive, !activityExpanded {
                    ForEach(activityBlocks) { block in
                        if case .warning(let message) = block.kind {
                            Text("Warning: \(message)")
                                .font(RelayTheme.uiFont(13))
                                .foregroundStyle(theme.statusWarning)
                                .lineLimit(2)
                                .padding(.bottom, 10)
                        }
                    }
                }

                Rectangle().fill(theme.border).frame(height: 1)
                HStack {
                    Button("View activity", action: onFullLog)
                        .frame(minHeight: 40)
                    Spacer()
                    if job.status.isActive {
                        Button(isCancelling ? "Stopping…" : "Stop", action: onCancel)
                            .foregroundStyle(theme.statusDanger)
                            .frame(minWidth: 44, minHeight: 40)
                            .disabled(isCancelling || job.status == .canceling)
                            .accessibilityLabel("Stop run")
                    }
                }
                .font(RelayTheme.uiFont(13, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
                .buttonStyle(.plain)
            }
            .padding(.horizontal, job.status.isActive ? 14 : 0)
            .background(job.status.isActive ? theme.surface1 : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                if job.status.isActive {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(theme.border, lineWidth: 1)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .onChange(of: job.status.isActive) { _, isActive in
            if !isActive {
                activityExpanded = false
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }

    @ViewBuilder
    private func activityBlock(_ block: RelayRunLogBlock) -> some View {
        switch block.kind {
        case .step(let command, let output, let exitCode):
            DisclosureGroup {
                Text(output.isEmpty ? "No output yet." : output)
                    .font(RelayTheme.monoFont(12))
                    .foregroundStyle(theme.foregroundMuted)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 10)
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(command)
                        .font(RelayTheme.monoFont(12))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(2)
                    if let exitCode {
                        Text("Exit \(exitCode)")
                            .font(RelayTheme.monoFont(11))
                            .foregroundStyle(exitCode == 0 ? theme.foregroundMuted : theme.statusDanger)
                    }
                }
                .padding(.vertical, 8)
            }
            .tint(theme.foregroundExtraMuted)
        case .prose(let text):
            RelayPaseoMarkdownView(text: text, theme: theme)
                .padding(.bottom, 10)
        case .warning(let message):
            Text("Warning: \(message)")
                .font(RelayTheme.uiFont(13))
                .foregroundStyle(theme.statusWarning)
                .padding(.vertical, 8)
        }
    }
}

private struct RelayChatRunStatus: View {
    let job: CodexJob
    @Environment(\.relayTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            Text(job.status.label)
                .foregroundStyle(statusColor)
            if job.status.isActive, let start = job.startedAt ?? job.createdAt {
                Text("·").foregroundStyle(theme.foregroundExtraMuted)
                Text(start, style: .timer)
                    .monospacedDigit()
                    .foregroundStyle(theme.foregroundMuted)
                    .fixedSize()
            } else if let duration = job.durationMs {
                Text("· \(max(0, duration / 1000))s")
                    .monospacedDigit()
                    .foregroundStyle(theme.foregroundMuted)
            }
        }
        .font(RelayTheme.uiFont(12))
    }

    private var statusColor: Color {
        switch job.status {
        case .waitingForApproval: theme.statusWarning
        case .failed, .timeout: theme.statusDanger
        case .running, .queued, .canceling: theme.statusDotRunning
        default: theme.foregroundMuted
        }
    }
}

// MARK: - Artifacts & Previews

private struct RelayJobArtifacts: View {
    let artifacts: [CodexJobArtifact]
    let client: CodexClient
    let onOpen: (CodexJobArtifact) -> Void
    @Environment(\.relayTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(artifacts.count == 1 ? "Output" : "\(artifacts.count) outputs")
                .font(RelayTheme.uiFont(12, weight: .medium))
                .foregroundStyle(theme.foregroundExtraMuted)

            ForEach(artifacts) { artifact in
                RelayArtifactCard(artifact: artifact, client: client) {
                    onOpen(artifact)
                }
            }
        }
        .accessibilityIdentifier("relay-job-artifacts")
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RelayArtifactCard: View {
    let artifact: CodexJobArtifact
    let client: CodexClient
    let onOpen: () -> Void

    @Environment(\.relayTheme) private var theme
    @State private var thumbnail: UIImage?
    @State private var isLoadingThumbnail = false
    @State private var thumbnailFailed = false

    var body: some View {
        Button(action: onOpen) {
            VStack(alignment: .leading, spacing: 0) {
                if artifact.relayViewerKind == .image {
                    thumbnailContent
                }

                HStack(spacing: 10) {
                    Image(systemName: artifact.relaySymbolName)
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(theme.accentBright)
                        .frame(width: 24, height: 24)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(artifact.relayDisplayTitle)
                            .font(RelayTheme.uiFont(13.5, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)
                        Text(artifact.relayMetadataLabel)
                            .font(RelayTheme.monoFont(10.5))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 8)

                    Text(artifact.relayActionLabel)
                        .font(RelayTheme.uiFont(12, weight: .medium))
                        .foregroundStyle(theme.accentBright)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
                .padding(11)
            }
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: 11, style: .continuous))
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel("\(artifact.relayActionLabel) \(artifact.relayDisplayTitle)")
        .task(id: artifact.rawURL) {
            await loadThumbnailIfNeeded()
        }
    }

    @ViewBuilder
    private var thumbnailContent: some View {
        if let thumbnail {
            Image(uiImage: thumbnail)
                .resizable()
                .scaledToFit()
                .frame(maxWidth: .infinity)
                .frame(height: 140)
                .background(theme.surface2.opacity(0.6))
        } else if isLoadingThumbnail {
            ZStack {
                theme.surface2.opacity(0.4)
                ProgressView().controlSize(.small).tint(theme.accent)
            }
            .frame(height: 140)
        } else if thumbnailFailed {
            ZStack {
                theme.surface2.opacity(0.4)
                Label("Open image", systemImage: "photo")
                    .font(RelayTheme.uiFont(12.5, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
            }
            .frame(height: 140)
        }
    }

    @MainActor
    private func loadThumbnailIfNeeded() async {
        guard artifact.relayViewerKind == .image, thumbnail == nil, !isLoadingThumbnail else { return }
        isLoadingThumbnail = true
        thumbnailFailed = false
        defer { isLoadingThumbnail = false }
        do {
            let result = try await client.fetchArtifact(artifact.rawURL)
            thumbnail = UIImage(data: result.data)
            thumbnailFailed = thumbnail == nil
        } catch is CancellationError {
            return
        } catch {
            thumbnailFailed = true
        }
    }
}

struct RelayArtifactViewer: View {
    let artifact: CodexJobArtifact
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme
    @State private var data = Data()
    @State private var text = ""
    @State private var image: UIImage?
    @State private var localFileURL: URL?
    @State private var localFileDirectoryURL: URL?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        if artifact.relayViewerKind == .web, let url = webURL {
            AuthenticatedWebView(
                url: url,
                title: artifact.relayDisplayTitle,
                identityStore: identityStore
            )
        } else {
            NavigationStack {
                ZStack {
                    theme.surface0.ignoresSafeArea()
                    fetchedContent
                }
                .navigationTitle(artifact.relayDisplayTitle)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                            .foregroundStyle(theme.accentBright)
                    }
                    if let localFileURL {
                        ToolbarItem(placement: .topBarTrailing) {
                            ShareLink(item: localFileURL) {
                                Image(systemName: "square.and.arrow.up")
                            }
                            .accessibilityLabel("Share output")
                        }
                    }
                }
                .task(id: artifact.id) {
                    await load()
                }
                .onDisappear(perform: removeLocalFile)
            }
            .preferredColorScheme(theme.colorScheme)
        }
    }

    private var webURL: URL? {
        client.resolvedArtifactURL(artifact.previewURL)
            ?? client.resolvedArtifactURL(artifact.rawURL)
    }

    @ViewBuilder
    private var fetchedContent: some View {
        if isLoading, data.isEmpty {
            ProgressView().tint(theme.accent)
        } else if let errorMessage, data.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(theme.statusDanger)
                Text("Could not open this output")
                    .font(RelayTheme.uiFont(16, weight: .semibold))
                    .foregroundStyle(theme.foreground)
                Text(errorMessage)
                    .font(RelayTheme.uiFont(13.5))
                    .foregroundStyle(theme.foregroundMuted)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await load() } }
                    .font(RelayTheme.uiFont(14, weight: .semibold))
                    .foregroundStyle(theme.accentBright)
            }
            .padding(.horizontal, 32)
        } else {
            switch artifact.relayViewerKind {
            case .image:
                imageContent
            case .markdown:
                ScrollView {
                    RelayMarkdownText(text: text, userAligned: false)
                        .padding(16)
                }
            case .text:
                ScrollView([.horizontal, .vertical]) {
                    Text(text.isEmpty ? "This output is empty." : text)
                        .font(RelayTheme.monoFont(12))
                        .foregroundStyle(text.isEmpty ? theme.foregroundExtraMuted : theme.foreground)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: true, vertical: false)
                        .padding(16)
                }
            case .table:
                RelayDelimitedTableView(
                    text: text,
                    delimiter: artifact.filename.lowercased().hasSuffix(".tsv") ? "\t" : ","
                )
            case .quickLook:
                if let localFileURL {
                    RelayQuickLookPreview(fileURL: localFileURL)
                } else {
                    ProgressView().tint(theme.accent)
                }
            case .web:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private var imageContent: some View {
        if let image {
            GeometryReader { proxy in
                ScrollView([.horizontal, .vertical]) {
                    Image(uiImage: image)
                        .resizable()
                        .scaledToFit()
                        .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
                }
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "photo.badge.exclamationmark")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(theme.statusWarning)
                Text("Relay received the image bytes but iOS could not decode them.")
                    .font(RelayTheme.uiFont(13.5))
                    .foregroundStyle(theme.foregroundMuted)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)
        }
    }

    @MainActor
    private func load() async {
        guard artifact.relayViewerKind != .web, !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            let result = try await client.fetchArtifact(artifact.rawURL)
            data = result.data
            switch artifact.relayViewerKind {
            case .image:
                image = UIImage(data: result.data)
            case .text, .markdown, .table:
                text = String(decoding: result.data, as: UTF8.self)
            case .quickLook:
                try stageLocalFile(result.data)
            case .web:
                break
            }
        } catch is CancellationError {
            return
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    @MainActor
    private func stageLocalFile(_ data: Data) throws {
        removeLocalFile()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-artifact-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let name = URL(fileURLWithPath: artifact.filename).lastPathComponent.trimmedNonEmpty ?? "output"
        let url = directory.appendingPathComponent(name)
        try data.write(to: url, options: .atomic)
        localFileDirectoryURL = directory
        localFileURL = url
    }

    @MainActor
    private func removeLocalFile() {
        localFileURL = nil
        if let localFileDirectoryURL {
            try? FileManager.default.removeItem(at: localFileDirectoryURL)
        }
        localFileDirectoryURL = nil
    }
}

private struct RelayAppPreviewNotice: View {
    let onOpen: () -> Void
    @Environment(\.relayTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(theme.statusWarning)
                VStack(alignment: .leading, spacing: 3) {
                    Text("App preview ready")
                        .font(RelayTheme.uiFont(13, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    Text("Relay can show the running app from your linked computer.")
                        .font(RelayTheme.uiFont(12))
                        .foregroundStyle(theme.foregroundMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Button(action: onOpen) {
                HStack(spacing: 7) {
                    Image(systemName: "arrow.up.right.square")
                    Text("Show app")
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                }
                .font(RelayTheme.uiFont(12.5, weight: .medium))
                .foregroundStyle(theme.statusWarning)
                .padding(.horizontal, 10)
                .frame(height: 34)
                .background(theme.statusWarningTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-show-app")
        }
        .padding(11)
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 11, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .accessibilityIdentifier("relay-app-preview-notice")
    }
}

private struct RelayAutomaticPreviewCandidate {
    let triggerJobID: String
    let previewJobID: String
    let sourceURL: URL

    var key: String { "\(triggerJobID)|\(previewJobID)|\(sourceURL.absoluteString)" }
}

struct RelayRemotePreviewRequest: Identifiable {
    let id = UUID()
    let jobID: String
    let sourceURL: URL
}

struct RelayRemotePreviewViewer: View {
    let request: RelayRemotePreviewRequest
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme
    @State private var previewURL: URL?
    @State private var isLoading = false
    @State private var errorMessage: String?

    var body: some View {
        Group {
            if let previewURL {
                AuthenticatedWebView(
                    url: previewURL,
                    title: "App preview",
                    identityStore: identityStore
                )
            } else {
                NavigationStack {
                    ZStack {
                        theme.surface0.ignoresSafeArea()
                        statusContent
                    }
                    .navigationTitle("App preview")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { dismiss() }
                                .foregroundStyle(theme.accentBright)
                        }
                    }
                }
                .preferredColorScheme(theme.colorScheme)
            }
        }
        .task(id: request.id) {
            await openPreview()
        }
    }

    @ViewBuilder
    private var statusContent: some View {
        if isLoading {
            VStack(spacing: 12) {
                ProgressView().tint(theme.accent)
                Text("Connecting to the app…")
                    .font(RelayTheme.uiFont(13.5, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(theme.statusWarning)
                Text("Could not open the app preview")
                    .font(RelayTheme.uiFont(16, weight: .semibold))
                    .foregroundStyle(theme.foreground)
                Text(errorMessage ?? "The linked computer did not return a preview.")
                    .font(RelayTheme.uiFont(13.5))
                    .foregroundStyle(theme.foregroundMuted)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await openPreview() } }
                    .font(RelayTheme.uiFont(14, weight: .semibold))
                    .foregroundStyle(theme.accentBright)
            }
            .padding(.horizontal, 32)
        }
    }

    @MainActor
    private func openPreview() async {
        guard !isLoading else { return }
        isLoading = true
        errorMessage = nil
        defer { isLoading = false }
        do {
            previewURL = try await client.createPreview(
                jobID: request.jobID,
                sourceURL: request.sourceURL
            ).url
        } catch is CancellationError {
            return
        } catch let error as CodexClientError where error.isGenericRouteNotFound {
            errorMessage = "This linked computer is running an older Relay service that cannot open app previews. Update Relay on that computer, then try again."
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private extension CodexJobArtifact {
    var relayViewerKind: RelayArtifactViewerKind {
        let sharedKind = relaySharedContract.artifactPresentationKind(
            filename: filename,
            contentType: contentType,
            artifactKind: kind.rawValue,
            hasPreview: previewURL?.trimmedNonEmpty != nil
        )
        switch sharedKind {
        case "image": return .image
        case "web": return .web
        case "markdown": return .markdown
        case "table": return .table
        case "text": return .text
        default: return .quickLook
        }
    }

    var relayDisplayTitle: String {
        title?.trimmedNonEmpty ?? filename
    }

    var relayMetadataLabel: String {
        let type = language?.trimmedNonEmpty?.uppercased()
            ?? normalizedContentType.split(separator: "/").last.map(String.init)?.uppercased()
            ?? kind.rawValue
        guard let bytes else { return type }
        return "\(type) · \(ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file))"
    }

    var relayActionLabel: String {
        switch relayViewerKind {
        case .image: return "View"
        case .web: return "Preview"
        case .markdown, .table, .text, .quickLook: return "Open"
        }
    }

    var relaySymbolName: String {
        switch relayViewerKind {
        case .image: return "photo"
        case .web: return "safari"
        case .markdown: return "doc.richtext"
        case .table: return "tablecells"
        case .text: return "chevron.left.forwardslash.chevron.right"
        case .quickLook: return "doc.text.magnifyingglass"
        }
    }

    private var normalizedContentType: String {
        contentType?
            .split(separator: ";", maxSplits: 1)
            .first
            .map(String.init)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased() ?? ""
    }
}

private enum RelayArtifactViewerKind {
    case image
    case web
    case markdown
    case table
    case text
    case quickLook
}

// MARK: - Threads Drawer & Consent Sheet

private struct RelayThreadDrawer: View {
    @ObservedObject var viewModel: RelayChatViewModel
    var onContinueHandoff: (RelayHandoffCard) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    Button {
                        viewModel.startNewConversation()
                        dismiss()
                    } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                            .font(RelayTheme.uiFont(15.5, weight: .medium))
                            .foregroundStyle(theme.accentBright)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 20)
                            .frame(minHeight: 48)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 6)

                    handoffSection

                    if viewModel.historyItems.isEmpty {
                        Text("No chats in this folder yet.")
                            .font(RelayTheme.uiFont(13.5))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .padding(.horizontal, 20)
                            .padding(.top, 20)
                    } else {
                        Text("This folder")
                            .font(RelayTheme.uiFont(13, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)
                            .padding(.horizontal, 20)
                            .padding(.top, 22)
                            .padding(.bottom, 4)
                            .accessibilityAddTraits(.isHeader)
                        ForEach(viewModel.historyItems) { item in
                            historyRow(item)
                        }
                    }

                    macSessionSection
                }
                .padding(.bottom, 28)
            }
            .background(theme.surface0)
            .navigationTitle("Threads")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(theme.foreground)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await viewModel.refreshHandoffs()
                while !Task.isCancelled {
                    await viewModel.refreshThreads()
                    try? await Task.sleep(for: .seconds(4))
                }
            }
            .preferredColorScheme(theme.colorScheme)
        }
    }

    @ViewBuilder private var handoffSection: some View {
        if !viewModel.handoffs.isEmpty {
            HStack(spacing: 4) {
                Text("Continue from your computer")
                    .font(RelayTheme.uiFont(13, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                RelayInfoButton(
                    title: "Handoff",
                    message: "These are Codex or Claude Code sessions sent from your linked computer. Continue resumes the same work on your Relay machine."
                )
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
            ForEach(viewModel.handoffs) { card in
                RelayHandoffCardView(
                    card: card,
                    manifest: viewModel.handoffManifests[card.id],
                    isContinuing: viewModel.continuingHandoffIDs.contains(card.id),
                    onContinue: {
                        onContinueHandoff(card)
                    }
                )
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
        }
    }

    @ViewBuilder private var macSessionSection: some View {
        if let index = viewModel.macSessions, !index.sessions.isEmpty {
            HStack(spacing: 8) {
                Text(index.sectionTitle)
                Spacer()
                if let updatedAt = index.updatedAtDate {
                    Text(RelayRelativeTime.string(for: updatedAt))
                        .font(RelayTheme.monoFont(10.5))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
            }
            .font(RelayTheme.uiFont(13, weight: .medium))
            .foregroundStyle(theme.foregroundMuted)
            .padding(.horizontal, 20)
            .padding(.top, 22)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
            ForEach(index.sessions) { session in
                RelayMacSessionRow(session: session, onStartFresh: {
                    viewModel.startFresh(from: session)
                    dismiss()
                })
                .padding(.horizontal, 20)
            }
            Text("Run relay handoff there to continue one of these exactly.")
                .font(RelayTheme.uiFont(12))
                .foregroundStyle(theme.foregroundExtraMuted)
                .padding(.horizontal, 20)
                .padding(.top, 8)
        }
    }

    private func historyRow(_ item: CodexThreadFeedItem) -> some View {
        Button {
            Task {
                await viewModel.openHistoryItem(item)
                dismiss()
            }
        } label: {
            RelayConversationRow(item: item)
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            if case .thread(let thread) = item.source {
                Button("Delete", role: .destructive) {
                    Task { await viewModel.delete(thread) }
                }
            }
        }
    }
}

private struct RelayStatusBanner: View {
    let text: String

    var body: some View {
        RelayInlineNotice(text: text)
    }
}

private struct RelayFullLogRequest: Identifiable {
    var id: String { jobID }
    let jobID: String
}

private enum RelayAIDataConsentPurpose: Equatable {
    case review
    case sendPrompt
}

private struct RelayAIDataConsentRequest: Identifiable {
    let id = UUID()
    let provider: CodexProvider
    let purpose: RelayAIDataConsentPurpose
}

private struct RelayAIDataConsentSheet: View {
    let provider: CodexProvider
    let purpose: RelayAIDataConsentPurpose
    let isConsentGranted: Bool
    let onAllow: () -> Void
    let onCancel: () -> Void
    @Environment(\.relayTheme) private var theme

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    RelayProviderMark(provider: provider, size: 32)
                        .frame(width: 56, height: 56)
                        .background(theme.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Share work content with \(provider.aiDataRecipient)?")
                            .font(RelayTheme.uiFont(24, weight: .semibold))
                            .foregroundStyle(theme.foreground)

                        Text(provider.aiDataDisclosure)
                            .font(RelayTheme.uiFont(15))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineSpacing(4)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        disclosureRow("01", "Your prompt and conversation history")
                        disclosureRow("02", "Workspace files, attachments, and command output the agent needs")
                        disclosureRow("03", "Used by \(provider.aiDataRecipient) to provide the requested AI service")
                    }

                    Text("Relay does not share your Relay name, email, password, device identifiers, or Apple payment and subscription details with this AI provider. You can decline and nothing will be sent.")
                        .font(RelayTheme.uiFont(13))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineSpacing(3)

                    Link("Read Privacy Policy", destination: URL(string: "https://app.openrelay.sh/privacy")!)
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.accentBright)

                    VStack(spacing: 10) {
                        RelayButton(primaryActionTitle, variant: .primary, isFullWidth: true, action: onAllow)
                            .accessibilityIdentifier("relay-ai-data-consent-allow")

                        if !isConsentGranted {
                            RelayButton("Not Now", variant: .outline, isFullWidth: true, action: onCancel)
                                .accessibilityIdentifier("relay-ai-data-consent-cancel")
                        }
                    }
                    .padding(.top, 4)
                }
                .padding(24)
            }
            .background(theme.surface0)
            .navigationTitle("AI Data Sharing")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(theme.colorScheme)
        .presentationDetents([.large])
    }

    private var primaryActionTitle: String {
        if isConsentGranted { return "Done" }
        return purpose == .sendPrompt ? "Allow & Send" : "Allow"
    }

    private func disclosureRow(_ index: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            Text(index)
                .font(RelayTheme.monoFont(11, weight: .semibold))
                .foregroundStyle(theme.accentBright)
            Text(text)
                .font(RelayTheme.uiFont(14))
                .foregroundStyle(theme.foreground)
        }
    }
}
