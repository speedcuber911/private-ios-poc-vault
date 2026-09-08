import CryptoKit
import Foundation
import Security

// MARK: - The QR payload

/// Everything `relayd pair` prints into its QR code.
///
/// The whole payload rides in the URL **fragment**, which no server and no
/// access log ever sees. A generic camera app shows a tappable universal link;
/// the in-app scanner reads the same string directly and never opens a browser.
struct RelayPairingInvite: Equatable {
    let nodeID: String
    let nodeName: String
    /// The pairing secret. Either the long token from the QR or, in manual
    /// entry, the short `XXXX-XXXX` code the user read off their terminal.
    let secret: String
    /// Where `POST /v1/pair` goes. In manual entry it is derived from the node
    /// URL the user typed.
    let pairEndpoint: URL
    /// Where the phone works after pairing. Frequently a bare IPv4/IPv6 literal
    /// with a non-standard port — a BYO node usually has no DNS name.
    let apiBaseURL: URL
    /// `sha256` over the node CA's SubjectPublicKeyInfo, base64url, unpadded.
    /// This is the pin: the QR came off the user's own terminal, so it is an
    /// out-of-band authenticated channel, and it is the only reason the phone
    /// can trust the very first TLS connection to a machine that signs its own
    /// certificates.
    let caFingerprint: String
}

enum RelayPairingInviteError: Error, Equatable {
    case empty
    case notAPairingCode
    case unsupportedVersion(String)
    case missingFields([String])
    case invalidURL(field: String)
    case invalidFingerprint

    var message: String {
        switch self {
        case .empty:
            return "Nothing to read. Scan the QR code from `relayd pair`, or paste the link it printed."
        case .notAPairingCode:
            return "That isn't a Relay pairing code. Run `relayd pair` on your machine and scan the QR code it prints."
        case .unsupportedVersion(let value):
            return "This pairing code is version \(value); this version of Relay understands version 1. Update the app."
        case .missingFields(let fields):
            return "That pairing code is incomplete — it is missing \(fields.joined(separator: ", ")). Run `relayd pair` again for a fresh one."
        case .invalidURL(let field):
            return "That pairing code carries an address Relay can't use (\(field)). Run `relayd pair` again for a fresh one."
        case .invalidFingerprint:
            return "That pairing code has no usable CA fingerprint, so Relay cannot verify your machine's certificate. Run `relayd pair` again with an up-to-date relayd."
        }
    }
}

extension RelayPairingInvite {
    /// Parses `…/pair#v=1&n=…&m=…&t=…&p=…&a=…&f=…`.
    ///
    /// Tolerant about how it arrives: the full universal link, the bare
    /// fragment, or the fragment with its leading `#`. Strict about what it
    /// must contain — in particular `f`, without which there is no pin and the
    /// first connection cannot be authenticated at all.
    static func parse(_ raw: String) throws -> RelayPairingInvite {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw RelayPairingInviteError.empty }

        var fragment = trimmed
        if let hash = trimmed.firstIndex(of: "#") {
            fragment = String(trimmed[trimmed.index(after: hash)...])
        }
        guard !fragment.isEmpty else { throw RelayPairingInviteError.notAPairingCode }

        var fields: [String: String] = [:]
        for pair in fragment.split(separator: "&") {
            let parts = pair.split(separator: "=", maxSplits: 1).map(String.init)
            guard parts.count == 2 else { continue }
            let key = parts[0].removingPercentEncoding ?? parts[0]
            let value = parts[1].removingPercentEncoding ?? parts[1]
            guard !key.isEmpty, !value.isEmpty else { continue }
            fields[key] = value
        }

        // Nothing recognisable at all reads better as "wrong kind of code" than
        // as a list of missing fields.
        guard fields["n"] != nil || fields["t"] != nil || fields["v"] != nil else {
            throw RelayPairingInviteError.notAPairingCode
        }
        if let version = fields["v"], version != "1" {
            throw RelayPairingInviteError.unsupportedVersion(version)
        }

