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
                        .font(.system(size: 24, weight: .medium, design: .serif))
                        .foregroundStyle(AppTheme.textPrimary)
                    Spacer()
                    Text("\(page + 1) of \(pages.count)")
                        .font(AppTheme.uiFont(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.textTertiary)
                }
                .padding(.horizontal, 22)
                .padding(.top, 16)

                TabView(selection: $page) {
                    ForEach(Array(pages.enumerated()), id: \.offset) { index, item in
                        VStack(spacing: 24) {
                            Spacer()
                            Image(systemName: item.icon)
                                .font(.system(size: 54, weight: .medium))
                                .foregroundStyle(AppTheme.accentGradient)
                                .frame(width: 116, height: 116)
                                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 34))
                                .overlay {
                                    RoundedRectangle(cornerRadius: 34)
                                        .stroke(AppTheme.glassStroke, lineWidth: 1)
                                }
                            Text(item.title)
                                .font(.system(size: 31, weight: .medium, design: .serif))
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
                .tabViewStyle(.page(indexDisplayMode: .always))

                Button {
                    if page < pages.count - 1 {
                        withAnimation(.easeInOut) { page += 1 }
                    } else {
                        accountStore.completeOnboarding()
                    }
                } label: {
                    Text(page == pages.count - 1 ? "Enter Relay" : "Continue")
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(AppTheme.accentGradient, in: RoundedRectangle(cornerRadius: 13))
                }
                .buttonStyle(.plain)
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
