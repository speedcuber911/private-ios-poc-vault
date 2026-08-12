import SwiftUI
import UIKit

struct RelayOnboardingView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let trialClient: RelayTrialClient

    @StateObject private var trialFlow: RelayTrialFlowModel
    @State private var page = 0
    @State private var showingTrialProvisioning = false
    @State private var showingTrustInfo = false

    init(
        accountStore: RelayAccountStore,
        nodeStore: RelayNodeStore,
        identityStore: ClientIdentityStore,
        trialClient: RelayTrialClient
    ) {
        self.accountStore = accountStore
        self.nodeStore = nodeStore
        self.identityStore = identityStore
        self.trialClient = trialClient
        _trialFlow = StateObject(wrappedValue: RelayTrialFlowModel(
            client: trialClient,
            identityStore: identityStore,
            nodeStore: nodeStore
        ))
    }

    private let pages = [
        OnboardingPage(
            icon: "rectangle.connected.to.line.below",
            title: "Your agents, one place",
            detail: "Start, monitor, and continue Codex, Claude, and Cursor work from your iPhone."
        ),
        OnboardingPage(
            icon: "lock.shield",
            title: "Private by design",
            detail: "Your account uses Better Auth. Agent and file routes keep their separate certificate-protected connection."
        ),
        OnboardingPage(
            icon: "checkmark.seal",
            title: "Ready to Relay",
            detail: "Use Files to browse workspaces, open Chat for agent work, and find your account in Settings."
        )
    ]

    var body: some View {
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()
            VStack(spacing: 18) {
                HStack {
                    Text("Relay")
                        .font(AppTheme.serifFont(size: 24))
                        .foregroundStyle(AppTheme.textPrimary)
                    Spacer()
                    RelayCapsLabel(text: "\(page + 1) of \(pages.count)")
                }
                .padding(.horizontal, 22)
                .padding(.top, 16)

                TabView(selection: $page) {
                    ForEach(Array(pages.enumerated()), id: \.offset) { index, item in
                        VStack(spacing: 24) {
                            Spacer()
                            Image(systemName: item.icon)
                                .font(.system(size: 48, weight: .medium))
                                .foregroundStyle(AppTheme.accentGradient)
                            Text(item.title)
                                .font(AppTheme.serifFont(size: 31))
                                .foregroundStyle(AppTheme.textPrimary)
                                .multilineTextAlignment(.center)
                            Text(item.detail)
                                .font(AppTheme.uiFont(size: 16))
                                .foregroundStyle(AppTheme.textSecondary)
                                .multilineTextAlignment(.center)
                                .lineSpacing(4)
                                .padding(.horizontal, 24)
                            Spacer()
                        }
                        .tag(index)
                    }
                }
                .tabViewStyle(.page(indexDisplayMode: .never))

                if page == pages.count - 1 {
                    forkActions
                        .padding(.horizontal, 22)
                        .padding(.bottom, 20)
                } else {
                    Button {
                        withAnimation(.easeInOut) { page += 1 }
                    } label: {
                        Text("Continue")
                    }
                    .buttonStyle(RelayPrimaryButtonStyle())
                    .padding(.horizontal, 22)
                    .padding(.bottom, 20)
                    .accessibilityIdentifier("relay-onboarding-continue")
                }
            }
        }
        .sheet(isPresented: $showingTrialProvisioning) {
            TrialProvisioningView(
                accountStore: accountStore,
                flow: trialFlow,
                deviceName: UIDevice.current.name
            )
        }
        .sheet(isPresented: $showingTrustInfo) {
            TrialTrustInfoView()
        }
        .preferredColorScheme(.dark)
    }

    /// Page 3's fork: an instant trial machine vs. the existing BYO install path.
    /// "Connect your own machine" keeps the `relay-onboarding-continue` accessibility
    /// id so existing onboarding automation (which only knows the BYO path) still works.
    private var forkActions: some View {
        VStack(spacing: 14) {
            Button {
                showingTrialProvisioning = true
            } label: {
                Text("Try instantly")
            }
            .buttonStyle(RelayPrimaryButtonStyle())
            .accessibilityIdentifier("relay-trial-start")

            VStack(spacing: 6) {
                Button {
                    accountStore.completeOnboarding()
                } label: {
                    Text("Connect your own machine")
                }
                .buttonStyle(RelayOutlineButtonStyle())
                .accessibilityIdentifier("relay-onboarding-continue")

                Text("Install Relay on hardware you own and point the app at it — no trial infrastructure involved.")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
            }

            Button("What's a trial machine?") {
                showingTrustInfo = true
            }
            .font(AppTheme.uiFont(size: 13, weight: .medium))
            .foregroundStyle(AppTheme.textSecondary)
            .buttonStyle(.plain)
            .accessibilityIdentifier("relay-trial-info")
        }
    }

    private struct OnboardingPage {
        let icon: String
        let title: String
        let detail: String
    }
}

/// Tertiary disclosure explaining what a trial machine is and the privacy trade-off
/// versus connecting your own — surfaced from the onboarding fork.
private struct TrialTrustInfoView: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 18) {
                    Image(systemName: "info.circle")
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(AppTheme.accentGradient)

                    Text("What's a trial machine?")
                        .font(AppTheme.serifFont(size: 24))
                        .foregroundStyle(AppTheme.textPrimary)

                    Text("Trial machines run on Relay infrastructure — connect your own machine for full privacy.")
                        .font(AppTheme.uiFont(size: 16))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineSpacing(4)

                    Text("A trial machine lets you use Relay immediately, with nothing to install. It runs on infrastructure Relay operates and expires automatically. Connecting your own machine instead keeps every agent and file route on hardware only you control.")
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(AppTheme.textTertiary)
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
