import Foundation

enum PreviewFilter: String, CaseIterable, Identifiable {
    case all = "All"
    case recent = "Recent"
    case protected = "Protected"

    var id: String { rawValue }

    /// Recent means opened, not merely inspected. The certificate filter is
    /// deliberately independent of catalog signature verification.
    func entries(from entries: [POCEntry], recentIDs: [String]) -> [POCEntry] {
        let recent = recentIDs.compactMap { id in entries.first { $0.id == id } }
        switch self {
        case .all:
            let ids = Set(recent.map(\.id))
            return recent + entries.filter { !ids.contains($0.id) }
        case .recent:
            return recent
        case .protected:
            return entries.filter(\.requiresClientCertificate)
        }
    }
}

enum PreviewTrustCopy {
    static let catalogTitle = "Manifest signature verified"
    static let catalogExplanation = "Relay verified this catalog with its trusted signing key. This verifies the catalog, not the contents of downloaded web pages."

    static func accessTitle(for entry: POCEntry) -> String {
        entry.requiresClientCertificate ? "Client certificate required" : "Not required by catalog"
    }

    static func accessExplanation(for entry: POCEntry) -> String {
        entry.requiresClientCertificate
            ? "The catalog marks this preview as requiring a valid client certificate. Your configured certificate is used when the server requests it."
            : "The catalog does not require a client certificate for this preview. The server may enforce other sign-in rules."
    }
}

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

@MainActor
final class LibraryViewModel: ObservableObject {
    enum State: Equatable {
        case idle
        case loading
        case loaded(POCManifest)
        case failed(String)
    }

    @Published var state: State = .idle
    @Published var searchText = ""

    private let client: ManifestClient
    private var loadGeneration = UUID()

    init(client: ManifestClient) {
        self.client = client
    }

    var entries: [POCEntry] {
        guard case .loaded(let manifest) = state else { return [] }
        return manifest.entriesByRecentUpdate
    }

    var filteredEntries: [POCEntry] {
        entries.filter { $0.matchesSearch(searchText) }
    }

    var verifiedManifest: POCManifest? {
        guard case .loaded(let manifest) = state else { return nil }
        return manifest
    }

    func load() async {
        let generation = UUID()
        loadGeneration = generation
        state = .loading
        do {
            let manifest = try await client.fetchManifest()
            guard generation == loadGeneration else { return }
            guard !Task.isCancelled else {
                state = .idle
                return
            }
            state = .loaded(manifest)
        } catch {
            guard generation == loadGeneration else { return }
            guard !Task.isCancelled else {
                state = .idle
                return
            }
            state = .failed(error.localizedDescription)
        }
    }

    func reset() {
        loadGeneration = UUID()
        state = .idle
        searchText = ""
    }
}
