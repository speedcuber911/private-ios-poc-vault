import Foundation

struct CodexWorkspace: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let path: String?
    let summary: String?
    let isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case workspaceId
        case slug
        case name
        case title
        case path
        case rootPath
        case summary
        case description
        case isDefault
        case defaultWorkspace = "default"
    }

    init(
        id: String,
        name: String,
        path: String? = nil,
        summary: String? = nil,
        isDefault: Bool = false
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.summary = summary
        self.isDefault = isDefault
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let path = try container.decodeLooseStringIfPresent(forKey: .path)
        let rootPath = try container.decodeLooseStringIfPresent(forKey: .rootPath)
        let name = try container.decodeLooseStringIfPresent(forKey: .name)
        let title = try container.decodeLooseStringIfPresent(forKey: .title)
        let workspaceID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateWorkspaceID = try container.decodeLooseStringIfPresent(forKey: .workspaceId)
        let slug = try container.decodeLooseStringIfPresent(forKey: .slug)
        let decodedPath = path ?? rootPath
        let decodedName = name ?? title
        let decodedID = workspaceID
            ?? alternateWorkspaceID
            ?? slug
            ?? decodedPath
            ?? decodedName

        guard let id = decodedID?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Workspace is missing an id.")
            )
        }

        self.id = id
        self.path = decodedPath?.trimmedNonEmpty
        self.name = decodedName?.trimmedNonEmpty
            ?? decodedPath.map { URL(fileURLWithPath: $0).lastPathComponent }
            ?? id
        let summary = try container.decodeLooseStringIfPresent(forKey: .summary)
        let description = try container.decodeLooseStringIfPresent(forKey: .description)
        let isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault)
        let defaultWorkspace = try container.decodeIfPresent(Bool.self, forKey: .defaultWorkspace)
        self.summary = summary ?? description
        self.isDefault = isDefault ?? defaultWorkspace ?? false
    }

    var detailText: String {
        if let path, !path.isEmpty {
            return path
        }
        if let summary, !summary.isEmpty {
            return summary
        }
        return id
    }
}

enum CodexProvider: String, CaseIterable, Identifiable, Codable {
    case codex
    case claude

    var id: String { rawValue }

    static let defaultProvider = CodexProvider.codex

    init(rawProvider: String?) {
        let normalized = rawProvider?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch normalized {
        case "claude", "anthropic":
            self = .claude
        case "codex", "openai", .none:
            self = .codex
        default:
            self = .codex
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawProvider: try? container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var displayName: String {
        switch self {
        case .codex:
            return "Codex"
        case .claude:
            return "Claude"
        }
    }

    var defaultModel: String {
        switch self {
        case .codex:
            return "gpt-5.5"
        case .claude:
            return "sonnet"
        }
    }

    var modelOptions: [String] {
        switch self {
        case .codex:
            return [
                "gpt-5.5",
                "gpt-5.4",
                "gpt-5.4-mini",
                "gpt-5.3-codex",
                "gpt-5.3-codex-spark",
                "gpt-5.2"
            ]
        case .claude:
            return [
                "sonnet",
                "opus",
                "haiku"
            ]
        }
    }

    var defaultReasoningEffort: CodexReasoningEffort {
        switch self {
        case .codex:
            return .xhigh
        case .claude:
            return .high
        }
    }

    var reasoningEffortOptions: [CodexReasoningEffort] {
        CodexReasoningEffort.allCases
    }
}

struct CodexSession: Decodable, Hashable, Identifiable {
    let id: String
    let provider: CodexProvider
    let workspaceId: String?
    let workspaceName: String?
    let cwd: String?
    let timestamp: Date?
    let updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id
        case sessionId
        case workspace
        case workspaceId
        case workspaceName
        case cwd
        case path
        case timestamp
        case createdAt
        case updatedAt
        case lastUsedAt
        case provider
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateID = try container.decodeLooseStringIfPresent(forKey: .sessionId)
        guard let id = (primaryID ?? alternateID)?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Session is missing an id.")
            )
        }

        let workspace = try? container.decodeIfPresent(CodexWorkspace.self, forKey: .workspace)
        let timestamp = try container.decodeLossyDateIfPresent(forKey: .timestamp)
        let createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        let updatedAt = try container.decodeLossyDateIfPresent(forKey: .updatedAt)
        let lastUsedAt = try container.decodeLossyDateIfPresent(forKey: .lastUsedAt)
        let cwd = try container.decodeLooseStringIfPresent(forKey: .cwd)
        let path = try container.decodeLooseStringIfPresent(forKey: .path)

        self.provider = (try container.decodeIfPresent(CodexProvider.self, forKey: .provider)) ?? .defaultProvider
        self.id = id
        self.workspaceId = (try container.decodeLooseStringIfPresent(forKey: .workspaceId))
            ?? workspace?.id
        self.workspaceName = (try container.decodeLooseStringIfPresent(forKey: .workspaceName))
            ?? workspace?.name
        self.cwd = cwd ?? path
        self.timestamp = timestamp ?? createdAt
        self.updatedAt = updatedAt ?? lastUsedAt ?? timestamp ?? createdAt
    }

    var displayTitle: String {
        workspaceName?.trimmedNonEmpty ?? workspaceId?.trimmedNonEmpty ?? "\(provider.displayName) thread"
    }

    var shortID: String {
        String(id.prefix(12))
    }
}

enum CodexJobStatus: Hashable, Codable {
    case queued
    case running
    case succeeded
    case failed
    case canceling
    case canceled
    case timeout
    case unknown(String)

