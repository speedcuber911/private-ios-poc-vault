import Foundation
import UIKit

struct RelayUsage: Hashable {
    var inputTokens: Int?
    var outputTokens: Int?

    var isEmpty: Bool { inputTokens == nil && outputTokens == nil }
}

enum RelayAttachmentLimits {
    static let maxCount = 6
    static let maxBytes = 8 * 1024 * 1024
    static let maxTotalBytes = 18 * 1024 * 1024
}

struct RelayDraftAttachment: Identifiable, Hashable {
    let id: UUID
    let filename: String
    let contentType: String
    let data: Data

    var isImage: Bool { contentType.lowercased().hasPrefix("image/") }
    var byteCount: Int { data.count }

    var jobAttachment: CodexJobAttachment {
        CodexJobAttachment(id: id, filename: filename, contentType: contentType, data: data)
    }

    var displayed: RelayDisplayedAttachment {
        RelayDisplayedAttachment(
            id: id.uuidString,
            filename: filename,
            contentType: contentType,
            byteCount: byteCount,
            kind: isImage ? .image : .file,
            payload: .local(data)
        )
    }

    static func make(filename: String, data: Data, contentType: String?) -> RelayDraftAttachment? {
        guard !data.isEmpty else { return nil }
        if let image = UIImage(data: data) {
            let originalType = (contentType ?? "").lowercased()
            let wantsPNG = originalType.contains("png") || filename.lowercased().hasSuffix(".png")
            let encoded: Data
            let type: String
            let name: String
            if wantsPNG, let png = image.pngData(), png.count <= RelayAttachmentLimits.maxBytes {
                encoded = png
                type = "image/png"
                name = replacingPathExtension(filename, with: "png")
            } else if let jpeg = jpegData(from: image, maxBytes: RelayAttachmentLimits.maxBytes) {
                encoded = jpeg
                type = "image/jpeg"
                name = replacingPathExtension(filename, with: "jpg")
            } else {
                return nil
            }
            return RelayDraftAttachment(id: UUID(), filename: name, contentType: type, data: encoded)
        }
        let type = (contentType?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false)
            ? contentType!.trimmingCharacters(in: .whitespacesAndNewlines)
            : mimeType(for: filename)
        return RelayDraftAttachment(id: UUID(), filename: filename, contentType: type, data: data)
    }

    private static func jpegData(from image: UIImage, maxBytes: Int) -> Data? {
        for quality in [0.82, 0.7, 0.55, 0.4, 0.28] as [CGFloat] {
            if let data = image.jpegData(compressionQuality: quality), data.count <= maxBytes {
                return data
            }
        }
        return image.jpegData(compressionQuality: 0.2)
    }

    private static func replacingPathExtension(_ filename: String, with ext: String) -> String {
        let base = URL(fileURLWithPath: filename).deletingPathExtension().lastPathComponent
        let cleaned = base.trimmingCharacters(in: .whitespacesAndNewlines)
        return "\(cleaned.isEmpty ? "photo" : cleaned).\(ext)"
    }

    private static func mimeType(for filename: String) -> String {
        switch URL(fileURLWithPath: filename).pathExtension.lowercased() {
        case "png": return "image/png"
        case "jpg", "jpeg": return "image/jpeg"
        case "gif": return "image/gif"
        case "webp": return "image/webp"
        case "heic": return "image/heic"
        case "pdf": return "application/pdf"
        case "txt": return "text/plain"
        case "md": return "text/markdown"
        case "json": return "application/json"
        default: return "application/octet-stream"
        }
    }
}

struct RelayDisplayedAttachment: Identifiable, Hashable {
    enum Kind: Hashable {
        case image
        case file
    }

    enum Payload: Hashable {
        case local(Data)
        case remote(String)
        case unavailable
    }

    let id: String
    let filename: String
    let contentType: String
    let byteCount: Int?
    let kind: Kind
    let payload: Payload

    var remoteURL: String? {
        if case .remote(let url) = payload { return url }
        return nil
    }

    static func from(_ attachment: CodexThreadAttachment) -> RelayDisplayedAttachment {
        RelayDisplayedAttachment(
            id: attachment.id,
            filename: attachment.filename,
            contentType: attachment.contentType ?? "application/octet-stream",
            byteCount: attachment.bytes,
            kind: attachment.kind == .image ? .image : .file,
            payload: attachment.rawURL?.trimmedNonEmpty.map { .remote($0) } ?? .unavailable
        )
    }

    static func from(_ attachment: CodexJobAttachmentReference) -> RelayDisplayedAttachment {
        RelayDisplayedAttachment(
            id: attachment.id,
            filename: attachment.filename,
            contentType: attachment.contentType ?? "application/octet-stream",
            byteCount: attachment.bytes,
            kind: attachment.kind == .image ? .image : .file,
            payload: attachment.rawURL?.trimmedNonEmpty.map { .remote($0) } ?? .unavailable
        )
    }
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
    var attachments: [RelayDisplayedAttachment]
    /// Thread history: the steps the agent took before it wrote this message.
    /// Live jobs keep theirs in `RelayChatViewModel.timelines` instead.
    var historyTimeline: RelayTimeline?
    /// The transcript already shows this job's answer as its own turn, so the
    /// job row carries only what that turn does not: outputs and the run receipt.
    var hidesJobAnswer: Bool

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
        elapsedSeconds: Double? = nil,
        attachments: [RelayDisplayedAttachment] = [],
        historyTimeline: RelayTimeline? = nil,
        hidesJobAnswer: Bool = false
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
        self.attachments = attachments
        self.historyTimeline = historyTimeline
        self.hidesJobAnswer = hidesJobAnswer
    }
}

/// A selectable picker row: a server model plus the explicit interaction mode it runs in.
/// Identity includes BOTH the model id and the mode, so a dual-mode Codex descriptor can
/// appear as an Agents (task) row and a Chat models (chat) row without colliding.
struct RelayModelChoice: Identifiable, Hashable {
    let model: CodexModelDescriptor
    let mode: RelayInteractionMode

    var id: String { "\(model.id)#\(mode.rawValue)" }

    /// The harness that actually owns the resulting session. Chat models retain their
    /// catalog provider; task aliases such as Bedrock/Claude and Azure/Codex resolve to
    /// the CLI that Relay launches. Keeping this on the choice gives every UI surface
    /// one source of truth for provider switching and identity.
    var executionProvider: CodexProvider {
        mode == .task ? RelayChatViewModel.taskProvider(for: model) : model.provider
    }

    /// The harness name shown for Agents grouping and the composer chip ("Codex",
    /// "Claude Code", "Cursor"). Purely presentational; rows still come only from the
    /// server catalog.
    static func harnessTitle(for provider: CodexProvider) -> String {
        switch provider {
        case .claude:
            return "Claude Code"
        case .codex, .cursor, .kimi, .bedrock, .azure:
            return provider.displayName
        }
    }

    var harnessTitle: String { Self.harnessTitle(for: model.provider) }

    /// A task catalog entry without a `taskModel` delegates model choice to the
    /// provider CLI. It is the provider's Default model choice, not another agent.
    var isProviderDefault: Bool {
        mode == .task && model.taskModel?.trimmedNonEmpty == nil
    }

    /// The model label with any redundant harness prefix/suffix stripped, so submenu rows
    /// read "Default" / "GPT-5.6 Sol" under Codex and "Sonnet" under Claude Code.
    var shortModelLabel: String {
        if isProviderDefault { return "Default" }
        var text = model.label.trimmingCharacters(in: .whitespacesAndNewlines)
        if model.provider == .kimi, ["kimi k3", "k3"].contains(text.lowercased()) {
            return "K3"
        }
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
        if model.provider == .kimi, shortModelLabel == "K3" { return "Kimi K3" }
        return "\(harnessTitle) · \(shortModelLabel)"
    }

    private static func labelAliases(for provider: CodexProvider) -> [String] {
        switch provider {
        case .codex:
            return ["Codex"]
        case .claude:
            return ["Claude Code", "Claude"]
        case .cursor:
            return ["Cursor Agent", "Cursor"]
        case .kimi:
            return ["Kimi K3", "Kimi Code", "Kimi"]
        case .bedrock:
            return ["Bedrock"]
        case .azure:
            return ["Azure OpenAI", "Azure"]
        }
    }
}

/// One harness (agent CLI) advertised by the server catalog, carrying its task-mode
/// model choices. The client never synthesizes extra rows; a harness with one
/// advertised model simply has one choice.
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

    /// An active thread belongs to exactly one harness. Keep model changes inside
    /// that provider; clearing the thread (New Conversation) passes nil and restores
    /// the complete server-advertised catalog.
    func restricted(to provider: CodexProvider?) -> RelayModelPickerSections {
        guard let provider else { return self }

        let scopedAgents = agents.compactMap { group -> RelayHarnessGroup? in
            let choices = group.choices.filter { $0.executionProvider == provider }
            guard !choices.isEmpty else { return nil }
            return RelayHarnessGroup(provider: group.provider, choices: choices)
        }
        let scopedChatModels = chatModels.filter { $0.executionProvider == provider }
        return RelayModelPickerSections(agents: scopedAgents, chatModels: scopedChatModels)
    }
}

enum RelayModelDiscovery {
    static let agentProviderOrder: [CodexProvider] = [.codex, .claude, .cursor, .kimi, .bedrock, .azure]
    static let chatProviderOrder: [CodexProvider] = [.codex, .azure, .bedrock, .claude, .cursor, .kimi]

