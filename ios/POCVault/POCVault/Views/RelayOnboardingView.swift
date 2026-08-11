import SwiftUI

struct RelayOnboardingView: View {
    @ObservedObject var accountStore: RelayAccountStore
    @State private var page = 0

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

                Button {
                    if page < pages.count - 1 {
                        withAnimation(.easeInOut) { page += 1 }
                    } else {
                        accountStore.completeOnboarding()
                    }
                } label: {
                    Text(page == pages.count - 1 ? "Enter Relay" : "Continue")
                }
                .buttonStyle(RelayPrimaryButtonStyle())
                .padding(.horizontal, 22)
                .padding(.bottom, 20)
                .accessibilityIdentifier("relay-onboarding-continue")
            }
        }
        .preferredColorScheme(.dark)
    }

    private struct OnboardingPage {
        let icon: String
        let title: String
        let detail: String
    }
}
