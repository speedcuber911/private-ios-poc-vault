import Foundation

/// A machine this phone has paired with, as it was described by the machine
/// itself in the MAC-authenticated pairing response.
///
/// `pubkeyPEM` and `encPubkey` are learned at pairing time and carried purely so
/// the machine can later be registered with a Relay account: `relay handoff`
/// seals to the X25519 key, and nothing else in the system writes it now that
/// trial enrolment is gone. Neither is needed to use files or chat.
struct RelayPairedNode: Codable, Equatable, Identifiable, Hashable {
    let nodeID: String
    var nodeName: String
    let apiBaseURL: URL
    /// The machine's own id for this phone. Kept because it is the argument to
    /// `relayd devices revoke`, which is the remedy when the confirmation code
    /// does not match — advice is worth little if the user has to go and find
    /// the id themselves.
    var deviceID: String?
    /// The confirmation code the machine printed in the terminal, held until
    /// the user has compared the two. Nil once confirmed, and nil from the
    /// start when the machine did not send one.
    ///
    /// Persisted rather than kept in the pairing screen's memory because the
    /// screen does not survive the moment it succeeds: adopting the node flips
    /// `hasMachine`, and the router replaces the whole onboarding stack. It
    /// also means backgrounding the app mid-comparison does not quietly skip
    /// the check.
    var pendingVerificationCode: String?
    /// The node's ed25519 identity, SPKI PEM.
    var pubkeyPEM: String?
    /// The node's X25519 public key, base64 — the handoff seal recipient.
    var encPubkey: String?
    /// The Relay account this machine has been published to, when it has been.
    /// `nil` is a normal, supported state: the machine still serves files and
    /// chat, it just has no laptop handoff and no push.
    var registeredAccountID: String?
    /// Optional user-chosen index into `RelayIdentityColor` for distinguishing
    /// this host in multi-host lists and badges. Nil uses the deterministic hash.
    var colorIndex: Int?
    /// Optional timestamp recording when this host was paired. Nil for legacy
    /// records or fixtures that did not stamp a date.
    var addedAt: Date?

    var id: String { nodeID }

    /// The single host the pinned CA and the device bearer token apply to.
    /// An IP literal is a first-class case here — a BYO node usually has no DNS
    /// name — and so is a non-standard port, which is deliberately *not* part of
    /// this value: pinning and token scoping are per host, as `URLSession`
    /// reports it on an authentication challenge.
    var host: String? { apiBaseURL.host }
}

/// Runtime-mutable multi-host store for the machines this phone has paired with,
/// plus the currently active selection.
///
/// Defaults to `AppConfiguration.codexBaseURL` (the personal install someone
/// configured through `support/vault-config.json`) until a node is paired, at
/// which point every surface is repointed without a relaunch. All paired hosts
/// and the active selection persist across launches, auto-migrating any legacy
/// single-host record on first load.
@MainActor
final class RelayNodeStore: ObservableObject {
    @Published private(set) var hosts: [RelayPairedNode] = []
    @Published private(set) var activeHostID: String?
    @Published private(set) var pairedNode: RelayPairedNode?

    /// Optional observer invoked whenever the active host changes (selection,
    /// adoption, or removal), allowing the app shell to switch host-scoped TLS
    /// pinning and bearer credentials in lockstep.
    var onActiveHostChanged: ((RelayPairedNode?) -> Void)?

    private let defaults: UserDefaults
    private static let storageKeyV2 = "com.parikshit.pocvault.paired.nodes.v2"
    private static let activeHostStorageKey = "com.parikshit.pocvault.paired.activeNodeID"
    /// Legacy single-host key read once and migrated into `storageKeyV2`.
    private static let legacyStorageKey = "com.parikshit.pocvault.paired.node"
    /// The trial pointer this store used to persist. Removed on first launch
    /// after the upgrade: a machine allocated by Relay no longer exists, and a
    /// dead pointer left in defaults is a host the app would otherwise dial.
    private static let legacyTrialKey = "com.parikshit.pocvault.trial.node"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.removeObject(forKey: Self.legacyTrialKey)

