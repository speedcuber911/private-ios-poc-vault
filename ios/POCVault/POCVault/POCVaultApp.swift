import SwiftUI

@main
struct POCVaultApp: App {
    @StateObject private var identityStore: ClientIdentityStore
    @StateObject private var libraryViewModel: LibraryViewModel
    @StateObject private var codexViewModel: CodexConsoleViewModel
    @StateObject private var claudeViewModel: CodexConsoleViewModel
    private let manifestClient: ManifestClient
    private let codexNotificationService: CodexLocalNotificationService

    init() {
        let identityStore = ClientIdentityStore()
        identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        let codexNotificationService = CodexLocalNotificationService()
        let manifestClient = ManifestClient(
            manifestURL: AppConfiguration.manifestURL,
            signatureURL: AppConfiguration.signatureURL,
            identityStore: identityStore,
            trustedPublicKeyRawRepresentation: AppConfiguration.trustedManifestPublicKey
        )
        let codexClient = CodexClient(
            baseURL: AppConfiguration.codexBaseURL,
            identityStore: identityStore
        )
        let codexViewModel = CodexConsoleViewModel(
            client: codexClient,
            provider: .codex,
            completionNotifier: codexNotificationService
        )
        let claudeViewModel = CodexConsoleViewModel(
            client: codexClient,
            provider: .claude,
            completionNotifier: codexNotificationService
        )
        codexNotificationService.setReplyHandler { reply in
            switch reply.provider {
            case .codex:
                _ = await codexViewModel.createNotificationReply(reply)
            case .claude:
                _ = await claudeViewModel.createNotificationReply(reply)
            }
        }

        _identityStore = StateObject(wrappedValue: identityStore)
        _libraryViewModel = StateObject(wrappedValue: LibraryViewModel(client: manifestClient))
        _codexViewModel = StateObject(wrappedValue: codexViewModel)
        _claudeViewModel = StateObject(wrappedValue: claudeViewModel)
        self.manifestClient = manifestClient
        self.codexNotificationService = codexNotificationService
    }

    var body: some Scene {
        WindowGroup {
            POCVaultRootView(
                libraryViewModel: libraryViewModel,
                codexViewModel: codexViewModel,
                claudeViewModel: claudeViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
        }
    }
}

struct POCVaultRootView: View {
    @ObservedObject var libraryViewModel: LibraryViewModel
    @ObservedObject var codexViewModel: CodexConsoleViewModel
    @ObservedObject var claudeViewModel: CodexConsoleViewModel
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient

    var body: some View {
        TabView {
            LibraryView(
                viewModel: libraryViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
            .tabItem {
                Label("Library", systemImage: "square.grid.2x2")
            }

            CodexConsoleView(viewModel: codexViewModel)
                .tabItem {
                    Label {
                        Text(CodexProvider.codex.displayName)
                    } icon: {
                        Image(CodexProvider.codex.tabIconAssetName)
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 24, height: 24)
                    }
                }

            CodexConsoleView(viewModel: claudeViewModel)
                .tabItem {
                    Label {
                        Text(CodexProvider.claude.displayName)
                    } icon: {
                        Image(CodexProvider.claude.tabIconAssetName)
                            .renderingMode(.template)
                            .resizable()
                            .scaledToFit()
                            .frame(width: 24, height: 24)
                    }
                }

            CodexStatusView(
                codexViewModel: codexViewModel,
                claudeViewModel: claudeViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
                .tabItem {
                    Label("Status", systemImage: "waveform.path.ecg")
                }
        }
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
        .task {
            identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        }
    }
}

extension CodexProvider {
    var tabIconAssetName: String {
        switch self {
        case .codex:
            return "ChatGPTMark"
        case .claude:
            return "ClaudeMark"
        }
    }

    var activityTint: Color {
        switch self {
        case .codex:
            return AppTheme.statusInfo
        case .claude:
            return AppTheme.statusWarn
        }
    }
}

private struct CodexStatusView: View {
    @ObservedObject var codexViewModel: CodexConsoleViewModel
    @ObservedObject var claudeViewModel: CodexConsoleViewModel
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient
    @State private var selectedSection = StatusSection.activity

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()

