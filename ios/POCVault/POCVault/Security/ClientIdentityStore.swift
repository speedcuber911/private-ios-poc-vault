import Combine
import Foundation
import Security

enum ClientIdentityStoreError: Error, LocalizedError {
    case supportFileMissing(URL)
    case p12ImportFailed(OSStatus)
    case p12ContainsNoIdentity
    case keychainAddFailed(OSStatus)
    case keychainReadFailed(OSStatus)
    case keychainDeleteFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case .supportFileMissing(let url):
            return "No client certificate was found at \(url.path)."
        case .p12ImportFailed(let status):
            return "The .p12 file could not be imported. OSStatus \(status)."
        case .p12ContainsNoIdentity:
            return "The .p12 file did not include a client identity."
        case .keychainAddFailed(let status):
            return "The client identity could not be saved to Keychain. OSStatus \(status)."
        case .keychainReadFailed(let status):
            return "The client identity could not be read from Keychain. OSStatus \(status)."
        case .keychainDeleteFailed(let status):
            return "The client identity could not be removed from Keychain. OSStatus \(status)."
        }
    }
}

final class ClientIdentityStore: ObservableObject {
    static let supportDirectoryName = "support"
    static let defaultP12Name = "client.p12"
    /// Common names this app will adopt an already-installed keychain identity
    /// under, when the persistent reference that normally locates it is gone
    /// (restore to a new device, app reinstall).
    ///
    /// "trial-device" is the CN a trial machine issues — see
    /// `product/relayd/src/trialpair.mjs`, which signs the device CSR with
    /// `-subj "/CN=trial-device"`. Without it here, a trial identity sitting in
    /// the keychain could never be recovered, and the trial cannot simply be
    /// re-run: the pairing slots are put-once and the account gets one trial
    /// for its lifetime.
    private static let preferredClientCertificateNames = ["iphone", "trial-device"]

    @Published private(set) var lastImportedCertificateName: String?

