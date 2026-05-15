import Combine
import Foundation
import Security

enum ClientIdentityStoreError: Error, LocalizedError {
    case supportFileMissing(URL)
    case p12ImportFailed(OSStatus)
    case p12ContainsNoIdentity
    case keychainAddFailed(OSStatus)
    case keychainReadFailed(OSStatus)

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
        }
    }
}

final class ClientIdentityStore: ObservableObject {
    static let supportDirectoryName = "support"
    static let defaultP12Name = "client.p12"

    @Published private(set) var lastImportedCertificateName: String?

    private let defaults: UserDefaults
    private let persistentRefKey = "com.example.pocvault.identity.persistentRef"
    private var cachedIdentity: SecIdentity?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
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
    func importIdentity(from url: URL, passphrase: String) throws -> URLCredential {
        let data = try Data(contentsOf: url)
        let identity = try Self.identity(fromPKCS12: data, passphrase: passphrase)
        try save(identity: identity, label: url.deletingPathExtension().lastPathComponent)
        cachedIdentity = identity
        lastImportedCertificateName = certificateCommonName(for: identity) ?? url.lastPathComponent
        return URLCredential(identity: identity, certificates: nil, persistence: .forSession)
    }

    func credential() -> URLCredential? {
        guard let identity = identity() else { return nil }
        return URLCredential(identity: identity, certificates: nil, persistence: .forSession)
    }

    func identity() -> SecIdentity? {
        if let cachedIdentity {
            return cachedIdentity
        }

        guard let persistentRef = defaults.data(forKey: persistentRefKey) else {
            return nil
        }

        let query: [String: Any] = [
            kSecValuePersistentRef as String: persistentRef,
            kSecReturnRef as String: true
        ]

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else {
            return nil
        }

        cachedIdentity = (item as! SecIdentity)
        return cachedIdentity
    }

    var hasStoredIdentity: Bool {
        identity() != nil
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

    private static func identity(fromPKCS12 data: Data, passphrase: String) throws -> SecIdentity {
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

        return identityValue as! SecIdentity
    }
}
