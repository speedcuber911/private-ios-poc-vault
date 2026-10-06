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
    static let label = AppTheme.textPrimary.opacity(0.6)
    static let groupRadius: CGFloat = 18
    static let blockRadius: CGFloat = 12
    /// Blocks and grouped lists sit on the 16pt gutter; labels and bare prose
    /// align with the text inside them, 16pt further in.
    static let gutter: CGFloat = 16
    static let textInset: CGFloat = 32
    static let bottomPadding: CGFloat = 28
    /// The sheet grows with its content up to this share of the screen, then scrolls.
    static let maxScreenShare: CGFloat = 0.7
    /// Drag indicator, the 44pt control row, and the space under it.
    static let headerHeight: CGFloat = 69

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
                    .padding(.bottom, RelayActivitySheetStyle.bottomPadding)
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
        HStack(spacing: 0) {
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

            Text(title)
                .font(AppTheme.serifFont(size: 19, weight: .medium))
                .foregroundStyle(AppTheme.textPrimary)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .accessibilityAddTraits(.isHeader)

            Color.clear.frame(width: 44, height: 44)
        }
        .padding(.horizontal, 10)
        .padding(.top, 19)
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
            .padding(.top, 4)
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
                    RelayHairline().padding(.horizontal, 16)
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
        .padding(.horizontal, RelayActivitySheetStyle.gutter)
    }
}

struct RelayStepRow: View {
    let step: RelayStep
    let childCount: Int
    let action: () -> Void

    static let wordColumn: CGFloat = 68

    /// A step with nothing behind it (thinking that sent no text) is a plain
    /// line: no chevron, no tap.
    private var opens: Bool { step.hasDetail || childCount > 0 }
    private var stepCount: String? {
        guard step.kind == .agent, childCount > 0 else { return nil }
        return childCount == 1 ? "1 step" : "\(childCount) steps"
    }

    var body: some View {
        if opens {
            Button(action: action) { label }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-step-row")
        } else {
            label
        }
    }

