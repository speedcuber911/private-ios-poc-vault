import Foundation
import UserNotifications

/// True when `error` represents a cancelled task or URL request rather than a real failure.
/// Shared by every view model that polls or streams so cancellation never surfaces as an error.
func isCancellation(_ error: Error) -> Bool {
    if error is CancellationError {
        return true
    }
    if let urlError = error as? URLError, urlError.code == .cancelled {
        return true
    }

    let nsError = error as NSError
    return nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled
}

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
        case .queued, .running, .waitingForApproval, .canceling, .unknown:
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
        case .queued, .running, .waitingForApproval, .canceling, .unknown:
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

private extension CodexJobStatus {
    var shouldNotifyCompletion: Bool {
        switch self {
        case .succeeded, .failed, .canceled, .timeout:
            return true
        case .queued, .running, .waitingForApproval, .canceling, .unknown:
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
        case .queued, .running, .waitingForApproval, .canceling, .unknown:
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
        case .some(.queued), .some(.running), .some(.waitingForApproval), .some(.canceling), .some(.unknown), .none:
            return false
        }
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