    /// Build the harness-first picker sections from the server catalog. Catalog order is
    /// preserved within each provider (the server curates it); providers absent from the
    /// catalog simply do not appear.
    static func sections(from models: [CodexModelDescriptor]) -> RelayModelPickerSections {
        let agents = agentProviderOrder.compactMap { provider -> RelayHarnessGroup? in
            let entries = models.filter { $0.provider == provider && $0.supports(.task) }
            guard !entries.isEmpty else { return nil }
            let choices = entries
                .map { RelayModelChoice(model: $0, mode: .task) }
                .enumerated()
                .sorted { lhs, rhs in
                    if lhs.element.isProviderDefault != rhs.element.isProviderDefault {
                        return lhs.element.isProviderDefault
                    }
                    return lhs.offset < rhs.offset
                }
                .map(\.element)
            return RelayHarnessGroup(
                provider: provider,
                choices: choices
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

/// Everything the chat reads from the machine while a conversation is live,
/// as closures, so the stream and poll paths can be driven in tests without a
/// network. `live(_:)` is the real one; it only forwards to the client, so
/// trust pinning and the bearer token are exactly the client's.
struct RelayChatLiveSource {
    /// The job stream, from the byte offsets and timeline cursor already held.
    var jobEvents: (_ jobID: String, _ stdoutOffset: Int64?, _ stderrOffset: Int64?, _ timeline: Int)
        -> AsyncThrowingStream<CodexJobStreamEvent, Error>
    var timelinePage: (_ jobID: String, _ since: Int) async throws -> RelayTimelinePage
    var chatEvents: (CodexChatRequest) -> AsyncThrowingStream<CodexChatEvent, Error>
    /// This folder's threads and invocations.
    var history: (_ workspaceID: String?) async throws -> (threads: [CodexThread], jobs: [CodexJob])
    var pendingApprovals: () async throws -> [CodexApproval]
    /// The wait between reconnects.
    var pause: (TimeInterval) async -> Void

    static func live(_ client: CodexClient) -> RelayChatLiveSource {
        RelayChatLiveSource(
            jobEvents: { jobID, stdoutOffset, stderrOffset, timeline in
                client.streamJobEvents(
                    id: jobID,
                    stdoutOffset: stdoutOffset,
                    stderrOffset: stderrOffset,
                    timeline: timeline
                )
            },
            timelinePage: { jobID, since in
                try await client.fetchTimeline(jobID: jobID, since: since)
            },
            chatEvents: { client.streamChat($0) },
            history: { workspaceID in
                let threads = try await client.fetchThreads(provider: nil, workspaceID: workspaceID, limit: 200)
                let jobs = try await client.fetchJobs(provider: nil, workspaceID: workspaceID, limit: 200)
                return (threads, jobs)
            },
            pendingApprovals: { try await client.fetchPendingApprovalsIfSupported() },
            pause: { seconds in
                try? await Task.sleep(nanoseconds: UInt64(max(0, seconds) * 1_000_000_000))
            }
        )
    }
}

@MainActor
final class RelayChatViewModel: ObservableObject {
    @Published private(set) var models: [CodexModelDescriptor] = []
    @Published private(set) var skillsByProvider: [CodexProvider: [CodexSkillDescriptor]] = [:]
    @Published private(set) var selectedSkillIDsByProvider: [CodexProvider: Set<String>] = [:]
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var messages: [RelayConversationItem] = []
    @Published private(set) var harnessesByProvider: [CodexProvider: RelayHarnessStatus] = [:]
    @Published private(set) var isLoading = false
    @Published private(set) var isSending = false
    @Published private(set) var isTranscribing = false
    /// True while `openThread` has seeded identity from the feed item and is still
    /// waiting on `fetchThreadDetail`. Cleared when detail lands or the request fails.
    @Published private(set) var isLoadingThreadDetail = false
    /// Session id of a native Codex, Claude Code, or Cursor run the open chat is
    /// following. Nil when the open thread is idle.
    @Published private(set) var watchedSessionID: String?
    private var nativeWatchQuietSince: Date?
    @Published private(set) var cancellingJobIDs: Set<String> = []
    /// The explicit model+mode selection. Never inferred from `supports(.task)`; the mode
    /// travels with the choice from the picker section it was tapped in.
    @Published private(set) var selectedChoice: RelayModelChoice?
    /// User-chosen reasoning effort for task jobs (nil = model default). Reset when the
    /// selected choice changes so we never send an effort the model doesn't support.
    @Published var selectedEffort: CodexReasoningEffort?
    /// Claude's permission policy is deliberately provider-specific. Codex keeps its
    /// runner-enforced sandbox policy until the backend has a true interactive approval
    /// channel; we do not present a phone toggle that the current executor would ignore.
    @Published var claudePermissionMode: RelayClaudePermissionMode {
        didSet {
            UserDefaults.standard.set(claudePermissionMode.rawValue, forKey: Self.claudePermissionDefaultsKey)
        }
    }
    @Published var codexApprovalPolicy: RelayCodexApprovalPolicy {
        didSet {
            UserDefaults.standard.set(codexApprovalPolicy.rawValue, forKey: Self.codexApprovalDefaultsKey)
        }
    }
    /// What a Codex job may touch, chosen independently of whether it may ask.
    @Published var codexSandbox: RelayCodexSandbox {
        didSet {
            UserDefaults.standard.set(codexSandbox.rawValue, forKey: Self.codexSandboxDefaultsKey)
        }
    }
    /// Approvals parked against this conversation's own jobs.
    ///
    /// The channel has always existed — the runner parks on `waitForDecision`, the
    /// Sessions tab renders it and the push action buttons answer it. It was simply
    /// absent from the screen the user is looking at while the run stalls, which is
    /// why an approval read as a hang.
    @Published private(set) var pendingApprovals: [CodexApproval] = []
    @Published var prompt = ""
    @Published var draftAttachments: [RelayDraftAttachment] = []
    @Published var errorMessage: String?
    /// Live stdout/stderr tail per active job id, fed by the job SSE stream. Cleared when
    /// the job reaches a terminal state.
    @Published private(set) var liveJobTails: [String: String] = [:]
    /// Reduced timelines of the jobs on screen, by job id: the prose and steps
    /// the transcript draws. A job absent here renders from `liveJobTails`.
    ///
    /// Published in batches: events land in `timelineStore` as they arrive and
    /// are copied here at most every `publishInterval`, so a burst of a hundred
    /// events redraws the transcript a dozen times a second, not a hundred.
    @Published private(set) var timelines: [String: RelayTimeline] = [:]

    /// Sessions handed over from a Mac. Node-level, not folder-scoped: a handoff
    /// lands in its own worktree workspace, so it is shown wherever the threads
    /// list is open rather than filtered to the current folder.
    @Published private(set) var handoffs: [RelayHandoffCard] = []
    /// Manifests fetched per handoff (`GET /v1/handoffs/:id`), keyed by id.
    @Published private(set) var handoffManifests: [String: RelayHandoffManifest] = [:]
    /// The "On your Mac" index, or nil when no Mac has published one.
    @Published private(set) var macSessions: RelayMacSessionIndex?
    @Published private(set) var continuingHandoffIDs: Set<String> = []

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
    private let live: RelayChatLiveSource
    private let fetchJobDetail: (String) async throws -> CodexJob
    private let fetchThreadDetail: (String, String?, CodexProvider) async throws -> CodexThreadDetail
    /// Detail refreshes may finish after the user selects a different source or
    /// starts a conversation. They must not replace that newer foreground state.
    private var conversationRevision = UUID()
    private var currentThreadID: String?
    private var currentThreadProvider: CodexProvider?
    private var currentThreadMode: RelayInteractionMode = .task
    /// Workspace the current thread belongs to. Resuming a session in a different
    /// workspace is rejected by the server ("session does not belong to workspace"), so
    /// we only resume when this matches the compose workspace.
    private var currentThreadWorkspaceID: String?
    /// Human-readable name recorded for the current folder-scoped thread.
    private var currentThreadWorkspaceName: String?
    private var streamTask: Task<Void, Never>?
    /// Live job SSE consumers keyed by job id. Streams are VM-owned: dismissing the chat
    /// cover never cancels them; leaving the conversation does. A stream that ends
    /// without `done` reconnects itself from where it stopped (`runJobStream`), and
    /// only after repeated failures hands over to the store's 2 s monitor loop
    /// (`refreshActiveWorkIfNeeded`), which pages the timeline and tries again later.
    private var jobStreamTasks: [String: Task<Void, Never>] = [:]
    /// Which run of `runJobStream` owns each entry above, so one that was
    /// replaced cannot clear its successor on the way out.
    private var jobStreamTokens: [String: UUID] = [:]

    /// What has been consumed of one job's live channels, and how they are faring.
    private struct JobLiveState {
        /// Bytes of each log already shown: where a reconnect resumes.
        var stdoutOffset: Int64 = 0
        var stderrOffset: Int64 = 0
        /// Set when the stream stopped retrying; the poll carries the job until
        /// `streamRetryAfterGivingUp` has passed.
        var streamGaveUpAt: Date?
        /// The machine has no timeline route (it predates timelines).
        var timelineUnavailable = false
        var isSyncingTimeline = false
        /// A finished job's timeline is fetched once, not on every poll.
        var fetchedFinishedTimeline = false
    }

    private var jobLive: [String: JobLiveState] = [:]
    /// The timelines as of the last event. `timelines` trails it by one batch.
    private var timelineStore: [String: RelayTimeline] = [:]
    private var tailStore: [String: String] = [:]
    private var dirtyTimelineIDs: Set<String> = []
    private var dirtyTailIDs: Set<String> = []
    /// Chat tokens received but not yet shown, by assistant message id.
    private var pendingChatDeltas: [String: String] = [:]
    private var publishTask: Task<Void, Never>?
    private var foregroundObserver: NSObjectProtocol?
    private var lastPublishAt = Date.distantPast
    private var detailRefreshesInFlight: Set<String> = []
    /// How often live content reaches the screen: about twelve times a second.
    let publishInterval: TimeInterval

    /// Waits before each reconnect of a dropped job stream; after the last one
    /// the stream gives up and the poll takes over.
    nonisolated static let streamRetryDelays: [TimeInterval] = [0.5, 1, 2, 4, 8]
    /// How long the poll carries a job before the stream is tried again.
    nonisolated static let streamRetryAfterGivingUp: TimeInterval = 30

    private static let liveTailCharacterCap = 12_000
    /// Keep following a native transcript through long tool calls. The list drops
    /// the Running pin after a few quiet minutes; an open chat waits longer so a
    /// thinking pause does not freeze the transcript.
    private static let nativeWatchQuietLimit: TimeInterval = 15 * 60
    private static let claudePermissionDefaultsKey = "relay.claude.permissionMode"
    private static let codexApprovalDefaultsKey = "relay.codex.approvalPolicy"
    private static let codexSandboxDefaultsKey = "relay.codex.sandbox"
    /// Matches relayd's default `CODEX_MAX_TIMEOUT_MS`. Approvals already pause
    /// this clock; the cap is only for a run that never finishes on its own.
    static let taskTimeoutMs = 4 * 60 * 60 * 1000

    var isStreaming: Bool { streamingMessageID != nil }

    /// Provider locked to the open resumable session. A different provider must start a
    /// new conversation instead of looking like an in-place model change.
    var currentSessionProvider: CodexProvider? { currentThreadProvider }

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

    init(
        client: CodexClient,
        workspaceID: String?,
        workspacePath: String?,
        fetchJobDetail: ((String) async throws -> CodexJob)? = nil,
        fetchThreadDetail: ((String, String?, CodexProvider) async throws -> CodexThreadDetail)? = nil,
        live: RelayChatLiveSource? = nil,
        publishInterval: TimeInterval = 0.08
    ) {
        self.client = client
        self.live = live ?? .live(client)
        self.publishInterval = publishInterval
        self.fetchJobDetail = fetchJobDetail ?? { id in
            try await client.fetchJob(id: id, includeFullLogs: false)
        }
        self.fetchThreadDetail = fetchThreadDetail ?? { sessionID, workspaceID, provider in
            try await client.fetchThreadDetail(
                sessionID: sessionID,
                workspaceID: workspaceID,
                provider: provider
            )
        }
        self.workspaceID = workspaceID?.trimmedNonEmpty
        self.workspacePath = workspacePath?.trimmedNonEmpty
        let savedClaudeMode = UserDefaults.standard.string(forKey: Self.claudePermissionDefaultsKey)
        self.claudePermissionMode = RelayClaudePermissionMode(rawValue: savedClaudeMode ?? "") ?? .manual
        self.codexApprovalPolicy = RelayCodexApprovalPolicy(
            rawValue: UserDefaults.standard.string(forKey: Self.codexApprovalDefaultsKey) ?? ""
        ) ?? .onRequest
        self.codexSandbox = RelayCodexSandbox(
            rawValue: UserDefaults.standard.string(forKey: Self.codexSandboxDefaultsKey) ?? ""
        ) ?? .default
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.resumeLiveWork(restartingStreams: true)
            }
        }
    }

    deinit {
        if let foregroundObserver {
            NotificationCenter.default.removeObserver(foregroundObserver)
        }
    }

    /// Folder name for the chat top bar ("Relay" for the root chat).
    var folderDisplayName: String {
        if let workspacePath {
            return URL(fileURLWithPath: workspacePath).lastPathComponent
        }
        return registeredWorkspaceName ?? "Relay"
    }

    /// Full jail path shown under the chat header; nil for the root chat.
    var folderPathLabel: String? {
        workspacePath
    }

    /// Adopt a workspace id learned outside this VM (e.g. the browser registered the
    /// folder after this session was created). First-writer wins; ids are stable per path.
    func adoptWorkspaceID(_ id: String) {
        guard workspaceID == nil, let trimmed = id.trimmedNonEmpty else { return }
        workspaceID = trimmed
        Task { await refreshSkills() }
    }

    // MARK: - Model selection

    var pickerSections: RelayModelPickerSections {
        RelayModelDiscovery.sections(from: models)
    }

    func selectChoice(_ choice: RelayModelChoice) {
        selectedChoice = choice
        selectedEffort = nil  // fall back to the new model's default until the user picks
    }

    var selectedTaskProvider: CodexProvider? {
        guard let choice = selectedChoice, choice.mode == .task else { return nil }
        return Self.taskProvider(for: choice.model)
    }

    var selectedHarnessStatus: RelayHarnessStatus? {
        guard let provider = selectedTaskProvider else { return nil }
        return harnessesByProvider[provider]
    }

    var availableSkills: [CodexSkillDescriptor] {
        guard let provider = selectedTaskProvider else { return [] }
        return skillsByProvider[provider] ?? []
    }

    var selectedSkillIDs: Set<String> {
        guard let provider = selectedTaskProvider else { return [] }
        return selectedSkillIDsByProvider[provider] ?? []
    }

    func toggleSkill(_ skill: CodexSkillDescriptor) {
        guard skill.provider == selectedTaskProvider else { return }
        var selected = selectedSkillIDsByProvider[skill.provider] ?? []
        if selected.contains(skill.id) {
            selected.remove(skill.id)
        } else if selected.count < 6 {
            selected.insert(skill.id)
        }
        selectedSkillIDsByProvider[skill.provider] = selected
    }

    /// Effort levels the selected task model exposes (from the catalog), as typed options.
    /// Chat requests carry no effort, so chat-mode selections expose none.
    var availableEfforts: [CodexReasoningEffort] {
        guard let choice = selectedChoice, choice.mode == .task else { return [] }
        if selectedHarnessStatus?.taskControls?.reasoningEffort == false { return [] }
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
        if let provider = currentThreadProvider {
            if let selectedChoice, selectedChoice.executionProvider == provider,
               let refreshed = sections.allChoices.first(where: { $0.id == selectedChoice.id }) {
                self.selectedChoice = refreshed
                return
            }
            if let choice = Self.choiceMatchingThread(
                from: models,
                provider: provider,
                mode: currentThreadMode,
                model: selectedChoice?.model.id
            ) {
                selectChoice(choice)
            }
            return
        }
        if let selectedChoice, let refreshed = sections.allChoices.first(where: { $0.id == selectedChoice.id }) {
            self.selectedChoice = refreshed
            return
        }
        if let fallback = sections.defaultChoice {
            selectedChoice = fallback
        }
    }

    // MARK: - Bootstrap / refresh

    private var isRefreshingModels = false

    func refreshModels() async {
        guard !isRefreshingModels else { return }
        isRefreshingModels = true
        defer { isRefreshingModels = false }
        do {
            let refreshed = try await client.fetchModels()
            guard !Task.isCancelled else { return }
            models = refreshed
            ensureSelectedChoiceValid()
        } catch {
            // A failed refresh must not erase the last usable picker or selection.
            CodexDiagnostics.log("model_refresh_failed", fields: ["error": String(describing: error)])
        }
    }

    func bootstrap() async {
        guard !isLoading else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            await refreshHarnesses()
            models = try await client.fetchModels()
            ensureSelectedChoiceValid()
            await refreshSkills()
            await refreshThreads()
            await refreshHandoffs()
            // Opening a thread races this bootstrap. Keep that thread's error
            // and provider; do not reset to an empty root catalog default.
            if currentThreadID == nil {
                errorMessage = nil
            }
        } catch {
            if currentThreadID == nil {
                errorMessage = error.localizedDescription
            }
        }
        #if DEBUG
        await runAutoDriveIfRequested()
        #endif
    }

    /// Readiness is independent per provider. Older personal nodes may not expose the
    /// harness endpoint yet; keep their last known state and let the job endpoint decide.
    func refreshHarnesses() async {
        do {
            let harnesses = try await client.fetchHarnesses()
            harnessesByProvider = Dictionary(uniqueKeysWithValues: harnesses.map { ($0.provider, $0) })
        } catch {
            CodexDiagnostics.log("harness_refresh_failed", fields: ["error": String(describing: error)])
        }
    }

    /// Refresh provider inventories independently. One unavailable harness must not hide
    /// another harness's installed skills or fail the rest of chat bootstrap.
    func refreshSkills() async {
        let providers = Set(
            models
                .filter { $0.supports(.task) }
                .map { Self.taskProvider(for: $0) }
        )
        var discovered = skillsByProvider
        for provider in providers {
            do {
                discovered[provider] = try await client.fetchSkills(provider: provider, workspaceID: workspaceID)
            } catch {
                CodexDiagnostics.log("skill_refresh_failed", fields: [
                    "provider": provider.rawValue,
                    "error": String(describing: error)
                ])
            }
        }
        skillsByProvider = discovered
        for provider in providers {
            let validIDs = Set((discovered[provider] ?? []).map(\.id))
            selectedSkillIDsByProvider[provider] = (selectedSkillIDsByProvider[provider] ?? [])
                .intersection(validIDs)
        }
    }

    /// Load only this folder's threads and invocations. A folder whose dynamic workspace
    /// has not been registered yet has no server-side history; the workspace-root chat
    /// keeps only legacy/global conversations whose workspaceId is nil.
    func refreshThreads() async {
        guard workspacePath == nil || workspaceID != nil else {
            if !threads.isEmpty { threads = [] }
            if !jobs.isEmpty { jobs = [] }
            return
        }
        do {
            let fetched = try await live.history(workspaceID)
            let scopedThreads = Self.sortedThreads(fetched.threads.filter { belongsToHistoryScope($0.workspaceId) })
            let scopedJobs = Self.sortedJobs(fetched.jobs.filter { belongsToHistoryScope($0.workspaceId) })
            // A poll that changed nothing publishes nothing: every assignment
            // here redraws the whole chat.
            if threads != scopedThreads { threads = scopedThreads }
            // The list carries the compact copy of each job. For one on screen
            // the richer copy already held stays; only what the list knows
            // better (status, times) is taken from it.
            let merged = scopedJobs.map { job in conversationJob(id: job.id)?.absorbing(job) ?? job }
            if jobs != merged { jobs = merged }
            mergeUpdatedJobs(scopedJobs)
        } catch {
            if !isCancellation(error) {
                errorMessage = error.localizedDescription
            }
        }
    }

    // MARK: - Handoffs

    /// Reload the handoff cards and the "On your Mac" index. Never throws and
    /// never fabricates rows: a node that is unreachable leaves the last known
    /// state in place rather than blanking the list.
    func refreshHandoffs() async {
        do {
            let cards = try await client.fetchHandoffs()
            handoffs = cards
            for card in cards where handoffManifests[card.id] == nil {
                guard let detail = try? await client.fetchHandoff(id: card.id) else { continue }
                if let manifest = detail.manifest {
                    handoffManifests[card.id] = manifest
                }
            }
        } catch {
            if isCancellation(error) { return }
            CodexDiagnostics.log("handoff_refresh_failed", fields: ["error": String(describing: error)])
        }

        if let index = try? await client.fetchMacSessions() {
            macSessions = index
        }
    }

    /// The folder on disk for a handoff checkout, when this chat is not already
    /// scoped there. Used so Continue after a push (which opens the root chat)
    /// can move the conversation into that folder instead of sending from nowhere.
    func resolveHandoffFolder(_ card: RelayHandoffCard) async -> (path: String, workspaceID: String)? {
        guard let workspaceID = card.workspaceID else { return nil }
        if let workspacePath, self.workspaceID == workspaceID {
            return (workspacePath, workspaceID)
        }
        let pageLimit = 200
        let maxPages = 10
        var offset = 0
        for _ in 0..<maxPages {
            guard let listing = try? await client.fetchDirectory(path: nil, offset: offset, limit: pageLimit) else {
                return nil
            }
            if let path = listing.entries.first(where: { $0.workspaceId == workspaceID })?.path {
                return (path, workspaceID)
            }
            if listing.entries.isEmpty || !listing.truncated {
                return nil
            }
            offset += listing.entries.count
        }
        return nil
    }

    /// Resume the handed-off session as an ordinary job in its own worktree, so
    /// it streams over the existing job SSE. The conversation then continues
    /// that session: follow-up task messages target the handoff's workspace.
    func continueHandoff(_ card: RelayHandoffCard) async {
        guard card.isActionable, !continuingHandoffIDs.contains(card.id) else { return }
        conversationRevision = UUID()
        continuingHandoffIDs.insert(card.id)
        defer { continuingHandoffIDs.remove(card.id) }

        do {
            let created = try await client.continueHandoff(id: card.id)
            let job: CodexJob
            if let createdJob = created.job {
                job = createdJob
            } else {
                job = try await client.fetchJob(id: created.id)
            }
            if let workspaceID = job.workspaceId ?? card.workspaceID {
                adoptWorkspaceID(workspaceID)
                currentThreadWorkspaceID = workspaceID
            }
            adoptThread(from: job)
            currentThreadProvider = job.provider
            currentThreadWorkspaceName = job.workspaceName ?? currentThreadWorkspaceName
            messages.append(jobItem(job))
            attachJobStream(to: job)
            errorMessage = nil
            await refreshThreads()
            await refreshHandoffs()
        } catch {
            if isCancellation(error) { return }
            // The node's own words when it has any (409 "handoff is not ready",
            // "a job is already running for this handoff"), so a refusal is never
            // reported as a vague failure.
            errorMessage = error.localizedDescription
            CodexDiagnostics.log("handoff_continue_failed", fields: [
                "handoffId": card.id,
                "error": String(describing: error)
            ])
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
        await syncLiveJobs()
        await refreshPendingApprovals()
        await refreshThreads()
    }

    /// Pull approvals parked against the jobs shown here, and only those.
    ///
    /// Scoped by job id rather than shown wholesale: an approval belonging to a run
    /// started from another folder is not this conversation's to answer, and offering
    /// it here would let one screen unblock work the user cannot see.
    private func refreshPendingApprovals() async {
        guard messages.contains(where: { $0.job != nil }) else {
            if !pendingApprovals.isEmpty { pendingApprovals = [] }
            return
        }
        guard let all = try? await live.pendingApprovals() else { return }
        // Read after the wait: the conversation may have changed while the
        // request was out, and its approvals are not the new one's to show.
        let jobIDs = Set(messages.compactMap { $0.job?.id })
        let scoped = all.filter { $0.isPending && jobIDs.contains($0.jobId) }
        if pendingApprovals != scoped { pendingApprovals = scoped }
    }

    /// Keep only the approvals that belong to a job in this conversation.
    private func scopePendingApprovals() {
        guard !pendingApprovals.isEmpty else { return }
        let jobIDs = Set(messages.compactMap { $0.job?.id })
        let scoped = pendingApprovals.filter { jobIDs.contains($0.jobId) }
        if scoped.count != pendingApprovals.count { pendingApprovals = scoped }
    }

    /// Answer an approval. The card clears immediately so the run visibly resumes,
    /// and comes back if the machine rejected the decision — a job must never look
    /// answered when it is still parked.
    func decideApproval(_ approval: CodexApproval, _ decision: CodexApprovalDecision) async {
        let previous = pendingApprovals
        pendingApprovals.removeAll { $0.id == approval.id }
        do {
            _ = try await client.decideApproval(id: approval.id, decision: decision)
            await refreshActiveJobDetails()
        } catch {
            guard !isCancellation(error) else { return }
            pendingApprovals = previous
            scopePendingApprovals()
            errorMessage = error.localizedDescription
        }
    }

    /// Fetch full detail for each active job card so stdout/result grows live in the UI.
    private func refreshActiveJobDetails() async {
        let activeIDs = messages.compactMap { $0.job?.status.isActive == true ? $0.job?.id : nil }
        for id in activeIDs {
            guard let updated = try? await fetchJobDetail(id) else { continue }
            // The conversation may have moved on while the request was out.
            guard isOnScreen(jobID: id) else { continue }
            replaceJob(updated, from: .detail)
        }
    }

    // MARK: - Sending

    func sendCurrentPrompt() async {
        guard let choice = selectedChoice else {
            errorMessage = "No model is available."
            return
        }
        conversationRevision = UUID()
        if !draftAttachments.isEmpty {
            if currentThreadMode == .chat, currentThreadID != nil {
                errorMessage = "This chat session cannot take files. Start a new conversation to attach images."
                return
            }
            guard choice.model.supports(.task) else {
                errorMessage = "This model cannot take attached files. Switch to an agent to send them."
                return
            }
            await runTask(using: RelayModelChoice(model: choice.model, mode: .task))
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
        publishPending()
        if let id = streamingMessageID, let index = messages.firstIndex(where: { $0.id == id }) {
            if messages[index].text.isEmpty {
                // Nothing was written, so there is no answer to keep. Saying so
                // is a status line, not something the model said: stored as
                // assistant text it would be sent back as history next turn.
                let provider = messages[index].provider
                messages.remove(at: index)
                messages.append(RelayConversationItem(role: .status, text: "Stopped.", provider: provider))
            } else {
                messages[index].isStreaming = false
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
            await refreshSkills()
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

        let history = Self.chatHistory(from: messages)

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
            var usage: RelayUsage?
            var failure: String?
            do {
                for try await event in self.live.chatEvents(request) {
                    if Task.isCancelled { break }
                    switch event {
                    case .meta(let threadId, _, let provider):
                        guard self.streamingMessageID == assistantID else { break }
                        self.currentThreadID = threadId
                        self.currentThreadProvider = CodexProvider(rawProvider: provider)
                        self.currentThreadWorkspaceID = scopeWorkspaceID
                        if self.currentThreadWorkspaceName == nil, scopeWorkspaceID != nil {
                            self.currentThreadWorkspaceName = self.registeredWorkspaceName
                                ?? self.workspacePath.map { URL(fileURLWithPath: $0).lastPathComponent }
                        }
                    case .delta(let delta):
                        self.append(delta: delta, to: assistantID)
                    case .usage(let input, let output):
                        usage = RelayUsage(inputTokens: input, outputTokens: output)
                    case .done:
                        break
                    case .error(let message):
                        failure = message
                    }
                }
            } catch {
                if !Task.isCancelled {
                    failure = error.localizedDescription
                }
            }
            self.finishStreaming(
                id: assistantID,
                usage: usage,
                startedAt: startedAt,
                failure: failure,
                wasCancelled: Task.isCancelled
            )
            if !Task.isCancelled {
                await self.refreshThreads()
            }
        }
        streamTask = task
        await task.value
    }

    /// Close a chat turn. What the model wrote stays exactly as written; how the
    /// turn ended is said beside it, as a status line. A stream that dropped
    /// after three paragraphs keeps the three paragraphs, and neither the error
    /// nor "No response received." is ever stored as something the model said.
    private func finishStreaming(
        id: String,
        usage: RelayUsage?,
        startedAt: Date,
        failure: String?,
        wasCancelled: Bool
    ) {
        publishPending()
        var provider: CodexProvider?
        var wroteNothing = false
        if let index = messages.firstIndex(where: { $0.id == id }) {
            provider = messages[index].provider
            if messages[index].text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                wroteNothing = true
                messages.remove(at: index)
            } else {
                messages[index].isStreaming = false
                if let usage, !usage.isEmpty { messages[index].usage = usage }
                messages[index].elapsedSeconds = Date().timeIntervalSince(startedAt)
            }
        }
        if !wasCancelled {
            if let failure {
                errorMessage = failure
                messages.append(RelayConversationItem(role: .status, text: failure, provider: provider))
            } else if wroteNothing {
                messages.append(RelayConversationItem(role: .status, text: "No response received.", provider: provider))
            }
        }
        if streamingMessageID == id { streamingMessageID = nil }
        streamTask = nil
        isSending = false
    }

    /// The turns sent to a tool-less chat model: what the user typed and what a
    /// model answered. Status lines and job cards are the app talking, not the
    /// conversation, and an assistant turn with no text is not a turn.
    nonisolated static func chatHistory(from items: [RelayConversationItem]) -> [CodexChatMessage] {
        items.compactMap { item -> CodexChatMessage? in
            switch item.role {
            case .user:
                return CodexChatMessage(role: "user", content: item.text)
            case .assistant where !item.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty:
                return CodexChatMessage(role: "assistant", content: item.text)
            case .assistant, .status, .job:
                return nil
            }
        }
    }

    private func runTask(using choice: RelayModelChoice) async {
        let model = choice.model
        guard model.supports(.task) else {
            errorMessage = "\(model.label) is not available for Task."
            return
        }
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingAttachments = draftAttachments
        guard (!text.isEmpty || !outgoingAttachments.isEmpty), !isSending else { return }
        isSending = true
        defer { isSending = false }

        let provider = Self.taskProvider(for: model)
        let revision = conversationRevision
        await refreshHarnesses()
        if let status = harnessesByProvider[provider], status.isConfirmedUnavailable {
            errorMessage = status.actionMessage ?? "\(provider.displayName) is not ready on this computer."
            return
        }
        if let controls = harnessesByProvider[provider]?.taskControls {
            if Self.taskModelParameter(for: model) != nil, !controls.model {
                errorMessage = "This \(provider.displayName) runner does not support model selection."
                return
            }
            if effectiveEffort != nil, !controls.reasoningEffort {
                errorMessage = "This \(provider.displayName) runner does not support effort selection."
                return
            }
            if provider == .claude, !controls.permissionModes.contains(claudePermissionMode.rawValue) {
                errorMessage = "This Claude Code runner does not support the selected permission mode."
                return
            }
            if provider == .codex, !controls.approvalPolicies.contains(codexApprovalPolicy.rawValue) {
                errorMessage = "This Codex runner does not support the selected approval policy."
                return
            }
        }

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
                errorMessage = handoffs.contains(where: \.isActionable)
                    ? "Continue the handed-off session, or open a folder, to run this."
                    : "Open a folder to run tasks — the root chat has no workspace."
            } else if currentThreadID != nil {
                errorMessage = "This conversation does not have a task workspace. Start a new conversation from the folder to run a task."
            }
            return
        }
        prompt = ""
        draftAttachments = []
        errorMessage = nil

        // Resume this on-screen conversation. A brand-new Codex job has no
        // session id until the runner writes one, so also look at jobs already
        // shown here — otherwise "Go on" after a cancel starts a second thread.
        let conversationJobs = messages.compactMap(\.job)
        let resumeID = Self.resumeSessionID(
            currentThreadID: currentThreadID,
            currentThreadProvider: currentThreadProvider,
            currentThreadWorkspaceID: currentThreadWorkspaceID,
            provider: provider,
            workspaceID: workspaceID,
            conversationJobs: conversationJobs
        )
        let userPrompt = text.isEmpty ? "Please inspect the attached file(s)." : text
        let requestPrompt = Self.followUpTaskPrompt(userText: userPrompt, conversationJobs: conversationJobs)
        messages.append(RelayConversationItem(
            role: .user,
            text: text,
            provider: provider,
            modelLabel: model.label,
            attachments: outgoingAttachments.map(\.displayed)
        ))
        do {
            let created = try await client.createJob(CodexCreateJobRequest(
                workspaceId: workspaceID,
                prompt: requestPrompt,
                timeoutMs: Self.taskTimeoutMs,
                model: Self.taskModelParameter(for: model),
                reasoningEffort: effectiveEffort?.rawValue,
                provider: provider,
                permissionMode: provider == .claude ? claudePermissionMode.apiValue : nil,
                approvalPolicy: provider == .codex ? codexApprovalPolicy.rawValue : nil,
                sandbox: provider == .codex ? codexSandbox.rawValue : nil,
                skills: Array(selectedSkillIDsByProvider[provider] ?? []).sorted(),
                attachments: outgoingAttachments.map(\.jobAttachment),
                resumeSessionId: resumeID
            ))
            let job: CodexJob
            if let createdJob = created.job {
                job = createdJob
            } else {
                job = try await client.fetchJob(id: created.id)
            }
            // The user opened something else while the machine was creating
            // the job. It runs, and the history list shows it; it does not
            // attach itself to a conversation it was not sent from.
            guard conversationRevision == revision else {
                await refreshThreads()
                return
            }
            adoptThread(from: job)
            currentThreadProvider = provider
            currentThreadWorkspaceID = job.workspaceId ?? workspaceID
            currentThreadWorkspaceName = job.workspaceName ?? currentThreadWorkspaceName ?? registeredWorkspaceName
            messages.append(jobItem(job))
            attachJobStream(to: job)
            await refreshThreads()
        } catch {
            if prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                prompt = text
            }
            if draftAttachments.isEmpty {
                draftAttachments = outgoingAttachments
            }
            await refreshHarnesses()
            errorMessage = error.localizedDescription
            messages.append(RelayConversationItem(role: .status, text: error.localizedDescription, provider: provider))
        }
    }

