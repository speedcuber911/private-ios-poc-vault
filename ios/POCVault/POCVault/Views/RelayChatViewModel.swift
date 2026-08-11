import Foundation

struct RelayUsage: Hashable {
    var inputTokens: Int?
    var outputTokens: Int?

    var isEmpty: Bool { inputTokens == nil && outputTokens == nil }
}

struct RelayConversationItem: Identifiable, Hashable {
    enum Role: Hashable {
        case user
        case assistant
        case status
        case job
    }

    let id: String
    var role: Role
    var text: String
    var timestamp: Date
    var provider: CodexProvider?
    var modelLabel: String?
    var job: CodexJob?
    var canLoadFullLog: Bool
    /// True while assistant tokens are still streaming in (drives the caret / typing dots).
    var isStreaming: Bool
    /// Token usage reported by the server once the stream finishes.
    var usage: RelayUsage?
    /// Wall-clock seconds the reply took, stamped when the stream completes.
    var elapsedSeconds: Double?

    init(
        id: String = UUID().uuidString,
        role: Role,
        text: String,
        timestamp: Date = Date(),
        provider: CodexProvider? = nil,
        modelLabel: String? = nil,
        job: CodexJob? = nil,
        canLoadFullLog: Bool = false,
        isStreaming: Bool = false,
        usage: RelayUsage? = nil,
        elapsedSeconds: Double? = nil
    ) {
        self.id = id
        self.role = role
        self.text = text
        self.timestamp = timestamp
        self.provider = provider
        self.modelLabel = modelLabel
        self.job = job
        self.canLoadFullLog = canLoadFullLog
        self.isStreaming = isStreaming
        self.usage = usage
        self.elapsedSeconds = elapsedSeconds
    }
}

/// A selectable picker row: a server model plus the explicit interaction mode it runs in.
/// Identity includes BOTH the model id and the mode, so a dual-mode Codex descriptor can
/// appear as an Agents (task) row and a Chat models (chat) row without colliding.
struct RelayModelChoice: Identifiable, Hashable {
    let model: CodexModelDescriptor
    let mode: RelayInteractionMode

    var id: String { "\(model.id)#\(mode.rawValue)" }

    /// The harness name shown for Agents grouping and the composer chip ("Codex",
    /// "Claude Code", "Cursor"). Purely presentational; rows still come only from the
    /// server catalog.
    static func harnessTitle(for provider: CodexProvider) -> String {
        switch provider {
        case .claude:
            return "Claude Code"
        case .codex, .cursor, .bedrock, .azure:
            return provider.displayName
        }
    }

    var harnessTitle: String { Self.harnessTitle(for: model.provider) }

    /// The model label with any redundant harness prefix/suffix stripped, so submenu rows
    /// read "GPT-5.6 Sol" under Codex, "Auto" under Cursor, "Sonnet" under Claude Code.
    var shortModelLabel: String {
        var text = model.label.trimmingCharacters(in: .whitespacesAndNewlines)
        for alias in Self.labelAliases(for: model.provider) {
            let lowered = text.lowercased()
            if lowered.hasPrefix(alias.lowercased()) {
                let stripped = String(text.dropFirst(alias.count))
                    .trimmingCharacters(in: CharacterSet(charactersIn: " \t·:-–—"))
                if !stripped.isEmpty {
                    text = stripped
                }
                break
            }
            let parenthetical = "(\(alias))"
            if lowered.hasSuffix(parenthetical.lowercased()) {
                let stripped = String(text.dropLast(parenthetical.count))
                    .trimmingCharacters(in: .whitespaces)
                if !stripped.isEmpty {
                    text = stripped
                }
                break
            }
        }
        return text
    }

    /// Composer chip text: harness plus model, e.g. "Codex · GPT-5.6 Sol" / "Cursor · Auto".
    var chipLabel: String {
        "\(harnessTitle) · \(shortModelLabel)"
    }

    private static func labelAliases(for provider: CodexProvider) -> [String] {
        switch provider {
        case .codex:
            return ["Codex"]
        case .claude:
            return ["Claude Code", "Claude"]
        case .cursor:
            return ["Cursor Agent", "Cursor"]
        case .bedrock:
            return ["Bedrock"]
        case .azure:
            return ["Azure OpenAI", "Azure"]
        }
    }
}

