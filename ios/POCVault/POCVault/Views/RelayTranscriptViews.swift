import SwiftUI
import UIKit

// The transcript's own pieces: how the list follows new content, and the rows a
// turn is drawn from (byline, prose, activity, live steps, footer).
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 2.

// MARK: - Scroll following

/// Whether the transcript follows new content. Pure, so the rule is testable:
/// only the reader's own scrolling decides, and content arriving never does.
struct RelayScrollFollow: Equatable {
    struct Geometry: Equatable {
        var contentHeight: CGFloat
        var viewportHeight: CGFloat
        var offsetY: CGFloat
        var insetTop: CGFloat = 0
        var insetBottom: CGFloat = 0

        /// The offset that shows the last line just above the composer. Content
        /// shorter than the viewport rests at the top.
        var bottomOffsetY: CGFloat {
            max(-insetTop, contentHeight + insetBottom - viewportHeight)
        }

        var distanceFromBottom: CGFloat { max(0, bottomOffsetY - offsetY) }
    }

    /// Closer than this to the end counts as being at the bottom.
    static let threshold: CGFloat = 28

    private(set) var isFollowing = true

    /// The reader moved the list themselves (drag, flick, scroll-to-top).
    mutating func readerScrolled(to geometry: Geometry) {
        isFollowing = geometry.distanceFromBottom <= Self.threshold
    }

    /// Jump-to-latest, sending a message, opening a conversation.
    mutating func resume() {
        isFollowing = true
    }

    /// Where to move the list after content or the viewport changed, or nil to
    /// leave it alone. Never while a finger is down, and never when the reader
    /// has scrolled away.
    func correction(for geometry: Geometry, readerIsTouching: Bool) -> CGFloat? {
        guard isFollowing, !readerIsTouching else { return nil }
        let target = geometry.bottomOffsetY
        return abs(target - geometry.offsetY) > 0.5 ? target : nil
    }
}

/// Watches the transcript's real scroll position and keeps it pinned to the end
/// while the reader is there. It observes the scroll view itself rather than
/// reacting to model changes, so every source of new height (a streamed token, a
/// finished job's outputs, the keyboard, the composer growing) is handled once.
@MainActor
final class RelayTranscriptScroller: ObservableObject {
    /// False once the reader has scrolled away: the jump-to-latest button shows.
    @Published private(set) var isAtBottom = true

    private var follow = RelayScrollFollow()
    private weak var scrollView: UIScrollView?
    private var observations: [NSKeyValueObservation] = []
    private var lastOffsetY: CGFloat = 0
    private var isAdjusting = false

    func attach(_ scrollView: UIScrollView) {
        guard self.scrollView !== scrollView else { return }
        observations.removeAll()
        self.scrollView = scrollView
        lastOffsetY = scrollView.contentOffset.y
        observations = [
            scrollView.observe(\.contentSize, options: [.old, .new]) { [weak self] _, change in
                guard change.oldValue != change.newValue else { return }
                MainActor.assumeIsolated { self?.pin() }
            },
            scrollView.observe(\.contentOffset) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.offsetChanged() }
            },
        ]
        pin()
    }

    /// The keyboard or the composer changed the room the transcript has.
    func viewportChanged() {
        DispatchQueue.main.async { [weak self] in self?.pin() }
    }

    /// A different conversation is on screen: start at its end, without a
    /// visible scroll, and keep landing there while its rows are measured.
    func land() {
        follow.resume()
        publish()
        pin()
        DispatchQueue.main.async { [weak self] in self?.pin() }
    }

    /// The jump button, and sending a message.
    func jumpToLatest(animated: Bool = true) {
        follow.resume()
        publish()
        guard let scrollView, let geometry else { return }
        let target = geometry.bottomOffsetY
        guard abs(target - geometry.offsetY) > 0.5 else { return }
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: target), animated: animated)
    }

    private var geometry: RelayScrollFollow.Geometry? {
        guard let scrollView else { return nil }
        return RelayScrollFollow.Geometry(
            contentHeight: scrollView.contentSize.height,
            viewportHeight: scrollView.bounds.height,
            offsetY: scrollView.contentOffset.y,
            insetTop: scrollView.adjustedContentInset.top,
            insetBottom: scrollView.adjustedContentInset.bottom
        )
    }

    private func pin() {
        guard let scrollView, let geometry, !isAdjusting,
              let target = follow.correction(for: geometry, readerIsTouching: scrollView.isTracking) else { return }
        isAdjusting = true
        scrollView.setContentOffset(CGPoint(x: scrollView.contentOffset.x, y: target), animated: false)
        isAdjusting = false
        lastOffsetY = scrollView.contentOffset.y
    }

    private func offsetChanged() {
        guard let scrollView, let geometry else { return }
        let previous = lastOffsetY
        lastOffsetY = geometry.offsetY
        guard !isAdjusting else { return }
        let readerDriven = scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating
        // The status-bar tap scrolls up without a touch on the list; it is still
        // the reader leaving the bottom.
        let movedUpUntouched = geometry.offsetY < previous - 0.5
            && geometry.distanceFromBottom > RelayScrollFollow.threshold
        guard readerDriven || movedUpUntouched else { return }
        follow.readerScrolled(to: geometry)
        publish()
    }

    private func publish() {
        let value = follow.isFollowing
        guard value != isAtBottom else { return }
        // Scroll callbacks can arrive inside a SwiftUI layout pass.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.follow.isFollowing == value, self.isAtBottom != value else { return }
            self.isAtBottom = value
        }
    }
}