        var missing: [String] = []
        if fields["n"]?.trimmedNonEmpty == nil { missing.append("the machine id") }
        if fields["t"]?.trimmedNonEmpty == nil { missing.append("the pairing token") }
        if fields["p"]?.trimmedNonEmpty == nil { missing.append("the pairing address") }
        if fields["a"]?.trimmedNonEmpty == nil { missing.append("the machine address") }
        if fields["f"]?.trimmedNonEmpty == nil { missing.append("the CA fingerprint") }
        guard missing.isEmpty else { throw RelayPairingInviteError.missingFields(missing) }

        guard let pairEndpoint = decodeURLField(fields["p"]!) else {
            throw RelayPairingInviteError.invalidURL(field: "the pairing address")
        }
        guard let apiBaseURL = decodeURLField(fields["a"]!) else {
            throw RelayPairingInviteError.invalidURL(field: "the machine address")
        }
        guard let fingerprint = RelayPairing.normalizedFingerprint(fields["f"]!) else {
            throw RelayPairingInviteError.invalidFingerprint
        }

        let nodeID = fields["n"]!
        return RelayPairingInvite(
            nodeID: nodeID,
            nodeName: fields["m"]?.trimmedNonEmpty ?? nodeID,
            secret: fields["t"]!,
            pairEndpoint: pairEndpoint,
            apiBaseURL: apiBaseURL,
            caFingerprint: fingerprint
        )
    }

    /// `p`/`a` are base64url-encoded URLs. A literal URL is accepted too, so a
    /// hand-assembled link still works.
    static func decodeURLField(_ value: String) -> URL? {
        if let data = Data(base64URLEncoded: value),
           let text = String(data: data, encoding: .utf8),
           let url = httpURL(text) {
            return url
        }
        return httpURL(value)
    }

    /// An http(s) URL with a host. `URL.host` unwraps IPv6 brackets, so
    /// `https://[fd00::1]:8443` yields `fd00::1` — the same string
    /// `URLAuthenticationChallenge` reports, which is what pinning compares.
    static func httpURL(_ text: String) -> URL? {
        guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host, !host.isEmpty else {
            return nil
        }
        return url
    }

    /// `POST /v1/pair` relative to a node URL the user typed, preserving any
    /// path prefix, the port, and IPv6 bracketing.
    static func defaultPairEndpoint(nodeURL: URL) -> URL? {
        guard var components = URLComponents(url: nodeURL, resolvingAgainstBaseURL: false) else { return nil }
        let base = components.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        components.path = "/" + [base, "v1/pair"].filter { !$0.isEmpty }.joined(separator: "/")
        components.query = nil
        components.fragment = nil
        return components.url
    }

    /// `relayd`'s confirmation-code alphabet (`pairing.mjs`): no `0`/`O` and no
    /// `1`/`I`.
    static let codeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

    /// Whether the user typed the confirmation code where the pairing token
    /// belongs — an easy mistake, since `relayd pair` prints both.
    ///
    /// Recognised locally so the answer is instant and costs nothing. The node
    /// makes the same shape test (`looksLikeVerificationCode`) and returns the
    /// same advice as a 400, but there is no reason to spend a round trip to
    /// be told something the phone can already see.
    static func looksLikeVerificationCode(_ value: String) -> Bool {
        let cleaned = value.uppercased().filter { $0.isLetter || $0.isNumber }
        return cleaned.count == 8 && cleaned.allSatisfy(codeAlphabet.contains)
    }

    /// The long pairing token, as printed next to the QR.
    ///
    /// Only the token is a credential. The confirmation code is eight
    /// characters from a 32-symbol alphabet — about 40 bits — and it is the MAC
    /// key for the whole exchange, so accepting it here would put every paired
    /// blob within offline brute-force reach of anyone who captured one. The
    /// node stopped matching it for exactly that reason; the phone does not
    /// offer it either.
    static func normalizeToken(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let tokenCharacters = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard trimmed.count >= 16,
              trimmed.unicodeScalars.allSatisfy(tokenCharacters.contains) else {
            return nil
        }
        return trimmed
    }
}