/// One harness (agent CLI) advertised by the server catalog, carrying its task-mode
/// model choices. A harness with a single "let the harness choose" entry (Cursor Auto)
/// simply has one choice — the client never synthesizes extra rows.
struct RelayHarnessGroup: Identifiable, Hashable {
    let provider: CodexProvider
    let choices: [RelayModelChoice]

    var id: String { provider.rawValue }
    var title: String { RelayModelChoice.harnessTitle(for: provider) }
}

/// Harness-first picker structure: Agents (task mode, grouped per harness) and a flat
/// Chat models list. Both are derived purely from the server catalog; a missing provider
/// produces no group and no rows.
struct RelayModelPickerSections: Hashable {
    let agents: [RelayHarnessGroup]
    let chatModels: [RelayModelChoice]

    var isEmpty: Bool { agents.isEmpty && chatModels.isEmpty }

    var allChoices: [RelayModelChoice] {
        agents.flatMap(\.choices) + chatModels
    }

    /// Sensible default when nothing is selected yet: the first chat model if any
    /// (matching the conversation-first surface), else the first agent.
    var defaultChoice: RelayModelChoice? {
        chatModels.first ?? agents.first?.choices.first
    }
}

enum RelayModelDiscovery {
    static let agentProviderOrder: [CodexProvider] = [.codex, .claude, .cursor, .bedrock, .azure]
    static let chatProviderOrder: [CodexProvider] = [.codex, .azure, .bedrock, .claude, .cursor]

    /// Build the harness-first picker sections from the server catalog. Catalog order is
    /// preserved within each provider (the server curates it); providers absent from the
    /// catalog simply do not appear.
    static func sections(from models: [CodexModelDescriptor]) -> RelayModelPickerSections {
        let agents = agentProviderOrder.compactMap { provider -> RelayHarnessGroup? in
            let entries = models.filter { $0.provider == provider && $0.supports(.task) }
            guard !entries.isEmpty else { return nil }
            return RelayHarnessGroup(
                provider: provider,
                choices: entries.map { RelayModelChoice(model: $0, mode: .task) }
            )
        }
        let chatModels = chatProviderOrder.flatMap { provider in
            models
                .filter { $0.provider == provider && $0.supports(.chat) }
                .map { RelayModelChoice(model: $0, mode: .chat) }
        }
        return RelayModelPickerSections(agents: agents, chatModels: chatModels)
    }
}

@MainActor
final class RelayChatViewModel: ObservableObject {
    @Published private(set) var models: [CodexModelDescriptor] = []
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var messages: [RelayConversationItem] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var isTranscribing = false
    @Published private(set) var cancellingJobIDs: Set<String> = []
    /// The explicit model+mode selection. Never inferred from `supports(.task)`; the mode
    /// travels with the choice from the picker section it was tapped in.
    @Published private(set) var selectedChoice: RelayModelChoice?
    /// User-chosen reasoning effort for task jobs (nil = model default). Reset when the
    /// selected choice changes so we never send an effort the model doesn't support.
    @Published var selectedEffort: CodexReasoningEffort?
    @Published var prompt = ""
    @Published var errorMessage: String?
    /// Live stdout/stderr tail per active job id, fed by the job SSE stream. Cleared when
    /// the job reaches a terminal state.
    @Published private(set) var liveJobTails: [String: String] = [:]

    /// Registered workspace id for this folder, nil until the folder is registered
    /// (lazy `POST /workspaces/select` on first send).
    @Published private(set) var workspaceID: String?
    /// Absolute jail path of the folder this conversation is scoped to; nil for the
    /// workspace-root chat.
    let workspacePath: String?

    private var registeredWorkspaceName: String?

    /// Id of the assistant message currently streaming, or nil when idle. The composer
    /// flips its send button to a stop button while this is set.
    @Published private(set) var streamingMessageID: String?

