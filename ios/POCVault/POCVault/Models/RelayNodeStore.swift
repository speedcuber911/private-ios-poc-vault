import Foundation

/// A machine this phone has paired with, as it was described by the machine
/// itself in the MAC-authenticated pairing response.
///
/// `pubkeyPEM` and `encPubkey` are learned at pairing time and carried purely so
/// the machine can later be registered with a Relay account: `relay handoff`
/// seals to the X25519 key, and nothing else in the system writes it now that
/// trial enrolment is gone. Neither is needed to use files or chat.
struct RelayPairedNode: Codable, Equatable {
    let nodeID: String
    let nodeName: String
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

    /// The single host the pinned CA and the device bearer token apply to.
    /// An IP literal is a first-class case here — a BYO node usually has no DNS
    /// name — and so is a non-standard port, which is deliberately *not* part of
    /// this value: pinning and token scoping are per host, as `URLSession`
    /// reports it on an authentication challenge.
    var host: String? { apiBaseURL.host }
}

/// Runtime-mutable pointer to the machine the app talks to.
///
/// Defaults to `AppConfiguration.codexBaseURL` (the personal install someone
/// configured through `support/vault-config.json`) until a node is paired, at
/// which point every surface is repointed without a relaunch. The paired node
/// persists across launches.
@MainActor
final class RelayNodeStore: ObservableObject {
    @Published private(set) var pairedNode: RelayPairedNode?

    private let defaults: UserDefaults
    private static let storageKey = "com.parikshit.pocvault.paired.node"
    /// The trial pointer this store used to persist. Removed on first launch
    /// after the upgrade: a machine allocated by Relay no longer exists, and a
    /// dead pointer left in defaults is a host the app would otherwise dial.
    private static let legacyTrialKey = "com.parikshit.pocvault.trial.node"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.removeObject(forKey: Self.legacyTrialKey)
        if let data = defaults.data(forKey: Self.storageKey),
           let restored = try? JSONDecoder().decode(RelayPairedNode.self, from: data) {
            pairedNode = restored
        }
    }

    var activeNodeURL: URL? { pairedNode?.apiBaseURL }

    /// The confirmation code still awaiting comparison with the terminal, if
    /// any. Nil is the ordinary state — before pairing, after confirming, and
    /// against a machine whose relayd does not send one.
    var pendingVerificationCode: String? { pairedNode?.pendingVerificationCode }

    /// The base URL the app should actually talk to: the paired node when there
    /// is one, else the personal install's configured Codex base URL.
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

    /// Adopts a freshly paired machine: persists it and points the app at it.
    func adopt(_ node: RelayPairedNode) {
        pairedNode = node
        persist(node)
    }

    /// The user has compared the confirmation code with their terminal and
    /// says it matches. Only clears the prompt — the pairing itself completed
    /// before the code could be shown, which is why the copy says "confirm",
    /// not "approve".
    func confirmVerification() {
        guard var node = pairedNode, node.pendingVerificationCode != nil else { return }
        node.pendingVerificationCode = nil
        pairedNode = node
        persist(node)
    }

    /// Records that this machine is now published to `accountID`, so Settings
    /// stops offering to connect it.
    func markRegistered(accountID: String) {
        guard var node = pairedNode else { return }
        node.registeredAccountID = accountID
        pairedNode = node
        persist(node)
    }

    /// Forgets the paired machine and reverts to the personal install, if any.
    func clear() {
        pairedNode = nil
        defaults.removeObject(forKey: Self.storageKey)
    }

    private func persist(_ node: RelayPairedNode) {
        guard let data = try? JSONEncoder().encode(node) else { return }
        defaults.set(data, forKey: Self.storageKey)
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
            nodeStore.markRegistered(accountID: accountID)
            return nil
        } catch {
            return "Relay couldn't connect this machine to your account. Handoff and notifications stay off until it does."
        }
    }
}
