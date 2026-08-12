import Foundation
import Security

/// Server-trust pinning for the one class of host whose TLS certificate does not
/// chain to a publicly-trusted root: a trial machine.
///
/// A trial machine is reached at `https://<nodeId>.tun.<domain>`, and the broker
/// in front of it is a TLS **passthrough** listener — it peeks the ClientHello,
/// routes on SNI, and never terminates TLS. The certificate the phone actually
/// validates is relayd's own, signed by that node's private CA, which no system
/// trust store contains. That CA already ships inside the PKCS#12 the phone
/// imports during pairing, so the app pins it — for that host and nothing else.
///
/// Every other host, above all the BYO/personal install fronted by a publicly
/// trusted certificate, keeps validating against the system trust store exactly
/// as before. Pinning is opt-in per host, never a global relaxation.
enum RelayServerTrust {
    enum Decision: Equatable {
        /// Evaluate the chain against the pinned node CA and nothing else.
        case pinned
        /// Hand the challenge back to the system trust store.
        case systemDefault
    }

    /// Pin only when the app holds a CA *and* the challenged host is exactly the
    /// host that CA was issued for. A pinned CA left behind by an expired trial
    /// must never be applied to the personal install.
    static func decision(challengeHost: String, pinnedHost: String?, hasPinnedCA: Bool) -> Decision {
        guard hasPinnedCA,
              let pinned = pinnedHost?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !pinned.isEmpty else {
            return .systemDefault
        }
        let host = challengeHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return host == pinned ? .pinned : .systemDefault
    }

    /// Evaluates `trust` against `anchor` alone, with hostname validation on
    /// (relayd's server certificate carries `SAN=DNS:<nodeId><suffix>`, which is
    /// the host the phone dials, so a correct certificate passes).
    ///
    /// Returns `false` on any failure. Callers must cancel rather than fall back
    /// to default handling: falling back would silently accept any
    /// publicly-trusted certificate issued for the pinned name.
    static func evaluate(_ trust: SecTrust, host: String, anchor: SecCertificate) -> Bool {
        guard SecTrustSetAnchorCertificates(trust, [anchor] as CFArray) == errSecSuccess,
              SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, host as CFString)) == errSecSuccess else {
            return false
        }
        return SecTrustEvaluateWithError(trust, nil)
    }

    /// Shared `NSURLAuthenticationMethodServerTrust` handling for every delegate
    /// (URLSession or WKWebView) that can be pointed at a trial machine.
    static func handleServerTrustChallenge(
        _ challenge: URLAuthenticationChallenge,
        identityStore: ClientIdentityStore,
        scope: String,
        completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
        let host = challenge.protectionSpace.host
        let pinnedCA = identityStore.pinnedCACertificate

        switch decision(
            challengeHost: host,
            pinnedHost: identityStore.pinnedHost,
            hasPinnedCA: pinnedCA != nil
        ) {
        case .systemDefault:
            CodexDiagnostics.log("codex_server_trust_challenge", fields: [
                "host": host,
                "scope": scope,
                "mode": "system"
            ])
            completionHandler(.performDefaultHandling, nil)

        case .pinned:
            guard let serverTrust = challenge.protectionSpace.serverTrust, let pinnedCA else {
                CodexDiagnostics.log("codex_server_trust_challenge", fields: [
                    "host": host,
                    "scope": scope,
                    "mode": "pinned",
                    "result": "unavailable"
                ])
                completionHandler(.cancelAuthenticationChallenge, nil)
                return
            }

            let isTrusted = evaluate(serverTrust, host: host, anchor: pinnedCA)
            CodexDiagnostics.log("codex_server_trust_challenge", fields: [
                "host": host,
                "scope": scope,
                "mode": "pinned",
                "result": isTrusted ? "trusted" : "rejected"
            ])
            completionHandler(
                isTrusted ? .useCredential : .cancelAuthenticationChallenge,
                isTrusted ? URLCredential(trust: serverTrust) : nil
            )
        }
    }
}