    private let client: CodexClient
    private var currentThreadID: String?
    private var currentThreadProvider: CodexProvider?
    /// Workspace the current thread belongs to. Resuming a session in a different
    /// workspace is rejected by the server ("session does not belong to workspace"), so
    /// we only resume when this matches the compose workspace.
    private var currentThreadWorkspaceID: String?
    /// Human-readable name recorded for the current folder-scoped thread.
    private var currentThreadWorkspaceName: String?
    private var streamTask: Task<Void, Never>?
    /// Live job SSE consumers keyed by job id. Streams are VM-owned: dismissing the chat
    /// cover never cancels them. When a stream errors/drops the entry clears itself and
    /// the store's 2 s monitor loop (refreshActiveWorkIfNeeded) remains the fallback
    /// update channel.
    private var jobStreamTasks: [String: Task<Void, Never>] = [:]

    private static let liveTailCharacterCap = 12_000

    var isStreaming: Bool { streamingMessageID != nil }

    /// Unified, newest-first history for this exact folder. Server threads carry complete
    /// conversations; standalone jobs cover invocations whose provider never produced a
    /// resumable session (or whose session discovery has not completed yet). The extra
    /// local filter is defense in depth on top of the server's workspaceId query.
    var historyItems: [CodexThreadFeedItem] {
        let scopedThreads = threads.filter { belongsToHistoryScope($0.workspaceId) }
        let scopedJobs = jobs.filter { belongsToHistoryScope($0.workspaceId) }
        return CodexThreadFeedItem.makeFeed(
            threads: scopedThreads,
            jobs: scopedJobs,
            workspaceID: workspaceID
        )
    }

    init(client: CodexClient, workspaceID: String?, workspacePath: String?) {
        self.client = client
        self.workspaceID = workspaceID?.trimmedNonEmpty
        self.workspacePath = workspacePath?.trimmedNonEmpty
    }

    /// Folder name for the chat top bar ("Relay" for the root chat).
    var folderDisplayName: String {
        if let workspacePath {
            return URL(fileURLWithPath: workspacePath).lastPathComponent
        }
        return registeredWorkspaceName ?? "Relay"
    }

    /// Adopt a workspace id learned outside this VM (e.g. the browser registered the
    /// folder after this session was created). First-writer wins; ids are stable per path.
    func adoptWorkspaceID(_ id: String) {
        guard workspaceID == nil, let trimmed = id.trimmedNonEmpty else { return }
        workspaceID = trimmed
    }

    // MARK: - Model selection

    var pickerSections: RelayModelPickerSections {
        RelayModelDiscovery.sections(from: models)
    }

    func selectChoice(_ choice: RelayModelChoice) {
        selectedChoice = choice
        selectedEffort = nil  // fall back to the new model's default until the user picks
    }

    /// Effort levels the selected task model exposes (from the catalog), as typed options.
    /// Chat requests carry no effort, so chat-mode selections expose none.
    var availableEfforts: [CodexReasoningEffort] {
        guard let choice = selectedChoice, choice.mode == .task else { return [] }
        return choice.model.effortLevels.compactMap { CodexReasoningEffort(rawValue: $0.lowercased()) }
    }

    /// The effort to actually send: user choice if set and valid, else the model default.
    var effectiveEffort: CodexReasoningEffort? {
        if let selectedEffort, availableEfforts.contains(selectedEffort) { return selectedEffort }
        return availableEfforts.contains(.high) ? .high : availableEfforts.first
    }

    func selectEffort(_ effort: CodexReasoningEffort?) {
        selectedEffort = effort
    }

    private func ensureSelectedChoiceValid() {
        let sections = pickerSections
        if let selectedChoice, sections.allChoices.contains(selectedChoice) {
            return
        }
        if let fallback = sections.defaultChoice {
            selectedChoice = fallback
        }
    }

    // MARK: - Bootstrap / refresh