        if let data = defaults.data(forKey: Self.storageKeyV2),
           let restored = try? JSONDecoder().decode([RelayPairedNode].self, from: data) {
            hosts = restored
            let storedActiveID = defaults.string(forKey: Self.activeHostStorageKey)
            if let storedActiveID, hosts.contains(where: { $0.nodeID == storedActiveID }) {
                activeHostID = storedActiveID
            } else {
                activeHostID = hosts.first?.nodeID
            }
        } else if let legacyData = defaults.data(forKey: Self.legacyStorageKey),
                  let restored = try? JSONDecoder().decode(RelayPairedNode.self, from: legacyData) {
            hosts = [restored]
            activeHostID = restored.nodeID
            persist()
            defaults.removeObject(forKey: Self.legacyStorageKey)
        }

        syncPairedNode()
    }

    var activeNodeURL: URL? { pairedNode?.apiBaseURL }

    /// The confirmation code still awaiting comparison with the terminal, if
    /// any. Nil is the ordinary state — before pairing, after confirming, and
    /// against a machine whose relayd does not send one.
    var pendingVerificationCode: String? { pairedNode?.pendingVerificationCode }

    /// The base URL the app should actually talk to: the active paired node when
    /// there is one, else the personal install's configured Codex base URL.
    var effectiveBaseURL: URL {
        activeNodeURL ?? AppConfiguration.codexBaseURL
    }

    /// Whether there is actually a machine to talk to: a paired node, or a
    /// personal install someone deliberately configured.
    ///
    /// `effectiveBaseURL` can never answer this — it falls back to the build
    /// default, so it always yields *a* URL whether or not a machine exists.
    /// This predicate is what routes an unpaired phone to the pairing screen
    /// instead of firing requests at that default and reporting the resulting
    /// TLS failure as the user's machine misbehaving.
    ///
    /// The simulator preview's fixture counts as a configured personal install —
    /// see `AppConfiguration.isSimulatorFixtureRun`.
    var hasMachine: Bool {
        pairedNode != nil || AppConfiguration.hasConfiguredPersonalInstall
    }

    func host(id: String) -> RelayPairedNode? {
        hosts.first(where: { $0.nodeID == id })
    }

    /// Adopts a freshly paired machine: adds or updates it in `hosts`, makes it
    /// active, and persists.
    func adopt(_ node: RelayPairedNode) {
        var updated = node
        if let index = hosts.firstIndex(where: { $0.nodeID == node.nodeID }) {
            let previous = hosts[index]
            if updated.colorIndex == nil {
                updated.colorIndex = previous.colorIndex
            }
            if updated.addedAt == nil {
                updated.addedAt = previous.addedAt
            }
            hosts[index] = updated
        } else {
            hosts.append(updated)
        }

        let previousActive = pairedNode
        activeHostID = updated.nodeID
        syncPairedNode()
        persist()
        if previousActive?.nodeID != pairedNode?.nodeID || previousActive?.host != pairedNode?.host {
            onActiveHostChanged?(pairedNode)
        }
    }

    /// Switches the active host to the paired machine with `id`.
    func selectHost(id: String) {
        guard hosts.contains(where: { $0.nodeID == id }) else { return }
        guard activeHostID != id else { return }
        activeHostID = id
        syncPairedNode()
        persist()
        onActiveHostChanged?(pairedNode)
    }

    /// Removes the paired host with `id`, activating another remaining host if
    /// available, or reverting to nil when none remain.
    func removeHost(id: String) {
        let previousActiveID = activeHostID
        hosts.removeAll { $0.nodeID == id }
        if activeHostID == id {
            activeHostID = hosts.first?.nodeID
        }
        syncPairedNode()
        persist()
        if previousActiveID != activeHostID || previousActiveID == id {
            onActiveHostChanged?(pairedNode)
        }
    }

    /// Updates the display name of the paired host with `id`.
    func renameHost(id: String, name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let index = hosts.firstIndex(where: { $0.nodeID == id }) else {
            return
        }
        hosts[index].nodeName = trimmed
        syncPairedNode()
        persist()
    }

    /// Sets or clears the user-selected identity color index for the paired host with `id`.
    func setHostColor(id: String, colorIndex: Int?) {
        guard let index = hosts.firstIndex(where: { $0.nodeID == id }) else { return }
        hosts[index].colorIndex = colorIndex
        syncPairedNode()
        persist()
    }

    /// The user has compared the confirmation code with their terminal and
    /// says it matches. Only clears the prompt — the pairing itself completed
    /// before the code could be shown, which is why the copy says "confirm",
    /// not "approve".
    func confirmVerification() {
        guard let activeHostID,
              let index = hosts.firstIndex(where: { $0.nodeID == activeHostID }),
              hosts[index].pendingVerificationCode != nil else {
            return
        }
        hosts[index].pendingVerificationCode = nil
        syncPairedNode()
        persist()
    }

    /// Records that the active machine is now published to `accountID`, so
    /// Settings stops offering to connect it.
    func markRegistered(accountID: String) {
        guard let activeHostID else { return }
        markRegistered(accountID: accountID, nodeID: activeHostID)
    }

    /// Records that the specified machine is now published to `accountID`.
    func markRegistered(accountID: String, nodeID: String) {
        guard let index = hosts.firstIndex(where: { $0.nodeID == nodeID }) else { return }
        hosts[index].registeredAccountID = accountID
        syncPairedNode()
        persist()
    }

    /// Forgets the active paired machine. When only one host existed, clears the
    /// store completely and reverts to the personal install, if any; when other
    /// hosts exist, activates the next available host gracefully.
    func clear() {
        if let activeHostID {
            removeHost(id: activeHostID)
        } else {
            clearAll()
        }
    }

    /// Forgets every paired machine and reverts to the personal install, if any.
    func clearAll() {
        let hadActive = pairedNode != nil
        hosts = []
        activeHostID = nil
        pairedNode = nil
        defaults.removeObject(forKey: Self.storageKeyV2)
        defaults.removeObject(forKey: Self.activeHostStorageKey)
        defaults.removeObject(forKey: Self.legacyStorageKey)
        if hadActive {
            onActiveHostChanged?(nil)
        }
    }

    private func syncPairedNode() {
        if let activeHostID,
           let matched = hosts.first(where: { $0.nodeID == activeHostID }) {
            pairedNode = matched
        } else if let first = hosts.first {
            activeHostID = first.nodeID
            pairedNode = first
        } else {
            activeHostID = nil
            pairedNode = nil
        }
    }

    private func persist() {
        if hosts.isEmpty {
            defaults.removeObject(forKey: Self.storageKeyV2)
            defaults.removeObject(forKey: Self.activeHostStorageKey)
            defaults.removeObject(forKey: Self.legacyStorageKey)
            return
        }
        if let data = try? JSONEncoder().encode(hosts) {
            defaults.set(data, forKey: Self.storageKeyV2)
        }
        if let activeHostID {
            defaults.set(activeHostID, forKey: Self.activeHostStorageKey)
        } else {
            defaults.removeObject(forKey: Self.activeHostStorageKey)
        }
        defaults.removeObject(forKey: Self.legacyStorageKey)
    }
}