    init(rawStatus: String?) {
        let normalized = rawStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch normalized {
        case "queued", "queue", "pending", "created", "submitted":
            self = .queued
        case "running", "active", "in_progress", "in-progress", "processing":
            self = .running
        case "succeeded", "success", "completed", "complete", "done", "passed":
            self = .succeeded
        case "failed", "failure", "errored", "error":
            self = .failed
        case "canceling", "cancelling":
            self = .canceling
        case "canceled", "cancelled":
            self = .canceled
        case "timeout", "timed_out", "timed-out":
            self = .timeout
        case .some(let value) where !value.isEmpty:
            self = .unknown(value)
        default:
            self = .unknown("unknown")
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self.init(rawStatus: value)
        } else {
            self = .unknown("unknown")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var rawValue: String {
        switch self {
        case .queued:
            return "queued"
        case .running:
            return "running"
        case .succeeded:
            return "succeeded"
        case .failed:
            return "failed"
        case .canceling:
            return "canceling"
        case .canceled:
            return "canceled"
        case .timeout:
            return "timeout"
        case .unknown(let value):
            return value
        }
    }

    var label: String {
        switch self {
        case .queued:
            return "Queued"
        case .running:
            return "Running"
        case .succeeded:
            return "Succeeded"
        case .failed:
            return "Failed"
        case .canceling:
            return "Canceling"
        case .canceled:
            return "Canceled"
        case .timeout:
            return "Timed out"
        case .unknown(let value):
            return value.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var isActive: Bool {
        switch self {
        case .queued, .running, .canceling:
            return true
        case .succeeded, .failed, .canceled, .timeout, .unknown:
            return false
        }
    }

    var needsAttention: Bool {
        switch self {
        case .failed, .timeout:
            return true
        case .queued, .running, .succeeded, .canceling, .canceled, .unknown:
            return false
        }
    }
}

struct CodexThread: Decodable, Hashable, Identifiable {
    let id: String
    let provider: CodexProvider
    let sessionId: String
    let workspaceId: String?
    let workspaceName: String?
    let cwd: String?
    let timestamp: Date?
    let updatedAt: Date?
    let jobCount: Int
    let activeJobCount: Int
    let lastJobId: String?
    let lastJobStatus: CodexJobStatus?
    let lastPrompt: String?
    let lastResult: String?
    let lastError: String?
    let hasSessionFile: Bool
    let isSmokeTest: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case provider
        case sessionId
        case workspaceId
        case workspaceName
        case cwd
        case path
        case timestamp
        case createdAt
        case updatedAt
        case lastUsedAt
        case jobCount
        case activeJobCount
        case lastJobId
        case lastJobStatus
        case lastPrompt
        case lastResult
        case lastError
        case hasSessionFile
        case isSmokeTest
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let sessionID = try container.decodeLooseStringIfPresent(forKey: .sessionId)
        guard let id = (primaryID ?? sessionID)?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Thread is missing an id.")
            )
        }

        let cwd = try container.decodeLooseStringIfPresent(forKey: .cwd)
        let path = try container.decodeLooseStringIfPresent(forKey: .path)
        let timestamp = try container.decodeLossyDateIfPresent(forKey: .timestamp)
        let createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        let updatedAt = try container.decodeLossyDateIfPresent(forKey: .updatedAt)
        let lastUsedAt = try container.decodeLossyDateIfPresent(forKey: .lastUsedAt)

        self.id = id
        self.provider = (try container.decodeIfPresent(CodexProvider.self, forKey: .provider)) ?? .defaultProvider
        self.sessionId = sessionID?.trimmedNonEmpty ?? id
        self.workspaceId = try container.decodeLooseStringIfPresent(forKey: .workspaceId)
        self.workspaceName = try container.decodeLooseStringIfPresent(forKey: .workspaceName)
        self.cwd = cwd ?? path
        self.timestamp = timestamp ?? createdAt
        self.updatedAt = updatedAt ?? lastUsedAt ?? timestamp ?? createdAt
        self.jobCount = (try container.decodeIntegerIfPresent(forKey: .jobCount)) ?? 0
        self.activeJobCount = (try container.decodeIntegerIfPresent(forKey: .activeJobCount)) ?? 0
        self.lastJobId = try container.decodeLooseStringIfPresent(forKey: .lastJobId)
        self.lastJobStatus = try container.decodeIfPresent(CodexJobStatus.self, forKey: .lastJobStatus)
        self.lastPrompt = try container.decodeLooseStringIfPresent(forKey: .lastPrompt)
        self.lastResult = try container.decodeLooseStringIfPresent(forKey: .lastResult)
        self.lastError = try container.decodeLooseStringIfPresent(forKey: .lastError)
        self.hasSessionFile = (try container.decodeIfPresent(Bool.self, forKey: .hasSessionFile)) ?? true
        self.isSmokeTest = (try container.decodeIfPresent(Bool.self, forKey: .isSmokeTest)) ?? false
    }

    var displayTitle: String {
        Self.threadTitle(from: lastPrompt)
            ?? Self.threadTitle(from: lastResult)
            ?? Self.threadTitle(from: lastError)
            ?? workspaceLabel
    }

    var workspaceLabel: String {
        workspaceName?.trimmedNonEmpty ?? workspaceId?.trimmedNonEmpty ?? provider.displayName
    }

    var shortID: String {
        String(sessionId.prefix(12))
    }

    var previewText: String {
        lastPrompt?.trimmedNonEmpty
            ?? lastResult?.trimmedNonEmpty
            ?? lastError?.trimmedNonEmpty
            ?? cwd?.trimmedNonEmpty
            ?? sessionId
    }

    var feedPreview: String {
        lastResult?.trimmedNonEmpty
            ?? lastError?.trimmedNonEmpty
            ?? lastPrompt?.trimmedNonEmpty
            ?? cwd?.trimmedNonEmpty
            ?? sessionId
    }

    var hasActiveJobs: Bool {
        activeJobCount > 0 || lastJobStatus?.isActive == true
    }

    static func threadTitle(from value: String?) -> String? {
        guard var text = normalizedThreadText(value) else { return nil }
        if let pullRequestTitle = githubPullRequestTitle(in: text) {
            return pullRequestTitle
        }
        text = stripPromptLeadIns(text)

        let lowered = text.lowercased()
        if lowered.hasPrefix("read-only security audit") {
            return "Read-only security audit"
        }
        if lowered.contains("loading spinner"), lowered.contains("2 pr") {
            return "Review loading-spinner PRs"
        }
        if lowered.contains("shlok"), lowered.contains("2 pr") {
            return "Review Shlok's PRs"
        }

        return compactTitle(text)
    }

    private static func githubPullRequestTitle(in value: String) -> String? {
        let pattern = #"https?://github\.com/[^/\s]+/([^/\s]+)/pull/([0-9]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let nsRange = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: nsRange),
              match.numberOfRanges >= 3,
              let repoRange = Range(match.range(at: 1), in: value),
              let numberRange = Range(match.range(at: 2), in: value) else {
            return nil
        }
        return "\(value[repoRange]) PR #\(value[numberRange])"
    }

    private static func stripPromptLeadIns(_ value: String) -> String {
        var text = value
        replacePrefix("Review and merge Hey parikshit, I was adding these ", in: &text, with: "Review and merge ")
        replacePrefix("Hey parikshit can you ", in: &text)
        replacePrefix("Hey parikshit, can you ", in: &text)
        replacePrefix("Hey parikshit, ", in: &text)
        replacePrefix("Hey parikshit ", in: &text)
        return text
    }

    private static func replacePrefix(_ prefix: String, in text: inout String, with replacement: String = "") {
        guard let range = text.range(of: prefix, options: [.caseInsensitive, .anchored]) else { return }
        text.replaceSubrange(range, with: replacement)
    }

    private static func compactTitle(_ value: String) -> String? {
        var text = value.replacingOccurrences(
            of: #"https?://\S+"#,
            with: "",
            options: .regularExpression
        )
        text = normalizedThreadText(text) ?? text
        guard !text.isEmpty else { return nil }

        let limit = 76
        guard text.count > limit else { return text }
        return "\(text.prefix(limit).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }

    private static func normalizedThreadText(_ value: String?) -> String? {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmedNonEmpty
    }
}

struct CodexThreadDetail: Decodable, Hashable {
    let thread: CodexThread
    let messages: [CodexThreadMessage]
    let jobs: [CodexJob]

    enum CodingKeys: String, CodingKey {
        case thread
        case messages
        case jobs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.thread = try container.decode(CodexThread.self, forKey: .thread)
        self.messages = (try? container.decodeIfPresent([CodexThreadMessage].self, forKey: .messages)) ?? []
        self.jobs = (try? container.decodeIfPresent([CodexJob].self, forKey: .jobs)) ?? []
    }
}

enum CodexThreadMessageRole: String, Decodable, Hashable {
    case user
    case assistant
    case status

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = (try? container.decode(String.self))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch rawValue {
        case "user":
            self = .user
        case "assistant", "codex", "claude":
            self = .assistant
        default:
            self = .status
        }
    }
}

struct CodexThreadMessage: Decodable, Hashable, Identifiable {
    let role: CodexThreadMessageRole
    let timestamp: Date?
    let text: String

