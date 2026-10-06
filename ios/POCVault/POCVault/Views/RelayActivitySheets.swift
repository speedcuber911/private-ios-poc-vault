import SwiftUI
import UIKit

// The steps sheet and the step detail pushed inside it.
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 2.

/// What the reader tapped: an activity row (a list of steps) or a live row (one
/// step), in a job's timeline or in a history message's.
struct RelayActivityRequest: Identifiable, Hashable {
    enum Source: Hashable {
        case job(String)
        case message(String)
    }

    enum Root: Hashable {
        case block(String)
        case step(String)
    }

    let source: Source
    let root: Root

    var id: String { "\(source)|\(root)" }
}

enum RelayActivitySheetStyle {
    static let ground = Color(hex: 0x211E1A)
    static let cornerRadius: CGFloat = 34
    static let block = AppTheme.textPrimary.opacity(0.05)
    static let control = AppTheme.textPrimary.opacity(0.08)
    static let groupRadius: CGFloat = 18
    static let blockRadius: CGFloat = 12
    /// The sheet grows with its content up to this share of the screen, then scrolls.
    static let maxScreenShare: CGFloat = 0.7
    static let headerHeight: CGFloat = 76

    static func detentHeight(content: CGFloat, screen: CGFloat) -> CGFloat {
        let wanted = headerHeight + max(content, 60)
        return min(wanted, (screen * maxScreenShare).rounded())
    }
}

/// A bottom sheet sized to its content. It reads the timeline from the view
/// model on every pass, so a sheet opened on a running step keeps updating and
/// flips to done with it.
struct RelayActivitySheet: View {
    let request: RelayActivityRequest
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss
    /// Step ids pushed on top of the root page.
    @State private var path: [String] = []
    @State private var contentHeight: CGFloat = 240
    /// A row that stands for one step opens that step, not a list of one.
    /// Decided when the sheet opens so a block that grows does not swap pages.
    @State private var soleStepID: String?

    init(request: RelayActivityRequest, viewModel: RelayChatViewModel) {
        self.request = request
        self.viewModel = viewModel
        let timeline = Self.timeline(for: request, in: viewModel)
        var sole: String?
        if case .block(let id) = request.root,
           let block = timeline.blocks.first(where: { $0.id == id }) {
            let steps = timeline.steps(in: block)
            if steps.count == 1 { sole = steps[0].id }
        }
        _soleStepID = State(initialValue: sole)
    }

    private static func timeline(for request: RelayActivityRequest, in viewModel: RelayChatViewModel) -> RelayTimeline {
        switch request.source {
        case .job(let id):
            return viewModel.timeline(forJobID: id) ?? RelayTimeline()
        case .message(let id):
            return viewModel.messages.first { $0.id == id }?.historyTimeline ?? RelayTimeline()
        }
    }

    private var timeline: RelayTimeline { Self.timeline(for: request, in: viewModel) }

    private var currentStepID: String? {
        if let last = path.last { return last }
        if case .step(let id) = request.root { return id }
        return soleStepID
    }

    private var rootSteps: [RelayStep] {
        guard case .block(let id) = request.root,
              let block = timeline.blocks.first(where: { $0.id == id }) else { return [] }
        return timeline.steps(in: block)
    }

    private var title: String {
        if let id = currentStepID {
            return timeline.step(id)?.title ?? "Step"
        }
        let count = rootSteps.count
        return count == 1 ? "1 step" : "\(count) steps"
    }

