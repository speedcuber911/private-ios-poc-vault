import Foundation

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

    func load() async {
        state = .loading
        do {
            state = .loaded(try await client.fetchManifest())
        } catch {
            state = .failed(error.localizedDescription)
        }
    }
}