    private let defaults: UserDefaults
    private let persistentRefKey = "com.parikshit.pocvault.identity.persistentRef"
    /// DER of the node CA extracted from a trial PKCS#12, plus the single host it
    /// may be pinned for and a marker that the stored identity is trial-issued.
    /// A CA certificate is public material — no secret is persisted here.
    private let pinnedCAKey = "com.parikshit.pocvault.identity.pinnedCA"
    private let pinnedHostKey = "com.parikshit.pocvault.identity.pinnedHost"
    private let trialIssuedKey = "com.parikshit.pocvault.identity.trialIssued"
    private let deviceTokenKey = "com.parikshit.pocvault.identity.deviceToken"
    private let deviceTokenHostKey = "com.parikshit.pocvault.identity.deviceTokenHost"
    private var cachedIdentity: SecIdentity?
    private var cachedPinnedCA: SecCertificate?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    static func resolvedImportPassphrase(
        explicitPassphrase: String,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> String {
        let explicit = explicitPassphrase.trimmingCharacters(in: .whitespacesAndNewlines)
        if !explicit.isEmpty {
            return explicit
        }

        return environment["POC_VAULT_P12_PASSPHRASE"]?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    static func isPreferredClientCertificateName(_ name: String?) -> Bool {
        guard let normalizedName = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !normalizedName.isEmpty else {
            return false
        }
        return preferredClientCertificateNames.contains(normalizedName)
    }

    /// Diagnostic-only summary of the identity that would be offered to a
    /// server, as `subjectCN|issuer`. A trial machine advertises exactly one
    /// acceptable client CA, so the issuer here is what decides whether iOS can
    /// satisfy that request at all — and it is not otherwise recoverable from
    /// the device, because the identity lives in the keychain rather than the
    /// app container. Never includes key material.
    var storedIdentityDescription: String {
        guard let identity = identity() else { return "none" }
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess,
              let certificate else {
            return "identity-without-certificate"
        }
        let subject = certificateCommonName(for: identity) ?? "?"
        // iOS exposes no readable issuer string, but the question is not what
        // the issuer is called — it is whether it is the CA this machine
        // advertises as its only acceptable client CA. The pinned CA came from
        // the same PKCS#12 as this identity, so comparing the identity's
        // normalized issuer against the pinned CA's normalized subject answers
        // it exactly, with no string parsing.
        let issuerDER = SecCertificateCopyNormalizedIssuerSequence(certificate) as Data?
        let pinnedSubjectDER = pinnedCACertificate
            .flatMap { SecCertificateCopyNormalizedSubjectSequence($0) as Data? }
        let issuedByPinnedCA: String
        switch (issuerDER, pinnedSubjectDER) {
        case (nil, _): issuedByPinnedCA = "unknown-issuer"
        case (_, nil): issuedByPinnedCA = "no-pinned-ca"
        case let (issuer?, pinned?): issuedByPinnedCA = issuer == pinned ? "yes" : "NO"
        }
        // Whether the private key can actually SIGN, not merely whether the
        // identity exists.
        //
        // A client certificate is only sent if the TLS stack can produce a
        // CertificateVerify with its key. If the key is missing from the
        // keychain or unusable, iOS abandons the handshake without sending
        // anything — which is what the machine observes: it records no failed
        // handshake at all, while the phone reports "requires a client
        // certificate". An identity that looks complete can still fail here,
        // so it is checked directly rather than assumed.
        var signable = "no-key"
        if let key = { () -> SecKey? in
            var k: SecKey?
            return SecIdentityCopyPrivateKey(identity, &k) == errSecSuccess ? k : nil
        }() {
            var signError: Unmanaged<CFError>?
            let probe = Data("relay-key-usability-probe".utf8) as CFData
            let algorithm: SecKeyAlgorithm = .ecdsaSignatureMessageX962SHA256
            if SecKeyIsAlgorithmSupported(key, .sign, algorithm) {
                signable = SecKeyCreateSignature(key, algorithm, probe, &signError) != nil
                    ? "yes"
                    : "FAILED(\((signError?.takeRetainedValue() as Error?).map { ($0 as NSError).code.description } ?? "?"))"
            } else {
                signable = "algorithm-unsupported"
            }
        }
        return "\(subject)|issuedByPinnedCA=\(issuedByPinnedCA)|canSign=\(signable)"
    }

    var supportDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(Self.supportDirectoryName, isDirectory: true)
    }

    var expectedSupportP12URL: URL {
        supportDirectory.appendingPathComponent(Self.defaultP12Name, isDirectory: false)
    }

    var supportConfigURL: URL {
        supportDirectory.appendingPathComponent("vault-config.json", isDirectory: false)
    }

    @discardableResult
    func ensureSupportDirectoryExists() -> Bool {
        do {
            try FileManager.default.createDirectory(
                at: supportDirectory,
                withIntermediateDirectories: true
            )
            return true
        } catch {
            return FileManager.default.fileExists(atPath: supportDirectory.path)
        }
    }

    func supportP12Candidates() -> [URL] {
        guard let urls = try? FileManager.default.contentsOfDirectory(
            at: supportDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }

        return urls
            .filter { $0.pathExtension.localizedCaseInsensitiveCompare("p12") == .orderedSame }
            .sorted { $0.lastPathComponent.localizedCaseInsensitiveCompare($1.lastPathComponent) == .orderedAscending }
    }

    @discardableResult
    func importIdentityFromSupport(
        named fileName: String = defaultP12Name,
        passphrase: String
    ) throws -> URLCredential {
        let url = supportDirectory.appendingPathComponent(fileName, isDirectory: false)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw ClientIdentityStoreError.supportFileMissing(url)
        }
        return try importIdentity(from: url, passphrase: passphrase)
    }

