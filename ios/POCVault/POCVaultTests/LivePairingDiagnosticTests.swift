import XCTest
@testable import POCVault

/// Drives the REAL pairing code against a REAL relayd, from the simulator.
///
/// Why this exists: every non-Apple client — curl, openssl, Node — completed the
/// pairing exchange against this node while the phone refused it. Server-side
/// verification therefore proved nothing about the only client that matters.
/// The simulator links the same Security.framework as the device, so it
/// reproduces Apple-specific trust rules (the 398-day server-certificate limit,
/// SecPolicyCreateSSL host matching, ATS) that nothing else enforces.
///
/// Skipped unless a live invite is supplied, so it never runs in CI:
///
///   relayd pair  ->  write the link to /private/tmp/relay-pair-link.txt
///
/// The value is single-use and expires in 15 minutes; mint a fresh one with
/// `relayd pair` for each run.
final class LivePairingDiagnosticTests: XCTestCase {

    /// Where the invite comes from.
    ///
    /// A file rather than an environment variable: `TEST_RUNNER_`-prefixed
    /// variables reach an XCUITest runner, but not a unit test launched from an
    /// `.xctestrun`, so the env route silently yields nil. The simulator shares
    /// the host filesystem, so a path under /private/tmp is simply readable.
    private static let invitePath = "/private/tmp/relay-pair-link.txt"

    private var link: String? {
        let fromEnv = ProcessInfo.processInfo.environment["RELAY_PAIR_LINK"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if let fromEnv, !fromEnv.isEmpty { return fromEnv }
        let fromFile = try? String(contentsOfFile: Self.invitePath, encoding: .utf8)
        let trimmed = fromFile?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (trimmed?.isEmpty == false) ? trimmed : nil
    }

    func testLiveInviteParses() throws {
        let link = try XCTUnwrap(self.link, "write a fresh `relayd pair` link to /private/tmp/relay-pair-link.txt to run this")
        let invite = try RelayPairingInvite.parse(link)
        print("DIAG parsed: node=\(invite.nodeID) pair=\(invite.pairEndpoint) api=\(invite.apiBaseURL) pin=\(invite.caFingerprint)")
        XCTAssertFalse(invite.caFingerprint.isEmpty)
    }

    /// The decisive one: does iOS complete the exchange?
    func testLivePairingExchange() async throws {
        let link = try XCTUnwrap(self.link, "write a fresh `relayd pair` link to /private/tmp/relay-pair-link.txt to run this")
        let invite = try RelayPairingInvite.parse(link)

        // Before the app's own client runs, ask Security.framework directly what
        // it thinks of this server, and print the CFError. That error string is
        // the whole point of the test: URLSession reports a refused challenge as
        // a generic cancellation, so the actual reason never reaches the UI.
        await Self.reportTrustEvaluation(for: invite)

        let client = RelayNodePairingClient()
        do {
            let result = try await client.exchange(invite: invite, deviceName: "simulator-diagnostic")
            print("DIAG exchange OK: deviceId=\(result.deviceID) code=\(result.verificationCode ?? "nil") api=\(result.apiBaseURL)")
            XCTAssertFalse(result.p12.isEmpty, "a mint pairing must return a PKCS12")
        } catch {
            XCTFail("DIAG exchange FAILED: \(error) — \((error as? RelayNodePairingError)?.message ?? "")")
        }
    }

    /// Isolates WHICH part of the trust handling kills the connection.
    ///
    /// The node reports `tlsClientError ECONNRESET` with no `secureConnection`,
    /// i.e. iOS hung up mid-handshake — even though the pinning delegate had
    /// already evaluated the chain and returned `.useCredential`. So the
    /// question is whether accepting the trust UNMODIFIED works where our
    /// anchor-pinned version does not.
    func testTrustVariants() async throws {
        let link = try XCTUnwrap(self.link, "write a fresh `relayd pair` link to /private/tmp/relay-pair-link.txt to run this")
        let invite = try RelayPairingInvite.parse(link)

        for variant in [TrustVariant.acceptAnything, .pinnedAnchorsOnly, .pinnedNoAnchorRestriction] {
            let probe = VariantProbe(host: invite.pairEndpoint.host ?? "", expected: invite.caFingerprint, variant: variant)
            let session = URLSession(configuration: .ephemeral, delegate: probe, delegateQueue: nil)
            var request = URLRequest(url: invite.pairEndpoint)
            request.httpMethod = "POST"
            request.httpBody = Data("{}".utf8)
            request.timeoutInterval = 15
            var outcome = "?"
            do {
                let (_, response) = try await session.data(for: request)
                outcome = "CONNECTED http=\((response as? HTTPURLResponse)?.statusCode ?? -1)"
            } catch {
                outcome = "FAILED \((error as NSError).code) \((error as NSError).localizedDescription)"
            }
            print("DIAGVARIANT \(variant): \(outcome) | \(probe.note)")
            session.invalidateAndCancel()
        }
    }

    enum TrustVariant: String, CustomStringConvertible {
        case acceptAnything            // no evaluation at all
        case pinnedAnchorsOnly         // what the app does today
        case pinnedNoAnchorRestriction // verify the pin, then accept without re-policying
        var description: String { rawValue }
    }

    private final class VariantProbe: NSObject, URLSessionDelegate, @unchecked Sendable {
        private let host: String
        private let expected: String
        private let variant: TrustVariant
        private let lock = NSLock()
        private var _note = ""
        init(host: String, expected: String, variant: TrustVariant) {
            self.host = host; self.expected = expected; self.variant = variant
        }
        var note: String { lock.lock(); defer { lock.unlock() }; return _note }
        private func set(_ t: String) { lock.lock(); _note = t; lock.unlock() }

        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let trust = challenge.protectionSpace.serverTrust else {
                completionHandler(.performDefaultHandling, nil); return
            }
            switch variant {
            case .acceptAnything:
                set("accepted without evaluating")
                completionHandler(.useCredential, URLCredential(trust: trust))
            case .pinnedNoAnchorRestriction:
                let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
                let ok = chain.contains { RelayPairing.spkiFingerprint(certificate: $0) == expected }
                set(ok ? "pin matched, accepted as-is" : "pin MISSING")
                completionHandler(ok ? .useCredential : .cancelAuthenticationChallenge, ok ? URLCredential(trust: trust) : nil)
            case .pinnedAnchorsOnly:
                let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
                guard let anchor = chain.first(where: { RelayPairing.spkiFingerprint(certificate: $0) == expected }) else {
                    set("pin MISSING"); completionHandler(.cancelAuthenticationChallenge, nil); return
                }
                _ = SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
                _ = SecTrustSetAnchorCertificatesOnly(trust, true)
                _ = SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
                var e: CFError?
                let ok = SecTrustEvaluateWithError(trust, &e)
                set(ok ? "anchored+evaluated OK" : "anchored eval FAILED \(e.map { String(describing: $0) } ?? "")")
                completionHandler(ok ? .useCredential : .cancelAuthenticationChallenge, ok ? URLCredential(trust: trust) : nil)
            }
        }
    }

