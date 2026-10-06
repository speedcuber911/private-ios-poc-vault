import SwiftUI

/// One parked approval, with the two answers to it.
///
/// Shared deliberately. This card is shown in the Sessions tab and, since the run
/// stalls in front of whoever started it, inline in the chat transcript. A second
/// copy would drift, and the two surfaces disagreeing about what a command was
/// asking for is exactly the kind of thing nobody notices until it matters.
///
/// Not a card: in the transcript it sits directly under the "Waiting" live
/// row, a hairline and then the request. Approve is the one ember action and
/// Deny the quiet outline, at equal width; status is the caps word.
struct RelayApprovalCard: View {
    let approval: CodexApproval
    /// Absent in the chat transcript: the run is already open in front of you,
    /// so an "Open" button there would lead where you already are.
    var onOpen: (() -> Void)? = nil
    let onDecision: (CodexApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                RelayCapsLabel(text: "Needs approval", color: AppTheme.statusWarn, size: 10)
                Spacer(minLength: 8)
                if let onOpen {
                    Button(action: onOpen) {
                        HStack(spacing: 6) {
                            Text("Open \(approval.provider.relayPresentation.title)")
                            RelayRowChevron()
                        }
                        .font(RelayTranscriptStyle.small.weight(.medium))
                        .foregroundStyle(RelayChatStyle.secondary)
                        .lineLimit(1)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -15)
                }
            }
            Text(approval.title)
                .font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .headline).weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
            if let command = approval.command?.trimmedNonEmpty {
                // Wraps anywhere inside its block; never a sideways scroll.
                Text(command)
                    .font(RelayTranscriptStyle.mono)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineSpacing(4)
                    .lineLimit(6)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 12)
                    .padding(.horizontal, 14)
                    .background(
                        AppTheme.textPrimary.opacity(0.05),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
                    .padding(.top, 12)
            }
            if let reason = approval.reason?.trimmedNonEmpty {
                Text(reason)
                    .font(RelayTranscriptStyle.small)
                    .foregroundStyle(AppTheme.textSecondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 8)
            }
            HStack(spacing: 12) {
                Button("Deny") { onDecision(.decline) }
                    .buttonStyle(RelayApprovalButtonStyle(isPrimary: false))
                Button("Approve") { onDecision(.accept) }
                    .buttonStyle(RelayApprovalButtonStyle(isPrimary: true))
            }
            .padding(.top, 16)
        }
        .padding(.top, 16)
        .overlay(alignment: .top) { RelayHairline() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(approval.provider.relayPresentation.title) approval request")
    }
}

/// The two answers: 48pt pills at equal width. Approve is filled ember, Deny a
/// hairline outline. The app-wide pill styles are 50pt with other type sizes.
struct RelayApprovalButtonStyle: ButtonStyle {
    let isPrimary: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.custom("DMSans-9ptRegular", size: 16, relativeTo: .body).weight(.semibold))
            .foregroundStyle(isPrimary ? AppTheme.onEmber : AppTheme.textPrimary)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(isPrimary ? AppTheme.accent : Color.clear, in: Capsule())
            .overlay {
                if !isPrimary {
                    Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1)
                }
            }
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
