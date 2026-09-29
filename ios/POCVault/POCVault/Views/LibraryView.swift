import SwiftUI

struct WorkspacePreviewResult: Identifiable {
    let job: CodexJob
    let liveURLs: [URL]

    var id: String { job.id }
    var title: String { job.prompt?.trimmedNonEmpty ?? "Session output" }
    var workspaceLabel: String { job.workspaceName?.trimmedNonEmpty ?? job.workspaceId?.trimmedNonEmpty ?? "Workspace" }

    static func results(from jobs: [CodexJob]) -> [WorkspacePreviewResult] {
        jobs.compactMap { job in
            let urls = relaySharedContract.previewResultSources(output: job.displayOutput, stdout: job.stdout)
                .compactMap(URL.init(string:))
            guard !job.artifacts.isEmpty || !urls.isEmpty else { return nil }
            return WorkspacePreviewResult(job: job, liveURLs: urls)
        }
    }
}

enum RelayPreviewsLoadError: Error, LocalizedError, Equatable {
    case timedOut(seconds: Int)

    var errorDescription: String? {
        switch self {
        case .timedOut(let seconds):
            return "It didn't answer within \(seconds) seconds."
        }
    }
}

/// Why the Previews tab has nothing new to show, worded for the phone.
struct RelayPreviewsLoadFailure: Equatable {
    let title: String
    let message: String
    let isUnreachable: Bool

    init(_ error: Error) {
        let nsError = error as NSError
        isUnreachable = error is RelayPreviewsLoadError || nsError.domain == NSURLErrorDomain
        title = isUnreachable ? "Couldn't reach your machine" : "Couldn't load previews"
        message = error.localizedDescription
    }
}

