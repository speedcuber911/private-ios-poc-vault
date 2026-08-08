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

enum RelayModelPickerBucket: String, CaseIterable, Identifiable {
    case latest
    case all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .latest:
            return "Latest"
        case .all:
            return "All"
        }
    }
}

struct RelayModelSection: Identifiable, Hashable {
    let title: String
    let models: [CodexModelDescriptor]

    var id: String { title }
}

enum RelayModelDiscovery {
    static func sections(
        from models: [CodexModelDescriptor],
        mode: RelayInteractionMode,
        bucket: RelayModelPickerBucket,
        searchText: String
    ) -> [RelayModelSection] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !query.isEmpty {
            let results = models
                .filter { model in model.matches(query) }
                .sorted(by: modelSort)
            return results.isEmpty ? [] : [RelayModelSection(title: "Search", models: results)]
        }

        switch bucket {
        case .latest:
            let recommended = recommendedModels(from: models, mode: mode)
            return recommended.isEmpty ? [] : [RelayModelSection(title: "Latest", models: recommended)]
        case .all:
            let grouped = Dictionary(grouping: models, by: \.provider)
            return providerOrder(for: mode).compactMap { provider in
                guard let entries = grouped[provider], !entries.isEmpty else { return nil }
                return RelayModelSection(title: provider.displayName, models: entries.sorted(by: modelSort))
            }
        }
    }

    static func recommendedModels(
        from models: [CodexModelDescriptor],
        mode: RelayInteractionMode,
        limit: Int = 10
    ) -> [CodexModelDescriptor] {
        let supported = models.filter { $0.supports(mode) }
        guard mode == .chat else {
            return supported.sorted(by: modelSort)
        }

        var bestByFamily: [String: CodexModelDescriptor] = [:]
        for model in supported {
            let key = familyKey(for: model)
            guard let current = bestByFamily[key] else {
                bestByFamily[key] = model
                continue
            }
            if recommendationScore(for: model) > recommendationScore(for: current) {
                bestByFamily[key] = model
            }
        }

        return Array(bestByFamily.values)
            .sorted { lhs, rhs in
                let lhsScore = recommendationScore(for: lhs)
                let rhsScore = recommendationScore(for: rhs)
                if lhsScore != rhsScore {
                    return lhsScore > rhsScore
                }
                return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
            }
            .prefix(limit)
            .map { $0 }
    }

    private static func providerOrder(for mode: RelayInteractionMode) -> [CodexProvider] {
        switch mode {
        case .chat:
            return [.azure, .bedrock, .codex, .claude]
        case .task:
            return [.codex, .claude, .bedrock, .azure]
        }
    }

    private static func modelSort(_ lhs: CodexModelDescriptor, _ rhs: CodexModelDescriptor) -> Bool {
        let lhsProviderIndex = providerOrder(for: lhs.modes.contains(.task) && !lhs.modes.contains(.chat) ? .task : .chat)
            .firstIndex(of: lhs.provider) ?? Int.max
        let rhsProviderIndex = providerOrder(for: rhs.modes.contains(.task) && !rhs.modes.contains(.chat) ? .task : .chat)
            .firstIndex(of: rhs.provider) ?? Int.max
        if lhsProviderIndex != rhsProviderIndex {
            return lhsProviderIndex < rhsProviderIndex
        }
        return lhs.label.localizedCaseInsensitiveCompare(rhs.label) == .orderedAscending
    }

    private static func familyKey(for model: CodexModelDescriptor) -> String {
        // De-dupe the Latest bucket by the model's own identity, not its coarse family, so
        // genuinely distinct models (e.g. gpt-5 vs gpt-5-chat, or two Opus minor versions)
        // each survive. We only fold away dated build suffixes and a version-pin tail
        // (e.g. "-20251101-v1:0"), which are the same model published twice.
        let base = nonEmpty(model.azureDeployment)
            ?? model.id.split(separator: "/").last.map(String.init)
            ?? model.label
        return base
            .lowercased()
            .replacingOccurrences(of: "global.anthropic.", with: "")
            .replacingOccurrences(of: #"-\d{8}(-v\d+(:\d+)?)?$"#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"\s*\(.*?\)"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func recommendationScore(for model: CodexModelDescriptor) -> Int {
        let text = "\(model.id) \(model.label) \(model.azureDeployment ?? "")".lowercased()
        var score = 0

        switch model.provider {
        case .azure:
            score += 1_000
        case .bedrock:
            score += 900
        case .codex:
            score += 800
        case .claude:
            score += 790
        }

        score += familyVersionScore(in: text)

        if text.contains("gpt-5") { score += 500 }
        if text.contains("gpt-4") { score += 300 }
        if text.contains("claude") { score += 430 }
        if text.contains("opus") { score += 90 }
        if text.contains("sonnet") { score += 70 }
        if text.contains("haiku") { score += 35 }
        if text.contains("deepseek") { score += 420 }
        if text.contains("kimi") { score += 410 }
        if text.contains("grok") { score += 405 }

        if text.contains("mini") { score -= 80 }
        if text.contains("nano") { score -= 140 }
        if text.contains("turbo") { score -= 60 }
        if text.contains("dev") { score -= 35 }
        if text.contains("prod") { score += 25 }

        return score
    }

    private static func familyVersionScore(in text: String) -> Int {
        [
            #"\bgpt[-_ ]?([0-9]+)(?:[.\-_ ]([0-9]+))?"#,
            #"\bclaude(?:[-_ ][a-z]+)?[-_ ]([0-9]+)(?:[.\-_ ]([0-9]+))?"#,
            #"\bdeepseek[-_ ]?v?([0-9]+)(?:[.\-_ ]([0-9]+))?"#,
            #"\bkimi(?:[-_ ]k)?[-_ ]?([0-9]+)(?:[.\-_ ]([0-9]+))?"#,
            #"\bgrok[-_ ]([0-9]+)(?:[.\-_ ]([0-9]+))?"#
        ].reduce(0) { best, pattern in
            max(best, bestVersionScore(matching: pattern, in: text))
        }
    }

    private static func bestVersionScore(matching pattern: String, in text: String) -> Int {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return 0 }
        let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        return matches.reduce(0) { best, match in
            guard match.numberOfRanges >= 2,
                  let majorRange = Range(match.range(at: 1), in: text),
                  let major = Int(text[majorRange]) else {
                return best
            }
            let minor: Int
            if match.numberOfRanges >= 3,
               let minorRange = Range(match.range(at: 2), in: text),
               let parsedMinor = Int(text[minorRange]) {
                minor = parsedMinor
            } else {
                minor = 0
            }
            let normalizedMajor = major == 35 ? 3 : major
            let normalizedMinor = major == 35 ? 50 : minor
            return max(best, (normalizedMajor * 100) + normalizedMinor)
        }
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }
}