    @discardableResult
    func importIdentityFromSetupEnvironmentIfNeeded() -> Bool {
        let setupPassphrase = Self.resolvedImportPassphrase(explicitPassphrase: "")
        CodexDiagnostics.log("identity_setup_import_check", fields: [
            "hasPassphrase": String(!setupPassphrase.isEmpty),
            "hasStoredIdentity": String(hasStoredIdentity),
            "supportP12Exists": String(FileManager.default.fileExists(atPath: expectedSupportP12URL.path))
        ])
        guard
            !setupPassphrase.isEmpty,
            FileManager.default.fileExists(atPath: expectedSupportP12URL.path)
        else {
            CodexDiagnostics.log("identity_setup_import_skipped")
            return false
        }

        do {
            try importIdentityFromSupport(passphrase: setupPassphrase)
            CodexDiagnostics.log("identity_setup_import_success", fields: [
                "hasStoredIdentity": String(hasStoredIdentity),
                "certificateName": lastImportedCertificateName ?? ""
            ])
            return true
        } catch {
            let nsError = error as NSError
            CodexDiagnostics.log("identity_setup_import_failed", fields: [
                "domain": nsError.domain,
                "code": String(nsError.code),
                "description": error.localizedDescription
            ])
            return false
        }
    }

    /// BYO / support-directory import. Nothing is pinned: a personal install is
    /// fronted by a publicly-trusted certificate and its PKCS#12 carries no CA.
    @discardableResult
    func importIdentity(from url: URL, passphrase: String) throws -> URLCredential {
        try importIdentity(from: url, passphrase: passphrase, trialHost: nil)
    }

    /// Trial import. `trialHost` is the SNI hostname the machine answers on; when
    /// it is supplied the node CA found in the PKCS#12 is persisted and pinned to
    /// that one host, and the identity is marked trial-issued so sign-out can
    /// purge it without touching a BYO identity the user imported themselves.
    @discardableResult
    func importIdentity(from url: URL, passphrase: String, trialHost: String?) throws -> URLCredential {
        let data = try Data(contentsOf: url)
        let imported = try Self.importPKCS12(data, passphrase: passphrase)
        try save(identity: imported.identity, label: url.deletingPathExtension().lastPathComponent)
        // The issuing CA goes into the keychain alongside the identity, not
        // only into defaults for pinning.
        //
        // A machine names one acceptable client CA in its certificate request,
        // and iOS sends a certificate only when it can build a chain from the
        // leaf to one of those names. With the CA absent from the keychain
        // there is no chain to build: iOS declined silently, sent nothing, and
        // the connection failed as -1206 while the machine logged no handshake
        // error at all — because none reached it. A certificate minted from
        // the same CA, with that CA available locally, authenticated to the
        // same machine and returned 200.
        saveCACertificate(imported.caCertificate)
        cachedIdentity = imported.identity
        lastImportedCertificateName = certificateCommonName(for: imported.identity) ?? url.lastPathComponent
        pinTrialMaterial(caCertificate: imported.caCertificate, host: trialHost)
        return URLCredential(identity: imported.identity, certificates: nil, persistence: .forSession)
    }

    // MARK: - Pinned node CA (see RelayServerTrust)

