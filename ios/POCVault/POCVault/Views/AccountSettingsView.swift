import SwiftUI

struct AccountSettingsView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let trialClient: RelayTrialClient
    @Environment(\.dismiss) private var dismiss

    @State private var showingDeleteConfirmation = false
    @State private var deletionPassword = ""
    @State private var isDeletingTrial = false
    @State private var trialDeleteError: String?
    @State private var showingCLILink = false
    @State private var linkedComputer: CLIComputerLink?
    @State private var browsers: [RelayBrowserSession] = []
    @State private var didLoadLinkedComputer = false
    @State private var isLoadingLinkedComputer = false
    @State private var isDisconnectingComputer = false
    @State private var isRemovingBrowser = false
    @State private var linkedComputerError: String?
    @State private var showingDisconnectConfirmation = false
    @State private var browserToRemove: RelayBrowserSession?

    var body: some View {
        NavigationStack {
            Form {
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
                        if !didLoadLinkedComputer && isLoadingLinkedComputer {
                            HStack(spacing: 10) {
                                ProgressView()
                                Text("Checking signed-in places…")
                                    .foregroundStyle(AppTheme.textSecondary)
                            }
                        } else {
                            if let linkedComputer {
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
                                .disabled(isDisconnectingComputer || isRemovingBrowser)
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
                                .disabled(isDisconnectingComputer || isRemovingBrowser)
                                .accessibilityIdentifier("relay-remove-browser")
                            }

                            Button("Approve a sign-in") {
                                showingCLILink = true
                            }
                            .disabled(isLoadingLinkedComputer || isDisconnectingComputer || isRemovingBrowser)
                            .accessibilityIdentifier("relay-approve-sign-in")
                        }

                        if let linkedComputerError {
                            Label(linkedComputerError, systemImage: "exclamationmark.triangle.fill")
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

                if let trial = nodeStore.trial {
                    Section {
                        LabeledContent("Status", value: Self.stateLabel(for: trial.state))
                        LabeledContent("Expires", value: Self.expiryFormatter.string(from: trial.expiresDate))

                        Button("Delete trial machine", role: .destructive) {
                            Task { await deleteTrialMachine() }
                        }
                        .disabled(isDeletingTrial)
                        .accessibilityIdentifier("relay-delete-trial-machine")

                        if let trialDeleteError {
                            Label(trialDeleteError, systemImage: "exclamationmark.triangle.fill")
                                .foregroundStyle(AppTheme.statusError)
                        }
                    } header: {
                        Text("Trial machine")
                    } footer: {
                        Text("Deleting removes the trial machine and its data immediately. Connect your own machine any time to keep working.")
                    }
                }

                Section("About") {
                    LabeledContent("App", value: "Relay")
                    LabeledContent("Version", value: versionText)
                    LabeledContent("Authentication", value: "Better Auth")
                }
            }
            .scrollContentBackground(.hidden)
            .refreshable {
                await loadLinkedComputer()
            }
            .background(AppTheme.bgCanvas)
            .tint(AppTheme.accent)
            .navigationTitle("Account & Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
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
                "Disconnect \(linkedComputer.map(computerName) ?? "computer")?",
                isPresented: $showingDisconnectConfirmation,
                titleVisibility: .visible
            ) {
                Button("Disconnect computer", role: .destructive) {
                    Task { await disconnectLinkedComputer() }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Relay will revoke this computer’s CLI access. You can link a different computer afterward.")
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
            .task(id: linkedComputer?.id) {
                guard linkedComputer?.status == .connecting else { return }
                for _ in 0..<30 {
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    guard !Task.isCancelled else { return }
                    await loadLinkedComputer(showProgress: false)
                    if linkedComputer?.status != .connecting { return }
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var computerFooter: String {
        "Only one computer can be linked at a time — disconnect it before linking another. Each signed-in browser can use the web console; Remove signs that browser out. Approve a sign-in scans the QR from Sign in with iPhone, or from `relay login` when no computer is linked."
    }

    private var versionText: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "—"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "—"
        return "\(version) (\(build))"
    }

    private func deleteTrialMachine() async {
        guard let bearer = accountStore.currentSessionToken else { return }
        isDeletingTrial = true
        trialDeleteError = nil
        defer { isDeletingTrial = false }
        do {
            try await trialClient.deleteTrial(bearer: bearer)
            nodeStore.clear()
            // The machine is gone, so its client certificate and pinned CA are
            // dead weight on this phone — and must not outlive it.
            identityStore.discardTrialMaterial()
        } catch {
            trialDeleteError = "Relay couldn't delete the trial machine. Try again."
        }
    }

    private func loadLinkedComputer(showProgress: Bool = true) async {
        guard let bearer = accountStore.currentSessionToken else {
            linkedComputer = nil
            browsers = []
            didLoadLinkedComputer = true
            return
        }
        if showProgress { isLoadingLinkedComputer = true }
        linkedComputerError = nil
        defer {
            didLoadLinkedComputer = true
            if showProgress { isLoadingLinkedComputer = false }
        }
        do {
            let places = try await RelayAuthClient(
                baseURL: AppConfiguration.authBaseURL
            ).signedInPlaces(bearerToken: bearer)
            linkedComputer = places.computer
            browsers = places.browsers
        } catch {
            linkedComputerError = "Relay couldn't refresh signed-in places."
        }
    }

    private func disconnectLinkedComputer() async {
        guard let bearer = accountStore.currentSessionToken else { return }
        isDisconnectingComputer = true
        linkedComputerError = nil
        defer { isDisconnectingComputer = false }
        do {
            try await RelayAuthClient(
                baseURL: AppConfiguration.authBaseURL
            ).disconnectComputer(bearerToken: bearer)
            linkedComputer = nil
            browsers = []
            didLoadLinkedComputer = true
        } catch {
            linkedComputerError = "Relay couldn't disconnect this computer. Try again."
        }
    }

    private func removeBrowser(_ browser: RelayBrowserSession) async {
        guard let bearer = accountStore.currentSessionToken else { return }
        isRemovingBrowser = true
        linkedComputerError = nil
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
                linkedComputerError = "That browser is already signed out."
                return
            }
            linkedComputerError = "Relay couldn't remove this browser. Try again."
        } catch {
            linkedComputerError = "Relay couldn't remove this browser. Try again."
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

    private static func stateLabel(for state: RelayTrialNode.State) -> String {
        switch state {
        case .creating: return "Creating"
        case .ready: return "Active"
        case .expired: return "Expired"
        case .destroyed: return "Destroyed"
        case .failed: return "Failed"
        }
    }

    private static let expiryFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    private static let computerDateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}