/// Why the typed-in form is not yet submittable. Each case names the one field
/// at fault, because "check your entries" is useless when three things could be
/// wrong and one of them is a 43-character string.
enum RelayManualEntryError: Error, Equatable {
    case missingNodeURL
    case invalidNodeURL
    case missingToken
    case verificationCodeInTokenField
    case invalidToken
    case missingFingerprint
    case invalidFingerprint

    var message: String {
        switch self {
        case .missingNodeURL:
            return "Enter your machine's address, for example https://192.168.1.20:8443."
        case .invalidNodeURL:
            return "That address isn't a URL Relay can reach. It needs a scheme and a host, like https://192.168.1.20:8443."
        case .missingToken:
            return "Paste the pairing token `relayd pair` printed."
        case .verificationCodeInTokenField:
            return "That's the confirmation code, not the pairing token. The code is the short one you compare afterwards; the token is the long string printed under the QR. Paste that instead — or just scan the QR."
        case .invalidToken:
            return "That doesn't look like a pairing token. It's the long string `relayd pair` prints under the QR code."
        case .missingFingerprint:
            return "Paste the CA fingerprint from `relayd pair`."
        case .invalidFingerprint:
            return "That fingerprint isn't a 32-byte SHA-256. Copy it from `relayd pair` or `relayd doctor`."
        }
    }
}

// MARK: - The exchange

/// What the node hands back, after its tag has been verified.
struct RelayNodePairingResult: Equatable {
    let deviceID: String
    let nodeID: String
    let nodeName: String
    let apiBaseURL: URL
    let p12: Data
    let caPEM: String
    let pubkeyPEM: String?
    let encPubkey: String?
    /// The short code the machine printed in the terminal, for the user to
    /// compare against. Deliberately absent from the QR: comparing a value the
    /// phone just read off the same QR would prove nothing.
    let verificationCode: String?
}

enum RelayNodePairingError: Error, Equatable {
    case unreachable(String)
    /// TLS was refused because the machine's chain did not terminate in the CA
    /// the QR pinned.
    case untrustedCertificate
    case codeRejected
    case rateLimited
    /// A 400, carrying the machine's own explanation when it sent one. The node
    /// answers a mistyped confirmation code here with specific advice, and
    /// relaying it verbatim beats inventing a vaguer version of it.
    case badRequest(String?)
    case server(status: Int)
    case malformedResponse
    /// The node's blob did not authenticate under the pairing secret.
    case tagMismatch
    /// The delivered CA is not the CA the QR pinned.
    case caFingerprintMismatch
    case identityImportFailed(String)

    /// True for the two failures that mean someone is between the phone and the
    /// machine, rather than something being merely broken. These are never
    /// retried automatically and are worded as what they are.
    var isSecurityEvent: Bool {
        switch self {
        case .tagMismatch, .caFingerprintMismatch, .untrustedCertificate:
            return true
        default:
            return false
        }
    }

    var message: String {
        switch self {
        case .unreachable(let detail):
            return "Relay couldn't reach your machine. Check that it's on the same network and that `relayd` is running. (\(detail))"
        case .untrustedCertificate:
            return "Your machine presented a TLS certificate that does not come from the certificate authority in the pairing code. Relay stopped before sending anything. Pair again from a fresh `relayd pair`, and if it happens twice, treat this network as hostile."
        case .codeRejected:
            return "That pairing code has already been used or has expired. Run `relayd pair` on your machine for a new one."
        case .rateLimited:
            return "Too many pairing attempts from here. Wait a few minutes, then try again."
        case .badRequest(let detail):
            if let detail = detail?.trimmedNonEmpty {
                return detail.prefix(1).uppercased() + detail.dropFirst() + "."
            }
            return "Your machine rejected the pairing request. Make sure `relayd` is up to date, then run `relayd pair` again."
        case .server(let status):
            return "Your machine returned an unexpected error (\(status)). Check `relayd` and try again."
        case .malformedResponse:
            return "Your machine sent a response Relay couldn't read. Make sure `relayd` is up to date."
        case .tagMismatch:
            return "The reply did not come from the machine that printed this code — its authentication tag is wrong. Relay installed nothing. Do not retry on this network; pair again somewhere you trust."
        case .caFingerprintMismatch:
            return "The certificate authority your machine delivered does not match the fingerprint in the pairing code. Relay installed nothing. Do not retry on this network; pair again somewhere you trust."
        case .identityImportFailed(let detail):
            return "Relay couldn't install the credential your machine issued. \(detail)"
        }
    }
}

