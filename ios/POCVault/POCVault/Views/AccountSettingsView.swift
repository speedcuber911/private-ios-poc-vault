import SwiftUI

// MARK: - Account Settings Presentation Enums & State

private enum AccountSettingsSheet: Identifiable {
    case pairing
    case signIn
    case diagnostics
    case cliLink
    case providerLogin(CodexProvider)

    var id: String {
        switch self {
        case .pairing: return "pairing"
        case .signIn: return "signIn"
        case .diagnostics: return "diagnostics"
        case .cliLink: return "cliLink"
        case .providerLogin(let provider): return "providerLogin-\(provider.rawValue)"
        }
    }
}

private enum AccountSettingsConfirmation: Identifiable {
    case disconnectComputer
    case removeBrowser(RelayBrowserSession)
    case unpairHost(RelayPairedNode)
    case stopMachine

    var id: String {
        switch self {
        case .disconnectComputer: return "disconnectComputer"
        case .removeBrowser(let browser): return "removeBrowser-\(browser.id)"
        case .unpairHost(let host): return "unpairHost-\(host.nodeID)"
        case .stopMachine: return "stopMachine"
        }
    }
}

private enum AccountSettingsAlert: Identifiable {
    case deleteAccount
    case renameHost(RelayPairedNode)

    var id: String {
        switch self {
        case .deleteAccount: return "deleteAccount"
        case .renameHost(let host): return "renameHost-\(host.nodeID)"
        }
    }

    var title: String {
        switch self {
        case .deleteAccount: return "Delete your Relay account?"
        case .renameHost: return "Rename host"
        }
    }
}

@MainActor
private final class AccountSettingsState: ObservableObject {
    @Published var activeSheet: AccountSettingsSheet? {
        didSet {
            if let activeSheet {
                lastPresentedSheet = activeSheet
            }
        }
    }
    var lastPresentedSheet: AccountSettingsSheet?
    @Published var activeConfirmation: AccountSettingsConfirmation?
    @Published var activeAlert: AccountSettingsAlert?
    @Published var deletionPassword = ""
    @Published var showingAccountDetails = false
    @Published var renameHostDraft = ""
    @Published var isRegisteringMachine = false
    @Published var machineNotice: String?
    @Published var browsers: [RelayBrowserSession] = []
    @Published var isRemovingBrowser = false
    @Published var signedInPlacesError: String?
    @Published var harnesses: [RelayHarnessStatus] = []
    @Published var isLoadingHarnesses = false
    @Published var harnessError: String?
}

// MARK: - Account Settings View

struct AccountSettingsView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    let codexClient: CodexClient
    let authClient: RelayAuthClient
    /// The app's one power model, shared with Usage, so the two screens can
    /// never disagree about whether the machine is on.
    @ObservedObject var powerModel: RelayMachinePowerModel
    var pushService: RelayPushService?
    var showsDismissButton: Bool
    var onOpenDiagnostics: (() -> Void)?
    var onOpenMachineMonitor: (() -> Void)?
    var onDisconnect: (() -> Void)?

    @ObservedObject private var themeStore = RelayThemeStore.shared
    @StateObject private var state = AccountSettingsState()
    @Environment(\.dismiss) private var dismiss

    /// Primary initializer matching existing `POCVaultApp` call sites.
    init(
        accountStore: RelayAccountStore,
        nodeStore: RelayNodeStore,
        identityStore: ClientIdentityStore,
        computerLinkStore: RelayComputerLinkStore,
        codexClient: CodexClient,
        authClient: RelayAuthClient,
        powerModel: RelayMachinePowerModel,
        pushService: RelayPushService? = nil,
        showsDismissButton: Bool = true,
        onOpenDiagnostics: (() -> Void)? = nil,
        onOpenMachineMonitor: (() -> Void)? = nil,
        onDisconnect: (() -> Void)? = nil
    ) {
        self.accountStore = accountStore
        self.nodeStore = nodeStore
        self.identityStore = identityStore
        self.computerLinkStore = computerLinkStore
        self.codexClient = codexClient
        self.authClient = authClient
        self.powerModel = powerModel
        self.pushService = pushService
        self.showsDismissButton = showsDismissButton
        self.onOpenDiagnostics = onOpenDiagnostics
        self.onOpenMachineMonitor = onOpenMachineMonitor
        self.onDisconnect = onDisconnect
    }

    /// Convenience initializer supporting the expanded multi-host shell parameter order.
    init(
        accountStore: RelayAccountStore,
        identityStore: ClientIdentityStore,
        nodeStore: RelayNodeStore,
        computerLinkStore: RelayComputerLinkStore,
        authClient: RelayAuthClient,
        codexClient: CodexClient,
        pushService: RelayPushService? = nil,
        powerModel: RelayMachinePowerModel,
        showsDismissButton: Bool = true,
        onOpenDiagnostics: (() -> Void)? = nil,
        onOpenMachineMonitor: (() -> Void)? = nil,
        onDisconnect: (() -> Void)? = nil
    ) {
        self.init(
            accountStore: accountStore,
            nodeStore: nodeStore,
            identityStore: identityStore,
            computerLinkStore: computerLinkStore,
            codexClient: codexClient,
            authClient: authClient,
            powerModel: powerModel,
            pushService: pushService,
            showsDismissButton: showsDismissButton,
            onOpenDiagnostics: onOpenDiagnostics,
            onOpenMachineMonitor: onOpenMachineMonitor,
            onDisconnect: onDisconnect
        )
    }

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        NavigationStack {
            AccountSettingsMainContent(
                accountStore: accountStore,
                nodeStore: nodeStore,
                identityStore: identityStore,
                computerLinkStore: computerLinkStore,
                codexClient: codexClient,
                authClient: authClient,
                powerModel: powerModel,
                themeStore: themeStore,
                state: state,
                pushService: pushService,
                showsDismissButton: showsDismissButton,
                onDismiss: { dismiss() },
                onOpenDiagnostics: onOpenDiagnostics,
                onOpenMachineMonitor: onOpenMachineMonitor,
                onRefreshAll: {
                    await loadLinkedComputer()
                    await refreshHarnessesForMachineState()
                },
                onLoadLinkedComputer: { showProgress in
                    await loadLinkedComputer(showProgress: showProgress)
                },
                onLoadHarnesses: {
                    await loadHarnesses()
                },
                onSwitchHost: switchActiveHost,
                onRegisterMachine: registerMachine
            )
        }
        .modifier(AccountSettingsAlertsModifier(
            accountStore: accountStore,
            nodeStore: nodeStore,
            computerLinkStore: computerLinkStore,
            powerModel: powerModel,
            state: state,
            onDismiss: { dismiss() },
            onDisconnectComputer: { await disconnectLinkedComputer() },
            onRemoveBrowser: { browser in await removeBrowser(browser) },
            onUnpairHost: unpairHost
        ))
        .modifier(AccountSettingsSheetsModifier(
            accountStore: accountStore,
            nodeStore: nodeStore,
            identityStore: identityStore,
            codexClient: codexClient,
            authClient: authClient,
            themeStore: themeStore,
            state: state,
            onReloadHarnesses: { await loadHarnesses() },
            onReloadLinkedComputer: { await loadLinkedComputer() },
            onPairingDismissed: {
                await powerModel.refresh()
                await refreshHarnessesForMachineState()
            }
        ))
        .modifier(AccountSettingsLifecycleModifier(
            accountStore: accountStore,
            nodeStore: nodeStore,
            identityStore: identityStore,
            computerLinkStore: computerLinkStore,
            powerModel: powerModel,
            state: state,
            agentsMachineState: agentsMachineState,
            onLoadLinkedComputer: { showProgress in
                await loadLinkedComputer(showProgress: showProgress)
            },
            onRefreshHarnesses: {
                await refreshHarnessesForMachineState()
            }
        ))
        .tint(theme.accentBright)
        .relayThemeStore(themeStore)
    }

    // MARK: - Actions & Machine Helpers

    private func switchActiveHost(to host: RelayPairedNode) {
        identityStore.activateHostMaterial(for: host.host ?? host.nodeID)
        nodeStore.selectHost(id: host.nodeID)
        state.machineNotice = nil
        Task {
            await powerModel.refresh()
            await refreshHarnessesForMachineState()
        }
    }

    private func registerMachine(_ node: RelayPairedNode) async {
        state.isRegisteringMachine = true
        state.machineNotice = nil
        defer { state.isRegisteringMachine = false }
        state.machineNotice = await RelayNodeRegistration.register(
            node: node,
            accountStore: accountStore,
            nodeStore: nodeStore,
            client: authClient
        )
    }

    private func unpairHost(_ host: RelayPairedNode) {
        let key = host.host ?? host.nodeID
        if nodeStore.hosts.count <= 1 {
            nodeStore.removeHost(id: host.nodeID)
            identityStore.discardPairedMaterial()
            onDisconnect?()
        } else {
            identityStore.discardPairedMaterial(for: key)
            nodeStore.removeHost(id: host.nodeID)
            if let nextActive = nodeStore.pairedNode {
                identityStore.activateHostMaterial(for: nextActive.host ?? nextActive.nodeID)
            }
        }
        state.machineNotice = nil
    }

    /// Whether the machine is worth asking about its agents. Without power
    /// control there is nothing to go on, so it is simply asked.
    private var agentsMachineState: AgentsLoadTrigger.Machine {
        AccountSettingsHelpers.agentsMachineState(powerModel: powerModel)
    }

    private var isMachineKnownDown: Bool { agentsMachineState == .down }

    private func refreshHarnessesForMachineState() async {
        if agentsMachineState == .down {
            state.harnesses = []
            state.harnessError = nil
        }
        guard nodeStore.hasMachine, agentsMachineState == .reachable else { return }
        await loadHarnesses()
    }

    private func loadHarnesses() async {
        guard nodeStore.hasMachine, !isMachineKnownDown else { return }
        state.isLoadingHarnesses = true
        state.harnessError = nil
        defer { state.isLoadingHarnesses = false }
        do {
            state.harnesses = try await codexClient.fetchHarnesses(budget: .statusRead)
        } catch {
            guard !Task.isCancelled else { return }
            if powerModel.isWarmingUp {
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { await loadHarnesses() }
                return
            }
            state.harnesses = []
            state.harnessError = "Relay couldn't check the agents on your machine."
        }
    }

    private func loadLinkedComputer(showProgress: Bool = true) async {
        guard let bearer = accountStore.currentSessionToken,
              let accountID = accountStore.user?.id else {
            state.browsers = []
            return
        }
        state.signedInPlacesError = nil
        await computerLinkStore.refresh(
            bearerToken: bearer,
            accountID: accountID,
            showProgress: showProgress
        )
        do {
            let places = try await RelayAuthClient(
                baseURL: AppConfiguration.authBaseURL
            ).signedInPlaces(bearerToken: bearer)
            state.browsers = places.browsers
            computerLinkStore.adoptPlaces(places, accountID: accountID)
        } catch {
            state.signedInPlacesError = "Couldn’t refresh your signed-in devices."
        }
    }

    private func disconnectLinkedComputer() async {
        guard let bearer = accountStore.currentSessionToken,
              let accountID = accountStore.user?.id else { return }
        await computerLinkStore.disconnect(bearerToken: bearer, accountID: accountID)
    }

    private func removeBrowser(_ browser: RelayBrowserSession) async {
        guard let bearer = accountStore.currentSessionToken else { return }
        state.isRemovingBrowser = true
        state.signedInPlacesError = nil
        defer {
            state.isRemovingBrowser = false
        }
        do {
            try await RelayAuthClient(
                baseURL: AppConfiguration.authBaseURL
            ).removeBrowser(id: browser.id, bearerToken: bearer)
            state.browsers.removeAll { $0.id == browser.id }
        } catch let error as RelayAuthClientError {
            if case .server(let status, let code, _) = error,
               status == 404, code == "unknown_browser" {
                state.browsers.removeAll { $0.id == browser.id }
                state.signedInPlacesError = "That browser is already signed out."
                return
            }
            state.signedInPlacesError = "Relay couldn't remove this browser. Try again."
        } catch {
            state.signedInPlacesError = "Relay couldn't remove this browser. Try again."
        }
    }
}

