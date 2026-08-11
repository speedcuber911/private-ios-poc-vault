import SwiftUI

@main
struct POCVaultApp: App {
    @StateObject private var identityStore: ClientIdentityStore
    @StateObject private var libraryViewModel: LibraryViewModel
    @StateObject private var chatSessionStore: RelayChatSessionStore
    @StateObject private var statusFeedViewModel: StatusFeedViewModel
    @StateObject private var accountStore: RelayAccountStore
    private let manifestClient: ManifestClient
    private let codexClient: CodexClient

    init() {
        let identityStore = ClientIdentityStore()
        identityStore.importIdentityFromSetupEnvironmentIfNeeded()
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
        let accountStore = RelayAccountStore(
            client: RelayAuthClient(baseURL: AppConfiguration.authBaseURL),
            identityStore: identityStore
        )

        _identityStore = StateObject(wrappedValue: identityStore)
        _libraryViewModel = StateObject(wrappedValue: LibraryViewModel(client: manifestClient))
        _chatSessionStore = StateObject(wrappedValue: RelayChatSessionStore(
            client: codexClient,
            completionNotifier: CodexLocalNotificationService()
        ))
        _statusFeedViewModel = StateObject(wrappedValue: StatusFeedViewModel(client: codexClient))
        _accountStore = StateObject(wrappedValue: accountStore)
        self.manifestClient = manifestClient
        self.codexClient = codexClient
    }

    var body: some Scene {
        WindowGroup {
            Group {
                switch accountStore.phase {
                case .restoring:
                    RelayRestoringView()
                case .signedOut:
                    AuthenticationView(accountStore: accountStore)
                case .onboarding:
                    RelayOnboardingView(accountStore: accountStore)
                case .ready:
                    POCVaultRootView(
                        libraryViewModel: libraryViewModel,
                        statusFeedViewModel: statusFeedViewModel,
                        chatSessionStore: chatSessionStore,
                        accountStore: accountStore,
                        identityStore: identityStore,
                        manifestClient: manifestClient,
                        codexClient: codexClient
                    )
                }
            }
            .task {
                await accountStore.restore()
                #if DEBUG
                await applyAuthenticationUITestHooks()
                #endif
            }
        }
    }

    #if DEBUG
    private func applyAuthenticationUITestHooks() async {
        let env = ProcessInfo.processInfo.environment
        if accountStore.phase == .signedOut,
           let username = env["RELAY_UITEST_CREATE_USERNAME"]?.trimmedNonEmpty,
           let email = env["RELAY_UITEST_CREATE_EMAIL"]?.trimmedNonEmpty,
           let password = env["RELAY_UITEST_CREATE_PASSWORD"]?.trimmedNonEmpty {
            await accountStore.signUp(username: username, email: email, password: password)
        }
        if accountStore.phase == .onboarding,
           env["RELAY_UITEST_SKIP_ONBOARDING"] == "1" {
            accountStore.completeOnboarding()
        }
    }
    #endif
}

