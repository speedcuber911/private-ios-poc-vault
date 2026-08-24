import AVFoundation
import SwiftUI
import UIKit

struct RelayChatView: View {
    @ObservedObject var viewModel: RelayChatViewModel
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore
    /// Set when the chat is presented as a folder's full-screen cover; shows the
    /// dismiss chevron in the top bar. Dismissing never cancels streams (VM-owned).
    var onDismiss: (() -> Void)? = nil
    /// Raised by the root when a handoff push is tapped: open the threads list,
    /// which is where handoff cards live. Lowered again once honored, so a second
    /// push after the sheet was closed still opens it.
    var threadsRequest: Binding<Bool> = .constant(false)
    /// Continue from a handoff opened in the wrong chat (the root, after a push)
    /// rebinds the cover to that checkout folder, then resumes there.
    var onBindChatToFolder: ((_ folderPath: String, _ workspaceID: String?, _ card: RelayHandoffCard) -> Void)? = nil
    /// New-session entry points ask for the owning agent/model after the server catalog
    /// has loaded. Existing-thread and push entry points leave the picker closed.
    var presentsProviderPickerOnAppear = false
    @State private var showingThreads = false
    @State private var threadsPreferLarge = false
    @State private var fullLogRequest: RelayFullLogRequest?
    @State private var artifactRequest: CodexJobArtifact?
    @State private var remotePreviewRequest: RelayRemotePreviewRequest?
    @State private var automaticallyOpenedPreviews: Set<String> = []
    @State private var modelPickerRequest = 0
    @State private var didHandleInitialProviderPicker = false
    @State private var aiDataConsentRequest: RelayAIDataConsentRequest?

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()

