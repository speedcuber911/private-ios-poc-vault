import SwiftUI

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
    var showsDismissButton = true
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    @State private var showingDeleteConfirmation = false
    @State private var deletionPassword = ""
    @State private var showingCLILink = false
    @State private var showingSignIn = false
    @State private var showingPairing = false
    @State private var showingUnpairConfirmation = false
    @State private var isRegisteringMachine = false
    @State private var machineNotice: String?
    @State private var browsers: [RelayBrowserSession] = []
    @State private var isRemovingBrowser = false
    @State private var signedInPlacesError: String?
    @State private var showingDisconnectConfirmation = false
    @State private var browserToRemove: RelayBrowserSession?
    @State private var harnesses: [RelayHarnessStatus] = []
    @State private var isLoadingHarnesses = false
    @State private var harnessError: String?
    @State private var providerLoginRequest: CodexProvider?
    @State private var showingStopPower = false

    var body: some View {
        NavigationStack {
            Form {
                machineSection

                if accountStore.user == nil {
                    Section {
                        Button("Sign in to Relay") { showingSignIn = true }
                            .accessibilityIdentifier("relay-settings-sign-in")
                    } header: {
                        RelayFormHeader("Account", info: accountFooter)
                    }
                }

                if let user = accountStore.user {
                    Section("Account") {
                        LabeledContent("Name", value: user.preferredName)
                        LabeledContent("Email", value: user.email)
                        if let username = user.username, !username.isEmpty {
                            LabeledContent("Username", value: username)
                        }
                        LabeledContent(
                            "Sign-in method",
                            value: user.usesPassword ? "Username and password" : "Apple"
                        )
                    }

                    Section {
                        if !computerLinkStore.hasLoaded && computerLinkStore.isLoading {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Checking signed-in places…")
                                    .foregroundStyle(AppTheme.textSecondary)
                            }
                        } else {
                            if let linkedComputer = computerLinkStore.computer {
                                LabeledContent("Computer", value: computerName(linkedComputer))
                                LabeledContent("Status", value: computerStatus(linkedComputer))
                                if let platform = linkedComputer.platform {
                                    LabeledContent("Platform", value: platformLabel(platform))
                                }
                                if let connectedAt = linkedComputer.connectedAt {
                                    LabeledContent(
                                        "Connected",
                                        value: Self.computerDateFormatter.string(
                                            from: Date(timeIntervalSince1970: Double(connectedAt) / 1_000)
                                        )
                                    )
                                }

                                Button("Disconnect computer", role: .destructive) {
                                    showingDisconnectConfirmation = true
                                }
                                .disabled(computerLinkStore.isDisconnecting || isRemovingBrowser)
                                .accessibilityIdentifier("relay-disconnect-computer")
                            }

                            ForEach(browsers) { browser in
                                LabeledContent("Browser", value: browserName(browser))
                                if let platform = browser.platform {
                                    LabeledContent("Platform", value: platformLabel(platform))
                                }
                                LabeledContent(
                                    "Signed in",
                                    value: Self.computerDateFormatter.string(
                                        from: Date(timeIntervalSince1970: Double(browser.createdAt) / 1_000)
                                    )
                                )
                                Button("Remove", role: .destructive) {
                                    browserToRemove = browser
                                }
                                .disabled(computerLinkStore.isDisconnecting || isRemovingBrowser)
                                .accessibilityIdentifier("relay-remove-browser")
                            }

                            Button("Approve a sign-in") {
                                showingCLILink = true
                            }
                            .disabled(
                                computerLinkStore.isLoading
                                    || computerLinkStore.isDisconnecting
                                    || isRemovingBrowser
                            )
                            .accessibilityIdentifier("relay-approve-sign-in")
                        }

                        if let signedInError = signedInPlacesError ?? computerLinkStore.errorMessage {
                            Label(signedInError, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppTheme.statusError)

                            Button("Try again") {
                                Task { await loadLinkedComputer() }
                            }
                        }
                    } header: {
                        RelayFormHeader("Signed in", info: computerFooter)
                    }

                    Section {
                        Button("Sign out", role: .destructive) {
                            Task {
                                await accountStore.signOut()
                                dismiss()
                            }
                        }
                        .disabled(accountStore.isWorking)

                        Button("Delete account", role: .destructive) {
                            deletionPassword = ""
                            showingDeleteConfirmation = true
                        }
                        .disabled(accountStore.isWorking)
                        .accessibilityIdentifier("relay-delete-account")
                    } header: {
                        RelayFormHeader("Security", info: securityFooter)
                    }

                    if let error = accountStore.errorMessage {
                        Section {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppTheme.statusError)
                        }
                    }
                }

                if nodeStore.hasMachine {
                    codingAgentsSection
                }

                Section("About") {
                    LabeledContent("App", value: "Relay")
                    LabeledContent("Version", value: versionText)
                    Link("Privacy Policy", destination: URL(string: "https://app.openrelay.sh/privacy")!)
                    Link("Terms of Use", destination: URL(string: "https://app.openrelay.sh/terms")!)
                    Link("Support", destination: URL(string: "https://app.openrelay.sh/support")!)
                }
            }
            .scrollContentBackground(.hidden)
            .scrollBounceBehavior(.basedOnSize)
            .contentMargins(.bottom, showsDismissButton ? 0 : 56, for: .scrollContent)
            .refreshable {
                await loadLinkedComputer()
            }
            .background(AppTheme.bgCanvas)
            .tint(AppTheme.accent)
            .navigationTitle("Account & Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if showsDismissButton {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { dismiss() }
                    }
                }
            }
            .alert("Delete your Relay account?", isPresented: $showingDeleteConfirmation) {
                if accountStore.user?.usesPassword == true {
                    SecureField("Current password", text: $deletionPassword)
                }
                Button("Delete account", role: .destructive) {
                    Task {
                        let didDelete = await accountStore.deleteAccount(
                            password: accountStore.user?.usesPassword == true
                                ? deletionPassword
                                : nil
                        )
                        if didDelete { dismiss() }
                    }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This action cannot be undone. Data on servers you own is not deleted.")
            }
            .confirmationDialog(
                "Disconnect \(computerLinkStore.computer.map(computerName) ?? "computer")?",
                isPresented: $showingDisconnectConfirmation,
                titleVisibility: .visible
            ) {
                Button("Disconnect computer", role: .destructive) {
                    Task { await disconnectLinkedComputer() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Relay will revoke this computer’s CLI access and hide its folders on this phone. Files on the Relay machine are not deleted.")
            }
            .confirmationDialog(
                "Remove \(browserToRemove.map(browserName) ?? "browser")?",
                isPresented: Binding(
                    get: { browserToRemove != nil },
                    set: { if !$0 { browserToRemove = nil } }
                ),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    if let browserToRemove {
                        Task { await removeBrowser(browserToRemove) }
                    }
                }
                Button("Cancel", role: .cancel) {
                    browserToRemove = nil
                }
            } message: {
                Text("That browser will be signed out.")
            }
            .interactiveDismissDisabled(accountStore.isWorking)
            .overlay {
                if accountStore.isWorking {
                    ZStack {
                        Color.black.opacity(0.28).ignoresSafeArea()
                        ProgressView().tint(AppTheme.accent)
                    }
                }
            }
            .sheet(item: $providerLoginRequest, onDismiss: {
                Task { await loadHarnesses() }
            }) { provider in
                ProviderLoginView(client: codexClient, provider: provider)
            }
            .sheet(isPresented: $showingSignIn) {
                NavigationStack {
                    AuthenticationView(accountStore: accountStore)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                Button("Cancel") { showingSignIn = false }
                            }
                        }
                }
                .preferredColorScheme(.dark)
            }
            .onChange(of: accountStore.user?.id) { _, id in
                if id != nil { showingSignIn = false }
                Task { await loadLinkedComputer() }
            }
            .sheet(isPresented: $showingPairing) {
                NodePairingView(
                    identityStore: identityStore,
                    nodeStore: nodeStore,
                    accountStore: accountStore,
                    authClient: authClient,
                    onDismiss: { showingPairing = false }
                )
            }
            .confirmationDialog(
                "Unpair \(nodeStore.pairedNode?.nodeName ?? "this machine")?",
                isPresented: $showingUnpairConfirmation,
                titleVisibility: .visible
            ) {
                Button("Unpair", role: .destructive) { unpairMachine() }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This phone forgets the machine and deletes the credential it was issued. To retire that credential on the machine too, run `relayd devices revoke` there. Nothing else on the machine is deleted; run `relayd pair` again to reconnect.")
            }
            .confirmationDialog(
                "Stop \(nodeStore.pairedNode?.nodeName ?? "this machine")?",
                isPresented: $showingStopPower,
                titleVisibility: .visible
            ) {
                Button("Stop machine", role: .destructive) {
                    Task { await powerModel.stop() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Runs stop. Pairing stays on disk. Start it again from this phone when you need it.")
            }
            .sheet(isPresented: $showingCLILink, onDismiss: {
                Task { await loadLinkedComputer() }
            }) {
                if let bearer = accountStore.currentSessionToken {
                    CLILinkScannerView(
                        authClient: RelayAuthClient(baseURL: AppConfiguration.authBaseURL),
                        bearerToken: bearer
                    )
                }
            }
            .task {
                await loadLinkedComputer()
            }
            // Waits for the first power read, and reloads when the machine
            // comes up: a stopped machine is not asked, and is never powered
            // on just to fill this section.
            .task(id: AgentsLoadTrigger(hasMachine: nodeStore.hasMachine, machine: agentsMachineState)) {
                if agentsMachineState == .down {
                    harnesses = []
                    harnessError = nil
                }
                guard nodeStore.hasMachine, agentsMachineState == .reachable else { return }
                await loadHarnesses()
            }
            .task(id: computerLinkStore.computer?.id) {
                guard computerLinkStore.computer?.status == .connecting else { return }
                for _ in 0..<30 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard !Task.isCancelled else { return }
                    await loadLinkedComputer(showProgress: false)
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
        .preferredColorScheme(.dark)
    }

    private var codingAgentsSection: some View {
        Section {
            if isMachineKnownDown {
                // Sign-in lives on the machine, so a machine that is off has no
                // answer to give; an old "Connected" would be a guess.
                Text(powerModel.status == .starting
                     ? "Starting \(RelayMachineLabel.inSentence(machineName)). Agents appear once it is up."
                     : "\(machineName) is off. Its agents and their sign-in show here once it is on.")
                    .foregroundStyle(AppTheme.textSecondary)
                    .accessibilityIdentifier("relay-agents-machine-down")
            } else if isLoadingHarnesses && harnesses.isEmpty {
                HStack(spacing: 10) {
                    ProgressView()
                    Text("Checking agents on your machine…")
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }

            ForEach(isMachineKnownDown ? [] : harnesses.filter(\.installed)) { harness in
                harnessRow(harness)
            }

            if let harnessError, !isMachineKnownDown {
                Label(harnessError, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(AppTheme.statusError)

                Button("Try again") {
                    Task { await loadHarnesses() }
                }
            }
        } header: {
            RelayFormHeader("Coding agents", info: agentsFooter)
        }
    }

    private func harnessRow(_ harness: RelayHarnessStatus) -> some View {
        HStack(spacing: 10) {
            RelayProviderMark(provider: harness.provider, size: 16)
            VStack(alignment: .leading, spacing: 2) {
                Text(harness.provider.displayName)
                if harness.authRejection != nil {
                    // The provider turned the stored sign-in away on a real run,
                    // whatever the CLI's own status check still says.
                    Text("Sign-in expired")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.statusWarn)
                }
            }
            Spacer()
            if harness.loggedIn == true {
                // "Connected" is the CLI's own reading, and it cannot see a
                // token the provider revoked; signing in again stays one tap away.
                Menu {
                    Button("Sign in again") {
                        providerLoginRequest = harness.provider
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text("Connected")
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                    }
                    .foregroundStyle(AppTheme.textSecondary)
                }
                .accessibilityIdentifier("relay-agent-connected-\(harness.provider.rawValue)")
            } else {
                Button(harness.loggedIn == false ? "Sign in" : "Check sign-in") {
                    providerLoginRequest = harness.provider
                }
                .accessibilityIdentifier("relay-agent-sign-in-\(harness.provider.rawValue)")
            }
        }
    }

    private var machineName: String {
        nodeStore.pairedNode?.nodeName ?? RelayMachineLabel.fallback
    }

    private var computerFooter: String {
        guard let linkedComputer = computerLinkStore.computer else {
            return "Approve a sign-in scans the QR from Sign in with iPhone or `relay login`. Only one computer can be linked at a time; browsers are managed separately."
        }
        switch linkedComputer.status {
        case .connecting:
            return "Link approved. Finish `relay login` on the computer; Relay will mark it Connected when sign-in completes."
        case .connected:
            return "This computer can use the Relay CLI and hand off sessions. Each listed browser can use the web console; Remove signs only that browser out."
        }
    }

    private var versionText: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }

    /// Paired, and — separately — whether that machine is published to an
    /// account. Unregistered is a normal state, not a fault, so it is stated
    /// plainly and costs nothing else in the app.
    @ViewBuilder
    private var machineSection: some View {
        Section {
            if let node = nodeStore.pairedNode {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(node.nodeName)
                            .font(AppTheme.serifFont(size: 22))
                            .foregroundStyle(AppTheme.textPrimary)
                        Text(node.apiBaseURL.absoluteString)
                            .font(AppTheme.monoFont(size: 13))
                            .foregroundStyle(AppTheme.textSecondary)
                            .textSelection(.enabled)
                        Text(node.registeredAccountID == nil ? "Paired to this phone" : "Connected to your account")
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(AppTheme.textTertiary)
                    }

                    if identityStore.wakeCredential() != nil {
                        RelayMachinePowerSwitch(
                            model: powerModel,
                            confirmStop: { showingStopPower = true },
                            accessibilityIdentifier: "relay-settings-power"
                        )
                        RelayMachineSizeControl(model: powerModel)
                        RelayMachineAutoStopToggle(model: powerModel)
                        if let notice = powerModel.notice {
                            Text(notice)
                                .font(AppTheme.uiFont(size: 13))
                                .foregroundStyle(AppTheme.statusError)
                        }
                    }
                }
                .padding(.vertical, 4)

                NavigationLink {
                    RelayMachineMonitorView(
                        client: codexClient,
                        identityStore: identityStore,
                        powerModel: powerModel,
                        machineName: node.nodeName
                    )
                } label: {
                    Text("Usage")
                }
                .accessibilityIdentifier("relay-settings-machine-usage")

                if node.registeredAccountID == nil {
                    Button(accountStore.user == nil
                           ? "Sign in to connect this machine"
                           : "Connect this machine to your account") {
                        if accountStore.user == nil {
                            showingSignIn = true
                        } else {
                            Task { await registerMachine() }
                        }
                    }
                    .disabled(isRegisteringMachine)
                    .accessibilityIdentifier("relay-settings-register-machine")
                }

                if let machineNotice {
                    Label(machineNotice, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(AppTheme.statusError)
                }

                Button("Unpair machine", role: .destructive) {
                    showingUnpairConfirmation = true
                }
                .accessibilityIdentifier("relay-settings-unpair")
            } else if AppConfiguration.hasConfiguredPersonalInstall {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Linked computer")
                        .font(AppTheme.serifFont(size: 22))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(AppConfiguration.codexBaseURL.absoluteString)
                        .font(AppTheme.monoFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                    Text("support/vault-config.json")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                }
                .padding(.vertical, 4)
                NavigationLink {
                    RelayMachineMonitorView(
                        client: codexClient,
                        identityStore: identityStore,
                        powerModel: powerModel,
                        machineName: "Linked computer"
                    )
                } label: {
                    Text("Usage")
                }
                Button("Pair a machine") { showingPairing = true }
                    .accessibilityIdentifier("relay-settings-pair")
            } else {
                Button("Pair a machine") { showingPairing = true }
                    .accessibilityIdentifier("relay-settings-pair")
            }
        } header: {
            RelayFormHeader("Machine", info: machineFooter)
        }
    }

    private var machineFooter: String {
        guard let node = nodeStore.pairedNode else {
            return "Run `relayd pair` on a computer or server you own and scan the code it prints."
        }
        if node.registeredAccountID == nil {
            return "This machine is paired directly to this phone and fully usable. Usage and power are on this screen. It is not connected to a Relay account, so there is no handoff from a laptop and no push if the machine is under load or goes quiet — add those whenever you want them."
        }
        return "Connected to your Relay account, so `relay handoff` from a laptop and usage alerts reach this phone."
    }

    private var accountFooter: String {
        "Optional. An account adds handoff from a laptop, push notifications, and approving `relay login` on a computer. Files, agents and terminals work without one."
    }

    private var securityFooter: String {
        "Deleting removes your Relay account, registered devices, node records, entitlements, and this phone’s local Relay certificate. Files on servers you own are not deleted."
    }

    private var agentsFooter: String {
        "Sign in to each agent right from this iPhone — no laptop needed. The session is stored on your machine, and `relay sync-auth` from a Mac still works too."
    }

    private func registerMachine() async {
        guard let node = nodeStore.pairedNode else { return }
        isRegisteringMachine = true
        machineNotice = nil
        defer { isRegisteringMachine = false }
        machineNotice = await RelayNodeRegistration.register(
            node: node,
            accountStore: accountStore,
            nodeStore: nodeStore,
            client: authClient
        )
    }

    private func unpairMachine() {
        nodeStore.clear()
        // The machine is no longer this phone's, so its client certificate,
        // pinned CA and bearer token are dead weight — and must not outlive it.
        identityStore.discardPairedMaterial()
        machineNotice = nil
    }

    /// Whether the machine is worth asking about its agents. Without power
    /// control there is nothing to go on, so it is simply asked.
    private var agentsMachineState: AgentsLoadTrigger.Machine {
        guard powerModel.canControl else { return .reachable }
        switch powerModel.status {
        case .loading: return .checking
        case .off, .starting, .stopping: return .down
        case .unknown, .unavailable, .on: return .reachable
        }
    }

    /// EC2 says the machine is stopped or in motion, so a node request that
    /// fails is not news and the agents section has nothing to add.
    private var isMachineKnownDown: Bool { agentsMachineState == .down }

    private func loadHarnesses() async {
        guard nodeStore.hasMachine, !isMachineKnownDown else { return }
        isLoadingHarnesses = true
        harnessError = nil
        defer { isLoadingHarnesses = false }
        do {
            harnesses = try await codexClient.fetchHarnesses(budget: .statusRead)
        } catch {
            // A load replaced by a newer one is not a failure to report.
            guard !Task.isCancelled else { return }
            // Just started: relayd comes up some seconds after EC2 says
            // running, so ask again rather than reporting that gap.
            if powerModel.isWarmingUp {
                try? await Task.sleep(for: .seconds(4))
                if !Task.isCancelled { await loadHarnesses() }
                return
            }
            // What the machine said last time is not what it says now: an
            // old "Connected" next to this error would be a guess.
            harnesses = []
            harnessError = "Relay couldn't check the agents on your machine."
        }
    }

    private func loadLinkedComputer(showProgress: Bool = true) async {
        guard let bearer = accountStore.currentSessionToken,
              let accountID = accountStore.user?.id else {
            browsers = []
            return
        }
        signedInPlacesError = nil
        await computerLinkStore.refresh(
            bearerToken: bearer,
            accountID: accountID,
            showProgress: showProgress
        )
        do {
            let places = try await RelayAuthClient(
                baseURL: AppConfiguration.authBaseURL
            ).signedInPlaces(bearerToken: bearer)
            browsers = places.browsers
            computerLinkStore.adoptPlaces(places, accountID: accountID)
        } catch {
            signedInPlacesError = "Relay couldn't refresh signed-in places."
        }
    }

    private func disconnectLinkedComputer() async {
        guard let bearer = accountStore.currentSessionToken,
              let accountID = accountStore.user?.id else { return }
        await computerLinkStore.disconnect(bearerToken: bearer, accountID: accountID)
    }

    private func removeBrowser(_ browser: RelayBrowserSession) async {
        guard let bearer = accountStore.currentSessionToken else { return }
        isRemovingBrowser = true
        signedInPlacesError = nil
        defer {
            isRemovingBrowser = false
            browserToRemove = nil
        }
        do {
            try await RelayAuthClient(
                baseURL: AppConfiguration.authBaseURL
            ).removeBrowser(id: browser.id, bearerToken: bearer)
            browsers.removeAll { $0.id == browser.id }
        } catch let error as RelayAuthClientError {
            if case .server(let status, let code, _) = error,
               status == 404, code == "unknown_browser" {
                browsers.removeAll { $0.id == browser.id }
                signedInPlacesError = "That browser is already signed out."
                return
            }
            signedInPlacesError = "Relay couldn't remove this browser. Try again."
        } catch {
            signedInPlacesError = "Relay couldn't remove this browser. Try again."
        }
    }

    private func computerName(_ computer: CLIComputerLink) -> String {
        guard let name = computer.machineName, !name.isEmpty else { return "Linked computer" }
        return name
    }

    private func browserName(_ browser: RelayBrowserSession) -> String {
        guard let name = browser.name, !name.isEmpty else { return "Browser" }
        return name
    }

    private func computerStatus(_ computer: CLIComputerLink) -> String {
        switch computer.status {
        case .connecting: return "Waiting for computer"
        case .connected: return "Connected"
        }
    }

    private func platformLabel(_ platform: String) -> String {
        switch platform {
        case "macos": return "macOS"
        case "linux": return "Linux"
        case "windows": return "Windows"
        case "web": return "Web"
        case "other": return "Other"
        default: return platform
        }
    }

    private static let computerDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

/// What the coding-agents list is loaded against: a machine, and what EC2
/// says about it.
private struct AgentsLoadTrigger: Equatable {
    enum Machine { case checking, down, reachable }
    var hasMachine: Bool
    var machine: Machine
}

struct RelayMachinePowerSwitch: View {
    @ObservedObject var model: RelayMachinePowerModel
    var onStarted: (() async -> Void)? = nil
    var confirmStop: () -> Void
    var accessibilityIdentifier: String
    /// Usage's compact header sets this false: the switch sits beside the
    /// machine name, so only the transient detail (Starting…) stays visible.
    var showsLabel = true

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            if showsLabel {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Power")
                        .font(AppTheme.uiFont(size: 17))
                        .foregroundStyle(AppTheme.textPrimary)
                    detailText
                }
                Spacer(minLength: 12)
            } else {
                detailText
            }
            if model.status.isBusy {
                ProgressView()
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
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(
                    model.status == .unavailable ? AppTheme.statusError : AppTheme.textTertiary
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
            .tint(AppTheme.accent)
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

    var body: some View {
        if model.autoStopEnabled != nil || !model.status.isResolved {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Auto-stop when idle")
                        .font(AppTheme.uiFont(size: 17))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(model.autoStopEnabled == false
                         ? "Stays on until you stop it."
                         : "Stops after an hour of low CPU and network.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                }
                Spacer(minLength: 12)
                if model.autoStopEnabled != nil {
                    if model.isSavingAutoStop {
                        ProgressView()
                    }
                    Toggle("Auto-stop when idle", isOn: Binding(
                        get: { model.autoStopEnabled ?? false },
                        set: { enabled in Task { await model.setAutoStop(enabled) } }
                    ))
                    .labelsHidden()
                    .tint(AppTheme.accent)
                    .disabled(model.isSavingAutoStop)
                    .accessibilityIdentifier("relay-settings-autostop")
                } else {
                    ProgressView()
                        .accessibilityIdentifier("relay-settings-autostop")
                }
            }
            .accessibilityElement(children: .contain)
        }
    }
}

struct RelayMachineSizeControl: View {
    @ObservedObject var model: RelayMachinePowerModel
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
                    .font(AppTheme.uiFont(size: 17))
                    .foregroundStyle(AppTheme.textPrimary)
                Spacer()
                Text(model.instanceType ?? "Unavailable")
                    .font(AppTheme.monoFont(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
                    .accessibilityIdentifier("relay-instance-type")
            }

            if let currentHourly, let currentMonthly {
                HStack(alignment: .firstTextBaseline, spacing: 7) {
                    Text(monthlyPrice(currentMonthly))
                        .font(AppTheme.serifFont(size: 22))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text("/ month")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                    Spacer(minLength: 8)
                    Text("\(hourlyPrice(currentHourly))/hr")
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                }
                Text("EC2 compute · \(hoursPerMonth) running hours/month")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
            } else if model.instanceType != nil {
                Text("Compute price unavailable for this series and region")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
            }

            if model.isSubmittingResize {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Requesting size change…")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                }
            } else if let resize = model.resize, resize.isActive {
                HStack(spacing: 8) {
                    ProgressView()
                    Text("Changing to \(resize.targetType) · \(stageText(resize.stage))")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                }
            } else if options.count > 1 {
                HStack {
                    Text(options.first ?? "")
                    Spacer()
                    Text(options.last ?? "")
                }
                .font(AppTheme.monoFont(size: 12))
                .foregroundStyle(AppTheme.textTertiary)
                Slider(value: Binding(
                    get: { Double(selectedIndex) },
                    set: { selectedIndex = Int($0.rounded()) }
                ), in: 0...Double(options.count - 1), step: 1)
                .accessibilityLabel("Machine size")
                .accessibilityValue(selectedType ?? "")
                .accessibilityIdentifier("relay-instance-size-slider")

                if let selectedType, selectedType != model.instanceType {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(selectedType)
                                .font(AppTheme.uiFont(size: 16, weight: .medium))
                                .foregroundStyle(AppTheme.textPrimary)
                            if let selectedMonthly {
                                Text("\(monthlyPrice(selectedMonthly)) / month")
                                    .font(AppTheme.uiFont(size: 13))
                                    .foregroundStyle(AppTheme.textSecondary)
                            } else {
                                Text("Price temporarily unavailable")
                                    .font(AppTheme.uiFont(size: 13))
                                    .foregroundStyle(AppTheme.textSecondary)
                            }
                        }
                        Spacer(minLength: 6)
                        if let currentMonthly, let selectedMonthly {
                            Text(monthlyDifference(selectedMonthly - currentMonthly))
                                .font(AppTheme.monoFont(size: 12, weight: .medium))
                                .foregroundStyle(AppTheme.accent)
                        }
                    }
                    .padding(.vertical, 3)

                    Button("Change to \(selectedType)") {
                        showingConfirmation = true
                    }
                    .buttonStyle(RelayOutlineButtonStyle())
                    .disabled(model.isSubmittingResize)
                }

                if model.pricing != nil {
                    Text("AWS Linux On-Demand estimate · storage, data and tax are extra")
                        .font(AppTheme.uiFont(size: 11))
                        .foregroundStyle(AppTheme.textTertiary)
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
            Color.black.opacity(0.56).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 0) {
                RelayCapsLabel(text: "Relay · Machine", color: AppTheme.accent, size: 11)
                Spacer(minLength: 28)

                ZStack {
                    Circle()
                        .stroke(AppTheme.accent.opacity(0.17), lineWidth: 2)
                    Circle()
                        .trim(from: 0.06, to: 0.31)
                        .stroke(AppTheme.accent, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                        .rotationEffect(.degrees(isAnimating ? 360 : 0))
                        .animation(reduceMotion ? nil : .linear(duration: 1.8).repeatForever(autoreverses: false), value: isAnimating)
                    Image(systemName: "server.rack")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(AppTheme.textPrimary)
                }
                .frame(width: 94, height: 94)
                .accessibilityHidden(true)

                Text(stageTitle)
                    .font(AppTheme.serifFont(size: 32))
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(.top, 30)
                Text(isRecovering
                     ? "The size change hit a problem. Relay is bringing your machine back."
                     : "Moving to \(target). Your machine will be unavailable during this change.")
                    .font(AppTheme.uiFont(size: 16))
                    .foregroundStyle(AppTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 9)

                VStack(alignment: .leading, spacing: 0) {
                    ForEach(steps.indices, id: \.self) { index in
                        HStack(spacing: 17) {
                            ZStack {
                                Circle()
                                    .stroke(index == activeStep ? AppTheme.accent : AppTheme.hairlineStrong, lineWidth: 1.5)
                                    .frame(width: 28, height: 28)
                                if index < activeStep {
                                    Image(systemName: "checkmark")
                                        .font(.system(size: 11, weight: .semibold))
                                        .foregroundStyle(AppTheme.textSecondary)
                                } else if index == activeStep {
                                    Circle()
                                        .fill(AppTheme.accent)
                                        .frame(width: 7, height: 7)
                                }
                            }
                            Text(isRecovering && index == activeStep ? "Restoring power" : steps[index])
                                .font(AppTheme.uiFont(size: 16, weight: index == activeStep ? .medium : .regular))
                                .foregroundStyle(index == activeStep ? AppTheme.textPrimary : AppTheme.textTertiary)
                            Spacer()
                        }
                        .frame(height: 56)
                        .accessibilityElement(children: .combine)
                        .accessibilityAddTraits(index == activeStep ? .updatesFrequently : [])
                    }
                }
                .padding(.top, 31)

                Spacer(minLength: 28)
                Text("This usually takes a few minutes. Relay is checking the machine as it changes.")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 32)
            .padding(.top, 36)
            .padding(.bottom, 38)
            .frame(maxWidth: 480, maxHeight: .infinity, alignment: .leading)
        }
        .tint(AppTheme.accent)
        .preferredColorScheme(.dark)
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
