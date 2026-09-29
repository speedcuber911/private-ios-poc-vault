import Foundation

/// The three list calls behind Chats, plus the one decision it can make.
/// `CodexClient` is the real source; tests substitute a fake.
protocol RelayChatsFeedSource: AnyObject {
    func fetchChatsThreads(budget: CodexRequestBudget) async throws -> [CodexThread]
    func fetchChatsJobs(budget: CodexRequestBudget) async throws -> [CodexJob]
    func fetchChatsApprovals(budget: CodexRequestBudget) async throws -> [CodexApproval]
    func decideApproval(id: String, decision: CodexApprovalDecision, message: String?) async throws -> CodexApproval
}

extension CodexClient: RelayChatsFeedSource {
    func fetchChatsThreads(budget: CodexRequestBudget) async throws -> [CodexThread] {
        try await fetchThreads(provider: nil, workspaceID: nil, limit: StatusFeedViewModel.threadLimit, budget: budget)
    }

    func fetchChatsJobs(budget: CodexRequestBudget) async throws -> [CodexJob] {
        try await fetchJobs(provider: nil, workspaceID: nil, limit: StatusFeedViewModel.jobLimit, budget: budget)
    }

    func fetchChatsApprovals(budget: CodexRequestBudget) async throws -> [CodexApproval] {
        try await fetchPendingApprovalsIfSupported(budget: budget)
    }
}

/// Jobs and threads exactly as the machine last returned them.
struct RelayActivitySnapshot {
    let jobs: [CodexJob]
    let threads: [CodexThread]
}

/// How the app-wide completion monitor reads jobs and threads without issuing
/// its own copy of the Chats requests.
@MainActor
protocol RelayActivityFeedProviding: AnyObject {
    /// Jobs and threads the machine answered within `maxAge`, refreshing (or
    /// joining the refresh already in flight) when the last answer is older.
    /// Nil when the machine did not answer both. Rows seeded from disk never
    /// qualify: they would read as completions that happened while closed.
    func activitySnapshot(maxAge: TimeInterval) async -> RelayActivitySnapshot?
}

/// Pure bookkeeping behind the Chats list: what each of the three sources last
/// said, which failed on its latest attempt, and what the list shows meanwhile.
/// Free of networking so merge-as-arrives can be tested without a machine.
struct RelayChatsFeedState {
    enum Source: CaseIterable, Hashable {
        case threads
        case jobs
        case approvals
    }

    private(set) var threads: [CodexThread] = []
    private(set) var jobs: [CodexJob] = []
    private(set) var approvals: [CodexApproval] = []
    private(set) var feedItems: [CodexThreadFeedItem] = []
    /// `savedAt` of the on-disk snapshot the list was seeded from.
    private(set) var seededAt: Date?
    /// When each source last answered in this process. Seeded rows never count.
    private(set) var landedAt: [Source: Date] = [:]
    /// Sources whose latest attempt failed, with the reason.
    private(set) var failures: [Source: String] = [:]
    /// Approvals decided on this phone. A list fetched before the decision
    /// must not bring the card back; the id is dropped once the machine stops
    /// reporting it.
    private(set) var decidedApprovalIDs: Set<String> = []

    init(seed: RelayChatsFeedSnapshot.Restored? = nil) {
        guard let seed else { return }
        threads = seed.threads
        jobs = seed.jobs
        seededAt = seed.savedAt
        rebuildFeed()
    }

    mutating func land(threads: [CodexThread], at date: Date) {
        self.threads = threads
        landedAt[.threads] = date
        failures[.threads] = nil
        rebuildFeed()
    }

    mutating func land(jobs: [CodexJob], at date: Date) {
        self.jobs = jobs
        landedAt[.jobs] = date
        failures[.jobs] = nil
        rebuildFeed()
    }

    mutating func land(approvals: [CodexApproval], at date: Date) {
        decidedApprovalIDs.formIntersection(approvals.map(\.id))
        self.approvals = approvals.filter { !decidedApprovalIDs.contains($0.id) }
        landedAt[.approvals] = date
        failures[.approvals] = nil
    }

    /// A failed source keeps what it last showed; only its failure is noted.
    mutating func fail(_ source: Source, message: String) {
        failures[source] = message
    }