    // MARK: - Live job stream (SSE with polling fallback)

    /// Attach the job SSE stream: stdout/stderr feed the live tail, timeline
    /// events feed `timelines`, and `done` closes the job. The stream belongs to
    /// the conversation showing the job, so nothing attaches for a job that is
    /// not on screen.
    private func attachJobStream(to job: CodexJob) {
        let jobID = job.id
        guard job.status.isActive, jobStreamTasks[jobID] == nil, isOnScreen(jobID: jobID) else { return }
        jobLive[jobID, default: JobLiveState()].streamGaveUpAt = nil
        let token = UUID()
        jobStreamTokens[jobID] = token
        jobStreamTasks[jobID] = Task { [weak self] in
            await self?.runJobStream(jobID: jobID, token: token)
        }
    }

    /// One job's stream, kept up for as long as the job runs.
    ///
    /// A stream that ends without `done` — the phone slept, the network moved,
    /// the machine restarted — is reconnected from exactly where it stopped: the
    /// byte offsets of both logs and the timeline cursor go back to the machine,
    /// so nothing already shown is sent again and nothing is skipped. Reconnects
    /// back off; after the last one the stream gives up and the poll carries
    /// the job, trying the stream again every `streamRetryAfterGivingUp`.
    private func runJobStream(jobID: String, token: UUID) async {
        var failures = 0
        // A job whose output is already partly held (the stream was restarted
        // on returning to the foreground) resumes; a fresh one starts clean.
        var isReattach = jobLive[jobID].map { $0.stdoutOffset > 0 || $0.stderrOffset > 0 } ?? false
        while !Task.isCancelled, jobStreamTokens[jobID] == token {
            let state = jobLive[jobID] ?? JobLiveState()
            let cursor = timelineStore[jobID]?.cursor ?? 0
            var sawDone = false
            var progressed = false
            var reason = "closed"
            do {
                // The first connection asks for what it always has; only a
                // reconnect names offsets.
                let events = live.jobEvents(
                    jobID,
                    isReattach ? state.stdoutOffset : nil,
                    isReattach ? state.stderrOffset : nil,
                    cursor
                )
                for try await event in events {
                    guard !Task.isCancelled, jobStreamTokens[jobID] == token else { break }
                    switch event {
                    case .status: break
                    case .stdout, .stderr, .timeline, .done: progressed = true
                    }
                    handleJobStreamEvent(event, jobID: jobID)
                    if case .done = event {
                        sawDone = true
                        break
                    }
                }
            } catch {
                reason = CodexDiagnostics.brief(error)
            }
            if sawDone {
                let held = jobLive[jobID] ?? JobLiveState()
                CodexDiagnostics.log("job_stream_done", fields: [
                    "jobId": jobID,
                    "stdoutOffset": String(held.stdoutOffset),
                    "stderrOffset": String(held.stderrOffset),
                    "timeline": String(timelineStore[jobID]?.cursor ?? 0)
                ])
            }
            guard !sawDone, !Task.isCancelled, jobStreamTokens[jobID] == token else { break }
            // Still worth following only while the job is on screen and running.
            guard let job = conversationJob(id: jobID), job.status.isActive else { break }

            failures = progressed ? 1 : failures + 1
            let held = jobLive[jobID] ?? JobLiveState()
            guard failures <= Self.streamRetryDelays.count else {
                jobLive[jobID, default: JobLiveState()].streamGaveUpAt = Date()
                CodexDiagnostics.log("job_stream_gave_up", fields: [
                    "jobId": jobID,
                    "attempts": String(failures - 1),
                    "reason": reason
                ])
                break
            }
            CodexDiagnostics.log("job_stream_reattach", fields: [
                "jobId": jobID,
                "attempt": String(failures),
                "stdoutOffset": String(held.stdoutOffset),
                "stderrOffset": String(held.stderrOffset),
                "timeline": String(timelineStore[jobID]?.cursor ?? 0),
                "reason": reason
            ])
            isReattach = true
            await live.pause(Self.streamRetryDelays[failures - 1])
        }
        if jobStreamTokens[jobID] == token {
            jobStreamTokens[jobID] = nil
            jobStreamTasks[jobID] = nil
        }
    }

