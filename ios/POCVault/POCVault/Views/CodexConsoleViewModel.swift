import Foundation
import UserNotifications

struct CodexCompletionSignal: Equatable {
    let key: String
    let title: String
    let body: String
    let jobID: String?
    let sessionID: String?

    var notificationIdentifier: String {
        "codex-completion-\(key.replacingOccurrences(of: ":", with: "-"))"
    }

    var threadIdentifier: String {
        guard let sessionID else { return "codex" }
        return "codex-thread-\(sessionID)"
    }

    static func completedJobs(
        previouslyActiveJobIDs: Set<String>,
        jobs: [CodexJob],
        notifiedKeys: Set<String>
    ) -> [CodexCompletionSignal] {
        jobs.compactMap { job in
            guard previouslyActiveJobIDs.contains(job.id),
                  job.status.shouldNotifyCompletion,
                  job.isReadyForCompletionNotification else {
                return nil
            }
            let key = "job:\(job.id)"
            guard !notifiedKeys.contains(key) else { return nil }
            return CodexCompletionSignal(
                key: key,
                title: title(for: job.status, provider: job.provider),
                body: body(
                    for: job.status,
                    provider: job.provider,
                    subject: subject(from: job.prompt, fallback: job.workspaceName ?? job.workspaceId ?? "your \(job.provider.displayName) run")
                ),
                jobID: job.id,
                sessionID: job.threadSessionId
            )
        }
    }

    static func completedThreads(
        previouslyActiveThreadIDs: Set<String>,
        threads: [CodexThread],
        notifiedKeys: Set<String>
    ) -> [CodexCompletionSignal] {
        threads.compactMap { thread in
            guard previouslyActiveThreadIDs.contains(thread.sessionId),
                  !thread.hasActiveJobs,
                  let status = thread.lastJobStatus,
                  status.shouldNotifyCompletion,
                  thread.isReadyForCompletionNotification else {
                return nil
            }
            let key = thread.lastJobId.map { "job:\($0)" } ?? "thread:\(thread.sessionId)"
            guard !notifiedKeys.contains(key) else { return nil }
            return CodexCompletionSignal(
                key: key,
                title: title(for: status, provider: thread.provider),
                body: body(for: status, provider: thread.provider, subject: subject(from: thread.lastPrompt, fallback: thread.workspaceLabel)),
                jobID: thread.lastJobId,
                sessionID: thread.sessionId
            )
        }
    }

    private static func title(for status: CodexJobStatus, provider: CodexProvider) -> String {
        switch status {
        case .succeeded:
            return "\(provider.displayName) finished"
        case .failed, .timeout:
            return "\(provider.displayName) needs attention"
        case .canceled:
            return "\(provider.displayName) was canceled"
        case .queued, .running, .canceling, .unknown:
            return "\(provider.displayName) updated"
        }
    }

    private static func body(for status: CodexJobStatus, provider: CodexProvider, subject: String) -> String {
        switch status {
        case .succeeded:
            return "Your \(provider.displayName) thread is ready: \(subject)"
        case .failed:
            return "\(provider.displayName) hit an error: \(subject)"
        case .timeout:
            return "\(provider.displayName) timed out: \(subject)"
        case .canceled:
            return "\(provider.displayName) was canceled: \(subject)"
        case .queued, .running, .canceling, .unknown:
            return "\(provider.displayName) updated: \(subject)"
        }
    }

    private static func subject(from value: String?, fallback: String) -> String {
        let rawSubject = CodexThread.threadTitle(from: value) ?? nonEmpty(value) ?? fallback
        return shortened(rawSubject)
    }

    private static func nonEmpty(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static func shortened(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 120 else { return trimmed }
        return "\(String(trimmed.prefix(117)).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }
}

protocol CodexCompletionNotifying {
    func prepareForNotifications() async
    func sendCompletionNotification(_ signal: CodexCompletionSignal) async
}

struct CodexNoopCompletionNotifier: CodexCompletionNotifying {
    func prepareForNotifications() async {}
    func sendCompletionNotification(_ signal: CodexCompletionSignal) async {}
}

final class CodexLocalNotificationService: NSObject, CodexCompletionNotifying, UNUserNotificationCenterDelegate {
    private let center: UNUserNotificationCenter
    private var preparedAuthorization = false
    private var canSendNotifications = false

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.delegate = self
    }

    func prepareForNotifications() async {
        guard !preparedAuthorization else { return }
        preparedAuthorization = true

        let settings = await center.notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            canSendNotifications = true
        case .notDetermined:
            canSendNotifications = ((try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true)
        case .denied:
            canSendNotifications = false
        @unknown default:
            canSendNotifications = false
        }
    }

    func sendCompletionNotification(_ signal: CodexCompletionSignal) async {
        await prepareForNotifications()
        guard canSendNotifications else { return }

        let content = UNMutableNotificationContent()
        content.title = signal.title
        content.body = signal.body
        content.sound = .default
        content.threadIdentifier = signal.threadIdentifier
        content.userInfo = [
            "codexCompletionKey": signal.key,
            "codexJobID": signal.jobID ?? "",
            "codexSessionID": signal.sessionID ?? ""
        ]

        let request = UNNotificationRequest(
            identifier: signal.notificationIdentifier,
            content: content,
            trigger: nil
        )
        try? await center.add(request)
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .list, .sound])
    }
}

