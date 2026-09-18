import SwiftUI

@main
struct POCVaultApp: App {
    /// iOS hands the APNs device token to a UIApplicationDelegate and nowhere else.
    @UIApplicationDelegateAdaptor(RelayAppDelegate.self) private var appDelegate
    @StateObject private var identityStore: ClientIdentityStore
    @StateObject private var chatSessionStore: RelayChatSessionStore
    @StateObject private var statusFeedViewModel: StatusFeedViewModel
    @StateObject private var accountStore: RelayAccountStore
    @StateObject private var nodeStore: RelayNodeStore
    @StateObject private var computerLinkStore: RelayComputerLinkStore
    @StateObject private var pushService: RelayPushService
    private let codexClient: CodexClient
    private let authClient: RelayAuthClient

    init() {
        let identityStore = ClientIdentityStore()
        identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        // One client for the whole app, built at the node the store already
        // restored (a machine paired on a previous launch, else the personal
        // install). Chat, status and the browser all share it, so `retarget`
        // moves every surface at once instead of only the browser's copy.
        let nodeStore = RelayNodeStore()
        let codexClient = CodexClient(
            baseURL: nodeStore.effectiveBaseURL,
            identityStore: identityStore
        )
        let authClient = RelayAuthClient(baseURL: AppConfiguration.authBaseURL)
        let accountStore = RelayAccountStore(
            client: authClient,
            identityStore: identityStore,
            nodeStore: nodeStore
        )

        _identityStore = StateObject(wrappedValue: identityStore)
        _nodeStore = StateObject(wrappedValue: nodeStore)
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
        self.codexClient = codexClient
        self.authClient = authClient
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
        }
    }

    /// What the app shows is decided by whether there is a MACHINE, not by
    /// whether there is an account.
    ///
    /// Relay hands out no machines, so an account buys handoff, push and
    /// `relay login` approval and nothing else — and gating the product behind
    /// a sign-up for a machine the user brought themselves is asking them to
    /// register with a middleman they do not need. Signed out with a paired
    /// machine is a first-class state; the account screen now lives inside
    /// Settings.
    @ViewBuilder
    private var phaseContent: some View {
        if accountStore.phase == .restoring {
            RelayRestoringView()
        } else if !nodeStore.hasMachine {
            RelayOnboardingView(
                accountStore: accountStore,
                nodeStore: nodeStore,
                identityStore: identityStore,
                authClient: authClient
            )
        } else {
            POCVaultRootView(
                statusFeedViewModel: statusFeedViewModel,
                chatSessionStore: chatSessionStore,
                accountStore: accountStore,
                identityStore: identityStore,
                nodeStore: nodeStore,
                computerLinkStore: computerLinkStore,
                codexClient: codexClient,
                authClient: authClient,
                pushService: pushService
            )
            // Pairing (or unpairing) a machine restarts the browser stack so
            // listings refetch; the shared client and the chat/status
            // stores survive it.
            .id("\(nodeStore.effectiveBaseURL.absoluteString)|\(accountStore.user?.id ?? "signed-out")")
            // Comparing the confirmation code is presented HERE, not from the
            // pairing screen, because that screen does not outlive its own
            // success: adopting the node flips `hasMachine` and this router
            // replaces the onboarding stack the sheet was attached to. Driving
            // it from the store also means backgrounding the app mid-comparison
            // resumes the check instead of silently skipping it.
            .sheet(isPresented: Binding(
                get: { nodeStore.pendingVerificationCode != nil },
                set: { if !$0 { nodeStore.confirmVerification() } }
            )) {
                if let code = nodeStore.pendingVerificationCode {
                    NodeVerificationView(
                        nodeStore: nodeStore,
                        code: code,
                        onUnpair: {
                            nodeStore.clear()
                            identityStore.discardPairedMaterial()
                        }
                    )
                }
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
    case previews
    case sessions
    case settings
}

private struct RelayTerminalLaunch: Identifiable {
    let id = UUID()
    let workspaceID: String
    let workspaceName: String
}

struct POCVaultRootView: View {
    @ObservedObject var statusFeedViewModel: StatusFeedViewModel
    @ObservedObject var chatSessionStore: RelayChatSessionStore
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    let codexClient: CodexClient
    let authClient: RelayAuthClient
    @ObservedObject var pushService: RelayPushService

    @Environment(\.scenePhase) private var scenePhase
    @State private var browserPath: [BrowserRoute] = []
    /// Restoring is a launch-time act, not an on-appear one: returning to the
    /// Workspaces tab must not yank the user back to a folder they just left.
    @State private var didRestoreBrowserPath = false
    @State private var chatLaunch: RelayChatLaunch?
    @State private var terminalLaunch: RelayTerminalLaunch?
    /// Raised when a handoff push is tapped: the threads list is where handoff
    /// cards live, so that is where the tap has to land.
    @State private var opensThreadsForHandoff = false
    @State private var selectedRootTab = RelayRootTab.sessions
    @State private var showingDiagnostics = false

    var body: some View {
        mainTabs
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
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
                presentsProviderPickerOnAppear: launch.presentsProviderPicker,
                automaticallyOpensPreviews: launch.automaticallyOpensPreviews
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
                nodeStore: nodeStore
            )
        }
        .task {
            identityStore.importIdentityFromSetupEnvironmentIfNeeded()
        }
        // Push registration needs a session: the cloud device route is
        // session-authed. This view now exists while signed out too, so it is
        // keyed on the account and simply does nothing until there is one.
        .task(id: accountStore.user?.id) {
#if targetEnvironment(simulator)
            // Simulator previews use local fixtures and should not interrupt UI
            // review with a notification permission prompt.
            return
#else
            guard accountStore.currentSessionToken != nil else { return }
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
                        switch item.source {
                        case .pendingJob(let job):
                            return job.id == jobID
                        case .thread(let thread):
                            return thread.lastJobId == jobID
                        }
                    }) else {
                        statusFeedViewModel.reportRoutingMiss(
                            "That run is not in Sessions yet."
                        )
                        return
                    }
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
        // Signed-in places are account state, so this refresh is skipped
        // entirely when there is no session rather than spinning against a
        // bearer-authenticated route with no bearer.
        .task(id: scenePhase) {
            guard scenePhase == .active,
                  let bearer = accountStore.currentSessionToken,
                  let accountID = accountStore.user?.id else { return }
            await computerLinkStore.refresh(
                bearerToken: bearer,
                accountID: accountID,
                showProgress: !computerLinkStore.hasLoaded
            )
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
            CodexStatusView(
                feedViewModel: statusFeedViewModel,
                identityStore: identityStore,
                nodeStore: nodeStore,
                client: codexClient,
                onOpenItem: openSession,
                onOpenNewSession: { workspaceID in
                    openNewSession(folderPath: nil, workspaceID: workspaceID)
                },
                onBrowseFiles: { selectedRootTab = .workspaces }
            )
            .tag(RelayRootTab.sessions)
            .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }
            .badge(statusFeedViewModel.approvals.count)

            Group {
                if foldersAreHiddenAfterComputerDisconnect {
                    disconnectedComputerScreen
                } else {
                    browserNavigation
                }
            }
            .tag(RelayRootTab.workspaces)
            .tabItem { Label("Folders", systemImage: "folder") }

            RelayPreviewsView(
                identityStore: identityStore,
                client: codexClient,
                workspaceAccessIsAvailable: !foldersAreHiddenAfterComputerDisconnect,
                onOpenWorkspaces: { selectedRootTab = .workspaces },
                onOpenJob: openPreviewSourceJob
            )
            .tag(RelayRootTab.previews)
            .tabItem { Label("Previews", systemImage: "rectangle.on.rectangle") }
            .accessibilityIdentifier("relay-previews-tab")

            AccountSettingsView(
                accountStore: accountStore,
                nodeStore: nodeStore,
                identityStore: identityStore,
                computerLinkStore: computerLinkStore,
                codexClient: codexClient,
                authClient: authClient,
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
        .onAppear(perform: restoreBrowserPathIfNeeded)
        .onChange(of: browserPath) { _, path in
            persistBrowserPath(path)
        }
    }

    /// Where the browser reopens.
    ///
    /// Landing at the root every launch is wrong for a machine you actually
    /// work on: the folder you were last in IS the folder you want. The stack
    /// is keyed by machine, because a path from one node means nothing on
    /// another, and it is stored rather than derived because the app is killed
    /// and relaunched far more often than it is repaired.
    private var browserPathDefaultsKey: String {
        "relay.browserPath.\(nodeStore.effectiveBaseURL.absoluteString)"
    }

    /// Only folder routes are kept. A file route carries a decoded directory
    /// entry whose size and mtime go stale between launches, and reopening a
    /// file viewer unprompted is not what "where I left off" means — so the
    /// folders beneath an open file are saved and the viewer itself is not.
    private func persistBrowserPath(_ path: [BrowserRoute]) {
        let folders = path.compactMap { route -> String? in
            guard case .folder(let folderPath) = route else { return nil }
            return folderPath
        }
        UserDefaults.standard.set(folders, forKey: browserPathDefaultsKey)
    }

    private func restoreBrowserPathIfNeeded() {
        guard !didRestoreBrowserPath else { return }
        didRestoreBrowserPath = true
        guard browserPath.isEmpty,
              !foldersAreHiddenAfterComputerDisconnect,
              let folders = UserDefaults.standard.array(forKey: browserPathDefaultsKey) as? [String],
              !folders.isEmpty
        else { return }
        browserPath = folders.map { BrowserRoute.folder(path: $0) }
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
            machineLabel: isRoot ? nodeStore.pairedNode?.nodeName : nil,
            onOpenFolder: { path in
                browserPath.append(.folder(path: path))
            },
            onNavigateToFolder: { path in
                navigateBrowser(to: path)
            },
            onOpenFile: { entry in
                browserPath.append(.file(entry: entry))
            },
            onOpenChat: { path, workspaceID in
                openNewSession(folderPath: path, workspaceID: workspaceID)
            },
            onOpenConversation: { item in
                let launch = chatSessionStore.launch(folderPath: folderPath, workspaceID: item.workspaceID)
                chatLaunch = launch
                Task { await launch.viewModel.openHistoryItem(item) }
            },
            onOpenTerminal: { workspaceID, workspaceName in
                terminalLaunch = RelayTerminalLaunch(workspaceID: workspaceID, workspaceName: workspaceName)
            },
            onOpenDiagnostics: isRoot ? { showingDiagnostics = true } : nil
        )
    }

    /// Breadcrumb taps move within the existing navigation stack when possible.
    /// A direct visual-test route may not have its ancestors in the stack, so that
    /// case starts a clean stack at the selected folder instead of pushing sideways
    /// from a deeper location.
    private func navigateBrowser(to folderPath: String?) {
        guard let folderPath else {
            browserPath.removeAll()
            return
        }

        if let index = browserPath.firstIndex(where: { route in
            guard case .folder(let path) = route else { return false }
            return path == folderPath
        }) {
            browserPath = Array(browserPath.prefix(through: index))
        } else {
            browserPath = [.folder(path: folderPath)]
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

    private func openPreviewSourceJob(_ job: CodexJob) {
        let item = CodexThreadFeedItem(source: .pendingJob(job))
        let launch = chatSessionStore.launch(
            folderPath: nil,
            workspaceID: item.workspaceID,
            automaticallyOpensPreviews: false
        )
        chatLaunch = launch
        Task { await launch.viewModel.openHistoryItem(item) }
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
    /// - RELAY_UITEST_OPEN=previews|library|status|account select that tab
    private func applyUITestHooks() {
        let env = ProcessInfo.processInfo.environment
        if let folder = env["RELAY_UITEST_PATH"]?.trimmedNonEmpty {
            browserPath.append(.folder(path: folder))
            selectedRootTab = .workspaces
        }
        if let file = env["RELAY_UITEST_FILE"]?.trimmedNonEmpty,
           let data = try? JSONSerialization.data(withJSONObject: ["path": file, "kind": "file"]),
           let entry = try? JSONDecoder().decode(CodexWorkspaceDirectoryEntry.self, from: data) {
            browserPath.append(.file(entry: entry))
        }
        switch env["RELAY_UITEST_OPEN"] {
        case "previews", "library":
            selectedRootTab = .previews
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

    func reportRoutingMiss(_ message: String) {
        errorMessage = message
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
    @ObservedObject var nodeStore: RelayNodeStore
    let client: CodexClient
    let onOpenItem: (CodexThreadFeedItem) -> Void
    let onOpenNewSession: (String?) -> Void
    let onBrowseFiles: () -> Void
    @State private var searchText = ""
    @State private var providerFilter: CodexProvider?
    @State private var showingDiagnostics = false
    @State private var showingWorkspacePicker = false
    @State private var workspacePickerError: String?
    @State private var workspaces: [CodexWorkspace] = []
    @State private var isLoadingWorkspaces = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if let error = feedViewModel.errorMessage {
                        Text(error)
                            .font(.subheadline)
                            .foregroundStyle(AppTheme.statusError)
                            .padding(18)
                    }

                    if !displayedApprovals.isEmpty {
                        sectionHeading("Needs your attention")
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

                    if displayedItems.isEmpty {
                        if feedViewModel.isRefreshing && feedViewModel.feedItems.isEmpty {
                            ProgressView("Loading chats…")
                                .frame(maxWidth: .infinity)
                                .padding(.top, 64)
                        } else if feedViewModel.errorMessage == nil {
                            emptyState
                        }
                    } else {
                        ForEach(RecentChatSection.allCases) { section in
                            let items = displayedItems.filter { section.contains($0) }
                            if !items.isEmpty {
                                sectionHeading(section.title)
                                ForEach(items) { item in
                                    Button {
                                        onOpenItem(item)
                                    } label: {
                                        RelayConversationRow(item: item)
                                            .padding(.horizontal, 18)
                                    }
                                    .buttonStyle(.plain)
                                    .accessibilityIdentifier("relay-recent-chat-\(item.id)")
                                }
                            }
                        }
                    }
                }
                .padding(.bottom, 20)
            }
            .background(AppTheme.bgCanvas)
            .scrollDismissesKeyboard(.interactively)
            .navigationTitle("Chats")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $searchText, prompt: "Search chats and folders")
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Menu {
                        Picker("Agent", selection: $providerFilter) {
                            Text("All agents").tag(nil as CodexProvider?)
                            ForEach(availableProviders) { provider in
                                Text(provider.relayPresentation.title).tag(Optional(provider))
                            }
                        }
                        Divider()
                        Button {
                            showingDiagnostics = true
                        } label: {
                            Label("Diagnostics", systemImage: "stethoscope")
                        }
                    } label: {
                        Image(systemName: providerFilter == nil ? "line.3.horizontal.decrease" : "line.3.horizontal.decrease.circle.fill")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .tint(AppTheme.textPrimary)
                    .accessibilityLabel(providerFilter.map { "Filter chats, \($0.relayPresentation.title)" } ?? "Filter chats, all agents")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showingWorkspacePicker = true
                    } label: {
                        Image(systemName: "square.and.pencil")
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .tint(AppTheme.textPrimary)
                    .accessibilityLabel("New chat")
                    .accessibilityIdentifier("relay-new-chat")
                }
            }
            .refreshable {
                await feedViewModel.refresh()
            }
            .sheet(isPresented: $showingDiagnostics) {
                DiagnosticsView(identityStore: identityStore, nodeStore: nodeStore)
            }
            .sheet(isPresented: $showingWorkspacePicker) {
                SessionsWorkspacePickerSheet(
                    workspaces: workspaces,
                    isLoading: isLoadingWorkspaces,
                    errorMessage: workspacePickerError,
                    onSelect: { workspace in
                        showingWorkspacePicker = false
                        onOpenNewSession(workspace.id)
                    },
                    onBrowseFiles: {
                        showingWorkspacePicker = false
                        onBrowseFiles()
                    },
                    onRetry: {
                        Task { await loadWorkspacesForPicker() }
                    }
                )
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
            }
            .onChange(of: showingWorkspacePicker) { _, isPresented in
                guard isPresented else { return }
                Task { await loadWorkspacesForPicker() }
            }
        }
        .preferredColorScheme(.dark)
    }

    private func sectionHeading(_ title: String) -> some View {
        Text(title)
            .font(.custom("DMSans-9ptRegular", size: 13, relativeTo: .subheadline).weight(.medium))
            .foregroundStyle(AppTheme.textPrimary.opacity(0.65))
            .padding(.horizontal, 18)
            .padding(.top, 20)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Text(searchText.isEmpty && providerFilter == nil ? "A place to pick up your work" : "No chats found")
                .font(.title3.weight(.medium))
                .foregroundStyle(AppTheme.textPrimary)
            Text(searchText.isEmpty && providerFilter == nil ? "Start a chat in one of your folders. Your conversations will appear here." : "Try a different title, folder, or agent.")
                .font(.subheadline)
                .foregroundStyle(AppTheme.textPrimary.opacity(0.7))
                .multilineTextAlignment(.center)
            if searchText.isEmpty {
                Button("New chat") { showingWorkspacePicker = true }
                    .buttonStyle(RelayOutlineButtonStyle())
                    .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 72)
    }

    @MainActor
    private func loadWorkspacesForPicker() async {
        isLoadingWorkspaces = true
        workspacePickerError = nil
        defer { isLoadingWorkspaces = false }
        do {
            workspaces = try await client.fetchCodexWorkspaces()
        } catch {
            workspacePickerError = error.localizedDescription
            workspaces = []
        }
    }

    private var displayedItems: [CodexThreadFeedItem] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return feedViewModel.feedItems.filter { item in
            (providerFilter == nil || item.provider == providerFilter) &&
            (query.isEmpty || [item.title, item.workspaceLabel, item.provider.relayPresentation.title]
                .contains { $0.localizedCaseInsensitiveContains(query) })
        }
    }

    // Pending decisions stay visible even when searching conversation titles.
    private var displayedApprovals: [CodexApproval] {
        guard let providerFilter else { return feedViewModel.approvals }
        return feedViewModel.approvals.filter { $0.provider == providerFilter }
    }

    private var availableProviders: [CodexProvider] {
        let providers = Set(feedViewModel.feedItems.map(\.provider) + feedViewModel.approvals.map(\.provider))
        return CodexProvider.allCases.filter(providers.contains)
    }

    private func openApproval(_ approval: CodexApproval) {
        guard let item = feedViewModel.feedItems.first(where: { $0.jobID == approval.jobId }) else { return }
        onOpenItem(item)
    }
}

