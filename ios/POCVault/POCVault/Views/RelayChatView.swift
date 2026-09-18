import AVFoundation
import SwiftUI
import UIKit

private enum RelayChatStyle {
    static let secondary = AppTheme.textPrimary.opacity(0.72)
    static let surface = AppTheme.textPrimary.opacity(0.06)
    static let bodyFont = Font.custom("DMSans-9ptRegular", size: 16, relativeTo: .body)
    static let labelFont = Font.custom("DMSans-9ptRegular", size: 13, relativeTo: .subheadline)
}

struct RelayChatView: View {
    @Environment(\.scenePhase) private var scenePhase
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
    /// Source-job inspection never replays its historical request to show an app.
    /// The visible Show app and output actions remain available on demand.
    var automaticallyOpensPreviews = true
    @State private var showingThreads = false
    @State private var threadsPreferLarge = false
    @State private var fullLogRequest: RelayFullLogRequest?
    @State private var artifactRequest: CodexJobArtifact?
    @State private var remotePreviewRequest: RelayRemotePreviewRequest?
    @State private var automaticallyOpenedPreviews: Set<String> = []
    @State private var modelPickerRequest = 0
    @State private var didHandleInitialProviderPicker = false
    @State private var aiDataConsentRequest: RelayAIDataConsentRequest?
    @State private var automaticallyPresentedConsentProviders: Set<CodexProvider> = []
    @State private var providerLoginRequest: CodexProvider?

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()

