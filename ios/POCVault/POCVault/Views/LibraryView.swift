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

struct RelayPreviewsView: View {
    @ObservedObject var identityStore: ClientIdentityStore
    let client: CodexClient
    let workspaceAccessIsAvailable: Bool
    let onOpenWorkspaces: () -> Void
    let onOpenJob: (CodexJob) -> Void

    @State private var results: [WorkspacePreviewResult] = []
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var refreshGeneration = UUID()
    @State private var artifactRequest: CodexJobArtifact?
    @State private var remotePreviewRequest: RelayRemotePreviewRequest?

    var body: some View {
        workspaceResults
        .background(AppTheme.bgCanvas.ignoresSafeArea())
        .fullScreenCover(item: $artifactRequest) { artifact in
            RelayArtifactViewer(artifact: artifact, client: client, identityStore: identityStore)
        }
        .fullScreenCover(item: $remotePreviewRequest) { request in
            RelayRemotePreviewViewer(request: request, client: client, identityStore: identityStore)
        }
        .task(id: workspaceAccessIsAvailable) { await refreshResults() }
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
                    Spacer()
                    Button { Task { await refreshResults() } } label: {
                        Image(systemName: "arrow.clockwise")
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(AppTheme.textSecondary)
                    .accessibilityLabel("Refresh workspace results")
                    .accessibilityIdentifier("relay-workspace-previews-refresh")
                }
                Text("Review files and live app links produced by sessions on your connected machine. Each output stays linked to the workspace that created it.")
                    .font(AppTheme.uiFont(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                if !workspaceAccessIsAvailable {
                    StatusCard(symbol: "desktopcomputer.trianglebadge.exclamationmark", title: "Computer disconnected", message: "Reconnect your computer in Settings to load its workspace results.")
                } else if isLoading {
                    ProgressView("Loading workspace results…")
                        .tint(AppTheme.accent)
                        .padding(.vertical, 28)
                } else if let loadError {
                    StatusCard(symbol: "exclamationmark.triangle", title: "Could not load workspace results", message: loadError)
                    Button("Try again") { Task { await refreshResults() } }
                        .buttonStyle(RelayPrimaryButtonStyle())
                } else if results.isEmpty {
                    StatusCard(symbol: "doc.richtext", title: "No preview outputs yet", message: "Files and live app links produced by your sessions will appear here. Start a session in a workspace and ask for an output or app preview.")
                    Button("Open Workspaces", action: onOpenWorkspaces)
                        .buttonStyle(RelayPrimaryButtonStyle())
                        .accessibilityIdentifier("relay-previews-open-workspaces")
                } else {
                    RelayCapsLabel(text: "Recent workspace outputs")
                    LazyVStack(alignment: .leading, spacing: 24) {
                        ForEach(results) { result in resultCard(result) }
                    }
                    Text("Showing outputs found in the latest 100 jobs. Live app links work while the app is running on the connected machine.")
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await refreshResults() }
        .accessibilityIdentifier("relay-workspace-previews-list")
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

    @MainActor
    private func refreshResults() async {
        let generation = UUID()
        refreshGeneration = generation
        results = []
        loadError = nil
        isLoading = false
        guard workspaceAccessIsAvailable else { return }
        isLoading = true
        defer {
            if generation == refreshGeneration { isLoading = false }
        }
        do {
            let jobs = try await client.fetchJobs(provider: nil, workspaceID: nil, limit: 100)
            guard !Task.isCancelled, generation == refreshGeneration, workspaceAccessIsAvailable else { return }
            results = WorkspacePreviewResult.results(from: jobs)
        } catch {
            guard !Task.isCancelled, generation == refreshGeneration else { return }
            loadError = error.localizedDescription
        }
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
