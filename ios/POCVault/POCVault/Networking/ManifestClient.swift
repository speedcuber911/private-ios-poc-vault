import CryptoKit
import Foundation

enum ManifestClientError: Error, LocalizedError {
    case httpFailure(Int)
    case missingSignaturePublicKey
    case invalidSignature
    case invalidSignatureEnvelope

    var errorDescription: String? {
        switch self {
        case .httpFailure(let statusCode):
            return "Manifest request failed with HTTP \(statusCode)."
        case .missingSignaturePublicKey:
            return "Manifest signature verification needs a trusted public key."
        case .invalidSignature:
            return "Manifest signature verification failed."
        case .invalidSignatureEnvelope:
            return "Manifest signature response is invalid."
        }
    }
}

private struct ManifestSignatureEnvelope: Decodable {
    let signature: String

    var signatureBytes: Data? {
        Data(base64URLEncoded: signature)
    }
}

final class ManifestClient: NSObject, URLSessionDelegate {
    let manifestURL: URL
    let signatureURL: URL
    let trustedPublicKeyRawRepresentation: Data?

    private let identityStore: ClientIdentityStore
    private lazy var session: URLSession = {
        URLSession(configuration: .ephemeral, delegate: self, delegateQueue: nil)
    }()

    init(
        manifestURL: URL,
        signatureURL: URL,
        identityStore: ClientIdentityStore,
        trustedPublicKeyRawRepresentation: Data?
    ) {
        self.manifestURL = manifestURL
        self.signatureURL = signatureURL
        self.identityStore = identityStore
        self.trustedPublicKeyRawRepresentation = trustedPublicKeyRawRepresentation
        super.init()
    }

    var hasTrustedPublicKey: Bool {
        trustedPublicKeyRawRepresentation != nil
    }

    func fetchManifest() async throws -> POCManifest {
        async let manifestBytes = fetchBytes(from: manifestURL)
        async let signatureBytes = fetchBytes(from: signatureURL)

        let (payload, signaturePayload) = try await (manifestBytes, signatureBytes)
        guard let trustedPublicKeyRawRepresentation else {
            throw ManifestClientError.missingSignaturePublicKey
        }
        let envelope = try JSONDecoder().decode(ManifestSignatureEnvelope.self, from: signaturePayload)
        guard let signature = envelope.signatureBytes else {
            throw ManifestClientError.invalidSignatureEnvelope
        }

        guard Self.verifySignature(
            payload: payload,
            signature: signature,
            publicKeyRawRepresentation: trustedPublicKeyRawRepresentation
        ) else {
            throw ManifestClientError.invalidSignature
        }

        return try POCManifest.decode(from: payload)
    }

    func fetchUnsignedManifestForDiagnostics() async throws -> POCManifest {
        try await POCManifest.decode(from: fetchBytes(from: manifestURL))
    }

    private func fetchBytes(from url: URL) async throws -> Data {
        let (data, response) = try await session.data(from: url)
        if let httpResponse = response as? HTTPURLResponse,
           !(200...299).contains(httpResponse.statusCode) {
            throw ManifestClientError.httpFailure(httpResponse.statusCode)
        }
        return data
    }

    static func verifySignature(
        payload: Data,
        signature: Data,
        publicKeyRawRepresentation: Data
    ) -> Bool {
        do {
            let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation: publicKeyRawRepresentation)
            return publicKey.isValidSignature(signature, for: payload)
        } catch {
            return false
        }
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        switch challenge.protectionSpace.authenticationMethod {
        case NSURLAuthenticationMethodClientCertificate:
            if let credential = identityStore.credential() {
                completionHandler(.useCredential, credential)
            } else {
                completionHandler(.performDefaultHandling, nil)
            }
        default:
            completionHandler(.performDefaultHandling, nil)
        }
    }
}

private extension Data {
    init?(base64URLEncoded value: String) {
        let padded = value
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .padding(toLength: ((value.count + 3) / 4) * 4, withPad: "=", startingAt: 0)
        self.init(base64Encoded: padded)
    }
}
