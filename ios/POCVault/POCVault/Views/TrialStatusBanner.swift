import SwiftUI

/// Trial lifecycle chrome shown under the root browser toolbar: a compact
/// "Trial · N days left" capsule while the trial machine is live, and a
/// full-width expiry banner once `trial.state == .expired`. Copy always says
/// "machine", never "sandbox" (product copy rule).
struct TrialStatusBanner: View {
    let trial: RelayTrialNode
    let client: CodexClient
    @ObservedObject var subscriptionStore: RelaySubscriptionStore

    @State private var showingConnectOwnMachine = false
    @State private var exportURL: URL?
    @State private var isExporting = false
    @State private var exportError: String?

    var body: some View {
        Group {
            if trial.state == .expired {
                expiredBanner
            } else {
                capsule
            }
        }
        .sheet(isPresented: $showingConnectOwnMachine) {
            ConnectOwnMachineInfoView()
        }
    }

    private func exportFiles() async {
        isExporting = true
        exportError = nil
        defer { isExporting = false }
        do {
            exportURL = try await client.downloadExport()
        } catch {
            exportError = "Export failed: \(error.localizedDescription)"
        }
    }

    private var capsule: some View {
        HStack(spacing: 12) {
            RelayCapsLabel(
                text: "Trial · \(trial.remainingDescription())",
                color: AppTheme.textSecondary,
                size: 10
            )

            Spacer(minLength: 4)

            Button("Keep Relay · \(subscriptionStore.monthlyDisplayPrice)/month") {
                Task { await subscriptionStore.purchase() }
            }
            .font(AppTheme.uiFont(size: 12, weight: .semibold))
            .foregroundStyle(AppTheme.accent)
            .buttonStyle(.plain)
            .disabled(subscriptionStore.isPurchasing)
            .accessibilityIdentifier("relay-trial-subscribe")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(AppTheme.textPrimary.opacity(0.06), in: Capsule())
        .accessibilityIdentifier("relay-trial-badge")
    }

    private var expiredBanner: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Your trial machine has expired — data is kept for 3 days.")
                .font(AppTheme.uiFont(size: 13, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("relay-trial-expired-message")

            VStack(spacing: 10) {
                Button("Subscribe monthly · \(subscriptionStore.monthlyDisplayPrice)") {
                    Task { await subscriptionStore.purchase() }
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .disabled(subscriptionStore.isPurchasing)
                .accessibilityIdentifier("relay-trial-subscribe-monthly")

                Button("Subscribe yearly · \(subscriptionStore.yearlyDisplayPrice)") {
                    Task {
                        await subscriptionStore.purchase(
                            productID: RelaySubscriptionStore.hostedYearlyProductID
                        )
                    }
                }
                .buttonStyle(RelayOutlineButtonStyle())
                .disabled(subscriptionStore.isPurchasing)
                .accessibilityIdentifier("relay-trial-subscribe-yearly")

                HStack(spacing: 18) {
                    Button("Restore Purchases") {
                        Task { await subscriptionStore.restorePurchases() }
                    }
                    .font(AppTheme.uiFont(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                    .buttonStyle(.plain)

                    Button("Connect your own machine") {
                        showingConnectOwnMachine = true
                    }
                    .font(AppTheme.uiFont(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("relay-trial-connect-own")
                }
            }

            // The grace period is the only window in which this data still
            // exists, so the export has to be reachable from the banner itself.
            // ShareLink appears only once the tar is staged on disk, matching
            // how FileViewerView shares downloaded files.
            if let exportURL {
                ShareLink(item: exportURL) {
                    Text("Share my files")
                        .font(AppTheme.uiFont(size: 13, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                }
                .accessibilityIdentifier("relay-trial-export-share")
            } else {
                Button(isExporting ? "Preparing export…" : "Export my files") {
                    Task { await exportFiles() }
                }
                .font(AppTheme.uiFont(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .buttonStyle(.plain)
                .disabled(isExporting)
                .accessibilityIdentifier("relay-trial-export")
            }

            if let message = subscriptionStore.errorMessage, !message.isEmpty {
                Text(message)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let exportError {
                Text(exportError)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.hairline, lineWidth: 1)
        )
        .accessibilityIdentifier("relay-trial-expired-banner")
    }
}

/// The BYO explanation reused from onboarding's fork screen — surfaced again
/// from the expiry banner so a user whose trial lapsed sees the same copy.
private struct ConnectOwnMachineInfoView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "server.rack")
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(AppTheme.accentGradient)

                    Text("Connect your own machine")
                        .font(AppTheme.serifFont(size: 24))
                        .foregroundStyle(AppTheme.textPrimary)

                    Text("Install Relay on hardware you own and point the app at it — no trial infrastructure involved.")
                        .font(AppTheme.uiFont(size: 16))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineSpacing(4)

                    Spacer()
                }
                .padding(24)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// The hosted machine is deliberately unreachable after trial expiry. This
/// screen is the only root surface until StoreKit and the cloud both confirm
/// an active entitlement; successful purchase/restore updates RelayNodeStore,
/// which routes the app back to the normal workspace UI.
struct RelayExpiredTrialView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var subscriptionStore: RelaySubscriptionStore

    @State private var showingDeleteConfirmation = false
    @State private var deletionPassword = ""

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                ScrollView {
                    VStack(spacing: 22) {
                        Image(systemName: "bolt.shield")
                            .font(.system(size: 42, weight: .medium))
                            .foregroundStyle(AppTheme.accentGradient)

                        VStack(spacing: 10) {
                            Text("Keep your Relay machine")
                                .font(AppTheme.serifFont(size: 30))
                                .foregroundStyle(AppTheme.textPrimary)
                                .multilineTextAlignment(.center)

                            Text("Your seven-day trial has ended. Hosted access is paused; your machine data is kept for three days.")
                                .font(AppTheme.uiFont(size: 15))
                                .foregroundStyle(AppTheme.textSecondary)
                                .multilineTextAlignment(.center)
                                .lineSpacing(4)
                        }

                        VStack(spacing: 12) {
                            Button {
                                Task { await subscriptionStore.purchase() }
                            } label: {
                                VStack(spacing: 3) {
                                    Text("Monthly · \(subscriptionStore.monthlyDisplayPrice)")
                                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                                    Text("Billed every month")
                                        .font(AppTheme.uiFont(size: 11))
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(RelayPrimaryButtonStyle())
                            .disabled(subscriptionStore.isPurchasing)
                            .accessibilityIdentifier("relay-expired-subscribe-monthly")

                            Button {
                                Task {
                                    await subscriptionStore.purchase(
                                        productID: RelaySubscriptionStore.hostedYearlyProductID
                                    )
                                }
                            } label: {
                                VStack(spacing: 3) {
                                    Text("Yearly · \(subscriptionStore.yearlyDisplayPrice)")
                                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                                    Text("Save about 17% · billed every year")
                                        .font(AppTheme.uiFont(size: 11))
                                }
                                .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(RelayOutlineButtonStyle())
                            .disabled(subscriptionStore.isPurchasing)
                            .accessibilityIdentifier("relay-expired-subscribe-yearly")
                        }

                        if subscriptionStore.isPurchasing {
                            ProgressView("Confirming with the App Store…")
                                .tint(AppTheme.accent)
                                .foregroundStyle(AppTheme.textSecondary)
                        }

                        if let message = subscriptionStore.errorMessage, !message.isEmpty {
                            Text(message)
                                .font(AppTheme.uiFont(size: 13))
                                .foregroundStyle(AppTheme.statusError)
                                .multilineTextAlignment(.center)
                        }

                        Button("Restore Purchases") {
                            Task { await subscriptionStore.restorePurchases() }
                        }
                        .font(AppTheme.uiFont(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                        .buttonStyle(.plain)
                        .disabled(subscriptionStore.isPurchasing)
                        .accessibilityIdentifier("relay-expired-restore")

                        Text("Payment is charged to your Apple ID. Subscriptions renew automatically unless canceled at least 24 hours before the current period ends. Manage or cancel in App Store account settings.")
                            .font(AppTheme.uiFont(size: 11))
                            .foregroundStyle(AppTheme.textTertiary)
                            .multilineTextAlignment(.center)
                            .lineSpacing(3)

                        HStack(spacing: 18) {
                            Link("Privacy", destination: URL(string: "https://app.openrelay.sh/privacy")!)
                            Link("Terms", destination: URL(string: "https://app.openrelay.sh/terms")!)
                            Link("Support", destination: URL(string: "https://app.openrelay.sh/support")!)
                        }
                        .font(AppTheme.uiFont(size: 12, weight: .medium))
                        .foregroundStyle(AppTheme.textSecondary)

                        Button("Sign out") {
                            Task { await accountStore.signOut() }
                        }
                        .font(AppTheme.uiFont(size: 13, weight: .medium))
                        .foregroundStyle(AppTheme.textTertiary)
                        .buttonStyle(.plain)

                        Button("Delete account", role: .destructive) {
                            deletionPassword = ""
                            showingDeleteConfirmation = true
                        }
                        .font(AppTheme.uiFont(size: 13, weight: .medium))
                        .buttonStyle(.plain)
                        .disabled(accountStore.isWorking)
                        .accessibilityIdentifier("relay-expired-delete-account")
                    }
                    .padding(.horizontal, 24)
                    .padding(.vertical, 34)
                }
            }
            .navigationTitle("Relay Hosted")
            .navigationBarTitleDisplayMode(.inline)
        }
        .preferredColorScheme(.dark)
        .task { await subscriptionStore.prepare() }
        .alert("Delete your Relay account?", isPresented: $showingDeleteConfirmation) {
            if accountStore.user?.usesPassword == true {
                SecureField("Current password", text: $deletionPassword)
            }
            Button("Delete account", role: .destructive) {
                Task {
                    _ = await accountStore.deleteAccount(
                        password: accountStore.user?.usesPassword == true
                            ? deletionPassword
                            : nil
                    )
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This permanently deletes your Relay account and hosted machine. Your App Store subscription must be canceled separately in Apple account settings.")
        }
    }
}