    /// Apply one stream event to the conversation that is showing its job, and
    /// to no other. A stream can outlive the screen it was opened for by an
    /// event or two; what it says then is about a job the user has left.
    private func handleJobStreamEvent(_ event: CodexJobStreamEvent, jobID: String) {
        guard isOnScreen(jobID: jobID) else { return }
        switch event {
        case .status(let updated):
            guard updated.id == jobID else { return }
            replaceJob(updated, from: .stream)
        case .stdout(let offset, let chunk):
            appendLiveTail(jobID: jobID, chunk, at: offset, channel: \.stdoutOffset)
        case .stderr(let offset, let chunk):
            appendLiveTail(jobID: jobID, chunk, at: offset, channel: \.stderrOffset)
        case .timeline(let envelope):
            applyTimeline([envelope], jobID: jobID)
        case .done(let finished):
            guard finished.id == jobID else { return }
            replaceJob(finished, from: .stream)
        }
    }

    private func stopJobStream(jobID: String) {
        jobStreamTasks[jobID]?.cancel()
        jobStreamTasks[jobID] = nil
        jobStreamTokens[jobID] = nil
    }

    /// The app came back to the foreground, where every stream it held has
    /// usually died: reconnect now instead of waiting out a backoff or a
    /// give-up window that elapsed while the phone was asleep.
    ///
    /// `restartingStreams` is for a return from the background proper: a stream
    /// held across a suspension can look open for minutes after its connection
    /// is gone, and while it does nothing else carries the job. Restarting
    /// costs nothing, because it resumes from the offsets and cursor held.
    func resumeLiveWork(restartingStreams: Bool = false) {
        for job in messages.compactMap(\.job) where job.status.isActive {
            jobLive[job.id]?.streamGaveUpAt = nil
            if restartingStreams { stopJobStream(jobID: job.id) }
            attachJobStream(to: job)
        }
        scheduleTimelineSync()
    }