                VStack(spacing: 0) {
                    Picker("Status view", selection: $selectedSection) {
                        ForEach(StatusSection.allCases) { section in
                            Text(section.title).tag(section)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, AppTheme.screenHorizontalPadding)
                    .padding(.top, AppTheme.screenTopPadding)
                    .padding(.bottom, 12)

                    switch selectedSection {
                    case .activity:
                        ScrollView {
                            VStack(alignment: .leading, spacing: 18) {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text("Activity")
                                        .font(AppTheme.screenTitleFont)
                                        .foregroundStyle(AppTheme.textPrimary)
                                    Text(summaryText)
                                        .font(AppTheme.bodyFont)
                                        .foregroundStyle(AppTheme.textSecondary)
                                }

                                if activityItems.isEmpty {
                                    StatusEmptyState(
                                        symbol: "waveform.path.ecg",
                                        title: "No recent activity",
                                        message: "Runs from Codex and Claude will collect here after the first thread starts."
                                    )
                                } else {
                                    VStack(spacing: 10) {
                                        ForEach(Array(activityItems.prefix(24))) { activityItem in
                                            CodexActivityRow(provider: activityItem.provider, item: activityItem.item)
                                        }
                                    }
                                }
                            }
                            .padding(.horizontal, AppTheme.screenHorizontalPadding)
                            .padding(.bottom, AppTheme.tabBarClearance)
                        }
                        .scrollDismissesKeyboard(.interactively)
                    case .health:
                        DiagnosticsView(
                            identityStore: identityStore,
                            manifestClient: manifestClient,
                            showsNavigationChrome: false
                        )
                    }
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await refreshAll()
            }
            .task {
                await bootstrapAll()
            }
        }
    }

    private var activityItems: [ProviderActivityItem] {
        (
            codexViewModel.threadFeedItems.map { ProviderActivityItem(provider: .codex, item: $0) }
            + claudeViewModel.threadFeedItems.map { ProviderActivityItem(provider: .claude, item: $0) }
        )
        .sorted {
            ($0.item.updatedAt ?? .distantPast) > ($1.item.updatedAt ?? .distantPast)
        }
    }

    private var summaryText: String {
        let activeCount = activityItems.filter(\.item.isActive).count
        if activeCount == 0 {
            return "\(activityItems.count) recent threads across Codex and Claude"
        }
        return "\(activeCount) active · \(activityItems.count) recent"
    }

    private func bootstrapAll() async {
        async let codexBootstrap: Void = codexViewModel.bootstrapIfNeeded()
        async let claudeBootstrap: Void = claudeViewModel.bootstrapIfNeeded()
        _ = await (codexBootstrap, claudeBootstrap)
    }

    private func refreshAll() async {
        async let codexRefresh: Void = codexViewModel.refreshAll()
        async let claudeRefresh: Void = claudeViewModel.refreshAll()
        _ = await (codexRefresh, claudeRefresh)
    }
}

private enum StatusSection: String, CaseIterable, Identifiable {
    case activity
    case health

    var id: String { rawValue }

    var title: String {
        switch self {
        case .activity:
            return "Activity"
        case .health:
            return "Health"
        }
    }
}

private struct StatusEmptyState: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(AppTheme.accent)
            Text(title)
                .font(AppTheme.cardTitleFont)
                .foregroundStyle(AppTheme.textPrimary)
            Text(message)
                .font(AppTheme.bodyFont)
                .foregroundStyle(AppTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(AppTheme.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                .stroke(AppTheme.strokeSubtle, lineWidth: 1)
        }
    }
}

private struct ProviderActivityItem: Identifiable {
    let provider: CodexProvider
    let item: CodexThreadFeedItem

    var id: String {
        "\(provider.rawValue)-\(item.id)"
    }
}