                VStack(spacing: 0) {
                    topBar
                        .simultaneousGesture(keyboardDismissTap)
                    threadAccessBar
                        .simultaneousGesture(keyboardDismissTap)
                    messageList
                        .layoutPriority(1)
                        .contentShape(Rectangle())
                        .simultaneousGesture(keyboardDismissTap)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if !showingThreads {
                    RelayComposer(
                        text: $viewModel.prompt,
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
                        isSending: viewModel.isSending,
                        isStreaming: viewModel.isStreaming,
                        isTranscribing: viewModel.isTranscribing,
                        onPickChoice: { viewModel.selectChoice($0) },
                        onPickEffort: { viewModel.selectEffort($0) },
                        onToggleSkill: { viewModel.toggleSkill($0) },
                        onPickClaudePermission: { viewModel.claudePermissionMode = $0 },
                        onPickCodexApproval: { viewModel.codexApprovalPolicy = $0 },
                        onNewConversation: { viewModel.startNewConversation() },
                        onVoice: { fileURL in
                            Task { await viewModel.transcribePromptAudio(fileURL: fileURL) }
                        },
                        onSend: {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            requestPromptSend()
                        },
                        onStop: {
                            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                            viewModel.stopStreaming()
                        }
                    )
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .task {
                honorThreadsRequest()
                await viewModel.bootstrap()
                if presentsProviderPickerOnAppear, !didHandleInitialProviderPicker {
                    didHandleInitialProviderPicker = true
                    modelPickerRequest += 1
                }
            }
            .onChange(of: threadsRequest.wrappedValue) { _, _ in
                honorThreadsRequest()
            }
            .onChange(of: automaticPreviewCandidate?.key) { _, _ in
                openRequestedPreviewIfNeeded()
            }
            .refreshable {
                await viewModel.refreshThreads()
            }
            .sheet(isPresented: $showingThreads) {
                RelayThreadDrawer(
                    viewModel: viewModel,
                    onContinueHandoff: { card in
                        Task { await continueHandoff(card) }
                    }
                )
                    .presentationDetents(threadsPreferLarge ? [.large] : [.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $fullLogRequest) { request in
                RelayFullLogSheet(job: request.job) {
                    await viewModel.loadFullLog(for: request.job)
                }
            }
            .sheet(item: $aiDataConsentRequest) { request in
                RelayAIDataConsentSheet(
                    provider: request.provider,
                    onAllow: {
                        RelayAIDataConsentStore.grantConsent(for: request.provider)
                        aiDataConsentRequest = nil
                        Task { await viewModel.sendCurrentPrompt() }
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
            .fullScreenCover(item: $remotePreviewRequest) { request in
                RelayRemotePreviewViewer(
                    request: request,
                    client: client,
                    identityStore: identityStore
                )
            }
        }
        // The chat opens as its own full-screen presentation; re-pin the app's
        // deliberate dark-only appearance so the cover can never flash light.
        .preferredColorScheme(.dark)
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "chevron.down")
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(width: 36, height: 36)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close chat")
            }

            Button {
                startNewConversation()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(AppTheme.uiFont(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(width: 36, height: 36)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New conversation")

            VStack(alignment: .leading, spacing: 2) {
                Text(viewModel.folderDisplayName)
                    .font(AppTheme.serifFont(size: 24))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                if let path = viewModel.folderPathLabel {
                    Text(path)
                        .font(AppTheme.monoFont(size: 10))
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineLimit(1)
                        .truncationMode(.head)
                }
                if let choice = viewModel.selectedChoice {
                    HStack(spacing: 8) {
                        RelayProviderBadge(
                            provider: choice.executionProvider,
                            detail: "\(choice.shortModelLabel) · \(choice.mode.label)",
                            style: .plain,
                            size: 9
                        )
                        if viewModel.currentSessionProvider != nil {
                            RelayCapsLabel(text: "Provider locked", color: AppTheme.textFaint, size: 8)
                        }
                        if let harness = viewModel.selectedHarnessStatus {
                            RelayCapsLabel(
                                text: harness.shortStatus,
                                color: harness.isConfirmedUnavailable
                                    ? AppTheme.statusWarn
                                    : harness.loggedIn == true
                                        ? choice.executionProvider.relayPresentation.accent
                                        : AppTheme.textFaint,
                                size: 8
                            )
                        }
                    }
                    .padding(.top, 3)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var threadAccessBar: some View {
        Button {
            threadsPreferLarge = false
            showingThreads = true
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "bubble.left.and.bubble.right")
                    .font(AppTheme.uiFont(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)

                Text("Threads")
                    .font(AppTheme.uiFont(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)

                // A session waiting to be picked up is the one thing in the
                // drawer the user did not start here, so it is named out front.
                if !viewModel.handoffs.isEmpty {
                    RelayCapsLabel(
                        text: "\(viewModel.handoffs.count) handed off",
                        color: AppTheme.accent,
                        size: 9
                    )
                }

                Spacer()

                Text("\(viewModel.historyItems.count)")
                    .font(AppTheme.monoFont(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)

                Image(systemName: "chevron.right")
                    .font(AppTheme.uiFont(size: 11, weight: .semibold))
                    .foregroundStyle(AppTheme.textFaint)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .overlay(alignment: .bottom) {
                Rectangle()
                    .fill(AppTheme.hairline)
                    .frame(height: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Threads, \(viewModel.historyItems.count) conversations and invocations")
        .accessibilityIdentifier("relay-threads")
    }

    private func honorThreadsRequest() {
        guard threadsRequest.wrappedValue else { return }
        threadsRequest.wrappedValue = false
        threadsPreferLarge = true
        showingThreads = true
    }

    private func startNewConversation() {
        viewModel.startNewConversation()
        modelPickerRequest += 1
    }

    private func requestPromptSend() {
        guard let provider = viewModel.selectedChoice?.model.provider else {
            Task { await viewModel.sendCurrentPrompt() }
            return
        }
        guard RelayAIDataConsentStore.hasConsent(for: provider) else {
            dismissKeyboard()
            aiDataConsentRequest = RelayAIDataConsentRequest(provider: provider)
            return
        }
        Task { await viewModel.sendCurrentPrompt() }
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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    if let error = viewModel.errorMessage {
                        RelayStatusBanner(text: error)
                    }

                    if viewModel.messages.isEmpty && !viewModel.isSending {
                        RelayEmptyConversation(choice: viewModel.selectedChoice)
                    } else {
                        ForEach(viewModel.messages) { item in
                            if let job = item.job {
                                RelayJobCard(
                                    job: job,
                                    client: client,
                                    liveTail: viewModel.liveJobTails[job.id],
                                    isCancelling: viewModel.cancellingJobIDs.contains(job.id),
                                    onCancel: {
                                        Task { await viewModel.cancel(job: job) }
                                    },
                                    onFullLog: {
                                        fullLogRequest = RelayFullLogRequest(job: job)
                                    },
                                    onArtifact: { artifact in
                                        artifactRequest = artifact
                                    },
                                    onLoopbackURL: { url in
                                        remotePreviewRequest = RelayRemotePreviewRequest(
                                            jobID: job.id,
                                            sourceURL: url
                                        )
                                    }
                                )
                                .id(item.id)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                            } else {
                                RelayChatBubble(item: item)
                                    .id(item.id)
                                    .transition(.move(edge: item.role == .user ? .trailing : .leading).combined(with: .opacity))
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id(Self.bottomAnchor)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .animation(.spring(response: 0.36, dampingFraction: 0.82), value: viewModel.messages.count)
            .onChange(of: viewModel.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: streamingTextLength) { _, _ in scrollToBottom(proxy, animated: false) }
            // Task completion updates an existing message rather than appending one.
            // Follow that height change so newly-added artifacts do not land beneath
            // the pinned composer while the scroll position stays on the old log tail.
            .onChange(of: completedResultContentVersion) { _, _ in
                scrollToBottom(proxy, animated: false)
            }
            .overlay(alignment: .bottomTrailing) { scrollToBottomButton(proxy) }
        }
    }

    /// Total length of the streaming assistant message; changing this drives auto-follow scroll.
    private var streamingTextLength: Int {
        guard let id = viewModel.streamingMessageID,
              let item = viewModel.messages.first(where: { $0.id == id }) else { return 0 }
        return item.text.count
    }

    private var completedResultContentVersion: Int {
        viewModel.messages.reduce(into: 0) { version, item in
            guard let job = item.job, !job.status.isActive else { return }
            version &+= job.displayOutput?.count ?? 0
            version &+= job.artifacts.count &* 100_000
        }
    }

    private var automaticPreviewCandidate: RelayAutomaticPreviewCandidate? {
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

        // A follow-up may be only “show me,” so its answer need not repeat an endpoint
        // already present in the conversation. The preview lease must still use the job
        // that originally produced that endpoint.
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

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
    }

    @ViewBuilder private func scrollToBottomButton(_ proxy: ScrollViewProxy) -> some View {
        if viewModel.isStreaming {
            Button {
                scrollToBottom(proxy)
            } label: {
                Image(systemName: "arrow.down")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(width: 38, height: 38)
                    .background(AppTheme.canvasTop, in: Circle())
                    .overlay { Circle().stroke(AppTheme.hairline, lineWidth: 0.6) }
            }
            .buttonStyle(.plain)
            .padding(.trailing, 16)
            .padding(.bottom, 8)
            .transition(.scale.combined(with: .opacity))
        }
    }

    private static let bottomAnchor = "relay-bottom-anchor"
}

private struct RelayComposerCommand: Identifiable {
    enum Action {
        case model
        case permissions
        case skills
        case newConversation
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

private struct RelayComposer: View {
    private enum Layout {
        static let horizontalInset: CGFloat = 16
        static let controlHeight: CGFloat = 38
        static let actionSize: CGFloat = 36
        static let rowSpacing: CGFloat = 12
        static let bottomPadding: CGFloat = 10
    }

    @Binding var text: String
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
    let isSending: Bool
    let isStreaming: Bool
    let isTranscribing: Bool
    let onPickChoice: (RelayModelChoice) -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onToggleSkill: (CodexSkillDescriptor) -> Void
    let onPickClaudePermission: (RelayClaudePermissionMode) -> Void
    let onPickCodexApproval: (RelayCodexApprovalPolicy) -> Void
    let onNewConversation: () -> Void
    let onVoice: (URL) -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    @State private var isFocused = false
    @State private var editorSelection = NSRange(location: 0, length: 0)
    @State private var editorHeight: CGFloat = 36
    @State private var showingModelPicker = false
    @State private var showingPermissionPicker = false
    @State private var showingSkillPicker = false
    @State private var skillSearch = ""
    @StateObject private var recorder = RelayPromptAudioRecorder()

    /// Provider identity is part of the thread, not a mutable composer setting.
    /// A clean conversation has no provider yet and therefore sees the full catalog.
    private var visibleSections: RelayModelPickerSections {
        sections.restricted(to: threadProvider)
    }

    private var slashContext: RelaySlashContext? {
        RelaySlashContext.find(in: text, selection: editorSelection)
    }

    private var slashCommands: [RelayComposerCommand] {
        var commands = [
            RelayComposerCommand(
                id: "relay:model",
                command: "/model",
                title: "Change model",
                detail: "Choose an agent and model",
                source: "Relay action",
                action: .model
            ),
            RelayComposerCommand(
                id: "relay:new",
                command: "/new",
                title: "New session",
                detail: "Start a clean conversation in this workspace",
                source: "Relay action",
                action: .newConversation
            ),
            RelayComposerCommand(
                id: "relay:review",
                command: "/review",
                title: "Review changes",
                detail: "Ask the selected agent for a focused code review",
                source: "Relay action",
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
                    source: "\(RelayModelChoice.harnessTitle(for: provider)) setting",
                    action: .permissions
                ))
            }
            commands.append(RelayComposerCommand(
                id: "relay:skills:\(provider.rawValue)",
                command: "/skills",
                title: "Installed skills",
                detail: "Choose from this computer's \(RelayModelChoice.harnessTitle(for: provider)) skills",
                source: "Relay action",
                action: .skills
            ))
        }

        commands.append(contentsOf: skills.map { skill in
            RelayComposerCommand(
                id: "skill:\(skill.provider.rawValue):\(skill.id)",
                command: "/\(skill.name)",
                title: skill.title,
                detail: skill.description,
                source: "Installed \(RelayModelChoice.harnessTitle(for: skill.provider)) \(skill.isCommand ? "command" : "skill")",
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

    private func chipLabel(
        icon: String,
        text: String,
        badge: String? = nil,
        tint: Color = AppTheme.accent,
        providerMark: CodexProvider? = nil
    ) -> some View {
        HStack(spacing: 6) {
            if let providerMark {
                RelayProviderMark(provider: providerMark, size: 13)
            } else {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(tint)
            }
            Text(text)
                .font(AppTheme.uiFont(size: 11, weight: .semibold))
                .tracking(0.8)
                .textCase(.uppercase)
                .lineLimit(1)
                .truncationMode(.tail)
            if let badge {
                Text(badge)
                    .font(AppTheme.uiFont(size: 9, weight: .bold))
                    .foregroundStyle(tint)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(tint.opacity(0.15), in: Capsule())
                    .layoutPriority(1)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(AppTheme.uiFont(size: 9, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
        }
        .foregroundStyle(AppTheme.textPrimary)
        .padding(.horizontal, 12)
        .frame(height: Layout.controlHeight)
        .frame(maxWidth: 240, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .background(
            providerMark == nil ? AppTheme.textPrimary.opacity(0.025) : tint.opacity(0.08),
            in: Capsule()
        )
        .overlay {
            Capsule()
                .stroke(
                    providerMark == nil ? AppTheme.hairlineStrong : tint.opacity(0.34),
                    lineWidth: 1
                )
        }
    }

    /// Harness-first model picker: each agent harness (Codex, Claude Code, Cursor) is a
    /// submenu holding its own task-mode models; chat-capable models live in a flat
    /// "Chat models" section. Both render only what the server catalog advertises.
    private var modelPickerMenu: some View {
        Menu {
            if !visibleSections.agents.isEmpty {
                Section("Agents") {
                    ForEach(visibleSections.agents) { harness in
                        Menu(harness.title) {
                            ForEach(harness.choices) { choice in
                                choiceButton(choice, title: choice.shortModelLabel)
                            }
                        }
                    }
                }
            }
            if !visibleSections.chatModels.isEmpty {
                Section("Chat models") {
                    ForEach(visibleSections.chatModels) { choice in
                        choiceButton(choice, title: choice.chipLabel)
                    }
                }
            }
        } label: {
            let selectedProvider = selectedChoice?.executionProvider
            chipLabel(
                icon: "cpu",
                text: selectedChoice?.chipLabel ?? "Model",
                badge: selectedChoice?.mode.label,
                tint: selectedProvider?.relayPresentation.accent ?? AppTheme.accent,
                providerMark: selectedProvider
            )
        }
        .menuOrder(.fixed)
        .accessibilityIdentifier("relay-model-chip")
        .accessibilityLabel(threadProvider == nil ? "Choose provider and model" : "Choose model for this provider")
    }

    @ViewBuilder private func choiceButton(_ choice: RelayModelChoice, title: String) -> some View {
        Button {
            requestChoice(choice)
        } label: {
            if choice == selectedChoice {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private var effortPickerMenu: some View {
        Menu {
            ForEach(efforts) { effort in
                Button {
                    onPickEffort(effort)
                } label: {
                    Label(effort.label, systemImage: selectedEffort == effort ? "checkmark" : "")
                }
            }
        } label: {
            chipLabel(
                icon: "gauge.with.dots.needle.50percent",
                text: (selectedEffort ?? efforts.first(where: { $0 == .high }) ?? efforts.first)?.label ?? "Effort",
                tint: selectedChoice?.executionProvider.relayPresentation.accent ?? AppTheme.accent
            )
        }
        .accessibilityIdentifier("relay-effort-chip")
    }

    private var permissionChip: some View {
        Button {
            showingPermissionPicker = true
        } label: {
            let scopedProvider = provider ?? .codex
            chipLabel(
                icon: "checkmark.shield",
                text: "\(scopedProvider.relayPresentation.permissionsTitle ?? "Permissions") · \(provider == .claude ? claudePermissionMode.label : codexApprovalPolicy.label)",
                tint: scopedProvider.relayPresentation.accent
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-permission-chip")
        .accessibilityLabel("\(RelayModelChoice.harnessTitle(for: provider ?? .codex)) permissions")
    }

    private var skillChip: some View {
        Button {
            showingSkillPicker = true
        } label: {
            let scopedProvider = provider ?? .codex
            chipLabel(
                icon: "hammer",
                text: scopedProvider.relayPresentation.skillsTitle,
                badge: selectedSkillIDs.isEmpty ? nil : "\(selectedSkillIDs.count)",
                tint: scopedProvider.relayPresentation.accent
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-skill-chip")
        .accessibilityLabel("Skills, \(selectedSkillIDs.count) selected")
    }

    /// A single pinned control rail. It never participates in the conversation's
    /// vertical scrolling or turns into a stacked layout; narrow widths and large text
    /// move sideways inside this rail instead.
    private var controlBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .center, spacing: 8) {
                modelPickerMenu

                if !efforts.isEmpty {
                    effortPickerMenu
                }
                if provider?.hasTaskPermissionControls == true {
                    permissionChip
                }
                if provider != nil {
                    skillChip
                }
            }
        }
        .frame(height: Layout.controlHeight)
        .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
        .accessibilityIdentifier("relay-control-bar")
    }

    var body: some View {
        VStack(spacing: Layout.rowSpacing) {
            if slashContext != nil {
                slashPalette
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            controlBar

            if let harnessStatus, harnessStatus.isConfirmedUnavailable {
                HStack(alignment: .top, spacing: 8) {
                    RelayProviderMark(provider: harnessStatus.provider, size: 14)
                    Text(harnessStatus.actionMessage ?? "This provider is not ready on the linked computer.")
                        .font(AppTheme.uiFont(size: 11, weight: .medium))
                        .foregroundStyle(AppTheme.statusWarn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.horizontal, 4)
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("relay-provider-readiness")
            }

            HStack(alignment: .bottom, spacing: 9) {
                Button {
                    toggleRecording()
                } label: {
                    ZStack {
                        if isTranscribing {
                            ProgressView()
                                .tint(AppTheme.textSecondary)
                                .controlSize(.small)
                        } else {
                            Image(systemName: recorder.isRecording ? "stop.fill" : "mic.fill")
                                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                                .foregroundStyle(recorder.isRecording ? AppTheme.statusWarn : AppTheme.textSecondary)
                        }
                    }
                    .frame(width: Layout.actionSize, height: Layout.actionSize)
                }
                .buttonStyle(.plain)
                .disabled(isSending || isTranscribing)
                .accessibilityLabel(recorder.isRecording ? "Stop recording" : "Record prompt")

                ZStack(alignment: .leading) {
                    if text.isEmpty {
                        Text("Message…")
                            .font(AppTheme.uiFont(size: 15))
                            .foregroundStyle(AppTheme.textTertiary)
                            .allowsHitTesting(false)
                    }
                    RelayCommandTextEditor(
                        text: $text,
                        selection: $editorSelection,
                        isFocused: $isFocused,
                        height: $editorHeight
                    )
                    .frame(height: editorHeight)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if isStreaming {
                    Button(action: onStop) {
                        ZStack {
                            Circle()
                                .fill(AppTheme.accent)
                                .frame(width: Layout.actionSize, height: Layout.actionSize)
                            RoundedRectangle(cornerRadius: 3).fill(.white).frame(width: 12, height: 12)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("relay-stop")
                    .accessibilityLabel("Stop")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Button {
                        isFocused = false
                        onSend()
                    } label: {
                        ZStack {
                            Circle()
                                .fill(canSend ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(AppTheme.textPrimary.opacity(0.08)))
                                .frame(width: Layout.actionSize, height: Layout.actionSize)
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? .white : AppTheme.textTertiary)
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityIdentifier("relay-send")
                    .accessibilityLabel(harnessStatus?.isConfirmedUnavailable == true ? "Provider connection required" : "Send")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background {
                Capsule()
                    .fill(AppTheme.textPrimary.opacity(0.018))
                    .overlay {
                        Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1)
                    }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isStreaming)
        }
        .padding(.horizontal, Layout.horizontalInset)
        .padding(.top, 12)
        .padding(.bottom, Layout.bottomPadding)
        .background(AppTheme.canvasBottom)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(AppTheme.hairlineStrong)
                .frame(height: 1)
        }
        .animation(.easeOut(duration: 0.18), value: isFocused)
        .animation(.easeOut(duration: 0.16), value: slashContext)
        .sheet(isPresented: $showingModelPicker) {
            modelPickerSheet
        }
        .sheet(isPresented: $showingPermissionPicker) {
            permissionPickerSheet
        }
        .sheet(isPresented: $showingSkillPicker) {
            skillPickerSheet
        }
        .onChange(of: modelPickerRequest) { _, _ in
            showingModelPicker = true
        }
    }

    private var slashPalette: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                RelayCapsLabel(
                    text: slashContext?.query.isEmpty == false ? "Matching commands" : "Commands and installed skills",
                    color: AppTheme.textSecondary,
                    size: 9
                )
                Spacer()
                if let provider {
                    RelayProviderBadge(provider: provider, style: .plain, size: 9)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider().overlay(AppTheme.hairline)

            if slashCommands.isEmpty {
                Text("No command or installed skill matches this text.")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
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
                                        .font(AppTheme.monoFont(size: 12, weight: .medium))
                                        .foregroundStyle(provider?.relayPresentation.accent ?? AppTheme.accent)
                                        .frame(width: 112, alignment: .leading)

                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(command.title)
                                            .font(AppTheme.uiFont(size: 13, weight: .semibold))
                                            .foregroundStyle(AppTheme.textPrimary)
                                        Text(command.detail)
                                            .font(AppTheme.uiFont(size: 11))
                                            .foregroundStyle(AppTheme.textSecondary)
                                            .lineLimit(2)
                                        Text(command.source)
                                            .font(AppTheme.uiFont(size: 9, weight: .medium))
                                            .foregroundStyle(AppTheme.textTertiary)
                                            .textCase(.uppercase)
                                            .tracking(0.7)
                                    }
                                    Spacer(minLength: 0)

                                    if isSelectedSkill(command) {
                                        Image(systemName: "checkmark")
                                            .foregroundStyle(provider?.relayPresentation.accent ?? AppTheme.accent)
                                    }
                                }
                                .padding(.horizontal, 12)
                                .padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)

                            if command.id != slashCommands.last?.id {
                                Divider().overlay(AppTheme.hairline).padding(.leading, 134)
                            }
                        }
                    }
                }
                .frame(maxHeight: 248)
            }
        }
        .background(AppTheme.canvasTop)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(AppTheme.hairlineStrong, lineWidth: 1)
        }
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
            showingPermissionPicker = true
        case .skills:
            replaceSlashToken(with: "")
            showingSkillPicker = true
        case .newConversation:
            replaceSlashToken(with: "")
            onNewConversation()
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

    private var modelPickerSheet: some View {
        NavigationStack {
            List {
                if !visibleSections.agents.isEmpty {
                    Section("Agents") {
                        ForEach(visibleSections.agents) { harness in
                            ForEach(harness.choices) { choice in
                                Button {
                                    requestChoice(choice)
                                    showingModelPicker = false
                                } label: {
                                    pickerRow(
                                        title: "\(harness.title) · \(choice.shortModelLabel)",
                                        detail: "Agent session",
                                        selected: choice == selectedChoice,
                                        provider: choice.executionProvider
                                    )
                                }
                            }
                        }
                    }
                }
                if !visibleSections.chatModels.isEmpty {
                    Section("Chat models") {
                        ForEach(visibleSections.chatModels) { choice in
                            Button {
                                requestChoice(choice)
                                showingModelPicker = false
                            } label: {
                                pickerRow(
                                    title: choice.chipLabel,
                                    detail: "Conversation",
                                    selected: choice == selectedChoice,
                                    provider: choice.executionProvider
                                )
                            }
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("Model")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingModelPicker = false }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var permissionPickerSheet: some View {
        NavigationStack {
            List {
                if provider == .claude {
                    Section("Claude Code") {
                        ForEach(RelayClaudePermissionMode.allCases) { mode in
                            Button {
                                onPickClaudePermission(mode)
                            } label: {
                                pickerRow(
                                    title: mode.label,
                                    detail: mode.detail,
                                    selected: mode == claudePermissionMode,
                                    provider: .claude
                                )
                            }
                        }
                    }
                    Section {
                        Text("This setting is sent only to Claude Code jobs. Codex keeps its own independent runner policy.")
                            .font(AppTheme.uiFont(size: 12))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                } else {
                    Section("Codex") {
                        ForEach(RelayCodexApprovalPolicy.allCases) { policy in
                            Button {
                                onPickCodexApproval(policy)
                            } label: {
                                pickerRow(
                                    title: policy.label,
                                    detail: policy.detail,
                                    selected: policy == codexApprovalPolicy,
                                    provider: .codex
                                )
                            }
                        }
                    }
                    Section {
                        Text("This policy is sent only to Codex. Claude Code keeps its own independent permission mode.")
                            .font(AppTheme.uiFont(size: 12))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle((provider ?? .codex).relayPresentation.permissionsTitle ?? "Permissions")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingPermissionPicker = false }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var skillPickerSheet: some View {
        NavigationStack {
            List {
                if filteredSkills.isEmpty {
                    ContentUnavailableView(
                        skillSearch.isEmpty
                            ? "No installed \((provider ?? .codex).relayPresentation.skillsTitle.lowercased())"
                            : "No matching \((provider ?? .codex).relayPresentation.skillsTitle.lowercased())",
                        systemImage: "hammer",
                        description: Text("Relay shows only \((provider ?? .codex).relayPresentation.title) skills discovered on this runner.")
                    )
                    .listRowBackground(Color.clear)
                } else {
                    Section {
                        ForEach(filteredSkills) { skill in
                            Button {
                                onToggleSkill(skill)
                            } label: {
                                pickerRow(
                                    title: skill.title,
                                    detail: skill.description,
                                    selected: selectedSkillIDs.contains(skill.id),
                                    provider: skill.provider
                                )
                            }
                        }
                    } header: {
                        RelayProviderBadge(provider: provider ?? .codex, style: .plain, size: 9)
                    }
                }
            }
            .searchable(text: $skillSearch, prompt: "Search installed skills")
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle((provider ?? .codex).relayPresentation.skillsTitle)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingSkillPicker = false }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var filteredSkills: [CodexSkillDescriptor] {
        let query = skillSearch.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return skills }
        return skills.filter {
            $0.name.lowercased().contains(query)
                || $0.title.lowercased().contains(query)
                || $0.description.lowercased().contains(query)
        }
    }

    private func pickerRow(
        title: String,
        detail: String,
        selected: Bool,
        provider: CodexProvider? = nil
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if let provider {
                RelayProviderMark(provider: provider, size: 16)
                    .frame(width: 30, height: 30)
                    .background(provider.relayPresentation.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(AppTheme.uiFont(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(detail)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.leading)
            }
            Spacer()
            if selected {
                Image(systemName: "checkmark")
                    .font(AppTheme.uiFont(size: 13, weight: .semibold))
                    .foregroundStyle(provider?.relayPresentation.accent ?? AppTheme.accent)
            }
        }
        .contentShape(Rectangle())
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !isSending
            && !isTranscribing
            && !recorder.isRecording
            && harnessStatus?.isConfirmedUnavailable != true
    }

    private func requestChoice(_ choice: RelayModelChoice) {
        guard threadProvider == nil || choice.executionProvider == threadProvider else { return }
        onPickChoice(choice)
    }

    private func toggleRecording() {
        if recorder.isRecording {
            if let fileURL = recorder.stopRecording() {
                onVoice(fileURL)
            }
            return
        }
        isFocused = false
        Task {
            try? await recorder.startRecording()
        }
    }
}

/// UITextView bridge used only for caret reporting. SwiftUI's iOS 17 text field does not
/// expose the insertion point, but slash discovery must follow the caret when the user
/// types `/` in the middle of an existing draft.
private struct RelayCommandTextEditor: UIViewRepresentable {
    @Binding var text: String
    @Binding var selection: NSRange
    @Binding var isFocused: Bool
    @Binding var height: CGFloat

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.backgroundColor = .clear
        view.textColor = UIColor(AppTheme.textPrimary)
        view.tintColor = UIColor(AppTheme.accent)
        view.font = UIFont(name: "DMSans-9ptRegular", size: 15) ?? .systemFont(ofSize: 15)
        view.textContainerInset = UIEdgeInsets(top: 7, left: 0, bottom: 7, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.keyboardDismissMode = .interactive
        view.adjustsFontForContentSizeCategory = true
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        if view.text != text {
            view.text = text
        }
        let safeLocation = min(selection.location, (view.text as NSString).length)
        let safeSelection = NSRange(location: safeLocation, length: 0)
        if view.selectedRange != safeSelection {
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

        init(parent: RelayCommandTextEditor) {
            self.parent = parent
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            parent.isFocused = true
            parent.selection = textView.selectedRange
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            parent.isFocused = false
            parent.selection = textView.selectedRange
        }

        func textViewDidChange(_ textView: UITextView) {
            parent.text = textView.text
            parent.selection = textView.selectedRange
            updateHeight(for: textView)
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            parent.selection = textView.selectedRange
        }

        func updateHeight(for textView: UITextView) {
            let width = max(textView.bounds.width, 120)
            let fitting = textView.sizeThatFits(
                CGSize(width: width, height: CGFloat.greatestFiniteMagnitude)
            ).height
            let next = min(max(fitting, 36), 120)
            textView.isScrollEnabled = fitting > 120
            guard abs(parent.height - next) > 0.5 else { return }
            DispatchQueue.main.async { [weak self] in
                self?.parent.height = next
            }
        }
    }
}

private struct RelayChatBubble: View {
    let item: RelayConversationItem
    @State private var showCopied = false

    private var showWaitingDots: Bool { item.isStreaming && item.text.isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 44) }

            Group {
                if isUser {
                    messageColumn
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(AppTheme.accent)
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
            }

            if !isUser { Spacer(minLength: 44) }
        }
    }

    private var messageColumn: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                if isUser {
                    RelayCapsLabel(text: "You", color: AppTheme.onEmber.opacity(0.7))
                } else if let provider = item.provider {
                    RelayProviderBadge(
                        provider: provider,
                        detail: item.modelLabel,
                        style: .plain,
                        size: 9
                    )
                } else {
                    RelayCapsLabel(text: "Relay", color: AppTheme.accent)
                }
                if showCopied {
                    RelayCapsLabel(text: "Copied", color: AppTheme.textSecondary, size: 9)
                        .transition(.opacity)
                }
            }

            if showWaitingDots {
                RelayTypingDots(tint: item.provider?.relayPresentation.accent ?? AppTheme.textTertiary)
                    .padding(.vertical, 2)
            } else {
                RelayStreamingContent(
                    text: item.text,
                    isStreaming: item.isStreaming,
                    userAligned: isUser,
                    tint: item.provider?.relayPresentation.accent ?? AppTheme.accent
                )
            }

            if let footer = footerText {
                Text(footer)
                    .font(AppTheme.monoFont(size: 10))
                    .foregroundStyle(isUser ? AppTheme.onEmber.opacity(0.7) : AppTheme.textTertiary)
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

/// Animated three-dot "thinking" indicator shown before the first token arrives.
private struct RelayTypingDots: View {
    var tint: Color = AppTheme.textTertiary
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(tint)
                    .frame(width: 5, height: 5)
                    .scaleEffect(scale(for: i))
                    .opacity(0.5 + 0.5 * scale(for: i))
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                phase = 1.0
            }
        }
    }

    private func scale(for index: Int) -> Double {
        let offset = Double(index) * 0.22
        let v = sin((phase + offset) * .pi)
        return 0.7 + 0.45 * abs(v)
    }
}

/// Renders streamed assistant text with a blinking caret appended while streaming.
private struct RelayStreamingContent: View {
    let text: String
    let isStreaming: Bool
    let userAligned: Bool
    var tint: Color = AppTheme.accent
    @State private var caretOn = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RelayMarkdownText(text: text, userAligned: userAligned)
            if isStreaming {
                Rectangle()
                    .fill(tint)
                    .frame(width: 8, height: 16)
                    .opacity(caretOn ? 1 : 0)
                    .padding(.top, 2)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                            caretOn = false
                        }
                    }
            }
        }
    }
}

// RelayMarkdownText / RelayMarkdownProse / RelayMarkdownTable / RelayCodeBlock moved to
// Rendering/RelayMarkdownViews.swift (revamp I3) so the file viewer shares the chat's
// markdown rendering. Call sites here are unchanged.

private struct RelayJobCard: View {
    let job: CodexJob
    let client: CodexClient
    /// SSE-fed stdout/stderr tail shown while the job is active; polling fills the card
    /// via `job.displayOutput` when the stream is unavailable.
    let liveTail: String?
    let isCancelling: Bool
    let onCancel: () -> Void
    let onFullLog: () -> Void
    let onArtifact: (CodexJobArtifact) -> Void
    let onLoopbackURL: (URL) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                RelayProviderBadge(
                    provider: job.provider,
                    detail: job.model,
                    style: .capsule,
                    size: 9
                )
                RelayStatusPill(status: job.status, startedAt: job.startedAt ?? job.createdAt)
                Spacer()
                // Status lives in the pill only (it used to repeat as plain text here);
                // the trailing slot shows the run duration once the server reports one.
                if let duration = job.durationMs {
                    Text("\(max(1, duration / 1000))s")
                        .font(AppTheme.monoFont(size: 11))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }

            if job.status.isActive {
                if let tail = activeTailText {
                    liveTailView(tail)
                } else {
                    // No output yet but the job is live — show motion so it never looks frozen.
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).tint(job.provider.relayPresentation.accent)
                        Text(job.status == .queued ? "Queued for \(job.provider.relayPresentation.title)…" : "\(job.provider.relayPresentation.title) is working…")
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
            } else if let text = job.displayOutput?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                // Final result: render markdown like chat replies (bold, code, lists).
                RelayMarkdownText(
                    text: relaySharedContract.displayTextHidingLocalPreviewURLs(value: text),
                    userAligned: false,
                    onOpenLoopbackURL: onLoopbackURL
                )

                if let sourceURL = RelayOutputURLPolicy.loopbackURLs(in: text).first {
                    RelayAppPreviewNotice {
                        onLoopbackURL(sourceURL)
                    }
                }
            }

            if !job.artifacts.isEmpty {
                RelayJobArtifacts(
                    artifacts: job.artifacts,
                    client: client,
                    onOpen: onArtifact
                )
            }

            HStack {
                if job.status.isActive {
                    Button(isCancelling ? "Canceling" : "Cancel", role: .destructive, action: onCancel)
                        .foregroundStyle(AppTheme.statusError)
                        .disabled(isCancelling)
                }
                Spacer()
                Button("View full log", action: onFullLog)
                    .foregroundStyle(job.provider.relayPresentation.accent)
            }
            .font(AppTheme.uiFont(size: 13, weight: .medium))
        }
        .padding(14)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(job.status.isActive ? job.provider.relayPresentation.accent.opacity(0.4) : AppTheme.hairline, lineWidth: 1)
        }
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(job.provider.relayPresentation.accent)
                .frame(width: 3)
                .padding(.vertical, 12)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(job.provider.relayPresentation.title) job, \(job.status.label)")
        .onChange(of: job.status.isActive) { _, isActive in
            // Light tap when the job reaches a terminal state while the card is visible.
            if !isActive {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }

    /// While active, prefer the SSE live tail; fall back to poll-fetched progress output.
    private var activeTailText: String? {
        if let tail = liveTail?.trimmedNonEmpty { return tail }
        return job.displayOutput?.trimmedNonEmpty
    }

    /// Autoscrolling mono tail: sticks to the newest output while the stream appends.
    private func liveTailView(_ text: String) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(text)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    Color.clear.frame(height: 1).id(Self.tailAnchor)
                }
            }
            .frame(maxHeight: 180)
            .onAppear { proxy.scrollTo(Self.tailAnchor, anchor: .bottom) }
            .onChange(of: text.count) { _, _ in
                proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
            }
        }
    }

    private static let tailAnchor = "relay-job-tail-anchor"
}

/// Typed outputs returned by relayd. These deliberately sit outside the Markdown
/// renderer: HTML/browser previews stay sandboxed in the authenticated WebView, images
/// are fetched as bytes through the authenticated API client, and source/documents get
/// a native readable surface instead of being squeezed into the transcript card.
private struct RelayJobArtifacts: View {
    let artifacts: [CodexJobArtifact]
    let client: CodexClient
    let onOpen: (CodexJobArtifact) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            RelayCapsLabel(
                text: artifacts.count == 1 ? "Output" : "\(artifacts.count) outputs",
                color: AppTheme.textTertiary,
                size: 9
            )

            ForEach(artifacts) { artifact in
                RelayArtifactCard(artifact: artifact, client: client) {
                    onOpen(artifact)
                }
            }
        }
        .accessibilityIdentifier("relay-job-artifacts")
        // A LazyVStack can otherwise satisfy a tight phone-height proposal by
        // compressing the output stack, which hides rows beneath a large thumbnail.
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RelayArtifactCard: View {
    let artifact: CodexJobArtifact
    let client: CodexClient
    let onOpen: () -> Void

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
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                        .frame(width: 24, height: 24)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(artifact.relayDisplayTitle)
                            .font(AppTheme.uiFont(size: 13, weight: .semibold))
                            .foregroundStyle(AppTheme.textPrimary)
                            .lineLimit(1)
                        Text(artifact.relayMetadataLabel)
                            .font(AppTheme.monoFont(size: 10))
                            .foregroundStyle(AppTheme.textTertiary)
                            .lineLimit(1)
                    }

                    Spacer(minLength: 8)

                    Text(artifact.relayActionLabel)
                        .font(AppTheme.uiFont(size: 11, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(AppTheme.textTertiary)
                }
                .padding(10)
            }
            .background(AppTheme.textPrimary.opacity(0.035), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .stroke(AppTheme.hairline, lineWidth: 0.75)
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
                .background(Color.black.opacity(0.18))
        } else if isLoadingThumbnail {
            ZStack {
                Color.black.opacity(0.14)
                ProgressView().controlSize(.small).tint(AppTheme.accent)
            }
            .frame(height: 140)
        } else if thumbnailFailed {
            ZStack {
                Color.black.opacity(0.14)
                Label("Open image", systemImage: "photo")
                    .font(AppTheme.uiFont(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)
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

private struct RelayArtifactViewer: View {
    let artifact: CodexJobArtifact
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore

    @Environment(\.dismiss) private var dismiss
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
                    AppTheme.canvasGradient.ignoresSafeArea()
                    fetchedContent
                }
                .navigationTitle(artifact.relayDisplayTitle)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Done") { dismiss() }
                            .foregroundStyle(AppTheme.accent)
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
            .preferredColorScheme(.dark)
        }
    }

    private var webURL: URL? {
        client.resolvedArtifactURL(artifact.previewURL)
            ?? client.resolvedArtifactURL(artifact.rawURL)
    }

    @ViewBuilder
    private var fetchedContent: some View {
        if isLoading, data.isEmpty {
            ProgressView().tint(AppTheme.accent)
        } else if let errorMessage, data.isEmpty {
            VStack(spacing: 12) {
                Image(systemName: "exclamationmark.triangle")
                    .font(.system(size: 28, weight: .medium))
                    .foregroundStyle(AppTheme.statusError)
                Text("Could not open this output")
                    .font(AppTheme.uiFont(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(errorMessage)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await load() } }
                    .font(AppTheme.uiFont(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
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
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(text.isEmpty ? AppTheme.textTertiary : AppTheme.textPrimary)
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
                    ProgressView().tint(AppTheme.accent)
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
                    .foregroundStyle(AppTheme.statusWarn)
                Text("Relay received the image bytes but iOS could not decode them.")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .top, spacing: 9) {
                Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.statusWarn)
                VStack(alignment: .leading, spacing: 3) {
                    Text("App preview ready")
                        .font(AppTheme.uiFont(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text("Relay can show the running app from your linked computer.")
                        .font(AppTheme.uiFont(size: 11.5))
                        .foregroundStyle(AppTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            Button(action: onOpen) {
                HStack(spacing: 7) {
                    Image(systemName: "arrow.up.right.square")
                    Text("Show app")
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 10, weight: .bold))
                }
                .font(AppTheme.uiFont(size: 12, weight: .semibold))
                .foregroundStyle(AppTheme.statusWarn)
                .padding(.horizontal, 10)
                .frame(height: 34)
                .background(AppTheme.statusWarn.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-show-app")
        }
        .padding(10)
        .background(AppTheme.statusWarn.opacity(0.07), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(AppTheme.statusWarn.opacity(0.24), lineWidth: 0.75)
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

private struct RelayRemotePreviewRequest: Identifiable {
    let id = UUID()
    let jobID: String
    let sourceURL: URL
}

private struct RelayRemotePreviewViewer: View {
    let request: RelayRemotePreviewRequest
    let client: CodexClient
    @ObservedObject var identityStore: ClientIdentityStore

    @Environment(\.dismiss) private var dismiss
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
                        AppTheme.canvasGradient.ignoresSafeArea()
                        statusContent
                    }
                    .navigationTitle("App preview")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Done") { dismiss() }
                                .foregroundStyle(AppTheme.accent)
                        }
                    }
                }
                .preferredColorScheme(.dark)
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
                ProgressView().tint(AppTheme.accent)
                Text("Connecting to the app…")
                    .font(AppTheme.uiFont(size: 13, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)
            }
        } else {
            VStack(spacing: 12) {
                Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                    .font(.system(size: 30, weight: .semibold))
                    .foregroundStyle(AppTheme.statusWarn)
                Text("Could not open the app preview")
                    .font(AppTheme.uiFont(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(errorMessage ?? "The linked computer did not return a preview.")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
                Button("Try again") { Task { await openPreview() } }
                    .font(AppTheme.uiFont(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
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

private struct RelayStatusPill: View {
    let status: CodexJobStatus
    let startedAt: Date?

    var body: some View {
        if status.isActive, let startedAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                RelayCapsLabel(
                    text: "\(status.label) · \(Self.elapsedLabel(from: startedAt, to: context.date))",
                    color: AppTheme.accentBright
                )
            }
        } else {
            RelayCapsLabel(text: status.label, color: status.relayTint)
        }
    }

    /// Takes the start explicitly rather than re-unwrapping the property: the
    /// `if let` above had already proved it non-nil, so the second `guard let`
    /// was dead, and the binding it discarded was the compiler's "immutable
    /// value 'startedAt' was never used" warning.
    private static func elapsedLabel(from startedAt: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}

private extension CodexJobStatus {
    var relayTint: Color {
        switch self {
        case .queued, .running, .canceling:
            return AppTheme.accentBright
        case .waitingForApproval:
            return AppTheme.statusWarn
        case .succeeded:
            return AppTheme.textSecondary
        case .failed:
            return AppTheme.statusError
        case .canceled, .timeout, .unknown:
            return AppTheme.textTertiary
        }
    }
}

private struct RelayThreadDrawer: View {
    @ObservedObject var viewModel: RelayChatViewModel
    var onContinueHandoff: (RelayHandoffCard) -> Void = { _ in }
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        viewModel.startNewConversation()
                        dismiss()
                    } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                            .foregroundStyle(AppTheme.accent)
                    }
                    .listRowBackground(Color.clear)
                }

                handoffSection

                if viewModel.historyItems.isEmpty {
                    Text("No conversations or invocations in this folder yet.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                        .listRowBackground(AppTheme.bgCanvas)
                }

                // Exact-folder conversations plus invocations that do not have a session yet.
                Section("This folder") {
                    ForEach(viewModel.historyItems) { item in
                        historyRow(item)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if case .thread(let thread) = item.source {
                                    Button(role: .destructive) {
                                        Task { await viewModel.delete(thread) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            }
                    }
                }

                macSessionSection
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("Threads")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                await viewModel.refreshThreads()
                await viewModel.refreshHandoffs()
            }
            .preferredColorScheme(.dark)
        }
    }

    /// Sessions handed over from a Mac. Above this folder's history because a
    /// handoff is the thing the user was just pushed about.
    @ViewBuilder private var handoffSection: some View {
        if !viewModel.handoffs.isEmpty {
            Section {
                ForEach(viewModel.handoffs) { card in
                    RelayHandoffCardView(
                        card: card,
                        manifest: viewModel.handoffManifests[card.id],
                        isContinuing: viewModel.continuingHandoffIDs.contains(card.id),
                        onContinue: {
                            onContinueHandoff(card)
                        }
                    )
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 6, leading: 8, bottom: 6, trailing: 8))
                }
            } header: {
                Text("Continue from your computer")
            } footer: {
                Text("These are Codex or Claude Code sessions sent from your linked computer. Continue resumes the same work on your Relay machine.")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textFaint)
            }
        }
    }

    /// The Mac's own session index: browsable, metadata only, with the honest
    /// affordances — start fresh here, or run `relay handoff` over there.
    @ViewBuilder private var macSessionSection: some View {
        if let index = viewModel.macSessions, !index.sessions.isEmpty {
            Section {
                ForEach(index.sessions) { session in
                    RelayMacSessionRow(session: session, onStartFresh: {
                        viewModel.startFresh(from: session)
                        dismiss()
                    })
                    .listRowBackground(Color.clear)
                }
            } header: {
                HStack(spacing: 8) {
                    Text(index.sectionTitle)
                    Spacer()
                    if let updatedAt = index.updatedAtDate {
                        Text(RelayRelativeTime.string(for: updatedAt))
                            .font(AppTheme.monoFont(size: 10))
                            .foregroundStyle(AppTheme.textFaint)
                    }
                }
            } footer: {
                Text("Run relay handoff there to continue one of these exactly.")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textFaint)
            }
        }
    }

    private func historyRow(_ item: CodexThreadFeedItem) -> some View {
        Button {
            Task {
                await viewModel.openHistoryItem(item)
                dismiss()
            }
        } label: {
            HStack(alignment: .top, spacing: 10) {
                RelayProviderMark(provider: historyProvider(item), size: 17)
                    .frame(width: 34, height: 34)
                    .background(historyProvider(item).relayPresentation.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 9))
                VStack(alignment: .leading, spacing: 5) {
                    HStack(spacing: 6) {
                        RelayProviderBadge(provider: historyProvider(item), style: .plain, size: 8)
                        Spacer()
                        if item.isActive {
                            RelayCapsLabel(text: "Active", color: AppTheme.accentBright, size: 9)
                        }
                        RelayCapsLabel(text: historyModeLabel(item), color: historyProvider(item).relayPresentation.accent, size: 9)
                    }
                    Text(item.title)
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    Text(item.preview)
                        .font(.caption)
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineLimit(2)
                    Text(historyMetadata(item))
                        .font(AppTheme.monoFont(size: 10))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }
            .overlay(alignment: .leading) {
                Rectangle()
                    .fill(historyProvider(item).relayPresentation.accent.opacity(0.75))
                    .frame(width: 2)
                    .offset(x: -8)
            }
        }
        .listRowBackground(Color.clear)
    }

    private func historyModeLabel(_ item: CodexThreadFeedItem) -> String {
        switch item.source {
        case .thread(let thread):
            return thread.mode.label
        case .pendingJob:
            return "Task"
        }
    }

    private func historyMetadata(_ item: CodexThreadFeedItem) -> String {
        switch item.source {
        case .thread(let thread):
            if thread.mode == .chat {
                return "\(item.workspaceLabel) · conversation"
            }
            let count = thread.jobCount
            let invocationText = count == 1 ? "1 invocation" : "\(count) invocations"
            return "\(item.workspaceLabel) · \(invocationText)"
        case .pendingJob(let job):
            return "\(item.workspaceLabel) · invocation · \(job.status.label)"
        }
    }

    private func historyProvider(_ item: CodexThreadFeedItem) -> CodexProvider {
        switch item.source {
        case .thread(let thread): return thread.provider
        case .pendingJob(let job): return job.provider
        }
    }
}

private struct RelayStatusBanner: View {
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

private struct RelayEmptyConversation: View {
    let choice: RelayModelChoice?

    private var isTask: Bool { choice?.mode == .task }
    private var provider: CodexProvider { choice?.executionProvider ?? .codex }

    var body: some View {
        VStack(spacing: 14) {
            RelayProviderMark(provider: provider, size: 30)
                .frame(width: 54, height: 54)
                .background(provider.relayPresentation.accent.opacity(0.1), in: RoundedRectangle(cornerRadius: 16))
                .overlay {
                    RoundedRectangle(cornerRadius: 16)
                        .stroke(provider.relayPresentation.accent.opacity(0.25), lineWidth: 1)
                }

            VStack(spacing: 6) {
                Text(isTask ? "Run a task" : "Start a conversation")
                    .font(AppTheme.serifFont(size: 24))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(isTask
                     ? "Queue an agent job in this folder."
                     : "Stream a reply scoped to this folder.")
                    .font(AppTheme.uiFont(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }

            if let choice {
                RelayProviderBadge(
                    provider: provider,
                    detail: "\(choice.shortModelLabel) · \(choice.mode.label)",
                    style: .capsule,
                    size: 10
                )
            }
        }
        .frame(maxWidth: .infinity, minHeight: 320, alignment: .center)
        .padding(.horizontal, 24)
        .padding(.bottom, 18)
    }
}

private struct RelayFullLogRequest: Identifiable {
    var id: String { job.id }
    let job: CodexJob
}

private struct RelayAIDataConsentRequest: Identifiable {
    let provider: CodexProvider
    var id: CodexProvider { provider }
}

private struct RelayAIDataConsentSheet: View {
    let provider: CodexProvider
    let onAllow: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    RelayProviderMark(provider: provider, size: 32)
                        .frame(width: 58, height: 58)
                        .background(provider.relayPresentation.accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 16))

                    VStack(alignment: .leading, spacing: 10) {
                        Text("Share work content with \(provider.aiDataRecipient)?")
                            .font(AppTheme.serifFont(size: 28))
                            .foregroundStyle(AppTheme.textPrimary)

                        Text(provider.aiDataDisclosure)
                            .font(AppTheme.uiFont(size: 15))
                            .foregroundStyle(AppTheme.textSecondary)
                            .lineSpacing(4)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        disclosureRow("01", "Your prompt and conversation history")
                        disclosureRow("02", "Workspace files, attachments, and command output the agent needs")
                        disclosureRow("03", "Used by \(provider.aiDataRecipient) to provide the requested AI service")
                    }

                    Text("Relay does not share your Relay name, email, password, device identifiers, or Apple payment and subscription details with this AI provider. You can decline and nothing will be sent.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineSpacing(3)

                    Link("Read Privacy Policy", destination: URL(string: "https://app.openrelay.sh/privacy")!)
                        .font(AppTheme.uiFont(size: 14, weight: .medium))
                        .foregroundStyle(AppTheme.accent)

                    VStack(spacing: 12) {
                        Button("Allow & Send", action: onAllow)
                            .buttonStyle(RelayPrimaryButtonStyle())
                            .accessibilityIdentifier("relay-ai-data-consent-allow")

                        Button("Not Now", action: onCancel)
                            .buttonStyle(RelayOutlineButtonStyle())
                            .accessibilityIdentifier("relay-ai-data-consent-cancel")
                    }
                    .padding(.top, 4)
                }
                .padding(24)
            }
            .background(AppTheme.bgCanvas)
            .navigationTitle("AI Data Sharing")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .presentationDetents([.large])
    }

    private func disclosureRow(_ index: String, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 11) {
            RelayCapsLabel(text: index, color: provider.relayPresentation.accent, size: 9)
            Text(text)
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textPrimary)
        }
    }
}

private struct RelayFullLogSheet: View {
    let job: CodexJob
    let load: () async -> String
    @Environment(\.dismiss) private var dismiss
    @State private var text: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    RelayProviderBadge(
                        provider: job.provider,
                        detail: job.model,
                        style: .capsule,
                        size: 10
                    )

                    if let receipt = job.execution {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("EXECUTION RECEIPT")
                                .font(AppTheme.monoFont(size: 10))
                                .foregroundStyle(AppTheme.textTertiary)
                            Text(receipt.summaryLines.joined(separator: "\n"))
                                .font(AppTheme.monoFont(size: 11))
                                .foregroundStyle(AppTheme.textSecondary)
                                .textSelection(.enabled)
                        }
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.white.opacity(0.04))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    if let text {
                        Text(text.isEmpty ? "No log output." : text)
                            .font(AppTheme.monoFont(size: 12))
                            .foregroundStyle(AppTheme.textPrimary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        ProgressView("Loading \(job.provider.relayPresentation.title) log…")
                            .tint(job.provider.relayPresentation.accent)
                            .foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity, minHeight: 260)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
            }
            .background(AppTheme.bgCanvas)
            .navigationTitle("\(job.provider.relayPresentation.title) log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .preferredColorScheme(.dark)
        }
        .task(id: job.id) {
            guard text == nil else { return }
            text = await load()
        }
    }
}

@MainActor
private final class RelayPromptAudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    func startRecording() async throws {
        guard !isRecording else { return }
        guard await requestPermission() else { throw RecordingError.microphoneDenied }
        let session = AVAudioSession.sharedInstance()
        let configuration = CodexPromptAudioRecordingConfiguration.devicePromptDefaults
        try session.setCategory(configuration.category, mode: configuration.mode, options: configuration.options)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-chat-\(UUID().uuidString)")
            .appendingPathExtension("wav")
        let recorder = try AVAudioRecorder(url: url, settings: configuration.settings)
        recorder.delegate = self
        recorder.prepareToRecord()
        guard recorder.record() else { throw RecordingError.startFailed }
        self.recorder = recorder
        recordingURL = url
        isRecording = true
    }

    func stopRecording() -> URL? {
        guard isRecording else { return nil }
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return recordingURL
    }

    func deleteRecording(at url: URL) {
        try? FileManager.default.removeItem(at: url)
        if recordingURL == url {
            recordingURL = nil
        }
    }

    private func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    private enum RecordingError: LocalizedError {
        case microphoneDenied
        case startFailed

        var errorDescription: String? {
            switch self {
            case .microphoneDenied:
                return "Microphone access is not enabled for Relay."
            case .startFailed:
                return "Could not start microphone recording."
            }
        }
    }
}