private extension CodexJobStatus {
    var shouldNotifyCompletion: Bool {
        switch self {
        case .succeeded, .failed, .canceled, .timeout:
            return true
        case .queued, .running, .canceling, .unknown:
            return false
        }
    }
}

private extension CodexJob {
    var isReadyForCompletionNotification: Bool {
        switch status {
        case .succeeded:
            return displayOutput?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        case .failed, .timeout, .canceled:
            return true
        case .queued, .running, .canceling, .unknown:
            return false
        }
    }
}

private extension CodexThread {
    var isReadyForCompletionNotification: Bool {
        switch lastJobStatus {
        case .some(.succeeded):
            return lastResult?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        case .some(.failed), .some(.timeout), .some(.canceled):
            return true
        case .some(.queued), .some(.running), .some(.canceling), .some(.unknown), .none:
            return false
        }
    }
}

struct CodexAgentMonitorPolicy: Hashable {
    static func shouldStartAppMonitor(isRunningTests: Bool) -> Bool {
        !isRunningTests
    }

    static func shouldRefresh(
        hasActiveJobs: Bool,
        observedActiveJobCount: Int,
        observedActiveThreadCount: Int
    ) -> Bool {
        hasActiveJobs || observedActiveJobCount > 0 || observedActiveThreadCount > 0
    }
}

@MainActor
final class CodexConsoleViewModel: ObservableObject {
    let provider: CodexProvider

    @Published private(set) var health: CodexHealth?
    @Published private(set) var workspaces: [CodexWorkspace] = []
    @Published private(set) var sessions: [CodexSession] = []
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var workspaceDirectoryListing: CodexWorkspaceDirectoryListing?
    @Published private(set) var isRefreshing = false
    @Published private(set) var isCreating = false
    @Published private(set) var isTranscribing = false
    @Published private(set) var isLoadingWorkspaceDirectories = false
    @Published private(set) var isSelectingWorkspaceDirectory = false
    @Published private(set) var isCreatingWorkspaceDirectory = false
    @Published private(set) var cancellingJobIDs: Set<String> = []
    @Published private(set) var deletingThreadIDs: Set<String> = []
    @Published private(set) var lastRefreshedAt: Date?
    @Published private(set) var connectionNotice: String?
    @Published var selectedWorkspaceID: String? {
        didSet {
            guard selectedWorkspaceID != oldValue else { return }
            clearSelectedSessionIfNeeded()
        }
    }
    @Published var selectedSessionID: String?
    @Published var prompt = ""
    @Published var timeoutMs = 1_800_000
    @Published var selectedModel = CodexProvider.defaultProvider.defaultModel
    @Published var selectedReasoningEffort: CodexReasoningEffort = CodexProvider.defaultProvider.defaultReasoningEffort
    @Published var selectedRunMode: CodexRunMode = .quality
    @Published private(set) var attachments: [CodexJobAttachment] = []
    @Published private(set) var selectedSkills: [CodexSkill] = []
    @Published var errorMessage: String?

    private let client: CodexClient
    private let completionNotifier: CodexCompletionNotifying
    private var hasBootstrapped = false
    private var observedActiveJobIDs: Set<String> = []
    private var observedActiveThreadIDs: Set<String> = []
    private var notifiedCompletionKeys: Set<String> = []

    init(
        client: CodexClient,
        provider: CodexProvider = .defaultProvider,
        completionNotifier: CodexCompletionNotifying = CodexNoopCompletionNotifier()
    ) {
        self.client = client
        self.provider = provider
        self.completionNotifier = completionNotifier
        self.selectedModel = provider.defaultModel
        self.selectedReasoningEffort = provider.defaultReasoningEffort
    }

    nonisolated static func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError {
            return true
        }
        if let urlError = error as? URLError, urlError.code == .cancelled {
            return true
        }