private struct RelayRestoringView: View {
    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()
            VStack(spacing: 18) {
                Image(systemName: "point.3.connected.trianglepath.dotted")
                    .font(.system(size: 36, weight: .medium))
                    .foregroundStyle(AppTheme.accentGradient)
                ProgressView()
                    .tint(AppTheme.accent)
                    .accessibilityLabel("Restoring Relay session")
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// Navigation routes of the root file browser stack.
enum BrowserRoute: Hashable {
    case folder(path: String)
    case file(entry: CodexWorkspaceDirectoryEntry)
}

struct POCVaultRootView: View {
    @ObservedObject var libraryViewModel: LibraryViewModel
    @ObservedObject var statusFeedViewModel: StatusFeedViewModel
    @ObservedObject var chatSessionStore: RelayChatSessionStore
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var identityStore: ClientIdentityStore
    let manifestClient: ManifestClient
    let codexClient: CodexClient

    @State private var browserPath: [BrowserRoute] = []
    @State private var chatLaunch: RelayChatLaunch?
    @State private var showingLibrary = false
    @State private var showingStatus = false
    @State private var showingDiagnostics = false
    @State private var showingAccount = false

    var body: some View {
        NavigationStack(path: $browserPath) {
            browserScreen(folderPath: nil, isRoot: true)
                .navigationDestination(for: BrowserRoute.self) { route in
                    switch route {
                    case .folder(let path):
                        browserScreen(folderPath: path, isRoot: false)
                    case .file(let entry):
                        FileViewerView(
                            client: codexClient,
                            identityStore: identityStore,
                            entry: entry
                        )
                    }
                }
        }
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
        // Library embeds its own NavigationStack, so it must present full screen — never
        // be pushed into the browser stack (nesting navigation stacks is illegal).
        .fullScreenCover(isPresented: $showingLibrary) {
            libraryCover
        }
        .fullScreenCover(item: $chatLaunch) { launch in
            RelayChatView(viewModel: launch.viewModel, onDismiss: { chatLaunch = nil })
        }
        .sheet(isPresented: $showingStatus) {
            CodexStatusView(
                feedViewModel: statusFeedViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
        }
        .sheet(isPresented: $showingDiagnostics) {
            DiagnosticsView(
                identityStore: identityStore,
                manifestClient: manifestClient
            )
        }
        .sheet(isPresented: $showingAccount) {
            AccountSettingsView(accountStore: accountStore)
        }
        .task {
            identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        }
        .task {
            // App-wide job monitor + completion notifications, owned by the session store.
            guard shouldStartAgentMonitor else { return }
            await chatSessionStore.monitorActiveWorkWhileAppIsOpen()
        }
        #if DEBUG
        .task {
            applyUITestHooks()
        }
        #endif
    }

    private func browserScreen(folderPath: String?, isRoot: Bool) -> some View {
        FileBrowserView(
            client: codexClient,
            folderPath: folderPath,
            isRoot: isRoot,
            onOpenFolder: { path in
                browserPath.append(.folder(path: path))
            },
            onOpenFile: { entry in
                browserPath.append(.file(entry: entry))
            },
            onOpenChat: { path, workspaceID in
                openChat(folderPath: path, workspaceID: workspaceID)
            },
            onOpenLibrary: isRoot ? { showingLibrary = true } : nil,
            onOpenStatus: isRoot ? { showingStatus = true } : nil,
            onOpenDiagnostics: isRoot ? { showingDiagnostics = true } : nil,
            onOpenAccount: isRoot ? { showingAccount = true } : nil
        )
    }

    private func openChat(folderPath: String?, workspaceID: String?) {
        chatLaunch = chatSessionStore.launch(folderPath: folderPath, workspaceID: workspaceID)
    }

    private var libraryCover: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button {
                    showingLibrary = false
                } label: {
                    Image(systemName: "chevron.down")
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(width: 36, height: 36)
                        .background(AppTheme.bgSurfaceHi, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close library")
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)

            LibraryView(
                viewModel: libraryViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient
            )
        }
        .background(AppTheme.bgCanvas.ignoresSafeArea())
        // Full-screen covers are separate presentations: re-pin the deliberate
        // dark-only appearance so the cover can never flash light.
        .preferredColorScheme(.dark)
    }

    private var shouldStartAgentMonitor: Bool {
        CodexAgentMonitorPolicy.shouldStartAppMonitor(
            isRunningTests: ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
        )
    }

    #if DEBUG
    /// Visual-test deep links (compiled out of release builds):
    /// - RELAY_UITEST_PATH=/abs/folder     push the browser to that folder
    /// - RELAY_UITEST_FILE=/abs/file       push the file route (read-only viewer)
    /// - RELAY_UITEST_CHAT=1               open the chat cover (for RELAY_UITEST_PATH's
    ///   folder when set, else the root); the existing RELAY_UITEST_MODEL /
    ///   RELAY_UITEST_PROMPT / RELAY_UITEST_TASK_PROMPT auto-drive then takes over.
    /// - RELAY_UITEST_OPEN=library|status|account  present that cover/sheet
    private func applyUITestHooks() {
        let env = ProcessInfo.processInfo.environment
        if let folder = env["RELAY_UITEST_PATH"]?.trimmedNonEmpty {
            browserPath.append(.folder(path: folder))
        }
        if let file = env["RELAY_UITEST_FILE"]?.trimmedNonEmpty,
           let data = try? JSONSerialization.data(withJSONObject: ["path": file, "kind": "file"]),
           let entry = try? JSONDecoder().decode(CodexWorkspaceDirectoryEntry.self, from: data) {
            browserPath.append(.file(entry: entry))
        }
        switch env["RELAY_UITEST_OPEN"] {
        case "library":
            showingLibrary = true
        case "status":
            showingStatus = true
        case "account":
            showingAccount = true
        default:
            break
        }
        if env["RELAY_UITEST_CHAT"] == "1" {
            openChat(folderPath: env["RELAY_UITEST_PATH"]?.trimmedNonEmpty, workspaceID: nil)
        }
    }
    #endif
}

extension CodexProvider {
    var tabIconAssetName: String {
        switch self {
        case .codex:
            return "ChatGPTMark"
        case .claude:
            return "ClaudeMark"
        case .cursor:
            return "ChatGPTMark"
        case .bedrock:
            return "ClaudeMark"
        case .azure:
            return "ChatGPTMark"
        }
    }

    var activityTint: Color {
        switch self {
        case .codex:
            return AppTheme.textSecondary
        case .claude, .cursor, .bedrock, .azure:
            return AppTheme.accent
        }
    }
}

/// Lightweight app-wide activity feed for the Status sheet: fetches recent threads and
/// jobs across every provider/workspace, replacing the retired console view models'
/// `threadFeedItems`.
@MainActor
final class StatusFeedViewModel: ObservableObject {
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var errorMessage: String?

    private let client: CodexClient
    private var hasLoaded = false

    init(client: CodexClient) {
        self.client = client
    }

    var feedItems: [CodexThreadFeedItem] {
        CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs)
    }

    func bootstrapIfNeeded() async {
        guard !hasLoaded else { return }
        await refresh()
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            async let threadRequest = client.fetchThreads(provider: nil, workspaceID: nil, limit: 80)
            async let jobRequest = client.fetchJobs(provider: nil, workspaceID: nil, limit: 30)
            threads = try await threadRequest
            jobs = try await jobRequest
            errorMessage = nil
            hasLoaded = true
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }
}

private struct CodexStatusView: View {
    @ObservedObject var feedViewModel: StatusFeedViewModel
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
                                if let error = feedViewModel.errorMessage {
                                    Text(error)
                                        .font(.system(size: 13))
                                        .foregroundStyle(AppTheme.statusError)
                                        .padding(.horizontal, 20)
                                        .padding(.bottom, 12)
                                }

