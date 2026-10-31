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
///
/// A question (Claude's AskUserQuestion) parks the same way but is answered,
/// not approved: its options are drawn in place and the picks go back with
/// the decision.
struct RelayApprovalCard: View {
    let approval: CodexApproval
    /// Absent in the chat transcript: the run is already open in front of you,
    /// so an "Open" button there would lead where you already are.
    var onOpen: (() -> Void)? = nil
    /// `answers` is keyed by question text, and set only when a question was answered.
    let onDecision: (CodexApprovalDecision, _ answers: [String: String]?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if approval.isQuestion {
                    RelayCapsLabel(text: "Needs your answer", color: AppTheme.statusWarn, size: 10)
                } else {
                    RelayCapsLabel(text: "Needs approval", color: AppTheme.statusWarn, size: 10)
                }
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
                .font(AppTheme.uiFont(size: 17, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
            if let questions = approval.questions, !questions.isEmpty {
                RelayQuestionForm(questions: questions, onDecision: onDecision)
                    // A new question for the same run must not inherit old picks.
                    .id(approval.id)
            } else {
                requestDetail
                HStack(spacing: 12) {
                    Button("Deny") { onDecision(.decline, nil) }
                        .buttonStyle(RelayApprovalButtonStyle(isPrimary: false))
                    Button("Approve") { onDecision(.accept, nil) }
                        .buttonStyle(RelayApprovalButtonStyle(isPrimary: true))
                }
                .padding(.top, 16)
            }
        }
        .padding(.top, 16)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "\(approval.provider.relayPresentation.title) \(approval.isQuestion ? "question" : "approval request")"
        )
    }

    @ViewBuilder
    private var requestDetail: some View {
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
    }
}

/// The questions an agent asked, answered where they were asked: tap an option
/// (or several, where the agent allows it), or write your own. Send stays quiet
/// until every question has an answer; Skip tells the agent you passed.
///
/// Your own words are typed in an alert rather than a field in the transcript,
/// whose outside-tap keyboard dismissal would close the keyboard on every tap.
private struct RelayQuestionForm: View {
    let questions: [CodexApprovalQuestion]
    let onDecision: (CodexApprovalDecision, _ answers: [String: String]?) -> Void

    @State private var picked: [String: Set<String>] = [:]
    @State private var written: [String: String] = [:]
    @State private var writing: CodexApprovalQuestion?
    @State private var draft = ""

    private var isComplete: Bool { questions.allSatisfy { answer(for: $0) != nil } }