    mutating func markDecided(approvalID: String) {
        decidedApprovalIDs.insert(approvalID)
        approvals.removeAll { $0.id == approvalID }
    }

    var hasListContent: Bool { !feedItems.isEmpty }

    /// Threads and jobs have both been heard from — answered or failed — or a
    /// snapshot stood in for them.
    var listHasSettled: Bool {
        seededAt != nil || [Source.threads, .jobs].allSatisfy { landedAt[$0] != nil || failures[$0] != nil }
    }

    /// The only state that earns the full-screen spinner: nothing on disk,
    /// nothing on screen, and the first answer still pending.
    var isAwaitingFirstList: Bool {
        !listHasSettled && !hasListContent && approvals.isEmpty
    }

    /// Rows are on screen but the latest attempt to refresh them failed.
    var listIsStale: Bool {
        hasListContent && (failures[.threads] != nil || failures[.jobs] != nil)
    }

    /// How current the rows are: the older of the two list sources, with the
    /// snapshot's age standing in for a source that has not answered yet.
    var listAsOf: Date? {
        let threadsAsOf = landedAt[.threads] ?? seededAt
        let jobsAsOf = landedAt[.jobs] ?? seededAt
        switch (threadsAsOf, jobsAsOf) {
        case let (threadsDate?, jobsDate?):
            return min(threadsDate, jobsDate)
        case let (date?, nil), let (nil, date?):
            return date
        case (nil, nil):
            return nil
        }
    }

    /// An error is only worth the screen when there are no rows to keep.
    var blockingFailureMessage: String? {
        guard !hasListContent, listHasSettled else { return nil }
        return failures[.threads] ?? failures[.jobs]
    }

    /// Both list sources answered on their latest attempt, within `maxAge`.
    func activity(maxAge: TimeInterval, now: Date) -> RelayActivitySnapshot? {
        guard failures[.threads] == nil, failures[.jobs] == nil,
              let threadsDate = landedAt[.threads], let jobsDate = landedAt[.jobs],
              now.timeIntervalSince(threadsDate) <= maxAge,
              now.timeIntervalSince(jobsDate) <= maxAge
        else { return nil }
        return RelayActivitySnapshot(jobs: jobs, threads: threads)
    }

    private mutating func rebuildFeed() {
        feedItems = CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs)
    }
}

/// Raised when a list call outlives its deadline. URLSession's own idle
/// timeout normally fires first; this bounds the call end to end.
struct RelayChatsFeedDeadlineExceeded: LocalizedError {
    let seconds: TimeInterval

    var errorDescription: String? {
        "Your machine did not answer in \(Int(seconds.rounded())) seconds."
    }
}

/// Owner of the Chats list (the root recent-conversations screen) and the only
/// thing in the app that fetches the app-wide `/v1/codex/threads`.
///
/// - Seeds synchronously from the machine's on-disk snapshot, so a cold launch
///   paints rows before any request is made.
/// - Fetches threads, jobs and approvals concurrently and merges each as it
///   lands; one failing source never blanks the others.
/// - Coalesces: a refresh requested while one is in flight joins it.
/// - Every call runs under `CodexRequestBudget.listPoll` plus a hard deadline,
///   so a silent machine costs seconds and never triggers a wake.
@MainActor
final class StatusFeedViewModel: ObservableObject, RelayActivityFeedProviding {
    nonisolated static let threadLimit = 200
    nonisolated static let jobLimit = 30
    /// Cadence while Chats is on screen and the app is active.
    nonisolated static let pollInterval: TimeInterval = 4.5
    /// Coming back to Chats refetches unless the list answered this recently.
    nonisolated static let entryFreshness: TimeInterval = 2
    nonisolated static let listBudget = CodexRequestBudget.listPoll
    /// End-to-end bound on one list call; a little past the request's idle
    /// timeout so URLSession's clearer error usually wins.
    nonisolated static let defaultDeadline: TimeInterval = listBudget.timeout + 2

    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var approvals: [CodexApproval] = []
    @Published private(set) var feedItems: [CodexThreadFeedItem] = []
    /// Nothing cached, nothing on screen, first answer pending.
    @Published private(set) var isAwaitingFirstList = false
    /// Rows are on screen but could not be refreshed.
    @Published private(set) var isListStale = false
    /// How current the rows are, published only while they are stale.
    @Published private(set) var staleListAsOf: Date?
    /// Something to say above the list: a routing miss, a failed decision, or
    /// a failed load when there are no rows to keep.
    @Published private(set) var errorMessage: String?

