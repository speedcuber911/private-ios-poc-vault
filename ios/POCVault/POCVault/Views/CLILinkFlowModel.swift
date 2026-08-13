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