    /// The poll's share of live work, for jobs the stream is not carrying: page
    /// the timeline from the cursor, and put the stream back once it has had
    /// time to recover.
    private func syncLiveJobs() async {
        for job in messages.compactMap(\.job) where job.status.isActive && jobStreamTasks[job.id] == nil {
            let gaveUpAt = jobLive[job.id]?.streamGaveUpAt
            if gaveUpAt.map({ Date().timeIntervalSince($0) >= Self.streamRetryAfterGivingUp }) ?? true {
                attachJobStream(to: job)
            }
        }
        await syncTimelines()
    }

    /// Bring every on-screen job's timeline up to what its machine holds.
    ///
    /// Two cases, both by `GET …/timeline?since=<cursor>`: an active job whose
    /// stream is not attached is paged on the poll cadence; a finished job that
    /// reports more events than are held (a job opened from history, or one
    /// whose stream dropped before the end) is fetched once. A job that reports
    /// no `timelineEvents` came from a machine that predates timelines: the
    /// route is never called for it and it renders the legacy way.
    func syncTimelines() async {
        for id in messages.compactMap({ $0.job?.id }) {
            await syncTimeline(jobID: id)
        }
    }

    private func scheduleTimelineSync() {
        guard messages.contains(where: { ($0.job?.timelineEvents ?? 0) > 0 }) else { return }
        Task { [weak self] in await self?.syncTimelines() }
    }

    private func syncTimeline(jobID: String) async {
        guard let job = conversationJob(id: jobID) else { return }
        let state = jobLive[jobID] ?? JobLiveState()
        guard !state.timelineUnavailable, !state.isSyncingTimeline else { return }
        let reported = job.timelineEvents ?? 0
        guard reported > (timelineStore[jobID]?.cursor ?? 0) else { return }
        let wasActive = job.status.isActive
        if wasActive {
            guard jobStreamTasks[jobID] == nil else { return }
        } else {
            guard !state.fetchedFinishedTimeline else { return }
        }

        jobLive[jobID, default: JobLiveState()].isSyncingTimeline = true
        var completed = false
        do {
            var since = timelineStore[jobID]?.cursor ?? 0
            for _ in 0..<64 {
                let page = try await live.timelinePage(jobID, since)
                guard isOnScreen(jobID: jobID) else { return }
                applyTimeline(page.events, jobID: jobID)
                // Caught up with what the job reported: anything newer is the
                // next poll's, not another request now.
                if page.events.isEmpty || page.next <= since || page.complete || page.next >= reported {
                    completed = true
                    break
                }
                since = page.next
            }
        } catch CodexClientError.httpFailure(404, _) {
            // No such route: an older machine. Leave the job on the legacy path.
            jobLive[jobID]?.timelineUnavailable = true
        } catch {
            // A failed page is retried by the next poll.
        }
        guard jobLive[jobID] != nil else { return }
        jobLive[jobID]?.isSyncingTimeline = false
        CodexDiagnostics.log("job_timeline_paged", fields: [
            "jobId": jobID,
            "reported": String(reported),
            "timeline": String(timelineStore[jobID]?.cursor ?? 0),
            "jobActive": String(wasActive)
        ])
        if let latest = conversationJob(id: jobID), latest.status.isFinal {
            if completed, !wasActive { jobLive[jobID]?.fetchedFinishedTimeline = true }
            settleTimeline(for: latest)
        }
    }