/// Sits behind the transcript's content and hands the enclosing scroll view to
/// the scroller. iOS 17 has no SwiftUI API for scroll position and phase.
struct RelayScrollViewFinder: UIViewRepresentable {
    let scroller: RelayTranscriptScroller

    func makeUIView(context: Context) -> FinderView {
        let view = FinderView()
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear
        view.onFind = { [weak scroller] scrollView in scroller?.attach(scrollView) }
        return view
    }

    func updateUIView(_ view: FinderView, context: Context) {
        view.onFind = { [weak scroller] scrollView in scroller?.attach(scrollView) }
        view.find()
    }

    final class FinderView: UIView {
        var onFind: ((UIScrollView) -> Void)?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil else { return }
            DispatchQueue.main.async { [weak self] in self?.find() }
        }

        func find() {
            var candidate = superview
            while let view = candidate {
                if let scrollView = view as? UIScrollView {
                    onFind?(scrollView)
                    return
                }
                candidate = view.superview
            }
        }
    }
}

/// Centred above the composer, shown exactly while the reader is away from the
/// end of the transcript.
struct RelayJumpToLatestButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .frame(width: 36, height: 36)
                .background(AppTheme.canvasTop, in: Circle())
                .overlay { Circle().stroke(AppTheme.hairlineStrong, lineWidth: 0.75) }
                .shadow(color: AppTheme.shadowColor, radius: 8, y: 3)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.bottom, 4)
        .accessibilityLabel("Jump to latest")
        .accessibilityIdentifier("relay-jump-to-latest")
    }
}

// MARK: - Turn rows

/// Who is speaking. Drawn once, on a turn's first block.
struct RelayTurnByline: View {
    let provider: CodexProvider?

    var body: some View {
        HStack(spacing: 7) {
            if let provider {
                RelayProviderMark(provider: provider, size: 14)
                Text(provider.relayPresentation.title)
                    .font(RelayChatStyle.labelFont.weight(.medium))
                    .foregroundStyle(RelayChatStyle.secondary)
            } else {
                Text("Relay")
                    .font(RelayChatStyle.labelFont)
                    .foregroundStyle(RelayChatStyle.secondary)
            }
        }
    }
}

/// One prose block of a turn. Equatable so a finished block is skipped while
/// later blocks stream: its text is the only thing that can change it.
struct RelayTurnProse: View, Equatable {
    let text: String
    var onOpenLoopbackURL: ((URL) -> Void)? = nil

    static func == (lhs: RelayTurnProse, rhs: RelayTurnProse) -> Bool {
        lhs.text == rhs.text
    }

    var body: some View {
        RelayMarkdownText(
            text: relaySharedContract.displayTextHidingLocalPreviewURLs(value: text),
            userAligned: false,
            onOpenLoopbackURL: onOpenLoopbackURL,
            bodyFont: RelayChatStyle.bodyFont
        )
    }
}

/// "Ran 5 commands, read 2 files ›": one line for a run of finished steps.
struct RelayActivityRow: View {
    let summary: String
    var failedCount = 0
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 7) {
                Text(summary)
                    .foregroundStyle(RelayChatStyle.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if failedCount > 0 {
                    Text("· \(failedCount) failed")
                        .foregroundStyle(AppTheme.statusError)
                        .lineLimit(1)
                        .layoutPriority(1)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
                Spacer(minLength: 0)
            }
            .font(RelayChatStyle.labelFont)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(failedCount > 0 ? "\(summary), \(failedCount) failed" : summary)
        .accessibilityHint("Shows each step")
        .accessibilityIdentifier("relay-activity-row")
    }
}