    var body: some View {
        let timeline = timeline
        VStack(spacing: 0) {
            header
            ScrollView {
                page(timeline)
                    .padding(.horizontal, 16)
                    .padding(.bottom, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background {
                        GeometryReader { proxy in
                            Color.clear.preference(key: RelayActivityHeightKey.self, value: proxy.size.height)
                        }
                    }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .onPreferenceChange(RelayActivityHeightKey.self) { height in
            guard abs(height - contentHeight) > 0.5 else { return }
            contentHeight = height
        }
        .presentationDetents([
            .height(RelayActivitySheetStyle.detentHeight(
                content: contentHeight,
                screen: UIScreen.main.bounds.height
            )),
        ])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(RelayActivitySheetStyle.cornerRadius)
        .presentationBackground(RelayActivitySheetStyle.ground)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        ZStack {
            Text(title)
                .font(AppTheme.serifFont(size: 19, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .padding(.horizontal, 60)
                .accessibilityAddTraits(.isHeader)
            HStack {
                Button {
                    if path.isEmpty {
                        dismiss()
                    } else {
                        withAnimation(.easeOut(duration: 0.18)) { _ = path.removeLast() }
                    }
                } label: {
                    Image(systemName: path.isEmpty ? "xmark" : "chevron.left")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .frame(width: 36, height: 36)
                        .background(RelayActivitySheetStyle.control, in: Circle())
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(path.isEmpty ? "Close" : "Back")
                .accessibilityIdentifier("relay-activity-close")
                Spacer()
            }
            // The 36pt circle sits on the same 16pt gutter as the content.
            .padding(.horizontal, 12)
        }
        .frame(height: RelayActivitySheetStyle.headerHeight - 24)
        .padding(.top, 18)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func page(_ timeline: RelayTimeline) -> some View {
        if let id = currentStepID {
            if let step = timeline.step(id) {
                RelayStepDetail(step: step, children: timeline.children(of: id)) { child in
                    push(child)
                }
                .id(id)
                .transition(.opacity)
            }
        } else {
            RelayStepList(steps: rootSteps, timeline: timeline) { step in
                push(step.id)
            }
            .transition(.opacity)
        }
    }

    private func push(_ id: String) {
        withAnimation(.easeOut(duration: 0.18)) { path.append(id) }
    }
}

private struct RelayActivityHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Steps

/// One rounded group of step rows with inset hairlines.
struct RelayStepList: View {
    let steps: [RelayStep]
    let timeline: RelayTimeline
    let onOpen: (RelayStep) -> Void

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                if index > 0 {
                    Rectangle()
                        .fill(AppTheme.hairline)
                        .frame(height: 1)
                        .padding(.leading, 16)
                }
                RelayStepRow(step: step, childCount: timeline.children(of: step.id).count) {
                    onOpen(step)
                }
            }
        }
        .background(
            RelayActivitySheetStyle.block,
            in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.groupRadius, style: .continuous)
        )
    }
}

struct RelayStepRow: View {
    let step: RelayStep
    let childCount: Int
    let action: () -> Void

    /// Wide enough for the longest status word ("SEARCHING") at caps size.
    static let wordColumn: CGFloat = 76

    var body: some View {
        Button(action: action) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                RelayCapsLabel(text: step.statusWord, color: step.statusColor, size: 9.5)
                    .lineLimit(1)
                    .frame(width: Self.wordColumn, alignment: .leading)
                Text(step.rowSummary)
                    .font(AppTheme.uiFont(size: 14))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .frame(maxWidth: .infinity, alignment: .leading)
                trailing
                    .font(AppTheme.monoFont(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(1)
                    .fixedSize()
            }
            .padding(.horizontal, 16)
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-step-row")
    }

    @ViewBuilder
    private var trailing: some View {
        let steps = step.kind == .agent && childCount > 0
            ? (childCount == 1 ? "1 step" : "\(childCount) steps")
            : nil
        if step.status.isRunning {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(Self.join(steps, step.duration(now: context.date).map(RelayStepClock.clock)))
            }
        } else {
            Text(Self.join(steps, step.finishedDurationLabel))
        }
    }

    private static func join(_ parts: String?...) -> String {
        parts.compactMap { $0 }.joined(separator: " · ")
    }
}

// MARK: - Detail

struct RelayStepDetail: View {
    let step: RelayStep
    let children: [RelayStep]
    let onOpenChild: (String) -> Void
    @State private var promptExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            statusLine
            sections
            if let error = step.error?.trimmedNonEmpty {
                section("Error") { textBlock(error, mono: false, color: AppTheme.statusError) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The word and the clock: ember and ticking while the step runs, then its
    /// outcome and how long it took.
    private var statusLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            RelayCapsLabel(text: step.statusWord, color: step.statusColor, size: 10)
            if step.status.isRunning {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(step.duration(now: context.date).map(RelayStepClock.clock) ?? "")
                }
            } else if let label = step.finishedDurationLabel {
                Text(label)
            }
            if step.kind == .command, let exitCode = step.exitCode, exitCode != 0 {
                RelayCapsLabel(text: "Exit \(exitCode)", color: AppTheme.statusError, size: 10)
            }
            Spacer(minLength: 0)
        }
        .font(AppTheme.monoFont(size: 11))
        .foregroundStyle(AppTheme.textTertiary)
    }

    @ViewBuilder
    private var sections: some View {
        switch step.kind {
        case .command:
            optional("Description", step.input.description ?? step.summary, mono: false)
            optional("Command", step.input.command, mono: true)
            output
        case .read:
            optional("Path", step.input.path, mono: true)
        case .edit, .write:
            optional("Path", step.input.path, mono: true)
            // One ink for the whole diff: the +/- markers already say which side.
            optional("Diff", step.input.diff, mono: true)
        case .search:
            optional("Pattern", step.input.pattern, mono: true)
            optional("Path", step.input.path, mono: true)
            output
        case .fetch:
            optional("URL", step.input.url, mono: true)
            optional("Query", step.input.query, mono: false)
            output
        case .tool:
            optional("Name", toolName, mono: true)
            optional("Input", step.input.json, mono: true)
            output
        case .agent:
            agentSections
        case .reasoning:
            if let thought = step.output.trimmedNonEmpty {
                Text(thought)
                    .font(RelayChatStyle.bodyFont)
                    .foregroundStyle(RelayChatStyle.secondary)
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .todo:
            if let items = step.input.items, !items.isEmpty {
                section("Plan") { todoList(items) }
            }
            output
        }
    }

    private var toolName: String? {
        guard let name = step.input.name?.trimmedNonEmpty else { return nil }
        if let server = step.input.server?.trimmedNonEmpty { return "\(server) · \(name)" }
        return name
    }

    /// Output keeps its own indentation: only the blank lines around it go.
    private var outputText: String? {
        let text = step.output.trimmingCharacters(in: .newlines)
        return text.trimmingCharacters(in: .whitespaces).isEmpty ? nil : text
    }

    @ViewBuilder
    private var output: some View {
        if let text = outputText {
            section("Output") {
                textBlock(text, mono: true)
                if step.outputTruncated {
                    RelayCapsLabel(text: "Output truncated", color: AppTheme.textTertiary, size: 9)
                }
            }
        }
    }

    @ViewBuilder
    private var agentSections: some View {
        if let prompt = (step.input.prompt ?? step.input.description)?.trimmedNonEmpty {
            section("Prompt") {
                VStack(alignment: .leading, spacing: 0) {
                    Text(prompt)
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineSpacing(3)
                        .lineLimit(promptExpanded ? nil : 4)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if prompt.count > 180 || prompt.filter(\.isNewline).count >= 4 {
                        Button(promptExpanded ? "Show less" : "Show all") {
                            promptExpanded.toggle()
                        }
                        .buttonStyle(.plain)
                        .font(RelayChatStyle.labelFont)
                        .foregroundStyle(RelayChatStyle.secondary)
                        .frame(minHeight: 44, alignment: .bottomLeading)
                        .accessibilityIdentifier("relay-step-prompt-toggle")
                    }
                }
                .padding(12)
                .background(
                    RelayActivitySheetStyle.block,
                    in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
                )
            }
        }
        if !children.isEmpty {
            section(children.count == 1 ? "1 step" : "\(children.count) steps") {
                VStack(spacing: 0) {
                    ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                        if index > 0 {
                            Rectangle()
                                .fill(AppTheme.hairline)
                                .frame(height: 1)
                                .padding(.leading, 16)
                        }
                        RelayStepRow(step: child, childCount: 0) { onOpenChild(child.id) }
                    }
                }
                .background(
                    RelayActivitySheetStyle.block,
                    in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.groupRadius, style: .continuous)
                )
            }
        }
        if let report = step.output.trimmedNonEmpty {
            section("Report") {
                RelayMarkdownText(text: report, userAligned: false, bodyFont: AppTheme.uiFont(size: 14))
                    .padding(12)
                    .background(
                        RelayActivitySheetStyle.block,
                        in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
                    )
            }
        }
    }

    private func todoList(_ items: [RelayTodoItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    RelayCapsLabel(
                        text: item.statusWord,
                        color: item.isInProgress ? AppTheme.accentBright : AppTheme.textTertiary,
                        size: 9
                    )
                    .frame(width: 52, alignment: .leading)
                    Text(item.text)
                        .font(AppTheme.uiFont(size: 14))
                        .foregroundStyle(item.isDone ? AppTheme.textSecondary : AppTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RelayActivitySheetStyle.block,
            in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
        )
    }

    // An empty section is omitted rather than drawn as a blank box.
    @ViewBuilder
    private func optional(_ title: String, _ text: String?, mono: Bool) -> some View {
        if let text = text?.trimmedNonEmpty {
            section(title) { textBlock(text, mono: mono) }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            RelayCapsLabel(text: title, color: AppTheme.textTertiary, size: 9.5)
            content()
        }
    }

    private func textBlock(_ text: String, mono: Bool, color: Color = AppTheme.textPrimary) -> some View {
        Text(text)
            .font(mono ? AppTheme.monoFont(size: 12) : AppTheme.uiFont(size: 14))
            .foregroundStyle(color)
            .lineSpacing(mono ? 2 : 3)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(
                RelayActivitySheetStyle.block,
                in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
            )
    }
}

// MARK: - Presentation helpers

extension RelayStep {
    /// `4s` once a step is over. Nil for one that never reported its times, and
    /// for the sub-second steps where "0s" would only be noise.
    var finishedDurationLabel: String? {
        guard !status.isRunning, let startedAt, let endedAt else { return nil }
        let seconds = max(0, endedAt.timeIntervalSince(startedAt))
        return seconds >= 0.5 ? RelayStepClock.short(seconds) : nil
    }
}

private extension RelayTodoItem {
    private var normalized: String { (status ?? "").lowercased() }
    var isDone: Bool { normalized == "completed" || normalized == "done" }
    var isInProgress: Bool { normalized == "in_progress" || normalized == "doing" || normalized == "running" }
    var statusWord: String { isDone ? "Done" : isInProgress ? "Doing" : "To do" }
}