private extension CodexModelDescriptor {
    func matches(_ query: String) -> Bool {
        let haystack = [
            id,
            label,
            provider.displayName,
            azureDeployment ?? "",
            modes.map(\.label).joined(separator: " ")
        ]
            .joined(separator: " ")
            .lowercased()
        return haystack.contains(query)
    }
}

@MainActor
final class RelayChatViewModel: ObservableObject {
    @Published private(set) var models: [CodexModelDescriptor] = []
    @Published private(set) var workspaces: [CodexWorkspace] = []
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var messages: [RelayConversationItem] = []
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var isTranscribing = false
    @Published private(set) var cancellingJobIDs: Set<String> = []
    @Published var mode: RelayInteractionMode = .chat {
        didSet { ensureSelectedModelSupportsMode() }
    }
    @Published var selectedModelID: String? {
        didSet { ensureSelectedModelSupportsMode() }
    }
    @Published var selectedWorkspaceID: String?
    /// User-chosen reasoning effort for task jobs (nil = model default). Reset when the
    /// selected model changes so we never send an effort the model doesn't support.
    @Published var selectedEffort: CodexReasoningEffort?
    @Published var prompt = ""
    @Published var errorMessage: String?

    /// Effort levels the selected task model exposes (from the catalog), as typed options.
    var availableEfforts: [CodexReasoningEffort] {
        guard let model = selectedModel else { return [] }
        let levels = model.effortLevels.compactMap { CodexReasoningEffort(rawValue: $0.lowercased()) }
        return levels.isEmpty ? [] : levels
    }

