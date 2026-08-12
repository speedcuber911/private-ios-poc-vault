import SwiftUI

/// Trial lifecycle chrome shown under the root browser toolbar: a compact
/// "Trial · N days left" capsule while the trial machine is live, and a
/// full-width expiry banner once `trial.state == .expired`. Copy always says
/// "machine", never "sandbox" (product copy rule).
struct TrialStatusBanner: View {
    /// Labelled actions must do what they say: this one actually posts to the
    /// waitlist. Returns false when the join failed so the banner can say so
    /// instead of silently claiming success.
    typealias JoinWaitlistAction = () async -> Bool

    let trial: RelayTrialNode
    let client: CodexClient
    let onJoinWaitlist: JoinWaitlistAction

    @State private var showingConnectOwnMachine = false
    @State private var exportURL: URL?
    @State private var isExporting = false
    @State private var exportError: String?
    @State private var waitlistState = WaitlistState.idle

    private enum WaitlistState: Equatable {
        case idle
        case joining
        case joined
        case failed
    }

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

    /// Status here is a word, never a dot (spec rule 5): once joined, the button
    /// is replaced by a small-caps confirmation rather than a badge.
    @ViewBuilder
    private var waitlistAction: some View {
        switch waitlistState {
        case .joined:
            RelayCapsLabel(text: "On the waitlist", color: AppTheme.textSecondary, size: 10)
                .accessibilityIdentifier("relay-trial-waitlist-joined")
        case .idle, .joining, .failed:
            Button(waitlistState == .joining ? "Joining…" : "Join the paid waitlist") {
                Task { await joinWaitlist() }
            }
            .font(AppTheme.uiFont(size: 13, weight: .semibold))
            .foregroundStyle(AppTheme.accent)
            .buttonStyle(.plain)
            .disabled(waitlistState == .joining)
            .accessibilityIdentifier("relay-trial-waitlist")
        }
    }

    private func joinWaitlist() async {
        waitlistState = .joining
        waitlistState = await onJoinWaitlist() ? .joined : .failed
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
        RelayCapsLabel(
            text: "Trial · \(trial.remainingDescription())",
            color: AppTheme.textSecondary,
            size: 10
        )
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
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

            HStack(spacing: 18) {
                Button("Connect your own machine") {
                    showingConnectOwnMachine = true
                }
                .font(AppTheme.uiFont(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-trial-connect-own")

                waitlistAction
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

            if waitlistState == .failed {
                Text("Relay couldn't add you to the waitlist. Try again.")
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("relay-trial-waitlist-error")
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
