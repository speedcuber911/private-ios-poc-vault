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
            .interactiveDismissDisabled(accountStore.isWorking)
            .overlay {
                if accountStore.isWorking {
                    ZStack {
                        Color.black.opacity(0.28).ignoresSafeArea()
                        ProgressView().tint(AppTheme.accent)
                    }
                }
            }
        }
        .preferredColorScheme(.dark)
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
}
