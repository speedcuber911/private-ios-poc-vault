import SwiftUI

@main
struct POCVaultApp: App {
    /// iOS hands the APNs device token to a UIApplicationDelegate and nowhere else.
    @UIApplicationDelegateAdaptor(RelayAppDelegate.self) private var appDelegate
    @StateObject private var identityStore: ClientIdentityStore
    @StateObject private var libraryViewModel: LibraryViewModel
    @StateObject private var chatSessionStore: RelayChatSessionStore
    @StateObject private var statusFeedViewModel: StatusFeedViewModel
    @StateObject private var accountStore: RelayAccountStore
    @StateObject private var nodeStore: RelayNodeStore
    @StateObject private var computerLinkStore: RelayComputerLinkStore
    @StateObject private var pushService: RelayPushService
    @StateObject private var subscriptionStore: RelaySubscriptionStore
    private let manifestClient: ManifestClient
    private let codexClient: CodexClient
    private let trialClient: RelayTrialClient

    init() {
        let identityStore = ClientIdentityStore()
        identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        let manifestClient = ManifestClient(
            manifestURL: AppConfiguration.manifestURL,
            signatureURL: AppConfiguration.signatureURL,
            identityStore: identityStore,
            trustedPublicKeyRawRepresentation: AppConfiguration.trustedManifestPublicKey
        )
        // One client for the whole app, built at the node the store already
        // restored (a trial adopted on a previous launch, else the personal
        // install). Chat, status and the browser all share it, so `retarget`
        // moves every surface at once instead of only the browser's copy.
        let nodeStore = RelayNodeStore()
        let codexClient = CodexClient(
            baseURL: nodeStore.effectiveBaseURL,
            identityStore: identityStore
        )
        let accountStore = RelayAccountStore(
            client: RelayAuthClient(baseURL: AppConfiguration.authBaseURL),
            identityStore: identityStore,
            nodeStore: nodeStore
        )

        _identityStore = StateObject(wrappedValue: identityStore)
        _nodeStore = StateObject(wrappedValue: nodeStore)
        _libraryViewModel = StateObject(wrappedValue: LibraryViewModel(client: manifestClient))
        _chatSessionStore = StateObject(wrappedValue: RelayChatSessionStore(
            client: codexClient,
            completionNotifier: CodexLocalNotificationService()
        ))
        _statusFeedViewModel = StateObject(wrappedValue: StatusFeedViewModel(client: codexClient))
        _accountStore = StateObject(wrappedValue: accountStore)
        _computerLinkStore = StateObject(wrappedValue: RelayComputerLinkStore(
            client: RelayAuthClient(baseURL: AppConfiguration.authBaseURL)
        ))
        _pushService = StateObject(wrappedValue: RelayPushService(accountStore: accountStore, codexClient: codexClient))
        _subscriptionStore = StateObject(wrappedValue: RelaySubscriptionStore(
            accountStore: accountStore,
            nodeStore: nodeStore,
            client: RelaySubscriptionClient(baseURL: AppConfiguration.authBaseURL)
        ))
        self.manifestClient = manifestClient
        self.codexClient = codexClient
        self.trialClient = RelayTrialClient(baseURL: AppConfiguration.authBaseURL)
    }

    var body: some Scene {
        WindowGroup {
            phaseContent
            // Repointing happens here rather than in `body`: constructing a client
            // per body evaluation leaked a URLSession every time SwiftUI re-ran it.
            .onChange(of: nodeStore.effectiveBaseURL, initial: true) { _, newBaseURL in
                codexClient.retarget(baseURL: newBaseURL)
            }
            .task {
                await accountStore.restore()
                #if DEBUG
                await applyAuthenticationUITestHooks()
                #endif
            }
            .task(id: accountStore.user?.id) {
                guard accountStore.user != nil else { return }
                await subscriptionStore.prepare()
            }
        }
    }

