import Foundation
import Security

@MainActor
final class RelayAccountStore: ObservableObject {
    enum Phase: Equatable {
        case restoring
        case signedOut
        case onboarding
        case ready
        case recoveringMachine
    }

    @Published private(set) var phase: Phase = .restoring
    @Published private(set) var user: RelayAccountUser?
    @Published private(set) var isWorking = false
    @Published var errorMessage: String?
    @Published private(set) var machineRecoveryError: String?

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
    private let hostedRecovery: RelayTrialFlowModel?
    private let hasConfiguredPersonalInstall: Bool
    private let recoveryDeviceName: String
    private var accountGeneration = UUID()

    init(
        client: RelayAuthClient,
        identityStore: ClientIdentityStore,
        defaults: UserDefaults = .standard,
        tokenStore: RelaySessionTokenStore = RelaySessionTokenStore(),
        nodeStore: RelayNodeStore? = nil,
        trialClient: RelayTrialClient? = nil,
        recoveryDeviceName: String = "Relay iOS",
        hasConfiguredPersonalInstall: Bool = AppConfiguration.hasConfiguredPersonalInstall
    ) {
        self.client = client
        self.identityStore = identityStore
        self.defaults = defaults
        self.tokenStore = tokenStore
        self.nodeStore = nodeStore
        self.recoveryDeviceName = recoveryDeviceName
        self.hasConfiguredPersonalInstall = hasConfiguredPersonalInstall
        self.hostedRecovery = if let trialClient, let nodeStore {
            RelayTrialFlowModel(client: trialClient, identityStore: identityStore, nodeStore: nodeStore)
        } else {
            nil
        }
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
            await accept(user: restoredUser, token: token)
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
        // Stop any in-flight recovery before waiting for the remote sign-out.
        // No late node blob may install access after the user leaves the account.
        accountGeneration = UUID()
        // Deliberately NOT purging: see `accept(user:token:)`. The machine
        // outlives the session. Reusing valid access avoids an unnecessary new
        // device credential when the same account signs back in.
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

    func retryHostedMachineRecovery() async {
        await recoverHostedMachineIfNeeded()
    }

    private func runAuthentication(
        operation: () async throws -> (RelayAccountUser, String)
    ) async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            let (user, token) = try await operation()
            try tokenStore.save(token)
            await accept(user: user, token: token)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func accept(user: RelayAccountUser, token: String) async {
        // Machine access is purged when the account CHANGES, not when a session
        // ends. The same account can reuse valid host-scoped credentials; a
        // fresh device instead obtains its own through authenticated recovery.
        //
        // Doing it here keeps the property that mattered: a DIFFERENT account
        // signing in on this phone still inherits nothing.
        if let previousOwner = defaults.string(forKey: Self.trialOwnerKey), previousOwner != user.id {
            nodeStore?.clear()
            identityStore.discardTrialMaterial()
        }
        defaults.set(user.id, forKey: Self.trialOwnerKey)

        accountGeneration = UUID()
        self.user = user
        sessionToken = token
        await recoverHostedMachineIfNeeded()
    }

    /// Discover hosted access from the authenticated account, not from a local
    /// trial pointer that a fresh device cannot have. A configured personal
    /// installation remains its own path and is never replaced by discovery.
    private func recoverHostedMachineIfNeeded() async {
        guard let user, let bearer = sessionToken else { return }
        guard let hostedRecovery,
              !hasConfiguredPersonalInstall || nodeStore?.trial != nil else {
            phase = defaults.bool(forKey: onboardingKey(for: user.id)) ? .ready : .onboarding
            return
        }
        let userID = user.id
        let generation = accountGeneration
        phase = .recoveringMachine
        machineRecoveryError = nil
        let isAuthorized = { [weak self] in
            guard let self else { return false }
            return self.accountGeneration == generation && self.user?.id == userID && self.sessionToken == bearer
        }
        do {
            let outcome = try await hostedRecovery.restoreExisting(
                bearer: bearer, deviceName: recoveryDeviceName, isAuthorized: isAuthorized
            )
            guard isAuthorized() else { return }
            switch outcome {
            case .restored:
                completeOnboarding()
            case .noMachine:
                phase = defaults.bool(forKey: onboardingKey(for: userID)) ? .ready : .onboarding
            case .setupRequired(.expired):
                // The existing expired-machine surface offers the subscription
                // path. A spent trial is not silently replaced by recovery.
                phase = .ready
            case .setupRequired(.creating):
                machineRecoveryError = "Your hosted machine is still starting. Wait a moment, then retry."
            case .setupRequired:
                phase = .onboarding
            }
        } catch {
            guard isAuthorized() else { return }
            machineRecoveryError = RelayTrialFlowModel.message(for: error)
        }
    }

    /// The account whose trial machine this device currently holds credentials
    /// for. Compared on sign-in to decide whether they must be dropped.
    private static let trialOwnerKey = "com.parikshit.pocvault.trial.owner"

    /// `purgingDeviceAccess` is set when the account is deleted. This device's
    /// retained access to that
    /// account's machine goes with it: the trial pointer and the trial-issued
    /// client identity plus its pinned CA are removed, so a second account
    /// signing in here inherits neither. A BYO identity the user imported for
    /// their own install is theirs, not the account's, and is left alone.
    ///
    /// A dropped session or ordinary sign-out does not purge: the same account
    /// may reuse its valid credentials. Account changes purge in `accept`.
    private func clearLocalSession(purgingDeviceAccess: Bool = false) {
        accountGeneration = UUID()
        try? tokenStore.delete()
        if purgingDeviceAccess {
            nodeStore?.clear()
            identityStore.discardTrialMaterial()
        }
        sessionToken = nil
        user = nil
        errorMessage = nil
        machineRecoveryError = nil
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