    /// The reduced timeline of a job on screen, or nil when its machine sent none
    /// and the job renders the legacy way.
    func timeline(forJobID id: String) -> RelayTimeline? {
        guard let timeline = timelines[id], !timeline.isEmpty else { return nil }
        return timeline
    }

    /// Reduce events into the job's timeline. A sequence number already applied
    /// (a reconnect, a poll overlapping the stream) is ignored by the reducer,
    /// so the same event arriving twice is drawn once.
    private func applyTimeline(_ envelopes: [RelayTimelineEnvelope], jobID: String) {
        guard !envelopes.isEmpty else { return }
        var timeline = timelineStore[jobID] ?? RelayTimeline()
        var changed = false
        for envelope in envelopes where timeline.apply(envelope) {
            changed = true
        }
        guard changed else { return }
        timelineStore[jobID] = timeline
        dirtyTimelineIDs.insert(jobID)
        schedulePublish()
    }

    /// Once a job is over nothing in it is still running, whichever way the
    /// phone learned it was over: the stream's `done`, a poll, a cancel.
    private func settleTimeline(for job: CodexJob) {
        guard job.status.isFinal, let timeline = timelineStore[job.id], timeline.hasRunningSteps else { return }
        var settled = timeline
        settled.settle(as: job.status == .succeeded ? .done : job.status == .failed ? .failed : .cancelled)
        timelineStore[job.id] = settled
        dirtyTimelineIDs.insert(job.id)
        // The end of a run is not something to show a beat late.
        publishPending()
    }

    private func appendLiveTail(
        jobID: String,
        _ chunk: String,
        at offset: Int64,
        channel: WritableKeyPath<JobLiveState, Int64>
    ) {
        guard !chunk.isEmpty else { return }
        var state = jobLive[jobID] ?? JobLiveState()
        let consumed = state[keyPath: channel]
        let bytes = Array(chunk.utf8)
        let end = offset + Int64(bytes.count)
        // Bytes at or before the offset already consumed are a replay.
        guard end > consumed else { return }
        let fresh = offset >= consumed
            ? chunk
            : String(decoding: bytes.dropFirst(Int(consumed - offset)), as: UTF8.self)
        state[keyPath: channel] = end
        jobLive[jobID] = state

        var tail = (tailStore[jobID] ?? "") + fresh
        if tail.count > Self.liveTailCharacterCap {
            tail = String(tail.suffix(Self.liveTailCharacterCap))
        }
        tailStore[jobID] = tail
        dirtyTailIDs.insert(jobID)
        schedulePublish()
    }

    // MARK: - Coalesced publishing

