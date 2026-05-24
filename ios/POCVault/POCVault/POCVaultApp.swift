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

        _identityStore = StateObject(wrappedValue: identityStore)
        _libraryViewModel = StateObject(wrappedValue: LibraryViewModel(client: manifestClient))
        _codexViewModel = StateObject(wrappedValue: CodexConsoleViewModel(
            client: codexClient,
            provider: .codex,
            completionNotifier: codexNotificationService
        ))
        _claudeViewModel = StateObject(wrappedValue: CodexConsoleViewModel(
            client: codexClient,
            provider: .claude,
            completionNotifier: codexNotificationService
        ))
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
    @State private var selectedTab: RelayRootTab = .library

    var body: some View {
        TabView(selection: $selectedTab) {
            LibraryView(
                viewModel: libraryViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
            .tag(RelayRootTab.library)
            .tabItem {
                Label(RelayRootTab.library.title, systemImage: RelayRootTab.library.symbol)
            }

            CodexConsoleView(viewModel: codexViewModel, identityStore: identityStore)
                .tag(RelayRootTab.codex)
                .tabItem {
                    Label(RelayRootTab.codex.title, systemImage: RelayRootTab.codex.symbol)
                }

            CodexConsoleView(viewModel: claudeViewModel, identityStore: identityStore)
                .tag(RelayRootTab.claude)
                .tabItem {
                    Label(RelayRootTab.claude.title, systemImage: RelayRootTab.claude.symbol)
                }

            CodexStatusView(
                codexViewModel: codexViewModel,
                claudeViewModel: claudeViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
            .tag(RelayRootTab.status)
            .tabItem {
                Label(RelayRootTab.status.title, systemImage: RelayRootTab.status.symbol)
            }
        }
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
        .task {
            identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        }
        .task {
            guard shouldStartAgentMonitor else { return }
            await codexViewModel.monitorActiveWorkWhileAppIsOpen()
        }
        .task {
            guard shouldStartAgentMonitor else { return }
            await claudeViewModel.monitorActiveWorkWhileAppIsOpen()
        }
    }

    private var shouldStartAgentMonitor: Bool {
        CodexAgentMonitorPolicy.shouldStartAppMonitor(
            isRunningTests: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        )
    }
}

private enum RelayRootTab: String, CaseIterable, Identifiable {
    case library
    case codex
    case claude
    case status

    var id: String { rawValue }

    var title: String {
        switch self {
        case .library:
            return "Library"
        case .codex:
            return "Codex"
        case .claude:
            return "Claude"
        case .status:
            return "Status"
        }
    }

    var symbol: String {
        switch self {
        case .library:
            return "square.grid.2x2"
        case .codex:
            return "terminal"
        case .claude:
            return "asterisk"
        case .status:
            return "waveform.path.ecg"
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
            return AppTheme.textSecondary
        case .claude:
            return AppTheme.accent
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

                VStack(alignment: .leading, spacing: 0) {
                    Text("Status")
                        .font(.system(size: 26, weight: .medium, design: .serif))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 20)
                        .padding(.top, 16)
                        .padding(.bottom, 16)

                    HStack(spacing: 2) {
                        ForEach(StatusSection.allCases) { section in
                            Button {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    selectedSection = section
                                }
                            } label: {
                                Text(section.title)
                                    .font(.system(size: 14, weight: selectedSection == section ? .medium : .regular))
                                    .foregroundStyle(selectedSection == section ? AppTheme.textPrimary : AppTheme.textSecondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .background {
                                        if selectedSection == section {
                                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                                .fill(AppTheme.textPrimary.opacity(0.12))
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3)
                    .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)

                    switch selectedSection {
                    case .activity:
                        ScrollView {
                            VStack(alignment: .leading, spacing: 0) {
                                Text(summaryText)
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.textSecondary)
                                    .padding(.horizontal, 20)
                                    .padding(.bottom, 12)

                                LazyVStack(spacing: 0) {
                                    ForEach(Array(activityItems.prefix(24))) { activityItem in
                                        CodexActivityRow(provider: activityItem.provider, item: activityItem.item)
                                    }
                                }
                                .overlay(alignment: .top) {
                                    Rectangle()
                                        .fill(AppTheme.strokeSubtle)
                                        .frame(height: 0.5)
                                }
                            }
                            .padding(.bottom, 110)
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
            return "\(activityItems.count) threads · Codex and Claude"
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
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "message")
                .font(.system(size: 15))
                .foregroundStyle(AppTheme.textSecondary)
                .frame(width: 32, height: 32)
                .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))

            VStack(alignment: .leading, spacing: 5) {
                Text(item.title)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 7) {
                    Text("\(item.workspaceLabel) · \(timestampText)")
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.textSecondary)
                    Text(provider.displayName)
                        .font(.system(size: 11))
                        .foregroundStyle(provider == .claude ? AppTheme.accent : AppTheme.textSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background((provider == .claude ? AppTheme.accent : AppTheme.textPrimary).opacity(provider == .claude ? 0.14 : 0.08), in: Capsule())
                    HStack(spacing: 3) {
                        Image(systemName: statusSymbol)
                            .font(.system(size: 11, weight: .semibold))
                        Text(item.status?.label ?? "Thread")
                            .font(.system(size: 11))
                    }
                    .foregroundStyle(statusColor)
                }
                .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(AppTheme.strokeSubtle)
                .frame(height: 0.5)
                .padding(.leading, 62)
        }
    }

    private var statusSymbol: String {
        guard let status = item.status else { return item.isActive ? "clock" : "checkmark" }
        switch status {
        case .succeeded:
            return "checkmark"
        case .queued, .running, .canceling:
            return "clock"
        default:
            return "exclamationmark"
        }
    }

    private var timestampText: String {
        guard let updatedAt = item.updatedAt else { return "" }
        return Self.relativeFormatter.localizedString(for: updatedAt, relativeTo: Date())
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
    static let bgCanvas = Color(hex: 0x1A1917)
    static let bgSurface = warmText.opacity(0.06)
    static let bgSurfaceHi = Color(hex: 0x232220)
    static let threadPreviewBackground = Color(hex: 0x272522)
    static let strokeSubtle = warmText.opacity(0.07)
    static let strokeStrong = warmText.opacity(0.07)
    static let textPrimary = warmText
    static let textSecondary = warmText.opacity(0.45)
    static let textTertiary = warmText.opacity(0.27)
    static let inactiveTab = warmText.opacity(0.38)
    static let accent = Color(hex: 0xD4804A)
    static let statusOK = Color(hex: 0x32D74B)
    static let statusWarn = Color(hex: 0xFF9F0A)
    static let statusError = statusWarn
    static let statusInfo = textSecondary
    static let statusNeutral = textTertiary

    private static let warmText = Color(hex: 0xEDE8DF)

}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0
        )
    }
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
