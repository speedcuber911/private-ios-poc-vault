import SwiftUI

struct RelayPreviewsView: View {
    @ObservedObject var libraryViewModel: LibraryViewModel
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient
    let client: CodexClient
    let workspaceAccessIsAvailable: Bool
    let onOpenWorkspaces: () -> Void
    let onOpenJob: (CodexJob) -> Void

    @State private var showsPublishedCatalog = false
    @State private var results: [WorkspacePreviewResult] = []
    @State private var isLoading = false
    @State private var loadError: String?
    @State private var refreshGeneration = UUID()
    @State private var artifactRequest: CodexJobArtifact?
    @State private var remotePreviewRequest: RelayRemotePreviewRequest?

    var body: some View {
        VStack(spacing: 0) {
            Picker("Preview source", selection: $showsPublishedCatalog) {
                Text("Workspace results").tag(false)
                Text("Published catalog").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20)
            .padding(.top, 10)
            .padding(.bottom, 4)
            .accessibilityIdentifier("relay-previews-source")

            if showsPublishedCatalog {
                LibraryView(viewModel: libraryViewModel, identityStore: identityStore, manifestClient: manifestClient)
            } else {
                workspaceResults
            }
        }
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
                    StatusCard(symbol: "desktopcomputer.trianglebadge.exclamationmark", title: "Computer disconnected", message: "Reconnect your computer in Settings to load its workspace results. The separate published catalog uses its own configured access.")
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

struct LibraryView: View {
    @ObservedObject var viewModel: LibraryViewModel
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient

    @AppStorage("recentPOCEntryIDs") private var recentEntryIDs = ""
    @State private var showingDiagnostics = false
    @State private var selectedFilter: PreviewFilter = .all
    @State private var path: [POCEntry] = []
    @State private var openedPreview: POCEntry?

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    header
                    content
                    diagnosticsLink
                }
                .frame(maxWidth: 760)
                .padding(.horizontal, 20)
                .padding(.top, 14)
                .padding(.bottom, 28)
                .frame(maxWidth: .infinity)
            }
            .background(AppTheme.bgCanvas.ignoresSafeArea())
            .navigationTitle("Published catalog")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .accessibilityIdentifier("relay-previews-list")
            .refreshable { await viewModel.load() }
            .navigationDestination(for: POCEntry.self) { entry in
                PreviewDetailsView(
                    entry: entry,
                    catalogHost: manifestClient.manifestURL.host ?? "Configured catalog",
                    generatedAt: viewModel.verifiedManifest?.generatedAt,
                    onOpen: {
                        markRecent(entry)
                        openedPreview = entry
                    }
                )
            }
        }
        // Hosted content keeps the existing floating back control and never
        // inherits either the tab bar or a standard navigation bar.
        .fullScreenCover(item: $openedPreview) { entry in
            AuthenticatedWebView(url: entry.url, title: entry.title, identityStore: identityStore)
        }
        .fullScreenCover(isPresented: $showingDiagnostics) {
            DiagnosticsView(identityStore: identityStore, manifestClient: manifestClient)
        }
        .task {
            if case .idle = viewModel.state { await viewModel.load() }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .center, spacing: 10) {
                Text("Published catalog")
                    .font(AppTheme.serifFont(size: 32))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Button {
                    Task { await viewModel.load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(AppTheme.uiFont(size: 16, weight: .medium))
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .foregroundStyle(AppTheme.textSecondary)
                .accessibilityLabel("Refresh previews")
                .accessibilityIdentifier("relay-previews-refresh")
            }

            Text("Published web previews from your configured catalog. Inspect their source and access requirements, then open them in Relay.")
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch viewModel.state {
        case .idle, .loading:
            HStack(spacing: 12) {
                ProgressView().tint(AppTheme.accent)
                Text("Verifying preview catalog…")
                    .font(AppTheme.uiFont(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            .padding(.vertical, 28)
        case .failed(let message):
            StatusCard(
                symbol: "exclamationmark.triangle",
                title: "Preview catalog unavailable",
                message: message
            )
            Text("Catalog access is configured separately from your agent workspace. Check your connection and publisher-provided client certificate in Diagnostics, then refresh. Previews appear only after the catalog signature is verified.")
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textSecondary)
        case .loaded(let manifest):
            VStack(alignment: .leading, spacing: 5) {
                Label(PreviewTrustCopy.catalogTitle, systemImage: "checkmark.seal")
                    .font(AppTheme.uiFont(size: 13, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                Text("\(manifest.entries.count) \(manifest.entries.count == 1 ? "preview" : "previews") · \(manifestClient.manifestURL.host ?? "Configured catalog")")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
                    .textSelection(.enabled)
            }
            .accessibilityIdentifier("relay-previews-catalog-status")

            if manifest.entries.isEmpty {
                StatusCard(
                    symbol: "rectangle.on.rectangle",
                    title: "No previews published yet",
                    message: "Publish a static preview through your configured Relay deployment, then refresh this catalog. New previews appear here without an app update."
                )
            } else {
                SearchBox(text: $viewModel.searchText)
                POCSectionHeader(selectedFilter: $selectedFilter)

                if visibleEntries.isEmpty {
                    StatusCard(symbol: emptyState.symbol, title: emptyState.title, message: emptyState.message)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(visibleEntries) { entry in
                            NavigationLink(value: entry) { POCEntryCard(entry: entry) }
                                .buttonStyle(.plain)
                                .accessibilityIdentifier("relay-preview-details-\(entry.id)")
                                .accessibilityHint("Inspect preview source and access requirements")
                        }
                    }
                    .overlay(alignment: .top) {
                        Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
                    }
                }
            }
        }
    }

    private var diagnosticsLink: some View {
        Button { showingDiagnostics = true } label: {
            Label("Connection diagnostics", systemImage: "list.clipboard")
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textSecondary)
                .frame(maxWidth: .infinity, minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-previews-diagnostics")
    }

    private var visibleEntries: [POCEntry] {
        selectedFilter.entries(
            from: viewModel.filteredEntries,
            recentIDs: recentEntryIDs.split(separator: ",").map(String.init)
        )
    }

    private var emptyState: (symbol: String, title: String, message: String) {
        if !viewModel.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return ("magnifyingglass", "No matches", "Try another search or choose a different filter.")
        }
        switch selectedFilter {
        case .all:
            return ("rectangle.on.rectangle", "No previews", "Refresh to check for newly published previews.")
        case .recent:
            return ("clock", "No recent previews", "Open a preview from All and it will appear here for quick access.")
        case .protected:
            return ("lock", "No certificate-protected previews", "No entries in this catalog require a client certificate. All entries still belong to the verified catalog.")
        }
    }

    private func markRecent(_ entry: POCEntry) {
        var ids = recentEntryIDs.split(separator: ",").map(String.init).filter { $0 != entry.id }
        ids.insert(entry.id, at: 0)
        recentEntryIDs = ids.prefix(5).joined(separator: ",")
    }
}

private struct PreviewDetailsView: View {
    let entry: POCEntry
    let catalogHost: String
    let generatedAt: Date?
    let onOpen: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                VStack(alignment: .leading, spacing: 10) {
                    RelayCapsLabel(text: "Published preview")
                    Text(entry.title)
                        .font(AppTheme.serifFont(size: 30))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(entry.detailText)
                        .font(AppTheme.uiFont(size: 15))
                        .foregroundStyle(AppTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(alignment: .leading, spacing: 14) {
                    metadataRow("Preview host", value: entry.displayHost)
                    metadataRow("Updated", value: entry.updatedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "Not provided")
                    if !entry.tags.isEmpty {
                        metadataRow("Tags", value: entry.tags.joined(separator: " · "))
                    }
                }

                Divider().overlay(AppTheme.hairline)

                VStack(alignment: .leading, spacing: 10) {
                    RelayCapsLabel(text: "Catalog integrity")
                    Label(PreviewTrustCopy.catalogTitle, systemImage: "checkmark.seal")
                        .font(AppTheme.uiFont(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(PreviewTrustCopy.catalogExplanation)
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                    metadataRow("Catalog host", value: catalogHost)
                    if let generatedAt {
                        metadataRow("Catalog generated", value: generatedAt.formatted(date: .abbreviated, time: .shortened))
                    }
                }
                .accessibilityIdentifier("relay-preview-catalog-integrity")

                VStack(alignment: .leading, spacing: 10) {
                    RelayCapsLabel(text: "Access")
                    Text(PreviewTrustCopy.accessTitle(for: entry))
                        .font(AppTheme.uiFont(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(PreviewTrustCopy.accessExplanation(for: entry))
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                }
                .accessibilityIdentifier("relay-preview-access")

                Button(action: onOpen) {
                    Label("Open preview", systemImage: "arrow.up.right")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .accessibilityIdentifier("relay-preview-open")
            }
            .frame(maxWidth: 680, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .background(AppTheme.bgCanvas.ignoresSafeArea())
        .navigationTitle("Preview details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.visible, for: .navigationBar)
        .accessibilityIdentifier("relay-preview-details")
    }

    private func metadataRow(_ title: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title)
                .font(AppTheme.uiFont(size: 12))
                .foregroundStyle(AppTheme.textTertiary)
            Text(value)
                .font(AppTheme.uiFont(size: 14))
                .foregroundStyle(AppTheme.textPrimary)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct RelayLogoMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(AppTheme.textPrimary.opacity(0.06))
            Image(systemName: "terminal.fill")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

private struct SearchBox: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "magnifyingglass").foregroundStyle(AppTheme.textSecondary)
            TextField("Search previews", text: $text)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .font(AppTheme.uiFont(size: 15))
                .foregroundStyle(AppTheme.textPrimary)
                .submitLabel(.search)
                .accessibilityIdentifier("relay-previews-search")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))
        .tint(AppTheme.accent)
    }
}

private struct POCSectionHeader: View {
    @Binding var selectedFilter: PreviewFilter

    var body: some View {
        HStack(spacing: 20) {
            ForEach(PreviewFilter.allCases) { filter in
                Button { selectedFilter = filter } label: {
                    VStack(spacing: 6) {
                        Text(filter.rawValue)
                            .font(AppTheme.uiFont(size: 14, weight: selectedFilter == filter ? .medium : .regular))
                            .foregroundStyle(selectedFilter == filter ? AppTheme.textPrimary : AppTheme.textTertiary)
                        Rectangle()
                            .fill(selectedFilter == filter ? AppTheme.accent : Color.clear)
                            .frame(height: 2)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-previews-filter-\(filter.rawValue.lowercased())")
                .accessibilityAddTraits(selectedFilter == filter ? .isSelected : [])
            }
        }
    }
}

private struct POCEntryCard: View {
    let entry: POCEntry

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: "rectangle.on.rectangle")
                .font(.system(size: 20))
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 38, height: 42)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(entry.title)
                    .font(AppTheme.uiFont(size: 15, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(2)
                Text(entry.detailText)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(2)
                Text(entry.displayHost)
                    .font(AppTheme.uiFont(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
            }
            Spacer(minLength: 4)
            if entry.requiresClientCertificate {
                Image(systemName: "lock.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
                    .accessibilityLabel("Client certificate required")
            }
            Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(AppTheme.textTertiary)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 16)
        .contentShape(Rectangle())
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
        }
    }
}

private struct StatusCard: View {
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
