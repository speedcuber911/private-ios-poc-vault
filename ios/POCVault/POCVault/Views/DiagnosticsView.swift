import SwiftUI

struct DiagnosticsView: View {
    @ObservedObject var identityStore: ClientIdentityStore
    @ObservedObject var nodeStore: RelayNodeStore
    var showsNavigationChrome = true

    @Environment(\.dismiss) private var dismiss
    @State private var checks: [DiagnosticCheck] = []

    private var contentHorizontalPadding: CGFloat {
        showsNavigationChrome ? 16 : 16
    }
    private let cardCornerRadius: CGFloat = 16

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.bgCanvas.ignoresSafeArea()
                VStack(spacing: 0) {
                    if showsNavigationChrome {
                        diagnosticsNavBar
                            .padding(.horizontal, 16)
                            .padding(.top, 10)
                            .padding(.bottom, 18)
                    }

                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            if !showsNavigationChrome {
                                EmptyView()
                            }

                        VStack(alignment: .leading, spacing: 6) {
                            Text(screenTitle)
                                .font(titleFont)
                                .foregroundStyle(AppTheme.textPrimary)
                            RelayCapsLabel(text: AppConfiguration.runtimeMode)
                        }
                        .padding(.top, showsNavigationChrome ? 18 : 0)

                        VStack(alignment: .leading, spacing: 0) {
                            RelayCapsLabel(text: "Checks", size: 11)
                                .padding(.bottom, 8)
                            ForEach(Array(checks.enumerated()), id: \.element.id) { index, check in
                                DiagnosticRow(check: check)
                                if index < checks.count - 1 {
                                    Rectangle()
                                        .fill(AppTheme.hairline)
                                        .frame(height: 0.5)
                                        .padding(.leading, 46)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .diagnosticCard(cornerRadius: cardCornerRadius)
                    }
                    .padding(.horizontal, contentHorizontalPadding)
                    .padding(.bottom, showsNavigationChrome ? 28 : 110)
                    }
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                refreshChecks()
            }
            .onAppear(perform: refreshChecks)
        }
        // Presented as a sheet/cover of its own: re-pin the deliberate dark-only
        // appearance so the surface can never flash light.
        .preferredColorScheme(.dark)
    }

    private var diagnosticsNavBar: some View {
        ZStack {
            HStack {
                Button {
                    dismiss()
                } label: {
                    Text("Done")
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 14)
                        .frame(height: 32)
                        .background(AppTheme.textPrimary.opacity(0.08), in: Capsule())
                }
                .buttonStyle(.plain)

                Spacer()

                Button {
                    refreshChecks()
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(width: 32, height: 32)
                        .background(AppTheme.textPrimary.opacity(0.06), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh diagnostics")
            }

            Text("Diagnostics")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
        }
    }

    private func refreshChecks() {
        let node = nodeStore.pairedNode
        let host = identityStore.pinnedHost ?? node?.host
        let hasPinnedCA = identityStore.pinnedCACertificate != nil
        let hasDeviceToken = host.flatMap { identityStore.deviceToken(for: $0) } != nil
        let linkReady = hasPinnedCA && hasDeviceToken
        let cloudConnected = node?.registeredAccountID != nil

        checks = [
            DiagnosticCheck(
                title: "Runtime",
                detail: AppConfiguration.runtimeMode,
                isPassing: true
            ),
            DiagnosticCheck(
                title: "Machine",
                detail: node?.nodeName ?? "No machine paired",
                isPassing: nodeStore.hasMachine
            ),
            DiagnosticCheck(
                title: "Address",
                detail: node?.apiBaseURL.absoluteString ?? "No address",
                isPassing: node != nil
            ),
            DiagnosticCheck(
                title: "Link",
                detail: linkReady ? "Pinned CA, device token" : "Pairing material missing",
                isPassing: linkReady
            ),
            DiagnosticCheck(
                title: "Relay cloud",
                detail: cloudConnected ? "Connected" : "Not connected — optional",
                isPassing: true
            )
        ]
    }

    private var screenTitle: String {
        showsNavigationChrome ? "Diagnostics" : "Health"
    }

    private var titleFont: Font {
        showsNavigationChrome
            ? AppTheme.serifFont(size: 28)
            : AppTheme.serifFont(size: 20)
    }
}

private struct DiagnosticCheck: Identifiable {
    let id = UUID()
    let title: String
    let detail: String
    let isPassing: Bool
}

private struct DiagnosticRow: View {
    let check: DiagnosticCheck

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            RelayCapsLabel(
                text: check.isPassing ? "OK" : "Fail",
                color: check.isPassing ? AppTheme.textSecondary : AppTheme.statusError,
                size: 9
            )
            .frame(width: 34, alignment: .leading)
            .padding(.top, 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(check.title)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(check.detail)
                    .font(.system(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 12)
    }
}

private struct DiagnosticCardModifier: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        content
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(AppTheme.hairline, lineWidth: 1)
            }
    }
}

private extension View {
    func diagnosticCard(cornerRadius: CGFloat) -> some View {
        modifier(DiagnosticCardModifier(cornerRadius: cornerRadius))
    }
}