    /// The effort to actually send: user choice if set and valid, else the model default.
    var effectiveEffort: CodexReasoningEffort? {
        if let selectedEffort, availableEfforts.contains(selectedEffort) { return selectedEffort }
        return availableEfforts.contains(.high) ? .high : availableEfforts.first
    }

    func selectEffort(_ effort: CodexReasoningEffort?) {
        selectedEffort = effort
    }

    /// Id of the assistant message currently streaming, or nil when idle. The composer
    /// flips its send button to a stop button while this is set.
    @Published private(set) var streamingMessageID: String?

    private let client: CodexClient
    /// When set, this view model serves a single tab (Chat or Task) and the mode never changes.
    let lockedMode: RelayInteractionMode?
    private var currentThreadID: String?
    private var currentThreadProvider: CodexProvider?
    /// Workspace the current task thread belongs to. Resuming a session in a different
    /// workspace is rejected by the server ("session does not belong to workspace"), so we
    /// only resume when this matches the compose workspace.
    private var currentThreadWorkspaceID: String?
    private var streamTask: Task<Void, Never>?

    var isStreaming: Bool { streamingMessageID != nil }

    init(client: CodexClient, lockedMode: RelayInteractionMode? = nil) {
        self.client = client
        self.lockedMode = lockedMode
        if let lockedMode {
            self.mode = lockedMode
        }
    }

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

    var selectedModel: CodexModelDescriptor? {
        if let selectedModelID,
           let model = models.first(where: { $0.id == selectedModelID }) {
            return model
        }
        return preferredModel(for: mode)
    }

    var selectedWorkspace: CodexWorkspace? {
        guard let selectedWorkspaceID else { return nil }
        return workspaces.first { $0.id == selectedWorkspaceID }
    }

    var composeWorkspaceID: String {
        selectedWorkspaceID
            ?? workspaces.first(where: { $0.id == "poc-vault" })?.id
            ?? workspaces.first?.id
            ?? "poc-vault"
    }

    var modelGroups: [(provider: CodexProvider, models: [CodexModelDescriptor])] {
        let grouped = Dictionary(grouping: models, by: \.provider)
        return providerOrder(for: mode).compactMap { provider in
            guard let entries = grouped[provider], !entries.isEmpty else { return nil }
            return (provider, entries.sorted { $0.label < $1.label })
        }
    }

    func modelSections(bucket: RelayModelPickerBucket, searchText: String) -> [RelayModelSection] {
        RelayModelDiscovery.sections(from: models, mode: mode, bucket: bucket, searchText: searchText)
    }

    func bootstrap() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        async let modelRequest = client.fetchModels()
        async let workspaceRequest = client.fetchWorkspaces()
        async let threadRequest = client.fetchThreads(provider: nil, workspaceID: nil, limit: 80)
        async let jobRequest = client.fetchJobs(provider: nil, workspaceID: nil, limit: 20)
        do {
            models = try await modelRequest
            workspaces = try await workspaceRequest
            threads = Self.sortedThreads(try await threadRequest)
            jobs = Self.sortedJobs(try await jobRequest)
            ensureSelectedWorkspace()
            ensureSelectedModelSupportsMode()
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
        #if DEBUG
        await runAutoDriveIfRequested()
        #endif
    }