    @ViewBuilder
    private var phaseContent: some View {
        switch accountStore.phase {
        case .restoring:
            RelayRestoringView()
        case .signedOut:
            AuthenticationView(accountStore: accountStore)
        case .onboarding:
            RelayOnboardingView(
                accountStore: accountStore,
                nodeStore: nodeStore,
                identityStore: identityStore,
                trialClient: trialClient
            )
        case .ready where nodeStore.trial?.state == .expired:
            RelayExpiredTrialView(
                accountStore: accountStore,
                subscriptionStore: subscriptionStore
            )
        case .ready where !nodeStore.hasMachine:
            // Signed in, but nothing to talk to: the trial was lost or
            // never adopted and no personal install was configured.
            // Falling through to the browser here is what made a
            // machine-less account look broken rather than empty — it
            // fired requests at the baked-in default host and reported
            // that host's TLS failure. Offer the machine instead.
            RelayOnboardingView(
                accountStore: accountStore,
                nodeStore: nodeStore,
                identityStore: identityStore,
                trialClient: trialClient
            )
        case .ready:
            POCVaultRootView(
                libraryViewModel: libraryViewModel,
                statusFeedViewModel: statusFeedViewModel,
                chatSessionStore: chatSessionStore,
                accountStore: accountStore,
                identityStore: identityStore,
                nodeStore: nodeStore,
                computerLinkStore: computerLinkStore,
                manifestClient: manifestClient,
                codexClient: codexClient,
                trialClient: trialClient,
                subscriptionStore: subscriptionStore,
                pushService: pushService
            )
            // Adopting (or losing) a machine restarts the browser stack so
            // listings refetch; the shared client and the chat/status
            // stores survive it.
            .id(nodeStore.effectiveBaseURL)
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

private enum RelayRootTab: Hashable {
    case workspaces
    case sessions
    case settings
}

private struct RelayTerminalLaunch: Identifiable {
    let id = UUID()
    let workspaceID: String
    let workspaceName: String
}

struct POCVaultRootView: View {
    @ObservedObject var libraryViewModel: LibraryViewModel
    @ObservedObject var statusFeedViewModel: StatusFeedViewModel
    @ObservedObject var chatSessionStore: RelayChatSessionStore
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    let manifestClient: ManifestClient
    let codexClient: CodexClient
    let trialClient: RelayTrialClient
    @ObservedObject var subscriptionStore: RelaySubscriptionStore
    @ObservedObject var pushService: RelayPushService

    @Environment(\.scenePhase) private var scenePhase
    @State private var browserPath: [BrowserRoute] = []
    @State private var chatLaunch: RelayChatLaunch?
    @State private var terminalLaunch: RelayTerminalLaunch?
    /// Raised when a handoff push is tapped: the threads list is where handoff
    /// cards live, so that is where the tap has to land.
    @State private var opensThreadsForHandoff = false
    @State private var selectedRootTab = RelayRootTab.workspaces
    @State private var showingLibrary = false
    @State private var showingDiagnostics = false

    var body: some View {
        mainTabs
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
        // Library embeds its own NavigationStack, so it must present full screen — never
        // be pushed into the browser stack (nesting navigation stacks is illegal).
        .fullScreenCover(isPresented: $showingLibrary) {
            libraryCover
        }
        .fullScreenCover(item: $chatLaunch) { launch in
            RelayChatView(
                viewModel: launch.viewModel,
                client: codexClient,
                identityStore: identityStore,
                onDismiss: { chatLaunch = nil },
                threadsRequest: $opensThreadsForHandoff,
                onBindChatToFolder: { path, workspaceID, card in
                    opensThreadsForHandoff = false
                    let next = chatSessionStore.launch(folderPath: path, workspaceID: workspaceID)
                    chatLaunch = next
                    Task { await next.viewModel.continueHandoff(card) }
                },
                presentsProviderPickerOnAppear: launch.presentsProviderPicker
            )
        }
        .fullScreenCover(item: $terminalLaunch) { launch in
            RelayTerminalView(
                client: codexClient,
                workspaceID: launch.workspaceID,
                workspaceName: launch.workspaceName,
                onDismiss: { terminalLaunch = nil }
            )
        }
        .sheet(isPresented: $showingDiagnostics) {
            DiagnosticsView(
                identityStore: identityStore,
                manifestClient: manifestClient
            )
        }
        .task {
            identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        }
        // Push registration waits for a signed-in account: this view only exists
        // in the `.ready` phase, and the cloud device route is session-authed.
        .task {
#if targetEnvironment(simulator)
            // Simulator previews use local fixtures and should not interrupt UI
            // review with a notification permission prompt.
            return
#else
            RelayAppDelegate.pushService = pushService
            pushService.registerForPushNotifications()
            await pushService.registerPendingDeviceTokenIfNeeded()
#endif
        }
        // A handoff push carries no content — only a node id and an event type —
        // so the tap opens the threads list and the card loads from the node.
        .onChange(of: pushService.pendingRoute) { _, route in
            guard let route, !foldersAreHiddenAfterComputerDisconnect else { return }
            switch route {
            case .handoff:
                pushService.clearPendingRoute()
                if chatLaunch == nil {
                    openChat(folderPath: nil, workspaceID: nil)
                }
                opensThreadsForHandoff = true
            case .job(_, let jobID):
                pushService.clearPendingRoute()
                selectedRootTab = .sessions
                Task {
                    await statusFeedViewModel.refresh()
                    guard let item = statusFeedViewModel.feedItems.first(where: { item in
                        if case .pendingJob(let job) = item.source { return job.id == jobID }
                        return false
                    }) else { return }
                    openSession(item)
                }
            case .none:
                break
            }
        }
        .onChange(of: foldersAreHiddenAfterComputerDisconnect) { _, isHidden in
            guard isHidden else { return }
            browserPath.removeAll()
            chatLaunch = nil
        }
        // A trial machine expires on the server's clock, so the countdown and
        // the expiry banner are only honest if we re-read state on foreground.
        .task(id: scenePhase) {
            guard scenePhase == .active,
                  let bearer = accountStore.currentSessionToken,
                  let accountID = accountStore.user?.id else { return }
            await computerLinkStore.refresh(
                bearerToken: bearer,
                accountID: accountID,
                showProgress: !computerLinkStore.hasLoaded
            )
            guard nodeStore.trial != nil else { return }
            // Only an authoritative "no trial" may forget the machine — see
            // RelayNodeStore.applyRefresh. A `try?` here once turned every
            // offline foreground into permanent, unrecoverable loss.
            do {
                nodeStore.applyRefresh(.success(try await trialClient.currentTrial(bearer: bearer)))
            } catch {
                nodeStore.applyRefresh(.failure(error))
            }
        }
        .task(id: foldersAreHiddenAfterComputerDisconnect) {
            // App-wide job monitor + completion notifications, owned by the session store.
            guard !foldersAreHiddenAfterComputerDisconnect, shouldStartAgentMonitor else { return }
            await chatSessionStore.monitorActiveWorkWhileAppIsOpen()
        }
        .task(id: selectedRootTab) {
            // Sessions is a live view, not a one-time snapshot. Refresh every time the
            // user returns so work started after the tab's first load appears immediately.
            guard selectedRootTab == .sessions else { return }
            await statusFeedViewModel.refresh()
        }
        #if DEBUG
        .task {
            applyUITestHooks()
        }
        #endif
    }

    private var mainTabs: some View {
        TabView(selection: $selectedRootTab) {
            Group {
                if foldersAreHiddenAfterComputerDisconnect {
                    disconnectedComputerScreen
                } else {
                    browserNavigation
                }
            }
            .tag(RelayRootTab.workspaces)
            .tabItem { Label("Workspaces", systemImage: "square.grid.2x2") }

            CodexStatusView(
                feedViewModel: statusFeedViewModel,
                identityStore: identityStore,
                manifestClient: manifestClient,
                onOpenItem: openSession,
                onNewSession: { selectedRootTab = .workspaces }
            )
            .tag(RelayRootTab.sessions)
            .tabItem { Label("Sessions", systemImage: "bubble.left.and.text.bubble.right") }
            .badge(statusFeedViewModel.approvals.count)

            AccountSettingsView(
                accountStore: accountStore,
                nodeStore: nodeStore,
                identityStore: identityStore,
                computerLinkStore: computerLinkStore,
                trialClient: trialClient,
                subscriptionStore: subscriptionStore,
                showsDismissButton: false
            )
            .tag(RelayRootTab.settings)
            .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .toolbarBackground(AppTheme.canvasBottom, for: .tabBar)
        .toolbarBackground(.visible, for: .tabBar)
    }

    private var browserNavigation: some View {
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
    }

    private var disconnectedComputerScreen: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                VStack(spacing: 14) {
                    Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
                        .font(.system(size: 34, weight: .medium))
                        .foregroundStyle(AppTheme.textTertiary)
                    Text("Computer disconnected")
                        .font(AppTheme.serifFont(size: 26))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text("Its folders are hidden on this phone. Link a computer to show folders again; files on the Relay machine were not deleted.")
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(AppTheme.textSecondary)
                        .multilineTextAlignment(.center)
                        .lineSpacing(3)
                        .padding(.horizontal, 28)
                    Button("Link a computer") {
                        selectedRootTab = .settings
                    }
                    .buttonStyle(RelayPrimaryButtonStyle())
                    .padding(.horizontal, 32)
                    .padding(.top, 8)
                }
            }
        }
    }

    private var foldersAreHiddenAfterComputerDisconnect: Bool {
        computerLinkStore.suppressesFolderAccess(for: accountStore.user?.id)
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
                openNewSession(folderPath: path, workspaceID: workspaceID)
            },
            onOpenTerminal: { workspaceID, workspaceName in
                terminalLaunch = RelayTerminalLaunch(workspaceID: workspaceID, workspaceName: workspaceName)
            },
            onOpenLibrary: isRoot ? { showingLibrary = true } : nil,
            onOpenDiagnostics: isRoot ? { showingDiagnostics = true } : nil
        )
        // Only at the root: the countdown is about the machine as a whole, so
        // repeating it on every drilled-in folder would be noise.
        .safeAreaInset(edge: .top) {
            if isRoot, let trial = nodeStore.trial, trial.showsStatusBanner {
                TrialStatusBanner(
                    trial: trial,
                    client: codexClient,
                    subscriptionStore: subscriptionStore
                )
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            }
        }
    }

    private func openChat(folderPath: String?, workspaceID: String?) {
        chatLaunch = chatSessionStore.launch(folderPath: folderPath, workspaceID: workspaceID)
    }

    private func openNewSession(folderPath: String?, workspaceID: String?) {
        chatLaunch = chatSessionStore.launchNewSession(folderPath: folderPath, workspaceID: workspaceID)
    }

    private func openSession(_ item: CodexThreadFeedItem) {
        let launch = chatSessionStore.launch(folderPath: nil, workspaceID: item.workspaceID)
        chatLaunch = launch
        Task { await launch.viewModel.openHistoryItem(item) }
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
            selectedRootTab = .sessions
        case "account":
            selectedRootTab = .settings
        default:
            break
        }
        if env["RELAY_UITEST_CHAT"] == "1" {
            openChat(folderPath: env["RELAY_UITEST_PATH"]?.trimmedNonEmpty, workspaceID: nil)
        }
    }
    #endif
}