private struct CodexActivityRow: View {
    let provider: CodexProvider
    let item: CodexThreadFeedItem

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: item.isActive ? "bolt.fill" : "bubble.left.and.bubble.right")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(statusColor)
                    .frame(width: 26, height: 26)
                    .background(AppTheme.bgSurfaceHi, in: Circle())

                VStack(alignment: .leading, spacing: 5) {
                    Text(item.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    Text(item.preview)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer(minLength: 8)

                VStack(alignment: .trailing, spacing: 6) {
                    Text(provider.displayName)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(provider.activityTint)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(provider.activityTint.opacity(0.12), in: Capsule())

                    Text(item.status?.label ?? "Thread")
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(statusColor)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 5)
                        .background(statusColor.opacity(0.12), in: Capsule())
                }
            }

            HStack(spacing: 8) {
                Text(item.workspaceLabel)
                Text(item.shortID)
                if let updatedAt = item.updatedAt {
                    Text(Self.relativeFormatter.localizedString(for: updatedAt, relativeTo: Date()))
                }
            }
            .font(.caption2.weight(.semibold))
            .foregroundStyle(AppTheme.textTertiary)
            .lineLimit(1)
        }
        .padding(14)
        .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: AppTheme.compactRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.compactRadius, style: .continuous)
                .stroke(AppTheme.strokeSubtle, lineWidth: 1)
        }
    }

    private var statusColor: Color {
        guard let status = item.status else { return AppTheme.statusInfo }
        switch status {
        case .queued, .running, .canceling:
            return AppTheme.statusWarn
        case .succeeded:
            return AppTheme.statusOK
        case .failed, .timeout:
            return AppTheme.statusError
        case .canceled, .unknown:
            return AppTheme.statusNeutral
        }
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

enum AppTheme {
    static let bgCanvas = Color(red: 0.055, green: 0.055, blue: 0.058)
    static let bgSurface = Color(red: 0.095, green: 0.096, blue: 0.102)
    static let bgSurfaceHi = Color(red: 0.145, green: 0.146, blue: 0.154)
    static let strokeSubtle = Color.white.opacity(0.07)
    static let strokeStrong = Color.white.opacity(0.14)
    static let textPrimary = Color.white.opacity(0.94)
    static let textSecondary = Color.white.opacity(0.62)
    static let textTertiary = Color.white.opacity(0.40)
    static let accent = Color(red: 0.86, green: 0.86, blue: 0.82)
    static let statusOK = Color(red: 0.58, green: 0.70, blue: 0.60)
    static let statusWarn = Color(red: 0.74, green: 0.64, blue: 0.42)
    static let statusError = Color(red: 0.78, green: 0.45, blue: 0.43)
    static let statusInfo = Color(red: 0.58, green: 0.64, blue: 0.72)
    static let statusNeutral = Color.white.opacity(0.46)

    static let screenHorizontalPadding: CGFloat = 20
    static let screenTopPadding: CGFloat = 14
    static let tabBarClearance: CGFloat = 126
    static let cardPadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
    static let compactRadius: CGFloat = 14
    static let controlRadius: CGFloat = 12
    static let iconButtonSize: CGFloat = 36
    static let touchTargetSize: CGFloat = 44

    static let screenTitleFont = Font.system(size: 28, weight: .semibold)
    static let panelTitleFont = Font.title2.weight(.semibold)
    static let sectionLabelFont = Font.caption.weight(.bold)
    static let bodyFont = Font.subheadline.weight(.medium)
    static let cardTitleFont = Font.subheadline.weight(.semibold)
    static let captionFont = Font.caption.weight(.medium)
}

enum AppConfiguration {
#if targetEnvironment(simulator)
    static let manifestURL = URL(string: "http://127.0.0.1:8787/manifest.json")!
    static let signatureURL = URL(string: "http://127.0.0.1:8787/manifest.sig.json")!
    static let codexBaseURL = configuredURL(
        supportValue: supportConfig?.codexBaseURL,
        infoKey: "POCVaultCodexBaseURL",
        fallback: "http://127.0.0.1:8787"
    )
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
    static let codexBaseURL = configuredURL(
        supportValue: supportConfig?.codexBaseURL,
        infoKey: "POCVaultCodexBaseURL",
        fallback: "https://codex.pocs.example.com"
    )
    static let runtimeMode = "Relay Cloud"
#endif

    static let trustedManifestPublicKey = configuredPublicKey(
        supportValue: supportConfig?.manifestPublicKey,
        infoKey: "POCVaultManifestPublicKey"
    ) ?? Data([
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

    private static func configuredPublicKey(supportValue: String?, infoKey: String) -> Data? {
        let infoValue = Bundle.main.object(forInfoDictionaryKey: infoKey) as? String
        return [supportValue, infoValue]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty && !$0.contains("$(") }
            .flatMap(rawPublicKeyData)
    }

    private static func rawPublicKeyData(from value: String) -> Data? {
        let compact = value
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: " ", with: "")
        if compact.count == 64,
           compact.allSatisfy({ $0.isHexDigit }) {
            var bytes = Data()
            var index = compact.startIndex
            while index < compact.endIndex {
                let next = compact.index(index, offsetBy: 2)
                guard let byte = UInt8(compact[index..<next], radix: 16) else { return nil }
                bytes.append(byte)
                index = next
            }
            return bytes.count == 32 ? bytes : nil
        }

        let padded = compact
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .padding(toLength: ((compact.count + 3) / 4) * 4, withPad: "=", startingAt: 0)
        guard let decoded = Data(base64Encoded: padded), decoded.count == 32 else {
            return nil
        }
        return decoded
    }

    private struct SupportConfig: Decodable {
        let manifestURL: String?
        let signatureURL: String?
        let codexBaseURL: String?
        let manifestPublicKey: String?
    }
}