/// A step in flight: caps word in ember, a ticking clock, what it is doing.
struct RelayLiveStepRow: View {
    let step: RelayStep
    /// Set while the step is parked on an approval: "Waiting", in the warn tone.
    var word: String? = nil
    var color: Color = AppTheme.accentBright
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            RelayLiveRowLabel(
                word: word ?? step.statusWord,
                since: step.startedAt,
                detail: step.liveDetail,
                color: color
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("relay-live-step")
    }
}

/// The shared shape of a live row. Status is the word and the clock, never a
/// dot or a spinner.
struct RelayLiveRowLabel: View {
    let word: String
    let since: Date?
    var detail: String? = nil
    var color: Color = AppTheme.accentBright

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            RelayCapsLabel(text: word, color: color, size: 10)
                .fixedSize()
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(RelayStepClock.clock(context.date.timeIntervalSince(since)))
                        .font(AppTheme.monoFont(size: 11))
                        .foregroundStyle(RelayChatStyle.secondary)
                        .monospacedDigit()
                }
                .fixedSize()
            }
            if let detail, !detail.isEmpty {
                Text(detail)
                    .font(RelayChatStyle.labelFont)
                    .foregroundStyle(RelayChatStyle.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The blocks of one job's turn, in order, then whatever is still in flight.
struct RelayTimelineBlocks: View {
    let timeline: RelayTimeline
    /// The job is still going: running steps are drawn live and left out of
    /// their activity row's sentence until they finish.
    let isActive: Bool
    /// What the idle live row says when nothing is running ("Working",
    /// "Waiting" while an approval is parked).
    var idleWord = "Working"
    var idleSince: Date? = nil
    var idleColor: Color = AppTheme.accentBright
    /// An approval is parked: every live row says the idle word instead of its own.
    var isWaiting = false
    var onOpenLoopbackURL: ((URL) -> Void)? = nil
    let onOpenBlock: (String) -> Void
    let onOpenStep: (String) -> Void

    static let maxLiveRows = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(timeline.blocks) { block in
                switch block.content {
                case .prose(let text):
                    RelayTurnProse(text: text, onOpenLoopbackURL: onOpenLoopbackURL)
                        .equatable()
                        .padding(.vertical, 5)
                case .activity:
                    let steps = timeline.countedSteps(in: block, isActive: isActive)
                    if !steps.isEmpty {
                        RelayActivityRow(
                            summary: RelayTimeline.summary(of: steps),
                            failedCount: steps.filter { $0.status == .failed }.count,
                            action: { onOpenBlock(block.id) }
                        )
                    }
                }
            }
            if isActive {
                liveRows
            }
        }
    }

    @ViewBuilder
    private var liveRows: some View {
        let running = timeline.runningSteps
        if running.isEmpty {
            RelayIdleLiveRow(
                word: idleWord,
                since: idleSince,
                color: idleColor,
                // A parked approval is always worth saying; otherwise prose
                // that is still arriving is its own sign of life.
                proseLength: isWaiting ? nil : timeline.trailingProseLength
            )
        } else {
            ForEach(running.prefix(Self.maxLiveRows)) { step in
                RelayLiveStepRow(
                    step: step,
                    word: isWaiting ? idleWord : nil,
                    color: isWaiting ? idleColor : AppTheme.accentBright
                ) { onOpenStep(step.id) }
            }
            if running.count > Self.maxLiveRows {
                Text("+\(running.count - Self.maxLiveRows) more")
                    .font(RelayChatStyle.labelFont)
                    .foregroundStyle(AppTheme.textTertiary)
                    .padding(.bottom, 8)
            }
        }
    }
}

/// Nothing is running and no prose is arriving, but the job is: say so, with
/// the time since it started, so the screen is never silent.
private struct RelayIdleLiveRow: View {
    let word: String
    let since: Date?
    let color: Color
    /// Length of the prose block the turn currently ends with, or nil when it
    /// ends with something else. While this keeps growing the row stays away.
    let proseLength: Int?
    @State private var lastProseChange = Date.distantPast

    private static let quietAfter: TimeInterval = 2

    var body: some View {
        Group {
            if proseLength == nil {
                RelayLiveRowLabel(word: word, since: since, color: color)
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if context.date.timeIntervalSince(lastProseChange) >= Self.quietAfter {
                        RelayLiveRowLabel(word: word, since: since, color: color)
                    }
                }
            }
        }
        .onChange(of: proseLength) { _, length in
            if length != nil { lastProseChange = Date() }
        }
        .accessibilityIdentifier("relay-live-idle")
    }
}