/// The one first-contact request: `POST /v1/pair` on the node's pairing
/// listener.
///
/// The connection is TLS to a certificate iOS has never seen, so trust comes
/// from the QR rather than from the system store — see
/// `RelayPairingTrustDelegate`. Everything in the reply is then authenticated
/// again, at the application layer, by a MAC over the pairing secret; nothing
/// out of the response body is read, let alone installed, before that check
/// passes.
struct RelayNodePairingClient {
    var timeout: TimeInterval = 20
    /// Overridable so tests can drive the exchange without a live node.
    var makeSession: (RelayPairingTrustDelegate) -> URLSession = { delegate in
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        return URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    }

    func exchange(invite: RelayPairingInvite, deviceName: String) async throws -> RelayNodePairingResult {
        let macKey = RelayPairing.macKey(secret: invite.secret)
        let deviceBlob = try Self.deviceBlob(deviceName: deviceName)
        let deviceTag = RelayPairing.blobTag(macKey: macKey, slot: RelayPairing.deviceSlot, blob: deviceBlob)

        var request = URLRequest(url: invite.pairEndpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("no-store", forHTTPHeaderField: "Cache-Control")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "v": 2,
            "code": invite.secret,
            "blob": deviceBlob.base64EncodedString(),
            "tag": deviceTag
        ])