    /// Live content arrives an event at a time and each publish redraws the
    /// transcript. The first change after a quiet spell is shown at once; what
    /// follows within `publishInterval` is shown together when it elapses.
    private func schedulePublish() {
        guard publishTask == nil else { return }
        let wait = publishInterval - Date().timeIntervalSince(lastPublishAt)
        guard wait > 0 else {
            publishPending()
            return
        }
        publishTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.publishTask = nil
            self.publishPending()
        }
    }

    /// Show everything received so far. Called by the timer, and directly at
    /// the moments that must not wait for it (a turn ending, a job finishing).
    func publishPending() {
        publishTask?.cancel()
        publishTask = nil
        guard !dirtyTimelineIDs.isEmpty || !dirtyTailIDs.isEmpty || !pendingChatDeltas.isEmpty else { return }
        lastPublishAt = Date()
        if !dirtyTimelineIDs.isEmpty {
            var next = timelines
            for id in dirtyTimelineIDs { next[id] = timelineStore[id] }
            dirtyTimelineIDs.removeAll()
            if next != timelines { timelines = next }
        }
        if !dirtyTailIDs.isEmpty {
            var next = liveJobTails
            for id in dirtyTailIDs { next[id] = tailStore[id] }
            dirtyTailIDs.removeAll()
            if next != liveJobTails { liveJobTails = next }
        }
        if !pendingChatDeltas.isEmpty {
            var next = messages
            var changed = false
            for (id, delta) in pendingChatDeltas {
                guard let index = next.firstIndex(where: { $0.id == id }) else { continue }
                next[index].text += delta
                changed = true
            }
            pendingChatDeltas.removeAll()
            if changed { messages = next }
        }
    }

    /// The conversation on screen was replaced. Live state belongs to the jobs
    /// a conversation shows, so what belonged to the jobs just left goes with
    /// them: their streams stop, their timelines and tails are dropped, and
    /// their approvals are no longer offered here.
    private func conversationDidChange() {
        let onScreen = Set(messages.compactMap { $0.job?.id })
        for id in jobStreamTasks.keys where !onScreen.contains(id) {
            stopJobStream(jobID: id)
        }
        jobLive = jobLive.filter { onScreen.contains($0.key) }
        timelineStore = timelineStore.filter { onScreen.contains($0.key) }
        tailStore = tailStore.filter { onScreen.contains($0.key) }
        dirtyTimelineIDs.formIntersection(onScreen)
        dirtyTailIDs.formIntersection(onScreen)
        if timelines.keys.contains(where: { !onScreen.contains($0) }) {
            timelines = timelines.filter { onScreen.contains($0.key) }
        }
        if liveJobTails.keys.contains(where: { !onScreen.contains($0) }) {
            liveJobTails = liveJobTails.filter { onScreen.contains($0.key) }
        }
        pendingChatDeltas = pendingChatDeltas.filter { pending in messages.contains { $0.id == pending.key } }
        // A chat answer still streaming into the conversation that was just
        // replaced has nowhere to go, and must not name the new one's thread.
        if let id = streamingMessageID, !messages.contains(where: { $0.id == id }) {
            streamTask?.cancel()
            streamTask = nil
            streamingMessageID = nil
            isSending = false
        }
        scopePendingApprovals()
        scheduleTimelineSync()
    }

    private func isOnScreen(jobID: String) -> Bool {
        messages.contains { $0.job?.id == jobID }
    }

    /// The copy of a job this conversation is showing.
    private func conversationJob(id: String) -> CodexJob? {
        messages.first(where: { $0.job?.id == id })?.job
    }

    // MARK: - Threads

    func startNewConversation() {
        conversationRevision = UUID()
        currentThreadID = nil
        currentThreadProvider = nil
        currentThreadMode = .task
        currentThreadWorkspaceID = nil
        currentThreadWorkspaceName = nil
        isLoadingThreadDetail = false
        watchedSessionID = nil
        nativeWatchQuietSince = nil
        messages = []
        conversationDidChange()
        prompt = ""
        draftAttachments = []
        errorMessage = nil
    }

    func addDraftAttachments(_ incoming: [RelayDraftAttachment]) {
        guard !incoming.isEmpty else { return }
        var next = draftAttachments
        var total = next.reduce(0) { $0 + $1.byteCount }
        for attachment in incoming {
            if next.count >= RelayAttachmentLimits.maxCount {
                errorMessage = "You can attach at most \(RelayAttachmentLimits.maxCount) files."
                break
            }
            if attachment.byteCount > RelayAttachmentLimits.maxBytes {
                errorMessage = "“\(attachment.filename)” is too large to attach."
                continue
            }
            if total + attachment.byteCount > RelayAttachmentLimits.maxTotalBytes {
                errorMessage = "Those files together are too large to attach."
                break
            }
            next.append(attachment)
            total += attachment.byteCount
        }
        draftAttachments = next
    }

    func removeDraftAttachment(id: UUID) {
        draftAttachments.removeAll { $0.id == id }
    }

    /// A Mac-session index row is metadata, not a portable transcript. Starting from it
    /// therefore creates a clean session, but it must still select the same harness so a
    /// Claude Code row can never silently open in Codex (or vice versa).
    func startFresh(from session: RelayMacSession) {
        startNewConversation()
        let provider = CodexProvider(rawProvider: session.harness)
        if let model = models.first(where: { $0.provider == provider && $0.supports(.task) }) {
            selectChoice(RelayModelChoice(model: model, mode: .task))
            errorMessage = nil
        } else {
            selectedChoice = nil
            selectedEffort = nil
            errorMessage = "\(provider.relayPresentation.title) is not currently available on this runner."
        }
        prompt = "Continue the work from “\(session.displayTitle)”."
    }

    func openThread(_ thread: CodexThread) async {
        guard belongsToHistoryScope(thread.workspaceId) else {
            errorMessage = "This thread belongs to a different folder."
            return
        }
        let revision = UUID()
        conversationRevision = revision
        // Show the thread's identity and whatever the feed already carries before
        // the detail round trip, matching the source-task "show immediately" path.
        presentThreadSeed(thread)
        isLoadingThreadDetail = true
        defer {
            if conversationRevision == revision {
                isLoadingThreadDetail = false
            }
        }
        do {
            let detail = try await fetchThreadDetail(
                thread.sessionId,
                workspaceID,
                thread.provider
            )
            guard conversationRevision == revision else { return }
            currentThreadID = detail.thread.sessionId
            currentThreadProvider = detail.thread.provider
            currentThreadMode = detail.thread.mode
            currentThreadWorkspaceID = detail.thread.workspaceId
            currentThreadWorkspaceName = detail.thread.workspaceName
            if let choice = Self.choiceMatchingThread(
                from: models,
                provider: detail.thread.provider,
                mode: detail.thread.mode,
                model: detail.thread.model
            ) {
                selectChoice(choice)
            }
            messages = conversationItems(from: detail)
            conversationDidChange()
            // After the items are in place: a stream only attaches for a job
            // the conversation is showing.
            for job in detail.jobs {
                attachJobStream(to: job)
            }
            errorMessage = nil
            beginNativeWatch(detail.thread)
        } catch {
            guard conversationRevision == revision else { return }
            errorMessage = error.localizedDescription
        }
    }

    private func presentThreadSeed(_ thread: CodexThread) {
        currentThreadID = thread.sessionId
        currentThreadProvider = thread.provider
        currentThreadMode = thread.mode
        currentThreadWorkspaceID = thread.workspaceId
        currentThreadWorkspaceName = thread.workspaceName

        if let choice = Self.choiceMatchingThread(
            from: models,
            provider: thread.provider,
            mode: thread.mode,
            model: thread.model
        ) {
            selectChoice(choice)
        }

        var items: [RelayConversationItem] = []
        let stamp = thread.updatedAt ?? thread.timestamp ?? Date()
        if let prompt = thread.lastPrompt?.trimmedNonEmpty {
            items.append(RelayConversationItem(
                role: .user,
                text: prompt,
                timestamp: stamp.addingTimeInterval(-1),
                provider: thread.provider,
                modelLabel: thread.model
            ))
        }
        if let result = thread.lastResult?.trimmedNonEmpty {
            items.append(RelayConversationItem(
                role: .assistant,
                text: result,
                timestamp: stamp,
                provider: thread.provider,
                modelLabel: thread.model
            ))
        } else if let error = thread.lastError?.trimmedNonEmpty {
            items.append(RelayConversationItem(
                role: .status,
                text: error,
                timestamp: stamp,
                provider: thread.provider,
                modelLabel: thread.model
            ))
        }
        messages = items
        conversationDidChange()
        errorMessage = nil
        beginNativeWatch(thread)
    }

    /// Follow a session that is running on the machine. Relay jobs already stream;
    /// a native transcript only moves when we re-read it. Opening an idle thread
    /// stops a watch left over from the previous conversation.
    private func beginNativeWatch(_ thread: CodexThread) {
        if thread.hasActiveJobs {
            if watchedSessionID != thread.sessionId {
                nativeWatchQuietSince = nil
                watchedSessionID = thread.sessionId
            }
            return
        }
        if currentThreadID == thread.sessionId {
            watchedSessionID = nil
            nativeWatchQuietSince = nil
        }
    }

    /// One poll of the open native transcript. Stops after the file has been
    /// quiet for `nativeWatchQuietLimit`, which covers a long tool call without
    /// following an idle thread forever.
    func refreshWatchedThreadIfNeeded() async {
        guard let sessionID = watchedSessionID, sessionID == currentThreadID else { return }
        guard !isSending, !isLoadingThreadDetail, !hasActiveConversationJob else { return }
        guard let provider = currentThreadProvider else { return }
        let revision = conversationRevision
        guard let detail = try? await fetchThreadDetail(sessionID, workspaceID, provider) else { return }
        guard conversationRevision == revision, currentThreadID == sessionID, !isSending else { return }

        let items = conversationItems(from: detail)
        let previous = messages.map(transcriptSignature)
        let next = items.map(transcriptSignature)
        if previous != next, !items.isEmpty || messages.isEmpty {
            messages = items
            conversationDidChange()
            nativeWatchQuietSince = nil
            for job in detail.jobs where job.status.isActive {
                attachJobStream(to: job)
            }
        }
        if detail.thread.hasActiveJobs {
            nativeWatchQuietSince = nil
        } else if nativeWatchQuietSince == nil {
            nativeWatchQuietSince = Date()
        } else if Date().timeIntervalSince(nativeWatchQuietSince ?? .distantPast) >= Self.nativeWatchQuietLimit {
            watchedSessionID = nil
            nativeWatchQuietSince = nil
        }
    }

    /// A restored thread, drawn the way a live one is.
    ///
    /// The transcript's turns keep the order the machine sent them in. Each job
    /// the thread ran is placed at the end of the turn it produced, after its
    /// own prompt and answer, and when the transcript already holds that answer
    /// the job row says so (`hidesJobAnswer`) instead of showing it a second
    /// time. Steps arrive on the message they precede and become that message's
    /// `historyTimeline`.
    private func conversationItems(from detail: CodexThreadDetail) -> [RelayConversationItem] {
        let sessionID = detail.thread.sessionId
        let threadIsActive = detail.thread.hasActiveJobs
        let fallbackStamp = detail.thread.updatedAt ?? Date()
        var seenKeys: [String: Int] = [:]
        var items: [RelayConversationItem] = []
        /// Whether `items[i]` carries a time the machine actually recorded.
        var isDated: [Bool] = []

        func stepsItem(_ steps: [RelayStepPatch], stamp: Date) -> RelayConversationItem {
            RelayConversationItem(
                id: "turn:\(sessionID):steps:\(steps.first?.id ?? "")",
                role: .assistant,
                text: "",
                timestamp: stamp,
                provider: detail.thread.provider,
                modelLabel: selectedChoice?.model.label,
                historyTimeline: RelayTimeline(historySteps: steps, threadIsActive: threadIsActive)
            )
        }

        for message in detail.messages {
            let role: RelayConversationItem.Role = message.role == .user ? .user : message.role == .assistant ? .assistant : .status
            let stamp = message.timestamp ?? fallbackStamp
            // Steps before a message that is not the agent's are a turn that
            // ended without an answer: they stand as a turn of their own.
            if role != .assistant, !message.steps.isEmpty {
                items.append(stepsItem(message.steps, stamp: stamp))
                isDated.append(message.timestamp != nil)
            }
            let key = Self.restoredTurnKey(role: message.role, message: message)
            let repeats = seenKeys[key, default: 0]
            seenKeys[key] = repeats + 1
            items.append(RelayConversationItem(
                id: "turn:\(sessionID):\(key)" + (repeats > 0 ? ":\(repeats)" : ""),
                role: role,
                text: message.text,
                timestamp: stamp,
                provider: detail.thread.provider,
                modelLabel: selectedChoice?.model.label,
                attachments: message.attachments.map(RelayDisplayedAttachment.from),
                historyTimeline: role == .assistant && !message.steps.isEmpty
                    ? RelayTimeline(historySteps: message.steps, threadIsActive: threadIsActive)
                    : nil
            ))
            isDated.append(message.timestamp != nil)
        }

        if !detail.trailingSteps.isEmpty {
            if let last = detail.messages.last, last.role == .assistant, let index = items.indices.last {
                items[index].historyTimeline = RelayTimeline(
                    historySteps: last.steps + detail.trailingSteps,
                    threadIsActive: threadIsActive
                )
            } else {
                // The last message is the user's: the steps are the answer so far.
                items.append(stepsItem(detail.trailingSteps, stamp: fallbackStamp))
                isDated.append(false)
            }
        }

        // Jobs, oldest first, each claiming the user turn that started it.
        let jobs = detail.jobs.sorted { ($0.createdAt ?? .distantPast) < ($1.createdAt ?? .distantPast) }
        var claimed: Set<Int> = []
        /// Job rows to insert before `items[key]` (`items.count` is the end).
        var inserts: [Int: [RelayConversationItem]] = [:]
        let anyDated = isDated.contains(true)
        for job in jobs {
            var row = jobItem(job)
            if let promptIndex = Self.restoredPromptIndex(for: job, in: items, isDated: isDated, claimed: claimed) {
                claimed.insert(promptIndex)
                let turnEnd = items.indices.first(where: { $0 > promptIndex && items[$0].role == .user }) ?? items.count
                let answered = items[(promptIndex + 1)..<turnEnd].contains {
                    $0.role == .assistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                }
                row.hidesJobAnswer = answered && !job.status.isActive
                inserts[turnEnd, default: []].append(row)
                continue
            }
            if items.isEmpty, let prompt = job.prompt?.trimmedNonEmpty {
                // No transcript at all: show what was asked, as a live turn does.
                inserts[0, default: []].append(RelayConversationItem(
                    id: "prompt:\(job.id)",
                    role: .user,
                    text: prompt,
                    timestamp: job.createdAt ?? fallbackStamp,
                    provider: job.provider,
                    modelLabel: job.model,
                    attachments: job.attachments.map(RelayDisplayedAttachment.from)
                ))
            }
            // A job the transcript does not mention goes where its time puts
            // it; one still running, or one that cannot be dated, goes last.
            var position = items.count
            if !job.status.isActive, anyDated, let anchor = job.createdAt {
                position = items.indices.first(where: { isDated[$0] && items[$0].timestamp > anchor }) ?? items.count
            }
            inserts[position, default: []].append(row)
        }

        var ordered: [RelayConversationItem] = []
        ordered.reserveCapacity(items.count + jobs.count)
        for index in items.indices {
            ordered.append(contentsOf: inserts[index] ?? [])
            ordered.append(items[index])
        }
        ordered.append(contentsOf: inserts[items.count] ?? [])
        return ordered
    }

    /// An id for a restored turn that does not depend on where the turn sits in
    /// the window the machine returned. Index-based ids renamed every turn each
    /// time the 120-turn window slid, so the whole transcript was rebuilt and
    /// the scroll position lost. A turn is named by when it was written, or by
    /// how it starts when the transcript carries no time.
    nonisolated static func restoredTurnKey(role: CodexThreadMessageRole, message: CodexThreadMessage) -> String {
        if let timestamp = message.timestamp {
            return "\(role.rawValue):\(Int64((timestamp.timeIntervalSince1970 * 1000).rounded()))"
        }
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in message.text.prefix(96).utf8 {
            hash = (hash ^ UInt64(byte)) &* 0x0000_0100_0000_01b3
        }
        return "\(role.rawValue):h\(String(hash, radix: 16))"
    }

    /// The user turn that started `job`: the first unclaimed one saying what
    /// the job was asked, else the first written while the job ran.
    nonisolated static func restoredPromptIndex(
        for job: CodexJob,
        in items: [RelayConversationItem],
        isDated: [Bool],
        claimed: Set<Int>
    ) -> Int? {
        func squashed(_ text: String?) -> String {
            (text ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        }
        let candidates = items.indices.filter { items[$0].role == .user && !claimed.contains($0) }
        let asked = squashed(job.prompt)
        if !asked.isEmpty {
            // A follow-up prompt can be wrapped by the app, and a harness can
            // wrap what it records, so either may contain the other.
            let match = candidates.first { index in
                let said = squashed(items[index].text)
                guard !said.isEmpty else { return false }
                if said == asked { return true }
                return (said.count >= 12 && asked.contains(said)) || (asked.count >= 12 && said.contains(asked))
            }
            if let match { return match }
        }
        guard let createdAt = job.createdAt else { return nil }
        let end = job.completedAt ?? .distantFuture
        return candidates.first { index in
            isDated[index]
                && items[index].timestamp >= createdAt.addingTimeInterval(-2)
                && items[index].timestamp <= end
        }
    }

    private func transcriptSignature(_ item: RelayConversationItem) -> String {
        "\(item.id)\u{0}\(item.text)\u{0}\(item.job?.status.label ?? "")\u{0}\(item.attachments.count)"
            + "\u{0}\(item.historyTimeline?.hashValue ?? 0)\u{0}\(item.hidesJobAnswer)"
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
        let revision = UUID()
        conversationRevision = revision
        // Previews/history already supplied this real job. Show it before any
        // network wait: a cold runner's provider probes can otherwise leave an
        // empty conversation on screen for tens of seconds.
        presentStandaloneJob(job)
        guard let latest = try? await fetchJobDetail(job.id),
              conversationRevision == revision,
              latest.id == job.id, belongsToHistoryScope(latest.workspaceId) else { return }
        presentStandaloneJob(latest)
    }

    private func presentStandaloneJob(_ latest: CodexJob) {
        currentThreadID = latest.threadSessionId
        currentThreadProvider = latest.provider
        currentThreadMode = .task
        currentThreadWorkspaceID = latest.workspaceId
        currentThreadWorkspaceName = latest.workspaceName

        if let choice = Self.choiceMatchingThread(
            from: models,
            provider: latest.provider,
            mode: .task,
            model: latest.model
        ) {
            selectChoice(choice)
        }

        var items: [RelayConversationItem] = []
        if let prompt = latest.prompt?.trimmedNonEmpty {
            items.append(RelayConversationItem(
                role: .user,
                text: prompt,
                timestamp: latest.createdAt ?? Date(),
                provider: latest.provider,
                modelLabel: latest.model,
                attachments: latest.attachments.map(RelayDisplayedAttachment.from)
            ))
        } else if !latest.attachments.isEmpty {
            items.append(RelayConversationItem(
                role: .user,
                text: "",
                timestamp: latest.createdAt ?? Date(),
                provider: latest.provider,
                modelLabel: latest.model,
                attachments: latest.attachments.map(RelayDisplayedAttachment.from)
            ))
        }
        items.append(jobItem(latest))
        messages = items
        conversationDidChange()
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
                replaceJob(updated, from: .action)
            }
            await refreshThreads()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func loadFullLog(for job: CodexJob) async -> String {
        await loadFullLog(jobID: job.id)
    }

    func loadFullLog(jobID: String) async -> String {
        do {
            let full = try await client.fetchJob(id: jobID, includeFullLogs: true)
            replaceJob(full, from: .detail)
            return full.rawActivityOutput ?? full.displayOutput ?? ""
        } catch {
            errorMessage = error.localizedDescription
            return error.localizedDescription
        }
    }

    /// Live job copy for the run-log sheet. Prefer the conversation message, then the
    /// history list — never a struct captured at sheet presentation time.
    func liveJob(id: String) -> CodexJob? {
        if let job = messages.first(where: { $0.job?.id == id })?.job {
            return job
        }
        return jobs.first(where: { $0.id == id })
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

    /// Chat tokens are buffered and shown in batches, like every other live channel.
    private func append(delta: String, to id: String) {
        guard !delta.isEmpty else { return }
        pendingChatDeltas[id, default: ""] += delta
        schedulePublish()
    }

    private func jobItem(_ job: CodexJob) -> RelayConversationItem {
        RelayConversationItem(
            id: job.id,
            role: .job,
            text: job.displayOutput ?? job.errorMessage ?? job.status.label,
            timestamp: job.createdAt ?? Date(),
            provider: job.provider,
            modelLabel: job.model,
            job: job,
            canLoadFullLog: job.hasTruncatedServerOutput
        )
    }

    /// Where a copy of a job came from, which says how much it can be trusted to carry.
    private enum JobCopySource {
        /// The job stream: a partial `status` payload, or the terminal `done`.
        case stream
        /// A detail request: the 64 KiB preview, or the full logs.
        case detail
        /// The folder's list: the 4 KiB compact copy.
        case list
        /// The answer to something the user did (cancel).
        case action
    }

    /// Take in a newer copy of a job. It is merged into the copy already held,
    /// never swapped for it (`CodexJob.absorbing`), and it only touches the
    /// conversation when that conversation is showing the job: a copy of a job
    /// the user has left updates the history list and nothing else.
    private func replaceJob(_ incoming: CodexJob, from source: JobCopySource = .detail) {
        let listIndex = jobs.firstIndex(where: { $0.id == incoming.id })
        let onScreenIndex = messages.firstIndex(where: { $0.job?.id == incoming.id })
        let held = onScreenIndex.flatMap { messages[$0].job } ?? listIndex.map { jobs[$0] }
        let job = held?.absorbing(incoming) ?? incoming

        if let index = onScreenIndex {
            var item = messages[index]
            item.job = job
            item.text = job.displayOutput ?? job.errorMessage ?? job.status.label
            item.modelLabel = job.model ?? item.modelLabel
            item.canLoadFullLog = job.hasTruncatedServerOutput
            if item != messages[index] { messages[index] = item }
            adoptThread(from: job)
        }
        if let listIndex {
            if jobs[listIndex] != job { jobs[listIndex] = job }
        } else if source != .list {
            jobs.insert(job, at: 0)
        }

        guard !job.status.isActive else { return }
        if tailStore[job.id] != nil || liveJobTails[job.id] != nil {
            tailStore[job.id] = nil
            dirtyTailIDs.insert(job.id)
            publishPending()
        }
        guard onScreenIndex != nil else { return }
        settleTimeline(for: job)
        if source != .stream { stopJobStream(jobID: job.id) }
        // The job ended, but what said so carries little or none of its text:
        // fetch the real ending once.
        let endedHere = held?.status.isFinal != true && job.status.isFinal
        if endedHere, source != .detail, incoming.detailRank < 2 {
            refreshFinishedJobDetail(id: job.id)
        }
        if endedHere { scheduleTimelineSync() }
    }

    private func refreshFinishedJobDetail(id: String) {
        guard !detailRefreshesInFlight.contains(id) else { return }
        detailRefreshesInFlight.insert(id)
        Task { [weak self] in
            guard let self else { return }
            let detail = try? await self.fetchJobDetail(id)
            self.detailRefreshesInFlight.remove(id)
            guard let detail, detail.id == id, self.isOnScreen(jobID: id) else { return }
            self.replaceJob(detail, from: .detail)
        }
    }

    /// Keep the open conversation on one native session. Creating a Codex job
    /// does not yet have a session id, so never write nil over a thread we
    /// already have; adopt the id as soon as the job reports it.
    private func adoptThread(from job: CodexJob) {
        currentThreadID = Self.adoptedThreadID(currentThreadID: currentThreadID, job: job)
        if currentThreadProvider == nil {
            currentThreadProvider = job.provider
        }
        if currentThreadWorkspaceID == nil {
            currentThreadWorkspaceID = job.workspaceId
        }
        if currentThreadWorkspaceName == nil {
            currentThreadWorkspaceName = job.workspaceName
        }
    }

    /// Fold the list's copies into the jobs on screen. They are the poorest
    /// copies there are, so this only ever moves status forward.
    private func mergeUpdatedJobs(_ listed: [CodexJob]) {
        for job in listed where isOnScreen(jobID: job.id) {
            replaceJob(job, from: .list)
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

    /// Pick the catalog row that can actually continue this thread. Empty catalogs
    /// stay unselected rather than falling back to a different harness.
    nonisolated static func choiceMatchingThread(
        from models: [CodexModelDescriptor],
        provider: CodexProvider,
        mode: RelayInteractionMode,
        model: String?
    ) -> RelayModelChoice? {
        let choices = RelayModelDiscovery.sections(from: models).allChoices.filter {
            $0.mode == mode && $0.executionProvider == provider
        }
        if let model, let exact = choices.first(where: {
            $0.model.id == model || $0.model.taskModel == model
        }) {
            return exact
        }
        return choices.first
    }

    /// Which task runner executes a model's jobs. Cursor keeps its own runner; Azure
    /// descriptors fall back to the Codex runner (they are chat-first).
    nonisolated static func taskProvider(for model: CodexModelDescriptor) -> CodexProvider {
        switch model.provider {
        case .claude, .bedrock:
            return .claude
        case .cursor:
            return .cursor
        case .kimi:
            return .kimi
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

    /// Prefer the open thread, then the latest job already on screen. A follow-up
    /// must not start a second Codex session just because the first job's id
    /// arrived after create returned.
    nonisolated static func resumeSessionID(
        currentThreadID: String?,
        currentThreadProvider: CodexProvider?,
        currentThreadWorkspaceID: String?,
        provider: CodexProvider,
        workspaceID: String?,
        conversationJobs: [CodexJob]
    ) -> String? {
        if let currentThreadID, !currentThreadID.isEmpty,
           currentThreadProvider == provider,
           currentThreadWorkspaceID == workspaceID {
            return currentThreadID
        }
        for job in conversationJobs.reversed() {
            guard job.provider == provider, job.workspaceId == workspaceID,
                  let sessionID = job.threadSessionId else { continue }
            return sessionID
        }
        return nil
    }

    /// Never replace an open thread with nil. A job that has not yet learned
    /// its session id must leave the conversation where it is.
    nonisolated static func adoptedThreadID(currentThreadID: String?, job: CodexJob) -> String? {
        currentThreadID?.trimmedNonEmpty ?? job.threadSessionId
    }

    /// When this conversation's last run died before Codex persisted the turn,
    /// "Go on" still has to carry the unfinished instruction.
    nonisolated static func followUpTaskPrompt(userText: String, conversationJobs: [CodexJob]) -> String {
        let text = userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let last = conversationJobs.last, last.status.didEndBeforeSuccess else {
            return text
        }
        var unfinished: [String] = []
        for job in conversationJobs.reversed() {
            if job.status.didFinishSuccessfully { break }
            if let prompt = job.prompt?.trimmedNonEmpty {
                unfinished.append(prompt)
            }
        }
        unfinished.reverse()
        let remaining = unfinished.filter { !$0.isEmpty && !text.contains($0) }
        guard !remaining.isEmpty else { return text }
        return """
        Previous instruction in this thread (the last run stopped before it finished):

        \(remaining.joined(separator: "\n\n"))

        Continue that work. The user now says:

        \(text)
        """
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
        jobs.sorted { lhs, rhs in
            if lhs.status.isActive != rhs.status.isActive { return lhs.status.isActive && !rhs.status.isActive }
            let lhsDate = lhs.updatedAt ?? lhs.createdAt ?? .distantPast
            let rhsDate = rhs.updatedAt ?? rhs.createdAt ?? .distantPast
            return lhsDate > rhsDate
        }
    }
}