    #if DEBUG
    /// Headless visual-test hook. When launched with RELAY_UITEST_MODEL / RELAY_UITEST_PROMPT,
    /// the app selects that model and sends the prompt on its own so the streaming UI can be
    /// screenshotted without simulator tap automation. Compiled out of release builds.
    private func runAutoDriveIfRequested() async {
        let env = ProcessInfo.processInfo.environment
        // Task-tab auto-drive: submit a job so the live-polling job card can be screenshotted.
        if lockedMode == .task, let taskPrompt = env["RELAY_UITEST_TASK_PROMPT"], !taskPrompt.isEmpty {
            prompt = taskPrompt
            await sendCurrentPrompt()
            return
        }
        guard let promptText = env["RELAY_UITEST_PROMPT"], !promptText.isEmpty else { return }
        // Chat-tab auto-drive; skip on the task-locked tab.
        guard lockedMode != .task else { return }
        if lockedMode == nil { mode = .chat }
        if let wanted = env["RELAY_UITEST_MODEL"]?.lowercased(),
           let match = models.first(where: { $0.supports(.chat) && ($0.id.lowercased().contains(wanted) || $0.label.lowercased().contains(wanted)) }) {
            selectModel(match)
        }
        prompt = promptText
        await sendCurrentPrompt()
    }
    #endif

