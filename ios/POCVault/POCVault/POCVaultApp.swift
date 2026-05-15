import SwiftUI

@main
struct POCVaultApp: App {
    @StateObject private var identityStore: ClientIdentityStore
    @StateObject private var libraryViewModel: LibraryViewModel
    private let manifestClient: ManifestClient

    init() {
        let identityStore = ClientIdentityStore()
        let manifestClient = ManifestClient(
            manifestURL: AppConfiguration.manifestURL,
            signatureURL: AppConfiguration.signatureURL,
            identityStore: identityStore,
            trustedPublicKeyRawRepresentation: AppConfiguration.trustedManifestPublicKey
        )

        _identityStore = StateObject(wrappedValue: identityStore)
        _libraryViewModel = StateObject(wrappedValue: LibraryViewModel(client: manifestClient))
        self.manifestClient = manifestClient
    }

    var body: some Scene {
        WindowGroup {
            LibraryView(
                viewModel: libraryViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
        }
    }
}

enum AppConfiguration {
#if targetEnvironment(simulator)
    static let manifestURL = URL(string: "http://127.0.0.1:8787/manifest.json")!
    static let signatureURL = URL(string: "http://127.0.0.1:8787/manifest.sig.json")!
    static let runtimeMode = "Simulator Preview"
#else
    static let manifestURL = configuredURL(
        supportValue: supportConfig?.manifestURL,
        infoKey: "POCVaultManifestURL",
        fallback: "https://vault.pocs.example.com/manifest.json"
    )
    static let signatureURL = configuredURL(
        supportValue: supportConfig?.signatureURL,
        infoKey: "POCVaultSignatureURL",
        fallback: "https://vault.pocs.example.com/manifest.sig.json"
    )
    static let runtimeMode = "Production Vault"
#endif

    static let trustedManifestPublicKey = Data([
        0xf9, 0xba, 0xb6, 0x22, 0xa2, 0xad, 0x92, 0xd2,
        0x27, 0xeb, 0x34, 0x4f, 0xfa, 0x99, 0x30, 0xb1,
        0xaa, 0xdf, 0x77, 0xee, 0xaf, 0xb6, 0xde, 0x82,
        0x50, 0xb5, 0xc1, 0x83, 0xfc, 0x77, 0x2c, 0xc6
    ])

    private static let supportConfig: SupportConfig? = {
        guard let documentsURL = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else {
            return nil
        }
        let configURL = documentsURL.appendingPathComponent("support/vault-config.json")
        guard let data = try? Data(contentsOf: configURL) else {
            return nil
        }
        return try? JSONDecoder().decode(SupportConfig.self, from: data)
    }()

    private static func configuredURL(supportValue: String?, infoKey: String, fallback: String) -> URL {
        let infoValue = Bundle.main.object(forInfoDictionaryKey: infoKey) as? String
        let value = [supportValue, infoValue]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty && !$0.contains("$(") } ?? fallback
        return URL(string: value) ?? URL(string: fallback)!
    }

    private struct SupportConfig: Decodable {
        let manifestURL: String?
        let signatureURL: String?
    }
}