    private var label: some View {
        let summary = step.rowSummary
        return HStack(spacing: 8) {
            RelayCapsLabel(text: step.statusWord, color: step.statusColor, size: 10)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .frame(width: Self.wordColumn, alignment: .leading)
            VStack(alignment: .leading, spacing: 2) {
                Text(summary.text)
                    .font(summary.isCode ? RelayTranscriptStyle.mono : RelayTranscriptStyle.rowTitle)
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let stepCount {
                    Text(stepCount)
                        .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RelayStepDuration(step: step, color: AppTheme.textSecondary)
            if opens {
                RelayRowChevron()
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, 12)
        .frame(minHeight: stepCount == nil ? 52 : 64)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// How long a step took, or a ticking clock in ember while it runs.
struct RelayStepDuration: View {
    let step: RelayStep
    var color: Color = RelayActivitySheetStyle.label

    var body: some View {
        Group {
            if step.status.isRunning {
                if step.startedAt != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(RelayStepClock.clock(step.duration(now: context.date) ?? 0))
                            .foregroundStyle(AppTheme.accentBright)
                    }
                }
            } else if let label = step.finishedDurationLabel {
                Text(label).foregroundStyle(color)
            }
        }
        .font(RelayTranscriptStyle.clock)
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize()
    }
}

// MARK: - Detail

/// One labelled part of a step's detail page.
struct RelayStepSection: Identifiable, Equatable {
    enum Content: Equatable {
        /// DM Sans 15/22.
        case prose(String)
        /// DM Mono 13/20: commands, paths, patterns, JSON.
        case code(String)
        /// DM Mono 12/18, quieter: what a command printed.
        case output(String)
        case failure(String)
        case diff([RelayDiffLine])
        case plan([RelayTodoItem])
    }

    enum Trailing: Equatable {
        case duration
        case exit(Int)
        case text(String)
        case note(String)
    }

    let title: String
    let content: Content
    var trailing: Trailing? = nil

    var id: String { title }
}

struct RelayDiffLine: Equatable {
    enum Kind: Equatable { case context, added, removed }

    let kind: Kind
    let text: String

    /// Unified-diff text to rows. File headers are dropped; the Path section
    /// already names the file.
    static func parse(_ diff: String) -> [RelayDiffLine] {
        diff.split(separator: "\n", omittingEmptySubsequences: false).compactMap { raw -> RelayDiffLine? in
            let line = String(raw)
            if line.hasPrefix("+++") || line.hasPrefix("---") || line.hasPrefix("diff --git")
                || line.hasPrefix("index ") || line.hasPrefix("\\ No newline") {
                return nil
            }
            if line.hasPrefix("+") { return RelayDiffLine(kind: .added, text: String(line.dropFirst())) }
            if line.hasPrefix("-") { return RelayDiffLine(kind: .removed, text: String(line.dropFirst())) }
            return RelayDiffLine(kind: .context, text: line.hasPrefix(" ") ? String(line.dropFirst()) : line)
        }
    }

    /// "+1 −1".
    static func stat(_ lines: [RelayDiffLine]) -> String {
        let added = lines.filter { $0.kind == .added }.count
        let removed = lines.filter { $0.kind == .removed }.count
        return "+\(added) −\(removed)"
    }
}

extension RelayStep {
    /// Output keeps its own indentation: only the blank lines around it go.
    var trimmedOutput: String? {
        let text = output.trimmingCharacters(in: .newlines)
        return text.trimmingCharacters(in: .whitespaces).isEmpty ? nil : text
    }

    /// The sections of this step's detail page, top to bottom. They follow
    /// what the step carries, not its kind: any step with a command shows it,
    /// any step with output shows that. Empty ones are left out.
    var detailSections: [RelayStepSection] {
        var sections = detailFields.map {
            RelayStepSection(title: $0.title, content: $0.isCode ? .code($0.text) : .prose($0.text))
        }
        if let diff = input.diff?.trimmedNonEmpty {
            let lines = RelayDiffLine.parse(diff)
            sections.append(RelayStepSection(title: "Diff", content: .diff(lines), trailing: .text(RelayDiffLine.stat(lines))))
        }
        if let items = input.items, !items.isEmpty {
            sections.append(RelayStepSection(title: "Plan", content: .plan(items)))
        }
        // An agent's output is its report and a thought's is the thought; both
        // are drawn as prose by their own pages.
        if kind != .agent, kind != .reasoning, let text = trimmedOutput {
            sections.append(RelayStepSection(
                title: "Output",
                content: .output(text),
                trailing: outputTruncated ? .note("Truncated") : nil
            ))
        }
        if let error = error?.trimmedNonEmpty {
            sections.append(RelayStepSection(title: "Error", content: .failure(error)))
        }

        // The clock sits on the Command label; a running step without one
        // still shows it, on its first label.
        if let index = sections.firstIndex(where: { $0.title == "Command" }) {
            sections[index].trailing = .duration
        } else if status.isRunning, let first = sections.indices.first, sections[first].trailing == nil {
            sections[first].trailing = .duration
        }
        // A non-zero exit is said where the output is, or failing that on the command.
        if let exitCode, exitCode != 0,
           let index = sections.firstIndex(where: { $0.title == "Output" })
            ?? sections.firstIndex(where: { $0.title == "Command" }) {
            sections[index].trailing = .exit(exitCode)
        }
        return sections
    }
}

struct RelayStepDetail: View {
    let step: RelayStep
    let children: [RelayStep]
    let onOpenChild: (String) -> Void
    @State private var promptExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch step.kind {
            case .agent:
                agentPage
            case .reasoning:
                if let thought = step.output.trimmedNonEmpty {
                    Text(thought)
                        .font(RelayChatStyle.bodyFont)
                        .foregroundStyle(RelayChatStyle.secondary)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, RelayActivitySheetStyle.textInset)
                        .padding(.top, 6)
                }
            default:
                let sections = step.detailSections
                if sections.isEmpty {
                    // Opened on a step whose input has not arrived yet.
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        RelayCapsLabel(text: step.statusWord, color: step.statusColor, size: 10)
                        RelayStepDuration(step: step)
                    }
                    .padding(.horizontal, RelayActivitySheetStyle.textInset)
                    .padding(.top, 6)
                }
                ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
                    sectionView(section, isFirst: index == 0)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: Agent

    @ViewBuilder
    private var agentPage: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                RelayCapsLabel(
                    text: step.input.agentType?.trimmedNonEmpty ?? "Agent",
                    color: AppTheme.textPrimary,
                    size: 10
                )
                RelayStepDuration(step: step)
            }
            Text(step.displaySummary)
                .font(.custom("DMSans-9ptRegular", size: 17, relativeTo: .headline).weight(.semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, RelayActivitySheetStyle.textInset)
        .padding(.top, 6)

        if let prompt = step.input.prompt?.trimmedNonEmpty {
            label("Prompt", isFirst: false)
            VStack(alignment: .leading, spacing: 0) {
                Text(prompt)
                    .font(RelayTranscriptStyle.rowTitle)
                    .foregroundStyle(RelayChatStyle.secondary)
                    .lineSpacing(3)
                    .lineLimit(promptExpanded ? nil : 6)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if prompt.count > 280 || prompt.filter(\.isNewline).count >= 6 {
                    Button(promptExpanded ? "Show less" : "Show all") {
                        promptExpanded.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(RelayTranscriptStyle.small.weight(.medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(minHeight: 44, alignment: .bottomLeading)
                    .accessibilityIdentifier("relay-step-prompt-toggle")
                }
            }
            .modifier(RelayDetailBlock())
        }

        if !children.isEmpty {
            label(children.count == 1 ? "1 step" : "\(children.count) steps", isFirst: false)
            VStack(spacing: 0) {
                ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                    if index > 0 {
                        RelayHairline().padding(.horizontal, 16)
                    }
                    RelayStepRow(step: child, childCount: 0) { onOpenChild(child.id) }
                }
            }
            .background(
                RelayActivitySheetStyle.block,
                in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.groupRadius, style: .continuous)
            )
            .padding(.horizontal, RelayActivitySheetStyle.gutter)
        }

        if let report = step.output.trimmedNonEmpty {
            label("Report", isFirst: false)
            RelayMarkdownText(text: report, userAligned: false, bodyFont: RelayChatStyle.bodyFont)
                .padding(.horizontal, RelayActivitySheetStyle.textInset)
        }

        if let error = step.error?.trimmedNonEmpty {
            sectionView(RelayStepSection(title: "Error", content: .failure(error)), isFirst: false)
        }
    }

    // MARK: Sections

    private func label(_ title: String, isFirst: Bool, trailing: RelayStepSection.Trailing? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            RelayCapsLabel(text: title, color: RelayActivitySheetStyle.label, size: 10)
            Spacer(minLength: 8)
            switch trailing {
            case .duration:
                RelayStepDuration(step: step)
            case .exit(let code):
                RelayCapsLabel(text: "Exit \(code)", color: AppTheme.statusError, size: 10)
            case .text(let text):
                Text(text)
                    .font(RelayTranscriptStyle.clock)
                    .foregroundStyle(RelayActivitySheetStyle.label)
            case .note(let text):
                RelayCapsLabel(text: text, color: RelayActivitySheetStyle.label, size: 10)
            case nil:
                EmptyView()
            }
        }
        .padding(.horizontal, RelayActivitySheetStyle.textInset)
        .padding(.top, isFirst ? 6 : 20)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private func sectionView(_ section: RelayStepSection, isFirst: Bool) -> some View {
        label(section.title, isFirst: isFirst, trailing: section.trailing)
        switch section.content {
        case .prose(let text):
            textBlock(text, font: RelayTranscriptStyle.rowTitle, color: AppTheme.textPrimary, lineSpacing: 3)
        case .code(let text):
            textBlock(text, font: RelayTranscriptStyle.mono, color: AppTheme.textPrimary, lineSpacing: 4)
        case .output(let text):
            textBlock(text, font: RelayTranscriptStyle.clock, color: RelayChatStyle.secondary, lineSpacing: 3)
        case .failure(let text):
            textBlock(text, font: RelayTranscriptStyle.rowTitle, color: AppTheme.statusError, lineSpacing: 3)
        case .diff(let lines):
            RelayDiffBlock(lines: lines)
        case .plan(let items):
            planBlock(items)
        }
    }

    /// Text wraps inside its block, anywhere it has to: nothing scrolls sideways.
    private func textBlock(_ text: String, font: Font, color: Color, lineSpacing: CGFloat) -> some View {
        Text(text)
            .font(font)
            .foregroundStyle(color)
            .lineSpacing(lineSpacing)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .modifier(RelayDetailBlock())
    }

    private func planBlock(_ items: [RelayTodoItem]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    RelayCapsLabel(
                        text: item.statusWord,
                        color: item.isInProgress ? AppTheme.accentBright : RelayActivitySheetStyle.label,
                        size: 10
                    )
                    .frame(width: 52, alignment: .leading)
                    Text(item.text)
                        .font(RelayTranscriptStyle.rowTitle)
                        .foregroundStyle(item.isDone ? RelayChatStyle.secondary : AppTheme.textPrimary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(RelayDetailBlock())
    }
}

/// The rounded ink-5% block a detail section's content sits in.
private struct RelayDetailBlock: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .background(
                RelayActivitySheetStyle.block,
                in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
            )
            .padding(.horizontal, RelayActivitySheetStyle.gutter)
    }
}

/// A diff in one ink: the sign column says which side a line is on, and added
/// lines sit on a quiet band. No red, no green.
struct RelayDiffBlock: View {
    let lines: [RelayDiffLine]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                // The sign has its own column, so a wrapped line hangs under its code.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(sign(line.kind))
                        .frame(width: 8, alignment: .leading)
                    Text(line.text.isEmpty ? " " : line.text)
                        .lineSpacing(5)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .foregroundStyle(line.kind == .added ? AppTheme.textPrimary : RelayActivitySheetStyle.label)
                .padding(.vertical, 2)
                .padding(.horizontal, 16)
                .background(line.kind == .added ? AppTheme.textPrimary.opacity(0.08) : Color.clear)
            }
        }
        .font(RelayTranscriptStyle.clock)
        .textSelection(.enabled)
        .padding(.vertical, 8)
        .background(RelayActivitySheetStyle.block)
        .clipShape(RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous))
        .padding(.horizontal, RelayActivitySheetStyle.gutter)
    }

    private func sign(_ kind: RelayDiffLine.Kind) -> String {
        switch kind {
        case .added: return "+"
        case .removed: return "−"
        case .context: return ""
        }
    }
}

// MARK: - Presentation helpers

extension RelayStep {
    /// `0.4s`, `18s`, `1m 12s` once a step is over. Nil for one that never
    /// reported its times, and for the instant ones where "0s" would be noise.
    var finishedDurationLabel: String? {
        guard !status.isRunning, let startedAt, let endedAt else { return nil }
        let seconds = max(0, endedAt.timeIntervalSince(startedAt))
        guard seconds >= 0.05 else { return nil }
        guard seconds < 9.95 else { return RelayStepClock.short(seconds) }
        let tenths = String(format: "%.1f", seconds)
        return (tenths.hasSuffix(".0") ? String(tenths.dropLast(2)) : tenths) + "s"
    }
}

private extension RelayTodoItem {
    private var normalized: String { (status ?? "").lowercased() }
    var isDone: Bool { normalized == "completed" || normalized == "done" }
    var isInProgress: Bool { normalized == "in_progress" || normalized == "doing" || normalized == "running" }
    var statusWord: String { isDone ? "Done" : isInProgress ? "Doing" : "To do" }
}