    enum CodingKeys: String, CodingKey {
        case role
        case timestamp
        case createdAt
        case text
        case content
        case message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.role = (try? container.decodeIfPresent(CodexThreadMessageRole.self, forKey: .role)) ?? .status
        let timestamp = try container.decodeLossyDateIfPresent(forKey: .timestamp)
        let createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        let text = try container.decodeLooseStringIfPresent(forKey: .text)
        let content = try container.decodeLooseStringIfPresent(forKey: .content)
        let message = try container.decodeLooseStringIfPresent(forKey: .message)
        self.timestamp = timestamp ?? createdAt
        let resolvedText = text ?? content ?? message ?? ""
        self.text = resolvedText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var id: String {
        let timestampValue = timestamp?.timeIntervalSince1970.description ?? "undated"
        return "\(role.rawValue)-\(timestampValue)-\(text)"
    }
}

enum CodexThreadChatAlignment: Hashable {
    case leading
    case trailing
    case center
}

struct CodexThreadChatItem: Hashable, Identifiable {
    enum Kind: Hashable {
        case message
        case progressSummary
    }

    let role: CodexThreadMessageRole
    let text: String
    let timestamp: Date?
    let isError: Bool
    let sourceID: String
    let kind: Kind
    let progressCount: Int

    var id: String { sourceID }

    var alignment: CodexThreadChatAlignment {
        if kind == .progressSummary {
            return .leading
        }
        switch role {
        case .user:
            return .trailing
        case .assistant:
            return .leading
        case .status:
            return .center
        }
    }

    var speakerLabel: String {
        if kind == .progressSummary {
            return "Thinking"
        }
        switch role {
        case .user:
            return "You"
        case .assistant:
            return "Codex"
        case .status:
            return isError ? "Issue" : "Status"
        }
    }

    var isLong: Bool {
        kind == .progressSummary || text.count > 420 || text.filter(\.isNewline).count > 6
    }

    static func makeTranscript(
        detail: CodexThreadDetail?,
        thread: CodexThread?,
        latestJob: CodexJob?
    ) -> [CodexThreadChatItem] {
        if let detail, !detail.messages.isEmpty {
            return groupedTranscript(from: detail.messages)
        }

        var items: [CodexThreadChatItem] = []
        let prompt = latestJob?.prompt?.trimmedNonEmpty ?? thread?.lastPrompt?.trimmedNonEmpty
        if let prompt,
           let item = chatItem(role: .user, text: prompt, timestamp: latestJob?.createdAt ?? thread?.timestamp, sourceID: "thread-prompt") {
            items.append(item)
        }

        let answer = latestJob?.displayOutput?.trimmedNonEmpty ?? thread?.lastResult?.trimmedNonEmpty
        if let answer,
           let item = chatItem(role: .assistant, text: answer, timestamp: latestJob?.completedAt ?? thread?.updatedAt, sourceID: "thread-answer") {
            items.append(item)
        }

        let error = latestJob?.errorMessage?.trimmedNonEmpty ?? thread?.lastError?.trimmedNonEmpty
        if answer == nil,
           let error,
           let item = chatItem(role: .status, text: error, timestamp: latestJob?.completedAt ?? thread?.updatedAt, isError: true, sourceID: "thread-error") {
            items.append(item)
        }

        let workingProviderName = thread?.provider.displayName
            ?? latestJob?.provider.displayName
            ?? CodexProvider.defaultProvider.displayName
        if items.isEmpty,
           thread?.hasActiveJobs == true,
           let item = chatItem(
               role: .status,
               text: "\(workingProviderName) is working on this thread.",
               timestamp: thread?.updatedAt,
               sourceID: "thread-working"
           ) {
            items.append(item)
        }

        return items
    }