/// What the job card's footer carried: how the run ended, the full log, and
/// Stop while it is going.
struct RelayTurnFooter: View {
    let job: CodexJob
    let isCancelling: Bool
    let onFullLog: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(spacing: 16) {
            status
            Spacer(minLength: 8)
            Button("View full log", action: onFullLog)
                .frame(minHeight: 44)
                .accessibilityIdentifier("relay-job-full-log")
            if job.status.isActive {
                Button(isCancelling ? "Stopping…" : "Stop", action: onCancel)
                    .frame(minWidth: 44, minHeight: 44)
                    .disabled(isCancelling || job.status == .canceling)
                    .accessibilityLabel("Stop run")
            }
        }
        .font(.custom("DMSans-9ptRegular", size: 12, relativeTo: .caption))
        .foregroundStyle(RelayChatStyle.secondary)
        .buttonStyle(.plain)
    }

    /// While the job runs the live rows carry the clock, so the footer does
    /// not tick a second one beside them.
    @ViewBuilder
    private var status: some View {
        HStack(spacing: 6) {
            Text(job.status.label)
                .foregroundStyle(statusColor)
            if !job.status.isActive, let seconds = job.finishedSeconds {
                Text("· \(RelayStepClock.short(seconds))")
                    .monospacedDigit()
            }
        }
        .lineLimit(1)
    }

    private var statusColor: Color {
        switch job.status {
        case .waitingForApproval: AppTheme.statusWarn
        case .failed, .timeout: AppTheme.statusError
        case .running, .queued, .canceling: AppTheme.accentBright
        default: RelayChatStyle.secondary
        }
    }
}

// MARK: - Presentation helpers

extension RelayTimeline {
    /// The steps an activity row's sentence counts. While the job runs, a step
    /// still in flight is a live row instead.
    func countedSteps(in block: RelayTimelineBlock, isActive: Bool) -> [RelayStep] {
        let all = steps(in: block)
        return isActive ? all.filter { !$0.status.isRunning } : all
    }

    /// Length of the prose block the turn ends with, or nil when it ends with
    /// steps (or nothing).
    var trailingProseLength: Int? {
        guard case .prose(let text)? = blocks.last?.content else { return nil }
        return text.utf8.count
    }
}

extension RelayStep {
    /// What a row says about a step. Thinking has no summary of its own, so it
    /// shows the thought instead of repeating its title.
    var rowSummary: String {
        guard kind == .reasoning, (summary ?? "").isEmpty else { return displaySummary }
        return output.split(whereSeparator: \.isNewline).first.map(String.init) ?? displaySummary
    }

    /// The trailing text of a live row: the latest line of a thought, else the
    /// one-line summary. Nil when it would only repeat the status word.
    var liveDetail: String? {
        if kind == .reasoning, (summary ?? "").isEmpty {
            return output.split(whereSeparator: \.isNewline).last.map(String.init)
        }
        let text = displaySummary
        return text.caseInsensitiveCompare(statusWord) == .orderedSame ? nil : text
    }

    /// Ember while running, the error tone when it failed, quiet otherwise.
    var statusColor: Color {
        switch status {
        case .running: return AppTheme.accentBright
        case .failed: return AppTheme.statusError
        case .done, .cancelled: return AppTheme.textTertiary
        }
    }
}

extension CodexJob {
    /// How long a finished run took.
    var finishedSeconds: TimeInterval? {
        if let durationMs { return TimeInterval(max(0, durationMs)) / 1000 }
        guard let start = startedAt ?? createdAt, let end = completedAt else { return nil }
        return max(0, end.timeIntervalSince(start))
    }
}

enum RelayTranscriptLayout {
    /// Ids of the items that continue the turn above them: an agent's message
    /// or job directly after another from the same agent. They sit closer and
    /// do not repeat the byline.
    static func continuationIDs(in items: [RelayConversationItem]) -> Set<String> {
        var ids: Set<String> = []
        var previous: RelayConversationItem?
        for item in items {
            if let previous, previous.isAgentTurnPart, item.isAgentTurnPart,
               previous.turnProvider == item.turnProvider {
                ids.insert(item.id)
            }
            previous = item
        }
        return ids
    }
}

private extension RelayConversationItem {
    var isAgentTurnPart: Bool { role == .assistant || role == .job }
    var turnProvider: CodexProvider? { job?.provider ?? provider }
}