    /// The node CA to evaluate `pinnedHost`'s TLS chain against, or nil when the
    /// app has never imported a trial identity.
    var pinnedCACertificate: SecCertificate? {
        if let cachedPinnedCA {
            return cachedPinnedCA
        }
        guard let der = defaults.data(forKey: pinnedCAKey),
              let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
            return nil
        }
        cachedPinnedCA = certificate
        return certificate
    }

    /// Stores the bearer token this device authenticates to `host` with, and
    /// the host it belongs to.
    ///
    /// Scoped to one host for the same reason the pinned CA is: a token left
    /// behind by an expired trial must never be offered to the next machine,
    /// or to a personal install. Cleared with the rest of the trial material.
    func storeDeviceToken(_ token: String, host: String?) {
        guard let host = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !host.isEmpty, !token.isEmpty else {
            return
        }
        defaults.set(token, forKey: deviceTokenKey)
        defaults.set(host, forKey: deviceTokenHostKey)
        CodexDiagnostics.log("identity_device_token_stored", fields: ["host": host])
    }

    /// The token for `host`, or nil when this device has none for it.
    func deviceToken(for host: String) -> String? {
        let wanted = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !wanted.isEmpty,
              let stored = defaults.string(forKey: deviceTokenHostKey)?.lowercased(),
              stored == wanted,
              let token = defaults.string(forKey: deviceTokenKey)?.trimmedNonEmpty else {
            return nil
        }
        return token
    }

    /// The single host `pinnedCACertificate` may be applied to.
    var pinnedHost: String? {
        defaults.string(forKey: pinnedHostKey)?.trimmedNonEmpty
    }

    /// True when the stored client identity came from a trial pairing rather than
    /// from a user-supplied PKCS#12.
    var hasTrialIssuedIdentity: Bool {
        defaults.bool(forKey: trialIssuedKey)
    }

    /// Sign-out purge: drops the trial-issued identity and the pinned node CA so
    /// the next account on this phone inherits neither a pointer to another
    /// account's machine nor a certificate that would authenticate to it. A BYO
    /// identity the user imported themselves is deliberately left in place.
    func discardTrialMaterial() {
        if hasTrialIssuedIdentity {
            try? deleteStoredIdentity()
        }
        clearPinnedMaterial()
    }

    /// Records the CA to pin and the one host it applies to. Called by the trial
    /// import path; internal so the persistence can be unit-tested without a
    /// PKCS#12 fixture. A nil/empty host means "not a trial import" and leaves
    /// every pinning key untouched — a BYO import can never start pinning.
    func pinTrialMaterial(caCertificate: SecCertificate?, host: String?) {
        guard let host = host?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !host.isEmpty else {
            return
        }
        defaults.set(true, forKey: trialIssuedKey)
        defaults.set(host, forKey: pinnedHostKey)
        guard let caCertificate else {
            // No CA in the blob: leave the app on default handling rather than
            // pinning something arbitrary. TLS to the machine will fail loudly.
            defaults.removeObject(forKey: pinnedCAKey)
            cachedPinnedCA = nil
            CodexDiagnostics.log("identity_trial_ca_missing")
            return
        }
        defaults.set(SecCertificateCopyData(caCertificate) as Data, forKey: pinnedCAKey)
        cachedPinnedCA = caCertificate
        CodexDiagnostics.log("identity_trial_ca_pinned", fields: ["host": host])
    }

    private func clearPinnedMaterial() {
        defaults.removeObject(forKey: trialIssuedKey)
        defaults.removeObject(forKey: pinnedHostKey)
        defaults.removeObject(forKey: pinnedCAKey)
        // The device token is machine access just as much as the identity is,
        // so it goes with the rest of the trial material — leaving it behind
        // would hand the next account on this phone a working credential.
        defaults.removeObject(forKey: deviceTokenKey)
        defaults.removeObject(forKey: deviceTokenHostKey)
        cachedPinnedCA = nil
    }

    /// The client credential, carrying the issuing CA alongside the identity
    /// when we hold one.
    ///
    /// The chain is not decoration. A machine names exactly one acceptable
    /// client CA in its certificate request, and iOS will only send a
    /// certificate it can show chains to one of those names — with the leaf
    /// alone and its issuer absent, it sends nothing and the connection fails
    /// as -1206 (`requires a client certificate`), which is distinct from the
    /// -1205 a server returns when it has seen a certificate and refused it.
    /// Observed exactly that against a trial machine: the challenge fired, the
    /// credential was supplied, and the machine still saw no certificate.
    ///
    /// `pinnedCACertificate` is that issuer — it arrives in the same PKCS#12 as
    /// the identity — so it is the right chain to present even now that the
    /// server certificate itself is publicly trusted and no longer pinned.
    func credential() -> URLCredential? {
        guard let identity = identity() else { return nil }
        let chain = pinnedCACertificate.map { [$0] }
        return URLCredential(identity: identity, certificates: chain, persistence: .forSession)
    }

    func identity() -> SecIdentity? {
        if let cachedIdentity {
            return cachedIdentity
        }

        if let persistentRef = defaults.data(forKey: persistentRefKey) {
            let query: [String: Any] = [
                kSecValuePersistentRef as String: persistentRef,
                kSecReturnRef as String: true
            ]

            var item: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &item)
            if status == errSecSuccess,
               let item,
               CFGetTypeID(item) == SecIdentityGetTypeID() {
                let identity = (item as! SecIdentity)
                cachedIdentity = identity
                return identity
            }

            defaults.removeObject(forKey: persistentRefKey)
        }

        return recoverExistingPreferredIdentity()
    }

    var hasStoredIdentity: Bool {
        identity() != nil
    }

    func deleteStoredIdentity() throws {
        if let persistentRef = defaults.data(forKey: persistentRefKey) {
            let status = SecItemDelete([
                kSecValuePersistentRef as String: persistentRef
            ] as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw ClientIdentityStoreError.keychainDeleteFailed(status)
            }
        }
        defaults.removeObject(forKey: persistentRefKey)
        cachedIdentity = nil
        lastImportedCertificateName = nil
        // The pinned CA is only ever meaningful next to the identity it arrived
        // with, so a full identity purge takes it too.
        clearPinnedMaterial()
    }

    private func recoverExistingPreferredIdentity() -> SecIdentity? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassIdentity,
            kSecReturnRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let identities = item as? [SecIdentity] else {
            return nil
        }

        for identity in identities {
            let commonName = certificateCommonName(for: identity)
            guard Self.isPreferredClientCertificateName(commonName),
                  let persistentRef = try? persistentRef(for: identity) else {
                continue
            }

            defaults.set(persistentRef, forKey: persistentRefKey)
            cachedIdentity = identity
            lastImportedCertificateName = commonName
            return identity
        }

        return nil
    }

    /// Adds the issuing CA to the keychain so iOS can chain the client
    /// certificate to it. Best effort: a duplicate is success, and any other
    /// failure leaves the identity usable for servers that ask for no
    /// particular issuer, so it must not abort the import.
    private func saveCACertificate(_ certificate: SecCertificate?) {
        guard let certificate else {
            CodexDiagnostics.log("identity_ca_keychain", fields: ["stored": "false", "reason": "absent"])
            return
        }
        let status = SecItemAdd([
            kSecClass as String: kSecClassCertificate,
            kSecValueRef as String: certificate,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ] as CFDictionary, nil)
        CodexDiagnostics.log("identity_ca_keychain", fields: [
            "stored": String(status == errSecSuccess || status == errSecDuplicateItem),
            "status": String(status)
        ])
    }

    private func save(identity: SecIdentity, label: String) throws {
        let certificateName = certificateCommonName(for: identity) ?? label
        let addQuery: [String: Any] = [
            kSecValueRef as String: identity,
            kSecAttrLabel as String: certificateName,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecReturnPersistentRef as String: true
        ]

        var item: CFTypeRef?
        let status = SecItemAdd(addQuery as CFDictionary, &item)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw ClientIdentityStoreError.keychainAddFailed(status)
        }

        if let persistentRef = item as? Data {
            defaults.set(persistentRef, forKey: persistentRefKey)
        } else if status == errSecDuplicateItem {
            defaults.set(try existingPersistentRef(matching: identity), forKey: persistentRefKey)
        }
    }

    private func existingPersistentRef(matching identity: SecIdentity) throws -> Data {
        let importedCertificateData = try certificateData(for: identity)
        let query: [String: Any] = [
            kSecClass as String: kSecClassIdentity,
            kSecReturnRef as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else {
            throw ClientIdentityStoreError.keychainReadFailed(status)
        }

        let identities = item as? [SecIdentity] ?? []

        for candidate in identities where try certificateData(for: candidate) == importedCertificateData {
            return try persistentRef(for: candidate)
        }

        throw ClientIdentityStoreError.keychainReadFailed(errSecItemNotFound)
    }

    private func persistentRef(for identity: SecIdentity) throws -> Data {
        let query: [String: Any] = [
            kSecValueRef as String: identity,
            kSecReturnPersistentRef as String: true
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let persistentRef = item as? Data else {
            throw ClientIdentityStoreError.keychainReadFailed(status)
        }
        return persistentRef
    }

    private func certificateData(for identity: SecIdentity) throws -> Data {
        var certificate: SecCertificate?
        let status = SecIdentityCopyCertificate(identity, &certificate)
        guard status == errSecSuccess, let certificate else {
            throw ClientIdentityStoreError.keychainReadFailed(status)
        }
        return SecCertificateCopyData(certificate) as Data
    }

    private func certificateCommonName(for identity: SecIdentity) -> String? {
        var certificate: SecCertificate?
        guard SecIdentityCopyCertificate(identity, &certificate) == errSecSuccess, let certificate else {
            return nil
        }

        var commonName: CFString?
        guard SecCertificateCopyCommonName(certificate, &commonName) == errSecSuccess else {
            return nil
        }
        return commonName as String?
    }

    /// What a PKCS#12 blob yields: always an identity, plus the issuing CA when
    /// the blob carries one (a trial p12 is built with `-certfile <ca.pem>`; a
    /// BYO p12 usually is not, and a missing CA is never an error).
    struct ImportedPKCS12 {
        let identity: SecIdentity
        let caCertificate: SecCertificate?
    }

    static func importPKCS12(_ data: Data, passphrase: String) throws -> ImportedPKCS12 {
        let options = [kSecImportExportPassphrase as String: passphrase]
        var importedItems: CFArray?
        let status = SecPKCS12Import(data as CFData, options as CFDictionary, &importedItems)
        guard status == errSecSuccess else {
            throw ClientIdentityStoreError.p12ImportFailed(status)
        }

        guard
            let items = importedItems as? [[String: Any]],
            let firstItem = items.first,
            let identityValue = firstItem[kSecImportItemIdentity as String]
        else {
            throw ClientIdentityStoreError.p12ContainsNoIdentity
        }

        let identity = identityValue as! SecIdentity
        var leafCertificate: SecCertificate?
        let leafData: Data? = SecIdentityCopyCertificate(identity, &leafCertificate) == errSecSuccess
            ? leafCertificate.map { SecCertificateCopyData($0) as Data }
            : nil

        return ImportedPKCS12(
            identity: identity,
            caCertificate: caCertificate(
                in: certificateChain(in: firstItem),
                leafData: leafData
            )
        )
    }

    /// The certificate chain `SecPKCS12Import` returned, preferring the explicit
    /// chain and falling back to the trust object's chain.
    private static func certificateChain(in item: [String: Any]) -> [SecCertificate] {
        if let chain = item[kSecImportItemCertChain as String] as? [SecCertificate], !chain.isEmpty {
            return chain
        }
        guard let trustValue = item[kSecImportItemTrust as String],
              CFGetTypeID(trustValue as CFTypeRef) == SecTrustGetTypeID() else {
            return []
        }
        let trust = trustValue as! SecTrust
        return SecTrustCopyCertificateChain(trust) as? [SecCertificate] ?? []
    }

    /// Picks the node CA out of an imported chain: the self-signed entry that is
    /// not the identity's own leaf. Internal so the selection is unit-testable
    /// with fixture certificates (public material, no key involved).
    static func caCertificate(in chain: [SecCertificate], leafData: Data?) -> SecCertificate? {
        let candidates = chain.filter { SecCertificateCopyData($0) as Data != leafData }
        return candidates.first(where: isSelfSigned) ?? candidates.first
    }

    static func isSelfSigned(_ certificate: SecCertificate) -> Bool {
        guard let subject = SecCertificateCopyNormalizedSubjectSequence(certificate) as Data?,
              let issuer = SecCertificateCopyNormalizedIssuerSequence(certificate) as Data? else {
            return false
        }
        return subject == issuer
    }
}