    private static func groupedTranscript(from messages: [CodexThreadMessage]) -> [CodexThreadChatItem] {
        var items: [CodexThreadChatItem] = []
        var pendingAssistantMessages: [(offset: Int, message: CodexThreadMessage)] = []

        func flushAssistantMessages() {
            guard !pendingAssistantMessages.isEmpty else { return }
            defer { pendingAssistantMessages.removeAll() }

            if pendingAssistantMessages.count == 1,
               let pending = pendingAssistantMessages.first,
               let item = chatItem(
                   role: .assistant,
                   text: pending.message.text,
                   timestamp: pending.message.timestamp,
                   sourceID: "message-\(pending.offset)-\(pending.message.id)"
               ) {
                items.append(item)
                return
            }

            let progressMessages = pendingAssistantMessages.dropLast()
            if !progressMessages.isEmpty {
                let progressText = progressMessages
                    .enumerated()
                    .map { index, pending in
                        let text = pending.message.text
                            .trimmingCharacters(in: .whitespacesAndNewlines)
                            .replacingOccurrences(of: "\n\n", with: "\n")
                        return "\(index + 1). \(text)"
                    }
                    .joined(separator: "\n\n")
                if let first = progressMessages.first,
                   let item = chatItem(
                       role: .status,
                       text: progressText,
                       timestamp: first.message.timestamp,
                       sourceID: "progress-\(first.offset)-\(progressMessages.count)",
                       kind: .progressSummary,
                       progressCount: progressMessages.count
                   ) {
                    items.append(item)
                }
            }

            if let final = pendingAssistantMessages.last,
               let item = chatItem(
                   role: .assistant,
                   text: final.message.text,
                   timestamp: final.message.timestamp,
                   sourceID: "message-\(final.offset)-\(final.message.id)"
               ) {
                items.append(item)
            }
        }

        for (index, message) in messages.enumerated() {
            switch message.role {
            case .assistant:
                pendingAssistantMessages.append((index, message))
            case .user, .status:
                flushAssistantMessages()
                if let item = chatItem(
                    role: message.role,
                    text: message.text,
                    timestamp: message.timestamp,
                    isError: false,
                    sourceID: "message-\(index)-\(message.id)"
                ) {
                    items.append(item)
                }
            }
        }

        flushAssistantMessages()
        return items
    }

    private static func chatItem(
        role: CodexThreadMessageRole,
        text: String?,
        timestamp: Date?,
        isError: Bool = false,
        sourceID: String,
        kind: Kind = .message,
        progressCount: Int = 0
    ) -> CodexThreadChatItem? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        return CodexThreadChatItem(
            role: role,
            text: text,
            timestamp: timestamp,
            isError: isError,
            sourceID: sourceID,
            kind: kind,
            progressCount: progressCount
        )
    }
}

struct CodexTranscriptionResponse: Decodable, Hashable {
    let text: String
    let provider: String?
    let model: String?
    let audioBytes: Int?
    let durationMilliseconds: Int?
}

struct CodexThreadFeedItem: Hashable, Identifiable {
    enum Source: Hashable {
        case thread(CodexThread)
        case pendingJob(CodexJob)
    }

    let source: Source

    var id: String {
        switch source {
        case .thread(let thread):
            return "thread-\(thread.sessionId)"
        case .pendingJob(let job):
            return "job-\(job.id)"
        }
    }

    var title: String {
        switch source {
        case .thread(let thread):
            return thread.displayTitle
        case .pendingJob(let job):
            return CodexThread.threadTitle(from: job.displayPrompt) ?? job.displayPrompt
        }
    }

    var preview: String {
        switch source {
        case .thread(let thread):
            return thread.feedPreview
        case .pendingJob(let job):
            if let output = job.displayOutput?.trimmedNonEmpty {
                return output
            }
            if job.status.isActive {
                return "Starting on EC2. The thread will attach as soon as \(job.provider.displayName) opens a session."
            }
            return job.errorMessage?.trimmedNonEmpty ?? "No thread session was captured for this run."
        }
    }

    var workspaceLabel: String {
        switch source {
        case .thread(let thread):
            return thread.workspaceLabel
        case .pendingJob(let job):
            return job.workspaceName?.trimmedNonEmpty ?? job.workspaceId?.trimmedNonEmpty ?? job.provider.displayName
        }
    }

    var workspaceID: String? {
        switch source {
        case .thread(let thread):
            return thread.workspaceId
        case .pendingJob(let job):
            return job.workspaceId
        }
    }

    var updatedAt: Date? {
        switch source {
        case .thread(let thread):
            return thread.updatedAt ?? thread.timestamp
        case .pendingJob(let job):
            return job.updatedAt ?? job.createdAt
        }
    }

    var status: CodexJobStatus? {
        switch source {
        case .thread(let thread):
            return thread.lastJobStatus
        case .pendingJob(let job):
            return job.status
        }
    }

    var jobID: String? {
        switch source {
        case .thread(let thread):
            return thread.lastJobId
        case .pendingJob(let job):
            return job.id
        }
    }

    var sessionID: String? {
        switch source {
        case .thread(let thread):
            return thread.sessionId
        case .pendingJob:
            return nil
        }
    }

    var isPendingSession: Bool {
        if case .pendingJob = source {
            return true
        }
        return false
    }

    var isSmokeTest: Bool {
        if case .thread(let thread) = source {
            return thread.isSmokeTest
        }
        return false
    }

    var shortID: String {
        switch source {
        case .thread(let thread):
            return thread.shortID
        case .pendingJob(let job):
            return String(job.id.prefix(12))
        }
    }

    var isActive: Bool {
        switch source {
        case .thread(let thread):
            return thread.hasActiveJobs
        case .pendingJob(let job):
            return job.status.isActive
        }
    }

    static func makeFeed(threads: [CodexThread], jobs: [CodexJob]) -> [CodexThreadFeedItem] {
        let visibleThreads = threads.filter { !$0.isSmokeTest }
        let threadSessionIDs = Set(visibleThreads.map(\.sessionId))
        let threadJobIDs = Set(visibleThreads.compactMap(\.lastJobId))
        let threadItems = visibleThreads.map { CodexThreadFeedItem(source: .thread($0)) }
        let pendingJobItems = jobs
            .filter { job in
                if threadJobIDs.contains(job.id) { return false }
                if let sessionID = job.threadSessionId,
                   threadSessionIDs.contains(sessionID),
                   !job.status.needsAttention {
                    return false
                }
                return job.status.isActive
                    || job.status.needsAttention
            }
            .map { CodexThreadFeedItem(source: .pendingJob($0)) }

        return (pendingJobItems + threadItems).sorted {
            ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast)
        }
    }
}