// MARK: - Shallow NavigationStack Root Content

private struct AccountSettingsMainContent: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    let codexClient: CodexClient
    let authClient: RelayAuthClient
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    var pushService: RelayPushService?
    var showsDismissButton: Bool
    let onDismiss: () -> Void
    var onOpenDiagnostics: (() -> Void)?
    var onOpenMachineMonitor: (() -> Void)?
    let onRefreshAll: () async -> Void
    let onLoadLinkedComputer: (Bool) async -> Void
    let onLoadHarnesses: () async -> Void
    let onSwitchHost: (RelayPairedNode) -> Void
    let onRegisterMachine: (RelayPairedNode) async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                AccountSettingsHostsSection(
                    accountStore: accountStore,
                    nodeStore: nodeStore,
                    identityStore: identityStore,
                    codexClient: codexClient,
                    powerModel: powerModel,
                    themeStore: themeStore,
                    state: state,
                    onSwitchHost: onSwitchHost,
                    onRegisterMachine: onRegisterMachine,
                    onLoadHarnesses: onLoadHarnesses
                )
                AccountSettingsAppearanceSection(themeStore: themeStore)
                AccountSettingsChatSection(
                    nodeStore: nodeStore,
                    powerModel: powerModel,
                    themeStore: themeStore,
                    state: state,
                    onLoadHarnesses: onLoadHarnesses
                )
                AccountSettingsAccountSection(
                    accountStore: accountStore,
                    computerLinkStore: computerLinkStore,
                    themeStore: themeStore,
                    state: state,
                    pushService: pushService,
                    onDismiss: onDismiss,
                    onLoadLinkedComputer: onLoadLinkedComputer
                )
                AccountSettingsDiagnosticsSection(
                    nodeStore: nodeStore,
                    identityStore: identityStore,
                    codexClient: codexClient,
                    powerModel: powerModel,
                    state: state,
                    onOpenDiagnostics: onOpenDiagnostics,
                    onOpenMachineMonitor: onOpenMachineMonitor
                )
                AccountSettingsAboutSection(themeStore: themeStore)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollBounceBehavior(.basedOnSize)
        .refreshable {
            await onRefreshAll()
        }
        .background(theme.surface0.ignoresSafeArea())
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if showsDismissButton {
                ToolbarItem(placement: .topBarTrailing) {
                    RelayToolbarIconButton(
                        systemImage: "xmark",
                        accessibilityLabel: "Back to workspace",
                        iconSize: 15,
                        weight: .medium,
                        isMuted: true,
                        action: onDismiss
                    )
                }
            }
        }
    }
}

// MARK: - Shallow Modifiers (Alerts/Dialogs, Sheets, Lifecycle)

private struct AccountSettingsAlertsModifier: ViewModifier {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var state: AccountSettingsState
    let onDismiss: () -> Void
    let onDisconnectComputer: () async -> Void
    let onRemoveBrowser: (RelayBrowserSession) async -> Void
    let onUnpairHost: (RelayPairedNode) -> Void

    func body(content: Content) -> some View {
        content
            .alert(
                state.activeAlert?.title ?? "",
                isPresented: Binding(
                    get: { state.activeAlert != nil },
                    set: { if !$0 { state.activeAlert = nil } }
                ),
                presenting: state.activeAlert
            ) { alert in
                switch alert {
                case .deleteAccount:
                    if accountStore.user?.usesPassword == true {
                        SecureField("Current password", text: $state.deletionPassword)
                    }
                    Button("Delete account", role: .destructive) {
                        Task {
                            let didDelete = await accountStore.deleteAccount(
                                password: accountStore.user?.usesPassword == true
                                    ? state.deletionPassword
                                    : nil
                            )
                            if didDelete { onDismiss() }
                        }
                    }
                    Button("Cancel", role: .cancel) {}
                case .renameHost(let host):
                    TextField("Host name", text: $state.renameHostDraft)
                    Button("Save") {
                        nodeStore.renameHost(id: host.nodeID, name: state.renameHostDraft)
                    }
                    Button("Cancel", role: .cancel) {}
                }
            } message: { alert in
                switch alert {
                case .deleteAccount:
                    Text("This action cannot be undone. Data on servers you own is not deleted.")
                case .renameHost:
                    EmptyView()
                }
            }
            .modifier(AccountSettingsDialogsModifier(
                nodeStore: nodeStore,
                computerLinkStore: computerLinkStore,
                powerModel: powerModel,
                state: state,
                onDisconnectComputer: onDisconnectComputer,
                onRemoveBrowser: onRemoveBrowser,
                onUnpairHost: onUnpairHost
            ))
    }
}

private struct AccountSettingsDialogsModifier: ViewModifier {
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var state: AccountSettingsState
    let onDisconnectComputer: () async -> Void
    let onRemoveBrowser: (RelayBrowserSession) async -> Void
    let onUnpairHost: (RelayPairedNode) -> Void

    @MainActor
    private var confirmationTitle: String {
        switch state.activeConfirmation {
        case .disconnectComputer:
            return "Disconnect \(computerLinkStore.computer.map(AccountSettingsHelpers.computerName) ?? "computer")?"
        case .removeBrowser(let browser):
            return "Remove \(AccountSettingsHelpers.browserName(browser))?"
        case .unpairHost(let host):
            return "Unpair \(host.nodeName)?"
        case .stopMachine:
            return "Stop \(nodeStore.pairedNode?.nodeName ?? "this machine")?"
        case nil:
            return ""
        }
    }

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                confirmationTitle,
                isPresented: Binding(
                    get: { state.activeConfirmation != nil },
                    set: { if !$0 { state.activeConfirmation = nil } }
                ),
                titleVisibility: .visible,
                presenting: state.activeConfirmation
            ) { confirmation in
                switch confirmation {
                case .disconnectComputer:
                    Button("Disconnect computer", role: .destructive) {
                        Task { await onDisconnectComputer() }
                    }
                    Button("Cancel", role: .cancel) {}
                case .removeBrowser(let browser):
                    Button("Remove", role: .destructive) {
                        Task { await onRemoveBrowser(browser) }
                    }
                    Button("Cancel", role: .cancel) {}
                case .unpairHost(let host):
                    Button("Unpair", role: .destructive) {
                        onUnpairHost(host)
                    }
                    Button("Cancel", role: .cancel) {}
                case .stopMachine:
                    Button("Stop machine", role: .destructive) {
                        Task { await powerModel.stop() }
                    }
                    Button("Cancel", role: .cancel) {}
                }
            } message: { confirmation in
                switch confirmation {
                case .disconnectComputer:
                    Text("Relay will revoke this computer’s CLI access and hide its folders on this phone. Files on the Relay machine are not deleted.")
                case .removeBrowser:
                    Text("That browser will be signed out.")
                case .unpairHost:
                    Text("This phone forgets the machine and deletes the credential it was issued. To retire that credential on the machine too, run `relayd devices revoke` there. Nothing else on the machine is deleted; run `relayd pair` again to reconnect.")
                case .stopMachine:
                    Text("Runs stop. Pairing stays on disk. Start it again from this phone when you need it.")
                }
            }
    }
}

private struct AccountSettingsSheetsModifier: ViewModifier {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let codexClient: CodexClient
    let authClient: RelayAuthClient
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    let onReloadHarnesses: () async -> Void
    let onReloadLinkedComputer: () async -> Void
    let onPairingDismissed: () async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    func body(content: Content) -> some View {
        content
            .interactiveDismissDisabled(accountStore.isWorking)
            .overlay {
                if accountStore.isWorking {
                    ZStack {
                        Color.black.opacity(0.28).ignoresSafeArea()
                        ProgressView().tint(theme.accent)
                    }
                }
            }
            .sheet(item: $state.activeSheet, onDismiss: handleSheetDismiss) { sheet in
                AccountSettingsSheetContent(
                    sheet: sheet,
                    accountStore: accountStore,
                    nodeStore: nodeStore,
                    identityStore: identityStore,
                    codexClient: codexClient,
                    authClient: authClient,
                    themeStore: themeStore,
                    onDismissSheet: { state.activeSheet = nil }
                )
            }
    }

