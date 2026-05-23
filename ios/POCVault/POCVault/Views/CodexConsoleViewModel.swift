import Foundation
import UserNotifications

struct CodexCompletionSignal: Equatable {
    let key: String
    let title: String
    let body: String
    let jobID: String?
    let sessionID: String?
    let workspaceID: String?
    let provider: CodexProvider

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
                sessionID: job.threadSessionId,
                workspaceID: job.workspaceId,
                provider: job.provider
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
                sessionID: thread.sessionId,
                workspaceID: thread.workspaceId,
                provider: thread.provider
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

struct CodexNotificationReply: Equatable {
    let text: String
    let sessionID: String
    let workspaceID: String?
    let provider: CodexProvider
}

final class CodexLocalNotificationService: NSObject, CodexCompletionNotifying, UNUserNotificationCenterDelegate {
    private enum Constants {
        static let categoryIdentifier = "CODEX_THREAD_COMPLETION"
        static let replyActionIdentifier = "CODEX_THREAD_REPLY"
    }

    private let center: UNUserNotificationCenter
    private var preparedAuthorization = false
    private var canSendNotifications = false
    private var replyHandler: (@MainActor (CodexNotificationReply) async -> Void)?

    init(center: UNUserNotificationCenter = .current()) {
        self.center = center
        super.init()
        center.delegate = self
        registerNotificationCategories()
    }

    func setReplyHandler(_ handler: @escaping @MainActor (CodexNotificationReply) async -> Void) {
        replyHandler = handler
    }