        let delegate = RelayPairingTrustDelegate(
            host: invite.pairEndpoint.host ?? "",
            expectedFingerprint: invite.caFingerprint
        )
        let session = makeSession(delegate)
        defer { session.finishTasksAndInvalidate() }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if delegate.rejectedTrust {
                throw RelayNodePairingError.untrustedCertificate
            }
            throw RelayNodePairingError.unreachable((error as NSError).localizedDescription)
        }

        guard let http = response as? HTTPURLResponse else {
            throw RelayNodePairingError.malformedResponse
        }
        switch http.statusCode {
        case 200..<300: break
        case 403: throw RelayNodePairingError.codeRejected
        case 429: throw RelayNodePairingError.rateLimited
        case 400: throw RelayNodePairingError.badRequest(Self.errorMessage(in: data))
        default: throw RelayNodePairingError.server(status: http.statusCode)
        }

        return try Self.decodeResponse(data, invite: invite, macKey: macKey)
    }

    /// `{"error": "..."}` — relayd's `sendError` shape.
    static func errorMessage(in data: Data) -> String? {
        struct Payload: Decodable { let error: String? }
        return (try? JSONDecoder().decode(Payload.self, from: data))?.error?.trimmedNonEmpty
    }

    /// The mint variant of the device blob. The phone has no CSR stack, so it
    /// asks the node to mint a PKCS#12 encrypted under a passphrase both sides
    /// derive from the pairing secret; no private key ever crosses.
    static func deviceBlob(deviceName: String) throws -> Data {
        let name = deviceName.trimmedNonEmpty ?? "iPhone"
        guard let data = try? JSONSerialization.data(
            withJSONObject: ["mint": "p12", "deviceName": name, "platform": "ios"],
            options: [.sortedKeys]
        ) else {
            throw RelayNodePairingError.malformedResponse
        }
        return data
    }

    /// Verifies before it reads. The tag check and the CA fingerprint check
    /// both happen ahead of any use of a field in the node blob, so a
    /// substituted response cannot steer the phone at a different machine, a
    /// different CA, or a different bearer scope.
    static func decodeResponse(
        _ data: Data,
        invite: RelayPairingInvite,
        macKey: SymmetricKey
    ) throws -> RelayNodePairingResult {
        struct Envelope: Decodable {
            let blob: String
            let tag: String
        }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data),
              let nodeBlob = Data(base64Encoded: envelope.blob) else {
            throw RelayNodePairingError.malformedResponse
        }
        guard RelayPairing.verifyTag(
            macKey: macKey,
            slot: RelayPairing.nodeSlot,
            blob: nodeBlob,
            tag: envelope.tag
        ) else {
            throw RelayNodePairingError.tagMismatch
        }

        struct NodeBlob: Decodable {
            let deviceId: String
            let p12: String
            let caPem: String
            let nodeId: String
            let nodeName: String?
            let apiBaseUrl: String?
            let pubkey: String?
            let encPubkey: String?
            let verificationCode: String?
        }
        guard let payload = try? JSONDecoder().decode(NodeBlob.self, from: nodeBlob),
              let p12 = Data(base64Encoded: payload.p12), !p12.isEmpty else {
            throw RelayNodePairingError.malformedResponse
        }

        guard let ca = RelayPairing.certificate(fromPEM: payload.caPem),
              let delivered = RelayPairing.spkiFingerprint(certificate: ca) else {
            throw RelayNodePairingError.malformedResponse
        }
        guard delivered == invite.caFingerprint else {
            throw RelayNodePairingError.caFingerprintMismatch
        }

        // The node's own answer wins over the QR's `a=` — it is authenticated
        // by the same MAC and it is the node that knows where it is reachable.
        // Manual entry has no `a=` at all beyond what the user typed.
        let apiBaseURL = payload.apiBaseUrl
            .flatMap(RelayPairingInvite.httpURL) ?? invite.apiBaseURL

        return RelayNodePairingResult(
            deviceID: payload.deviceId,
            nodeID: payload.nodeId,
            nodeName: payload.nodeName?.trimmedNonEmpty ?? invite.nodeName,
            apiBaseURL: apiBaseURL,
            p12: p12,
            caPEM: payload.caPem,
            pubkeyPEM: payload.pubkey?.trimmedNonEmpty,
            encPubkey: payload.encPubkey?.trimmedNonEmpty,
            verificationCode: payload.verificationCode?.trimmedNonEmpty
        )
    }
}

/// Server-trust policy for the pairing request, and only for it.
///
/// A BYO node signs its own certificate, so this connection reaches something
/// no system trust store knows. The two obvious answers are both wrong: plain
/// HTTP puts the pairing token on the wire for anyone listening, and disabling
/// validation ships an app that will talk to anything. The QR is itself an
/// out-of-band authenticated channel — a human read it off their own terminal —
/// so it carries the pin, and this delegate enforces it: the presented chain
/// must contain a certificate whose SubjectPublicKeyInfo hashes to `f`, that
/// certificate is then made the sole anchor, and the chain must validate
/// against it for this host. Anything else fails closed.
///
/// The CA is pinned rather than the leaf so `relayd`'s `ensureServerCert` can
/// rotate the server certificate without invalidating a printed code.
final class RelayPairingTrustDelegate: NSObject, URLSessionDelegate, @unchecked Sendable {
    private let host: String
    private let expectedFingerprint: String
    private let lock = NSLock()
    private var didRejectTrust = false

    init(host: String, expectedFingerprint: String) {
        self.host = host
        self.expectedFingerprint = expectedFingerprint
    }

    /// Whether a challenge was refused. `URLSession` reports a cancelled
    /// challenge as a generic cancellation, which is indistinguishable from the
    /// user backing out, so the reason is recorded here instead of inferred.
    var rejectedTrust: Bool {
        lock.lock()
        defer { lock.unlock() }
        return didRejectTrust
    }

