import Foundation

/// Runtime-mutable pointer to the active Relay node endpoint. Defaults to
/// `AppConfiguration.codexBaseURL` (the personal install) until a trial node is
/// adopted, at which point the app can be redirected to a freshly provisioned
/// trial node without a relaunch. Persists the last known trial across launches.
@MainActor
final class RelayNodeStore: ObservableObject {
    @Published private(set) var activeNodeURL: URL?
    @Published private(set) var trial: RelayTrialNode?

    private let defaults: UserDefaults
    private static let storageKey = "com.parikshit.pocvault.trial.node"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        if let data = defaults.data(forKey: Self.storageKey),
           let restored = try? JSONDecoder().decode(RelayTrialNode.self, from: data) {
            trial = restored
            activeNodeURL = restored.nodeURL
        }
    }

    /// The base URL the app should actually talk to: the adopted trial node when
    /// present, else the personal install's configured Codex base URL.
    var effectiveBaseURL: URL {
        activeNodeURL ?? AppConfiguration.codexBaseURL
    }

    /// Adopts a newly created/paired trial node: persists it and points the app at it.
    func adoptTrial(_ trial: RelayTrialNode) {
        self.trial = trial
        activeNodeURL = trial.nodeURL
        persist(trial)
    }

    /// Refreshes the known trial state (e.g. an expiry countdown tick) without
    /// necessarily repointing the app: a present trial keeps the current node URL
    /// (setting one only if none was active yet), while a nil trial clears it.
    func updateTrial(_ trial: RelayTrialNode?) {
        self.trial = trial
        guard let trial else {
            activeNodeURL = nil
            defaults.removeObject(forKey: Self.storageKey)
            return
        }
        persist(trial)
        if activeNodeURL == nil {
            activeNodeURL = trial.nodeURL
        }
    }

    /// Removes all persisted trial state and reverts to the personal install.
    func clear() {
        trial = nil
        activeNodeURL = nil
        defaults.removeObject(forKey: Self.storageKey)
    }

    private func persist(_ trial: RelayTrialNode) {
        guard let data = try? JSONEncoder().encode(trial) else { return }
        defaults.set(data, forKey: Self.storageKey)
    }
}