    private(set) var machineURL: URL
    private let source: RelayChatsFeedSource
    private let snapshotStore: RelayChatsFeedSnapshotStore?
    private let deadline: TimeInterval?
    private let now: () -> Date
    private var state: RelayChatsFeedState
    private var notice: String?
    private var inFlight: Task<Void, Never>?
    /// Bumped when the machine changes; answers from an older generation are
    /// dropped rather than merged into another machine's list.
    private var generation = 0
    private var lastAttemptEndedAt: Date?
    /// Rows most recently written (or read) for this machine.
    private var persistedSnapshot: RelayChatsFeedSnapshot?

    convenience init(client: CodexClient, snapshotStore: RelayChatsFeedSnapshotStore? = .standard) {
        self.init(source: client, machineURL: client.baseURL, snapshotStore: snapshotStore)
    }

    init(
        source: RelayChatsFeedSource,
        machineURL: URL,
        snapshotStore: RelayChatsFeedSnapshotStore?,
        deadline: TimeInterval? = StatusFeedViewModel.defaultDeadline,
        now: @escaping () -> Date = Date.init
    ) {
        self.source = source
        self.machineURL = machineURL
        self.snapshotStore = snapshotStore
        self.deadline = deadline
        self.now = now
        let seed = snapshotStore?.load(for: machineURL)
        state = RelayChatsFeedState(seed: seed)
        persistedSnapshot = seed.map { RelayChatsFeedSnapshot(threads: $0.threads, jobs: $0.jobs) }
        publish()
    }

    // MARK: - Refreshing

    /// Refreshes now, or joins the refresh already in flight.
    func refresh() async {
        await refresh(ifOlderThan: nil)
    }

    /// Joins a refresh in flight; otherwise starts one unless the last attempt
    /// ended less than `maxAge` seconds ago.
    func refresh(ifOlderThan maxAge: TimeInterval?) async {
        if let inFlight {
            await inFlight.value
            return
        }
        if let maxAge, let ended = lastAttemptEndedAt, now().timeIntervalSince(ended) < maxAge {
            return
        }
        let generation = generation
        let task = Task { await self.performRefresh(generation: generation) }
        inFlight = task
        await task.value
    }

