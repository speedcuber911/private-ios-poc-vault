import SwiftUI

/// One parked approval, with the two answers to it.
///
/// Shared deliberately. This card is shown in the Sessions tab and, since the run
/// stalls in front of whoever started it, inline in the chat transcript. A second
/// copy would drift, and the two surfaces disagreeing about what a command was
/// asking for is exactly the kind of thing nobody notices until it matters.
///
/// Approve carries the provider's own accent rather than ember: on this card the
/// decision belongs to the agent that asked, and ember stays earned for the
/// screen's own primary action.
struct RelayApprovalCard: View {
    let approval: CodexApproval
    /// Absent in the chat transcript: the run is already open in front of you,
    /// so an "Open" button there would lead where you already are.
    var onOpen: (() -> Void)? = nil
    let onDecision: (CodexApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                RelayProviderBadge(provider: approval.provider, style: .capsule, size: 9)
                Spacer()
                RelayCapsLabel(text: "Needs approval", color: AppTheme.statusWarn, size: 9)
            }
            Label(approval.title, systemImage: "checkmark.shield")
                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            if let command = approval.command?.trimmedNonEmpty {
                Text(command)
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineLimit(4)
            }
            if let reason = approval.reason?.trimmedNonEmpty {
                Text(reason)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
            }
            HStack(spacing: 10) {
                Button("Deny") { onDecision(.decline) }
                    .buttonStyle(.bordered)
                if let onOpen {
                    Button("Open", action: onOpen)
                        .buttonStyle(.bordered)
                }
                Spacer()
                Button("Approve") { onDecision(.accept) }
                    .buttonStyle(.borderedProminent)
                    .tint(approval.provider.relayPresentation.accent)
            }
        }
        .padding(14)
        .background(AppTheme.canvasTop)
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(approval.provider.relayPresentation.accent.opacity(0.4), lineWidth: 1))
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 2)
                .fill(approval.provider.relayPresentation.accent)
                .frame(width: 3)
                .padding(.vertical, 12)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(approval.provider.relayPresentation.title) approval request")
    }
}
