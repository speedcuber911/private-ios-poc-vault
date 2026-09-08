import SwiftUI

struct AccountSettingsView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var computerLinkStore: RelayComputerLinkStore
    let codexClient: CodexClient
    let authClient: RelayAuthClient
    var showsDismissButton = true
    @Environment(\.dismiss) private var dismiss

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

    var body: some View {
        NavigationStack {
            Form {
                machineSection

                if accountStore.user == nil {
                    Section {
                        Button("Sign in to Relay") { showingSignIn = true }
                            .accessibilityIdentifier("relay-settings-sign-in")
                    } header: {
                        Text("Account")
                    } footer: {
                        Text("Optional. An account adds handoff from a laptop, push notifications, and approving `relay login` on a computer. Files, agents and terminals work without one.")
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
                        Text("Signed in")
                    } footer: {
                        Text(computerFooter)
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
                        Text("Security")
                    } footer: {
                        Text("Deleting removes your Relay account, registered devices, node records, entitlements, and this phone’s local Relay certificate. Files on servers you own are not deleted.")
                    }

                    if let error = accountStore.errorMessage {
                        Section {
                            Label(error, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppTheme.statusError)
                        }
                    }
                }

                if nodeStore.hasMachine {
                    Section {
                        if isLoadingHarnesses && harnesses.isEmpty {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Checking agents on your machine…")
                                    .foregroundStyle(AppTheme.textSecondary)
                            }
                        }

                        ForEach(harnesses.filter(\.installed)) { harness in
                            HStack(spacing: 10) {
                                RelayProviderMark(provider: harness.provider, size: 16)
                                Text(harness.provider.displayName)
                                Spacer()
                                if harness.loggedIn == true {
                                    Text("Connected")
                                        .foregroundStyle(AppTheme.textSecondary)
                                } else {
                                    Button(harness.loggedIn == false ? "Sign in" : "Check sign-in") {
                                        providerLoginRequest = harness.provider
                                    }
                                    .accessibilityIdentifier("relay-agent-sign-in-\(harness.provider.rawValue)")
                                }
                            }
                        }

                        if let harnessError {
                            Label(harnessError, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppTheme.statusError)

                            Button("Try again") {
                                Task { await loadHarnesses() }
                            }
                        }
                    } header: {
                        Text("Coding agents")
                    } footer: {
                        Text("Sign in to each agent right from this iPhone — no laptop needed. The session is stored on your machine, and `relay sync-auth` from a Mac still works too.")
                    }
                }

                Section("About") {
                    LabeledContent("App", value: "Relay")
                    LabeledContent("Version", value: versionText)
                    LabeledContent("Authentication", value: "Better Auth")
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
            .task(id: nodeStore.hasMachine) {
                guard nodeStore.hasMachine else { return }
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
        }
        .preferredColorScheme(.dark)
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
                LabeledContent("Machine", value: node.nodeName)
                LabeledContent("Address", value: node.apiBaseURL.absoluteString)
                LabeledContent(
                    "Account",
                    value: node.registeredAccountID == nil ? "Not connected" : "Connected"
                )

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
                LabeledContent("Machine", value: AppConfiguration.codexBaseURL.absoluteString)
                LabeledContent("Configured by", value: "support/vault-config.json")
                Button("Pair a machine") { showingPairing = true }
                    .accessibilityIdentifier("relay-settings-pair")
            } else {
                Button("Pair a machine") { showingPairing = true }
                    .accessibilityIdentifier("relay-settings-pair")
            }
        } header: {
            Text("Machine")
        } footer: {
            Text(machineFooter)
        }
    }

    private var machineFooter: String {
        guard let node = nodeStore.pairedNode else {
            return "Run `relayd pair` on a computer or server you own and scan the code it prints."
        }
        if node.registeredAccountID == nil {
            return "This machine is paired directly to this phone and fully usable. It is not connected to a Relay account, so there is no handoff from a laptop and no push notifications — add those whenever you want them."
        }
        return "Connected to your Relay account, so `relay handoff` from a laptop and push notifications reach this phone."
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

    private func loadHarnesses() async {
        guard nodeStore.hasMachine else { return }
        isLoadingHarnesses = true
        harnessError = nil
        defer { isLoadingHarnesses = false }
        do {
            harnesses = try await codexClient.fetchHarnesses()
        } catch {
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