    private func registerNotificationCategories() {
        let replyAction = UNTextInputNotificationAction(
            identifier: Constants.replyActionIdentifier,
            title: "Reply",
            options: [],
            textInputButtonTitle: "Send",
            textInputPlaceholder: "Reply to this thread"
        )
        let category = UNNotificationCategory(
            identifier: Constants.categoryIdentifier,
            actions: [replyAction],
            intentIdentifiers: [],
            options: []
        )
        center.setNotificationCategories([category])
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
        content.categoryIdentifier = Constants.categoryIdentifier
        content.userInfo = [
            "codexCompletionKey": signal.key,
            "codexJobID": signal.jobID ?? "",
            "codexSessionID": signal.sessionID ?? "",
            "codexWorkspaceID": signal.workspaceID ?? "",
            "codexProvider": signal.provider.rawValue
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

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        guard response.actionIdentifier == Constants.replyActionIdentifier,
              let textResponse = response as? UNTextInputNotificationResponse else {
            completionHandler()
            return
        }

        let text = textResponse.userText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            completionHandler()
            return
        }

        let userInfo = response.notification.request.content.userInfo
        guard let sessionID = (userInfo["codexSessionID"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !sessionID.isEmpty else {
            completionHandler()
            return
        }

        let workspaceID = (userInfo["codexWorkspaceID"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty
        let provider = CodexProvider(rawProvider: userInfo["codexProvider"] as? String)
        let reply = CodexNotificationReply(
            text: text,
            sessionID: sessionID,
            workspaceID: workspaceID,
            provider: provider
        )

        Task { [replyHandler] in
            await replyHandler?(reply)
            completionHandler()
        }
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
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

@MainActor
final class CodexConsoleViewModel: ObservableObject {
    let provider: CodexProvider

    @Published private(set) var health: CodexHealth?
    @Published private(set) var workspaces: [CodexWorkspace] = []
    @Published private(set) var availableSkills: [CodexSkill] = []
    @Published private(set) var sessions: [CodexSession] = []
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var isCreating = false
    @Published private(set) var isTranscribing = false
    @Published private(set) var cancellingJobIDs: Set<String> = []
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
    @Published var selectedClaudePermissionMode: ClaudePermissionMode = .auto
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
        return sessions.filter { $0.workspaceId == nil || $0.workspaceId == selectedWorkspaceID }
    }

    var threadsForSelectedWorkspace: [CodexThread] {
        guard let selectedWorkspaceID else { return threads }
        return threads.filter { $0.workspaceId == nil || $0.workspaceId == selectedWorkspaceID }
    }

    var visibleThreads: [CodexThread] {
        threads.filter { !$0.isSmokeTest }
    }

    var visibleThreadCount: Int {
        visibleThreads.count
    }

    var threadFeedItems: [CodexThreadFeedItem] {
        CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs)
    }

    var composeWorkspaceID: String {
        selectedWorkspaceID
            ?? workspaces.first(where: { $0.id == "poc-vault" })?.id
            ?? workspaces.first(where: { $0.isDefault })?.id
            ?? workspaces.first?.id
            ?? "poc-vault"
    }

    var hasActiveJobs: Bool {
        jobs.contains { $0.status.isActive } || threads.contains { $0.hasActiveJobs }
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

    func toggleSkill(_ skill: CodexSkill) {
        if let index = selectedSkills.firstIndex(where: { $0.id == skill.id }) {
            selectedSkills.remove(at: index)
        } else {
            selectedSkills.append(skill)
        }
    }

    func removeSkill(_ skill: CodexSkill) {
        selectedSkills.removeAll { $0.id == skill.id }
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

        async let workspaceRequest = client.fetchWorkspaces()
        async let skillRequest = client.fetchSkills(provider: provider)
        async let jobRequest = client.fetchJobs(provider: provider, limit: 10)
        async let sessionRequest = client.fetchSessions(provider: provider, limit: 50)
        async let threadRequest = client.fetchThreads(provider: provider, limit: 50)
        await refreshHealth()

        var refreshErrors: [Error] = []
        var loadedCoreContent = false
        var loadedAnyContent = false

        do {
            let workspaceResponse = try await workspaceRequest
            workspaces = workspaceResponse
            loadedCoreContent = true
            loadedAnyContent = true
        } catch {
            if Self.isCancellation(error) { return }
            refreshErrors.append(error)
        }

        do {
            let skillResponse = try await skillRequest
            availableSkills = Self.sortedSkills(skillResponse)
            selectedSkills.removeAll { skill in
                !availableSkills.contains(where: { $0.id == skill.id })
            }
        } catch {
            if Self.isCancellation(error) { return }
            if availableSkills.isEmpty, Self.isHTTPNotFound(error) {
                availableSkills = []
            }
        }

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
            selectDefaultWorkspaceIfNeeded()
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
            jobs = Self.sortedJobs(try await client.fetchJobs(provider: provider, limit: 10))
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
            sessions = Self.sortedSessions(try await client.fetchSessions(provider: provider, limit: 50))
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
            threads = Self.sortedThreads(try await client.fetchThreads(provider: provider, limit: 50))
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

    func pollJobsWhileVisible() async {
        while !Task.isCancelled {
            if hasActiveJobs {
                await completionNotifier.prepareForNotifications()
                await refreshJobs()
                await refreshSessions()
                await refreshThreads()
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        }
    }

    func loadJob(id: String, includeFullLogs: Bool = false) async throws -> CodexJob {
        let previouslyActiveJobIDs = observedActiveJobIDs.union(activeJobIDs(in: jobs))
        let job = try await client.fetchJob(id: id, includeFullLogs: includeFullLogs)
        upsert(job)
        await handleCompletedJobs([job], previouslyActiveJobIDs: previouslyActiveJobIDs)
        return job
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
        let newJobID = await createJob(
            workspaceID: composeWorkspaceID,
            prompt: basePrompt,
            timeoutMs: timeoutMs,
            skillIDs: selectedSkills.map(\.id),
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
            skillIDs: job.skills,
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
        let newJobID = await createJob(
            workspaceID: resolvedWorkspaceID,
            prompt: basePrompt,
            timeoutMs: timeoutMs,
            skillIDs: selectedSkills.map(\.id),
            attachments: attachments,
            resumeSessionID: sessionID
        )
        if newJobID != nil {
            selectedSkills = []
        }
        return newJobID
    }

    func createNotificationReply(_ reply: CodexNotificationReply) async -> String? {
        guard reply.provider == provider else {
            errorMessage = "This notification belongs to \(reply.provider.displayName)."
            return nil
        }

        return await createFollowUpWithoutSelectedSkills(
            prompt: reply.text,
            sessionID: reply.sessionID,
            workspaceID: reply.workspaceID
        )
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

    private func createJob(
        workspaceID: String,
        prompt: String,
        timeoutMs: Int?,
        skillIDs: [String] = [],
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
                    model: selectedModel,
                    reasoningEffort: effectiveReasoningEffort.rawValue,
                    provider: provider,
                    permissionMode: provider == .claude ? selectedClaudePermissionMode : nil,
                    skills: skillIDs,
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
            await refreshJobs()
            await refreshSessions()
            await refreshThreads()
            errorMessage = nil
            return response.id
        } catch {
            guard !Self.isCancellation(error) else { return nil }
            errorMessage = error.localizedDescription
            return nil
        }
    }

    private func createFollowUpWithoutSelectedSkills(
        prompt: String,
        sessionID: String,
        workspaceID: String?
    ) async -> String? {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            errorMessage = "Add a reply before continuing this thread."
            return nil
        }

        let resolvedWorkspaceID: String
        if let trimmedWorkspaceID = workspaceID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !trimmedWorkspaceID.isEmpty {
            resolvedWorkspaceID = trimmedWorkspaceID
        } else if let selectedThread = threads.first(where: { $0.sessionId == sessionID || $0.id == sessionID }),
                  let threadWorkspaceID = selectedThread.workspaceId?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !threadWorkspaceID.isEmpty {
            resolvedWorkspaceID = threadWorkspaceID
        } else {
            resolvedWorkspaceID = composeWorkspaceID
        }

        return await createJob(
            workspaceID: resolvedWorkspaceID,
            prompt: trimmedPrompt,
            timeoutMs: timeoutMs,
            skillIDs: [],
            attachments: [],
            resumeSessionID: sessionID
        )
    }

    private func connectionFailureMessage(connectedMessage: String) -> String {
        guard client.hasClientIdentity else {
            return "Client certificate is not available yet. Unlock the phone, open Diagnostics if needed, then refresh \(provider.displayName)."
        }
        return connectedMessage
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

    private static func sortedSkills(_ skills: [CodexSkill]) -> [CodexSkill] {
        skills.sorted {
            if $0.group != $1.group {
                return $0.group < $1.group
            }
            if $0.title != $1.title {
                return $0.title < $1.title
            }
            return $0.id < $1.id
        }
    }

    private var effectiveReasoningEffort: CodexReasoningEffort {
        selectedRunMode.effectiveReasoningEffort ?? selectedReasoningEffort
    }

    private static let maxAttachmentCount = 6
    private static let maxAttachmentBytes = 8 * 1_048_576
    private static let maxAttachmentTotalBytes = 18 * 1_048_576
}