                                Text(summaryText)
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.textSecondary)
                                    .padding(.horizontal, 20)
                                    .padding(.bottom, 12)

                                LazyVStack(spacing: 0) {
                                    ForEach(Array(feedViewModel.feedItems.prefix(24))) { item in
                                        CodexActivityRow(item: item)
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
                await feedViewModel.refresh()
            }
            .task {
                await feedViewModel.bootstrapIfNeeded()
            }
        }
        .preferredColorScheme(.dark)
    }

    private var summaryText: String {
        let items = feedViewModel.feedItems
        let activeCount = items.filter(\.isActive).count
        if activeCount == 0 {
            return "\(items.count) threads · all agents"
        }
        return "\(activeCount) active · \(items.count) recent"
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

private extension CodexThreadFeedItem {
    var provider: CodexProvider {
        switch source {
        case .thread(let thread):
            return thread.provider
        case .pendingJob(let job):
            return job.provider
        }
    }
}

private struct CodexActivityRow: View {
    let item: CodexThreadFeedItem

    private var provider: CodexProvider { item.provider }

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
                        .foregroundStyle(provider == .codex ? AppTheme.textSecondary : AppTheme.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                        .background((provider == .codex ? AppTheme.textPrimary : AppTheme.accent).opacity(provider == .codex ? 0.08 : 0.14), in: Capsule())
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
    static let accentBright = Color(hex: 0xE8965C)
    static let accentDeep = Color(hex: 0xB5612F)
    static let statusOK = Color(hex: 0x32D74B)
    static let statusWarn = Color(hex: 0xFF9F0A)
    static let statusError = statusWarn
    static let statusInfo = textSecondary
    static let statusNeutral = textTertiary

    private static let warmText = Color(hex: 0xEDE8DF)

    // Visual-leap tokens: gradients, glass, depth.
    static let accentGradient = LinearGradient(
        colors: [accentBright, accentDeep],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    static let canvasGradient = LinearGradient(
        colors: [Color(hex: 0x201E1B), Color(hex: 0x161513)],
        startPoint: .top,
        endPoint: .bottom
    )
    static let userBubbleGradient = LinearGradient(
        colors: [accentBright, accentDeep],
        startPoint: .topLeading,
        endPoint: .bottomTrailing
    )
    /// Translucent surface for glassy cards (use over .ultraThinMaterial).
    static let glassTint = warmText.opacity(0.04)
    static let glassStroke = warmText.opacity(0.10)
    static let shadowColor = Color.black.opacity(0.35)

    static func uiFont(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("DMSans-9ptRegular", size: size).weight(weight)
    }

    static func monoFont(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("DMMono-Regular", size: size).weight(weight)
    }
}

extension Color {
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
    static let authBaseURL = configuredURL(
        supportValue: supportConfig?.authBaseURL,
        infoKey: "RelayAuthBaseURL",
        fallback: "http://127.0.0.1:8790"
    )
    static let runtimeMode = "Simulator Preview"
#else
    static let manifestURL = configuredURL(
        supportValue: supportConfig?.manifestURL,
        infoKey: "POCVaultManifestURL",
        fallback: "https://vault.pocs.conformal.live/manifest.json"
    )
    static let signatureURL = configuredURL(
        supportValue: supportConfig?.signatureURL,
        infoKey: "POCVaultSignatureURL",
        fallback: "https://vault.pocs.conformal.live/manifest.sig.json"
    )
    static let codexBaseURL = configuredURL(
        supportValue: supportConfig?.codexBaseURL,
        infoKey: "POCVaultCodexBaseURL",
        fallback: "https://codex.pocs.conformal.live"
    )
    static let authBaseURL = configuredURL(
        supportValue: supportConfig?.authBaseURL,
        infoKey: "RelayAuthBaseURL",
        fallback: "https://api.pocs.conformal.live"
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
        return resolveConfiguredURL(candidates: [supportValue, infoValue], fallback: fallback)
    }

    /// Picks the first genuinely configured candidate URL, else the in-code fallback.
    /// Internal (not private) so unit tests can exercise the resolution directly.
    static func resolveConfiguredURL(candidates: [String?], fallback: String) -> URL {
        let value = candidates
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: isConfiguredURLValue) ?? fallback
        return URL(string: value) ?? URL(string: fallback)!
    }

    /// A candidate counts as configured only when the build actually injected a URL.
    /// Unset builds leak two placeholder shapes into Info.plist: the raw `$(VAR)` token
    /// (build setting undefined) and the checked-in `*.example.com` default (setting
    /// defined but never overridden). Both must lose to the in-code fallback — on the
    /// simulator that fallback is the local fixture, and letting the example.com
    /// placeholder win points a default xcodebuild install at a dead host. Real device
    /// builds keep working: the owner-injected live URL is neither shape and still wins.
    static func isConfiguredURLValue(_ value: String) -> Bool {
        guard !value.isEmpty, !value.contains("$(") else { return false }
        if let host = URL(string: value)?.host?.lowercased(),
           host == "example.com" || host.hasSuffix(".example.com") {
            return false
        }
        return true
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
        let authBaseURL: String?
        let manifestPublicKey: String?
    }
}
