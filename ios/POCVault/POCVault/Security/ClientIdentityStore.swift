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
    private static let preferredClientCertificateNames = ["iphone"]

    @Published private(set) var lastImportedCertificateName: String?

    private let defaults: UserDefaults
    private let persistentRefKey = "com.parikshit.pocvault.identity.persistentRef"
    /// DER of the node CA extracted from a trial PKCS#12, plus the single host it
    /// may be pinned for and a marker that the stored identity is trial-issued.
    /// A CA certificate is public material — no secret is persisted here.
    private let pinnedCAKey = "com.parikshit.pocvault.identity.pinnedCA"
    private let pinnedHostKey = "com.parikshit.pocvault.identity.pinnedHost"
    private let trialIssuedKey = "com.parikshit.pocvault.identity.trialIssued"
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
        cachedPinnedCA = nil
    }

    func credential() -> URLCredential? {
        guard let identity = identity() else { return nil }
        return URLCredential(identity: identity, certificates: nil, persistence: .forSession)
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
