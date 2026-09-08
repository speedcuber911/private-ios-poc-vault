import Foundation
import Security

@MainActor
final class RelayAccountStore: ObservableObject {
    /// Where the *account* is — which, since BYO pairing, is no longer where the
    /// *app* is. A signed-out phone with a paired machine is a fully working
    /// installation: signing in buys handoff, push notifications and `relay
    /// login` approval, and nothing else. The router keys off
    /// `RelayNodeStore.hasMachine`; this says only whether a session exists.
    enum Phase: Equatable {
        case restoring
        case signedOut
        case ready
    }

    @Published private(set) var phase: Phase = .restoring
    @Published private(set) var user: RelayAccountUser?
    @Published private(set) var isWorking = false
    @Published var errorMessage: String?

    private let client: RelayAuthClient
    private let identityStore: ClientIdentityStore
    private let tokenStore: RelaySessionTokenStore
    private let defaults: UserDefaults
    /// Held so a *different* account signing in on this phone cannot inherit the
    /// machine pointer and the credential that goes with it.
    private let nodeStore: RelayNodeStore?
    private var sessionToken: String?
    private var hasRestored = false
    private var accountGeneration = UUID()

    init(
        client: RelayAuthClient,
        identityStore: ClientIdentityStore,
        defaults: UserDefaults = .standard,
        tokenStore: RelaySessionTokenStore = RelaySessionTokenStore(),
        nodeStore: RelayNodeStore? = nil
    ) {
        self.client = client
        self.identityStore = identityStore
        self.defaults = defaults
        self.tokenStore = tokenStore
        self.nodeStore = nodeStore
    }

    func restore() async {
        guard !hasRestored else { return }
        hasRestored = true
        guard let token = try? tokenStore.load(), !token.isEmpty else {
            phase = .signedOut
            return
        }

        do {
            guard let restoredUser = try await client.session(for: token) else {
                clearLocalSession()
                return
            }
            accept(user: restoredUser, token: token)
        } catch {
            clearLocalSession()
        }
    }

    func signUp(username: String, email: String, password: String) async {
        await runAuthentication {
            try await client.signUp(
                username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                email: email.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
        }
    }

    func signIn(username: String, password: String) async {
        await runAuthentication {
            try await client.signIn(
                username: username.trimmingCharacters(in: .whitespacesAndNewlines),
                password: password
            )
        }
    }

    func signInWithApple(
        identityToken: String,
        nonce: String,
        email: String?,
        firstName: String?,
        lastName: String?
    ) async {
        await runAuthentication {
            try await client.signInWithApple(
                identityToken: identityToken,
                nonce: nonce,
                email: email,
                firstName: firstName,
                lastName: lastName
            )
        }
    }

    func signOut() async {
        accountGeneration = UUID()
        // Deliberately NOT purging: see `accept(user:token:)`. The machine
        // outlives the session — it is the user's own hardware, paired to this
        // phone directly, and it keeps serving files and chat while signed out.
        guard let token = sessionToken else {
            clearLocalSession()
            return
        }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await client.signOut(bearerToken: token)
        } catch {
            // A local sign-out must remain possible during an outage. Better
            // Auth sessions expire server-side and are not retained by Relay.
        }
        clearLocalSession()
    }

    func deleteAccount(password: String?) async -> Bool {
        guard let token = sessionToken else {
            clearLocalSession(purgingDeviceAccess: true)
            return true
        }
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await client.deleteAccount(password: password, bearerToken: token)
            try? identityStore.deleteStoredIdentity()
            clearLocalSession(purgingDeviceAccess: true)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }

    func dismissError() {
        errorMessage = nil
    }

    var currentSessionToken: String? { sessionToken }

    private func runAuthentication(
        operation: () async throws -> (RelayAccountUser, String)
    ) async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let (user, token) = try await operation()
            try tokenStore.save(token)
            accept(user: user, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func accept(user: RelayAccountUser, token: String) {
        // Machine access is purged when the account CHANGES, not when a session
        // ends. The same account can reuse valid host-scoped credentials; a
        // different account signing in on this phone inherits nothing.
        if let previousOwner = defaults.string(forKey: Self.machineOwnerKey), previousOwner != user.id {
            nodeStore?.clear()
            identityStore.discardPairedMaterial()
        }
        defaults.set(user.id, forKey: Self.machineOwnerKey)

        accountGeneration = UUID()
        self.user = user
        sessionToken = token
        phase = .ready
    }

    /// The account whose machine credentials this device currently holds.
    /// Compared on sign-in to decide whether they must be dropped. The key name
    /// is historical: it is already written on every installed build.
    private static let machineOwnerKey = "com.parikshit.pocvault.trial.owner"

    /// `purgingDeviceAccess` is set when the account is deleted. This device's
    /// retained access to that account's machine goes with it: the node pointer
    /// and the pairing-issued client identity plus its pinned CA are removed, so
    /// a second account signing in here inherits neither. A BYO identity the
    /// user imported for their own install is theirs, not the account's, and is
    /// left alone.
    ///
    /// A dropped session or ordinary sign-out does not purge: the same account
    /// may reuse its valid credentials, and a paired machine is not the
    /// account's property in the first place. Account changes purge in `accept`.
    private func clearLocalSession(purgingDeviceAccess: Bool = false) {
        accountGeneration = UUID()
        try? tokenStore.delete()
        if purgingDeviceAccess {
            nodeStore?.clear()
            identityStore.discardPairedMaterial()
        }
        sessionToken = nil
        user = nil
        errorMessage = nil
        phase = .signedOut
    }
}

struct RelaySessionTokenStore {
    private let service = "com.parikshit.pocvault.better-auth"
    private let account = "session"

    func save(_ token: String) throws {
        let data = Data(token.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        var insert = query
        insert[kSecValueData as String] = data
        insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(insert as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw RelaySessionTokenStoreError.keychain(status)
        }
    }

    func load() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else {
            throw RelaySessionTokenStoreError.keychain(status)
        }
        return String(data: data, encoding: .utf8)
    }

    func delete() throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RelaySessionTokenStoreError.keychain(status)
        }
    }
}

private enum RelaySessionTokenStoreError: Error, LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status):
            return "Relay could not securely store the session. OSStatus \(status)."
        }
    }
}