struct RelayProviderPresentation {
    let title: String
    let assetName: String?
    let systemImage: String
    let accent: Color
    let permissionsTitle: String?
    let skillsTitle: String
}

extension CodexProvider {
    /// One provider identity map for every screen. Provider color is deliberately
    /// separate from status color: a failed Codex run remains red, while the Codex mark
    /// stays sea-glass; a waiting Claude Code run remains yellow, while its mark stays
    /// clay. Text + mark always accompany color for accessibility.
    var relayPresentation: RelayProviderPresentation {
        switch self {
        case .codex:
            return RelayProviderPresentation(
                title: "Codex",
                assetName: "ChatGPTMark",
                systemImage: "command",
                accent: Color(hex: 0x78B8B0),
                permissionsTitle: "Codex approvals",
                skillsTitle: "Codex skills"
            )
        case .claude:
            return RelayProviderPresentation(
                title: "Claude Code",
                assetName: "ClaudeMark",
                systemImage: "sparkles",
                accent: Color(hex: 0xD69A69),
                permissionsTitle: "Claude Code permissions",
                skillsTitle: "Claude Code skills"
            )
        case .cursor:
            return RelayProviderPresentation(
                title: "Cursor",
                assetName: nil,
                systemImage: "cursorarrow",
                accent: Color(hex: 0xA89DD8),
                permissionsTitle: nil,
                skillsTitle: "Cursor skills"
            )
        case .kimi:
            return RelayProviderPresentation(
                title: "Kimi K3",
                assetName: nil,
                systemImage: "moon.stars",
                accent: Color(hex: 0x71B7D6),
                permissionsTitle: nil,
                skillsTitle: "Kimi skills"
            )
        case .bedrock:
            return RelayProviderPresentation(
                title: "Bedrock",
                assetName: nil,
                systemImage: "cube.transparent",
                accent: Color(hex: 0xD4AA64),
                permissionsTitle: nil,
                skillsTitle: "Bedrock skills"
            )
        case .azure:
            return RelayProviderPresentation(
                title: "Azure",
                assetName: nil,
                systemImage: "cloud",
                accent: Color(hex: 0x78A9D8),
                permissionsTitle: nil,
                skillsTitle: "Azure skills"
            )
        }
    }