/// Resolves with whichever settles first: `operation`, or the deadline.
///
/// Deliberately not a task group. A group waits for every child before it
/// returns, and the operation cannot be relied on to honour cancellation:
/// `CodexClient` answers a timed-out request by waking the machine and awaits
/// that wake on an unstructured task, which cancellation does not reach. A
/// group would therefore hold the caller exactly as long as the hang it is
/// meant to bound. Here the caller is released at the deadline and the
/// abandoned operation is cancelled and left to wind down on its own.
func relayWithDeadline<T>(
    seconds: Double,
    operation: @escaping () async throws -> T
) async throws -> T {
    let race = RelayDeadlineRace<T>()
    return try await withCheckedThrowingContinuation { continuation in
        race.arm(continuation)
        let work = Task {
            do {
                race.finish(.success(try await operation()))
            } catch {
                race.finish(.failure(error))
            }
        }
        let timer = Task {
            try? await Task.sleep(nanoseconds: UInt64(max(seconds, 0) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            race.finish(.failure(RelayPreviewsLoadError.timedOut(seconds: Int(seconds.rounded()))))
        }
        race.attach(work, timer)
    }
}

/// Resumes the continuation exactly once, then cancels whatever is still running.
private final class RelayDeadlineRace<T>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<T, Error>?
    private var tasks: [Task<Void, Never>] = []
    private var isFinished = false

    func arm(_ continuation: CheckedContinuation<T, Error>) {
        lock.lock()
        self.continuation = continuation
        lock.unlock()
    }

    func attach(_ newTasks: Task<Void, Never>...) {
        lock.lock()
        guard !isFinished else {
            lock.unlock()
            newTasks.forEach { $0.cancel() }
            return
        }
        tasks.append(contentsOf: newTasks)
        lock.unlock()
    }

    func finish(_ result: Result<T, Error>) {
        lock.lock()
        guard !isFinished, let continuation else {
            lock.unlock()
            return
        }
        isFinished = true
        self.continuation = nil
        let pending = tasks
        tasks = []
        lock.unlock()
        pending.forEach { $0.cancel() }
        continuation.resume(with: result)
    }
}

/// What the Previews tab shows, and the only thing that loads it.
///
/// The tab used to await `fetchJobs` with no deadline of its own and clear its
/// results on every appearance. Against a machine that accepts the connection
/// but never answers, `CodexClient` waits out its request timeout, then its
/// machine-wake cycle, then retries — minutes, not seconds — and every return
/// to the tab started that wait again from an empty screen. Now a load settles
/// within `loadTimeoutSeconds`, the last good result for this machine stays on
/// screen while a fresh one loads, and a failure is reported instead of waited on.
@MainActor
final class RelayPreviewsModel: ObservableObject {
    nonisolated static let loadTimeoutSeconds: Double = 20
    nonisolated static let jobLimit = 100

    /// `nil` until this machine has answered once in this process.
    @Published private(set) var results: [WorkspacePreviewResult]?
    @Published private(set) var isLoading = false
    @Published private(set) var failure: RelayPreviewsLoadFailure?

    private struct Snapshot {
        let results: [WorkspacePreviewResult]
    }

    /// Last good result per machine for the life of the process, so a rebuilt
    /// tab (pairing, sign-in) opens on content. Keyed by the machine's base URL
    /// so one machine's outputs never appear under another's.
    private static var snapshots: [String: Snapshot] = [:]

    private let machineKey: () -> String
    private let fetchJobs: () async throws -> [CodexJob]
    private let timeoutSeconds: Double
    private var shownMachineKey: String
    private var currentLoad: (id: UUID, task: Task<Void, Never>)?

    convenience init(client: CodexClient) {
        self.init(
            machineKey: { client.baseURL.absoluteString },
            fetchJobs: {
                try await client.fetchJobs(provider: nil, workspaceID: nil, limit: RelayPreviewsModel.jobLimit)
            }
        )
    }

    init(
        machineKey: @escaping () -> String,
        timeoutSeconds: Double = RelayPreviewsModel.loadTimeoutSeconds,
        fetchJobs: @escaping () async throws -> [CodexJob]
    ) {
        self.machineKey = machineKey
        self.fetchJobs = fetchJobs
        self.timeoutSeconds = timeoutSeconds
        let key = machineKey()
        shownMachineKey = key
        results = Self.snapshots[key]?.results
    }

    /// Revalidates in the background. Callers (pull to refresh) resume when the
    /// load settles, which is never later than the deadline. Cancelling a caller
    /// does not abandon the load: a result that arrives after the user switched
    /// tabs is waiting when they come back.
    func refresh() async {
        adoptCurrentMachine()
        let task: Task<Void, Never>
        if let currentLoad {
            task = currentLoad.task
        } else {
            let id = UUID()
            let key = shownMachineKey
            isLoading = true
            task = Task { [weak self] in
                await self?.load(id: id, machineKey: key)
            }
            currentLoad = (id, task)
        }
        await task.value
    }

    /// Forgets this machine's outputs: the computer was disconnected.
    func discard() {
        currentLoad?.task.cancel()
        currentLoad = nil
        Self.snapshots[shownMachineKey] = nil
        results = nil
        failure = nil
        isLoading = false
    }

    private func adoptCurrentMachine() {
        let key = machineKey()
        guard key != shownMachineKey else { return }
        currentLoad?.task.cancel()
        currentLoad = nil
        shownMachineKey = key
        results = Self.snapshots[key]?.results
        failure = nil
        isLoading = false
    }

    private func load(id: UUID, machineKey key: String) async {
        let outcome: Result<[CodexJob], Error>
        do {
            outcome = .success(try await relayWithDeadline(seconds: timeoutSeconds, operation: fetchJobs))
        } catch {
            outcome = .failure(error)
        }
        // Superseded by a machine switch or a disconnect: this answer is not ours to show.
        guard currentLoad?.id == id, key == shownMachineKey else { return }
        currentLoad = nil
        isLoading = false
        switch outcome {
        case .success(let jobs):
            let fresh = WorkspacePreviewResult.results(from: jobs)
            Self.snapshots[key] = Snapshot(results: fresh)
            results = fresh
            failure = nil
        case .failure(let error):
            guard !isCancellation(error) else { return }
            failure = RelayPreviewsLoadFailure(error)
        }
    }
}

struct RelayPreviewsView: View {
    @ObservedObject var identityStore: ClientIdentityStore
    let client: CodexClient
    let workspaceAccessIsAvailable: Bool
    let onOpenWorkspaces: () -> Void
    let onOpenJob: (CodexJob) -> Void

    @StateObject private var model: RelayPreviewsModel
    @State private var artifactRequest: CodexJobArtifact?
    @State private var remotePreviewRequest: RelayRemotePreviewRequest?

    init(
        identityStore: ClientIdentityStore,
        client: CodexClient,
        workspaceAccessIsAvailable: Bool,
        onOpenWorkspaces: @escaping () -> Void,
        onOpenJob: @escaping (CodexJob) -> Void
    ) {
        self.identityStore = identityStore
        self.client = client
        self.workspaceAccessIsAvailable = workspaceAccessIsAvailable
        self.onOpenWorkspaces = onOpenWorkspaces
        self.onOpenJob = onOpenJob
        _model = StateObject(wrappedValue: RelayPreviewsModel(client: client))
    }

    var body: some View {
        workspaceResults
        .background(AppTheme.bgCanvas.ignoresSafeArea())
        .fullScreenCover(item: $artifactRequest) { artifact in
            RelayArtifactViewer(artifact: artifact, client: client, identityStore: identityStore)
        }
        .fullScreenCover(item: $remotePreviewRequest) { request in
            RelayRemotePreviewViewer(request: request, client: client, identityStore: identityStore)
        }
        // Runs on every visit to the tab. With a cached result that is a quiet
        // revalidation, not a spinner.
        .task(id: workspaceAccessIsAvailable) {
            if workspaceAccessIsAvailable {
                await model.refresh()
            } else {
                model.discard()
            }
        }
        .onChange(of: workspaceAccessIsAvailable) { _, isAvailable in
            guard !isAvailable else { return }
            artifactRequest = nil
            remotePreviewRequest = nil
        }
    }

    private var workspaceResults: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack {
                    Text("Previews")
                        .font(AppTheme.serifFont(size: 32))
                        .foregroundStyle(AppTheme.textPrimary)
                    RelayInfoButton(
                        title: "Previews",
                        message: "Review files and live app links produced by sessions on your connected machine. Each output stays linked to the workspace that created it. Showing outputs found in the latest 100 jobs. Live app links work while the app is running on the connected machine."
                    )
                    Spacer()
                    Button { Task { await model.refresh() } } label: {
                        Image(systemName: "arrow.clockwise")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(model.isLoading ? AppTheme.textFaint : AppTheme.textSecondary)
                    .disabled(model.isLoading || !workspaceAccessIsAvailable)
                    .accessibilityLabel("Refresh workspace results")
                    .accessibilityIdentifier("relay-workspace-previews-refresh")
                }

                if !workspaceAccessIsAvailable {
                    StatusCard(symbol: "desktopcomputer.trianglebadge.exclamationmark", title: "Computer disconnected", message: "Reconnect your computer in Settings to load its workspace results.")
                } else if let results = model.results {
                    loadedContent(results)
                } else if let failure = model.failure, !model.isLoading {
                    StatusCard(symbol: failureSymbol(failure), title: failure.title, message: failure.message)
                    Button("Try again") { Task { await model.refresh() } }
                        .buttonStyle(RelayPrimaryButtonStyle())
                        .accessibilityIdentifier("relay-previews-retry")
                } else {
                    ProgressView("Loading workspace results…")
                        .tint(AppTheme.accent)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 28)
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .refreshable {
            guard workspaceAccessIsAvailable else { return }
            await model.refresh()
        }
        .accessibilityIdentifier("relay-workspace-previews-list")
    }

    /// Content this machine has already answered with, plus how fresh it is.
    /// A failed revalidation keeps what is on screen and says so in words.
    @ViewBuilder
    private func loadedContent(_ results: [WorkspacePreviewResult]) -> some View {
        if !results.isEmpty || model.isLoading || model.failure != nil {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                if !results.isEmpty {
                    RelayCapsLabel(text: "Recent workspace outputs")
                }
                Spacer(minLength: 0)
                if model.isLoading {
                    RelayCapsLabel(text: "Updating")
                } else if model.failure != nil {
                    RelayCapsLabel(text: "Not updated", color: AppTheme.statusWarn)
                }
            }
            .accessibilityElement(children: .combine)
        }

        if let failure = model.failure, !model.isLoading {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(failure.title). \(failure.message)")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Try again") { Task { await model.refresh() } }
                    .buttonStyle(RelayOutlineButtonStyle())
                    .accessibilityIdentifier("relay-previews-retry")
            }
        }

        if results.isEmpty {
            StatusCard(symbol: "doc.richtext", title: "No preview outputs yet", message: "Files and live app links produced by your sessions will appear here. Start a session in a workspace and ask for an output or app preview.")
            Button("Open Workspaces", action: onOpenWorkspaces)
                .buttonStyle(RelayPrimaryButtonStyle())
                .accessibilityIdentifier("relay-previews-open-workspaces")
        } else {
            LazyVStack(alignment: .leading, spacing: 24) {
                ForEach(results) { result in resultCard(result) }
            }
        }
    }

    private func failureSymbol(_ failure: RelayPreviewsLoadFailure) -> String {
        failure.isUnreachable ? "desktopcomputer.trianglebadge.exclamationmark" : "exclamationmark.triangle"
    }

    private func resultCard(_ result: WorkspacePreviewResult) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(result.workspaceLabel)
                    .font(AppTheme.uiFont(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.accent)
                Text(result.title)
                    .font(AppTheme.uiFont(size: 16, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(2)
                if let date = result.job.completedAt ?? result.job.updatedAt ?? result.job.createdAt {
                    Text(date.formatted(date: .abbreviated, time: .shortened))
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }
            ForEach(result.job.artifacts) { artifact in
                Button { artifactRequest = artifact } label: {
                    outputRow(
                        title: artifact.title?.trimmedNonEmpty ?? artifact.filename,
                        subtitle: artifact.filename,
                        symbol: "doc.richtext"
                    )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open output \(artifact.title?.trimmedNonEmpty ?? artifact.filename)")
                .accessibilityIdentifier("relay-workspace-preview-artifact-\(artifact.id)")
            }
            ForEach(result.liveURLs, id: \.absoluteString) { url in
                Button {
                    remotePreviewRequest = RelayRemotePreviewRequest(jobID: result.job.id, sourceURL: url)
                } label: {
                    outputRow(title: "Open live app", subtitle: url.absoluteString, symbol: "safari")
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-workspace-preview-live-\(result.id)")
            }
            Button { onOpenJob(result.job) } label: {
                Label("View source job", systemImage: "bubble.left.and.text.bubble.right")
                    .font(AppTheme.uiFont(size: 13, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(minHeight: 44)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-workspace-preview-source-\(result.id)")
            Divider().overlay(AppTheme.hairline)
        }
        .accessibilityIdentifier("relay-workspace-preview-result-\(result.id)")
    }

    private func outputRow(title: String, subtitle: String, symbol: String) -> some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).frame(width: 24)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(AppTheme.uiFont(size: 14, weight: .medium))
                Text(subtitle)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Image(systemName: "arrow.up.right")
        }
        .foregroundStyle(AppTheme.textPrimary)
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 60, alignment: .leading)
        .background(AppTheme.textPrimary.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
        .contentShape(Rectangle())
    }
}

struct StatusCard: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
            Text(title)
                .font(AppTheme.uiFont(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
            Text(message)
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(AppTheme.hairline, lineWidth: 1)
        }
    }
}