    /// Connects with the app's pinning rules and prints exactly why trust passed
    /// or failed, including the underlying `SecTrustEvaluateWithError` message.
    private static func reportTrustEvaluation(for invite: RelayPairingInvite) async {
        guard let host = invite.pairEndpoint.host else {
            print("DIAG trust: no host in pair endpoint")
            return
        }
        let probe = TrustProbe(host: host, expected: invite.caFingerprint)
        let session = URLSession(configuration: .ephemeral, delegate: probe, delegateQueue: nil)
        var request = URLRequest(url: invite.pairEndpoint)
        request.httpMethod = "POST"
        request.httpBody = Data("{}".utf8)
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.timeoutInterval = 20
        do {
            let (_, response) = try await session.data(for: request)
            print("DIAG trust: connected, HTTP \((response as? HTTPURLResponse)?.statusCode ?? -1)")
        } catch {
            print("DIAG trust: transport error \(error)")
        }
        print("DIAG trust: \(probe.summary)")
        session.invalidateAndCancel()
    }

    /// A delegate that mirrors `RelayPairingTrustDelegate` but records the
    /// reason instead of only accepting or refusing.
    private final class TrustProbe: NSObject, URLSessionDelegate, @unchecked Sendable {
        private let host: String
        private let expected: String
        private let lock = NSLock()
        private var notes: [String] = []

        init(host: String, expected: String) {
            self.host = host
            self.expected = expected
        }

        var summary: String {
            lock.lock(); defer { lock.unlock() }
            return notes.isEmpty ? "(no server-trust challenge was issued)" : notes.joined(separator: " | ")
        }

        private func note(_ text: String) {
            lock.lock(); notes.append(text); lock.unlock()
        }

        func urlSession(
            _ session: URLSession,
            didReceive challenge: URLAuthenticationChallenge,
            completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
        ) {
            guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
                  let trust = challenge.protectionSpace.serverTrust else {
                completionHandler(.performDefaultHandling, nil)
                return
            }
            let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
            note("chain=\(chain.count)")
            let pins = chain.map { RelayPairing.spkiFingerprint(certificate: $0) ?? "?" }
            note("pins=\(pins.joined(separator: ","))")
            note("expected=\(expected)")

            guard let anchor = chain.first(where: { RelayPairing.spkiFingerprint(certificate: $0) == expected }) else {
                note("VERDICT: pinned CA not present in chain")
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }
            note("anchor found")

            // The same calls RelayServerTrust.evaluate makes, but keeping the error.
            _ = SecTrustSetAnchorCertificates(trust, [anchor] as CFArray)
            _ = SecTrustSetAnchorCertificatesOnly(trust, true)
            _ = SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString))
            var cfError: CFError?
            let ok = SecTrustEvaluateWithError(trust, &cfError)
            if ok {
                note("VERDICT: trust OK")
                completionHandler(.useCredential, URLCredential(trust: trust))
            } else {
                note("VERDICT: SecTrust REJECTED: \(cfError.map { String(describing: $0) } ?? "no error")")
                completionHandler(.cancelAuthenticationChallenge, nil)
            }
        }
    }
}