    private var answers: [String: String] {
        Dictionary(
            questions.compactMap { question in answer(for: question).map { (question.question, $0) } },
            uniquingKeysWith: { first, _ in first }
        )
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(questions) { question in
                questionBlock(question)
                    .padding(.top, 16)
            }
            HStack(spacing: 12) {
                Button("Skip") { onDecision(.decline, nil) }
                    .buttonStyle(RelayApprovalButtonStyle(isPrimary: false))
                Button(questions.count == 1 ? "Send answer" : "Send answers") {
                    onDecision(.accept, answers)
                }
                .buttonStyle(RelayApprovalButtonStyle(isPrimary: isComplete))
                .disabled(!isComplete)
            }
            .padding(.top, 18)
        }
        .alert(
            "Your answer",
            isPresented: Binding(get: { writing != nil }, set: { if !$0 { writing = nil } }),
            presenting: writing
        ) { question in
            TextField(question.placeholder ?? "Type your answer", text: $draft)
                .keyboardType(question.kind == "number" ? .decimalPad : .default)
            Button("Use") { commitDraft(for: question) }
            Button("Cancel", role: .cancel) {}
        } message: { question in
            Text(question.question)
        }
    }

    private func questionBlock(_ question: CodexApprovalQuestion) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let header = question.header?.trimmedNonEmpty {
                RelayCapsLabel(text: header, color: AppTheme.textTertiary, size: 10)
                    .padding(.bottom, 4)
            }
            Text(question.question)
                .font(AppTheme.uiFont(size: 16, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
            if question.allowsMultiple {
                Text("Choose any")
                    .font(RelayTranscriptStyle.small)
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.top, 2)
            }
            VStack(spacing: 8) {
                if !question.isOpenEnded {
                    ForEach(question.options, id: \.label) { option in
                        optionRow(option, in: question)
                    }
                }
                ownAnswerRow(question)
            }
            .padding(.top, 10)
        }
    }

    private func optionRow(_ option: CodexApprovalQuestion.Option, in question: CodexApprovalQuestion) -> some View {
        let selected = picked[question.id]?.contains(option.label) == true
        return Button {
            toggle(option.label, in: question)
        } label: {
            RelayQuestionRow(selected: selected) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label)
                        .font(AppTheme.uiFont(size: 16, weight: .medium))
                        .foregroundStyle(AppTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                    if let detail = option.description?.trimmedNonEmpty {
                        Text(detail)
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(AppTheme.textSecondary)
                            .lineSpacing(2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func ownAnswerRow(_ question: CodexApprovalQuestion) -> some View {
        let own = written[question.id]?.trimmedNonEmpty
        return Button {
            draft = written[question.id] ?? ""
            writing = question
        } label: {
            RelayQuestionRow(selected: own != nil, idleSymbol: "pencil") {
                Text(own ?? (question.isOpenEnded ? "Write your answer" : "Something else…"))
                    .font(AppTheme.uiFont(size: 16, weight: own == nil ? .regular : .medium))
                    .foregroundStyle(own == nil ? AppTheme.textSecondary : AppTheme.textPrimary)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(own != nil ? .isSelected : [])
    }

    /// One answer per question. A multi-select sends its picks in the agent's
    /// order with your own words last, comma-joined as the agent expects.
    private func answer(for question: CodexApprovalQuestion) -> String? {
        let own = written[question.id]?.trimmedNonEmpty
        let labels = question.options.map(\.label).filter { picked[question.id]?.contains($0) == true }
        guard question.allowsMultiple else { return own ?? labels.first }
        let all = labels + [own].compactMap { $0 }
        return all.isEmpty ? nil : all.joined(separator: ", ")
    }

    private func toggle(_ label: String, in question: CodexApprovalQuestion) {
        var selection = picked[question.id] ?? []
        if question.allowsMultiple {
            if selection.contains(label) { selection.remove(label) } else { selection.insert(label) }
        } else {
            // One choice: an option replaces whatever you wrote.
            selection = selection.contains(label) ? [] : [label]
            written[question.id] = nil
        }
        picked[question.id] = selection
    }

    private func commitDraft(for question: CodexApprovalQuestion) {
        let text = draft.trimmedNonEmpty
        written[question.id] = text
        if text != nil, !question.allowsMultiple { picked[question.id] = [] }
    }
}

/// An answer row: raised when picked, with the accent tick sheet rows use.
private struct RelayQuestionRow<Content: View>: View {
    let selected: Bool
    var idleSymbol: String? = nil
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            content
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
            if selected {
                Image(systemName: "checkmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
            } else if let idleSymbol {
                Image(systemName: idleSymbol)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(AppTheme.textTertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .frame(minHeight: 48)
        .background(
            AppTheme.textPrimary.opacity(selected ? 0.11 : 0.05),
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// The two answers: 48pt pills at equal width. Approve is filled ember, Deny a
/// hairline outline. The app-wide pill styles are 50pt with other type sizes.
/// A disabled quiet pill fades its label rather than dimming any ember.
struct RelayApprovalButtonStyle: ButtonStyle {
    let isPrimary: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(AppTheme.uiFont(size: 16, weight: .semibold))
            .foregroundStyle(isPrimary ? AppTheme.onEmber : isEnabled ? AppTheme.textPrimary : AppTheme.textTertiary)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(isPrimary ? AppTheme.accent : AppTheme.textPrimary.opacity(0.07), in: Capsule())
            .contentShape(Capsule())
            .opacity(configuration.isPressed ? 0.8 : 1)
    }
}