enum CodexReasoningEffort: String, CaseIterable, Identifiable, Codable {
    case low
    case medium
    case high
    case xhigh

    var id: String { rawValue }

    var label: String {
        switch self {
        case .low:
            return "Low"
        case .medium:
            return "Medium"
        case .high:
            return "High"
        case .xhigh:
            return "XHigh"
        }
    }
}

enum CodexRunMode: String, CaseIterable, Identifiable, Codable {
    case quality
    case speed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .quality:
            return "Quality"
        case .speed:
            return "Speed"
        }
    }

    var effectiveReasoningEffort: CodexReasoningEffort? {
        switch self {
        case .quality:
            return nil
        case .speed:
            return .low
        }
    }
}

enum ClaudePermissionMode: String, CaseIterable, Identifiable, Codable {
    case acceptEdits
    case auto
    case bypassPermissions
    case defaultMode = "default"
    case dontAsk
    case plan

    var id: String { rawValue }

    var label: String {
        switch self {
        case .acceptEdits:
            return "Accept Edits"
        case .auto:
            return "Auto"
        case .bypassPermissions:
            return "Bypass"
        case .defaultMode:
            return "Default"
        case .dontAsk:
            return "Don't Ask"
        case .plan:
            return "Plan"
        }
    }
}

enum CodexDisplayLimits {
    static let answerCharacters = 24_000
    static let promptCharacters = 12_000
    static let rawActivityCharacters = 8_000
}

struct CodexTextPreview: Equatable {
    let text: String
    let originalCharacterCount: Int
    let isTruncated: Bool

    var hasText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func bounded(_ value: String?, limit: Int, emptyText: String) -> CodexTextPreview {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else {
            return CodexTextPreview(text: emptyText, originalCharacterCount: 0, isTruncated: false)
        }

        let originalCount = trimmed.count
        guard originalCount > limit else {
            return CodexTextPreview(text: trimmed, originalCharacterCount: originalCount, isTruncated: false)
        }

        let suffix = "\n\n[Preview truncated. Open the full activity log only when needed.]"
        return CodexTextPreview(
            text: String(trimmed.prefix(limit)) + suffix,
            originalCharacterCount: originalCount,
            isTruncated: true
        )
    }
}

struct CodexJob: Decodable, Hashable, Identifiable {
    let id: String
    let provider: CodexProvider
    let workspaceId: String?
    let workspaceName: String?
    let status: CodexJobStatus
    let prompt: String?
    let createdAt: Date?
    let updatedAt: Date?
    let startedAt: Date?
    let completedAt: Date?
    let timeoutMs: Int?
    let exitCode: Int?
    let stdout: String?
    let stderr: String?
    let result: String?
    let errorMessage: String?
    let durationMs: Int?
    let timedOut: Bool
    let certSubject: String?
    let model: String?
    let reasoningEffort: String?
    let permissionMode: String?
    let skills: [String]
    let logsIncluded: String?
    let sessionId: String?
    let resumeSessionId: String?
    let stdoutBytes: Int?
    let stderrBytes: Int?
    let resultBytes: Int?
    let stdoutTruncated: Bool
    let stderrTruncated: Bool
    let resultTruncated: Bool
    let attachments: [CodexJobAttachmentReference]

