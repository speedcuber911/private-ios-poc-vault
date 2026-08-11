import CryptoKit
import Foundation
import Security

enum RelayTrialPairing {
    static let deviceSlot = "device-blob"
    static let nodeSlot = "node-blob"
    private static let authLabel = "relay-pair-auth-v1"
    private static let macLabel = "relay-pair-mac-v1"
    private static let p12Label = "relay-trial-p12-v1"

    // Swift's SystemRandomNumberGenerator is cryptographically secure and, unlike
    // SecRandomCopyBytes, has no failure path that could hand back the all-zero
    // buffer as if it were a secret. This value is the sole protection on the
    // pairing rendezvous, so a silently predictable one would be worse than a crash.
    static func generateSecret() -> String {
        var rng = SystemRandomNumberGenerator()
        let bytes = (0..<24).map { _ in UInt8.random(in: .min ... .max, using: &rng) }
        return Data(bytes).base64URLEncodedString()
    }

    static func authToken(secret: String) -> String {
        var input = Data(authLabel.utf8)
        input.append(0)
        input.append(Data(secret.utf8))
        return Data(SHA256.hash(data: input)).base64URLEncodedString()
    }

    static func macKey(secret: String) -> SymmetricKey {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(macLabel.utf8), using: SymmetricKey(data: Data(secret.utf8)))
        return SymmetricKey(data: Data(mac))
    }

    static func blobTag(macKey: SymmetricKey, slot: String, blob: Data) -> String {
        var message = Data(slot.utf8)
        message.append(0)
        message.append(blob)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: macKey)).base64EncodedString()
    }

    static func verifyTag(macKey: SymmetricKey, slot: String, blob: Data, tag: String) -> Bool {
        guard let tagData = Data(base64Encoded: tag) else { return false }
        var message = Data(slot.utf8)
        message.append(0)
        message.append(blob)
        let expected = Data(HMAC<SHA256>.authenticationCode(for: message, using: macKey))
        guard expected.count == tagData.count else { return false }
        return expected.withUnsafeBytes { a in
            tagData.withUnsafeBytes { b in
                var diff: UInt8 = 0
                for i in 0..<expected.count { diff |= a[i] ^ b[i] }
                return diff == 0
            }
        }
    }

    static func p12Passphrase(secret: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(p12Label.utf8), using: SymmetricKey(data: Data(secret.utf8)))
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
