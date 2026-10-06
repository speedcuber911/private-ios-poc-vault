import SwiftUI

/// One parked approval, with the two answers to it.
///
/// Shared deliberately. This card is shown in the Sessions tab and, since the run
/// stalls in front of whoever started it, inline in the chat transcript. A second
/// copy would drift, and the two surfaces disagreeing about what a command was
/// asking for is exactly the kind of thing nobody notices until it matters.
///
/// Approve is the one ember action on the card and Deny the quiet outline, at
/// equal width: the two answers weigh the same and neither is a system-tinted
/// button. Status is the caps word, not a stripe or a badge.
struct RelayApprovalCard: View {
    let approval: CodexApproval
    /// Absent in the chat transcript: the run is already open in front of you,
    /// so an "Open" button there would lead where you already are.
    var onOpen: (() -> Void)? = nil
    let onDecision: (CodexApprovalDecision) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                RelayCapsLabel(text: "Needs approval", color: AppTheme.statusWarn, size: 10)
                Spacer(minLength: 8)
                if let onOpen {
                    Button(action: onOpen) {
                        HStack(spacing: 6) {
                            RelayProviderMark(provider: approval.provider, size: 13)
                            Text("Open")
                            Image(systemName: "chevron.right")
                                .font(.system(size: 9, weight: .semibold))
                        }
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -12)
                }
            }
            Text(approval.title)
                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .fixedSize(horizontal: false, vertical: true)
            if let command = approval.command?.trimmedNonEmpty {
                Text(command)
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineSpacing(2)
                    .lineLimit(6)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(
                        AppTheme.textPrimary.opacity(0.05),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous)
                    )
            }
            if let reason = approval.reason?.trimmedNonEmpty {
                Text(reason)
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 8) {
                Button("Deny") { onDecision(.decline) }
                    .buttonStyle(RelayOutlineButtonStyle())
                Button("Approve") { onDecision(.accept) }
                    .buttonStyle(RelayPrimaryButtonStyle())
            }
            .padding(.top, 4)
        }
        .padding(16)
        .background(AppTheme.canvasTop, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(AppTheme.hairline, lineWidth: 1)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(approval.provider.relayPresentation.title) approval request")
    }
}