    enum CodingKeys: String, CodingKey {
        case id
        case jobId
        case provider
        case workspace
        case workspaceId
        case workspaceName
        case status
        case state
        case prompt
        case createdAt
        case updatedAt
        case startedAt
        case completedAt
        case finishedAt
        case timeoutMs
        case timeout
        case exitCode
        case stdout
        case stderr
        case result
        case output
        case error
        case errorMessage
        case message
        case durationMs
        case timedOut
        case certSubject
        case model
        case reasoningEffort
        case permissionMode
        case skills
        case logsIncluded
        case sessionId
        case resumeSessionId
        case stdoutBytes
        case stderrBytes
        case resultBytes
        case stdoutTruncated
        case stderrTruncated
        case resultTruncated
        case attachments
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateID = try container.decodeLooseStringIfPresent(forKey: .jobId)
        let decodedID = primaryID ?? alternateID
        guard let id = decodedID?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Job is missing an id.")
            )
        }

        let workspace = try? container.decodeIfPresent(CodexWorkspace.self, forKey: .workspace)
        let status = try container.decodeIfPresent(CodexJobStatus.self, forKey: .status)
        let state = try container.decodeIfPresent(CodexJobStatus.self, forKey: .state)
        let completedAt = try container.decodeLossyDateIfPresent(forKey: .completedAt)
        let finishedAt = try container.decodeLossyDateIfPresent(forKey: .finishedAt)
        let timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs)
        let timeout = try container.decodeIntegerIfPresent(forKey: .timeout)
        let result = try container.decodeLooseStringIfPresent(forKey: .result)
        let output = try container.decodeLooseStringIfPresent(forKey: .output)
        let errorMessage = try container.decodeLooseStringIfPresent(forKey: .errorMessage)
        let error = try container.decodeLooseStringIfPresent(forKey: .error)
        let message = try container.decodeLooseStringIfPresent(forKey: .message)

        self.id = id
        self.provider = (try container.decodeIfPresent(CodexProvider.self, forKey: .provider)) ?? .defaultProvider
        self.workspaceId = (try container.decodeLooseStringIfPresent(forKey: .workspaceId))
            ?? workspace?.id
        self.workspaceName = (try container.decodeLooseStringIfPresent(forKey: .workspaceName))
            ?? workspace?.name
        self.status = status ?? state ?? .unknown("unknown")
        self.prompt = try container.decodeLooseStringIfPresent(forKey: .prompt)
        self.createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        self.updatedAt = try container.decodeLossyDateIfPresent(forKey: .updatedAt)
        self.startedAt = try container.decodeLossyDateIfPresent(forKey: .startedAt)
        self.completedAt = completedAt ?? finishedAt
        self.timeoutMs = timeoutMs ?? timeout
        self.exitCode = try container.decodeIntegerIfPresent(forKey: .exitCode)
        self.stdout = try container.decodeLooseStringIfPresent(forKey: .stdout)
        self.stderr = try container.decodeLooseStringIfPresent(forKey: .stderr)
        self.result = result ?? output
        self.errorMessage = errorMessage ?? error ?? message
        self.durationMs = try container.decodeIntegerIfPresent(forKey: .durationMs)
        self.timedOut = (try container.decodeIfPresent(Bool.self, forKey: .timedOut)) ?? false
        self.certSubject = try container.decodeLooseStringIfPresent(forKey: .certSubject)
        self.model = try container.decodeLooseStringIfPresent(forKey: .model)
        self.reasoningEffort = try container.decodeLooseStringIfPresent(forKey: .reasoningEffort)
        self.permissionMode = try container.decodeLooseStringIfPresent(forKey: .permissionMode)
        self.skills = (try? container.decode([String].self, forKey: .skills)) ?? []
        self.logsIncluded = try container.decodeLooseStringIfPresent(forKey: .logsIncluded)
        self.sessionId = try container.decodeLooseStringIfPresent(forKey: .sessionId)
        let resumeSessionID = try container.decodeLooseStringIfPresent(forKey: .resumeSessionId)
        self.resumeSessionId = resumeSessionID
        self.stdoutBytes = try container.decodeIntegerIfPresent(forKey: .stdoutBytes)
        self.stderrBytes = try container.decodeIntegerIfPresent(forKey: .stderrBytes)
        self.resultBytes = try container.decodeIntegerIfPresent(forKey: .resultBytes)
        self.stdoutTruncated = (try container.decodeIfPresent(Bool.self, forKey: .stdoutTruncated)) ?? false
        self.stderrTruncated = (try container.decodeIfPresent(Bool.self, forKey: .stderrTruncated)) ?? false
        self.resultTruncated = (try container.decodeIfPresent(Bool.self, forKey: .resultTruncated)) ?? false
        self.attachments = (try? container.decodeIfPresent([CodexJobAttachmentReference].self, forKey: .attachments)) ?? []
    }

    var displayPrompt: String {
        prompt?.trimmedNonEmpty ?? "Untitled \(provider.displayName) job"
    }

    var displayOutput: String? {
        if let result = result?.trimmedNonEmpty,
           let cleaned = CodexOutputCleaner.cleanAnswer(result).trimmedNonEmpty {
            return cleaned
        }
        if case .succeeded = status {
            return nil
        }
        return errorMessage?.trimmedNonEmpty
    }

    var displayOutputPreview: CodexTextPreview {
        CodexTextPreview.bounded(
            displayOutput,
            limit: CodexDisplayLimits.answerCharacters,
            emptyText: ""
        )
    }

    var promptPreview: CodexTextPreview {
        CodexTextPreview.bounded(
            prompt,
            limit: CodexDisplayLimits.promptCharacters,
            emptyText: "No prompt captured."
        )
    }

    var threadSessionId: String? {
        sessionId?.trimmedNonEmpty ?? resumeSessionId?.trimmedNonEmpty
    }

    var hasTruncatedServerOutput: Bool {
        stdoutTruncated || stderrTruncated || resultTruncated
    }

    var rawActivityPreview: CodexTextPreview {
        let sections = [
            ("Saved answer", result),
            ("Stdout", stdout),
            ("Stderr", stderr),
            ("Error", errorMessage)
        ]
        return Self.activityPreview(
            sections: sections,
            limit: CodexDisplayLimits.rawActivityCharacters,
            serverTruncated: hasTruncatedServerOutput
        )
    }

    var rawActivityOutput: String? {
        let parts = [
            result.map { ("Saved answer", $0) },
            stdout.map { ("Stdout", $0) },
            stderr.map { ("Stderr", $0) },
            errorMessage.map { ("Error", $0) }
        ]
        .compactMap { item -> String? in
            guard let (label, value) = item, let trimmed = value.trimmedNonEmpty else { return nil }
            return "## \(label)\n\n\(trimmed)"
        }
        return parts.joined(separator: "\n\n---\n\n").trimmedNonEmpty
    }

    var hasOperationalFields: Bool {
        workspaceId != nil
            || prompt != nil
            || createdAt != nil
            || updatedAt != nil
            || stdout != nil
            || stderr != nil
            || result != nil
            || errorMessage != nil
            || durationMs != nil
            || certSubject != nil
            || logsIncluded != nil
            || sessionId != nil
            || resumeSessionId != nil
            || !attachments.isEmpty
            || hasTruncatedServerOutput
            || status != .unknown("unknown")
    }

    private static func activityPreview(
        sections: [(String, String?)],
        limit: Int,
        serverTruncated: Bool
    ) -> CodexTextPreview {
        var rendered = ""

        for (label, value) in sections {
            guard let trimmed = value?.trimmedNonEmpty else { continue }
            let separator = rendered.isEmpty ? "" : "\n\n---\n\n"
            let header = "\(separator)## \(label)\n\n"
            rendered += header + trimmed
        }

        if rendered.trimmedNonEmpty == nil {
            rendered = "No raw activity captured."
        }

        let originalCount = rendered.count
        var didTruncate = serverTruncated

        if originalCount > limit {
            rendered = """
            [Showing latest activity. Older log output is hidden in this preview.]

            \(String(rendered.suffix(limit)))
            """
            didTruncate = true
        } else if serverTruncated {
            rendered = """
            [Showing latest activity from the server preview.]

            \(rendered)
            """
        }

        return CodexTextPreview(
            text: rendered,
            originalCharacterCount: originalCount,
            isTruncated: didTruncate
        )
    }
}

struct CodexJobAttachmentReference: Decodable, Hashable, Identifiable {
    let filename: String
    let contentType: String?
    let bytes: Int?
    let path: String?

    var id: String {
        path?.trimmedNonEmpty ?? filename
    }
}

struct CodexSkill: Decodable, Hashable, Identifiable {
    let id: String
    let name: String?
    let title: String
    let provider: CodexProvider?
    let group: String
    let summary: String

    enum CodingKeys: String, CodingKey {
        case id
        case name
        case title
        case provider
        case group
        case summary
        case description
    }

