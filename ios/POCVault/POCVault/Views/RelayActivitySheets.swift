import SwiftUI
import UIKit

// Paseo 60%/95% tool inspection sheets: shell commands, syntax-highlighted
// unified diffs, structured read/search/agent details, full run log, and usage.

/// What the reader tapped: an activity row (a list of steps) or a single tool step,
/// in a job's timeline or in a history message's timeline.
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
    static let ground = AppTheme.bgCanvas
    static let cornerRadius: CGFloat = 28
    static let block = AppTheme.textPrimary.opacity(0.05)
    static let control = AppTheme.textPrimary.opacity(0.08)
    static let label = AppTheme.textPrimary.opacity(0.6)
    static let groupRadius: CGFloat = 14
    static let blockRadius: CGFloat = 10
    static let gutter: CGFloat = 16
    static let textInset: CGFloat = 16
    static let bottomPadding: CGFloat = 28
    static let maxScreenShare: CGFloat = 0.7
    static let headerHeight: CGFloat = 56

    static func detentHeight(content: CGFloat, screen: CGFloat) -> CGFloat {
        let wanted = headerHeight + max(content, 60)
        return min(wanted, (screen * maxScreenShare).rounded())
    }
}

// MARK: - Activity Inspection Sheet

/// Paseo 60%/95% tool-call inspection sheet. Reads live timeline updates from
/// `viewModel` so an open running command or diff updates smoothly in place.
struct RelayActivitySheet: View {
    let request: RelayActivityRequest
    @ObservedObject var viewModel: RelayChatViewModel
    var timelineOverride: RelayTimeline?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme
    /// Step ids pushed on top of the root page.
    @State private var path: [String] = []
    /// A row that stands for one step opens that step directly.
    @State private var soleStepID: String?
    @State private var copiedHeader = false

