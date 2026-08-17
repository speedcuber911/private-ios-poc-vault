import Foundation

/// Wrapper handed to `fullScreenCover(item:)` when a folder's chat opens. Resolving the
/// view model happens at tap time (inside the store), so presenting the cover never
/// mutates store state during a SwiftUI body evaluation.
struct RelayChatLaunch: Identifiable {
    let id: String
    let viewModel: RelayChatViewModel
    /// A launch from a "New session" affordance starts with a clean draft and
    /// immediately asks which runner/model should own it. History and push routes
    /// leave this false because they open a specific existing conversation.
    let presentsProviderPicker: Bool
}

/// App-wide cache of per-folder chat view models plus the single background job monitor.
///
/// - One `RelayChatViewModel` per canonical folder path, created lazily when a folder's
///   terminal opens and reused on every later visit. Streams are VM-owned, so dismissing
///   the chat cover never cancels them.
/// - LRU eviction capped at `capacity`; view models that are streaming or still have an
///   active job are pinned and skipped by eviction.
/// - Owns the app-wide ~2 s monitor loop that replaces the old per-tab monitors, and
///   feeds `CodexCompletionNotifying` so job/thread completion notifications keep firing
///   now that the console view models have been deleted.
@MainActor
final class RelayChatSessionStore: ObservableObject {
    nonisolated static let defaultCapacity = 6
    /// Canonical key for the jail root (chatting from the root browser screen).
    nonisolated static let rootKey = "workspace-root"

    private let client: CodexClient
    private let completionNotifier: CodexCompletionNotifying
    /// Injectable so eviction tests can pin arbitrary view models; the default pins any
    /// VM with a live chat stream or an active job in its conversation.
    private let isPinned: @MainActor (RelayChatViewModel) -> Bool
    let capacity: Int

    @Published private(set) var sessionsByKey: [String: RelayChatViewModel] = [:]
    /// Keys ordered least-recently-used first.
    private(set) var accessOrder: [String] = []

    private var observedActiveJobIDs: Set<String> = []
    private var observedActiveThreadIDs: Set<String> = []
    private var notifiedCompletionKeys: Set<String> = []

    init(
        client: CodexClient,
        completionNotifier: CodexCompletionNotifying = CodexNoopCompletionNotifier(),
        capacity: Int = RelayChatSessionStore.defaultCapacity,
        isPinned: @escaping @MainActor (RelayChatViewModel) -> Bool = { viewModel in
            viewModel.isStreaming || viewModel.hasActiveConversationJob
        }
    ) {
        self.client = client
        self.completionNotifier = completionNotifier
        self.capacity = max(1, capacity)
        self.isPinned = isPinned
    }

    // MARK: - Session lookup

