import Foundation

struct DeviceCodeInspectResult: Equatable {
    let machineName: String?
    let platform: String?
    let createdAt: Int64
    let expiresAt: Int64
}

struct CLIComputerLink: Decodable, Equatable, Identifiable {
    enum Status: String, Decodable {
        case connecting
        case connected
    }

    let id: String
    let machineName: String?
    let platform: String?
    let status: Status
    let connectedAt: Int64?
    let createdAt: Int64
}

struct CLIComputerLinkState: Equatable {
    let computer: CLIComputerLink?
    let foldersAvailable: Bool
}

protocol RelayComputerLinkAuthClient: AnyObject {
    func computerLinkState(bearerToken: String) async throws -> CLIComputerLinkState
    func disconnectComputer(bearerToken: String) async throws
}

extension RelayAuthClient: RelayComputerLinkAuthClient {}

/// App-wide source of truth for the account's one CLI computer.
///
/// The file browser talks directly to the Relay node, while disconnecting a
/// computer happens on the account control plane. Without shared state, a
/// successful disconnect leaves the already-loaded node folders on screen.
/// This store bridges those two surfaces and remembers the user's explicit
/// disconnect across launches. Successful refreshes mirror the account
/// service's authoritative folder-access state; the persisted value only
/// prevents stale folders flashing while that refresh is in flight.
@MainActor
final class RelayComputerLinkStore: ObservableObject {
    @Published private(set) var computer: CLIComputerLink?
    @Published private(set) var hasLoaded = false
    @Published private(set) var isLoading = false
    @Published private(set) var isDisconnecting = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var suppressedFolderAccountIDs: Set<String>

    private let client: RelayComputerLinkAuthClient
    private let defaults: UserDefaults
    private var activeAccountID: String?
    private var operationRevision = 0

    private static let suppressedFolderAccountsKey =
        "com.parikshit.pocvault.computer-disconnect.hidden-folder-accounts"

    init(
        client: RelayComputerLinkAuthClient,
        defaults: UserDefaults = .standard
    ) {
        self.client = client
        self.defaults = defaults
        suppressedFolderAccountIDs = Set(
            defaults.stringArray(forKey: Self.suppressedFolderAccountsKey) ?? []
        )
    }

    func suppressesFolderAccess(for accountID: String?) -> Bool {
        guard let accountID = accountID?.trimmedNonEmpty else { return false }
        return suppressedFolderAccountIDs.contains(accountID)
    }

    func refresh(
        bearerToken: String,
        accountID: String,
        showProgress: Bool = true
    ) async {
        switchToAccountIfNeeded(accountID)
        guard !isLoading, !isDisconnecting else { return }

        operationRevision += 1
        let revision = operationRevision
        if showProgress { isLoading = true }
        errorMessage = nil
        defer {
            if revision == operationRevision, activeAccountID == accountID {
                hasLoaded = true
                if showProgress { isLoading = false }
            }
        }

        do {
            let loadedState = try await client.computerLinkState(bearerToken: bearerToken)
            guard revision == operationRevision, activeAccountID == accountID else { return }
            computer = loadedState.computer
            setFolderAccessSuppressed(!loadedState.foldersAvailable, for: accountID)
        } catch {
            guard revision == operationRevision, activeAccountID == accountID,
                  !isCancellation(error) else { return }
            errorMessage = "Relay couldn't refresh the computer link."
        }
    }

    func disconnect(bearerToken: String, accountID: String) async {
        switchToAccountIfNeeded(accountID)
        guard !isDisconnecting else { return }

        // Invalidate an in-flight GET before issuing DELETE. Otherwise its
        // older response can restore the computer (and its folders) after the
        // disconnect has already succeeded.
        operationRevision += 1
        let revision = operationRevision
        isLoading = false
        isDisconnecting = true
        errorMessage = nil
        defer {
            if revision == operationRevision, activeAccountID == accountID {
                isDisconnecting = false
            }
        }

        do {
            try await client.disconnectComputer(bearerToken: bearerToken)
            guard revision == operationRevision, activeAccountID == accountID else { return }
            computer = nil
            hasLoaded = true
            setFolderAccessSuppressed(true, for: accountID)
        } catch {
            guard revision == operationRevision, activeAccountID == accountID,
                  !isCancellation(error) else { return }
            errorMessage = "Relay couldn't disconnect this computer. Try again."
        }
    }

    private func switchToAccountIfNeeded(_ accountID: String) {
        guard activeAccountID != accountID else { return }
        operationRevision += 1
        activeAccountID = accountID
        computer = nil
        hasLoaded = false
        isLoading = false
        isDisconnecting = false
        errorMessage = nil
    }

    private func setFolderAccessSuppressed(_ suppressed: Bool, for accountID: String) {
        if suppressed {
            suppressedFolderAccountIDs.insert(accountID)
        } else {
            suppressedFolderAccountIDs.remove(accountID)
        }
        defaults.set(
            suppressedFolderAccountIDs.sorted(),
            forKey: Self.suppressedFolderAccountsKey
        )
    }
}