    private func reject(_ completionHandler: (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        lock.lock()
        didRejectTrust = true
        lock.unlock()
        completionHandler(.cancelAuthenticationChallenge, nil)
    }

    func urlSession(
        _ session: URLSession,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
            // The pairing listener authenticates the caller with the code, not
            // with a client certificate. Offer nothing.
            completionHandler(.performDefaultHandling, nil)
            return
        }
        guard let trust = challenge.protectionSpace.serverTrust,
              challenge.protectionSpace.host.caseInsensitiveCompare(host) == .orderedSame else {
            reject(completionHandler)
            return
        }

        let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
        guard let anchor = chain.first(where: {
            RelayPairing.spkiFingerprint(certificate: $0) == expectedFingerprint
        }) else {
            reject(completionHandler)
            return
        }
        guard RelayServerTrust.evaluate(trust, host: host, anchor: anchor) else {
            reject(completionHandler)
            return
        }
        completionHandler(.useCredential, URLCredential(trust: trust))
    }
}

// MARK: - The screen's state machine

@MainActor
final class NodePairingModel: ObservableObject {
    enum Step: Equatable {
        case entry
        case pairing
        /// Terminal. The screen closes itself here: adopting the node flips
        /// `hasMachine` and the router replaces the whole onboarding stack, so
        /// there is no lifetime left to show anything in. What comes next —
        /// comparing the confirmation code — is presented from the root,
        /// driven by `RelayNodeStore`.
        case paired(nodeName: String)
        case failed(message: String, isSecurityEvent: Bool)
    }

    @Published private(set) var step: Step = .entry
    @Published var manualNodeURL = ""
    @Published var manualToken = ""
    @Published var manualFingerprint = ""
    @Published var cameraDenied = false
    /// Bumped to rebuild the capture session after a failure, so the camera is
    /// not left running behind an error screen.
    @Published private(set) var scanGeneration = 0

    private let identityStore: ClientIdentityStore
    private let nodeStore: RelayNodeStore
    private let accountStore: RelayAccountStore
    private let authClient: RelayAuthClient
    private let deviceName: String
    private let client: RelayNodePairingClient

    init(
        identityStore: ClientIdentityStore,
        nodeStore: RelayNodeStore,
        accountStore: RelayAccountStore,
        authClient: RelayAuthClient,
        deviceName: String,
        client: RelayNodePairingClient = RelayNodePairingClient()
    ) {
        self.identityStore = identityStore
        self.nodeStore = nodeStore
        self.accountStore = accountStore
        self.authClient = authClient
        self.deviceName = deviceName
        self.client = client
    }

    /// The first thing wrong with the typed-in form, or nil when it is ready.
    var manualEntryProblem: RelayManualEntryError? {
        if case .failure(let problem) = manualInvite() { return problem }
        return nil
    }

    var isManualEntryComplete: Bool { manualEntryProblem == nil }

    func submitScanned(_ raw: String) async {
        guard step == .entry else { return }
        do {
            try await pair(with: RelayPairingInvite.parse(raw))
        } catch let error as RelayPairingInviteError {
            fail(message: error.message, isSecurityEvent: false)
        } catch {
            fail(message: RelayNodePairingError.malformedResponse.message, isSecurityEvent: false)
        }
    }

    func submitManualEntry() async {
        switch manualInvite() {
        case .success(let invite):
            await pair(with: invite)
        case .failure(let problem):
            fail(message: problem.message, isSecurityEvent: false)
        }
    }

    func retry() {
        step = .entry
        scanGeneration &+= 1
    }

