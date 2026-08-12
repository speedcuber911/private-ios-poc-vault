import SwiftUI

/// A session handed over from a Mac, waiting to be picked up here.
///
/// Editorial Ember: one outlined card on the canvas, small-caps words for
/// status (never a dot), the branch in the mono face, ember reserved for the
/// single primary action.
struct RelayHandoffCardView: View {
    let card: RelayHandoffCard
    let manifest: RelayHandoffManifest?
    let isContinuing: Bool
    let onContinue: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header

            Text(card.title)
                .font(AppTheme.serifFont(size: 18))
                .foregroundStyle(AppTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)

            Text(card.subtitle)
                .font(AppTheme.monoFont(size: 11))
                .foregroundStyle(AppTheme.textTertiary)
                .lineLimit(2)
                .truncationMode(.middle)

            if let diffstat = manifest?.diffstat {
                Text(diffstat)
                    .font(AppTheme.monoFont(size: 11))
                    .foregroundStyle(AppTheme.textSecondary)
            }

            if let excerpt = manifest?.excerpt {
                Text(excerpt)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 2)
            }

            failureNotice

            if card.isActionable {
                Button(action: onContinue) {
                    Text(continueTitle)
                }
                .buttonStyle(RelayPrimaryButtonStyle(isEnabled: !isContinuing))
                .disabled(isContinuing)
                .padding(.top, 4)
                .accessibilityIdentifier("relay-handoff-continue")
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(card.isActionable ? AppTheme.accent.opacity(0.35) : AppTheme.hairline, lineWidth: 1)
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            RelayCapsLabel(text: card.statusLabel, color: statusColor, size: 9)
            RelayCapsLabel(text: harnessLabel, color: AppTheme.textTertiary, size: 9)
            if card.canResumeNatively {
                RelayCapsLabel(text: "Resumable", color: AppTheme.textTertiary, size: 9)
            }
            Spacer(minLength: 6)
            if let machine = manifest?.machine {
                Text(machine)
                    .font(AppTheme.monoFont(size: 10))
                    .foregroundStyle(AppTheme.textFaint)
                    .lineLimit(1)
            }
        }
    }

    /// A failure is never silent: the sentence, the remedy, and the node's own
    /// reason token so nothing is hidden behind the translation.
    @ViewBuilder private var failureNotice: some View {
        if let summary = card.failureSummary {
            VStack(alignment: .leading, spacing: 4) {
                Text(summary)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
                if let advice = card.failureAdvice {
                    Text(advice)
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let reason = card.error {
                    Text(reason)
                        .font(AppTheme.monoFont(size: 10))
                        .foregroundStyle(AppTheme.textFaint)
                }
            }
            .padding(.top, 2)
        }
    }

    /// A handoff that has already been continued keeps its Continue action —
    /// the node allows another run once the last job ends — but says so, rather
    /// than pretending this is the first pickup.
    private var continueTitle: String {
        if isContinuing { return "Starting" }
        return card.lastJobID == nil ? "Continue" : "Continue again"
    }

    /// The harness the laptop session belonged to, from the manifest; the
    /// runner provider is the fallback before the manifest has loaded.
    private var harnessLabel: String {
        if let harness = manifest?.harness {
            return CodexProvider(rawProvider: harness).displayName
        }
        return card.provider?.displayName ?? "Session"
    }

    private var statusColor: Color {
        switch card.state {
        case .failed:
            return AppTheme.statusError
        case .importing:
            return AppTheme.statusWarn
        // The palette has no success color on purpose: a finished state is cream.
        case .ready, .unknown:
            return AppTheme.textSecondary
        }
    }
}

/// One session still living on the user's Mac. Not resumable from here — the
/// index is metadata only — so the row offers the honest affordance: start
/// fresh on the sandbox, and the section says what to run over there.
struct RelayMacSessionRow: View {
    let session: RelayMacSession
    let onStartFresh: () -> Void

    var body: some View {
        Button(action: onStartFresh) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(session.displayTitle)
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    HStack(spacing: 8) {
                        RelayCapsLabel(text: harnessLabel, color: AppTheme.textTertiary, size: 9)
                        Text(metadata)
                            .font(AppTheme.monoFont(size: 10))
                            .foregroundStyle(AppTheme.textFaint)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                Spacer(minLength: 6)
                Text("Start fresh")
                    .font(AppTheme.uiFont(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.accent)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var harnessLabel: String {
        CodexProvider(rawProvider: session.harness).displayName
    }

    private var metadata: String {
        guard let date = session.lastActiveDate else { return session.repo }
        let age = RelayRelativeTime.string(for: date)
        return session.repo.isEmpty ? age : "\(session.repo) · \(age)"
    }
}

/// Shared abbreviated relative formatter — the freshness stamp on Mac sessions
/// and on the index itself.
enum RelayRelativeTime {
    static func string(for date: Date, relativeTo now: Date = Date()) -> String {
        formatter.localizedString(for: date, relativeTo: now)
    }

    private static let formatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}