    @MainActor
    private func handleSheetDismiss() {
        let dismissed = state.lastPresentedSheet
        state.lastPresentedSheet = nil
        switch dismissed {
        case .providerLogin:
            Task { await onReloadHarnesses() }
        case .cliLink:
            Task { await onReloadLinkedComputer() }
        case .pairing:
            Task { await onPairingDismissed() }
        case .signIn, .diagnostics, .none:
            break
        }
    }
}

private struct AccountSettingsSheetContent: View {
    let sheet: AccountSettingsSheet
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let codexClient: CodexClient
    let authClient: RelayAuthClient
    @ObservedObject var themeStore: RelayThemeStore
    let onDismissSheet: () -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        switch sheet {
        case .providerLogin(let provider):
            ProviderLoginView(client: codexClient, provider: provider)
                .environment(\.relayTheme, theme)
        case .signIn:
            NavigationStack {
                AuthenticationView(accountStore: accountStore)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Cancel") { onDismissSheet() }
                        }
                    }
            }
            .environment(\.relayTheme, theme)
            .preferredColorScheme(theme.colorScheme)
        case .pairing:
            NodePairingView(
                identityStore: identityStore,
                nodeStore: nodeStore,
                accountStore: accountStore,
                authClient: authClient,
                onDismiss: onDismissSheet
            )
            .environment(\.relayTheme, theme)
            .preferredColorScheme(theme.colorScheme)
        case .diagnostics:
            DiagnosticsView(
                identityStore: identityStore,
                nodeStore: nodeStore
            )
            .environment(\.relayTheme, theme)
        case .cliLink:
            if let bearer = accountStore.currentSessionToken {
                CLILinkScannerView(
                    authClient: RelayAuthClient(baseURL: AppConfiguration.authBaseURL),
                    bearerToken: bearer
                )
                .environment(\.relayTheme, theme)
            } else {
                Color.clear
                    .onAppear { onDismissSheet() }
            }
        }
    }
}

private struct AccountSettingsLifecycleModifier: ViewModifier {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var state: AccountSettingsState
    let agentsMachineState: AgentsLoadTrigger.Machine
    let onLoadLinkedComputer: (Bool) async -> Void
    let onRefreshHarnesses: () async -> Void

    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: accountStore.user?.id) { _, id in
                if id != nil, case .signIn? = state.activeSheet {
                    state.activeSheet = nil
                }
                Task { await onLoadLinkedComputer(true) }
            }
            .task {
                await onLoadLinkedComputer(true)
            }
            // Waits for the first power read, and reloads when the machine
            // comes up: a stopped machine is not asked, and is never powered
            // on just to fill this section.
            .task(id: AgentsLoadTrigger(
                hasMachine: nodeStore.hasMachine,
                activeHostID: nodeStore.activeHostID,
                machine: agentsMachineState
            )) {
                await onRefreshHarnesses()
            }
            .task(id: computerLinkStore.computer?.id) {
                guard computerLinkStore.computer?.status == .connecting else { return }
                for _ in 0..<30 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard !Task.isCancelled else { return }
                    await onLoadLinkedComputer(false)
                    if computerLinkStore.computer?.status != .connecting { return }
                }
            }
            .task(id: identityStore.wakeCredential()?.nodeID) {
                await powerModel.refresh()
            }
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                await powerModel.watch()
            }
            .task(id: powerModel.resize?.stage) {
                await powerModel.waitForResize()
            }
            .modifier(RelayResizeProgressPresenter(model: powerModel))
    }
}

// MARK: - Section 1: Hosts

private struct AccountSettingsHostsSection: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let codexClient: CodexClient
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    let onSwitchHost: (RelayPairedNode) -> Void
    let onRegisterMachine: (RelayPairedNode) async -> Void
    let onLoadHarnesses: () async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        RelaySettingsSection("Hosts", info: AccountSettingsHelpers.machineInfo(for: nodeStore.pairedNode)) {
            VStack(alignment: .leading, spacing: 10) {
                if !nodeStore.hosts.isEmpty {
                    ForEach(nodeStore.hosts) { host in
                        let isActive = host.nodeID == nodeStore.activeHostID
                        NavigationLink {
                            AccountSettingsHostDetailView(
                                host: host,
                                accountStore: accountStore,
                                nodeStore: nodeStore,
                                identityStore: identityStore,
                                codexClient: codexClient,
                                powerModel: powerModel,
                                themeStore: themeStore,
                                state: state,
                                onSwitchHost: onSwitchHost,
                                onRegisterMachine: onRegisterMachine,
                                onLoadHarnesses: onLoadHarnesses
                            )
                        } label: {
                            AccountSettingsHostCard(
                                host: host,
                                isActive: isActive,
                                showActiveCheck: isActive && nodeStore.hosts.count > 1,
                                statusBucket: AccountSettingsHelpers.hostStatusBucket(
                                    isActive: isActive,
                                    hasMachine: nodeStore.hasMachine,
                                    powerStatus: powerModel.status
                                )
                            )
                        }
                        .buttonStyle(.plain)
                        .contextMenu {
                            if !isActive {
                                Button {
                                    onSwitchHost(host)
                                } label: {
                                    Label("Switch to host", systemImage: "checkmark.circle")
                                }
                            }
                            Button {
                                state.renameHostDraft = host.nodeName
                                state.activeAlert = .renameHost(host)
                            } label: {
                                Label("Rename", systemImage: "pencil")
                            }
                            Divider()
                            Button(role: .destructive) {
                                state.activeConfirmation = .unpairHost(host)
                            } label: {
                                Label("Unpair machine", systemImage: "trash")
                            }
                        }
                    }
                } else if AppConfiguration.hasConfiguredPersonalInstall {
                    NavigationLink {
                        AccountSettingsPersonalInstallDetailView(
                            nodeStore: nodeStore,
                            identityStore: identityStore,
                            codexClient: codexClient,
                            powerModel: powerModel,
                            themeStore: themeStore,
                            state: state,
                            onLoadHarnesses: onLoadHarnesses
                        )
                    } label: {
                        AccountSettingsPersonalInstallHostCard(
                            statusBucket: AccountSettingsHelpers.activePowerStatusBucket(
                                hasMachine: nodeStore.hasMachine,
                                powerStatus: powerModel.status
                            )
                        )
                    }
                    .buttonStyle(.plain)
                }

                if identityStore.wakeCredential() != nil || powerModel.status != .unavailable {
                    RelaySettingsCard {
                        RelayMachinePowerSwitch(
                            model: powerModel,
                            confirmStop: { state.activeConfirmation = .stopMachine },
                            accessibilityIdentifier: "relay-settings-hosts-power"
                        )
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)

                        RelaySettingsDivider()

                        RelayMachineSizeControl(model: powerModel)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)

                        if powerModel.autoStopEnabled != nil || !powerModel.status.isResolved {
                            RelaySettingsDivider()
                            RelayMachineAutoStopToggle(model: powerModel)
                                .padding(.horizontal, 16)
                                .padding(.vertical, 12)
                        }
                    }
                }

                // Paseo "+ Add connection" outlined card action
                Button {
                    state.activeSheet = .pairing
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .medium))
                        Text("Add connection")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                    }
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(maxWidth: .infinity)
                    .frame(height: 50)
                    .background(theme.surface0, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
                    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(RelaySettingsCardPressStyle(highlight: theme.interactionHighlight))
                .accessibilityIdentifier("relay-settings-pair")
            }
        }
    }
}

private struct AccountSettingsHostCard: View {
    let host: RelayPairedNode
    let isActive: Bool
    let showActiveCheck: Bool
    let statusBucket: RelayStatusBucket
    @Environment(\.relayTheme) private var theme

    var body: some View {
        RelaySettingsCard {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(host.nodeName)
                        .font(RelayTheme.uiFont(15, weight: .regular))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)
                        .truncationMode(.tail)

                    if let hostAddress = host.apiBaseURL.host?.trimmedNonEmpty,
                       hostAddress.caseInsensitiveCompare(host.nodeName) != .orderedSame {
                        Text(hostAddress)
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 10) {
                    if showActiveCheck {
                        Image(systemName: "checkmark")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(theme.accentBright)
                            .accessibilityLabel("Active host")
                    }

                    RelayStatusDot(bucket: statusBucket, size: 7)

                    Image(systemName: AccountSettingsHelpers.isLocalHost(host.apiBaseURL) ? "desktopcomputer" : "globe")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)

                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
    }
}

private struct AccountSettingsPersonalInstallHostCard: View {
    let statusBucket: RelayStatusBucket
    @Environment(\.relayTheme) private var theme