/// Local presentation grouping; the server's thread order and status semantics stay intact.
private enum RecentChatSection: String, CaseIterable, Identifiable {
    case active, today, yesterday, week, earlier
    var id: String { rawValue }
    var title: String {
        switch self {
        case .active: return "In progress"
        case .today: return "Today"
        case .yesterday: return "Yesterday"
        case .week: return "Previous 7 days"
        case .earlier: return "Earlier"
        }
    }

    func contains(_ item: CodexThreadFeedItem) -> Bool {
        if item.isActive { return self == .active }
        guard let date = item.updatedAt else { return self == .earlier }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return self == .today }
        if calendar.isDateInYesterday(date) { return self == .yesterday }
        let weekStart = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: Date())) ?? .distantPast
        return self == (date >= weekStart ? .week : .earlier)
    }
}

private struct SessionsWorkspacePickerSheet: View {
    let workspaces: [CodexWorkspace]
    let isLoading: Bool
    let errorMessage: String?
    let onSelect: (CodexWorkspace) -> Void
    let onBrowseFiles: () -> Void
    let onRetry: () -> Void

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()
                Group {
                    if isLoading {
                        ProgressView("Loading folders…")
                            .tint(AppTheme.accent)
                    } else if let errorMessage {
                        VStack(alignment: .leading, spacing: 16) {
                            Text(errorMessage)
                                .font(AppTheme.uiFont(size: 14))
                                .foregroundStyle(AppTheme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                            Button("Try again", action: onRetry)
                                .buttonStyle(RelayOutlineButtonStyle())
                            Button("Browse files instead", action: onBrowseFiles)
                                .buttonStyle(RelayPrimaryButtonStyle())
                        }
                        .padding(20)
                    } else if workspaces.isEmpty {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("No folders available on this machine.")
                                .font(AppTheme.uiFont(size: 14))
                                .foregroundStyle(AppTheme.textSecondary)
                            Button("Browse files instead", action: onBrowseFiles)
                                .buttonStyle(RelayPrimaryButtonStyle())
                        }
                        .padding(20)
                    } else {
                        List {
                            ForEach(workspaces) { workspace in
                                Button {
                                    onSelect(workspace)
                                } label: {
                                    VStack(alignment: .leading, spacing: 4) {
                                        Text(workspace.name)
                                            .font(AppTheme.uiFont(size: 15, weight: .medium))
                                            .foregroundStyle(AppTheme.textPrimary)
                                        // Only registered workspaces carry a path; an
                                        // unset one must not leave an empty mono line
                                        // padding the row out.
                                        if let path = workspace.path?.trimmedNonEmpty {
                                            Text(path)
                                                .font(AppTheme.monoFont(size: 12))
                                                .foregroundStyle(AppTheme.textTertiary)
                                                .lineLimit(1)
                                                .truncationMode(.head)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .listRowBackground(AppTheme.bgCanvas)
                            }
                        }
                        .listStyle(.plain)
                        .scrollContentBackground(.hidden)
                    }
                }
            }
            .navigationTitle("Choose a folder")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

// RelayApprovalCard moved to Views/RelayApprovalCard.swift — the chat transcript
// renders the same card, and two copies would drift.

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

/// Shared native row for recent chats and the folder-scoped Threads sheet.
struct RelayConversationRow: View {
    let item: CodexThreadFeedItem
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(item.title)
                    .font(.custom("DMSans-9ptRegular", size: 16, relativeTo: .body).weight(.medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(dynamicTypeSize.isAccessibilitySize ? 3 : 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if !dynamicTypeSize.isAccessibilitySize, let updatedAt = item.updatedAt {
                    Text(updatedAt, format: .dateTime.month(.abbreviated).day())
                        .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption))
                        .foregroundStyle(AppTheme.textPrimary.opacity(0.6))
                        .fixedSize()
                }
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    contextLabel
                    if let attentionLabel { statusLabel(attentionLabel) }
                }
                VStack(alignment: .leading, spacing: 4) {
                    contextLabel
                    if let attentionLabel { statusLabel(attentionLabel) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 13)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var contextLabel: some View {
        Text("\(item.workspaceLabel) · \(item.provider.relayPresentation.title)")
            .font(.custom("DMSans-9ptRegular", size: 13, relativeTo: .subheadline))
            .foregroundStyle(AppTheme.textPrimary.opacity(0.65))
            .lineLimit(1)
            .truncationMode(.middle)
    }

    private var attentionLabel: String? {
        guard let status = item.status else { return item.isActive ? "Running" : nil }
        switch status {
        case .queued, .running, .waitingForApproval, .canceling, .failed, .timeout:
            return status.label
        case .succeeded, .canceled, .unknown:
            return nil
        }
    }

    private func statusLabel(_ text: String) -> some View {
        Text(text)
            .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption).weight(.medium))
            .foregroundStyle(item.status == .failed || item.status == .timeout ? AppTheme.statusError : AppTheme.accentBright)
            .fixedSize(horizontal: true, vertical: false)
    }
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
    /// A node URL is per-user — the owner's own machine, paired to this phone —
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
    // The control plane that owns accounts, node records, handoff and push.
    // Nothing on the critical path goes through it: a paired machine serves
    // files, chat and terminals whether or not this host is reachable.
    static let authBaseURL = configuredURL(
        supportValue: supportConfig?.authBaseURL,
        infoKey: "RelayAuthBaseURL",
        fallback: "https://relay.ai-rocket-experiments.com"
    )
    static let runtimeMode = "Relay Cloud"
#endif

    /// Live dictation streams to Relay's own STT service, never to the speech
    /// provider directly: the provider key lives on that server and must not ship
    /// inside the app. Declared outside the build branches because the simulator
    /// and a device build both talk to the same hosted endpoint.
    static let sttStreamURL = configuredURL(
        supportValue: supportConfig?.sttStreamURL,
        infoKey: "RelaySTTStreamURL",
        fallback: "wss://relay.ai-rocket-experiments.com/v1/stt/stream"
    )

    /// Gates the shared STT service. Empty in a build nobody configured, which
    /// hides the mic entirely — better than a control that always fails on tap.
    static let sttSharedSecret = configuredSecret(
        supportValue: supportConfig?.sttSharedSecret,
        infoKey: "RelaySTTSharedSecret"
    )

    static var supportsDictation: Bool { !sttSharedSecret.isEmpty }

    /// True only when someone deliberately pointed this install at a personal
    /// machine, via `support/vault-config.json`.
    ///
    /// `codexBaseURL` always resolves to something, because the build setting
    /// is its last resort — so "we have a base URL" has never meant "we have a
    /// machine". A phone that unpairs reverts to that build default and the app
    /// then talks to whatever host happens to be baked in, reporting its
    /// failures as if the user's own machine were broken. It surfaced as
    /// `The server "codex.pocs.conformal.live" did not accept the certificate`
    /// against a host that had been decommissioned.
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
    /// every machine-routing assertion asserted something that could not hold,
    /// and the build failed on Apple's side.
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

    /// Same placeholder discipline as `configuredURL`, minus the URL parsing: an
    /// unset build setting reaches Info.plist as the literal `$(VAR)` token, and
    /// treating that as a real secret would ship a control that fails on every tap.
    private static func configuredSecret(supportValue: String?, infoKey: String) -> String {
        let infoValue = Bundle.main.object(forInfoDictionaryKey: infoKey) as? String
        return [supportValue, infoValue]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { !$0.isEmpty && !$0.contains("$(") } ?? ""
    }

    private struct SupportConfig: Decodable {
        let codexBaseURL: String?
        let authBaseURL: String?
        let sttStreamURL: String?
        let sttSharedSecret: String?
    }
}