    /// Retained for existing callers/tests, but no longer aliases unrelated providers to
    /// the Codex or Claude artwork.
    var tabIconAssetName: String {
        relayPresentation.assetName ?? relayPresentation.systemImage
    }

    var activityTint: Color { relayPresentation.accent }

    var hasTaskPermissionControls: Bool { relayPresentation.permissionsTitle != nil }
}

enum RelayProviderBadgeStyle: Equatable {
    case plain
    case capsule
}

struct RelayProviderMark: View {
    let provider: CodexProvider
    var size: CGFloat = 15

    var body: some View {
        Group {
            if let assetName = provider.relayPresentation.assetName {
                Image(assetName)
                    .resizable()
                    .renderingMode(.template)
                    .scaledToFit()
            } else {
                Image(systemName: provider.relayPresentation.systemImage)
                    .resizable()
                    .scaledToFit()
            }
        }
        .foregroundStyle(provider.relayPresentation.accent)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

struct RelayProviderBadge: View {
    let provider: CodexProvider
    var detail: String? = nil
    var style: RelayProviderBadgeStyle = .capsule
    var size: CGFloat = 10

    var body: some View {
        HStack(spacing: 6) {
            RelayProviderMark(provider: provider, size: size + 3)
            Text(label.uppercased())
                .font(AppTheme.uiFont(size: size, weight: .semibold))
                .tracking(0.9)
                .foregroundStyle(provider.relayPresentation.accent)
                .lineLimit(1)
        }
        .padding(.horizontal, style == .capsule ? 9 : 0)
        .padding(.vertical, style == .capsule ? 5 : 0)
        .background {
            if style == .capsule {
                Capsule().fill(provider.relayPresentation.accent.opacity(0.11))
            }
        }
        .overlay {
            if style == .capsule {
                Capsule().stroke(provider.relayPresentation.accent.opacity(0.28), lineWidth: 1)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
    }

    private var label: String {
        let title = provider.relayPresentation.title
        guard var detail = detail?.trimmedNonEmpty else { return title }

        // Server labels sometimes already include the harness (for example
        // "Claude Code · Sonnet"). Keep the badge harness-first without repeating it.
        let aliases = provider == .claude ? ["Claude Code", "Claude"] : [title]
        for alias in aliases where detail.lowercased().hasPrefix(alias.lowercased()) {
            let suffix = String(detail.dropFirst(alias.count))
                .trimmingCharacters(in: CharacterSet(charactersIn: " \t·:-–—"))
            if !suffix.isEmpty { detail = suffix }
            break
        }
        return "\(title) · \(detail)"
    }
}

/// Lightweight app-wide activity feed for the Status sheet: fetches recent threads and
/// jobs across every provider/workspace, replacing the retired console view models'
/// `threadFeedItems`.
@MainActor
final class StatusFeedViewModel: ObservableObject {
    @Published private(set) var threads: [CodexThread] = []
    @Published private(set) var jobs: [CodexJob] = []
    @Published private(set) var approvals: [CodexApproval] = []
    @Published private(set) var isRefreshing = false
    @Published private(set) var errorMessage: String?

    private let client: CodexClient
    init(client: CodexClient) {
        self.client = client
    }

    var feedItems: [CodexThreadFeedItem] {
        CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs)
    }

    func refresh() async {
        isRefreshing = true
        defer { isRefreshing = false }
        do {
            async let threadRequest = client.fetchThreads(provider: nil, workspaceID: nil, limit: 80)
            async let jobRequest = client.fetchJobs(provider: nil, workspaceID: nil, limit: 30)
            async let approvalRequest = client.fetchPendingApprovalsIfSupported()
            threads = try await threadRequest
            jobs = try await jobRequest
            approvals = try await approvalRequest
            errorMessage = nil
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    func decide(_ approval: CodexApproval, _ decision: CodexApprovalDecision) async {
        do {
            _ = try await client.decideApproval(id: approval.id, decision: decision)
            approvals.removeAll { $0.id == approval.id }
            await refresh()
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
    let onOpenItem: (CodexThreadFeedItem) -> Void
    let onNewSession: () -> Void
    @State private var selectedSection = StatusSection.activity
    @State private var providerFilter: CodexProvider?

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()

                VStack(alignment: .leading, spacing: 0) {
                    HStack {
                        Text("Sessions")
                            .font(AppTheme.serifFont(size: 32))
                            .foregroundStyle(AppTheme.textPrimary)
                        Spacer()
                        Button(action: onNewSession) {
                            Image(systemName: "plus")
                                .font(AppTheme.uiFont(size: 18, weight: .semibold))
                                .foregroundStyle(AppTheme.textPrimary)
                                .frame(width: 40, height: 40)
                                .background(AppTheme.canvasTop, in: Circle())
                                .overlay { Circle().stroke(AppTheme.hairlineStrong, lineWidth: 1) }
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Choose a workspace for a new session")
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 16)
                    .padding(.bottom, 16)

                    HStack(spacing: 18) {
                        ForEach(StatusSection.allCases) { section in
                            Button {
                                withAnimation(.easeInOut(duration: 0.18)) {
                                    selectedSection = section
                                }
                            } label: {
                                VStack(spacing: 5) {
                                    Text(section.title)
                                        .font(.system(size: 14, weight: selectedSection == section ? .medium : .regular))
                                        .foregroundStyle(selectedSection == section ? AppTheme.textPrimary : AppTheme.textTertiary)
                                    Rectangle()
                                        .fill(selectedSection == section ? AppTheme.accent : Color.clear)
                                        .frame(height: 2)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 20)
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

                                providerFilterBar
                                    .padding(.bottom, 14)

                                if !displayedApprovals.isEmpty {
                                    RelayCapsLabel(text: "Needs attention", color: AppTheme.statusWarn)
                                        .padding(.horizontal, 20)
                                        .padding(.bottom, 8)
                                    ForEach(displayedApprovals) { approval in
                                        RelayApprovalCard(
                                            approval: approval,
                                            onOpen: { openApproval(approval) },
                                            onDecision: { decision in
                                                Task { await feedViewModel.decide(approval, decision) }
                                            }
                                        )
                                        .padding(.horizontal, 16)
                                        .padding(.bottom, 10)
                                    }
                                }

                                Text(summaryText)
                                    .font(.system(size: 13))
                                    .foregroundStyle(AppTheme.textSecondary)
                                    .padding(.horizontal, 20)
                                    .padding(.bottom, 12)

                                LazyVStack(spacing: 0) {
                                    ForEach(Array(displayedItems.prefix(24))) { item in
                                        Button {
                                            onOpenItem(item)
                                        } label: {
                                            CodexActivityRow(item: item)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                                .overlay(alignment: .top) {
                                    Rectangle()
                                        .fill(AppTheme.hairline)
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
        }
        .preferredColorScheme(.dark)
    }

    private var summaryText: String {
        let items = displayedItems
        let activeCount = items.filter(\.isActive).count
        let scope = providerFilter?.relayPresentation.title ?? "all agents"
        if activeCount == 0 {
            return "\(items.count) threads · \(scope)"
        }
        return "\(activeCount) active · \(items.count) recent · \(scope)"
    }

    private var displayedItems: [CodexThreadFeedItem] {
        guard let providerFilter else { return feedViewModel.feedItems }
        return feedViewModel.feedItems.filter { $0.provider == providerFilter }
    }

    private var displayedApprovals: [CodexApproval] {
        guard let providerFilter else { return feedViewModel.approvals }
        return feedViewModel.approvals.filter { $0.provider == providerFilter }
    }

    private var availableProviders: [CodexProvider] {
        let providers = Set(feedViewModel.feedItems.map(\.provider) + feedViewModel.approvals.map(\.provider))
        return CodexProvider.allCases.filter(providers.contains)
    }

    private var providerFilterBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                Button {
                    providerFilter = nil
                } label: {
                    Text("ALL")
                        .font(AppTheme.uiFont(size: 10, weight: .semibold))
                        .tracking(0.9)
                        .foregroundStyle(providerFilter == nil ? AppTheme.textPrimary : AppTheme.textTertiary)
                        .padding(.horizontal, 12)
                        .frame(height: 30)
                        .background(providerFilter == nil ? AppTheme.textPrimary.opacity(0.08) : Color.clear, in: Capsule())
                        .overlay(Capsule().stroke(providerFilter == nil ? AppTheme.hairlineStrong : AppTheme.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)

                ForEach(availableProviders) { provider in
                    Button {
                        providerFilter = provider
                    } label: {
                        RelayProviderBadge(
                            provider: provider,
                            style: providerFilter == provider ? .capsule : .plain,
                            size: 9
                        )
                        .frame(height: 30)
                        .padding(.horizontal, providerFilter == provider ? 0 : 9)
                        .overlay {
                            if providerFilter != provider {
                                Capsule().stroke(AppTheme.hairline, lineWidth: 1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
        .accessibilityLabel("Filter sessions by provider")
    }

    private func openApproval(_ approval: CodexApproval) {
        guard let item = feedViewModel.feedItems.first(where: { item in
            if case .pendingJob(let job) = item.source { return job.id == approval.jobId }
            return false
        }) else { return }
        onOpenItem(item)
    }
}

private struct RelayApprovalCard: View {
    let approval: CodexApproval
    let onOpen: () -> Void
    let onDecision: (CodexApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                RelayProviderBadge(provider: approval.provider, style: .capsule, size: 9)
                Spacer()
                RelayCapsLabel(text: "Needs approval", color: AppTheme.statusWarn, size: 9)
            }
            Label(approval.title, systemImage: "checkmark.shield")
                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            if let command = approval.command?.trimmedNonEmpty {
                Text(command)
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(4)
            }
            if let reason = approval.reason?.trimmedNonEmpty {
                Text(reason)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            HStack(spacing: 10) {
                Button("Deny") { onDecision(.decline) }
                    .buttonStyle(.bordered)
                Button("Open", action: onOpen)
                    .buttonStyle(.bordered)
                Spacer()
                Button("Approve") { onDecision(.accept) }
                    .buttonStyle(.borderedProminent)
                    .tint(approval.provider.relayPresentation.accent)
            }
        }
        .padding(14)
        .background(AppTheme.canvasTop)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(approval.provider.relayPresentation.accent.opacity(0.4), lineWidth: 1))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(approval.provider.relayPresentation.accent)
                .frame(width: 3)
                .padding(.vertical, 12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(approval.provider.relayPresentation.title) approval request")
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
            RelayProviderMark(provider: provider, size: 17)
                .frame(width: 32, height: 32)
                .background(provider.relayPresentation.accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .stroke(provider.relayPresentation.accent.opacity(0.24), lineWidth: 1)
                }

            VStack(alignment: .leading, spacing: 5) {
                Text(item.title)
                    .font(.system(size: 14))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 7) {
                    RelayProviderBadge(provider: provider, style: .plain, size: 9)
                    Text("\(item.workspaceLabel) · \(timestampText)")
                        .font(.system(size: 11))
                        .foregroundStyle(AppTheme.textSecondary)
                    RelayCapsLabel(
                        text: item.status?.label ?? "Thread",
                        color: statusColor,
                        size: 9
                    )
                }
                .lineLimit(1)
            }

            Spacer(minLength: 0)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(provider.relayPresentation.accent.opacity(0.75))
                .frame(width: 2)
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(AppTheme.hairline)
                .frame(height: 0.5)
                .padding(.leading, 62)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(provider.relayPresentation.title), \(item.title)")
    }

    private var timestampText: String {
        guard let updatedAt = item.updatedAt else { return "" }
        return Self.relativeFormatter.localizedString(for: updatedAt, relativeTo: Date())
    }

    private var statusColor: Color {
        guard let status = item.status else { return AppTheme.textTertiary }
        switch status {
        case .queued, .running, .waitingForApproval, .canceling:
            return AppTheme.accentBright
        case .succeeded:
            return AppTheme.textSecondary
        case .failed, .timeout:
            return AppTheme.statusError
        case .canceled, .unknown:
            return AppTheme.textTertiary
        }
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

/// Editorial Ember design language — see docs/superpowers/specs/2026-08-11-editorial-ember-design.md.
/// Serif for identity, sans for function; one surface with hairlines; ember only where
/// attention belongs; status is typographic, never a dot.
enum AppTheme {
    // Canvas
    static let canvasTop = Color(hex: 0x1E1B17)
    static let canvasBottom = Color(hex: 0x151310)
    /// Solid canvas for sheets and fills that cannot take the gradient.
    static let bgCanvas = Color(hex: 0x1A1815)
    // Relay uses a flat canvas. Keep the historical property name so older views
    // adopt the flatter treatment without each screen carrying its own background.
    static let canvasGradient = canvasBottom

    // Ink — cream at four opacity steps. Success/neutral status text uses these.
    static let textPrimary = ink
    static let textSecondary = ink.opacity(0.55)
    static let textTertiary = ink.opacity(0.38)
    static let textFaint = ink.opacity(0.25)

    // Structure — hairlines instead of boxes.
    static let hairline = ink.opacity(0.10)
    static let hairlineStrong = ink.opacity(0.16)

    // Ember — the primary action, the user's own words, live activity. Nothing else.
    static let accent = Color(hex: 0xD4804A)
    static let accentBright = Color(hex: 0xE8965C)
    static let accentDeep = Color(hex: 0xC96F35)
    static let onEmber = Color(hex: 0x1C1207)
    static let accentGradient = accent
    static let userBubbleGradient = accentGradient

    // Status text colors (words, not shapes). Success stays cream on purpose.
    static let statusWarn = Color(hex: 0xE0B25C)
    static let statusError = Color(hex: 0xD9776B)

    // Depth
    static let shadowColor = Color.black.opacity(0.35)
    static let emberShadow = accentDeep.opacity(0.25)

    private static let ink = Color(hex: 0xEDE8DF)

    static func uiFont(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("DMSans-9ptRegular", size: size).weight(weight)
    }

    static func monoFont(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("DMMono-Regular", size: size).weight(weight)
    }

    /// New York serif — screen titles, wordmark, folder/chat headers only.
    static func serifFont(size: CGFloat, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }
}

/// Small-caps letterspaced label — the only rendering for status words, bylines,
/// and section labels (spec rule 5: status is typographic, never a dot).
struct RelayCapsLabel: View {
    let text: String
    var color: Color = AppTheme.textTertiary
    var size: CGFloat = 10

    var body: some View {
        Text(text.uppercased())
            .font(AppTheme.uiFont(size: size, weight: .semibold))
            .tracking(1.1)
            .foregroundStyle(color)
    }
}

/// Primary action: full-chroma ember pill, one per screen at most.
/// Disabled state desaturates to cream — never dimmed ember (spec rule 3).
struct RelayPrimaryButtonStyle: ButtonStyle {
    var isEnabled = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTheme.uiFont(size: 16, weight: .semibold))
            .foregroundStyle(isEnabled ? AppTheme.onEmber : AppTheme.textTertiary)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(
                isEnabled
                    ? AnyShapeStyle(AppTheme.accentGradient)
                    : AnyShapeStyle(AppTheme.textPrimary.opacity(0.04)),
                in: Capsule()
            )
            .overlay {
                if !isEnabled {
                    Capsule().stroke(AppTheme.hairline, lineWidth: 1)
                }
            }
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

/// Secondary action: hairline outline pill, cream text.
struct RelayOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTheme.uiFont(size: 15, weight: .medium))
            .foregroundStyle(AppTheme.textPrimary)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.7 : 1)
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
    /// A node URL is per-user — the owner's own machine or an adopted trial —
    /// so there is no correct global default and this fallback deliberately
    /// resolves to nothing. `.invalid` is reserved by RFC 2606 and is
    /// guaranteed never to resolve, so an unconfigured build fails at DNS,
    /// immediately and legibly.
    ///
    /// It used to fall back to `https://codex.pocs.conformal.live`, which is a
    /// *different, older* deployment — still live, still serving 200 on
    /// /healthz with a valid certificate as of 2026-08-13. That is worse than a
    /// dead host: an unconfigured build did not fail, it quietly talked to
    /// someone else's server. `hasConfiguredPersonalInstall` is the predicate
    /// that decides whether there is a machine at all, and it reads only
    /// `supportConfig` — never this fallback — so nothing downstream should
    /// reach this URL in the first place.
    static let codexBaseURL = configuredURL(
        supportValue: supportConfig?.codexBaseURL,
        infoKey: "POCVaultCodexBaseURL",
        fallback: "https://unconfigured.invalid"
    )
    // The control plane that owns accounts AND trials. It must be the box the
    // trial routes are deployed to — pointing this at a relay-cloud without
    // trial config does not degrade to "no trial", it 403s from the mTLS-gated
    // codex-api that answers /v1/* for unknown paths on that host.
    static let authBaseURL = configuredURL(
        supportValue: supportConfig?.authBaseURL,
        infoKey: "RelayAuthBaseURL",
        fallback: "https://relay.ai-rocket-experiments.com"
    )
    static let runtimeMode = "Relay Cloud"
#endif

    /// True only when someone deliberately pointed this install at a personal
    /// machine, via `support/vault-config.json`.
    ///
    /// `codexBaseURL` always resolves to something, because the build setting
    /// is its last resort — so "we have a base URL" has never meant "we have a
    /// machine". A trial user who signs out reverts to that build default and
    /// the app then talks to whatever host happens to be baked in, reporting
    /// its failures as if the user's own machine were broken. It surfaced as
    /// `The server "codex.pocs.conformal.live" did not accept the certificate`
    /// on an account whose only machine was a trial, against a host that had
    /// been decommissioned.
    ///
    /// Declared OUTSIDE the build branches, not inside `#else`: it reads only
    /// `supportConfig`, which both branches share, and `RelayNodeStore.hasMachine`
    /// references it unconditionally. Defined in one branch only, it compiled
    /// for the device and broke every simulator build — which is also the
    /// build the handoff states get exercised from.
    static let hasConfiguredPersonalInstall: Bool = {
        if (supportConfig?.codexBaseURL?.trimmedNonEmpty) != nil { return true }
        return isSimulatorFixtureRun
    }()

    /// True only when `ios/launch-simulator.sh` is driving this run: it exports
    /// `SIMCTL_CHILD_RELAY_SIM_FIXTURE=1`, which reaches the app as
    /// `RELAY_SIM_FIXTURE`, and it builds against the local fixture server. That
    /// run genuinely has a machine, so it belongs in
    /// `hasConfiguredPersonalInstall` rather than as a short-circuit inside
    /// `RelayNodeStore.hasMachine`.
    ///
    /// Both guards are load-bearing. The `#if` means no device build can be
    /// talked into claiming a machine by an environment variable. The env check
    /// means `xcodebuild test` — also a simulator build, and it sets none of
    /// these — sees the truth. The previous blanket
    /// `#if targetEnvironment(simulator) → true` made `hasMachine`
    /// unconditionally true wherever the tests run, so
    /// `testTrialRefreshClearsTheNodeURLOnceTheTrialIsNoLongerUsable` asserted
    /// something that could not hold and failed the build on Apple's side.
    ///
    /// Deliberately NOT derived from the Info.plist base URL. That value comes
    /// from a build setting, and a build setting always has *some* value, so
    /// "the plist has a URL" would be true of every build and mean nothing.
    /// `POC_VAULT_CODEX_BASE_URL` is now checked in empty for exactly this
    /// reason — it used to default to `https://codex.pocs.conformal.live`, an
    /// older deployment that is still live and still serving, so an
    /// unconfigured build reached a stranger's server rather than failing.
    static let isSimulatorFixtureRun: Bool = {
#if targetEnvironment(simulator)
        ProcessInfo.processInfo.environment["RELAY_SIM_FIXTURE"] == "1"
#else
        false
#endif
    }()

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
