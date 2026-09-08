import CryptoKit
import Foundation
import Security

/// Every value the phone and `relayd` must derive identically during pairing.
///
/// The four label strings below are **wire values**, shared with
/// `product/relayd/src/pairing.mjs`. Renaming one does not rename it on the
/// other side: it locks every already-paired device out of its machine. They
/// keep their historical spelling (`relay-trial-p12-v1`) for exactly that
/// reason, even though nothing about pairing is a trial any more.
enum RelayPairing {
    static let deviceSlot = "device-blob"
    static let nodeSlot = "node-blob"
    private static let authLabel = "relay-pair-auth-v1"
    private static let macLabel = "relay-pair-mac-v1"
    private static let p12Label = "relay-trial-p12-v1"
    private static let deviceTokenLabel = "relay-device-token-v1"

    /// The only pairing value a rendezvous is ever told. A one-way function of
    /// the secret, so holding it yields neither the secret nor `macKey`.
    ///
    /// The phone pairs directly with the node and does not use this itself; it
    /// stays because it is normative in the pairing contract and is the cheapest
    /// place to keep the cross-language test vector honest.
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
        // Constant-time compare without Data.withUnsafeBytes — nested closures
        // hit "Ambiguous use of 'withUnsafeBytes'" under Swift 6 / SourceKit
        // (ContiguousBytes vs the deprecated typed-pointer overload).
        var diff: UInt8 = 0
        for i in 0..<expected.count {
            diff |= expected[i] ^ tagData[i]
        }
        return diff == 0
    }

    static func p12Passphrase(secret: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(p12Label.utf8), using: SymmetricKey(data: Data(secret.utf8)))
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    /// The bearer token this device authenticates to its machine with.
    ///
    /// Derived from the pairing secret rather than sent, exactly as
    /// `p12Passphrase` is, so the pairing exchange carries no extra field and
    /// nothing crosses that both sides cannot compute. The node stores only its
    /// SHA-256, so both sides must keep using the same label.
    ///
    /// This replaces the client certificate on the data path: iOS will not send
    /// one to a server whose certificate it did not itself anchor, and declines
    /// silently, which is unfixable from the app.
    static func deviceToken(secret: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(
            for: Data(deviceTokenLabel.utf8),
            using: SymmetricKey(data: Data(secret.utf8))
        )
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - CA pinning material (the QR's `f=` field)

    /// `sha256` over a certificate's SubjectPublicKeyInfo, base64url, unpadded.
    ///
    /// The SPKI and not the whole certificate: `relayd`'s `ensureServerCert`
    /// re-issues the leaf, and a node CA may be re-encoded, without the key
    /// changing. Hashing the certificate would invalidate a printed pairing
    /// code the first time either happened.
    static func spkiFingerprint(certificate: SecCertificate) -> String? {
        spkiFingerprint(certificateDER: SecCertificateCopyData(certificate) as Data)
    }

    static func spkiFingerprint(certificateDER: Data) -> String? {
        guard let spki = subjectPublicKeyInfoDER(certificateDER: certificateDER) else { return nil }
        return Data(SHA256.hash(data: spki)).base64URLEncodedString()
    }

    /// Extracts the `subjectPublicKeyInfo` element, tag and length included,
    /// out of an X.509 certificate's DER.
    ///
    /// Done by walking the DER rather than via `SecCertificateCopyKey` +
    /// `SecKeyCopyExternalRepresentation`: that pair hands back the *raw key*
    /// (PKCS#1 for RSA, an X9.63 point for EC), not the SubjectPublicKeyInfo
    /// the fingerprint is defined over, and reconstructing the ASN.1 wrapper
    /// needs a per-algorithm, per-size header table that silently produces the
    /// wrong hash for anything not in it. The walk is exact and key-agnostic.
    ///
    ///     Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signature }
    ///     TBSCertificate ::= SEQUENCE {
    ///         version [0] EXPLICIT OPTIONAL, serialNumber, signature,
    ///         issuer, validity, subject, subjectPublicKeyInfo, ... }
    static func subjectPublicKeyInfoDER(certificateDER: Data) -> Data? {
        let bytes = [UInt8](certificateDER)
        guard let certificate = derElement(bytes, at: 0), certificate.tag == 0x30,
              let tbs = derElement(bytes, at: certificate.contentStart), tbs.tag == 0x30 else {
            return nil
        }
        var cursor = tbs.contentStart
        guard let first = derElement(bytes, at: cursor) else { return nil }
        // [0] EXPLICIT version is optional; v1 certificates omit it.
        if first.tag == 0xA0 { cursor = first.end }
        // serialNumber, signature, issuer, validity, subject.
        for _ in 0..<5 {
            guard let element = derElement(bytes, at: cursor), element.end <= tbs.end else { return nil }
            cursor = element.end
        }
        guard let spki = derElement(bytes, at: cursor), spki.tag == 0x30, spki.end <= tbs.end else {
            return nil
        }
        return Data(bytes[spki.start..<spki.end])
    }

    /// Accepts every shape a fingerprint is plausibly pasted in — base64url
    /// (what the QR carries), padded base64, and hex with or without
    /// separators — and returns the one canonical base64url form everything
    /// else compares against. Anything that is not 32 bytes is rejected.
    static func normalizedFingerprint(_ raw: String) -> String? {
        let compact = raw
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ":", with: "")
            .replacingOccurrences(of: "\n", with: "")
        guard !compact.isEmpty else { return nil }

        if compact.count == 64, compact.allSatisfy(\.isHexDigit) {
            var bytes = Data()
            var index = compact.startIndex
            while index < compact.endIndex {
                let next = compact.index(index, offsetBy: 2)
                guard let byte = UInt8(compact[index..<next], radix: 16) else { return nil }
                bytes.append(byte)
                index = next
            }
            return bytes.base64URLEncodedString()
        }

        let padded = compact
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .padding(toLength: ((compact.count + 3) / 4) * 4, withPad: "=", startingAt: 0)
        guard let decoded = Data(base64Encoded: padded), decoded.count == 32 else { return nil }
        return decoded.base64URLEncodedString()
    }

    /// First certificate in a PEM bundle. `relayd` sends the node CA as PEM in
    /// the pairing response; tolerate a bundle and stray whitespace.
    static func certificate(fromPEM pem: String) -> SecCertificate? {
        let begin = "-----BEGIN CERTIFICATE-----"
        let end = "-----END CERTIFICATE-----"
        guard let start = pem.range(of: begin), let stop = pem.range(of: end, range: start.upperBound..<pem.endIndex) else {
            return nil
        }
        let body = pem[start.upperBound..<stop.lowerBound]
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()
        guard let der = Data(base64Encoded: body) else { return nil }
        return SecCertificateCreateWithData(nil, der as CFData)
    }

    private struct DERElement {
        let tag: UInt8
        let start: Int
        let contentStart: Int
        let end: Int
    }

    /// One DER TLV at `offset`. Single-byte tags and definite lengths only,
    /// which is all X.509 certificates use.
    private static func derElement(_ bytes: [UInt8], at offset: Int) -> DERElement? {
        guard offset >= 0, offset + 1 < bytes.count else { return nil }
        let tag = bytes[offset]
        // A multi-byte tag (low five bits all set) never appears in a
        // certificate's outer structure; refuse rather than mis-parse.
        guard tag & 0x1F != 0x1F else { return nil }

        let lengthByte = bytes[offset + 1]
        var contentStart = offset + 2
        var length = Int(lengthByte)
        if lengthByte & 0x80 != 0 {
            let count = Int(lengthByte & 0x7F)
            // Indefinite length (0x80) is illegal in DER; > 4 bytes is absurd here.
            guard count >= 1, count <= 4, offset + 2 + count <= bytes.count else { return nil }
            length = 0
            for i in 0..<count {
                length = (length << 8) | Int(bytes[offset + 2 + i])
            }
            contentStart = offset + 2 + count
        }
        let end = contentStart + length
        guard length >= 0, end <= bytes.count else { return nil }
        return DERElement(tag: tag, start: offset, contentStart: contentStart, end: end)
    }
}

extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Decodes base64url (unpadded or padded). Returns nil for anything that is
    /// not valid base64 once translated.
    init?(base64URLEncoded value: String) {
        let compact = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !compact.isEmpty else { return nil }
        let padded = compact
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .padding(toLength: ((compact.count + 3) / 4) * 4, withPad: "=", startingAt: 0)
        guard let decoded = Data(base64Encoded: padded) else { return nil }
        self = decoded
    }
}