    /// Manual entry needs the fingerprint too.
    ///
    /// A typed token carries no pin, and the alternative — prompting the user
    /// to accept an unknown certificate — is the "tap to trust anything"
    /// dialog nobody reads. Asking for the fingerprint keeps the trust decision
    /// something the user can actually check: `relayd pair` prints it next to
    /// the token, and `relayd doctor` prints it again.
    private func manualInvite() -> Result<RelayPairingInvite, RelayManualEntryError> {
        guard manualNodeURL.trimmedNonEmpty != nil else { return .failure(.missingNodeURL) }
        guard let nodeURL = RelayPairingInvite.httpURL(manualNodeURL),
              let pairEndpoint = RelayPairingInvite.defaultPairEndpoint(nodeURL: nodeURL) else {
            return .failure(.invalidNodeURL)
        }
        guard manualToken.trimmedNonEmpty != nil else { return .failure(.missingToken) }
        guard !RelayPairingInvite.looksLikeVerificationCode(manualToken) else {
            return .failure(.verificationCodeInTokenField)
        }
        guard let token = RelayPairingInvite.normalizeToken(manualToken) else {
            return .failure(.invalidToken)
        }
        guard manualFingerprint.trimmedNonEmpty != nil else { return .failure(.missingFingerprint) }
        guard let fingerprint = RelayPairing.normalizedFingerprint(manualFingerprint) else {
            return .failure(.invalidFingerprint)
        }
        return .success(RelayPairingInvite(
            nodeID: "",
            nodeName: nodeURL.host ?? "Your machine",
            secret: token,
            pairEndpoint: pairEndpoint,
            apiBaseURL: nodeURL,
            caFingerprint: fingerprint
        ))
    }

    private func pair(with invite: RelayPairingInvite) async {
        step = .pairing
        do {
            let result = try await client.exchange(invite: invite, deviceName: deviceName)
            let node = try install(result, secret: invite.secret)
            // Registration runs before the terminal step, not after, because
            // `.paired` closes this screen. Its outcome is durable state that
            // Settings reports permanently ("Account: Not connected"), so
            // nothing is lost by not flashing it here.
            if accountStore.currentSessionToken != nil {
                _ = await RelayNodeRegistration.register(
                    node: node,
                    accountStore: accountStore,
                    nodeStore: nodeStore,
                    client: authClient
                )
            }
            step = .paired(nodeName: node.nodeName)
        } catch let error as RelayNodePairingError {
            fail(message: error.message, isSecurityEvent: error.isSecurityEvent)
        } catch {
            fail(message: RelayNodePairingError.identityImportFailed(error.localizedDescription).message, isSecurityEvent: false)
        }
    }

    /// Installs the credential, the pin and the bearer token, then points the
    /// app at the machine. Ordering matters: the token and the pin are in place
    /// before the node is adopted, so the very first request after adoption is
    /// already authenticated and already pinned.
    private func install(_ result: RelayNodePairingResult, secret: String) throws -> RelayPairedNode {
        guard let host = result.apiBaseURL.host, !host.isEmpty else {
            throw RelayNodePairingError.malformedResponse
        }
        let p12URL = try Self.writeTemporaryP12(result.p12)
        defer { try? FileManager.default.removeItem(at: p12URL) }

        do {
            // `caPem` has already been checked against the QR's pin, so it is
            // the certificate to trust — not whatever the PKCS#12 happens to
            // carry. Import without pinning, then pin the verified CA.
            _ = try identityStore.importIdentity(
                from: p12URL,
                passphrase: RelayPairing.p12Passphrase(secret: secret),
                pinnedHost: nil
            )
        } catch {
            let detail = (error as? ClientIdentityStoreError)?.errorDescription ?? error.localizedDescription
            throw RelayNodePairingError.identityImportFailed(detail)
        }
        identityStore.pinPairedMaterial(
            caCertificate: RelayPairing.certificate(fromPEM: result.caPEM),
            host: host
        )
        identityStore.storeDeviceToken(RelayPairing.deviceToken(secret: secret), host: host)

        let node = RelayPairedNode(
            nodeID: result.nodeID,
            nodeName: result.nodeName,
            apiBaseURL: result.apiBaseURL,
            deviceID: result.deviceID,
            pendingVerificationCode: result.verificationCode,
            pubkeyPEM: result.pubkeyPEM,
            encPubkey: result.encPubkey,
            registeredAccountID: nil
        )
        nodeStore.adopt(node)
        return node
    }

    private func fail(message: String, isSecurityEvent: Bool) {
        step = .failed(message: message, isSecurityEvent: isSecurityEvent)
    }

    private static func writeTemporaryP12(_ data: Data) throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-pair-\(UUID().uuidString)", isDirectory: false)
            .appendingPathExtension("p12")
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return url
    }
}
