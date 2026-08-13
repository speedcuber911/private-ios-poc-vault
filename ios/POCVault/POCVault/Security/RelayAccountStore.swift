import Foundation
import Security

@MainActor
final class RelayAccountStore: ObservableObject {
    enum Phase: Equatable {
        case restoring
        case signedOut
        case onboarding
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
    /// Held so ending a session can also drop the machine pointer: the trial
    /// record is account-scoped state, and leaving it behind would hand the next
    /// account on this phone another account's machine.
    private let nodeStore: RelayNodeStore?
    private var sessionToken: String?
    private var hasRestored = false

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

    func completeOnboarding() {
        guard let user else { return }
        defaults.set(true, forKey: onboardingKey(for: user.id))
        phase = .ready
    }

    func signOut() async {
        // Deliberately NOT purging: see `accept(user:token:)`. The machine
        // outlives the session and its pairing cannot be repeated, so the
        // credentials are kept until a different account signs in here.
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
            let deletedUserID = user?.id
            try await client.deleteAccount(password: password, bearerToken: token)
            if let deletedUserID {
                defaults.removeObject(forKey: onboardingKey(for: deletedUserID))
            }
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
        // ends. Signing out used to purge, which is safe but permanent: a
        // trial's pairing slots are put-once, so the moment this device drops
        // the identity, the machine it belongs to — still running, still paid
        // for, still holding the user's files — can never be reached from here
        // again. Signing back in cannot undo it, and the control plane answers
        // `trial_already_used` to every attempt to replace it, leaving the
        // account with a machine it cannot open and no way to get another.
        //
        // Doing it here keeps the property that mattered: a DIFFERENT account
        // signing in on this phone still inherits nothing.
        if let previousOwner = defaults.string(forKey: Self.trialOwnerKey), previousOwner != user.id {
            nodeStore?.clear()
            identityStore.discardTrialMaterial()
        }
        defaults.set(user.id, forKey: Self.trialOwnerKey)

        self.user = user
        sessionToken = token
        phase = defaults.bool(forKey: onboardingKey(for: user.id)) ? .ready : .onboarding
    }

    /// The account whose trial machine this device currently holds credentials
    /// for. Compared on sign-in to decide whether they must be dropped.
    private static let trialOwnerKey = "com.parikshit.pocvault.trial.owner"

    /// `purgingDeviceAccess` is set only when the user deliberately leaves the
    /// account (sign out, delete account). Then this device's access to that
    /// account's machine goes with it: the trial pointer and the trial-issued
    /// client identity plus its pinned CA are removed, so a second account
    /// signing in here inherits neither. A BYO identity the user imported for
    /// their own install is theirs, not the account's, and is left alone.
    ///
    /// A dropped session (expired token, auth server unreachable) must NOT purge:
    /// the same user signs back in and their machine — whose pairing can never be
    /// repeated — has to still be there.
    private func clearLocalSession(purgingDeviceAccess: Bool = false) {
        try? tokenStore.delete()
        if purgingDeviceAccess {
            nodeStore?.clear()
            identityStore.discardTrialMaterial()
        }
        sessionToken = nil
        user = nil
        errorMessage = nil
        phase = .signedOut
    }

    private func onboardingKey(for userID: String) -> String {
        "com.parikshit.pocvault.onboarding.\(userID)"
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