    /// Chats is a live view: refresh on entry, then every `pollInterval` until
    /// the calling task is cancelled (tab switched, app inactive, chat opened).
    /// A tick never overlaps a refresh still in flight — it joins it.
    func pollWhileVisible() async {
        await refresh(ifOlderThan: Self.entryFreshness)
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await refresh(ifOlderThan: Self.pollInterval - 0.5)
        }
    }

    func activitySnapshot(maxAge: TimeInterval) async -> RelayActivitySnapshot? {
        if let fresh = state.activity(maxAge: maxAge, now: now()) { return fresh }
        await refresh()
        return state.activity(maxAge: .infinity, now: now())
    }

    private enum Landing: @unchecked Sendable {
        case threads([CodexThread])
        case jobs([CodexJob])
        case approvals([CodexApproval])
        case failed(RelayChatsFeedState.Source, Error)
    }

    private func performRefresh(generation: Int) async {
        let source = source
        let budget = Self.listBudget
        let deadline = deadline
        let refreshedMachine = machineURL
        await withTaskGroup(of: Landing.self) { group in
            group.addTask {
                await Self.fetch(.threads, deadline: deadline) {
                    .threads(try await source.fetchChatsThreads(budget: budget))
                }
            }
            group.addTask {
                await Self.fetch(.jobs, deadline: deadline) {
                    .jobs(try await source.fetchChatsJobs(budget: budget))
                }
            }
            group.addTask {
                await Self.fetch(.approvals, deadline: deadline) {
                    .approvals(try await source.fetchChatsApprovals(budget: budget))
                }
            }
            for await landing in group {
                guard generation == self.generation else { continue }
                apply(landing)
            }
        }
        guard generation == self.generation else { return }
        inFlight = nil
        lastAttemptEndedAt = now()
        persistIfChanged(for: refreshedMachine)
    }

    nonisolated private static func fetch(
        _ source: RelayChatsFeedState.Source,
        deadline: TimeInterval?,
        _ operation: @escaping @Sendable () async throws -> Landing
    ) async -> Landing {
        do {
            guard let deadline else { return try await operation() }
            return try await withThrowingTaskGroup(of: Landing.self) { group in
                group.addTask { try await operation() }
                group.addTask {
                    try await Task.sleep(nanoseconds: UInt64(deadline * 1_000_000_000))
                    throw RelayChatsFeedDeadlineExceeded(seconds: deadline)
                }
                defer { group.cancelAll() }
                guard let first = try await group.next() else { throw CancellationError() }
                return first
            }
        } catch {
            return .failed(source, error)
        }
    }

    private func apply(_ landing: Landing) {
        switch landing {
        case .threads(let threads):
            state.land(threads: threads, at: now())
            notice = nil
        case .jobs(let jobs):
            state.land(jobs: jobs, at: now())
        case .approvals(let approvals):
            state.land(approvals: approvals, at: now())
        case .failed(let source, let error):
            guard !isCancellation(error) else { return }
            state.fail(source, message: error.localizedDescription)
        }
        publish()
    }

    // MARK: - Machine lifecycle

    /// Points the list at another machine: its own snapshot, or nothing.
    func switchMachine(to baseURL: URL) {
        guard RelayChatsFeedSnapshotStore.machineKey(for: baseURL)
                != RelayChatsFeedSnapshotStore.machineKey(for: machineURL) else { return }
        machineURL = baseURL
        resetState(seed: snapshotStore?.load(for: baseURL))
    }

    /// A machine unpaired from this phone takes its list with it.
    func forgetSnapshot(for baseURL: URL) {
        snapshotStore?.remove(for: baseURL)
        guard RelayChatsFeedSnapshotStore.machineKey(for: baseURL)
                == RelayChatsFeedSnapshotStore.machineKey(for: machineURL) else { return }
        resetState(seed: nil)
    }

    private func resetState(seed: RelayChatsFeedSnapshot.Restored?) {
        generation += 1
        inFlight = nil
        lastAttemptEndedAt = nil
        notice = nil
        state = RelayChatsFeedState(seed: seed)
        persistedSnapshot = seed.map { RelayChatsFeedSnapshot(threads: $0.threads, jobs: $0.jobs) }
        publish()
    }

    /// Written only once threads have answered in this process, and only when
    /// the rows differ from what is already on disk.
    private func persistIfChanged(for baseURL: URL) {
        guard let snapshotStore, state.landedAt[.threads] != nil else { return }
        let snapshot = RelayChatsFeedSnapshot(threads: state.threads, jobs: state.jobs)
        guard snapshot != persistedSnapshot else { return }
        persistedSnapshot = snapshot
        snapshotStore.save(snapshot, savedAt: now(), for: baseURL)
    }

    // MARK: - Actions

    func reportRoutingMiss(_ message: String) {
        notice = message
        publish()
    }

    func decide(_ approval: CodexApproval, _ decision: CodexApprovalDecision) async {
        do {
            _ = try await source.decideApproval(id: approval.id, decision: decision, message: nil)
            state.markDecided(approvalID: approval.id)
            publish()
            await refresh()
        } catch {
            guard !isCancellation(error) else { return }
            notice = error.localizedDescription
            publish()
        }
    }

    // MARK: - Publishing

    /// Assigns only what changed, so a poll that brings nothing new does not
    /// re-render the list.
    private func publish() {
        if threads != state.threads { threads = state.threads }
        if jobs != state.jobs { jobs = state.jobs }
        if approvals != state.approvals { approvals = state.approvals }
        if feedItems != state.feedItems { feedItems = state.feedItems }
        if isAwaitingFirstList != state.isAwaitingFirstList { isAwaitingFirstList = state.isAwaitingFirstList }
        if isListStale != state.listIsStale { isListStale = state.listIsStale }
        let asOf = state.listIsStale ? state.listAsOf : nil
        if staleListAsOf != asOf { staleListAsOf = asOf }
        let message = notice ?? state.blockingFailureMessage
        if errorMessage != message { errorMessage = message }
    }
}