    /// Canonical dictionary key for a folder path: trimmed, trailing slashes dropped,
    /// nil/empty mapping to the shared root key.
    nonisolated static func canonicalKey(forFolderPath path: String?) -> String {
        guard var trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return rootKey
        }
        while trimmed.count > 1, trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return trimmed
    }

    var cachedSessionCount: Int { sessionsByKey.count }

    func cachedSession(forFolderPath path: String?) -> RelayChatViewModel? {
        sessionsByKey[Self.canonicalKey(forFolderPath: path)]
    }

    /// Return the cached view model for `path` (creating one if needed), mark it most
    /// recently used, and pre-associate the folder's workspace.
    @discardableResult
    func session(forFolderPath path: String?, workspaceID: String? = nil) -> RelayChatViewModel {
        let key = Self.canonicalKey(forFolderPath: path)
        let viewModel: RelayChatViewModel
        if let cached = sessionsByKey[key] {
            viewModel = cached
        } else {
            viewModel = RelayChatViewModel(
                client: client,
                workspaceID: workspaceID,
                workspacePath: key == Self.rootKey ? nil : key
            )
            sessionsByKey[key] = viewModel
        }
        touch(key)
        evictIfNeeded(keeping: key)
        applyWorkspace(workspaceID: workspaceID, to: viewModel)
        return viewModel
    }

    /// Session lookup packaged for `fullScreenCover(item:)`.
    func launch(folderPath: String?, workspaceID: String? = nil) -> RelayChatLaunch {
        RelayChatLaunch(
            id: Self.canonicalKey(forFolderPath: folderPath),
            viewModel: session(forFolderPath: folderPath, workspaceID: workspaceID),
            presentsProviderPicker: false
        )
    }

    /// Start a genuinely new session in a folder even when its cached view model is
    /// still showing an older thread. The cache remains valuable for live streams and
    /// folder metadata; only its foreground conversation state is reset.
    func launchNewSession(folderPath: String?, workspaceID: String? = nil) -> RelayChatLaunch {
        let viewModel = session(forFolderPath: folderPath, workspaceID: workspaceID)
        viewModel.startNewConversation()
        return RelayChatLaunch(
            id: Self.canonicalKey(forFolderPath: folderPath),
            viewModel: viewModel,
            presentsProviderPicker: true
        )
    }

    /// Folder chats register lazily on first send (the VM owns that); the store only
    /// forwards a workspace id it already knows (e.g. the browser listed the folder as
    /// registered) so scoped thread history loads without a registration round-trip.
    private func applyWorkspace(workspaceID: String?, to viewModel: RelayChatViewModel) {
        guard let workspaceID = workspaceID?.trimmedNonEmpty else { return }
        viewModel.adoptWorkspaceID(workspaceID)
    }

    // MARK: - LRU eviction

    private func touch(_ key: String) {
        accessOrder.removeAll { $0 == key }
        accessOrder.append(key)
    }

    private func evictIfNeeded(keeping keptKey: String) {
        guard sessionsByKey.count > capacity else { return }
        for key in accessOrder {
            guard sessionsByKey.count > capacity else { return }
            guard key != keptKey, let candidate = sessionsByKey[key] else { continue }
            guard !isPinned(candidate) else { continue }
            sessionsByKey.removeValue(forKey: key)
            accessOrder.removeAll { $0 == key }
        }
    }

    // MARK: - App-wide job monitor

    /// Single app-open monitor loop (replaces the console view models' per-provider
    /// monitors and the Task tab's visibility-tied polling). Every ~2 s it lets each
    /// cached VM refresh its active job cards, and — while any work is observed active —
    /// polls jobs/threads app-wide so completion notifications fire even when no chat
    /// cover is on screen. Started from the root `.task`, guarded by
    /// `CodexAgentMonitorPolicy.shouldStartAppMonitor`.
    func monitorActiveWorkWhileAppIsOpen() async {
        await pollOnce(force: true)
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            if Task.isCancelled { break }
            await pollOnce(force: false)
        }
    }

    private var hasActiveSessionWork: Bool {
        sessionsByKey.values.contains { $0.isStreaming || $0.hasActiveConversationJob }
    }

    private func pollOnce(force: Bool) async {
        for viewModel in sessionsByKey.values {
            await viewModel.refreshActiveWorkIfNeeded()
        }

        if force {
            await refreshCompletionFeed()
            return
        }
        guard CodexAgentMonitorPolicy.shouldRefresh(
            hasActiveJobs: hasActiveSessionWork,
            observedActiveJobCount: observedActiveJobIDs.count,
            observedActiveThreadCount: observedActiveThreadIDs.count
        ) else { return }
        await completionNotifier.prepareForNotifications()
        await refreshCompletionFeed()
    }

    private func refreshCompletionFeed() async {
        do {
            let jobs = try await client.fetchJobs(provider: nil, workspaceID: nil, limit: 20)
            let threads = try await client.fetchThreads(provider: nil, workspaceID: nil, limit: 50)
            await handleCompletionCandidates(jobs: jobs, threads: threads)
        } catch {
            // Offline/transient failures just skip a beat; the next tick retries.
        }
    }

    private func handleCompletionCandidates(jobs: [CodexJob], threads: [CodexThread]) async {
        let previouslyActiveJobIDs = observedActiveJobIDs
        let previouslyActiveThreadIDs = observedActiveThreadIDs

        let signals = CodexCompletionSignal.completedJobs(
            previouslyActiveJobIDs: previouslyActiveJobIDs,
            jobs: jobs,
            notifiedKeys: notifiedCompletionKeys
        ) + CodexCompletionSignal.completedThreads(
            previouslyActiveThreadIDs: previouslyActiveThreadIDs,
            threads: threads,
            notifiedKeys: notifiedCompletionKeys
        )
        for signal in signals where !notifiedCompletionKeys.contains(signal.key) {
            notifiedCompletionKeys.insert(signal.key)
            await completionNotifier.sendCompletionNotification(signal)
        }

        reconcileObservedJobs(jobs, previouslyActive: previouslyActiveJobIDs)
        reconcileObservedThreads(threads, previouslyActive: previouslyActiveThreadIDs)
    }

    /// Mirror of the console monitor's bookkeeping: completed-but-unnotified jobs stay
    /// observed (their output has not landed yet) so the next poll retries the signal.
    private func reconcileObservedJobs(_ jobs: [CodexJob], previouslyActive: Set<String>) {
        let loadedIDs = Set(jobs.map(\.id))
        let waitingForOutputIDs = Set(jobs.filter { job in
            guard previouslyActive.contains(job.id), !job.status.isActive else { return false }
            if case .unknown = job.status { return false }
            return !notifiedCompletionKeys.contains("job:\(job.id)")
        }.map(\.id))
        observedActiveJobIDs.subtract(loadedIDs.subtracting(waitingForOutputIDs))
        observedActiveJobIDs.formUnion(jobs.filter { $0.status.isActive }.map(\.id))
        observedActiveJobIDs.formUnion(waitingForOutputIDs)
    }

    private func reconcileObservedThreads(_ threads: [CodexThread], previouslyActive: Set<String>) {
        let loadedIDs = Set(threads.map(\.sessionId))
        let waitingForOutputIDs = Set(threads.filter { thread in
            guard previouslyActive.contains(thread.sessionId), !thread.hasActiveJobs else { return false }
            guard let status = thread.lastJobStatus, !status.isActive else { return false }
            if case .unknown = status { return false }
            let key = thread.lastJobId.map { "job:\($0)" } ?? "thread:\(thread.sessionId)"
            return !notifiedCompletionKeys.contains(key)
        }.map(\.sessionId))
        observedActiveThreadIDs.subtract(loadedIDs.subtracting(waitingForOutputIDs))
        observedActiveThreadIDs.formUnion(threads.filter(\.hasActiveJobs).map(\.sessionId))
        observedActiveThreadIDs.formUnion(waitingForOutputIDs)
    }
}