        let nsError = error as NSError
        return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
    }

    nonisolated static func isHTTPNotFound(_ error: Error) -> Bool {
        if let codexError = error as? CodexClientError {
            return codexError.statusCode == 404
        }
        let summary = CodexErrorSummary(message: error.localizedDescription)
        return summary.statusCode == 404
    }

    nonisolated static func isTransientConnection(_ error: Error) -> Bool {
        if let urlError = error as? URLError {
            return transientURLCodes.contains(urlError.code)
        }

        let nsError = error as NSError
        let code = URLError.Code(rawValue: nsError.code)
        if nsError.domain == NSURLErrorDomain,
           transientURLCodes.contains(code) {
            return true
        }

        let message = error.localizedDescription.lowercased()
        return message.contains("network connection was lost")
            || message.contains("not connected to the internet")
            || message.contains("timed out")
            || message.contains("could not connect")
    }

    private nonisolated static let transientURLCodes: Set<URLError.Code> = [
        .networkConnectionLost,
        .notConnectedToInternet,
        .timedOut,
        .cannotFindHost,
        .cannotConnectToHost,
        .dnsLookupFailed
    ]

    var endpointDisplay: String {
        guard let host = client.baseURL.host(percentEncoded: false) ?? client.baseURL.host else {
            return client.baseURL.absoluteString
        }
        if let port = client.baseURL.port {
            return "\(host):\(port)"
        }
        return host
    }

    var selectedWorkspace: CodexWorkspace? {
        guard let selectedWorkspaceID else { return nil }
        return workspaces.first { $0.id == selectedWorkspaceID }
    }

    var selectedSession: CodexSession? {
        guard let selectedSessionID else { return nil }
        return sessions.first { $0.id == selectedSessionID }
    }

    var selectedThread: CodexThread? {
        guard let selectedSessionID else { return nil }
        return threads.first { $0.sessionId == selectedSessionID || $0.id == selectedSessionID }
    }

    var sessionsForSelectedWorkspace: [CodexSession] {
        guard let selectedWorkspaceID else { return sessions }
        return sessions.filter { $0.workspaceId == selectedWorkspaceID }
    }

    var threadsForSelectedWorkspace: [CodexThread] {
        guard let selectedWorkspaceID else { return threads }
        return threads.filter { $0.workspaceId == selectedWorkspaceID }
    }

    var jobsForSelectedWorkspace: [CodexJob] {
        guard let selectedWorkspaceID else { return jobs }
        return jobs.filter { $0.workspaceId == selectedWorkspaceID }
    }

    var visibleThreads: [CodexThread] {
        threadsForSelectedWorkspace.filter { !$0.isSmokeTest }
    }

    var visibleThreadCount: Int {
        visibleThreads.count
    }

    var threadFeedItems: [CodexThreadFeedItem] {
        CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs, workspaceID: selectedWorkspaceID)
    }

    var composeStatusItem: CodexThreadFeedItem? {
        CodexThreadFeedItem.composeStatusItem(
            selectedSessionID: selectedSessionID,
            threads: threads,
            jobs: jobs,
            workspaceID: selectedWorkspaceID
        )
    }

    var composeWorkspaceID: String {
        selectedWorkspaceID
            ?? workspaces.first(where: { $0.id == "poc-vault" })?.id
            ?? workspaces.first(where: { $0.isDefault })?.id
            ?? workspaces.first?.id
            ?? "poc-vault"
    }

    var composeWorkspaceLabel: String {
        Self.nonEmpty(selectedWorkspace?.name)
            ?? Self.nonEmpty(selectedWorkspaceID)
            ?? "Workspace"
    }

    var hasActiveJobs: Bool {
        jobsForSelectedWorkspace.contains { $0.status.isActive } || threadsForSelectedWorkspace.contains { $0.hasActiveJobs }
    }

    var shouldPollActiveWorkMonitor: Bool {
        CodexAgentMonitorPolicy.shouldRefresh(
            hasActiveJobs: hasActiveJobs,
            observedActiveJobCount: observedActiveJobIDs.count,
            observedActiveThreadCount: observedActiveThreadIDs.count
        )
    }

    private var hasCachedCodexContent: Bool {
        !workspaces.isEmpty || !sessions.isEmpty || !threads.isEmpty || !jobs.isEmpty
    }

    var shouldShowThreadEmptyState: Bool {
        !isRefreshing || lastRefreshedAt != nil
    }

    var connectionNoticeTitle: String {
        client.hasClientIdentity ? "Reconnecting to \(provider.displayName)" : "\(provider.displayName) needs certificate"
    }

    var connectionNoticeMessage: String {
        connectionNotice ?? "Could not refresh Codex yet."
    }

    var showsConnectionNoticeBanner: Bool {
        connectionNotice != nil && hasCachedCodexContent
    }

    var selectedSkillIDs: Set<String> {
        Set(selectedSkills.map(\.id))
    }

    var attachmentLimitText: String {
        "Up to \(Self.maxAttachmentCount) files, \(Self.maxAttachmentBytes / 1_048_576) MB each."
    }

    var modelOptions: [String] {
        provider.modelOptions
    }

    var reasoningEffortOptions: [CodexReasoningEffort] {
        provider.reasoningEffortOptions
    }

    func isCancelling(_ jobID: String) -> Bool {
        cancellingJobIDs.contains(jobID)
    }

    func isDeletingThread(_ sessionID: String) -> Bool {
        deletingThreadIDs.contains(sessionID)
    }

    func toggleSkill(_ skill: CodexSkill) {
        if let index = selectedSkills.firstIndex(of: skill) {
            selectedSkills.remove(at: index)
        } else {
            selectedSkills.append(skill)
        }
    }

    func removeSkill(_ skill: CodexSkill) {
        selectedSkills.removeAll { $0 == skill }
    }

    func makeAttachment(
        data: Data,
        filename: String,
        contentType: String,
        existing: [CodexJobAttachment]
    ) -> CodexJobAttachment? {
        guard existing.count < Self.maxAttachmentCount else {
            errorMessage = "You can attach up to \(Self.maxAttachmentCount) files."
            return nil
        }
        guard data.count <= Self.maxAttachmentBytes else {
            errorMessage = "\(filename) is larger than \(Self.maxAttachmentBytes / 1_048_576) MB."
            return nil
        }
        let totalBytes = existing.reduce(data.count) { $0 + $1.byteCount }
        guard totalBytes <= Self.maxAttachmentTotalBytes else {
            errorMessage = "Attachments are larger than \(Self.maxAttachmentTotalBytes / 1_048_576) MB total."
            return nil
        }
        errorMessage = nil
        return CodexJobAttachment(filename: filename, contentType: contentType, data: data)
    }

    func addComposeAttachment(data: Data, filename: String, contentType: String) {
        guard let attachment = makeAttachment(
            data: data,
            filename: filename,
            contentType: contentType,
            existing: attachments
        ) else {
            return
        }
        attachments.append(attachment)
    }

    func removeComposeAttachment(_ attachment: CodexJobAttachment) {
        attachments.removeAll { $0.id == attachment.id }
    }

    func appendTranscription(_ text: String) {
        let transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }

        let existingPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        if existingPrompt.isEmpty {
            prompt = transcript
        } else {
            prompt = "\(existingPrompt)\n\n\(transcript)"
        }
    }

    func transcribePromptAudio(fileURL: URL) async {
        if let text = await transcribeAudioText(fileURL: fileURL) {
            appendTranscription(text)
        }
    }

    func transcribeAudioText(fileURL: URL) async -> String? {
        isTranscribing = true
        defer { isTranscribing = false }

        do {
            let transcription = try await client.transcribeAudio(fileURL: fileURL)
            errorMessage = nil
            return transcription.text.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            guard !Self.isCancellation(error) else { return nil }
            errorMessage = error.localizedDescription
            return nil
        }
    }

    func bootstrapIfNeeded() async {
        guard !hasBootstrapped else { return }
        for attempt in 0..<3 {
            await refreshAll()
            if lastRefreshedAt != nil || hasCachedCodexContent {
                hasBootstrapped = true
                return
            }
            guard !Task.isCancelled, attempt < 2 else { return }
            try? await Task.sleep(nanoseconds: UInt64(attempt + 1) * 1_500_000_000)
        }
    }

    func refreshAll() async {
        isRefreshing = true
        defer { isRefreshing = false }
        let previouslyActiveJobIDs = observedActiveJobIDs.union(activeJobIDs(in: jobs))
        let previouslyActiveThreadIDs = observedActiveThreadIDs.union(activeThreadIDs(in: threads))

        await refreshHealth()

        var refreshErrors: [Error] = []
        var loadedCoreContent = false
        var loadedAnyContent = false

        do {
            let workspaceResponse = try await client.fetchWorkspaces()
            workspaces = workspaceResponse
            selectDefaultWorkspaceIfNeeded()
            loadedCoreContent = true
            loadedAnyContent = true
        } catch {
            if Self.isCancellation(error) { return }
            refreshErrors.append(error)
        }

        let workspaceID = selectedWorkspaceID
        async let jobRequest = client.fetchJobs(provider: provider, workspaceID: workspaceID, limit: 10)
        async let sessionRequest = client.fetchSessions(provider: provider, workspaceID: workspaceID, limit: 50)
        async let threadRequest = client.fetchThreads(provider: provider, workspaceID: workspaceID, limit: 50)

        do {
            let sessionResponse = try await sessionRequest
            sessions = Self.sortedSessions(sessionResponse)
            loadedCoreContent = true
            loadedAnyContent = true
        } catch {
            if Self.isCancellation(error) { return }
            refreshErrors.append(error)
        }

        do {
            let threadResponse = try await threadRequest
            threads = Self.sortedThreads(threadResponse)
            await handleCompletedThreads(threads, previouslyActiveThreadIDs: previouslyActiveThreadIDs)
            loadedCoreContent = true
            loadedAnyContent = true
        } catch {
            if Self.isCancellation(error) { return }
            refreshErrors.append(error)
        }

        do {
            let jobResponse = try await jobRequest
            jobs = Self.sortedJobs(jobResponse)
            await handleCompletedJobs(jobs, previouslyActiveJobIDs: previouslyActiveJobIDs)
            loadedAnyContent = true
        } catch {
            if Self.isCancellation(error) { return }
            refreshErrors.append(error)
        }

        if loadedAnyContent {
            clearSelectedSessionIfNeeded()
            errorMessage = nil
            if loadedCoreContent {
                connectionNotice = nil
            }
            lastRefreshedAt = Date()
            return
        }

        guard let error = refreshErrors.first else { return }
        if Self.isTransientConnection(error) {
                errorMessage = nil
                connectionNotice = connectionFailureMessage(
                    connectedMessage: "Connection dropped. Keeping \(provider.displayName) content in place and retrying."
                )
                return
        }
        errorMessage = error.localizedDescription
    }

    func refreshJobs() async {
        do {
            let previouslyActiveJobIDs = observedActiveJobIDs.union(activeJobIDs(in: jobs))
            jobs = Self.sortedJobs(try await client.fetchJobs(provider: provider, workspaceID: selectedWorkspaceID, limit: 10))
            await handleCompletedJobs(jobs, previouslyActiveJobIDs: previouslyActiveJobIDs)
            errorMessage = nil
            connectionNotice = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            if Self.isTransientConnection(error) {
                errorMessage = nil
                connectionNotice = connectionFailureMessage(
                    connectedMessage: "Connection dropped while refreshing jobs."
                )
                return
            }
            errorMessage = error.localizedDescription
        }
    }

    func refreshSessions() async {
        do {
            sessions = Self.sortedSessions(try await client.fetchSessions(provider: provider, workspaceID: selectedWorkspaceID, limit: 50))
            clearSelectedSessionIfNeeded()
            errorMessage = nil
            connectionNotice = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            if Self.isTransientConnection(error) {
                errorMessage = nil
                connectionNotice = connectionFailureMessage(
                    connectedMessage: "Connection dropped while refreshing sessions."
                )
                return
            }
            errorMessage = error.localizedDescription
        }
    }

    func refreshThreads() async {
        do {
            let previouslyActiveThreadIDs = observedActiveThreadIDs.union(activeThreadIDs(in: threads))
            threads = Self.sortedThreads(try await client.fetchThreads(provider: provider, workspaceID: selectedWorkspaceID, limit: 50))
            await handleCompletedThreads(threads, previouslyActiveThreadIDs: previouslyActiveThreadIDs)
            clearSelectedSessionIfNeeded()
            errorMessage = nil
            connectionNotice = nil
            lastRefreshedAt = Date()
        } catch {
            guard !Self.isCancellation(error) else { return }
            if Self.isTransientConnection(error) {
                errorMessage = nil
                connectionNotice = connectionFailureMessage(
                    connectedMessage: "Connection dropped while refreshing threads."
                )
                return
            }
            errorMessage = error.localizedDescription
        }
    }

    func refreshHealth() async {
        do {
            health = try await client.fetchHealth()
        } catch {
            guard !Self.isCancellation(error) else { return }
            health = CodexHealth(status: "offline", message: error.localizedDescription, isHealthy: false)
        }
    }

    func loadWorkspaceDirectories(path: String? = nil, query: String? = nil) async {
        isLoadingWorkspaceDirectories = true
        defer { isLoadingWorkspaceDirectories = false }

        do {
            let listing = try await client.fetchWorkspaceDirectories(path: path, query: query)
            workspaceDirectoryListing = listing
            if let workspace = listing.selectedWorkspace {
                upsert(workspace)
            }
            errorMessage = nil
            connectionNotice = nil
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func selectWorkspaceDirectory(path: String) async -> Bool {
        let trimmedPath = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPath.isEmpty else {
            errorMessage = "Choose a folder before selecting a workspace."
            return false
        }

        isSelectingWorkspaceDirectory = true
        defer { isSelectingWorkspaceDirectory = false }

        do {
            let workspace = try await client.selectWorkspace(path: trimmedPath)
            upsert(workspace)
            selectedWorkspaceID = workspace.id
            selectedSessionID = nil
            await refreshWorkspaceScopedContent()
            errorMessage = nil
            return true
        } catch {
            guard !Self.isCancellation(error) else { return false }
            errorMessage = error.localizedDescription
            return false
        }
    }

    func createWorkspaceDirectory(parentPath: String?, name: String) async -> Bool {
        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            errorMessage = "Enter a folder name."
            return false
        }

        let trimmedParentPath = parentPath?.trimmingCharacters(in: .whitespacesAndNewlines)
        isCreatingWorkspaceDirectory = true
        defer { isCreatingWorkspaceDirectory = false }

        do {
            let parentPath = trimmedParentPath.flatMap(Self.nonEmpty) ?? ""
            let workspace = try await client.createWorkspace(
                parentPath: parentPath,
                name: trimmedName
            )
            upsert(workspace)
            selectedWorkspaceID = workspace.id
            selectedSessionID = nil
            workspaceDirectoryListing = try await client.fetchWorkspaceDirectories(path: workspace.path, query: nil)
            await refreshWorkspaceScopedContent()
            errorMessage = nil
            connectionNotice = nil
            return true
        } catch {
            guard !Self.isCancellation(error) else { return false }
            errorMessage = error.localizedDescription
            return false
        }
    }

    func pollJobsWhileVisible() async {
        while !Task.isCancelled {
            if shouldPollActiveWorkMonitor {
                await completionNotifier.prepareForNotifications()
                await refreshJobs()
                await refreshSessions()
                await refreshThreads()
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    func monitorActiveWorkWhileAppIsOpen() async {
        await bootstrapIfNeeded()
        await pollJobsWhileVisible()
    }

    func loadJob(id: String, includeFullLogs: Bool = false) async throws -> CodexJob {
        let previouslyActiveJobIDs = observedActiveJobIDs.union(activeJobIDs(in: jobs))
        let job = try await client.fetchJob(id: id, includeFullLogs: includeFullLogs)
        upsert(job)
        await handleCompletedJobs([job], previouslyActiveJobIDs: previouslyActiveJobIDs)
        return job
    }

    func resolvedArtifactURL(_ value: String?) -> URL? {
        client.resolvedArtifactURL(value)
    }

    func fetchArtifactRaw(jobID: String, artifactID: String) async throws -> Data {
        try await client.fetchArtifactRaw(jobID: jobID, artifactID: artifactID)
    }

    func loadThreadDetail(sessionID: String) async throws -> CodexThreadDetail {
        let detail = try await client.fetchThreadDetail(sessionID: sessionID, provider: provider)
        upsert(detail.thread)
        for job in detail.jobs {
            upsert(job)
        }
        return detail
    }

    func createJobFromCompose() async -> String? {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty || !attachments.isEmpty else {
            errorMessage = "Add a prompt or attachment before starting a \(provider.displayName) job."
            return nil
        }
        let basePrompt = trimmedPrompt.isEmpty ? "Please inspect the attached file(s)." : trimmedPrompt
        let promptForJob = Self.prompt(basePrompt, applying: selectedSkills, provider: provider)
        let newJobID = await createJob(
            workspaceID: composeWorkspaceID,
            prompt: promptForJob,
            timeoutMs: timeoutMs,
            attachments: attachments,
            resumeSessionID: selectedSessionID
        )
        if newJobID != nil {
            prompt = ""
            attachments = []
            selectedSkills = []
        }
        return newJobID
    }

    func retry(_ job: CodexJob) async -> String? {
        guard let prompt = job.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty else {
            errorMessage = "This job does not include a prompt to retry."
            return nil
        }
        guard let workspaceID = job.workspaceId ?? selectedWorkspaceID ?? workspaces.first?.id else {
            errorMessage = "No workspace is available for retry."
            return nil
        }
        guard job.provider == provider else {
            errorMessage = "This job belongs to \(job.provider.displayName). Switch providers to retry it."
            return nil
        }

        return await createJob(
            workspaceID: workspaceID,
            prompt: prompt,
            timeoutMs: job.timeoutMs ?? timeoutMs,
            resumeSessionID: job.threadSessionId
        )
    }

    func selectSession(_ session: CodexSession) {
        guard session.provider == provider else {
            errorMessage = "This session belongs to \(session.provider.displayName)."
            return
        }
        selectedWorkspaceID = session.workspaceId ?? selectedWorkspaceID
        selectedSessionID = session.id
    }

    func selectThread(_ thread: CodexThread) {
        guard thread.provider == provider else {
            errorMessage = "This thread belongs to \(thread.provider.displayName)."
            return
        }
        selectedWorkspaceID = thread.workspaceId ?? selectedWorkspaceID
        selectedSessionID = thread.sessionId
    }

    func selectSessionID(_ sessionID: String, workspaceID: String?) {
        if let workspaceID, !workspaceID.isEmpty {
            selectedWorkspaceID = workspaceID
        }
        selectedSessionID = sessionID
    }

    func startNewThread() {
        selectedSessionID = nil
    }

    func createFollowUp(
        prompt: String,
        sessionID: String,
        workspaceID: String?,
        attachments: [CodexJobAttachment] = []
    ) async -> String? {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty || !attachments.isEmpty else {
            errorMessage = "Add a reply or attachment before continuing this thread."
            return nil
        }
        let resolvedWorkspaceID: String
        if let trimmedWorkspaceID = workspaceID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !trimmedWorkspaceID.isEmpty {
            resolvedWorkspaceID = trimmedWorkspaceID
        } else {
            resolvedWorkspaceID = composeWorkspaceID
        }
        if let selectedThread = threads.first(where: { $0.sessionId == sessionID || $0.id == sessionID }),
           selectedThread.provider != provider {
            errorMessage = "This thread belongs to \(selectedThread.provider.displayName)."
            return nil
        }

        let basePrompt = trimmedPrompt.isEmpty ? "Please inspect the attached file(s)." : trimmedPrompt
        let promptForJob = Self.prompt(basePrompt, applying: selectedSkills, provider: provider)
        let newJobID = await createJob(
            workspaceID: resolvedWorkspaceID,
            prompt: promptForJob,
            timeoutMs: timeoutMs,
            attachments: attachments,
            resumeSessionID: sessionID
        )
        if newJobID != nil {
            selectedSkills = []
        }
        return newJobID
    }

    func cancel(id: String) async {
        cancellingJobIDs.insert(id)
        defer { cancellingJobIDs.remove(id) }

        do {
            if let job = try await client.cancelJob(id: id) {
                upsert(job)
            }
            await refreshJobs()
            errorMessage = nil
        } catch {
            guard !Self.isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func deleteThread(_ thread: CodexThread) async -> Bool {
        guard !thread.hasActiveJobs else {
            errorMessage = "Wait for active jobs to finish before deleting this thread."
            return false
        }
        return await deleteThread(sessionID: thread.sessionId, workspaceID: thread.workspaceId)
    }

    func deleteThread(sessionID: String, workspaceID: String?) async -> Bool {
        deletingThreadIDs.insert(sessionID)
        defer { deletingThreadIDs.remove(sessionID) }

        do {
            try await client.deleteThread(sessionID: sessionID, workspaceID: workspaceID, provider: provider)
            removeLocalThread(sessionID: sessionID)
            errorMessage = nil
            connectionNotice = nil
            lastRefreshedAt = Date()
            return true
        } catch {
            guard !Self.isCancellation(error) else { return false }
            errorMessage = error.localizedDescription
            return false
        }
    }

    private func createJob(
        workspaceID: String,
        prompt: String,
        timeoutMs: Int?,
        attachments: [CodexJobAttachment] = [],
        resumeSessionID: String? = nil
    ) async -> String? {
        isCreating = true
        defer { isCreating = false }

        do {
            let response = try await client.createJob(
                CodexCreateJobRequest(
                    workspaceId: workspaceID,
                    prompt: prompt,
                    timeoutMs: timeoutMs,
                    model: selectedModel.trimmedNonEmpty,
                    reasoningEffort: provider == .codex ? effectiveReasoningEffort.rawValue : nil,
                    provider: provider,
                    attachments: attachments,
                    resumeSessionId: resumeSessionID
                )
            )
            observedActiveJobIDs.insert(response.id)
            if let resumeSessionID {
                observedActiveThreadIDs.insert(resumeSessionID)
            }
            await completionNotifier.prepareForNotifications()
            if let job = response.job {
                upsert(job)
            } else if let job = try? await client.fetchJob(id: response.id) {
                upsert(job)
            }
            await refreshWorkspaceScopedContent()
            errorMessage = nil
            return response.id
        } catch {
            guard !Self.isCancellation(error) else { return nil }
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func connectionFailureMessage(connectedMessage: String) -> String {
        guard client.hasClientIdentity else {
            return "Client certificate is not available yet. Unlock the phone, open Diagnostics if needed, then refresh \(provider.displayName)."
        }
        return connectedMessage
    }

    private func refreshWorkspaceScopedContent() async {
        await refreshJobs()
        await refreshSessions()
        await refreshThreads()
    }

    private func selectDefaultWorkspaceIfNeeded() {
        if let selectedWorkspaceID,
           workspaces.contains(where: { $0.id == selectedWorkspaceID }) {
            return
        }
        selectedWorkspaceID = workspaces.first(where: { $0.id == "poc-vault" })?.id
            ?? workspaces.first(where: { $0.isDefault })?.id
            ?? workspaces.first?.id
    }

    private func clearSelectedSessionIfNeeded() {
        guard let selectedSessionID else { return }
        guard let selectedSession = sessions.first(where: { $0.id == selectedSessionID }) else {
            guard let selectedThread = threads.first(where: { $0.sessionId == selectedSessionID || $0.id == selectedSessionID }) else {
                self.selectedSessionID = nil
                return
            }
            if let selectedWorkspaceID,
               let threadWorkspaceID = selectedThread.workspaceId,
               threadWorkspaceID != selectedWorkspaceID {
                self.selectedSessionID = nil
            }
            return
        }
        if let selectedWorkspaceID,
           let sessionWorkspaceID = selectedSession.workspaceId,
           sessionWorkspaceID != selectedWorkspaceID {
            self.selectedSessionID = nil
        }
    }

    private func upsert(_ job: CodexJob) {
        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
            jobs[index] = job
        } else {
            jobs.insert(job, at: 0)
        }
        jobs = Self.sortedJobs(jobs)
        if job.status.isActive {
            observedActiveJobIDs.insert(job.id)
            if let sessionID = job.threadSessionId {
                observedActiveThreadIDs.insert(sessionID)
            }
        }
        lastRefreshedAt = Date()
    }

    private func upsert(_ workspace: CodexWorkspace) {
        if let index = workspaces.firstIndex(where: { $0.id == workspace.id }) {
            workspaces[index] = workspace
        } else {
            workspaces.append(workspace)
        }
    }

    private func upsert(_ thread: CodexThread) {
        if let index = threads.firstIndex(where: { $0.sessionId == thread.sessionId || $0.id == thread.id }) {
            threads[index] = thread
        } else {
            threads.insert(thread, at: 0)
        }
        threads = Self.sortedThreads(threads)
        if thread.hasActiveJobs {
            observedActiveThreadIDs.insert(thread.sessionId)
        }
        lastRefreshedAt = Date()
    }

    private func removeLocalThread(sessionID: String) {
        threads.removeAll { $0.sessionId == sessionID || $0.id == sessionID }
        sessions.removeAll { $0.id == sessionID }
        jobs.removeAll { $0.threadSessionId == sessionID }
        observedActiveThreadIDs.remove(sessionID)
        if selectedSessionID == sessionID {
            selectedSessionID = nil
        }
    }

    private func handleCompletedJobs(_ loadedJobs: [CodexJob], previouslyActiveJobIDs: Set<String>) async {
        let signals = CodexCompletionSignal.completedJobs(
            previouslyActiveJobIDs: previouslyActiveJobIDs,
            jobs: loadedJobs,
            notifiedKeys: notifiedCompletionKeys
        )
        await sendCompletionSignals(signals)

        let loadedIDs = Set(loadedJobs.map(\.id))
        let waitingForOutputIDs = Set(loadedJobs.filter {
            previouslyActiveJobIDs.contains($0.id)
                && $0.status.shouldNotifyCompletion
                && !$0.isReadyForCompletionNotification
        }.map(\.id))
        observedActiveJobIDs.subtract(loadedIDs.subtracting(waitingForOutputIDs))
        observedActiveJobIDs.formUnion(activeJobIDs(in: loadedJobs))
        observedActiveJobIDs.formUnion(waitingForOutputIDs)
    }

    private func handleCompletedThreads(_ loadedThreads: [CodexThread], previouslyActiveThreadIDs: Set<String>) async {
        let signals = CodexCompletionSignal.completedThreads(
            previouslyActiveThreadIDs: previouslyActiveThreadIDs,
            threads: loadedThreads,
            notifiedKeys: notifiedCompletionKeys
        )
        await sendCompletionSignals(signals)

        let loadedIDs = Set(loadedThreads.map(\.sessionId))
        let waitingForOutputIDs = Set(loadedThreads.filter {
            previouslyActiveThreadIDs.contains($0.sessionId)
                && ($0.lastJobStatus?.shouldNotifyCompletion == true)
                && !$0.isReadyForCompletionNotification
        }.map(\.sessionId))
        observedActiveThreadIDs.subtract(loadedIDs.subtracting(waitingForOutputIDs))
        observedActiveThreadIDs.formUnion(activeThreadIDs(in: loadedThreads))
        observedActiveThreadIDs.formUnion(waitingForOutputIDs)
    }

    private func sendCompletionSignals(_ signals: [CodexCompletionSignal]) async {
        for signal in signals {
            guard !notifiedCompletionKeys.contains(signal.key) else { continue }
            notifiedCompletionKeys.insert(signal.key)
            await completionNotifier.sendCompletionNotification(signal)
        }
    }

    private func activeJobIDs(in jobs: [CodexJob]) -> Set<String> {
        Set(jobs.filter { $0.status.isActive }.map(\.id))
    }

    private func activeThreadIDs(in threads: [CodexThread]) -> Set<String> {
        Set(threads.filter(\.hasActiveJobs).map(\.sessionId))
    }

    private static func sortedJobs(_ jobs: [CodexJob]) -> [CodexJob] {
        jobs.sorted {
            ($0.updatedAt ?? $0.createdAt ?? .distantPast) > ($1.updatedAt ?? $1.createdAt ?? .distantPast)
        }
    }

    private static func sortedSessions(_ sessions: [CodexSession]) -> [CodexSession] {
        sessions.sorted {
            ($0.updatedAt ?? $0.timestamp ?? .distantPast) > ($1.updatedAt ?? $1.timestamp ?? .distantPast)
        }
    }

    private static func sortedThreads(_ threads: [CodexThread]) -> [CodexThread] {
        threads.sorted {
            ($0.updatedAt ?? $0.timestamp ?? .distantPast) > ($1.updatedAt ?? $1.timestamp ?? .distantPast)
        }
    }

    private static func prompt(_ prompt: String, applying skills: [CodexSkill], provider: CodexProvider) -> String {
        guard !skills.isEmpty else { return prompt }
        let names = skills.map(\.id).joined(separator: ", ")
        return "Use these \(provider.displayName) skills for this task: \(names).\n\n\(prompt)"
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private var effectiveReasoningEffort: CodexReasoningEffort {
        selectedRunMode.effectiveReasoningEffort ?? selectedReasoningEffort
    }

    private static let maxAttachmentCount = 6
    private static let maxAttachmentBytes = 8 * 1_048_576
    private static let maxAttachmentTotalBytes = 18 * 1_048_576
}

struct CodexSkill: Identifiable, Hashable {
    let id: String
    let title: String
    let group: String
    let summary: String

    var searchText: String {
        "\(id) \(title) \(group) \(summary)".lowercased()
    }

    static let all: [CodexSkill] = [
        CodexSkill(id: "poc-vault-deploy", title: "POC deploy", group: "Library", summary: "Create, host, publish, or deploy private POCs."),
        CodexSkill(id: "browser", title: "In-app browser", group: "Browser", summary: "Open and test local web targets in Codex."),
        CodexSkill(id: "chrome", title: "Chrome", group: "Browser", summary: "Use logged-in Chrome sessions and existing tabs."),
        CodexSkill(id: "computer-use", title: "Computer use", group: "Desktop", summary: "Operate local Mac apps by clicking and typing."),
        CodexSkill(id: "github:github", title: "GitHub", group: "Code", summary: "Inspect repositories, PRs, issues, and context."),
        CodexSkill(id: "github:gh-address-comments", title: "Address PR comments", group: "Code", summary: "Find and address GitHub review feedback."),
        CodexSkill(id: "github:gh-fix-ci", title: "Fix CI", group: "Code", summary: "Debug failing GitHub Actions checks."),
        CodexSkill(id: "github:yeet", title: "Publish PR", group: "Code", summary: "Commit, push, and open a draft PR."),
        CodexSkill(id: "linear", title: "Linear", group: "Planning", summary: "Read, create, and update Linear issues."),
        CodexSkill(id: "slack:slack", title: "Slack", group: "Comms", summary: "Read Slack context and route Slack work."),
        CodexSkill(id: "slack:slack-outgoing-message", title: "Slack message", group: "Comms", summary: "Draft or send outbound Slack content."),
        CodexSkill(id: "gmail:gmail", title: "Gmail", group: "Comms", summary: "Search, summarize, draft, and triage email."),
        CodexSkill(id: "google-calendar:google-calendar", title: "Calendar", group: "Scheduling", summary: "Inspect availability and manage events."),
        CodexSkill(id: "notion:notion-research-documentation", title: "Notion research", group: "Docs", summary: "Research Notion sources into documentation."),
        CodexSkill(id: "documents:documents", title: "Documents", group: "Artifacts", summary: "Create and edit Word or docx artifacts."),
        CodexSkill(id: "spreadsheets:Spreadsheets", title: "Spreadsheets", group: "Artifacts", summary: "Create, analyze, and format spreadsheet files."),
        CodexSkill(id: "presentations:Presentations", title: "Presentations", group: "Artifacts", summary: "Build and verify slide decks."),
        CodexSkill(id: "pdf", title: "PDF", group: "Artifacts", summary: "Read, render, create, and review PDFs."),
        CodexSkill(id: "imagegen", title: "Image generation", group: "Media", summary: "Generate or edit raster images."),
        CodexSkill(id: "figma", title: "Figma", group: "Design", summary: "Fetch design context and translate Figma nodes."),
        CodexSkill(id: "frontend-skill", title: "Frontend UI", group: "Design", summary: "Build visually strong app and web UI."),
        CodexSkill(id: "ui-ux-pro-max", title: "UI/UX research", group: "Design", summary: "Use UI and UX design intelligence."),
        CodexSkill(id: "human-code-review", title: "Human review wording", group: "Writing", summary: "Make technical feedback sound natural."),
        CodexSkill(id: "openai-docs", title: "OpenAI docs", group: "Research", summary: "Use current official OpenAI API documentation.")
    ]
}