    var body: some View {
        RelaySettingsCard {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Linked computer")
                        .font(RelayTheme.uiFont(15, weight: .regular))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)

                    Text(AppConfiguration.codexBaseURL.host ?? AppConfiguration.codexBaseURL.absoluteString)
                        .font(RelayTheme.uiFont(12, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 10) {
                    RelayStatusDot(bucket: statusBucket, size: 7)
                    Image(systemName: AccountSettingsHelpers.isLocalHost(AppConfiguration.codexBaseURL) ? "desktopcomputer" : "globe")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                    Image(systemName: "gearshape")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
    }
}

// MARK: - Host Detail Destinations

private struct AccountSettingsHostDetailView: View {
    let host: RelayPairedNode
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let codexClient: CodexClient
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    let onSwitchHost: (RelayPairedNode) -> Void
    let onRegisterMachine: (RelayPairedNode) async -> Void
    let onLoadHarnesses: () async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        let liveHost = nodeStore.host(id: host.nodeID) ?? host
        let isActive = liveHost.nodeID == nodeStore.activeHostID

        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                identitySection(liveHost: liveHost, isActive: isActive)

                if isActive && identityStore.wakeCredential() != nil {
                    powerAndComputeSection
                }

                if isActive {
                    monitoringSection(liveHost: liveHost)

                    AccountSettingsCodingAgentsSection(
                        nodeStore: nodeStore,
                        powerModel: powerModel,
                        state: state,
                        onLoadHarnesses: onLoadHarnesses
                    )
                }

                accountRegistrationSection(liveHost: liveHost)
                dangerZoneSection(liveHost: liveHost)
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(theme.surface0.ignoresSafeArea())
        .navigationTitle(liveHost.nodeName)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func identitySection(liveHost: RelayPairedNode, isActive: Bool) -> some View {
        RelaySettingsSection("Host") {
            RelaySettingsCard {
                HStack(spacing: 12) {
                    RelayProjectIcon(
                        name: liveHost.nodeName,
                        seed: liveHost.nodeID,
                        colorIndex: liveHost.colorIndex,
                        size: 28
                    )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(liveHost.nodeName)
                            .font(RelayTheme.uiFont(16, weight: .medium))
                            .foregroundStyle(theme.foreground)
                        Text(liveHost.registeredAccountID == nil ? "Paired to this phone" : "Connected to your account")
                            .font(RelayTheme.uiFont(13, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    RelayStatusBadge(
                        isActive ? "Active" : "Standby",
                        bucket: AccountSettingsHelpers.hostStatusBucket(
                            isActive: isActive,
                            hasMachine: nodeStore.hasMachine,
                            powerStatus: powerModel.status
                        ),
                        showsDot: true,
                        compact: true
                    )
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                if !isActive {
                    RelaySettingsDivider()
                    HStack {
                        RelayButton("Switch to this host", variant: .primary, size: .sm, isFullWidth: true) {
                            onSwitchHost(liveHost)
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                }

                RelaySettingsDivider()

                RelaySettingsRow(
                    "Rename host",
                    subtitle: liveHost.nodeName,
                    systemImage: "pencil",
                    action: {
                        state.renameHostDraft = liveHost.nodeName
                        state.activeAlert = .renameHost(liveHost)
                    }
                ) {
                    RelayButton("Rename", variant: .outline, size: .sm) {
                        state.renameHostDraft = liveHost.nodeName
                        state.activeAlert = .renameHost(liveHost)
                    }
                }

                RelaySettingsDivider()
                AccountSettingsHostColorPickerRow(host: liveHost, nodeStore: nodeStore)
                RelaySettingsDivider()
                AccountSettingsConnectionDetailsRow(url: liveHost.apiBaseURL)
            }
        }
    }

    private var powerAndComputeSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            RelayFormHeader("Power & compute", info: "Control EC2 power, instance compute tier, and idle auto-stop directly from this phone.")
                .font(RelayTheme.uiFont(13, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
                .padding(.horizontal, 4)

            RelaySettingsCard {
                RelayMachinePowerSwitch(
                    model: powerModel,
                    confirmStop: { state.activeConfirmation = .stopMachine },
                    accessibilityIdentifier: "relay-settings-power"
                )
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                RelaySettingsDivider()

                RelayMachineSizeControl(model: powerModel)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)

                if powerModel.autoStopEnabled != nil || !powerModel.status.isResolved {
                    RelaySettingsDivider()
                    RelayMachineAutoStopToggle(model: powerModel)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                }

                if let notice = powerModel.notice {
                    RelaySettingsDivider()
                    RelayInlineNotice(text: notice)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                }
            }
        }
        .padding(.bottom, 24)
    }

    private func monitoringSection(liveHost: RelayPairedNode) -> some View {
        RelaySettingsSection("Monitoring") {
            RelaySettingsCard {
                NavigationLink {
                    RelayMachineMonitorView(
                        client: codexClient,
                        identityStore: identityStore,
                        powerModel: powerModel,
                        machineName: liveHost.nodeName
                    )
                } label: {
                    RelaySettingsRow(
                        "Machine monitor",
                        subtitle: "CPU, memory, disk and active runs",
                        systemImage: "gauge.with.dots.needle.67percent",
                        showsChevron: true
                    )
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func accountRegistrationSection(liveHost: RelayPairedNode) -> some View {
        RelaySettingsSection("Relay account") {
            RelaySettingsCard {
                if liveHost.registeredAccountID == nil {
                    RelaySettingsRow(
                        accountStore.user == nil
                            ? "Sign in to connect this machine"
                            : "Connect this machine to your account",
                        subtitle: "Enables laptop handoff and push alerts for this host",
                        systemImage: "person.badge.plus",
                        action: {
                            if accountStore.user == nil {
                                state.activeSheet = .signIn
                            } else {
                                Task { await onRegisterMachine(liveHost) }
                            }
                        }
                    ) {
                        if state.isRegisteringMachine {
                            ProgressView().controlSize(.small)
                        } else {
                            RelayButton(
                                accountStore.user == nil ? "Sign in" : "Connect",
                                variant: .outline,
                                size: .sm
                            ) {
                                if accountStore.user == nil {
                                    state.activeSheet = .signIn
                                } else {
                                    Task { await onRegisterMachine(liveHost) }
                                }
                            }
                            .disabled(state.isRegisteringMachine)
                        }
                    }
                    .accessibilityIdentifier("relay-settings-register-machine")
                } else {
                    RelaySettingsRow(
                        "Connected to Relay account",
                        subtitle: "`relay handoff` and push alerts reach this phone",
                        systemImage: "checkmark.circle",
                        iconColor: theme.statusSuccess
                    )
                }

                if let machineNotice = state.machineNotice {
                    RelaySettingsDivider()
                    RelayInlineNotice(text: machineNotice)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 10)
                }
            }
        }
    }

    private func dangerZoneSection(liveHost: RelayPairedNode) -> some View {
        RelaySettingsSection("Danger zone", flush: true) {
            RelaySettingsCard {
                RelaySettingsRow(
                    "Unpair machine",
                    subtitle: "Forgets this host and deletes its credential on this phone"
                ) {
                    RelayButton("Unpair", variant: .outline, size: .sm) {
                        state.activeConfirmation = .unpairHost(liveHost)
                    }
                    .accessibilityIdentifier("relay-settings-unpair")
                }
            }
        }
    }
}

private struct AccountSettingsPersonalInstallDetailView: View {
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let codexClient: CodexClient
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    let onLoadHarnesses: () async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                RelaySettingsSection("Host") {
                    RelaySettingsCard {
                        RelaySettingsRow(
                            "Linked computer",
                            subtitle: "Configured via support settings",
                            systemImage: "desktopcomputer"
                        ) {
                            RelayStatusBadge(
                                "Active",
                                bucket: AccountSettingsHelpers.activePowerStatusBucket(
                                    hasMachine: nodeStore.hasMachine,
                                    powerStatus: powerModel.status
                                ),
                                showsDot: true,
                                compact: true
                            )
                        }

                        RelaySettingsDivider()
                        AccountSettingsConnectionDetailsRow(url: AppConfiguration.codexBaseURL)
                    }
                }

                RelaySettingsSection("Monitoring") {
                    RelaySettingsCard {
                        NavigationLink {
                            RelayMachineMonitorView(
                                client: codexClient,
                                identityStore: identityStore,
                                powerModel: powerModel,
                                machineName: "Linked computer"
                            )
                        } label: {
                            RelaySettingsRow(
                                "Machine monitor",
                                subtitle: "CPU, memory, disk and active runs",
                                systemImage: "gauge.with.dots.needle.67percent",
                                showsChevron: true
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }

                AccountSettingsCodingAgentsSection(
                    nodeStore: nodeStore,
                    powerModel: powerModel,
                    state: state,
                    onLoadHarnesses: onLoadHarnesses
                )
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(theme.surface0.ignoresSafeArea())
        .navigationTitle("Linked computer")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AccountSettingsHostColorPickerRow: View {
    let host: RelayPairedNode
    @ObservedObject var nodeStore: RelayNodeStore
    @Environment(\.relayTheme) private var theme

    var body: some View {
        let activeIndex = host.colorIndex ?? RelayIdentityColor.index(for: host.nodeID)
        VStack(alignment: .leading, spacing: 10) {
            Text("Identity color")
                .font(RelayTheme.uiFont(14, weight: .regular))
                .foregroundStyle(theme.foreground)

            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(0..<RelayIdentityColor.count, id: \.self) { index in
                        let selected = activeIndex == index
                        Button {
                            nodeStore.setHostColor(id: host.nodeID, colorIndex: index)
                        } label: {
                            Circle()
                                .fill(RelayIdentityColor.color(at: index))
                                .frame(width: 24, height: 24)
                                .overlay {
                                    if selected {
                                        Circle()
                                            .strokeBorder(Color.white, lineWidth: 2)
                                            .padding(2)
                                    }
                                }
                                .frame(width: 32, height: 32)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(RelayIdentityColor.names[index])
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

private struct AccountSettingsConnectionDetailsRow: View {
    let url: URL
    @Environment(\.relayTheme) private var theme

    var body: some View {
        DisclosureGroup {
            Text(url.absoluteString)
                .font(RelayTheme.monoFont(13, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
                .padding(.bottom, 4)
        } label: {
            Text("Connection details")
                .font(RelayTheme.uiFont(14, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
        }
        .tint(theme.foregroundMuted)
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
}

// MARK: - Section 2: Appearance

private struct AccountSettingsAppearanceSection: View {
    @ObservedObject var themeStore: RelayThemeStore

    private var theme: RelayThemePalette { themeStore.palette }

    private static let orderedThemes: [RelayThemeID] = [
        .light, .paseoDark, .zinc, .midnight, .claude, .ghostty, .pureBlack, .ember
    ]

    var body: some View {
        RelaySettingsSection("Appearance") {
            RelaySettingsCard {
                // Theme row with live 8-theme horizontal swatches
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .center, spacing: 12) {
                        Text("Theme")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(theme.foreground)

                        Spacer()

                        Text(themeStore.selectedTheme.displayName)
                            .font(RelayTheme.uiFont(13, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }

                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Self.orderedThemes) { themeID in
                                themeSwatchPill(themeID)
                            }
                        }
                        .padding(.vertical, 2)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                RelaySettingsDivider()

                // Interface text size (14 / 15 / 16)
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Interface size")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(theme.foreground)
                        Text("Scales labels, lists and controls")
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 4) {
                        ForEach(RelayThemeStore.interfaceFontSizeOptions, id: \.self) { size in
                            let selected = Int(themeStore.interfaceFontSize.rounded()) == Int(size.rounded())
                            Button {
                                themeStore.interfaceFontSize = size
                            } label: {
                                Text("\(Int(size))")
                                    .font(RelayTheme.monoFont(12, weight: selected ? .medium : .regular))
                                    .foregroundStyle(selected ? theme.foreground : theme.foregroundMuted)
                                    .frame(width: 34, height: 30)
                                    .background(
                                        selected ? theme.surface3 : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3)
                    .background(theme.surface2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)

                RelaySettingsDivider()

                // Code size (11...15)
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Code size")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(theme.foreground)
                        Text("Diffs, files and terminal")
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    HStack(spacing: 2) {
                        Button {
                            themeStore.codeFontSize = max(
                                RelayThemeStore.codeFontSizeRange.lowerBound,
                                themeStore.codeFontSize - 1
                            )
                        } label: {
                            Image(systemName: "minus")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.plain)
                        .disabled(themeStore.codeFontSize <= RelayThemeStore.codeFontSizeRange.lowerBound)
                        .opacity(themeStore.codeFontSize <= RelayThemeStore.codeFontSizeRange.lowerBound ? 0.4 : 1)
                        .accessibilityLabel("Decrease code size")

                        Text("\(Int(themeStore.codeFontSize.rounded()))pt")
                            .font(RelayTheme.monoFont(12, weight: .medium))
                            .monospacedDigit()
                            .foregroundStyle(theme.foreground)
                            .frame(minWidth: 38)

                        Button {
                            themeStore.codeFontSize = min(
                                RelayThemeStore.codeFontSizeRange.upperBound,
                                themeStore.codeFontSize + 1
                            )
                        } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 12, weight: .medium))
                                .foregroundStyle(theme.foreground)
                                .frame(width: 30, height: 30)
                        }
                        .buttonStyle(.plain)
                        .disabled(themeStore.codeFontSize >= RelayThemeStore.codeFontSizeRange.upperBound)
                        .opacity(themeStore.codeFontSize >= RelayThemeStore.codeFontSizeRange.upperBound ? 0.4 : 1)
                        .accessibilityLabel("Increase code size")
                    }
                    .padding(3)
                    .background(theme.surface2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        }
    }

    private func themeSwatchPill(_ themeID: RelayThemeID) -> some View {
        let isSelected = themeStore.selectedTheme == themeID
        let previewPalette = themeID.palette

        return Button {
            withAnimation(.easeOut(duration: 0.16)) {
                themeStore.selectedTheme = themeID
            }
        } label: {
            HStack(spacing: 7) {
                ZStack {
                    Circle()
                        .fill(previewPalette.surface0)
                        .frame(width: 18, height: 18)
                        .overlay {
                            Circle()
                                .strokeBorder(previewPalette.borderAccent, lineWidth: 1)
                        }

                    Circle()
                        .fill(themeID.swatchColor)
                        .frame(width: 8, height: 8)
                }

                Text(themeID.displayName)
                    .font(RelayTheme.uiFont(13, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(isSelected ? theme.foreground : theme.foregroundMuted)
                    .lineLimit(1)
            }
            .padding(.horizontal, 10)
            .frame(height: 34)
            .background(
                isSelected ? theme.surface3 : theme.surface2.opacity(0.65),
                in: Capsule()
            )
            .overlay {
                Capsule()
                    .strokeBorder(isSelected ? theme.accentBright : theme.border, lineWidth: isSelected ? 1.2 : 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(themeID.displayName) theme")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

// MARK: - Section 3: Chat

private struct AccountSettingsChatSection: View {
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    let onLoadHarnesses: () async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    private var codingAgentsSummary: String {
        if AccountSettingsHelpers.agentsMachineState(powerModel: powerModel) == .down {
            let name = nodeStore.pairedNode?.nodeName ?? RelayMachineLabel.fallback
            return powerModel.status == .starting ? "Starting machine…" : "\(name) is off"
        }
        let installed = state.harnesses.filter(\.installed)
        if installed.isEmpty {
            return state.isLoadingHarnesses ? "Checking agents…" : "Manage Codex, Claude Code and provider sign-ins"
        }
        let connected = installed.filter { $0.loggedIn == true && $0.authRejection == nil }
        if connected.isEmpty {
            return "\(installed.count) installed · sign in from phone"
        }
        return connected.map(\.provider.displayName).joined(separator: ", ")
    }

    var body: some View {
        RelaySettingsSection(
            "Chat",
            info: "What happens when you send a message while the agent is running."
        ) {
            RelaySettingsCard {
                VStack(alignment: .leading, spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Send while running")
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(theme.foreground)
                        Text(themeStore.sendWhileRunning.subtitle)
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    HStack(spacing: 4) {
                        ForEach(RelaySendWhileRunningBehavior.allCases) { behavior in
                            let selected = themeStore.sendWhileRunning == behavior
                            Button {
                                themeStore.sendWhileRunning = behavior
                            } label: {
                                Text(behavior.title)
                                    .font(RelayTheme.uiFont(13, weight: selected ? .medium : .regular))
                                    .foregroundStyle(selected ? theme.foreground : theme.foregroundMuted)
                                    .frame(maxWidth: .infinity)
                                    .frame(height: 32)
                                    .background(
                                        selected ? theme.surface3 : Color.clear,
                                        in: RoundedRectangle(cornerRadius: 7, style: .continuous)
                                    )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(3)
                    .background(theme.surface2, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 9, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)

                if nodeStore.hasMachine {
                    RelaySettingsDivider()

                    NavigationLink {
                        AccountSettingsCodingAgentsDestination(
                            nodeStore: nodeStore,
                            powerModel: powerModel,
                            themeStore: themeStore,
                            state: state,
                            onLoadHarnesses: onLoadHarnesses
                        )
                    } label: {
                        RelaySettingsRow(
                            "Coding agents & sign-ins",
                            subtitle: codingAgentsSummary,
                            systemImage: "sparkles",
                            showsChevron: true
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct AccountSettingsCodingAgentsDestination: View {
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    let onLoadHarnesses: () async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                AccountSettingsCodingAgentsSection(
                    nodeStore: nodeStore,
                    powerModel: powerModel,
                    state: state,
                    onLoadHarnesses: onLoadHarnesses
                )
            }
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 32)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background(theme.surface0.ignoresSafeArea())
        .navigationTitle("Coding agents")
        .navigationBarTitleDisplayMode(.inline)
    }
}

private struct AccountSettingsCodingAgentsSection: View {
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var state: AccountSettingsState
    let onLoadHarnesses: () async -> Void

    @Environment(\.relayTheme) private var theme

    private var machineName: String {
        nodeStore.pairedNode?.nodeName ?? RelayMachineLabel.fallback
    }

    private var isMachineKnownDown: Bool {
        AccountSettingsHelpers.agentsMachineState(powerModel: powerModel) == .down
    }

    var body: some View {
        RelaySettingsSection("Coding agents", info: AccountSettingsHelpers.agentsInfo) {
            RelaySettingsCard {
                if isMachineKnownDown {
                    // Sign-in lives on the machine, so a machine that is off has no
                    // answer to give; an old "Connected" would be a guess.
                    Text(powerModel.status == .starting
                         ? "Starting \(RelayMachineLabel.inSentence(machineName)). Agents appear once it is up."
                         : "\(machineName) is off. Its agents and their sign-in show here once it is on.")
                        .font(RelayTheme.uiFont(14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .accessibilityIdentifier("relay-agents-machine-down")
                } else if state.isLoadingHarnesses && state.harnesses.isEmpty {
                    HStack(spacing: 10) {
                        ProgressView().controlSize(.small)
                        Text("Checking agents on your machine…")
                            .font(RelayTheme.uiFont(14, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 14)
                } else {
                    let installed = state.harnesses.filter(\.installed)
                    if installed.isEmpty && state.harnessError == nil {
                        Text("No coding agents reported by \(machineName).")
                            .font(RelayTheme.uiFont(14, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 14)
                    } else {
                        ForEach(Array(installed.enumerated()), id: \.element.id) { index, harness in
                            harnessRow(harness, showsTopDivider: index > 0)
                        }
                    }
                }

                if let harnessError = state.harnessError, !isMachineKnownDown {
                    if !state.harnesses.filter(\.installed).isEmpty {
                        RelaySettingsDivider()
                    }
                    RelayInlineNotice(text: harnessError, actionTitle: "Retry", isWorking: state.isLoadingHarnesses) {
                        Task { await onLoadHarnesses() }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                }
            }
        }
    }

    private func harnessRow(_ harness: RelayHarnessStatus, showsTopDivider: Bool) -> some View {
        VStack(spacing: 0) {
            if showsTopDivider {
                RelaySettingsDivider()
            }

            HStack(spacing: 12) {
                RelayProviderMark(provider: harness.provider, size: 17)

                VStack(alignment: .leading, spacing: 2) {
                    Text(harness.provider.displayName)
                        .font(RelayTheme.uiFont(15, weight: .regular))
                        .foregroundStyle(theme.foreground)
                    if harness.authRejection != nil {
                        // The provider turned the stored sign-in away on a real run,
                        // whatever the CLI's own status check still says.
                        Text("Sign-in expired")
                            .font(RelayTheme.uiFont(12, weight: .regular))
                            .foregroundStyle(theme.statusWarning)
                    }
                }

                Spacer()

                if harness.loggedIn == true {
                    // "Connected" is the CLI's own reading, and it cannot see a
                    // token the provider revoked; signing in again stays one tap away.
                    Menu {
                        Button("Sign in again") {
                            state.activeSheet = .providerLogin(harness.provider)
                        }
                    } label: {
                        HStack(spacing: 5) {
                            RelayStatusDot(
                                bucket: harness.authRejection != nil ? .needsInput : .done,
                                size: 6
                            )
                            Text("Connected")
                                .font(RelayTheme.uiFont(13, weight: .regular))
                            Image(systemName: "chevron.up.chevron.down")
                                .font(.system(size: 10, weight: .semibold))
                        }
                        .foregroundStyle(theme.foregroundMuted)
                    }
                    .accessibilityIdentifier("relay-agent-connected-\(harness.provider.rawValue)")
                } else {
                    RelayButton(
                        harness.loggedIn == false ? "Sign in" : "Check sign-in",
                        variant: .outline,
                        size: .sm
                    ) {
                        state.activeSheet = .providerLogin(harness.provider)
                    }
                    .accessibilityIdentifier("relay-agent-sign-in-\(harness.provider.rawValue)")
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 52)
        }
    }
}

// MARK: - Section 4: Account & Handoff

private struct AccountSettingsAccountSection: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    @ObservedObject var themeStore: RelayThemeStore
    @ObservedObject var state: AccountSettingsState
    var pushService: RelayPushService?
    let onDismiss: () -> Void
    let onLoadLinkedComputer: (Bool) async -> Void

    private var theme: RelayThemePalette { themeStore.palette }

    private var computerSummary: String {
        guard let linkedComputer = computerLinkStore.computer else {
            return "Scan QR from `relay login` or Sign in with iPhone"
        }
        switch linkedComputer.status {
        case .connecting:
            return "Link approved — finish `relay login` on your computer"
        case .connected:
            return "Scan QR to approve another computer or browser sign-in"
        }
    }

    var body: some View {
        RelaySettingsSection("Account & handoff", info: AccountSettingsHelpers.accountInfo) {
            VStack(alignment: .leading, spacing: 10) {
                RelaySettingsCard {
                    if let user = accountStore.user {
                        signedInAccountContent(user)
                    } else {
                        RelaySettingsRow(
                            "Sign in to Relay",
                            subtitle: "Optional — adds laptop handoff, push alerts and `relay login`",
                            systemImage: "person.badge.key",
                            showsChevron: true,
                            action: { state.activeSheet = .signIn }
                        )
                        .accessibilityIdentifier("relay-settings-sign-in")

                        if let pushService {
                            RelaySettingsDivider()
                            pushNotificationsRow(pushService)
                        }
                    }
                }

                if let error = state.signedInPlacesError ?? computerLinkStore.errorMessage {
                    RelayInlineNotice(text: error, actionTitle: "Retry", isWorking: computerLinkStore.isLoading) {
                        Task { await onLoadLinkedComputer(true) }
                    }
                    .padding(.horizontal, 4)
                }

                if let error = accountStore.errorMessage {
                    RelayInlineNotice(text: error)
                        .padding(.horizontal, 4)
                }
            }
        }
    }

    @ViewBuilder
    private func signedInAccountContent(_ user: RelayAccountUser) -> some View {
        RelaySettingsRow(
            user.preferredName,
            subtitle: user.email,
            systemImage: "person.circle"
        ) {
            Button {
                withAnimation(.easeOut(duration: 0.16)) {
                    state.showingAccountDetails.toggle()
                }
            } label: {
                Image(systemName: state.showingAccountDetails ? "chevron.up" : "chevron.down")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.foregroundExtraMuted)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Account details")
        }

        if state.showingAccountDetails {
            RelaySettingsDivider()
            VStack(alignment: .leading, spacing: 8) {
                if let username = user.username, !username.isEmpty {
                    detailPair("Username", value: username)
                }
                detailPair("Sign-in method", value: user.usesPassword ? "Username and password" : "Apple")
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }

        RelaySettingsDivider()

        if !computerLinkStore.hasLoaded && computerLinkStore.isLoading {
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Checking signed-in devices…")
                    .font(RelayTheme.uiFont(14, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
        } else {
            if let computer = computerLinkStore.computer {
                linkedComputerRow(computer)
                RelaySettingsDivider()
            }

            ForEach(state.browsers) { browser in
                browserRow(browser)
                RelaySettingsDivider()
            }

            RelaySettingsRow(
                "Approve a sign-in",
                subtitle: computerSummary,
                systemImage: "qrcode.viewfinder",
                showsChevron: true,
                action: { state.activeSheet = .cliLink }
            )
            .disabled(computerLinkStore.isLoading || computerLinkStore.isDisconnecting || state.isRemovingBrowser)
            .accessibilityIdentifier("relay-approve-sign-in")
        }

        if let pushService {
            RelaySettingsDivider()
            pushNotificationsRow(pushService)
        }

        RelaySettingsDivider()

        RelaySettingsRow(
            "Sign out",
            systemImage: "rectangle.portrait.and.arrow.right",
            action: {
                Task {
                    await accountStore.signOut()
                    onDismiss()
                }
            }
        )
        .disabled(accountStore.isWorking)

        RelaySettingsDivider()

        RelaySettingsRow(
            "Delete account",
            subtitle: AccountSettingsHelpers.securityInfo
        ) {
            RelayButton("Delete", variant: .outline, size: .sm, isDisabled: accountStore.isWorking) {
                state.deletionPassword = ""
                state.activeAlert = .deleteAccount
            }
            .accessibilityIdentifier("relay-delete-account")
        }
    }

    private func detailPair(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(RelayTheme.uiFont(13, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
            Spacer()
            Text(value)
                .font(RelayTheme.uiFont(13, weight: .regular))
                .foregroundStyle(theme.foreground)
                .textSelection(.enabled)
        }
    }

    private func pushNotificationsRow(_ service: RelayPushService) -> some View {
        RelaySettingsRow(
            "Push notifications",
            subtitle: service.isRegistered ? "Registered for handoff and run alerts" : "Enable in iOS Settings to receive alerts",
            systemImage: "bell"
        ) {
            RelayStatusBadge(
                service.isRegistered ? "Active" : "Off",
                bucket: service.isRegistered ? .done : .idle,
                showsDot: true,
                compact: true
            )
        }
    }

    private func linkedComputerRow(_ computer: CLIComputerLink) -> some View {
        let details = [
            computer.platform.map(AccountSettingsHelpers.platformLabel),
            AccountSettingsHelpers.computerStatus(computer),
            computer.connectedAt.map {
                "Connected " + AccountSettingsHelpers.computerDateFormatter.string(from: Date(timeIntervalSince1970: Double($0) / 1_000))
            }
        ].compactMap { $0 }.joined(separator: " · ")

        return RelaySettingsRow(
            AccountSettingsHelpers.computerName(computer),
            subtitle: details,
            systemImage: "laptopcomputer"
        ) {
            Menu {
                Button("Disconnect computer", role: .destructive) { state.activeConfirmation = .disconnectComputer }
                    .accessibilityIdentifier("relay-disconnect-computer")
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .medium))
                    .rotationEffect(.degrees(90))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 32, height: 32)
            }
            .disabled(computerLinkStore.isDisconnecting || state.isRemovingBrowser)
            .buttonStyle(.plain)
            .accessibilityLabel("Manage \(AccountSettingsHelpers.computerName(computer))")
        }
    }

    private func browserRow(_ browser: RelayBrowserSession) -> some View {
        let details = [
            browser.platform.map(AccountSettingsHelpers.platformLabel),
            "Signed in " + AccountSettingsHelpers.computerDateFormatter.string(from: Date(timeIntervalSince1970: Double(browser.createdAt) / 1_000))
        ].compactMap { $0 }.joined(separator: " · ")

        return RelaySettingsRow(
            AccountSettingsHelpers.browserName(browser),
            subtitle: details,
            systemImage: "globe"
        ) {
            Menu {
                Button("Remove", role: .destructive) { state.activeConfirmation = .removeBrowser(browser) }
                    .accessibilityIdentifier("relay-remove-browser")
            } label: {
                Image(systemName: "ellipsis")
                    .font(.system(size: 14, weight: .medium))
                    .rotationEffect(.degrees(90))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 32, height: 32)
            }
            .disabled(computerLinkStore.isDisconnecting || state.isRemovingBrowser)
            .buttonStyle(.plain)
            .accessibilityLabel("Manage \(AccountSettingsHelpers.browserName(browser))")
        }
    }
}

// MARK: - Section 5: Diagnostics

private struct AccountSettingsDiagnosticsSection: View {
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let codexClient: CodexClient
    @ObservedObject var powerModel: RelayMachinePowerModel
    @ObservedObject var state: AccountSettingsState
    var onOpenDiagnostics: (() -> Void)?
    var onOpenMachineMonitor: (() -> Void)?

    private var machineName: String {
        nodeStore.pairedNode?.nodeName ?? RelayMachineLabel.fallback
    }

    var body: some View {
        RelaySettingsSection("Diagnostics") {
            RelaySettingsCard {
                RelaySettingsRow(
                    "Diagnostics",
                    subtitle: "Link status, TLS pinning and runtime checks",
                    systemImage: "stethoscope",
                    showsChevron: true,
                    action: {
                        if let onOpenDiagnostics {
                            onOpenDiagnostics()
                        } else {
                            state.activeSheet = .diagnostics
                        }
                    }
                )

                if nodeStore.hasMachine {
                    RelaySettingsDivider()

                    if let onOpenMachineMonitor {
                        RelaySettingsRow(
                            "Machine usage",
                            subtitle: "Live CPU, memory, disk and power",
                            systemImage: "cpu",
                            showsChevron: true,
                            action: onOpenMachineMonitor
                        )
                        .accessibilityIdentifier("relay-settings-machine-usage")
                    } else {
                        NavigationLink {
                            RelayMachineMonitorView(
                                client: codexClient,
                                identityStore: identityStore,
                                powerModel: powerModel,
                                machineName: machineName
                            )
                        } label: {
                            RelaySettingsRow(
                                "Machine usage",
                                subtitle: "Live CPU, memory, disk and power",
                                systemImage: "cpu",
                                showsChevron: true
                            )
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("relay-settings-machine-usage")
                    }
                }
            }
        }
    }
}

// MARK: - Section 6: About

private struct AccountSettingsAboutSection: View {
    @ObservedObject var themeStore: RelayThemeStore

    private var theme: RelayThemePalette { themeStore.palette }

    private var versionText: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }

    var body: some View {
        RelaySettingsSection("About", flush: true) {
            RelaySettingsCard {
                RelaySettingsRow("Version") {
                    Text(versionText)
                        .font(RelayTheme.monoFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }

                settingsLinkRow("Privacy policy", url: "https://app.openrelay.sh/privacy")
                settingsLinkRow("Terms of use", url: "https://app.openrelay.sh/terms")
                settingsLinkRow("Support", url: "https://app.openrelay.sh/support")
            }
        }
    }

    private func settingsLinkRow(_ title: String, url: String) -> some View {
        VStack(spacing: 0) {
            RelaySettingsDivider()
            if let destination = URL(string: url) {
                Link(destination: destination) {
                    HStack(spacing: 12) {
                        Text(title)
                            .font(RelayTheme.uiFont(15, weight: .regular))
                            .foregroundStyle(theme.foreground)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .frame(minHeight: 50)
                    .contentShape(Rectangle())
                }
            }
        }
    }
}

// MARK: - Helpers

private enum AccountSettingsHelpers {
    static let accountInfo = "Optional. An account adds handoff from a laptop, push notifications, and approving `relay login` on a computer. Files, agents and terminals work without one."
    static let securityInfo = "Deletes your Relay account and device records. Files on servers you own are not deleted."
    static let agentsInfo = "Sign in to each agent right from this iPhone — no laptop needed. The session is stored on your machine, and `relay sync-auth` from a Mac still works too."

    static func machineInfo(for node: RelayPairedNode?) -> String {
        guard let node else {
            return "Run `relayd pair` on a computer or server you own and scan the code it prints."
        }
        if node.registeredAccountID == nil {
            return "Paired machines connect directly over TLS pinned to each machine's CA. Connecting to a Relay account is optional and adds laptop handoff and push alerts."
        }
        return "Connected to your Relay account, so `relay handoff` from a laptop and usage alerts reach this phone."
    }

    @MainActor
    static func agentsMachineState(powerModel: RelayMachinePowerModel) -> AgentsLoadTrigger.Machine {
        guard powerModel.canControl else { return .reachable }
        switch powerModel.status {
        case .loading: return .checking
        case .off, .starting, .stopping: return .down
        case .unknown, .unavailable, .on: return .reachable
        }
    }

    static func activePowerStatusBucket(
        hasMachine: Bool,
        powerStatus: RelayMachinePowerModel.Status
    ) -> RelayStatusBucket {
        guard hasMachine else { return .idle }
        switch powerStatus {
        case .on, .unknown, .unavailable: return .done
        case .starting, .stopping, .loading: return .needsInput
        case .off: return .error
        }
    }

    static func hostStatusBucket(
        isActive: Bool,
        hasMachine: Bool,
        powerStatus: RelayMachinePowerModel.Status
    ) -> RelayStatusBucket {
        isActive ? activePowerStatusBucket(hasMachine: hasMachine, powerStatus: powerStatus) : .idle
    }

    static func isLocalHost(_ url: URL) -> Bool {
        guard let host = url.host?.lowercased() else { return false }
        return host.hasSuffix(".local")
            || host == "localhost"
            || host == "127.0.0.1"
            || host == "::1"
            || host.hasPrefix("192.168.")
            || host.hasPrefix("10.")
    }

    static func computerName(_ computer: CLIComputerLink) -> String {
        guard let name = computer.machineName, !name.isEmpty else { return "Linked computer" }
        return name
    }

    static func browserName(_ browser: RelayBrowserSession) -> String {
        guard let name = browser.name, !name.isEmpty else { return "Browser" }
        return name
    }

    static func computerStatus(_ computer: CLIComputerLink) -> String {
        switch computer.status {
        case .connecting: return "Waiting for computer"
        case .connected: return "Connected"
        }
    }

    static func platformLabel(_ platform: String) -> String {
        switch platform {
        case "macos": return "macOS"
        case "linux": return "Linux"
        case "windows": return "Windows"
        case "web": return "Web"
        case "other": return "Other"
        default: return platform
        }
    }

    static let computerDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

/// What the coding-agents list is loaded against: a machine, active host, and what EC2 says about it.
private struct AgentsLoadTrigger: Equatable {
    enum Machine { case checking, down, reachable }
    var hasMachine: Bool
    var activeHostID: String?
    var machine: Machine
}

private struct RelaySettingsCardPressStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .overlay {
                if configuration.isPressed {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(highlight)
                }
            }
            .animation(.easeOut(duration: 0.10), value: configuration.isPressed)
    }
}

// MARK: - Shared Machine Power & Resize Controls (used by Settings and Machine Monitor)

struct RelayMachinePowerSwitch: View {
    @ObservedObject var model: RelayMachinePowerModel
    var onStarted: (() async -> Void)? = nil
    var confirmStop: () -> Void
    var accessibilityIdentifier: String
    /// Usage's compact header sets this false: the switch sits beside the
    /// machine name, so only the transient detail (Starting…) stays visible.
    var showsLabel = true

    @Environment(\.relayTheme) private var theme

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if showsLabel {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Power")
                        .font(RelayTheme.uiFont(15, weight: .regular))
                        .foregroundStyle(theme.foreground)
                    detailText
                }
                Spacer(minLength: 12)
            } else {
                detailText
            }
            if model.status.isBusy {
                ProgressView()
                    .controlSize(.small)
            }
            powerControl
        }
        .accessibilityElement(children: .contain)
        .animation(.default, value: model.status)
    }

    @ViewBuilder
    private var detailText: some View {
        if let detail = model.status.switchDetail {
            Text(detail)
                .font(RelayTheme.uiFont(13, weight: .regular))
                .foregroundStyle(
                    model.status == .unavailable ? theme.statusDanger : theme.foregroundMuted
                )
        }
    }

    private var canToggle: Bool {
        model.status.canToggle && !model.isSubmittingResize && model.resize?.isActive != true
    }

    /// The switch shows where the machine is, never where a tap would like it
    /// to be. A two-way Toggle moves the moment it is touched and is pulled
    /// back when the model disagrees (a stop waiting on its confirmation, a
    /// start that was refused), which read as the switch glitching. So the
    /// Toggle here only displays, and a tap is a request.
    ///
    /// Until the first read lands there is no position to show: the switch
    /// keeps its footprint and a spinner stands in for it, rather than
    /// starting at off and correcting itself a moment later.
    private var powerControl: some View {
        Toggle("Power", isOn: .constant(model.status.isPowered))
            .labelsHidden()
            .tint(theme.accent)
            .allowsHitTesting(false)
            .opacity(model.status.isResolved ? 1 : 0)
            .overlay {
                if model.status.isResolved {
                    Button(action: requestToggle) {
                        Color.clear.contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
            .disabled(!canToggle)
            .accessibilityRepresentation {
                Toggle("Power", isOn: Binding(
                    get: { model.status.isPowered },
                    set: { _ in requestToggle() }
                ))
                .disabled(!canToggle)
            }
            .accessibilityIdentifier(accessibilityIdentifier)
    }

    private func requestToggle() {
        guard canToggle else { return }
        if model.status == .on {
            confirmStop()
        } else {
            Task {
                await model.start()
                if model.status == .on {
                    await onStarted?()
                }
            }
        }
    }
}

/// Hidden until the control plane reports a value, so an older control plane
/// never shows a switch it cannot honour.
struct RelayMachineAutoStopToggle: View {
    @ObservedObject var model: RelayMachinePowerModel

    @Environment(\.relayTheme) private var theme

    var body: some View {
        if model.autoStopEnabled != nil || !model.status.isResolved {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-stop when idle")
                        .font(RelayTheme.uiFont(15, weight: .regular))
                        .foregroundStyle(theme.foreground)
                    Text(model.autoStopEnabled == false
                         ? "Stays on until you stop it."
                         : "Stops after an hour of low CPU and network.")
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
                Spacer(minLength: 12)
                if model.autoStopEnabled != nil {
                    if model.isSavingAutoStop {
                        ProgressView()
                            .controlSize(.small)
                    }
                    Toggle("Auto-stop when idle", isOn: Binding(
                        get: { model.autoStopEnabled ?? false },
                        set: { enabled in Task { await model.setAutoStop(enabled) } }
                    ))
                    .labelsHidden()
                    .tint(theme.accent)
                    .disabled(model.isSavingAutoStop)
                    .accessibilityIdentifier("relay-settings-autostop")
                } else {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityIdentifier("relay-settings-autostop")
                }
            }
            .accessibilityElement(children: .contain)
        }
    }
}

struct RelayMachineSizeControl: View {
    @ObservedObject var model: RelayMachinePowerModel
    @Environment(\.relayTheme) private var theme
    @State private var selectedIndex = 0
    @State private var showingConfirmation = false

    private var options: [String] { model.resizeOptions }
    private var selectedType: String? {
        options.indices.contains(selectedIndex) ? options[selectedIndex] : nil
    }
    private var currentHourly: Double? {
        model.instanceType.flatMap { model.pricing?.hourly(for: $0) }
    }
    private var currentMonthly: Double? {
        model.instanceType.flatMap { model.pricing?.monthly(for: $0) }
    }
    private var selectedMonthly: Double? {
        selectedType.flatMap { model.pricing?.monthly(for: $0) }
    }
    private var hoursPerMonth: Int { model.pricing?.hoursPerMonth ?? 730 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Instance type")
                    .font(RelayTheme.uiFont(15, weight: .regular))
                    .foregroundStyle(theme.foreground)
                Spacer()
                Text(model.instanceType ?? "Unavailable")
                    .font(RelayTheme.monoFont(13, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .accessibilityIdentifier("relay-instance-type")
            }

            if let currentHourly, let currentMonthly {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(monthlyPrice(currentMonthly))
                        .font(RelayTheme.uiFont(17, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    Text("/ month")
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                    Spacer(minLength: 8)
                    Text("\(hourlyPrice(currentHourly))/hr")
                        .font(RelayTheme.monoFont(12, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
                Text("EC2 compute · \(hoursPerMonth) running hours/month")
                    .font(RelayTheme.uiFont(12, weight: .regular))
                    .foregroundStyle(theme.foregroundExtraMuted)
            } else if model.instanceType != nil {
                Text("Compute price unavailable for this series and region")
                    .font(RelayTheme.uiFont(12, weight: .regular))
                    .foregroundStyle(theme.foregroundExtraMuted)
            }

            if model.isSubmittingResize {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Requesting size change…")
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
            } else if let resize = model.resize, resize.isActive {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Changing to \(resize.targetType) · \(stageText(resize.stage))")
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
            } else if options.count > 1 {
                HStack {
                    Text(options.first ?? "")
                    Spacer()
                    Text(options.last ?? "")
                }
                .font(RelayTheme.monoFont(12, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)

                Slider(value: Binding(
                    get: { Double(selectedIndex) },
                    set: { selectedIndex = Int($0.rounded()) }
                ), in: 0...Double(options.count - 1), step: 1)
                .tint(theme.accentBright)
                .accessibilityLabel("Machine size")
                .accessibilityValue(selectedType ?? "")
                .accessibilityIdentifier("relay-instance-size-slider")

                if let selectedType, selectedType != model.instanceType {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(selectedType)
                                .font(RelayTheme.uiFont(15, weight: .medium))
                                .foregroundStyle(theme.foreground)
                            if let selectedMonthly {
                                Text("\(monthlyPrice(selectedMonthly)) / month")
                                    .font(RelayTheme.uiFont(13, weight: .regular))
                                    .foregroundStyle(theme.foregroundMuted)
                            } else {
                                Text("Price temporarily unavailable")
                                    .font(RelayTheme.uiFont(13, weight: .regular))
                                    .foregroundStyle(theme.foregroundMuted)
                            }
                        }
                        Spacer(minLength: 6)
                        if let currentMonthly, let selectedMonthly {
                            Text(monthlyDifference(selectedMonthly - currentMonthly))
                                .font(RelayTheme.monoFont(12, weight: .medium))
                                .foregroundStyle(theme.accentBright)
                        }
                    }
                    .padding(.vertical, 2)

                    RelayButton(
                        "Change to \(selectedType)",
                        variant: .outline,
                        size: .sm,
                        isFullWidth: true,
                        isDisabled: model.isSubmittingResize
                    ) {
                        showingConfirmation = true
                    }
                }

                if model.pricing != nil {
                    Text("AWS Linux On-Demand estimate · storage, data and tax are extra")
                        .font(RelayTheme.uiFont(11, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .onAppear(perform: syncSelection)
        .onChange(of: model.instanceType) { _, _ in syncSelection() }
        .onChange(of: model.resizeOptions) { _, _ in syncSelection() }
        .confirmationDialog(
            "Change machine to \(selectedType ?? "this size")?",
            isPresented: $showingConfirmation,
            titleVisibility: .visible
        ) {
            if let target = selectedType, target != model.instanceType {
                Button(model.status == .off ? "Change size" : "Stop and change size") {
                    Task { await model.requestResize(to: target) }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(confirmationDetail)
        }
    }

    private func syncSelection() {
        selectedIndex = options.firstIndex(of: model.instanceType ?? "") ?? 0
    }

    private var confirmationDetail: String {
        let interruption = model.status == .off
            ? "The machine will remain stopped after the change."
            : "Running agent work will be interrupted while the machine stops and restarts."
        guard let currentMonthly, let selectedMonthly else {
            return "\(interruption) The compute price is temporarily unavailable."
        }
        return "\(interruption) EC2 compute at \(hoursPerMonth) running hours: \(monthlyPrice(currentMonthly)) → \(monthlyPrice(selectedMonthly)) per month (\(monthlyDifference(selectedMonthly - currentMonthly))). Storage and taxes are extra."
    }

    private func monthlyPrice(_ value: Double) -> String {
        price(value, minimumDigits: 2, maximumDigits: 2)
    }

    private func hourlyPrice(_ value: Double) -> String {
        price(value, minimumDigits: 2, maximumDigits: 5)
    }

    private func price(_ value: Double, minimumDigits: Int, maximumDigits: Int) -> String {
        let formatter = NumberFormatter()
        formatter.locale = Locale(identifier: "en_US")
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.minimumFractionDigits = minimumDigits
        formatter.maximumFractionDigits = maximumDigits
        return formatter.string(from: NSNumber(value: value)) ?? "$\(value)"
    }

    private func monthlyDifference(_ value: Double) -> String {
        "\(value >= 0 ? "+" : "−")\(monthlyPrice(abs(value)))/mo"
    }

    private func stageText(_ stage: String) -> String {
        switch stage {
        case "requested", "waiting_stop": return "stopping"
        case "modifying": return "changing size"
        case "waiting_start", "waiting_running": return "starting"
        case "recovering", "recovery_wait": return "restoring power"
        default: return "working"
        }
    }
}

struct RelayResizeProgressPresenter: ViewModifier {
    @ObservedObject var model: RelayMachinePowerModel
    @State private var isPresented = false

    func body(content: Content) -> some View {
        content
            .fullScreenCover(isPresented: $isPresented) {
                RelayMachineResizeProgressView(model: model)
                    .interactiveDismissDisabled()
                    .presentationBackground(.ultraThinMaterial)
            }
            .onAppear(perform: syncPresentation)
            .onChange(of: model.isSubmittingResize) { _, _ in syncPresentation() }
            .onChange(of: model.resize?.stage) { _, _ in syncPresentation() }
    }

    private func syncPresentation() {
        isPresented = model.isSubmittingResize || model.resize?.isActive == true
    }
}

private struct RelayMachineResizeProgressView: View {
    @ObservedObject var model: RelayMachinePowerModel
    @Environment(\.relayTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isAnimating = false

    private var stage: String { model.resize?.stage ?? "requested" }
    private var target: String { model.resize?.targetType ?? model.requestedResizeType ?? "new size" }
    private var wasRunning: Bool { model.resize?.wasRunning != false }
    private var isRecovering: Bool { stage == "recovering" || stage == "recovery_wait" }
    private var steps: [String] {
        if !wasRunning { return ["Preparing change", "Changing instance type"] }
        return ["Stopping machine", "Changing instance type", "Starting machine", "Waiting for machine"]
    }
    private var activeStep: Int {
        if !wasRunning { return stage == "modifying" ? 1 : 0 }
        switch stage {
        case "modifying": return 1
        case "waiting_start", "recovering": return 2
        case "waiting_running", "recovery_wait": return 3
        default: return 0
        }
    }

    var body: some View {
        ZStack {
            theme.surface0.opacity(0.92).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                RelayCapsLabel(text: "Relay · Machine", color: theme.accentBright, size: 11)
                Spacer(minLength: 28)

                ZStack {
                    Circle()
                        .stroke(theme.accentBright.opacity(0.18), lineWidth: 2)
                    Circle()
                        .trim(from: 0.06, to: 0.31)
                        .stroke(theme.accentBright, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(isAnimating ? 360 : 0))
                        .animation(reduceMotion ? nil : .linear(duration: 1.8).repeatForever(autoreverses: false), value: isAnimating)
                    Image(systemName: "server.rack")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(theme.foreground)
                }
                .frame(width: 94, height: 94)
                .accessibilityHidden(true)

                Text(stageTitle)
                    .font(RelayTheme.uiFont(30, weight: .semibold))
                    .foregroundStyle(theme.foreground)
                    .padding(.top, 30)
                Text(isRecovering
                     ? "The size change hit a problem. Relay is bringing your machine back."
                     : "Moving to \(target). Your machine will be unavailable during this change.")
                    .font(RelayTheme.uiFont(15, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 9)

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps.indices, id: \.self) { index in
                        HStack(spacing: 17) {
                            ZStack {
                                Circle()
                                    .stroke(index == activeStep ? theme.accentBright : theme.borderAccent, lineWidth: 1.5)
                                    .frame(width: 28, height: 28)
                                if index < activeStep {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(theme.foregroundMuted)
                                } else if index == activeStep {
                                    Circle()
                                        .fill(theme.accentBright)
                                        .frame(width: 7, height: 7)
                                }
                            }
                            Text(isRecovering && index == activeStep ? "Restoring power" : steps[index])
                                .font(RelayTheme.uiFont(15, weight: index == activeStep ? .medium : .regular))
                                .foregroundStyle(index == activeStep ? theme.foreground : theme.foregroundExtraMuted)
                            Spacer()
                        }
                        .frame(height: 54)
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(index == activeStep ? .updatesFrequently : [])
                    }
                }
                .padding(.top, 28)

                Spacer(minLength: 28)
                Text("This usually takes a few minutes. Relay is checking the machine as it changes.")
                    .font(RelayTheme.uiFont(13, weight: .regular))
                    .foregroundStyle(theme.foregroundExtraMuted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 28)
            .padding(.top, 36)
            .padding(.bottom, 38)
            .frame(maxWidth: 480, maxHeight: .infinity, alignment: .leading)
        }
        .tint(theme.accentBright)
        .preferredColorScheme(theme.colorScheme)
        .task(id: model.resize?.stage) {
            await model.waitForResize()
        }
        .onAppear { isAnimating = true }
    }

    private var stageTitle: String {
        if model.isSubmittingResize { return "Preparing size change" }
        switch stage {
        case "requested", "waiting_stop": return wasRunning ? "Stopping machine" : "Preparing machine"
        case "modifying": return "Changing instance type"
        case "waiting_start": return "Starting machine"
        case "waiting_running": return "Waiting for machine"
        case "recovering", "recovery_wait": return "Restoring machine power"
        default: return "Changing machine size"
        }
    }
}
