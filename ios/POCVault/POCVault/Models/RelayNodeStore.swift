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
    /// necessarily repointing the app: the current node URL is kept, and one is
    /// set only if none was active yet.
    ///
    /// Deliberately non-optional. Forgetting a machine is a destructive,
    /// unrecoverable act (the cloud answers `trial_already_used` for every state
    /// but `failed`), so it has to go through `clear()` — never through a nil
    /// that a `try?` could have produced.
    func updateTrial(_ trial: RelayTrialNode) {
        self.trial = trial
        persist(trial)
        if activeNodeURL == nil {
            activeNodeURL = trial.nodeURL
        }
    }

    /// Applies the outcome of a trial refresh.
    ///
    /// Only the server authoritatively answering "this account has no trial"
    /// (`RelayTrialClientError.noTrial`, the 404 `no_trial` body) may erase the
    /// persisted machine. Offline, DNS, 5xx, an expired session, or a response
    /// the app cannot decode all leave the record and `activeNodeURL` exactly as
    /// they were — foregrounding the app with no signal must never cost the user
    /// their machine.
    func applyRefresh(_ result: Result<RelayTrialNode, Error>) {
        switch result {
        case .success(let trial):
            updateTrial(trial)
        case .failure(let error):
            guard (error as? RelayTrialClientError) == .noTrial else { return }
            clear()
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