/// Publishing a paired machine to the signed-in Relay account.
///
/// This is deliberately a separate, optional step rather than part of pairing.
/// What it buys is handoff (`relay handoff` seals to the node's X25519 key,
/// which nothing else records) and push fan-out. Files, chat, terminals and
/// previews never needed an account and still do not, so every failure here is
/// reported and then dropped — it must never cost the user a working machine.
@MainActor
enum RelayNodeRegistration {
    /// Registers `node` with the account `accountStore` is signed into.
    /// Returns nil on success (or when there is nothing to do), else a message
    /// suitable for showing next to the machine in Settings.
    @discardableResult
    static func register(
        node: RelayPairedNode,
        accountStore: RelayAccountStore,
        nodeStore: RelayNodeStore,
        client: RelayAuthClient
    ) async -> String? {
        guard let bearer = accountStore.currentSessionToken,
              let accountID = accountStore.user?.id else {
            return "Sign in to connect this machine to your Relay account."
        }
        guard let pubkeyPEM = node.pubkeyPEM?.trimmedNonEmpty,
              let encPubkey = node.encPubkey?.trimmedNonEmpty else {
            // An older relayd that pairs but does not publish its keys. Handoff
            // has no recipient either way, so say that rather than inventing a
            // registration that would be useless.
            return "This machine did not send the keys Relay needs for handoff. Update relayd, then pair again."
        }
        do {
            try await client.registerNode(
                id: node.nodeID,
                name: node.nodeName,
                pubkeyPEM: pubkeyPEM,
                encPubkey: encPubkey,
                bearerToken: bearer
            )
            nodeStore.markRegistered(accountID: accountID, nodeID: node.nodeID)
            return nil
        } catch {
            return "Relay couldn't connect this machine to your account. Handoff and notifications stay off until it does."
        }
    }
}