    init(
        id: String,
        name: String? = nil,
        title: String? = nil,
        provider: CodexProvider? = nil,
        group: String = "Skills",
        summary: String = ""
    ) {
        self.id = id
        self.name = name
        self.title = title?.trimmedNonEmpty ?? Self.titleize(name ?? id)
        self.provider = provider
        self.group = group.trimmedNonEmpty ?? "Skills"
        self.summary = summary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decodedID = try container.decodeLooseStringIfPresent(forKey: .id)
        let decodedName = try container.decodeLooseStringIfPresent(forKey: .name)
        guard let id = decodedID ?? decodedName else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Skill is missing an id.")
            )
        }

        let title = try container.decodeLooseStringIfPresent(forKey: .title)
        let group = try container.decodeLooseStringIfPresent(forKey: .group)
        let summary = try container.decodeLooseStringIfPresent(forKey: .summary)
        let description = try container.decodeLooseStringIfPresent(forKey: .description)

        self.id = id
        self.name = decodedName
        self.title = title ?? Self.titleize(decodedName ?? id)
        self.provider = try container.decodeIfPresent(CodexProvider.self, forKey: .provider)
        self.group = group ?? "Skills"
        self.summary = summary ?? description ?? ""
    }

    var searchText: String {
        "\(id) \(name ?? "") \(title) \(group) \(summary)".lowercased()
    }

    var chipLabel: String {
        title.trimmedNonEmpty ?? Self.titleize(name ?? id)
    }

    private static func titleize(_ value: String) -> String {
        value
            .replacingOccurrences(of: ":", with: " ")
            .replacingOccurrences(of: "-", with: " ")
            .replacingOccurrences(of: "_", with: " ")
            .split(separator: " ")
            .map { word in
                word.prefix(1).uppercased() + String(word.dropFirst())
            }
            .joined(separator: " ")
    }
}

struct CodexJobAttachment: Encodable, Hashable, Identifiable {
    let id: UUID
    let filename: String
    let contentType: String
    let dataBase64: String
    let byteCount: Int

    init(
        id: UUID = UUID(),
        filename: String,
        contentType: String,
        data: Data
    ) {
        self.id = id
        self.filename = Self.cleanFilename(filename)
        self.contentType = contentType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "application/octet-stream" : contentType
        self.dataBase64 = data.base64EncodedString()
        self.byteCount = data.count
    }

    enum CodingKeys: String, CodingKey {
        case filename
        case contentType
        case dataBase64
    }

    private static func cleanFilename(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = trimmed.isEmpty ? "attachment.bin" : trimmed
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        let cleaned = fallback.unicodeScalars.map { scalar -> Character in
            allowed.contains(scalar) ? Character(scalar) : "-"
        }
        let result = String(cleaned).prefix(120)
        return result.isEmpty ? "attachment.bin" : String(result)
    }
}

struct CodexCreateJobRequest: Encodable {
    let workspaceId: String
    let prompt: String
    let timeoutMs: Int?
    let model: String?
    let reasoningEffort: String?
    let permissionMode: ClaudePermissionMode?
    let provider: CodexProvider
    let skills: [String]?
    let attachments: [CodexJobAttachment]?
    let resumeSessionId: String?

    init(
        workspaceId: String,
        prompt: String,
        timeoutMs: Int?,
        model: String? = nil,
        reasoningEffort: String? = nil,
        provider: CodexProvider = .defaultProvider,
        permissionMode: ClaudePermissionMode? = nil,
        skills: [String] = [],
        attachments: [CodexJobAttachment] = [],
        resumeSessionId: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.prompt = prompt
        self.timeoutMs = timeoutMs
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.permissionMode = permissionMode
        self.provider = provider
        self.skills = skills.isEmpty ? nil : skills
        self.attachments = attachments.isEmpty ? nil : attachments
        self.resumeSessionId = resumeSessionId
    }
}

enum CodexOutputCleaner {
    static func cleanAnswer(_ text: String) -> String {
        let stripped = stripANSI(text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !looksLikeRawTranscript(stripped) else { return "" }
        return stripped
    }

    private static func looksLikeRawTranscript(_ text: String) -> Bool {
        text.hasPrefix("OpenAI Codex ")
            || text.contains("\nworkdir: ")
            || text.contains("\nreasoning effort: ")
            || text.contains("\nexec\n")
            || text.contains("\nsucceeded in ")
    }

    private static func stripANSI(_ text: String) -> String {
        text.replacingOccurrences(
            of: #"\u001B\[[0-?]*[ -/]*[@-~]"#,
            with: "",
            options: .regularExpression
        )
    }
}

struct CodexCreateJobResponse: Decodable {
    let id: String
    let job: CodexJob?

    enum CodingKeys: String, CodingKey {
        case id
        case jobId
        case job
        case data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nestedJob = (try? container.decodeIfPresent(CodexJob.self, forKey: .job))
            ?? (try? container.decodeIfPresent(CodexJob.self, forKey: .data))
        let topLevelJob = try? CodexJob(from: decoder)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateID = try container.decodeLooseStringIfPresent(forKey: .jobId)
        let decodedID = primaryID
            ?? alternateID
            ?? nestedJob?.id
            ?? topLevelJob?.id

        guard let id = decodedID?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Create job response is missing an id.")
            )
        }

        self.id = id
        if let nestedJob {
            self.job = nestedJob
        } else if let topLevelJob, topLevelJob.hasOperationalFields {
            self.job = topLevelJob
        } else {
            self.job = nil
        }
    }
}

struct CodexHealth: Decodable, Hashable {
    let status: String
    let message: String?
    let version: String?
    let isHealthy: Bool

    enum CodingKeys: String, CodingKey {
        case status
        case state
        case ok
        case healthy
        case message
        case version
    }

    init(status: String, message: String? = nil, version: String? = nil, isHealthy: Bool? = nil) {
        self.status = status
        self.message = message
        self.version = version
        self.isHealthy = isHealthy ?? Self.statusIsHealthy(status)
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let statusValue = try container.decodeLooseStringIfPresent(forKey: .status)
        let state = try container.decodeLooseStringIfPresent(forKey: .state)
        let ok = try container.decodeIfPresent(Bool.self, forKey: .ok)
        let healthy = try container.decodeIfPresent(Bool.self, forKey: .healthy)
        let status = statusValue ?? state ?? "ok"
        let explicitHealth = ok ?? healthy

        self.status = status
        self.message = try container.decodeLooseStringIfPresent(forKey: .message)
        self.version = try container.decodeLooseStringIfPresent(forKey: .version)
        self.isHealthy = explicitHealth ?? Self.statusIsHealthy(status)
    }

