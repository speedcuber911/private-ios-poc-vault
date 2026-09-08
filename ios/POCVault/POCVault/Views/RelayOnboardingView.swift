import SwiftUI

/// The first thing a new install shows: three cards explaining what Relay is,
/// ending in the single action there is — connect a machine you own.
///
/// There is no account step and no trial fork. Relay hands out no machines, so
/// the only question is which of yours to point the phone at.
struct RelayOnboardingView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @ObservedObject var nodeStore: RelayNodeStore
    @ObservedObject var identityStore: ClientIdentityStore
    let authClient: RelayAuthClient

    @State private var page = 0
    @State private var showingPairing = false

    private let pages = [
        OnboardingPage(
            icon: "rectangle.connected.to.line.below",
            title: "Your machine, from your phone",
            detail: "Start and continue Codex, Claude Code, Cursor or Kimi work on hardware you already own, without keeping a laptop open."
        ),
        OnboardingPage(
            icon: "lock.shield",
            title: "Nothing in the middle",
            detail: "The phone talks straight to your machine over a connection it verifies against the certificate authority in your pairing code. Your files and your agent sessions never pass through Relay."
        ),
        OnboardingPage(
            icon: "qrcode.viewfinder",
            title: "One command to connect",
            detail: "Install relayd on your computer or server and run `relayd pair`. Scan the code it prints and you're working. An account is optional — add one later for laptop handoff and notifications."
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

                Button {
                    if page == pages.count - 1 {
                        showingPairing = true
                    } else {
                        withAnimation(.easeInOut) { page += 1 }
                    }
                } label: {
                    Text(page == pages.count - 1 ? "Connect your machine" : "Continue")
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .padding(.horizontal, 22)
                .padding(.bottom, 20)
                .accessibilityIdentifier("relay-onboarding-continue")
            }
        }
        .fullScreenCover(isPresented: $showingPairing) {
            NodePairingView(
                identityStore: identityStore,
                nodeStore: nodeStore,
                accountStore: accountStore,
                authClient: authClient,
                onDismiss: { showingPairing = false }
            )
        }
        .preferredColorScheme(.dark)
    }

    private struct OnboardingPage {
        let icon: String
        let title: String
        let detail: String
    }
}