protocol CLILinkAuthClient: AnyObject {
    func deviceInspect(userCode: String, bearerToken: String) async throws -> DeviceCodeInspectResult
    func deviceApprove(userCode: String, bearerToken: String) async throws
}

extension RelayAuthClient: CLILinkAuthClient {}

/// Drives in-app CLI linking: scan/type a user code → inspect → confirm → approve.
/// Status is always explicit text (Editorial Ember) — never a colored dot.
@MainActor
final class CLILinkFlowModel: ObservableObject {
    enum Step: Equatable {
        case scanning
        case inspecting
        case confirm(machineName: String?, platform: String?)
        case approving
        case approved(machineName: String?)
        case failed(String)
    }

    static let staleCodeMessage =
        "That code isn't valid anymore. Run `relay login` on your computer to get a fresh one."
    static let networkRetryMessage =
        "Couldn't reach Relay. Check your connection and try again."
    static let alreadyLinkedMessage =
        "A computer is already connected. Disconnect it in Account & Settings before linking another one."

    @Published private(set) var step: Step = .scanning
    @Published var manualCode: String = ""

    private let authClient: CLILinkAuthClient
    private let bearerToken: String
    private var pendingUserCode: String?
    private var pendingMachineName: String?

    init(authClient: CLILinkAuthClient, bearerToken: String) {
        self.authClient = authClient
        self.bearerToken = bearerToken
    }

    func resetToScanning() {
        pendingUserCode = nil
        pendingMachineName = nil
        manualCode = ""
        step = .scanning
    }

    func submitScannedPayload(_ raw: String) async {
        await inspect(raw)
    }

    func submitManualCode() async {
        await inspect(manualCode)
    }

    func confirmLink() async {
        guard let userCode = pendingUserCode else {
            step = .failed(Self.staleCodeMessage)
            return
        }
        step = .approving
        do {
            try await authClient.deviceApprove(userCode: userCode, bearerToken: bearerToken)
            step = .approved(machineName: pendingMachineName)
        } catch let error as RelayAuthClientError {
            step = .failed(Self.message(for: error))
        } catch {
            step = .failed(Self.networkRetryMessage)
        }
    }

    func cancelConfirm() {
        pendingUserCode = nil
        pendingMachineName = nil
        step = .scanning
    }

    private func inspect(_ raw: String) async {
        guard let userCode = Self.parseUserCode(from: raw) else {
            step = .failed(Self.staleCodeMessage)
            return
        }
        pendingUserCode = userCode
        step = .inspecting
        do {
            let info = try await authClient.deviceInspect(userCode: userCode, bearerToken: bearerToken)
            pendingMachineName = info.machineName
            step = .confirm(machineName: info.machineName, platform: info.platform)
        } catch let error as RelayAuthClientError {
            pendingUserCode = nil
            pendingMachineName = nil
            step = .failed(Self.message(for: error))
        } catch {
            pendingUserCode = nil
            pendingMachineName = nil
            step = .failed(Self.networkRetryMessage)
        }
    }

    private static func message(for error: RelayAuthClientError) -> String {
        switch error {
        case .server(let status, let code, _) where status == 409 && code == "computer_already_linked":
            return alreadyLinkedMessage
        case .server(let status, _, _) where status == 404 || status == 429:
            return staleCodeMessage
        case .invalidResponse, .missingSessionToken:
            return staleCodeMessage
        case .server:
            return networkRetryMessage
        }
    }

    /// Accepts a URL whose fragment contains `code=XXXX-XXXX`, or a bare code.
    /// Returns canonical `ABCD-EFGH` or nil.
    static func parseUserCode(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }

        if let urlCode = codeFromURL(trimmed) {
            return normalizeUserCode(urlCode)
        }
        return normalizeUserCode(trimmed)
    }

    static func normalizeUserCode(_ value: String) -> String? {
        let cleaned = value.uppercased().filter { $0.isLetter || $0.isNumber }
        guard cleaned.count == 8 else { return nil }
        let chars = Array(cleaned)
        return String(chars[0..<4]) + "-" + String(chars[4..<8])
    }

    private static func codeFromURL(_ raw: String) -> String? {
        guard let url = URL(string: raw), let fragment = url.fragment, !fragment.isEmpty else {
            // Also accept "…#code=ABCD-EFGH" when URL() is picky about schemes.
            if let hash = raw.split(separator: "#", maxSplits: 1).last, hash != raw[...] {
                return codeFromQueryLike(String(hash))
            }
            return nil
        }
        return codeFromQueryLike(fragment)
    }

    private static func codeFromQueryLike(_ fragment: String) -> String? {
        for pair in fragment.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2, parts[0] == "code" else { continue }
            return parts[1].removingPercentEncoding ?? parts[1]
        }
        return nil
    }
}