                VStack(spacing: 0) {
                    topBar
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
                        codexSandbox: viewModel.codexSandbox,
                        isSending: viewModel.isSending,
                        isStreaming: viewModel.isStreaming,
                        onPickChoice: { viewModel.selectChoice($0) },
                        onPickEffort: { viewModel.selectEffort($0) },
                        onToggleSkill: { viewModel.toggleSkill($0) },
                        onPickClaudePermission: { viewModel.claudePermissionMode = $0 },
                        onPickCodexApproval: { viewModel.codexApprovalPolicy = $0 },
                        onPickCodexSandbox: { viewModel.codexSandbox = $0 },
                        onNewConversation: { viewModel.startNewConversation() },
                        onSend: {
                            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                            requestPromptSend()
                        },
                        onStop: {
                            UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                            viewModel.stopStreaming()
                        },
                        onConnectProvider: { provider in
                            providerLoginRequest = provider
                        }
                    )
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
            .task {
                honorThreadsRequest()
                await viewModel.bootstrap()
                presentAIDataConsentIfNeeded()
                if presentsProviderPickerOnAppear, !didHandleInitialProviderPicker {
                    didHandleInitialProviderPicker = true
                    modelPickerRequest += 1
                }
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    Task { await viewModel.refreshModels() }
                }
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    do { try await Task.sleep(for: .seconds(60)) }
                    catch { return }
                    await viewModel.refreshModels()
                }
            }
            .onChange(of: threadsRequest.wrappedValue) { _, _ in
                honorThreadsRequest()
            }
            .onChange(of: viewModel.selectedChoice?.id) { _, _ in
                presentAIDataConsentIfNeeded()
            }
            .onChange(of: automaticPreviewCandidate?.key) { _, _ in
                openRequestedPreviewIfNeeded()
            }
            .sheet(item: $providerLoginRequest, onDismiss: {
                // The machine's login state changed (or the user backed out);
                // either way the composer notice must reflect reality.
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
                        Task { await continueHandoff(card) }
                    }
                )
                    .presentationDetents(threadsPreferLarge ? [.large] : [.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $fullLogRequest) { request in
                RelayFullLogSheet(jobID: request.jobID, viewModel: viewModel)
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
                            Task { await viewModel.sendCurrentPrompt() }
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
        HStack(spacing: 4) {
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "chevron.down")
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(RelayChatStyle.secondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close chat")
            }

            Button {
                threadsPreferLarge = false
                showingThreads = true
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(viewModel.folderDisplayName)
                        .font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .headline).weight(.semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 5) {
                        Text("Threads")
                        Text("\(viewModel.historyItems.count)")
                        if !viewModel.handoffs.isEmpty {
                            Text("· \(viewModel.handoffs.count) handed off")
                                .foregroundStyle(AppTheme.accentBright)
                        }
                        Image(systemName: "chevron.down")
                            .font(.system(size: 9, weight: .semibold))
                    }
                    .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption))
                    .foregroundStyle(RelayChatStyle.secondary)
                    .lineLimit(1)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(viewModel.folderDisplayName), Threads, \(viewModel.historyItems.count) conversations and invocations")
            .accessibilityIdentifier("relay-threads")

            Button(action: startNewConversation) {
                Image(systemName: "square.and.pencil")
                    .font(AppTheme.uiFont(size: 16, weight: .medium))
                    .foregroundStyle(RelayChatStyle.secondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New conversation")

            if let provider = viewModel.selectedChoice?.model.provider {
                Menu {
                    if let path = viewModel.folderPathLabel {
                        Section("Folder") {
                            Text(path)
                            Button("Copy folder path", systemImage: "doc.on.doc") {
                                UIPasteboard.general.string = path
                            }
                        }
                    }
                    Button("AI data sharing") {
                        presentAIDataConsent(for: provider, purpose: .review)
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(RelayChatStyle.secondary)
                        .frame(width: 44, height: 44)
                }
                .accessibilityIdentifier("relay-chat-overflow")
                .accessibilityLabel("Chat options")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
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
            presentAIDataConsent(for: provider, purpose: .sendPrompt)
            return
        }
        Task { await viewModel.sendCurrentPrompt() }
    }

    private func presentAIDataConsentIfNeeded() {
        guard let provider = viewModel.selectedChoice?.model.provider,
              !RelayAIDataConsentStore.hasConsent(for: provider),
              !automaticallyPresentedConsentProviders.contains(provider),
              aiDataConsentRequest == nil else { return }
        automaticallyPresentedConsentProviders.insert(provider)
        presentAIDataConsent(for: provider, purpose: .review)
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
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 24) {
                    if let error = viewModel.errorMessage {
                        RelayStatusBanner(text: error)
                    }

                    if viewModel.isLoadingThreadDetail {
                        ProgressView("Loading conversation…")
                            .tint(AppTheme.accent)
                            .foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity, minHeight: 120)
                    }

                    if viewModel.messages.isEmpty && !viewModel.isSending && !viewModel.isLoadingThreadDetail {
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
                    // An approval belongs where the run stalled, not in another tab.
                    // It sits at the tail because that is where the transcript stops
                    // until it is answered.
                    ForEach(viewModel.pendingApprovals) { approval in
                        RelayApprovalCard(approval: approval) { decision in
                            Task { await viewModel.decideApproval(approval, decision) }
                        }
                        .id(approval.id)
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .accessibilityIdentifier("relay-chat-approval")
                    }

                    Color.clear.frame(height: 1).id(Self.bottomAnchor)
                }
                .padding(.horizontal, 18)
                .padding(.top, 22)
                .padding(.bottom, 20)
            }
            .refreshable {
                await viewModel.refreshThreads()
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollBounceBehavior(.basedOnSize)
            .animation(.spring(response: 0.36, dampingFraction: 0.82), value: viewModel.messages.count)
            .onChange(of: viewModel.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: viewModel.pendingApprovals.count) { _, _ in scrollToBottom(proxy) }
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
        static let horizontalInset: CGFloat = 12
        static let controlHeight: CGFloat = 44
        static let actionSize: CGFloat = 44
        static let rowSpacing: CGFloat = 8
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
    let codexSandbox: RelayCodexSandbox
    let isSending: Bool
    let isStreaming: Bool
    let onPickChoice: (RelayModelChoice) -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onToggleSkill: (CodexSkillDescriptor) -> Void
    let onPickClaudePermission: (RelayClaudePermissionMode) -> Void
    let onPickCodexApproval: (RelayCodexApprovalPolicy) -> Void
    let onPickCodexSandbox: (RelayCodexSandbox) -> Void
    let onNewConversation: () -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    /// Direct provider sign-in from this iPhone; nil hides the affordance.
    var onConnectProvider: ((CodexProvider) -> Void)? = nil
    @State private var isFocused = false
    @State private var editorSelection = NSRange(location: 0, length: 0)
    @State private var editorHeight: CGFloat = 36
    @State private var showingRunSettings = false
    @State private var showingModelPicker = false
    @State private var showingPermissionPicker = false
    @State private var showingSkillPicker = false
    @State private var skillSearch = ""
    @StateObject private var dictation = RelayStreamingTranscriber()
    /// Whatever the user had already typed when dictation started. Live transcript
    /// is appended to this rather than replacing the field, so starting to dictate
    /// mid-draft never eats the draft.
    @State private var dictationPrefix = ""
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

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
            HStack(spacing: 6) {
                if let provider = selectedChoice?.executionProvider {
                    RelayProviderMark(provider: provider, size: 14)
                }
                Text(selectedChoice?.shortModelLabel ?? "Choose model")
                    .font(RelayChatStyle.labelFont.weight(.medium))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(RelayChatStyle.secondary)
            }
            .foregroundStyle(AppTheme.textPrimary)
            .frame(maxWidth: .infinity, minHeight: Layout.controlHeight, alignment: .leading)
            .contentShape(Rectangle())
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

    /// Live dictation state. Status is a small-caps word and a ticking duration —
    /// never a coloured dot (design spec rule 5) — and liveness is carried by a rule
    /// that answers to the microphone rather than by a spinner that answers to nothing.
    @ViewBuilder private var dictationBar: some View {
        if dictation.isActive {
            VStack(spacing: 5) {
                HStack(spacing: 8) {
                    RelayCapsLabel(
                        text: dictation.phase == .finalizing ? "Transcribing" : "Listening",
                        color: AppTheme.accent
                    )
                    Text(RelayStreamingTranscriber.durationLabel(dictation.elapsed))
                        .font(AppTheme.monoFont(size: 11))
                        .monospacedDigit()
                        .foregroundStyle(RelayChatStyle.secondary)
                    Spacer(minLength: 0)
                }
                voiceRule
            }
            .padding(.horizontal, 6)
            .padding(.bottom, 8)
            .transition(.opacity)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(
                dictation.phase == .finalizing
                    ? "Transcribing"
                    : "Listening, \(RelayStreamingTranscriber.durationLabel(dictation.elapsed))"
            )
        } else if case .failed(let message) = dictation.phase {
            Text(message)
                .font(RelayChatStyle.labelFont)
                .foregroundStyle(AppTheme.statusWarn)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 6)
                .padding(.bottom, 8)
                .transition(.opacity)
                .accessibilityIdentifier("relay-dictation-error")
        }
    }

    /// Full-width ember hairline whose opacity tracks loudness. Deliberately not a
    /// left-to-right fill: this is not progress, and a growing bar would imply an
    /// end point that dictation does not have.
    private var voiceRule: some View {
        Rectangle()
            .fill(AppTheme.accent)
            .frame(height: 1)
            .opacity(reduceMotion ? 0.55 : 0.2 + 0.8 * dictation.level)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: dictation.level)
    }

    /// Frequent controls fit in the composer. Less frequent choices live in a sheet,
    /// so neither narrow screens nor long policy labels need a scrolling chip rail.
    private var controlBar: some View {
        HStack(alignment: .center, spacing: 2) {
            modelPickerMenu
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                isFocused = false
                showingRunSettings = true
            } label: {
                Image(systemName: "slider.horizontal.3")
                    .font(AppTheme.uiFont(size: 17, weight: .medium))
                    .foregroundStyle(RelayChatStyle.secondary)
                    .frame(width: Layout.actionSize, height: Layout.actionSize)
                    .overlay(alignment: .topTrailing) {
                        if !selectedSkillIDs.isEmpty {
                            Text("\(selectedSkillIDs.count)")
                                .font(AppTheme.uiFont(size: 10, weight: .semibold))
                                .foregroundStyle(AppTheme.accent)
                                .padding(2)
                        }
                    }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-run-settings")
            .accessibilityLabel("Run settings, \(selectedSkillIDs.count) skills selected")

            // Hidden rather than disabled when the build has no STT credentials:
            // a control that can only ever fail is worse than no control.
            if AppConfiguration.supportsDictation {
                Button(action: toggleDictation) {
                    Image(systemName: dictation.isActive ? "stop.fill" : "mic")
                        .font(AppTheme.uiFont(size: 18, weight: .medium))
                        .foregroundStyle(dictation.isActive ? AppTheme.accent : RelayChatStyle.secondary)
                        .frame(width: Layout.actionSize, height: Layout.actionSize)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isSending || dictation.phase == .finalizing)
                .accessibilityIdentifier("relay-dictate")
                .accessibilityLabel(dictation.isActive ? "Stop dictation" : "Dictate prompt")
            }

            Button {
                isFocused = false
                if isStreaming { onStop() } else { onSend() }
            } label: {
                ZStack {
                    Circle()
                        .fill(isStreaming || canSend ? AppTheme.accent : RelayChatStyle.surface)
                        .frame(width: 34, height: 34)
                    if isStreaming {
                        RoundedRectangle(cornerRadius: 3)
                            .fill(AppTheme.onEmber)
                            .frame(width: 11, height: 11)
                    } else {
                        Image(systemName: "arrow.up")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(canSend ? AppTheme.onEmber : RelayChatStyle.secondary)
                    }
                }
                .frame(width: Layout.actionSize, height: Layout.actionSize)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!isStreaming && !canSend)
            .accessibilityIdentifier(isStreaming ? "relay-stop" : "relay-send")
            .accessibilityLabel(isStreaming ? "Stop" : harnessStatus?.isConfirmedUnavailable == true ? "Provider connection required" : "Send")
        }
        .frame(minHeight: Layout.controlHeight)
    }

    var body: some View {
        VStack(spacing: Layout.rowSpacing) {
            if slashContext != nil {
                slashPalette
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            if let harnessStatus, harnessStatus.isConfirmedUnavailable {
                HStack(alignment: .center, spacing: 8) {
                    Text(harnessStatus.actionMessage ?? "This provider is not ready on the linked computer.")
                        .font(RelayChatStyle.labelFont)
                        .foregroundStyle(AppTheme.statusWarn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let onConnectProvider, harnessStatus.supportsDirectLogin, harnessStatus.loggedIn == false {
                        Button("Connect") { onConnectProvider(harnessStatus.provider) }
                            .font(RelayChatStyle.labelFont.weight(.semibold))
                            .foregroundStyle(AppTheme.accent)
                            .frame(minWidth: 44, minHeight: 44)
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("relay-provider-connect")
                    }
                }
                .padding(.horizontal, 6)
                .accessibilityIdentifier("relay-provider-readiness")
            }

            VStack(spacing: 0) {
                dictationBar

                ZStack(alignment: .leading) {
                    if text.isEmpty {
                        Text("Message…")
                            .font(RelayChatStyle.bodyFont)
                            .foregroundStyle(RelayChatStyle.secondary)
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
                .padding(.horizontal, 6)

                controlBar
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 4)
            .background {
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(RelayChatStyle.surface)
                    .overlay {
                        RoundedRectangle(cornerRadius: 20, style: .continuous)
                            .stroke(AppTheme.hairlineStrong, lineWidth: 1)
                    }
            }
        }
        .padding(.horizontal, Layout.horizontalInset)
        .padding(.top, 10)
        .padding(.bottom, Layout.bottomPadding)
        .background(AppTheme.bgCanvas)
        .overlay(alignment: .top) {
            Rectangle().fill(AppTheme.hairline).frame(height: 1)
        }
        .animation(.easeOut(duration: 0.16), value: slashContext)
        .animation(.easeOut(duration: 0.18), value: dictation.isActive)
        .onChange(of: dictation.transcript) { _, transcript in
            applyDictation(transcript)
        }
        // A dismissed composer must not leave the microphone hot or a socket open.
        .onDisappear { dictation.cancel() }
        .sheet(isPresented: $showingRunSettings) { runSettingsSheet }
        .sheet(isPresented: $showingModelPicker) { modelPickerSheet }
        .sheet(isPresented: $showingPermissionPicker) { permissionPickerSheet }
        .sheet(isPresented: $showingSkillPicker) { skillPickerSheet }
        .onChange(of: modelPickerRequest) { _, _ in
            showingModelPicker = true
        }
    }

    private var runSettingsSheet: some View {
        NavigationStack {
            List {
                if !efforts.isEmpty {
                    Section("Reasoning") {
                        Picker("Effort", selection: Binding(
                            get: { selectedEffort ?? efforts[0] },
                            set: onPickEffort
                        )) {
                            ForEach(efforts) { effort in
                                Text(effort.label).tag(effort)
                            }
                        }
                        .accessibilityIdentifier("relay-effort-chip")
                    }
                }
                if provider?.hasTaskPermissionControls == true {
                    Section("Permissions") {
                        if provider == .claude {
                            Picker("Permission mode", selection: Binding(get: { claudePermissionMode }, set: onPickClaudePermission)) {
                                ForEach(RelayClaudePermissionMode.allCases) { mode in
                                    Text(mode.label).tag(mode)
                                }
                            }
                            Text(claudePermissionMode.detail)
                                .font(RelayChatStyle.labelFont)
                                .foregroundStyle(RelayChatStyle.secondary)
                        } else {
                            Picker("File access", selection: Binding(get: { codexSandbox }, set: onPickCodexSandbox)) {
                                ForEach(RelayCodexSandbox.allCases) { sandbox in
                                    Text(sandbox.label).tag(sandbox)
                                }
                            }
                            .accessibilityIdentifier("relay-permission-chip")
                            Picker("Approvals", selection: Binding(get: { codexApprovalPolicy }, set: onPickCodexApproval)) {
                                ForEach(RelayCodexApprovalPolicy.allCases) { policy in
                                    Text(policy.label).tag(policy)
                                }
                            }
                            Text(codexSandbox.detail)
                                .font(RelayChatStyle.labelFont)
                                .foregroundStyle(codexSandbox.isUnsandboxed ? AppTheme.statusWarn : RelayChatStyle.secondary)
                            Text(codexApprovalPolicy.detail)
                                .font(RelayChatStyle.labelFont)
                                .foregroundStyle(RelayChatStyle.secondary)
                        }
                    }
                }
                if provider != nil {
                    Section {
                        NavigationLink {
                            skillPickerContent
                        } label: {
                            HStack {
                                Text("Skills")
                                Spacer()
                                Text(selectedSkillIDs.isEmpty ? "None selected" : "\(selectedSkillIDs.count) selected")
                                    .foregroundStyle(RelayChatStyle.secondary)
                            }
                        }
                        .accessibilityIdentifier("relay-skill-chip")
                    }
                }
                Section {
                    Text("Changes apply to your next message.")
                        .font(RelayChatStyle.labelFont)
                        .foregroundStyle(RelayChatStyle.secondary)
                    if threadProvider != nil {
                        Text("This conversation stays with its original provider.")
                            .font(RelayChatStyle.labelFont)
                            .foregroundStyle(RelayChatStyle.secondary)
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("Run settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { showingRunSettings = false }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .preferredColorScheme(.dark)
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
                    ForEach(visibleSections.agents) { harness in
                        Section(harness.title) {
                            ForEach(harness.choices) { choice in
                                Button {
                                    requestChoice(choice)
                                    showingModelPicker = false
                                } label: {
                                    pickerRow(
                                        title: choice.shortModelLabel,
                                        detail: choice.isProviderDefault
                                            ? "Uses \(harness.title)'s configured default model"
                                            : "Runs this \(harness.title) session with \(choice.shortModelLabel)",
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
                    Section("What Codex can reach") {
                        ForEach(RelayCodexSandbox.allCases) { level in
                            Button {
                                onPickCodexSandbox(level)
                            } label: {
                                pickerRow(
                                    title: level.label,
                                    detail: level.detail,
                                    selected: level == codexSandbox,
                                    provider: .codex
                                )
                            }
                        }
                        if codexSandbox.isUnsandboxed {
                            Text("Codex will not be stopped from changing anything on this machine, including files outside your work.")
                                .font(AppTheme.uiFont(size: 12))
                                .foregroundStyle(AppTheme.statusWarn)
                        }
                    }

                    Section("When Codex asks") {
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
        NavigationStack { skillPickerContent }
            .preferredColorScheme(.dark)
    }

    private var skillPickerContent: some View {
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
                Button("Done") {
                    showingSkillPicker = false
                    showingRunSettings = false
                }
            }
        }
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
            && !dictation.isActive
            && harnessStatus?.isConfirmedUnavailable != true
    }

    private func requestChoice(_ choice: RelayModelChoice) {
        guard threadProvider == nil || choice.executionProvider == threadProvider else { return }
        onPickChoice(choice)
    }

    private func toggleDictation() {
        if dictation.isActive {
            Task { await dictation.stop() }
            return
        }
        isFocused = false
        // Anchor to the draft as it stands now; live transcript is appended to this
        // so a half-typed message survives someone reaching for the mic.
        dictationPrefix = text
        Task { try? await dictation.start() }
    }

    /// Mirrors live transcript into the field the user is about to send from, so the
    /// words are editable the instant they land rather than after a round trip.
    private func applyDictation(_ transcript: String) {
        let spoken = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !spoken.isEmpty else { return }
        let base = dictationPrefix.trimmingCharacters(in: .whitespacesAndNewlines)
        text = base.isEmpty ? spoken : "\(base)\n\n\(spoken)"
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
        view.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: UIFont(name: "DMSans-9ptRegular", size: 16) ?? .systemFont(ofSize: 16))
        view.textContainerInset = UIEdgeInsets(top: 7, left: 0, bottom: 7, right: 0)
        view.textContainer.lineFragmentPadding = 0
        view.accessibilityLabel = "Message"
        view.accessibilityIdentifier = "relay-message-editor"
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
                        .background(RelayChatStyle.surface)
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

            if !isUser { Spacer(minLength: 0) }
        }
    }

    private var messageColumn: some View {
        VStack(alignment: .leading, spacing: 7) {
            if !isUser || showCopied {
                HStack(spacing: 6) {
                    if !isUser {
                        if let provider = item.provider {
                            RelayProviderMark(provider: provider, size: 14)
                            Text(provider.relayPresentation.title)
                                .font(RelayChatStyle.labelFont.weight(.medium))
                                .foregroundStyle(RelayChatStyle.secondary)
                        } else {
                            Text("Relay").font(RelayChatStyle.labelFont)
                        }
                    }
                    if showCopied {
                        RelayCapsLabel(text: "Copied", color: AppTheme.textSecondary, size: 9)
                            .transition(.opacity)
                    }
                }

            }

            if showWaitingDots {
                RelayTypingDots(tint: item.provider?.relayPresentation.accent ?? AppTheme.textTertiary)
                    .padding(.vertical, 2)
            } else {
                RelayStreamingContent(
                    text: item.text,
                    isStreaming: item.isStreaming,
                    tint: item.provider?.relayPresentation.accent ?? AppTheme.accent
                )
            }

            if let footer = footerText {
                Text(footer)
                    .font(AppTheme.monoFont(size: 10))
                    .foregroundStyle(RelayChatStyle.secondary)
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
    var tint: Color = AppTheme.accent
    @State private var caretOn = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RelayMarkdownText(text: text, userAligned: false, bodyFont: RelayChatStyle.bodyFont)
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
    /// Live output falls back to the poll-fetched snapshot when SSE is unavailable.
    let liveTail: String?
    let isCancelling: Bool
    let onCancel: () -> Void
    let onFullLog: () -> Void
    let onArtifact: (CodexJobArtifact) -> Void
    let onLoopbackURL: (URL) -> Void
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
        // An unstructured stdout tail could be terminal output. Only treat leading
        // text as agent prose when the log also supplies a structured step boundary.
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
        case .succeeded: return "Run complete"
        case .failed: return "Run failed"
        case .timeout: return "Run timed out"
        case .canceled: return "Run stopped"
        default:
            // Long shell invocations belong in the disclosure, not the summary.
            if let latestCommand, latestCommand.count <= 80 { return latestCommand }
            return "Working on your request"
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 7) {
                RelayProviderMark(provider: job.provider, size: 14)
                Text(job.provider.relayPresentation.title)
                    .font(RelayChatStyle.labelFont.weight(.medium))
                    .foregroundStyle(RelayChatStyle.secondary)
            }

            if job.status.isActive, let prose = leadingProse {
                Text(CodexInlineMarkdown.attributed(prose))
                    .font(RelayChatStyle.bodyFont)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineSpacing(4)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !job.status.isActive,
               let text = job.displayOutput?.trimmedNonEmpty {
                RelayMarkdownText(
                    text: relaySharedContract.displayTextHidingLocalPreviewURLs(value: text),
                    userAligned: false,
                    onOpenLoopbackURL: onLoopbackURL,
                    bodyFont: RelayChatStyle.bodyFont
                )
                if let sourceURL = RelayOutputURLPolicy.loopbackURLs(in: text).first {
                    RelayAppPreviewNotice { onLoopbackURL(sourceURL) }
                }
            }

            if !job.artifacts.isEmpty {
                RelayJobArtifacts(artifacts: job.artifacts, client: client, onOpen: onArtifact)
            }

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    activityExpanded.toggle()
                } label: {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(activityTitle)
                                .font(RelayChatStyle.labelFont.weight(.medium))
                                .foregroundStyle(AppTheme.textPrimary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            RelayChatRunStatus(job: job)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        Image(systemName: activityExpanded ? "chevron.up" : "chevron.down")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(RelayChatStyle.secondary)
                    }
                    .padding(.vertical, 14)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-job-activity")
                .accessibilityLabel("\(activityTitle), \(job.status.label)")
                .accessibilityValue(activityExpanded ? "Expanded" : "Collapsed")
                .accessibilityHint("Shows recent activity. The full log contains all output.")

                if activityExpanded {
                    if let model = job.model?.trimmedNonEmpty {
                        Text(model)
                            .font(RelayChatStyle.labelFont)
                            .foregroundStyle(RelayChatStyle.secondary)
                            .padding(.bottom, 12)
                    }
                    if job.status.isActive {
                        ForEach(activityBlocks) { block in
                            activityBlock(block)
                        }
                        if activityBlocks.isEmpty {
                            Text("No output yet.")
                                .font(RelayChatStyle.labelFont)
                                .foregroundStyle(RelayChatStyle.secondary)
                                .padding(.bottom, 12)
                        }
                    } else {
                        Text("Open the full log for commands, output, and run details.")
                            .font(RelayChatStyle.labelFont)
                            .foregroundStyle(RelayChatStyle.secondary)
                            .padding(.bottom, 12)
                    }
                }

                // Warnings stay discoverable even while the activity is collapsed.
                if job.status.isActive, !activityExpanded {
                    ForEach(activityBlocks) { block in
                        if case .warning(let message) = block.kind {
                            Text("Warning: \(message)")
                                .font(RelayChatStyle.labelFont)
                                .foregroundStyle(AppTheme.statusWarn)
                                .lineLimit(2)
                                .padding(.bottom, 12)
                        }
                    }
                }

                Rectangle().fill(AppTheme.hairline).frame(height: 1)
                HStack {
                    Button("View full log", action: onFullLog)
                        .frame(minHeight: 44)
                    Spacer()
                    if job.status.isActive {
                        Button(isCancelling ? "Stopping…" : "Stop", action: onCancel)
                            .frame(minWidth: 44, minHeight: 44)
                            .disabled(isCancelling || job.status == .canceling)
                            .accessibilityLabel("Stop run")
                    }
                }
                .font(RelayChatStyle.labelFont)
                .foregroundStyle(RelayChatStyle.secondary)
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 14)
            .background(RelayChatStyle.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
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
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(RelayChatStyle.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.bottom, 12)
            } label: {
                VStack(alignment: .leading, spacing: 4) {
                    Text(command)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(2)
                    if let exitCode {
                        Text("Exit \(exitCode)")
                            .font(RelayChatStyle.labelFont)
                            .foregroundStyle(exitCode == 0 ? RelayChatStyle.secondary : AppTheme.statusError)
                    }
                }
                .padding(.vertical, 10)
            }
            .tint(RelayChatStyle.secondary)
        case .prose(let text):
            RelayMarkdownText(text: text, userAligned: false, bodyFont: RelayChatStyle.bodyFont)
                .padding(.bottom, 12)
        case .warning(let message):
            Text("Warning: \(message)")
                .font(RelayChatStyle.labelFont)
                .foregroundStyle(AppTheme.statusWarn)
                .padding(.vertical, 10)
        }
    }
}

/// One status and one duration per run, with no repeated provider badge or timer.
private struct RelayChatRunStatus: View {
    let job: CodexJob

    var body: some View {
        HStack(spacing: 6) {
            Text(job.status.label)
                .foregroundStyle(statusColor)
            if job.status.isActive, let start = job.startedAt ?? job.createdAt {
                Text("·").foregroundStyle(RelayChatStyle.secondary)
                Text(start, style: .timer)
                    .monospacedDigit()
                    .foregroundStyle(RelayChatStyle.secondary)
                    .fixedSize()
            } else if let duration = job.durationMs {
                Text("· \(max(0, duration / 1000))s")
                    .monospacedDigit()
                    .foregroundStyle(RelayChatStyle.secondary)
            }
        }
        .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption))
    }

    private var statusColor: Color {
        switch job.status {
        case .waitingForApproval: AppTheme.statusWarn
        case .failed, .timeout: AppTheme.statusError
        case .running, .queued, .canceling: AppTheme.accent
        default: RelayChatStyle.secondary
        }
    }
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

struct RelayArtifactViewer: View {
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
                    Text("No chats in this folder yet.")
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
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("Threads")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
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
            RelayConversationRow(item: item)
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 0, leading: 18, bottom: 0, trailing: 18))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
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
                        Button(primaryActionTitle, action: onAllow)
                            .buttonStyle(RelayPrimaryButtonStyle())
                            .accessibilityIdentifier("relay-ai-data-consent-allow")

                        if !isConsentGranted {
                            Button("Not Now", action: onCancel)
                                .buttonStyle(RelayOutlineButtonStyle())
                                .accessibilityIdentifier("relay-ai-data-consent-cancel")
                        }
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

    private var primaryActionTitle: String {
        if isConsentGranted { return "Done" }
        return purpose == .sendPrompt ? "Allow & Send" : "Allow"
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
    let jobID: String
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var rawText: String?
    @State private var showingRaw = false
    @State private var expandedStepIDs: Set<String> = []
    @State private var stepsExpanded = false
    @State private var receiptExpanded = false
    @State private var pinToBottom = true

    private var job: CodexJob? {
        viewModel.liveJob(id: jobID)
    }

    private var blocks: [RelayRunLogBlock] {
        RelayRunLogParser.parse(rawText ?? "")
    }

    private var proseBlocks: [RelayRunLogBlock] {
        blocks.filter {
            if case .prose = $0.kind { return true }
            return false
        }
    }

    private var stepBlocks: [RelayRunLogBlock] {
        blocks.filter {
            switch $0.kind {
            case .step, .warning:
                return true
            case .prose:
                return false
            }
        }
    }

    private var warningCount: Int {
        blocks.reduce(0) { count, block in
            if case .warning = block.kind { return count + 1 }
            return count
        }
    }

    private var stepCount: Int {
        blocks.reduce(0) { count, block in
            if case .step = block.kind { return count + 1 }
            return count
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                if showingRaw {
                    rawLogView
                } else {
                    structuredLogView
                }
            }
            .background(AppTheme.bgCanvas)
            .safeAreaInset(edge: .top, spacing: 0) { header }
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if job?.status.isActive == true {
                    HStack {
                        Text(pinToBottom ? "Following latest" : "Auto-follow paused")
                            .foregroundStyle(RelayChatStyle.secondary)
                        Spacer()
                        Button(pinToBottom ? "Pause" : "Follow latest") {
                            pinToBottom.toggle()
                        }
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(minHeight: 44)
                    }
                    .font(RelayChatStyle.labelFont)
                    .padding(.horizontal, 18)
                    .background(AppTheme.bgCanvas)
                    .overlay(alignment: .top) { hairline }
                }
            }
            .navigationTitle("Run log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(AppTheme.textPrimary)
                }
            }
            .preferredColorScheme(.dark)
        }
        .task(id: jobID) {
            await pollFullLogWhileActive()
        }
    }

    @ViewBuilder
    private var structuredLogView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if rawText == nil {
                        ProgressView("Loading run log…")
                            .tint(AppTheme.accent)
                            .foregroundStyle(AppTheme.textSecondary)
                            .frame(maxWidth: .infinity, minHeight: 260)
                            .padding(.top, 24)
                    } else if let job, !job.status.isActive {
                        finishedBody(job)
                    } else {
                        runningBody
                    }

                    Color.clear.frame(height: 1).id("run-log-bottom")
                }
            }
            .onChange(of: rawText) { _, _ in
                guard pinToBottom else { return }
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("run-log-bottom", anchor: .bottom)
                }
            }
            .onChange(of: pinToBottom) { _, following in
                if following { proxy.scrollTo("run-log-bottom", anchor: .bottom) }
            }
            .simultaneousGesture(
                DragGesture().onChanged { value in
                    if value.translation.height > 8 { pinToBottom = false }
                }
            )
        }
    }

    private var rawLogView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text((rawText?.isEmpty == false) ? (rawText ?? "") : "No log output.")
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear.frame(height: 1).id("raw-log-bottom")
                }
                .padding(18)
            }
            .onChange(of: rawText) { _, _ in
                if pinToBottom { proxy.scrollTo("raw-log-bottom", anchor: .bottom) }
            }
            .onChange(of: pinToBottom) { _, following in
                if following { proxy.scrollTo("raw-log-bottom", anchor: .bottom) }
            }
            .simultaneousGesture(
                DragGesture().onChanged { value in
                    if value.translation.height > 8 { pinToBottom = false }
                }
            )
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let job {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(providerModelLabel(job))
                            .font(RelayChatStyle.labelFont.weight(.medium))
                            .foregroundStyle(AppTheme.textPrimary)
                            .fixedSize(horizontal: false, vertical: true)
                        RelayChatRunStatus(job: job)
                    }
                    Spacer(minLength: 0)
                    if showingRaw {
                        Button {
                            UIPasteboard.general.string = rawText ?? ""
                        } label: {
                            Image(systemName: "doc.on.doc")
                                .frame(width: 44, height: 44)
                        }
                        .foregroundStyle(RelayChatStyle.secondary)
                        .accessibilityLabel("Copy raw log")
                    }
                }
            }
            Picker("Log format", selection: $showingRaw) {
                Text("Activity").tag(false)
                Text("Raw").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("relay-run-log-raw")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 12)
        .background(AppTheme.bgCanvas)
        .overlay(alignment: .bottom) { hairline }
    }

    @ViewBuilder
    private var runningBody: some View {
        ForEach(Array(blocks.enumerated()), id: \.element.id) { _, block in
            blockView(block, compact: false)
            hairline
        }

        if let receipt = job?.execution {
            receiptDisclosure(receipt)
            hairline
        }

    }

    @ViewBuilder
    private func finishedBody(_ job: CodexJob) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(proseBlocks) { block in
                if case .prose(let text) = block.kind {
                    proseSection(text, provider: job.provider)
                }
            }

            if proseBlocks.isEmpty, let answer = job.displayOutput?.trimmedNonEmpty {
                proseSection(answer, provider: job.provider)
            }

            hairline

            Button {
                stepsExpanded.toggle()
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: stepsExpanded ? "chevron.down" : "chevron.right")
                        .font(AppTheme.uiFont(size: 10, weight: .semibold))
                        .foregroundStyle(AppTheme.textTertiary)
                    Text("\(stepCount) steps")
                        .font(AppTheme.uiFont(size: 13.5))
                        .foregroundStyle(AppTheme.textPrimary)
                    Spacer()
                    if warningCount > 0 {
                        RelayCapsLabel(
                            text: "\(warningCount) warning\(warningCount == 1 ? "" : "s")",
                            color: AppTheme.statusWarn,
                            size: 9
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 11)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if stepsExpanded {
                hairline
                ForEach(stepBlocks) { block in
                    blockView(block, compact: true)
                }
            }

            hairline
            if let receipt = job.execution {
                receiptDisclosure(receipt)
                hairline
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: RelayRunLogBlock, compact: Bool) -> some View {
        switch block.kind {
        case .prose(let text):
            if !compact, let job {
                proseSection(text, provider: job.provider)
            }
        case .step(let command, let output, let exitCode):
            stepRow(id: block.id, command: command, output: output, exitCode: exitCode, compact: compact)
        case .warning(let message):
            warningRow(message, compact: compact)
        }
    }

    private func proseSection(_ text: String, provider: CodexProvider) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(provider.relayPresentation.title)
                .font(RelayChatStyle.labelFont.weight(.medium))
                .foregroundStyle(RelayChatStyle.secondary)
            RelayMarkdownText(text: text, userAligned: false, bodyFont: RelayChatStyle.bodyFont)
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func stepRow(id: String, command: String, output: String, exitCode: Int?, compact: Bool) -> some View {
        let expanded = expandedStepIDs.contains(id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if expanded {
                    expandedStepIDs.remove(id)
                } else {
                    expandedStepIDs.insert(id)
                }
            } label: {
                HStack(spacing: 9) {
                    if !compact {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                            .font(AppTheme.uiFont(size: 10, weight: .semibold))
                            .foregroundStyle(AppTheme.textTertiary)
                    }
                    Text(command)
                        .font(AppTheme.monoFont(size: 13))
                        .foregroundStyle(expanded || job?.status.isActive == true ? AppTheme.textPrimary : AppTheme.textSecondary)
                        .lineLimit(expanded ? nil : 2)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let exitCode {
                        Text("Exit \(exitCode)")
                            .font(RelayChatStyle.labelFont)
                            .foregroundStyle(exitCode == 0 ? RelayChatStyle.secondary : AppTheme.statusError)
                    } else if job?.status.isActive == true, blocks.last?.id == id {
                        // Liveness for the in-flight step is the duration, never a dot.
                        if let job {
                            durationLabel(for: job)
                        }
                    }
                }
                .padding(.horizontal, compact ? 35 : 16)
                .padding(.vertical, 12)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded, !output.isEmpty {
                Text(output)
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(11)
                    .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                    .padding(.leading, compact ? 35 : 35)
                    .padding(.trailing, 16)
                    .padding(.bottom, 13)
            }
        }
    }

    private func warningRow(_ message: String, compact: Bool) -> some View {
        HStack(alignment: .top, spacing: 9) {
            RelayCapsLabel(text: "Warning", color: AppTheme.statusWarn, size: 9)
            Text(message)
                .font(AppTheme.uiFont(size: compact ? 12 : 12.5))
                .foregroundStyle(AppTheme.textSecondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, compact ? 35 : 16)
        .padding(.vertical, compact ? 11 : 13)
    }

    private func receiptDisclosure(_ receipt: CodexExecutionReceipt) -> some View {
        DisclosureGroup(isExpanded: $receiptExpanded) {
            Text(receipt.summaryLines.joined(separator: "\n"))
                .font(AppTheme.monoFont(size: 11))
                .foregroundStyle(AppTheme.textSecondary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
        } label: {
            Text("Execution receipt")
                .font(AppTheme.uiFont(size: 13.5))
                .foregroundStyle(AppTheme.textSecondary)
                .padding(.vertical, 4)
        }
        .tint(AppTheme.textFaint)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private var hairline: some View {
        Rectangle()
            .fill(AppTheme.hairline)
            .frame(height: 1)
    }

    private func providerModelLabel(_ job: CodexJob) -> String {
        let provider = job.provider.relayPresentation.title
        if let model = job.model?.trimmedNonEmpty {
            return "\(provider) · \(model)"
        }
        return provider
    }

    @ViewBuilder
    private func durationLabel(for job: CodexJob) -> some View {
        if job.status.isActive, let startedAt = job.startedAt ?? job.createdAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                RelayCapsLabel(
                    text: Self.elapsedLabel(from: startedAt, to: context.date),
                    color: AppTheme.accentBright,
                    size: 9
                )
            }
        } else if let durationMs = job.durationMs {
            RelayCapsLabel(
                text: Self.elapsedLabel(milliseconds: durationMs),
                color: AppTheme.textSecondary,
                size: 9
            )
        } else if let startedAt = job.startedAt ?? job.createdAt,
                  let finishedAt = job.completedAt ?? job.updatedAt {
            RelayCapsLabel(
                text: Self.elapsedLabel(from: startedAt, to: finishedAt),
                color: AppTheme.textSecondary,
                size: 9
            )
        }
    }

    private func statusLabel(for job: CodexJob) -> some View {
        let text: String
        let color: Color
        switch job.status {
        case .queued, .running, .canceling:
            text = "Working"
            color = AppTheme.accentBright
        case .waitingForApproval:
            text = "Needs approval"
            color = AppTheme.statusWarn
        case .succeeded:
            text = "Finished"
            color = AppTheme.textSecondary
        case .failed:
            text = "Failed"
            color = AppTheme.statusError
        case .canceled:
            text = "Canceled"
            color = AppTheme.textTertiary
        case .timeout:
            text = "Timed out"
            color = AppTheme.statusError
        case .unknown:
            text = job.status.label
            color = AppTheme.textTertiary
        }
        return RelayCapsLabel(text: text, color: color, size: 9)
    }

    private func pollFullLogWhileActive() async {
        repeat {
            rawText = await viewModel.loadFullLog(jobID: jobID)
            let latest = viewModel.liveJob(id: jobID)
            if latest?.status.isActive != true {
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        } while !Task.isCancelled
    }

    private static func elapsedLabel(from startedAt: Date, to now: Date) -> String {
        let seconds = max(0, Int(now.timeIntervalSince(startedAt)))
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private static func elapsedLabel(milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1000)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
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