    func bootstrap() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            models = try await client.fetchModels()
            ensureSelectedChoiceValid()
            await refreshThreads()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        #if DEBUG
        await runAutoDriveIfRequested()
        #endif
    }

    /// Load only this folder's threads and invocations. A folder whose dynamic workspace
    /// has not been registered yet has no server-side history; the workspace-root chat
    /// keeps only legacy/global conversations whose workspaceId is nil.
    func refreshThreads() async {
        guard workspacePath == nil || workspaceID != nil else {
            threads = []
            jobs = []
            return
        }
        do {
            let fetchedThreads = try await client.fetchThreads(provider: nil, workspaceID: workspaceID, limit: 200)
            let fetchedJobs = try await client.fetchJobs(provider: nil, workspaceID: workspaceID, limit: 200)
            threads = Self.sortedThreads(fetchedThreads.filter { belongsToHistoryScope($0.workspaceId) })
            jobs = Self.sortedJobs(fetchedJobs.filter { belongsToHistoryScope($0.workspaceId) })
            mergeUpdatedJobs()
        } catch {
            if !isCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// True while any job shown in this conversation is still running/queued.
    var hasActiveConversationJob: Bool {
        messages.contains { $0.job?.status.isActive == true }
    }

    /// One pass of the app-wide monitor loop (owned by `RelayChatSessionStore`, ~2 s):
    /// while this conversation has an active job, pull its latest detail and refresh
    /// threads so the job card keeps showing progress — even when the chat cover is
    /// dismissed or the job SSE stream has dropped. This polling is the fallback (and
    /// reconciliation) channel next to `streamJobEvents`.
    func refreshActiveWorkIfNeeded() async {
        guard hasActiveConversationJob else { return }
        await refreshActiveJobDetails()
        await refreshThreads()
    }

    /// Fetch full detail for each active job card so stdout/result grows live in the UI.
    private func refreshActiveJobDetails() async {
        let activeIDs = messages.compactMap { $0.job?.status.isActive == true ? $0.job?.id : nil }
        for id in activeIDs {
            if let updated = try? await client.fetchJob(id: id, includeFullLogs: false) {
                replaceJob(updated)
            }
        }
    }

    // MARK: - Sending

    func sendCurrentPrompt() async {
        guard let choice = selectedChoice else {
            errorMessage = "No model is available."
            return
        }
        switch choice.mode {
        case .chat:
            await sendChat(using: choice)
        case .task:
            await runTask(using: choice)
        }
    }

    #if DEBUG
    /// Headless visual-test hook. When launched with RELAY_UITEST_MODEL / RELAY_UITEST_PROMPT
    /// (chat) or RELAY_UITEST_TASK_PROMPT (task), the app selects the matching choice and
    /// sends the prompt on its own so the streaming UI can be screenshotted without
    /// simulator tap automation. Compiled out of release builds.
    private func runAutoDriveIfRequested() async {
        let env = ProcessInfo.processInfo.environment
        // Task auto-drive: pick the harness's model in task mode and submit a job.
        if let taskPrompt = env["RELAY_UITEST_TASK_PROMPT"], !taskPrompt.isEmpty {
            if let wanted = env["RELAY_UITEST_MODEL"]?.lowercased(),
               let match = models.first(where: { $0.supports(.task) && ($0.id.lowercased().contains(wanted) || $0.label.lowercased().contains(wanted)) }) {
                selectChoice(RelayModelChoice(model: match, mode: .task))
            } else if let fallback = pickerSections.agents.first?.choices.first {
                selectChoice(fallback)
            }
            prompt = taskPrompt
            await sendCurrentPrompt()
            return
        }
        guard let promptText = env["RELAY_UITEST_PROMPT"], !promptText.isEmpty else { return }
        if let wanted = env["RELAY_UITEST_MODEL"]?.lowercased(),
           let match = models.first(where: { $0.supports(.chat) && ($0.id.lowercased().contains(wanted) || $0.label.lowercased().contains(wanted)) }) {
            selectChoice(RelayModelChoice(model: match, mode: .chat))
        } else if let fallback = pickerSections.chatModels.first {
            selectChoice(fallback)
        }
        prompt = promptText
        await sendCurrentPrompt()
    }
    #endif

    /// Cancel an in-flight chat stream. The SSE request aborts when the underlying task is
    /// cancelled (CodexClient tears down the URLSession data task on cancellation).
    func stopStreaming() {
        streamTask?.cancel()
        streamTask = nil
        if let id = streamingMessageID, let index = messages.firstIndex(where: { $0.id == id }) {
            messages[index].isStreaming = false
            if messages[index].text.isEmpty {
                messages[index].text = "Stopped."
            }
        }
        streamingMessageID = nil
        isSending = false
    }

    /// Register this folder as a workspace on first use (lazy `POST /workspaces/select`).
    /// Returns the workspace id, or nil after setting an error banner — callers must keep
    /// the typed prompt intact on nil.
    private func ensureWorkspaceRegistered() async -> String? {
        if let workspaceID { return workspaceID }
        guard let workspacePath else { return nil }
        do {
            let workspace = try await client.selectWorkspace(path: workspacePath)
            workspaceID = workspace.id
            registeredWorkspaceName = workspace.name
            return workspace.id
        } catch {
            errorMessage = "Couldn't register this folder as a workspace: \(error.localizedDescription)"
            return nil
        }
    }

    private func sendChat(using choice: RelayModelChoice) async {
        let model = choice.model
        guard model.supports(.chat) else {
            errorMessage = "\(model.label) is not available for Chat."
            return
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        isSending = true

        // Every selectable history item belongs to this folder. A brand-new folder
        // conversation lazily registers the folder before clearing the draft.
        var scopeWorkspaceID = Self.conversationWorkspaceID(
            currentThreadID: currentThreadID,
            currentThreadWorkspaceID: currentThreadWorkspaceID,
            defaultWorkspaceID: workspaceID
        )
        if currentThreadID == nil, currentThreadWorkspaceID == nil,
           (workspaceID != nil || workspacePath != nil) {
            guard let registered = await ensureWorkspaceRegistered() else {
                isSending = false
                return
            }
            scopeWorkspaceID = registered
        }

        prompt = ""
        errorMessage = nil

        let userItem = RelayConversationItem(role: .user, text: text, provider: model.provider, modelLabel: model.label)
        let assistantID = UUID().uuidString
        messages.append(userItem)
        messages.append(RelayConversationItem(id: assistantID, role: .assistant, text: "", provider: model.provider, modelLabel: model.label, isStreaming: true))
        streamingMessageID = assistantID

        let history = messages.compactMap { item -> CodexChatMessage? in
            switch item.role {
            case .user:
                return CodexChatMessage(role: "user", content: item.text)
            case .assistant where !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                return CodexChatMessage(role: "assistant", content: item.text)
            case .assistant, .status, .job:
                return nil
            }
        }

        // Only continue the current thread when provider AND workspace scope match;
        // the server rejects continuations under a conflicting workspaceId.
        let resumeThreadID = (currentThreadProvider == model.provider && currentThreadWorkspaceID == scopeWorkspaceID)
            ? currentThreadID
            : nil

        let request = CodexChatRequest(
            provider: model.provider.rawValue,
            model: model.id,
            threadId: resumeThreadID,
            messages: history,
            options: model.defaultOptions,
            workspaceId: scopeWorkspaceID
        )

        let startedAt = Date()
        let task = Task { [weak self] in
            guard let self else { return }
            var receivedAssistantText = false
            var usage: RelayUsage?
            do {
                for try await event in self.client.streamChat(request) {
                    if Task.isCancelled { break }
                    switch event {
                    case .meta(let threadId, _, let provider):
                        self.currentThreadID = threadId
                        self.currentThreadProvider = CodexProvider(rawProvider: provider)
                        self.currentThreadWorkspaceID = scopeWorkspaceID
                        if self.currentThreadWorkspaceName == nil, scopeWorkspaceID != nil {
                            self.currentThreadWorkspaceName = self.registeredWorkspaceName
                                ?? self.workspacePath.map { URL(fileURLWithPath: $0).lastPathComponent }
                        }
                    case .delta(let delta):
                        receivedAssistantText = true
                        self.append(delta: delta, to: assistantID)
                    case .usage(let input, let output):
                        usage = RelayUsage(inputTokens: input, outputTokens: output)
                    case .done:
                        break
                    case .error(let message):
                        self.errorMessage = message
                        receivedAssistantText = true
                        self.append(delta: "\n\n\(message)", to: assistantID)
                    }
                }
                if !Task.isCancelled, !receivedAssistantText {
                    self.replaceText("No response received.", for: assistantID)
                }
            } catch {
                if !Task.isCancelled {
                    self.errorMessage = error.localizedDescription
                    self.replaceText(error.localizedDescription, for: assistantID)
                }
            }
            self.finishStreaming(id: assistantID, usage: usage, startedAt: startedAt)
            if !Task.isCancelled {
                await self.refreshThreads()
            }
        }
        streamTask = task
        await task.value
    }

    private func finishStreaming(id: String, usage: RelayUsage?, startedAt: Date) {
        if let index = messages.firstIndex(where: { $0.id == id }) {
            messages[index].isStreaming = false
            if let usage, !usage.isEmpty { messages[index].usage = usage }
            messages[index].elapsedSeconds = Date().timeIntervalSince(startedAt)
        }
        if streamingMessageID == id { streamingMessageID = nil }
        streamTask = nil
        isSending = false
    }

    private func runTask(using choice: RelayModelChoice) async {
        let model = choice.model
        guard model.supports(.task) else {
            errorMessage = "\(model.label) is not available for Task."
            return
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        isSending = true
        defer { isSending = false }

        // Folder history continues a task in this same workspace. A new task lazily
        // registers the current folder before touching the draft.
        let targetWorkspaceID: String?
        if currentThreadWorkspaceID != nil {
            targetWorkspaceID = currentThreadWorkspaceID
        } else if currentThreadID != nil {
            targetWorkspaceID = nil
        } else {
            targetWorkspaceID = await ensureWorkspaceRegistered()
        }
        guard let workspaceID = targetWorkspaceID else {
            if workspacePath == nil {
                errorMessage = "Open a folder to run tasks — the root chat has no workspace."
            } else if currentThreadID != nil {
                errorMessage = "This conversation does not have a task workspace. Start a new conversation from the folder to run a task."
            }
            return
        }
        prompt = ""

        let provider = Self.taskProvider(for: model)
        // Only resume the existing session if it's the same provider AND same workspace,
        // otherwise the server rejects it ("session does not belong to workspace").
        let resumeID = (currentThreadProvider == provider && currentThreadWorkspaceID == workspaceID) ? currentThreadID : nil
        messages.append(RelayConversationItem(role: .user, text: text, provider: provider, modelLabel: model.label))
        do {
            let created = try await client.createJob(CodexCreateJobRequest(
                workspaceId: workspaceID,
                prompt: text,
                timeoutMs: 1_800_000,
                model: Self.taskModelParameter(for: model),
                reasoningEffort: effectiveEffort?.rawValue,
                provider: provider,
                resumeSessionId: resumeID
            ))
            let job: CodexJob
            if let createdJob = created.job {
                job = createdJob
            } else {
                job = try await client.fetchJob(id: created.id)
            }
            currentThreadID = job.threadSessionId ?? job.sessionId ?? job.resumeSessionId
            currentThreadProvider = provider
            currentThreadWorkspaceID = job.workspaceId ?? workspaceID
            currentThreadWorkspaceName = job.workspaceName ?? currentThreadWorkspaceName ?? registeredWorkspaceName
            messages.append(jobItem(job))
            attachJobStream(to: job)
            await refreshThreads()
        } catch {
            errorMessage = error.localizedDescription
            messages.append(RelayConversationItem(role: .status, text: error.localizedDescription, provider: provider))
        }
    }

    // MARK: - Live job stream (SSE with polling fallback)

    /// Attach the job SSE stream and mirror stdout/stderr into the live tail shown by the
    /// job card. On `done` the terminal job replaces the card. If the stream errors or
    /// drops, the task clears itself and the 2 s monitor polling keeps the card moving.
    private func attachJobStream(to job: CodexJob) {
        let jobID = job.id
        guard job.status.isActive, jobStreamTasks[jobID] == nil else { return }
        let task = Task { [weak self] in
            do {
                guard let client = self?.client else { return }
                for try await event in client.streamJobEvents(id: jobID) {
                    guard let self, !Task.isCancelled else { break }
                    switch event {
                    case .status(let updated):
                        self.replaceJob(updated)
                    case .stdout(_, let chunk):
                        self.appendLiveTail(jobID: jobID, chunk)
                    case .stderr(_, let chunk):
                        self.appendLiveTail(jobID: jobID, chunk)
                    case .done(let finished):
                        self.replaceJob(finished)
                    }
                }
            } catch {
                // Stream dropped (background, network, server restart): fall back to the
                // store-driven 2 s polling via refreshActiveWorkIfNeeded().
            }
            self?.jobStreamTasks[jobID] = nil
        }
        jobStreamTasks[jobID] = task
    }

    private func appendLiveTail(jobID: String, _ chunk: String) {
        guard !chunk.isEmpty else { return }
        var tail = (liveJobTails[jobID] ?? "") + chunk
        if tail.count > Self.liveTailCharacterCap {
            tail = String(tail.suffix(Self.liveTailCharacterCap))
        }
        liveJobTails[jobID] = tail
    }

    // MARK: - Threads

    func startNewConversation() {
        currentThreadID = nil
        currentThreadProvider = nil
        currentThreadWorkspaceID = nil
        currentThreadWorkspaceName = nil
        messages = []
    }

    func openThread(_ thread: CodexThread) async {
        guard belongsToHistoryScope(thread.workspaceId) else {
            errorMessage = "This thread belongs to a different folder."
            return
        }
        do {
            let detail = try await client.fetchThreadDetail(
                sessionID: thread.sessionId,
                workspaceID: workspaceID,
                provider: thread.provider
            )
            currentThreadID = detail.thread.sessionId
            currentThreadProvider = detail.thread.provider
            currentThreadWorkspaceID = detail.thread.workspaceId
            currentThreadWorkspaceName = detail.thread.workspaceName
            // Continuation keeps the thread's explicit mode in the selection.
            let mode = detail.thread.mode
            let threadModel = detail.thread.model
            if let model = models.first(where: {
                $0.provider == detail.thread.provider
                    && $0.supports(mode)
                    && (threadModel == nil || $0.id == threadModel || $0.taskModel == threadModel)
            }) {
                selectChoice(RelayModelChoice(model: model, mode: mode))
            } else if let model = models.first(where: { $0.provider == detail.thread.provider && $0.supports(mode) }) {
                selectChoice(RelayModelChoice(model: model, mode: mode))
            }
            var items = detail.messages.map { message in
                RelayConversationItem(
                    role: message.role == .user ? .user : message.role == .assistant ? .assistant : .status,
                    text: message.text,
                    timestamp: message.timestamp ?? detail.thread.updatedAt ?? Date(),
                    provider: detail.thread.provider,
                    modelLabel: selectedChoice?.model.label
                )
            }
            for job in detail.jobs {
                items.append(jobItem(job))
                attachJobStream(to: job)
            }
            messages = items.sorted { $0.timestamp < $1.timestamp }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Open either a resumable thread or a standalone invocation from the unified
    /// history feed. Standalone jobs still restore their prompt and result/log card.
    func openHistoryItem(_ item: CodexThreadFeedItem) async {
        switch item.source {
        case .thread(let thread):
            await openThread(thread)
        case .pendingJob(let job):
            await openStandaloneJob(job)
        }
    }

    private func openStandaloneJob(_ job: CodexJob) async {
        guard belongsToHistoryScope(job.workspaceId) else {
            errorMessage = "This invocation belongs to a different folder."
            return
        }
        let latest = (try? await client.fetchJob(id: job.id, includeFullLogs: false)) ?? job
        currentThreadID = latest.threadSessionId
        currentThreadProvider = latest.provider
        currentThreadWorkspaceID = latest.workspaceId
        currentThreadWorkspaceName = latest.workspaceName

        if let model = models.first(where: {
            $0.provider == latest.provider
                && $0.supports(.task)
                && (latest.model == nil || $0.id == latest.model || $0.taskModel == latest.model)
        }) ?? models.first(where: { $0.provider == latest.provider && $0.supports(.task) }) {
            selectChoice(RelayModelChoice(model: model, mode: .task))
        }

        var items: [RelayConversationItem] = []
        if let prompt = latest.prompt?.trimmedNonEmpty {
            items.append(RelayConversationItem(
                role: .user,
                text: prompt,
                timestamp: latest.createdAt ?? Date(),
                provider: latest.provider,
                modelLabel: latest.model
            ))
        }
        items.append(jobItem(latest))
        messages = items
        attachJobStream(to: latest)
        errorMessage = nil
    }

    func delete(_ thread: CodexThread) async {
        do {
            try await client.deleteThread(
                sessionID: thread.sessionId,
                workspaceID: thread.workspaceId,
                provider: thread.provider
            )
            threads.removeAll { $0.sessionId == thread.sessionId }
            // The server deletes every job attached to a task thread. Remove the same
            // jobs locally so the unified history feed does not briefly resurrect them
            // as standalone invocations before the next refresh.
            jobs.removeAll { $0.threadSessionId == thread.sessionId }
            if currentThreadID == thread.sessionId {
                startNewConversation()
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Jobs

    func cancel(job: CodexJob) async {
        cancellingJobIDs.insert(job.id)
        defer { cancellingJobIDs.remove(job.id) }
        do {
            if let updated = try await client.cancelJob(id: job.id) {
                replaceJob(updated)
            }
            await refreshThreads()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadFullLog(for job: CodexJob) async -> String {
        do {
            let full = try await client.fetchJob(id: job.id, includeFullLogs: true)
            replaceJob(full)
            return full.rawActivityOutput ?? full.displayOutput ?? ""
        } catch {
            errorMessage = error.localizedDescription
            return error.localizedDescription
        }
    }

    func transcribePromptAudio(fileURL: URL) async {
        isTranscribing = true
        defer { isTranscribing = false }
        do {
            let transcription = try await client.transcribeAudio(fileURL: fileURL)
            let text = transcription.text.trimmingCharacters(in: .whitespacesAndNewlines)
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                prompt = text
            } else if !text.isEmpty {
                prompt += "\n\n\(text)"
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Internals

    private func append(delta: String, to id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].text += delta
    }

    private func replaceText(_ text: String, for id: String) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].text = text
    }

    private func jobItem(_ job: CodexJob) -> RelayConversationItem {
        RelayConversationItem(
            role: .job,
            text: job.displayOutput ?? job.errorMessage ?? job.status.label,
            timestamp: job.createdAt ?? Date(),
            provider: job.provider,
            modelLabel: job.model,
            job: job,
            canLoadFullLog: job.hasTruncatedServerOutput
        )
    }

    private func replaceJob(_ job: CodexJob) {
        if !job.status.isActive {
            liveJobTails[job.id] = nil
        }
        if let index = messages.firstIndex(where: { $0.job?.id == job.id }) {
            messages[index] = jobItem(job)
        }
        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
            jobs[index] = job
        } else {
            jobs.insert(job, at: 0)
        }
    }

    private func mergeUpdatedJobs() {
        for job in jobs {
            if messages.contains(where: { $0.job?.id == job.id }) {
                replaceJob(job)
            }
        }
    }

    /// Exact-folder membership. A nil workspace is visible only in the workspace-root
    /// chat; it is never treated as a wildcard for a real folder.
    private func belongsToHistoryScope(_ itemWorkspaceID: String?) -> Bool {
        Self.isInHistoryScope(
            itemWorkspaceID: itemWorkspaceID,
            folderWorkspaceID: workspaceID,
            isWorkspaceRoot: workspacePath == nil
        )
    }

    nonisolated static func isInHistoryScope(
        itemWorkspaceID: String?,
        folderWorkspaceID: String?,
        isWorkspaceRoot: Bool
    ) -> Bool {
        if let folderWorkspaceID {
            return itemWorkspaceID == folderWorkspaceID
        }
        return isWorkspaceRoot && itemWorkspaceID == nil
    }

    /// Which task runner executes a model's jobs. Cursor keeps its own runner; Azure
    /// descriptors fall back to the Codex runner (they are chat-first).
    nonisolated static func taskProvider(for model: CodexModelDescriptor) -> CodexProvider {
        switch model.provider {
        case .claude, .bedrock:
            return .claude
        case .cursor:
            return .cursor
        case .codex, .azure:
            return .codex
        }
    }

    nonisolated static func taskModelParameter(for model: CodexModelDescriptor) -> String? {
        // Prefer an explicit task model (e.g. "opus", "gpt-5-codex") from the catalog;
        // otherwise fall back to the chat id for dual-mode models, or the runner default.
        if let taskModel = model.taskModel, !taskModel.isEmpty { return taskModel }
        return model.supports(.chat) ? model.id : nil
    }

    /// New conversations inherit the open folder. Existing conversations always retain
    /// their recorded scope, including nil for global chat threads.
    nonisolated static func conversationWorkspaceID(
        currentThreadID: String?,
        currentThreadWorkspaceID: String?,
        defaultWorkspaceID: String?
    ) -> String? {
        currentThreadID == nil && currentThreadWorkspaceID == nil
            ? defaultWorkspaceID
            : currentThreadWorkspaceID
    }

    private static func sortedThreads(_ threads: [CodexThread]) -> [CodexThread] {
        threads.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
    }

    private static func sortedJobs(_ jobs: [CodexJob]) -> [CodexJob] {
        jobs.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }
}