    private static func statusIsHealthy(_ status: String) -> Bool {
        let normalized = status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return ["ok", "up", "healthy", "ready", "online"].contains(normalized)
    }
}

private struct CodexLooseString: Decodable {
    let value: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = ""
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let integer = try? container.decode(Int.self) {
            value = String(integer)
        } else if let double = try? container.decode(Double.self) {
            value = String(double)
        } else if let bool = try? container.decode(Bool.self) {
            value = bool ? "true" : "false"
        } else {
            let json = try CodexJSONValue(from: decoder)
            value = json.prettyPrinted
        }
    }
}

private enum CodexJSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: CodexJSONValue])
    case array([CodexJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: CodexJSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([CodexJSONValue].self))
        }
    }

    var foundationValue: Any {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value
        case .bool(let value):
            return value
        case .object(let values):
            return values.mapValues(\.foundationValue)
        case .array(let values):
            return values.map(\.foundationValue)
        case .null:
            return NSNull()
        }
    }

    var prettyPrinted: String {
        guard JSONSerialization.isValidJSONObject(foundationValue),
              let data = try? JSONSerialization.data(withJSONObject: foundationValue, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return String(describing: foundationValue)
        }
        return string
    }
}

private extension KeyedDecodingContainer {
    func decodeLooseStringIfPresent(forKey key: Key) throws -> String? {
        try decodeIfPresent(CodexLooseString.self, forKey: key)?.value.trimmedNonEmpty
    }

    func decodeIntegerIfPresent(forKey key: Key) throws -> Int? {
        if let integer = try decodeIfPresent(Int.self, forKey: key) {
            return integer
        }
        if let double = try decodeIfPresent(Double.self, forKey: key) {
            return Int(double)
        }
        if let string = try decodeIfPresent(CodexLooseString.self, forKey: key)?.value,
           let integer = Int(string) {
            return integer
        }
        return nil
    }

    func decodeLossyDateIfPresent(forKey key: Key) throws -> Date? {
        if let date = try? decodeIfPresent(Date.self, forKey: key) {
            return date
        }
        if let string = try decodeIfPresent(CodexLooseString.self, forKey: key)?.value {
            return CodexDateParser.parse(string)
        }
        return nil
    }
}

private enum CodexDateParser {
    static func parse(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let seconds = Double(trimmed) {
            return Date(timeIntervalSince1970: seconds)
        }
        if let date = fractional.date(from: trimmed) {
            return date
        }
        return standard.date(from: trimmed)
    }

    private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

struct CodexErrorSummary: Equatable {
    let statusCode: Int?
    let statusLine: String
    let summary: String
    let rawResponse: String

    init(message: String) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let statusCode = Self.httpStatusCode(in: trimmed)
        let rawResponse = Self.rawResponse(from: trimmed)
        let parsedSummary = Self.htmlMessage(from: rawResponse)
            ?? Self.jsonMessage(from: rawResponse)
            ?? Self.plainSummary(from: rawResponse)
            ?? Self.plainSummary(from: trimmed)
            ?? "Request failed"

        self.statusCode = statusCode
        self.statusLine = statusCode.map { "HTTP \($0)" } ?? "Request failed"
        self.summary = parsedSummary
        self.rawResponse = rawResponse.isEmpty ? trimmed : rawResponse
    }

    private static func httpStatusCode(in message: String) -> Int? {
        guard let range = message.range(of: #"HTTP\s+(\d{3})"#, options: .regularExpression) else {
            return nil
        }
        return Int(message[range].split(separator: " ").last ?? "")
    }

    private static func rawResponse(from message: String) -> String {
        guard let range = message.range(of: ": ") else {
            return message
        }
        let prefix = message[..<range.lowerBound]
        if prefix.localizedCaseInsensitiveContains("HTTP")
            || prefix.localizedCaseInsensitiveContains("Codex request failed") {
            return String(message[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return message
    }

    private static func htmlMessage(from payload: String) -> String? {
        guard payload.localizedCaseInsensitiveContains("<html")
            || payload.localizedCaseInsensitiveContains("<p>")
            || payload.localizedCaseInsensitiveContains("<!doctype") else {
            return nil
        }
        if let message = firstCapture(in: payload, pattern: #"<p>\s*Message:\s*([^<]+)</p>"#) {
            return normalizeSentence(message)
        }
        if let title = firstCapture(in: payload, pattern: #"<title>\s*([^<]+)</title>"#) {
            return normalizeSentence(title)
        }
        return plainSummary(from: stripHTML(payload))
    }

    private static func jsonMessage(from payload: String) -> String? {
        guard let data = payload.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        for key in ["message", "error", "detail"] {
            if let value = object[key] as? String,
               let summary = plainSummary(from: value) {
                return summary
            }
        }
        return nil
    }

    private static func plainSummary(from value: String) -> String? {
        let cleaned = normalizeWhitespace(value)
        guard !cleaned.isEmpty else { return nil }
        if cleaned.localizedCaseInsensitiveContains("Codex request failed with HTTP "),
           let separator = cleaned.range(of: ": ") {
            return plainSummary(from: String(cleaned[separator.upperBound...]))
        }
        return cleaned
    }

    private static func stripHTML(_ value: String) -> String {
        value.replacingOccurrences(of: #"<[^>]+>"#, with: " ", options: .regularExpression)
    }

    private static func firstCapture(in value: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else {
            return nil
        }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: range),
              match.numberOfRanges > 1,
              let captureRange = Range(match.range(at: 1), in: value) else {
            return nil
        }
        return String(value[captureRange])
    }

    private static func normalizeSentence(_ value: String) -> String {
        var cleaned = normalizeWhitespace(value)
        while cleaned.last == "." {
            cleaned.removeLast()
        }
        return cleaned
    }

    private static func normalizeWhitespace(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&quot;", with: "\"")
            .replacingOccurrences(of: "&amp;", with: "&")
            .replacingOccurrences(of: "&lt;", with: "<")
            .replacingOccurrences(of: "&gt;", with: ">")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}

private extension String {
    var trimmedNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