    func refreshThreads() async {
        do {
            threads = Self.sortedThreads(try await client.fetchThreads(provider: nil, workspaceID: nil, limit: 80))
            jobs = Self.sortedJobs(try await client.fetchJobs(provider: nil, workspaceID: nil, limit: 20))
            mergeUpdatedJobs()
        } catch {
            if !CodexConsoleViewModel.isCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    /// True while any job shown in this conversation is still running/queued.
    var hasActiveConversationJob: Bool {
        messages.contains { $0.job?.status.isActive == true }
    }

    /// Long-lived poll loop started by the Task view's `.task`. While the view is on
    /// screen and a job is active, refresh job state every ~2s and pull the running
    /// job's latest output so its card shows live progress instead of a frozen card.
    /// Jobs are poll-only on the server (no log stream), so this is the update channel.
    func monitorActiveJobs() async {
        guard lockedMode == .task else { return }
        while !Task.isCancelled {
            if hasActiveConversationJob {
                await refreshActiveJobDetails()
                await refreshThreads()
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
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

    func sendCurrentPrompt() async {
        switch mode {
        case .chat:
            await sendChat()
        case .task:
            await runTask()
        }
    }

    func selectModel(_ model: CodexModelDescriptor) {
        if !model.supports(mode), let nextMode = model.modes.first {
            mode = nextMode
        }
        selectedModelID = model.id
        selectedEffort = nil  // fall back to the new model's default until the user picks
    }

    func selectWorkspace(_ workspace: CodexWorkspace) {
        selectedWorkspaceID = workspace.id
    }

    // MARK: - Workspace browsing / creation

    @Published private(set) var directoryListing: CodexWorkspaceDirectoryListing?
    @Published private(set) var isBrowsingDirectories = false
    @Published var workspaceActionError: String?

    /// Load the child directories under `path` (nil = workspace root) for the browse UI.
    func loadWorkspaceDirectories(path: String? = nil) async {
        isBrowsingDirectories = true
        defer { isBrowsingDirectories = false }
        do {
            directoryListing = try await client.fetchWorkspaceDirectories(path: path, query: nil)
            workspaceActionError = nil
        } catch {
            workspaceActionError = error.localizedDescription
        }
    }

    /// Register (or reuse) the directory at `path` as a workspace and select it.
    func selectBrowsedDirectory(path: String) async {
        do {
            let workspace = try await client.selectWorkspace(path: path)
            upsertWorkspace(workspace)
            selectedWorkspaceID = workspace.id
            workspaceActionError = nil
        } catch {
            workspaceActionError = error.localizedDescription
        }
    }

    /// Create a new workspace named `name` under `parentPath`, then select it.
    func createWorkspace(parentPath: String, name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        do {
            let workspace = try await client.createWorkspace(parentPath: parentPath, name: trimmed)
            upsertWorkspace(workspace)
            selectedWorkspaceID = workspace.id
            await loadWorkspaceDirectories(path: parentPath)
            workspaceActionError = nil
        } catch {
            workspaceActionError = error.localizedDescription
        }
    }

    private func upsertWorkspace(_ workspace: CodexWorkspace) {
        if let index = workspaces.firstIndex(where: { $0.id == workspace.id }) {
            workspaces[index] = workspace
        } else {
            workspaces.append(workspace)
        }
    }

    func startNewConversation() {
        currentThreadID = nil
        currentThreadProvider = nil
        currentThreadWorkspaceID = nil
        messages = []
    }

    /// Threads scoped to this tab's mode when locked (Chat tab hides Task threads, etc).
    var visibleThreads: [CodexThread] {
        guard let lockedMode else { return threads }
        return threads.filter { $0.mode == lockedMode }
    }

    /// Visible threads grouped by workspace, ordered by most-recent activity, for the
    /// thread drawer's "threads per folder" sections. Each group keeps its newest first.
    var threadsByWorkspace: [(workspace: String, threads: [CodexThread])] {
        let grouped = Dictionary(grouping: visibleThreads) { $0.workspaceLabel }
        return grouped
            .map { (workspace: $0.key, threads: Self.sortedThreads($0.value)) }
            .sorted { lhs, rhs in
                let l = lhs.threads.first?.updatedAt ?? .distantPast
                let r = rhs.threads.first?.updatedAt ?? .distantPast
                return l > r
            }
    }

    func openThread(_ thread: CodexThread) async {
        if let lockedMode, thread.mode != lockedMode { return }
        do {
            let detail = try await client.fetchThreadDetail(sessionID: thread.sessionId, provider: thread.provider)
            currentThreadID = detail.thread.sessionId
            currentThreadProvider = detail.thread.provider
            currentThreadWorkspaceID = detail.thread.workspaceId
            if lockedMode == nil {
                mode = detail.thread.mode
            }
            selectedWorkspaceID = detail.thread.workspaceId ?? selectedWorkspaceID
            if let threadModel = detail.thread.model,
               let model = models.first(where: { $0.id == threadModel && $0.provider == detail.thread.provider && $0.supports(mode) }) {
                selectedModelID = model.id
            } else if let model = models.first(where: { $0.provider == detail.thread.provider && $0.supports(mode) }) {
                selectedModelID = model.id
            }
            var items = detail.messages.map { message in
                RelayConversationItem(
                    role: message.role == .user ? .user : message.role == .assistant ? .assistant : .status,
                    text: message.text,
                    timestamp: message.timestamp ?? detail.thread.updatedAt ?? Date(),
                    provider: detail.thread.provider,
                    modelLabel: selectedModel?.label
                )
            }
            for job in detail.jobs {
                items.append(jobItem(job))
            }
            messages = items.sorted { $0.timestamp < $1.timestamp }
            errorMessage = nil
        } catch {
            errorMessage = error.localizedDescription
        }
    }

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
            return full.displayOutput ?? full.stdout ?? full.stderr ?? ""
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

    private func sendChat() async {
        guard let selectedModel else {
            errorMessage = "No chat model is available."
            return
        }
        guard selectedModel.supports(.chat) else {
            errorMessage = "\(selectedModel.label) is not available for Chat."
            return
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        prompt = ""
        isSending = true
        errorMessage = nil

        let userItem = RelayConversationItem(role: .user, text: text, provider: selectedModel.provider, modelLabel: selectedModel.label)
        let assistantID = UUID().uuidString
        messages.append(userItem)
        messages.append(RelayConversationItem(id: assistantID, role: .assistant, text: "", provider: selectedModel.provider, modelLabel: selectedModel.label, isStreaming: true))
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

        let request = CodexChatRequest(
            provider: selectedModel.provider.rawValue,
            model: selectedModel.id,
            threadId: currentThreadProvider == selectedModel.provider ? currentThreadID : nil,
            messages: history,
            options: selectedModel.defaultOptions
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

    private func runTask() async {
        guard let selectedModel else {
            errorMessage = "No task model is available."
            return
        }
        guard selectedModel.supports(.task) else {
            errorMessage = "\(selectedModel.label) is not available for Task."
            return
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !isSending else { return }
        prompt = ""
        isSending = true
        defer { isSending = false }

        let provider = taskProvider(for: selectedModel)
        let workspaceID = composeWorkspaceID
        // Only resume the existing session if it's the same provider AND same workspace,
        // otherwise the server rejects it ("session does not belong to workspace").
        let resumeID = (currentThreadProvider == provider && currentThreadWorkspaceID == workspaceID) ? currentThreadID : nil
        messages.append(RelayConversationItem(role: .user, text: text, provider: provider, modelLabel: selectedModel.label))
        do {
            let created = try await client.createJob(CodexCreateJobRequest(
                workspaceId: workspaceID,
                prompt: text,
                timeoutMs: 1_800_000,
                model: taskModelParameter(for: selectedModel),
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
            messages.append(jobItem(job))
            await refreshThreads()
        } catch {
            errorMessage = error.localizedDescription
            messages.append(RelayConversationItem(role: .status, text: error.localizedDescription, provider: provider))
        }
    }

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

    private func ensureSelectedWorkspace() {
        if selectedWorkspaceID == nil {
            selectedWorkspaceID = workspaces.first(where: { $0.id == "poc-vault" })?.id ?? workspaces.first?.id
        }
    }

    private func ensureSelectedModelSupportsMode() {
        let selected = selectedModelID.flatMap { selectedModelID in
            models.first { $0.id == selectedModelID }
        }
        if selected?.supports(mode) == true {
            return
        }

        let nextModelID = preferredModel(for: mode)?.id
        if selectedModelID != nextModelID {
            selectedModelID = nextModelID
        }
    }

    private func preferredModel(for mode: RelayInteractionMode) -> CodexModelDescriptor? {
        if let recommended = RelayModelDiscovery.recommendedModels(from: models, mode: mode, limit: 1).first {
            return recommended
        }

        for provider in providerOrder(for: mode) {
            if let model = models.first(where: { $0.provider == provider && $0.supports(mode) }) {
                return model
            }
        }
        return models.first { $0.supports(mode) }
    }

    private func providerOrder(for mode: RelayInteractionMode) -> [CodexProvider] {
        switch mode {
        case .chat:
            return [.azure, .bedrock, .codex, .claude]
        case .task:
            return [.codex, .claude, .bedrock, .azure]
        }
    }

    private func taskProvider(for model: CodexModelDescriptor) -> CodexProvider {
        switch model.provider {
        case .claude, .bedrock:
            return .claude
        case .codex, .azure:
            return .codex
        }
    }

    private func taskModelParameter(for model: CodexModelDescriptor) -> String? {
        // Prefer an explicit task model (e.g. "opus", "gpt-5-codex") from the catalog;
        // otherwise fall back to the chat id for dual-mode models, or the runner default.
        if let taskModel = model.taskModel, !taskModel.isEmpty { return taskModel }
        return model.supports(.chat) ? model.id : nil
    }

    private static func sortedThreads(_ threads: [CodexThread]) -> [CodexThread] {
        threads.sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
    }

    private static func sortedJobs(_ jobs: [CodexJob]) -> [CodexJob] {
        jobs.sorted { ($0.createdAt ?? .distantPast) > ($1.createdAt ?? .distantPast) }
    }
}