    init(request: RelayActivityRequest, viewModel: RelayChatViewModel, timelineOverride: RelayTimeline? = nil) {
        self.request = request
        self.viewModel = viewModel
        self.timelineOverride = timelineOverride
        let timeline = timelineOverride ?? Self.timeline(for: request, in: viewModel)
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

    private var timeline: RelayTimeline { timelineOverride ?? Self.timeline(for: request, in: viewModel) }

    private var currentStepID: String? {
        if let last = path.last { return last }
        if case .step(let id) = request.root { return id }
        return soleStepID
    }

    private var currentStep: RelayStep? {
        currentStepID.flatMap { timeline.step($0) }
    }

    private var rootSteps: [RelayStep] {
        guard case .block(let id) = request.root,
              let block = timeline.blocks.first(where: { $0.id == id }) else { return [] }
        return timeline.steps(in: block)
    }

    private var headerTitle: String {
        if let step = currentStep {
            if step.kind == .agent {
                return step.agent?.name ?? step.agent?.role ?? step.input.agentType ?? "Subagent"
            }
            return step.paseoVerb
        }
        let summary = RelayTimeline.summary(of: rootSteps)
        if Set(rootSteps.map { $0.kind.rawValue }).count > 1 { return "\(rootSteps.count) steps" }
        return summary.isEmpty ? "Activity" : summary
    }

    private var headerSubtitle: String? {
        guard let step = currentStep else {
            return rootSteps.isEmpty ? nil : "\(rootSteps.count) \(rootSteps.count == 1 ? "step" : "steps")"
        }
        if step.kind == .command {
            return step.input.cwd?.trimmedNonEmpty ?? step.input.description?.trimmedNonEmpty
        }
        if let path = step.input.path?.trimmedNonEmpty {
            return path
        }
        if let target = step.paseoTarget, target != headerTitle {
            return target
        }
        return nil
    }

    private var headerIcon: String {
        currentStep?.kind.paseoSymbol ?? "list.bullet"
    }

    private var quickCopyPayload: String? {
        guard let step = currentStep else { return nil }
        if step.kind == .command || (step.input.command != nil && step.input.diff == nil) {
            var parts: [String] = []
            if let cmd = step.input.command?.trimmedNonEmpty { parts.append("$ \(cmd)") }
            if let out = step.trimmedOutput { parts.append(out) }
            return parts.isEmpty ? nil : parts.joined(separator: "\n\n")
        }
        if let diff = step.input.diff?.trimmedNonEmpty { return diff }
        if let out = step.trimmedOutput { return out }
        if let path = step.input.path?.trimmedNonEmpty { return path }
        return nil
    }

    var body: some View {
        let activeTimeline = timeline
        VStack(spacing: 0) {
            sheetHeader

            if let step = currentStep, isShellTranscriptStep(step) {
                RelayShellStepFullSurface(step: step)
                    .id(step.id)
            } else {
                ScrollView {
                    page(activeTimeline)
                        .padding(.bottom, RelayActivitySheetStyle.bottomPadding)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .background(theme.surface0)
        .presentationDetents([.fraction(0.6), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(RelayActivitySheetStyle.cornerRadius)
        .presentationBackground(theme.surface0)
        .preferredColorScheme(theme.colorScheme)
    }

    private func isShellTranscriptStep(_ step: RelayStep) -> Bool {
        step.kind == .command && step.input.diff?.trimmedNonEmpty == nil
    }

    private var sheetHeader: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                if !path.isEmpty {
                    RelayToolbarIconButton(
                        systemImage: "chevron.left",
                        accessibilityLabel: "Back",
                        iconSize: 15,
                        weight: .medium,
                        isMuted: true
                    ) {
                        withAnimation(.easeOut(duration: 0.18)) { _ = path.removeLast() }
                    }
                } else if let step = currentStep, step.kind == .agent {
                    RelayAgentAvatar(seed: step.subagentAvatarSeed)
                } else if let step = currentStep, step.status.isRunning {
                    RelayStatusRing(isActive: true, size: 15, lineWidth: 1.7, showsCenterDot: true)
                        .frame(width: 24, height: 24)
                } else {
                    Image(systemName: headerIcon)
                        .font(.system(size: 16, weight: .regular))
                        .foregroundStyle(currentStep?.status == .failed ? theme.statusDanger : theme.foregroundMuted)
                        .frame(width: 24, height: 24)
                }

                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        Text(headerTitle)
                            .font(RelayTheme.uiFont(16, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .lineLimit(1)

                        if let step = currentStep {
                            RelayStepDuration(step: step, color: theme.foregroundExtraMuted)
                        }
                    }

                    if let subtitle = headerSubtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(RelayTheme.monoFont(11, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityAddTraits(.isHeader)

                HStack(spacing: 2) {
                    if let payload = quickCopyPayload {
                        RelayToolbarIconButton(
                            systemImage: copiedHeader ? "checkmark" : "doc.on.doc",
                            accessibilityLabel: copiedHeader ? "Copied" : "Copy",
                            iconSize: 15,
                            weight: .regular,
                            isMuted: !copiedHeader,
                            tint: copiedHeader ? theme.statusSuccess : nil
                        ) {
                            UIPasteboard.general.string = payload
                            copiedHeader = true
                            UIImpactFeedbackGenerator(style: .light).impactOccurred()
                        }
                        .task(id: copiedHeader) {
                            guard copiedHeader else { return }
                            try? await Task.sleep(for: .seconds(1.8))
                            copiedHeader = false
                        }
                    }

                    RelayToolbarIconButton(
                        systemImage: "xmark",
                        accessibilityLabel: path.isEmpty ? "Close" : "Back",
                        iconSize: 14,
                        weight: .medium,
                        isMuted: true
                    ) {
                        dismiss()
                    }
                    .accessibilityIdentifier("relay-activity-close")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 12)
            .background(theme.surface0)

            Rectangle()
                .fill(theme.border)
                .frame(height: 1)
        }
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
            .padding(.top, 8)
            .transition(.opacity)
        }
    }

    private func push(_ id: String) {
        withAnimation(.easeOut(duration: 0.18)) { path.append(id) }
    }
}

// MARK: - Full-Bleed Shell Surface

/// Paseo full-bleed dark code surface for Shell / Command tool calls:
/// `$ <command>\n\n<output>` in `SF Mono 12pt`, horizontal + vertical scrolling.
private struct RelayShellStepFullSurface: View {
    let step: RelayStep
    @Environment(\.relayTheme) private var theme

    private var commandText: String {
        step.input.command?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    private var outputText: String? {
        step.trimmedOutput
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if step.exitCode != nil || step.outputTruncated || step.status == .running {
                HStack(spacing: 8) {
                    if let exitCode = step.exitCode {
                        Text("exit \(exitCode)")
                            .font(RelayTheme.monoFont(11, weight: .medium))
                            .foregroundStyle(exitCode == 0 ? theme.foregroundMuted : theme.statusDanger)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(
                                exitCode == 0 ? theme.surface2 : theme.statusDangerTint,
                                in: Capsule()
                            )
                    } else if step.status == .running {
                        RelayStatusBadge("Running", bucket: .running, showsDot: true, compact: true)
                    }

                    if step.outputTruncated {
                        Text("Truncated")
                            .font(RelayTheme.monoFont(11, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    }

                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(theme.surface1)

                Rectangle()
                    .fill(theme.border)
                    .frame(height: 1)
            }

            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 14) {
                    if !commandText.isEmpty {
                        HStack(alignment: .top, spacing: 6) {
                            Text("$")
                                .font(RelayTheme.monoFont(12, weight: .semibold))
                                .foregroundStyle(theme.accentBright)
                            Text(RelaySyntaxHighlighter.highlightBlock(commandText, languageOrPath: "command.sh", theme: theme))
                                .font(RelayTheme.monoFont(12, weight: .regular))
                                .lineSpacing(4)
                                .textSelection(.enabled)
                        }
                    }

                    if let output = outputText {
                        Text(output)
                            .font(RelayTheme.monoFont(12, weight: .regular))
                            .foregroundStyle(theme.terminalFg.opacity(0.9))
                            .lineSpacing(3.5)
                            .textSelection(.enabled)
                    } else if step.status.isRunning {
                        Text("Waiting for output…")
                            .font(RelayTheme.monoFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    } else if commandText.isEmpty {
                        Text("No command output recorded.")
                            .font(RelayTheme.monoFont(12, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                    }

                    if let error = step.error?.trimmedNonEmpty {
                        Text(error)
                            .font(RelayTheme.monoFont(12, weight: .regular))
                            .foregroundStyle(theme.statusDanger)
                            .padding(10)
                            .background(theme.statusDangerTint, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                            .textSelection(.enabled)
                    }
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(theme.terminalBg)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - Steps List

struct RelayStepList: View {
    let steps: [RelayStep]
    let timeline: RelayTimeline
    let onOpen: (RelayStep) -> Void
    @Environment(\.relayTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                RelayStepRow(step: step, childCount: timeline.children(of: step.id).count) {
                    onOpen(step)
                }
                if index + 1 < steps.count {
                    Rectangle()
                        .fill(theme.border)
                        .frame(height: 1)
                        .padding(.leading, 44)
                }
            }
        }
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .padding(.horizontal, RelayActivitySheetStyle.gutter)
    }
}

struct RelayStepRow: View {
    let step: RelayStep
    let childCount: Int
    let action: () -> Void
    @Environment(\.relayTheme) private var theme

    static let wordColumn: CGFloat = 68

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
        return HStack(spacing: 10) {
            Group {
                if step.status.isRunning {
                    RelayStatusRing(isActive: true, size: 13, lineWidth: 1.5, showsCenterDot: true)
                } else {
                    Image(systemName: step.kind.paseoSymbol)
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(step.status == .failed ? theme.statusDanger : theme.foregroundMuted)
                }
            }
            .frame(width: 22, alignment: .center)
            .accessibilityHidden(true)

            VStack(alignment: .leading, spacing: 3) {
                Text(step.paseoVerb)
                    .font(RelayTheme.uiFont(14, weight: .medium))
                    .foregroundStyle(step.status == .failed ? theme.statusDanger : theme.foreground)
                Text(summary.text)
                    .font(summary.isCode ? RelayTheme.monoFont(12) : RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let stepCount {
                    Text(stepCount)
                        .font(RelayTheme.uiFont(12))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            RelayStepDuration(step: step, color: theme.foregroundExtraMuted)
            if opens {
                RelayRowChevron()
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .frame(minHeight: 54)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// How long a step took, or a ticking clock while it runs.
struct RelayStepDuration: View {
    let step: RelayStep
    var color: Color? = nil
    @Environment(\.relayTheme) private var theme

    var body: some View {
        Group {
            if step.status.isRunning {
                if step.startedAt != nil {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(RelayStepClock.clock(step.duration(now: context.date) ?? 0))
                            .foregroundStyle(theme.statusDotRunning)
                    }
                }
            } else if let label = step.finishedDurationLabel {
                Text(label).foregroundStyle(color ?? theme.foregroundExtraMuted)
            }
        }
        .font(RelayTheme.monoFont(11, weight: .regular))
        .monospacedDigit()
        .lineLimit(1)
        .fixedSize()
    }
}

// MARK: - Detail Sections

/// One labelled part of a step's detail page.
struct RelayStepSection: Identifiable, Equatable {
    enum Content: Equatable {
        case prose(String)
        case code(String)
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

    /// The sections of this step's detail page, top to bottom.
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

        if let index = sections.firstIndex(where: { $0.title == "Command" }) {
            sections[index].trailing = .duration
        } else if status.isRunning, let first = sections.indices.first, sections[first].trailing == nil {
            sections[first].trailing = .duration
        }
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
    @Environment(\.relayTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            switch step.kind {
            case .agent:
                agentPage
            case .reasoning:
                if let thought = step.output.trimmedNonEmpty {
                    Text(thought)
                        .font(RelayTheme.contentFont(15))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineSpacing(4)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, RelayActivitySheetStyle.textInset)
                        .padding(.top, 14)
                }
            default:
                let sections = step.detailSections
                if sections.isEmpty {
                    HStack(alignment: .center, spacing: 8) {
                        if step.status.isRunning {
                            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                        }
                        Text(step.statusWord)
                            .font(RelayTheme.uiFont(14, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)
                        RelayStepDuration(step: step)
                    }
                    .padding(.horizontal, RelayActivitySheetStyle.textInset)
                    .padding(.top, 16)
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
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                RelayStatusBadge(
                    step.agent?.statusLabel ?? step.statusWord,
                    bucket: agentBucket,
                    showsDot: true,
                    compact: true
                )
                if let role = (step.agent?.role ?? step.input.agentType)?.trimmedNonEmpty {
                    Text(role)
                        .font(RelayTheme.uiFont(12.5, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }
                Spacer(minLength: 0)
                RelayStepDuration(step: step)
            }
            Text(step.displaySummary)
                .font(RelayTheme.uiFont(16, weight: .medium))
                .foregroundStyle(theme.foreground)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, RelayActivitySheetStyle.textInset)
        .padding(.top, 14)

        if let prompt = step.input.prompt?.trimmedNonEmpty {
            sectionHeader("Prompt", isFirst: false)
            VStack(alignment: .leading, spacing: 4) {
                Text(prompt)
                    .font(RelayTheme.uiFont(14))
                    .foregroundStyle(theme.foregroundMuted)
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
                    .font(RelayTheme.uiFont(13, weight: .medium))
                    .foregroundStyle(theme.accentBright)
                    .frame(minHeight: 36, alignment: .bottomLeading)
                    .accessibilityIdentifier("relay-step-prompt-toggle")
                }
            }
            .modifier(RelayDetailBlock())
        }

        if !children.isEmpty {
            sectionHeader(children.count == 1 ? "1 step" : "\(children.count) steps", isFirst: false)
            VStack(spacing: 0) {
                ForEach(Array(children.enumerated()), id: \.element.id) { index, child in
                    RelayStepRow(step: child, childCount: 0) { onOpenChild(child.id) }
                    if index + 1 < children.count {
                        Rectangle()
                            .fill(theme.border)
                            .frame(height: 1)
                            .padding(.leading, 44)
                    }
                }
            }
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            }
            .padding(.horizontal, RelayActivitySheetStyle.gutter)
        }

        if let report = step.output.trimmedNonEmpty {
            sectionHeader("Report", isFirst: false)
            RelayPaseoMarkdownView(text: report, theme: theme, bodyFont: RelayTheme.contentFont(15))
                .padding(.horizontal, RelayActivitySheetStyle.textInset)
        }

        if let error = step.error?.trimmedNonEmpty {
            sectionView(RelayStepSection(title: "Error", content: .failure(error)), isFirst: false)
        }
    }

    private var agentBucket: RelayStatusBucket {
        if step.status.isRunning { return .running }
        if step.status == .failed || step.agent?.statusLabel == "Failed" { return .error }
        if step.agent?.statusLabel == "Working" { return .running }
        if step.agent?.statusLabel == "Waiting" { return .needsInput }
        if step.status == .done || step.agent?.statusLabel == "Done" { return .done }
        return .idle
    }

    // MARK: Sections

    private func sectionHeader(
        _ title: String,
        isFirst: Bool,
        trailing: RelayStepSection.Trailing? = nil,
        copyText: String? = nil
    ) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Text(title)
                .font(RelayTheme.uiFont(12.5, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)

            Spacer(minLength: 8)

            switch trailing {
            case .duration:
                RelayStepDuration(step: step)
            case .exit(let code):
                Text("Exit \(code)")
                    .font(RelayTheme.monoFont(11, weight: .medium))
                    .foregroundStyle(theme.statusDanger)
            case .text(let text):
                Text(text)
                    .font(RelayTheme.monoFont(11.5, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
            case .note(let text):
                Text(text)
                    .font(RelayTheme.monoFont(11, weight: .regular))
                    .foregroundStyle(theme.foregroundExtraMuted)
            case nil:
                EmptyView()
            }

            if let copyText {
                RelayCopyButton(text: copyText, iconOnly: true)
            }
        }
        .padding(.horizontal, RelayActivitySheetStyle.textInset)
        .padding(.top, isFirst ? 12 : 18)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func sectionView(_ section: RelayStepSection, isFirst: Bool) -> some View {
        sectionHeader(
            section.title,
            isFirst: isFirst,
            trailing: section.trailing,
            copyText: section.copyText
        )

        switch section.content {
        case .prose(let text):
            Text(text)
                .font(RelayTheme.uiFont(14.5))
                .foregroundStyle(theme.foreground)
                .lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, RelayActivitySheetStyle.textInset)

        case .code(let text):
            let hint = section.title == "Command"
                ? "command.sh"
                : (section.title == "Path" ? "plain" : (step.input.path ?? "content.json"))
            ScrollView(.horizontal, showsIndicators: false) {
                Text(RelaySyntaxHighlighter.highlightBlock(text, languageOrPath: hint, theme: theme))
                    .font(RelayTheme.monoFont(12))
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .modifier(RelayDetailBlock())

        case .output(let text):
            let hint = step.input.path ?? ""
            ScrollView(.horizontal, showsIndicators: false) {
                Group {
                    if !hint.isEmpty {
                        Text(RelaySyntaxHighlighter.highlightBlock(text, languageOrPath: hint, theme: theme))
                    } else {
                        Text(text).foregroundStyle(theme.foregroundMuted)
                    }
                }
                .font(RelayTheme.monoFont(12))
                .lineSpacing(3.5)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .modifier(RelayDetailBlock())

        case .failure(let text):
            Text(text)
                .font(RelayTheme.uiFont(13.5))
                .foregroundStyle(theme.statusDanger)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(theme.statusDangerTint, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .padding(.horizontal, RelayActivitySheetStyle.gutter)

        case .diff(let lines):
            RelayDiffBlock(lines: lines, filePath: step.input.path ?? "")

        case .plan(let items):
            planBlock(items)
        }
    }

    private func planBlock(_ items: [RelayTodoItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .top, spacing: 10) {
                    Group {
                        if item.isDone {
                            Image(systemName: "checkmark")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(theme.statusSuccess)
                        } else if item.isInProgress {
                            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                        } else {
                            Circle()
                                .strokeBorder(theme.foregroundExtraMuted, lineWidth: 1.25)
                                .frame(width: 11, height: 11)
                        }
                    }
                    .frame(width: 16, height: 18, alignment: .center)

                    Text(item.text)
                        .font(RelayTheme.uiFont(14))
                        .foregroundStyle(item.isDone ? theme.foregroundMuted : theme.foreground)
                        .strikethrough(item.isDone, color: theme.foregroundExtraMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .modifier(RelayDetailBlock())
    }
}

private struct RelayDetailBlock: ViewModifier {
    @Environment(\.relayTheme) private var theme

    func body(content: Content) -> some View {
        content
            .padding(.vertical, 12)
            .padding(.horizontal, 14)
            .background(
                theme.surface1,
                in: RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
            )
            .overlay {
                RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            }
            .padding(.horizontal, RelayActivitySheetStyle.gutter)
    }
}

/// Paseo syntax-highlighted unified diff block with calibrated green/red line
/// tints, `+`/`-` gutter markers, file path header, and horizontal scrolling.
struct RelayDiffBlock: View {
    let lines: [RelayDiffLine]
    var filePath: String = ""
    @Environment(\.relayTheme) private var theme

    private var stats: (additions: Int, deletions: Int) {
        let added = lines.filter { $0.kind == .added }.count
        let removed = lines.filter { $0.kind == .removed }.count
        return (added, removed)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !filePath.isEmpty {
                HStack(spacing: 8) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 12, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                    Text(filePath)
                        .font(RelayTheme.monoFont(11.5, weight: .medium))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 8)
                    RelayDiffStatView(additions: stats.additions, deletions: stats.deletions)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(theme.surface2.opacity(0.6))

                Rectangle().fill(theme.border).frame(height: 1)
            }

            ScrollView(.horizontal, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(sign(line.kind))
                                .foregroundStyle(signColor(line.kind))
                                .frame(width: 10, alignment: .leading)

                            Text(RelaySyntaxHighlighter.highlight(line: line.text, filePath: filePath, theme: theme))
                                .lineSpacing(4)
                                .fixedSize(horizontal: true, vertical: false)
                        }
                        .padding(.vertical, 2.5)
                        .padding(.horizontal, 12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(rowBackground(line.kind))
                    }
                }
                .padding(.vertical, 6)
            }
        }
        .font(RelayTheme.monoFont(12))
        .textSelection(.enabled)
        .background(theme.surface1)
        .clipShape(RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: RelayActivitySheetStyle.blockRadius, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .padding(.horizontal, RelayActivitySheetStyle.gutter)
    }

    private func sign(_ kind: RelayDiffLine.Kind) -> String {
        switch kind {
        case .added: return "+"
        case .removed: return "-"
        case .context: return " "
        }
    }

    private func signColor(_ kind: RelayDiffLine.Kind) -> Color {
        switch kind {
        case .added: return theme.diffAddition
        case .removed: return theme.diffDeletion
        case .context: return theme.foregroundExtraMuted
        }
    }

    private func rowBackground(_ kind: RelayDiffLine.Kind) -> Color {
        switch kind {
        case .added: return theme.diffAdditionBg
        case .removed: return theme.diffDeletionBg
        case .context: return .clear
        }
    }
}

// MARK: - Full Run Log Sheet (Paseo 60%/95%)

struct RelayFullLogSheet: View {
    let jobID: String
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme
    @State private var rawText: String?
    @State private var showingRaw = false
    @State private var expandedStepIDs: Set<String> = []
    @State private var stepsExpanded = false
    @State private var receiptExpanded = false
    @State private var pinToBottom = true
    @State private var copiedRaw = false

    private var job: CodexJob? {
        viewModel.liveJob(id: jobID)
    }

    private var blocks: [RelayRunLogBlock] {
        RelayRunLogParser.parse(rawText ?? "")
    }

    private var proseBlocks: [RelayRunLogBlock] {
        blocks.filter {
            if case .prose = $0.kind { return true }
            return false
        }
    }

    private var stepBlocks: [RelayRunLogBlock] {
        blocks.filter {
            switch $0.kind {
            case .step, .warning: return true
            case .prose: return false
            }
        }
    }

    private var warningCount: Int {
        blocks.reduce(0) { count, block in
            if case .warning = block.kind { return count + 1 }
            return count
        }
    }

    private var stepCount: Int {
        blocks.reduce(0) { count, block in
            if case .step = block.kind { return count + 1 }
            return count
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            sheetHeader

            Group {
                if showingRaw {
                    rawLogView
                } else {
                    structuredLogView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(theme.surface0)

            if job?.status.isActive == true {
                VStack(spacing: 0) {
                    Rectangle().fill(theme.border).frame(height: 1)
                    HStack {
                        HStack(spacing: 6) {
                            RelayStatusRing(isActive: pinToBottom, size: 10, lineWidth: 1.4, showsCenterDot: true)
                            Text(pinToBottom ? "Following latest" : "Auto-follow paused")
                                .foregroundStyle(theme.foregroundMuted)
                        }
                        Spacer()
                        Button(pinToBottom ? "Pause" : "Follow latest") {
                            pinToBottom.toggle()
                        }
                        .foregroundStyle(theme.foreground)
                        .frame(minHeight: 40)
                    }
                    .font(RelayTheme.uiFont(13.5, weight: .medium))
                    .padding(.horizontal, 16)
                    .background(theme.surface0)
                }
            }
        }
        .background(theme.surface0)
        .presentationDetents([.fraction(0.6), .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(RelayActivitySheetStyle.cornerRadius)
        .presentationBackground(theme.surface0)
        .preferredColorScheme(theme.colorScheme)
        .task(id: jobID) {
            await pollFullLogWhileActive()
        }
    }

    private var sheetHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Image(systemName: "terminal")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(theme.foregroundMuted)
                    .frame(width: 24, height: 24)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Run log")
                        .font(RelayTheme.uiFont(16, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    if let job {
                        HStack(spacing: 6) {
                            Text(providerModelLabel(job))
                                .font(RelayTheme.uiFont(12.5))
                                .foregroundStyle(theme.foregroundMuted)
                                .lineLimit(1)
                            durationLabel(for: job)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let text = rawText, !text.isEmpty {
                    RelayToolbarIconButton(
                        systemImage: copiedRaw ? "checkmark" : "doc.on.doc",
                        accessibilityLabel: "Copy raw log",
                        iconSize: 15,
                        isMuted: !copiedRaw,
                        tint: copiedRaw ? theme.statusSuccess : nil
                    ) {
                        UIPasteboard.general.string = text
                        copiedRaw = true
                        UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    }
                    .task(id: copiedRaw) {
                        guard copiedRaw else { return }
                        try? await Task.sleep(for: .seconds(1.8))
                        copiedRaw = false
                    }
                }

                RelayToolbarIconButton(
                    systemImage: "xmark",
                    accessibilityLabel: "Close",
                    iconSize: 14,
                    weight: .medium,
                    isMuted: true
                ) {
                    dismiss()
                }
            }

            Picker("Log format", selection: $showingRaw) {
                Text("Activity").tag(false)
                Text("Raw").tag(true)
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("relay-run-log-raw")
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 12)
        .background(theme.surface0)
        .overlay(alignment: .bottom) {
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    @ViewBuilder
    private var structuredLogView: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if rawText == nil {
                        ProgressView("Loading run log…")
                            .tint(theme.accent)
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(maxWidth: .infinity, minHeight: 220)
                            .padding(.top, 20)
                    } else if let job, !job.status.isActive {
                        finishedBody(job)
                    } else {
                        runningBody
                    }

                    Color.clear.frame(height: 1).id("run-log-bottom")
                }
            }
            .onChange(of: rawText) { _, _ in
                guard pinToBottom else { return }
                withAnimation(.easeOut(duration: 0.15)) {
                    proxy.scrollTo("run-log-bottom", anchor: .bottom)
                }
            }
            .onChange(of: pinToBottom) { _, following in
                if following { proxy.scrollTo("run-log-bottom", anchor: .bottom) }
            }
            .simultaneousGesture(
                DragGesture().onChanged { value in
                    if value.translation.height > 8 { pinToBottom = false }
                }
            )
        }
    }

    private var rawLogView: some View {
        ScrollViewReader { proxy in
            ScrollView([.horizontal, .vertical]) {
                VStack(alignment: .leading, spacing: 0) {
                    Text((rawText?.isEmpty == false) ? (rawText ?? "") : "No log output.")
                        .font(RelayTheme.monoFont(12))
                        .foregroundStyle(theme.terminalFg)
                        .lineSpacing(3.5)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Color.clear.frame(height: 1).id("raw-log-bottom")
                }
                .padding(16)
            }
            .background(theme.terminalBg)
            .onChange(of: rawText) { _, _ in
                if pinToBottom { proxy.scrollTo("raw-log-bottom", anchor: .bottom) }
            }
            .onChange(of: pinToBottom) { _, following in
                if following { proxy.scrollTo("raw-log-bottom", anchor: .bottom) }
            }
            .simultaneousGesture(
                DragGesture().onChanged { value in
                    if value.translation.height > 8 { pinToBottom = false }
                }
            )
        }
    }

    @ViewBuilder
    private var runningBody: some View {
        ForEach(Array(blocks.enumerated()), id: \.element.id) { _, block in
            blockView(block, compact: false)
            Rectangle().fill(theme.border).frame(height: 1)
        }

        if let receipt = job?.execution {
            receiptDisclosure(receipt)
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    @ViewBuilder
    private func finishedBody(_ job: CodexJob) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(proseBlocks) { block in
                if case .prose(let text) = block.kind {
                    proseSection(text, provider: job.provider)
                }
            }

            if proseBlocks.isEmpty, let answer = job.displayOutput?.trimmedNonEmpty {
                proseSection(answer, provider: job.provider)
            }

            Rectangle().fill(theme.border).frame(height: 1)

            Button {
                withAnimation(.easeOut(duration: 0.16)) { stepsExpanded.toggle() }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: stepsExpanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10.5, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                    Text("\(stepCount) steps")
                        .font(RelayTheme.uiFont(14, weight: .medium))
                        .foregroundStyle(theme.foreground)
                    Spacer()
                    if warningCount > 0 {
                        RelayStatusBadge(
                            "\(warningCount) warning\(warningCount == 1 ? "" : "s")",
                            bucket: .needsInput,
                            compact: true
                        )
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if stepsExpanded {
                Rectangle().fill(theme.border).frame(height: 1)
                ForEach(stepBlocks) { block in
                    blockView(block, compact: true)
                }
            }

            Rectangle().fill(theme.border).frame(height: 1)
            if let receipt = job.execution {
                receiptDisclosure(receipt)
                Rectangle().fill(theme.border).frame(height: 1)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: RelayRunLogBlock, compact: Bool) -> some View {
        switch block.kind {
        case .prose(let text):
            if !compact, let job {
                proseSection(text, provider: job.provider)
            }
        case .step(let command, let output, let exitCode):
            stepRow(id: block.id, command: command, output: output, exitCode: exitCode, compact: compact)
        case .warning(let message):
            warningRow(message, compact: compact)
        }
    }

    private func proseSection(_ text: String, provider: CodexProvider) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(provider.relayPresentation.title)
                .font(RelayTheme.uiFont(12.5, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
            RelayPaseoMarkdownView(text: text, theme: theme, bodyFont: RelayTheme.contentFont(15))
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func stepRow(id: String, command: String, output: String, exitCode: Int?, compact: Bool) -> some View {
        let expanded = expandedStepIDs.contains(id)
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if expanded {
                    expandedStepIDs.remove(id)
                } else {
                    expandedStepIDs.insert(id)
                }
            } label: {
                HStack(spacing: 9) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundStyle(theme.foregroundExtraMuted)
                    Text(command)
                        .font(RelayTheme.monoFont(12.5))
                        .foregroundStyle(expanded || job?.status.isActive == true ? theme.foreground : theme.foregroundMuted)
                        .lineLimit(expanded ? nil : 2)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if let exitCode {
                        Text("exit \(exitCode)")
                            .font(RelayTheme.monoFont(11))
                            .foregroundStyle(exitCode == 0 ? theme.foregroundExtraMuted : theme.statusDanger)
                    } else if job?.status.isActive == true, blocks.last?.id == id, let job {
                        durationLabel(for: job)
                    }
                }
                .padding(.horizontal, compact ? 24 : 16)
                .padding(.vertical, 11)
                .frame(minHeight: 42)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if expanded, !output.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    Text(output)
                        .font(RelayTheme.monoFont(12))
                        .foregroundStyle(theme.foregroundMuted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(12)
                .background(theme.surface1, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(theme.border, lineWidth: 1)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 12)
            }
        }
    }

    private func warningRow(_ message: String, compact: Bool) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text("Warning")
                .font(RelayTheme.uiFont(11, weight: .medium))
                .foregroundStyle(theme.statusWarning)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(theme.statusWarningTint, in: Capsule())
            Text(message)
                .font(RelayTheme.uiFont(compact ? 12.5 : 13))
                .foregroundStyle(theme.foregroundMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, compact ? 24 : 16)
        .padding(.vertical, 10)
    }

    private func receiptDisclosure(_ receipt: CodexExecutionReceipt) -> some View {
        DisclosureGroup(isExpanded: $receiptExpanded) {
            Text(receipt.summaryLines.joined(separator: "\n"))
                .font(RelayTheme.monoFont(11.5))
                .foregroundStyle(theme.foregroundMuted)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 8)
                .padding(.bottom, 10)
        } label: {
            Text("Execution receipt")
                .font(RelayTheme.uiFont(13.5, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
                .padding(.vertical, 4)
        }
        .tint(theme.foregroundExtraMuted)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    private func providerModelLabel(_ job: CodexJob) -> String {
        let provider = job.provider.relayPresentation.title
        if let model = job.model?.trimmedNonEmpty {
            return "\(provider) · \(model)"
        }
        return provider
    }

    @ViewBuilder
    private func durationLabel(for job: CodexJob) -> some View {
        if job.status.isActive, let startedAt = job.startedAt ?? job.createdAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(RelayStepClock.clock(context.date.timeIntervalSince(startedAt)))
                    .font(RelayTheme.monoFont(11))
                    .foregroundStyle(theme.statusDotRunning)
                    .monospacedDigit()
            }
        } else if let seconds = job.finishedSeconds {
            Text(RelayStepClock.short(seconds))
                .font(RelayTheme.monoFont(11))
                .foregroundStyle(theme.foregroundExtraMuted)
                .monospacedDigit()
        }
    }

    private func pollFullLogWhileActive() async {
        repeat {
            rawText = await viewModel.loadFullLog(jobID: jobID)
            let latest = viewModel.liveJob(id: jobID)
            if latest?.status.isActive != true {
                return
            }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
        } while !Task.isCancelled
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
}

private extension RelayStepSection {
    var copyText: String? {
        switch content {
        case .code(let text), .output(let text): return text
        case .diff(let lines):
            return lines.map { line in
                switch line.kind {
                case .added: return "+\(line.text)"
                case .removed: return "-\(line.text)"
                case .context: return " \(line.text)"
                }
            }.joined(separator: "\n")
        default: return nil
        }
    }
}

// MARK: - Conversation Usage Sheet

struct RelayConversationUsageSheet: View {
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme
    @State private var refreshing = false
    @State private var showingExplanation = false

    private var usage: RelayTimelineUsage? { viewModel.conversationUsage }
    private var limits: [RelayUsageLimit] { usage?.limits ?? [] }

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    if showingExplanation {
                        Text("Context is the space used by the latest model request. Plan limits are shared with your other chats. These are the provider’s last reports; they update as it sends new data.")
                            .font(RelayTheme.uiFont(13.5))
                            .foregroundStyle(theme.foregroundMuted)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    section("Context") { contextCard }
                    section("Plan usage") {
                        if limits.isEmpty {
                            unavailable("Plan limits haven’t been reported by this connection.")
                        } else {
                            VStack(spacing: 12) {
                                ForEach(limits.filter { $0.windowMinutes != 10080 }) { limit in limitCard(limit) }
                                if limits.contains(where: { $0.windowMinutes == 10080 }) {
                                    Text("Weekly limits")
                                        .font(RelayTheme.uiFont(13))
                                        .foregroundStyle(theme.foregroundMuted)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.top, 8)
                                    ForEach(limits.filter { $0.windowMinutes == 10080 }) { limit in limitCard(limit) }
                                }
                            }
                        }
                    }
                    if let usage, usage.inputTokens != nil || usage.outputTokens != nil {
                        section("Last turn") {
                            HStack(spacing: 24) {
                                tokenCount("Input tokens", value: usage.inputTokens)
                                tokenCount("Output tokens", value: usage.outputTokens)
                            }
                            .padding(16)
                            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                            .overlay {
                                RoundedRectangle(cornerRadius: 12, style: .continuous)
                                    .strokeBorder(theme.border, lineWidth: 1)
                            }
                        }
                    }
                    Text("Refresh checks your computer for newer reports. Older connections and imported chats may not include usage.")
                        .font(RelayTheme.uiFont(12.5))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .padding(.bottom, 32)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
        .background(theme.surface0)
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(RelayActivitySheetStyle.cornerRadius)
        .presentationBackground(theme.surface0)
        .preferredColorScheme(theme.colorScheme)
    }

    private var header: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "chart.pie")
                    .font(.system(size: 16))
                    .foregroundStyle(theme.foregroundMuted)
                Text("Usage")
                    .font(RelayTheme.uiFont(16, weight: .medium))
                    .foregroundStyle(theme.foreground)
                Spacer()
                RelayToolbarIconButton(
                    systemImage: "arrow.clockwise",
                    accessibilityLabel: "Refresh usage",
                    iconSize: 15,
                    isMuted: true,
                    isDisabled: refreshing
                ) {
                    refreshing = true
                    Task {
                        await viewModel.refreshConversationUsage()
                        refreshing = false
                    }
                }
                RelayToolbarIconButton(
                    systemImage: "info.circle",
                    accessibilityLabel: "About usage",
                    iconSize: 15,
                    isSelected: showingExplanation,
                    isMuted: true
                ) {
                    withAnimation(.easeOut(duration: 0.16)) { showingExplanation.toggle() }
                }
                RelayToolbarIconButton(
                    systemImage: "xmark",
                    accessibilityLabel: "Close usage",
                    iconSize: 14,
                    weight: .medium,
                    isMuted: true
                ) {
                    dismiss()
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            Rectangle().fill(theme.border).frame(height: 1)
        }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(RelayTheme.uiFont(13, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var contextCard: some View {
        if let usage, let tokens = usage.contextTokens {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Text("Context window")
                        .font(RelayTheme.uiFont(15, weight: .medium))
                    Spacer()
                    if let fraction = usage.contextFraction {
                        Text(percent(fraction * 100))
                            .font(RelayTheme.monoFont(12.5))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                }
                if let fraction = usage.contextFraction {
                    ProgressView(value: fraction)
                        .tint(fraction >= 0.8 ? theme.statusWarning : theme.accent)
                        .accessibilityLabel("Context window")
                        .accessibilityValue(percent(fraction * 100))
                }
                Text(usage.contextWindow.map { "\(tokens.formatted()) of \($0.formatted()) tokens" } ?? "\(tokens.formatted()) tokens · capacity not reported")
                    .font(RelayTheme.uiFont(13))
                    .foregroundStyle(theme.foregroundMuted)
                if let date = usage.contextReportedAt { reported(date) }
            }
            .padding(16)
            .foregroundStyle(theme.foreground)
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            }
        } else {
            unavailable("Context usage hasn’t been reported for this chat.")
        }
    }

    private func limitCard(_ limit: RelayUsageLimit) -> some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            let expired = limit.hasReset(at: context.date)
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    Text(limit.title)
                        .font(RelayTheme.uiFont(15, weight: .medium))
                    Spacer(minLength: 8)
                    Text(expired ? "Awaiting update" : limit.usedPercent.map(percent) ?? (limit.status == "rejected" ? "Limit reached" : "Not reported"))
                        .font(RelayTheme.monoFont(12.5))
                        .foregroundStyle(theme.foregroundMuted)
                }
                if !expired, let value = limit.usedPercent {
                    ProgressView(value: value, total: 100)
                        .tint(value >= 80 ? theme.statusWarning : theme.statusDotRunning)
                        .accessibilityLabel(limit.title)
                        .accessibilityValue(percent(value))
                }
                if let date = limit.resetsAt {
                    Text(expired ? "Last window ended \(date.formatted(date: .abbreviated, time: .shortened))" : "Resets \(date.formatted(date: .abbreviated, time: .shortened))")
                        .font(RelayTheme.uiFont(13))
                        .foregroundStyle(theme.foregroundMuted)
                }
                if let date = limit.reportedAt { reported(date) }
            }
            .padding(16)
            .foregroundStyle(theme.foreground)
            .background(theme.surface1, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            }
        }
    }

    private func unavailable(_ message: String) -> some View {
        Text(message)
            .font(RelayTheme.uiFont(13.5))
            .foregroundStyle(theme.foregroundMuted)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
    }

    private func reported(_ date: Date) -> some View {
        Text("Reported \(date.formatted(date: .abbreviated, time: .shortened))")
            .font(RelayTheme.uiFont(12))
            .foregroundStyle(theme.foregroundExtraMuted)
    }

    private func tokenCount(_ title: String, value: Int?) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value.map { $0.formatted() } ?? "—")
                .font(RelayTheme.monoFont(18, weight: .medium))
                .foregroundStyle(theme.foreground)
                .monospacedDigit()
            Text(title)
                .font(RelayTheme.uiFont(12.5))
                .foregroundStyle(theme.foregroundMuted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func percent(_ value: Double) -> String { "\(Int(value.rounded()))% used" }
}
