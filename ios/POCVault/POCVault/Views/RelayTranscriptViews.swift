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

        /// Content that fits has no "away from the end": pulling it down to
        /// refresh is not scrolling up.
        var fitsViewport: Bool { contentHeight + insetBottom <= viewportHeight - insetTop + 0.5 }

        var distanceFromBottom: CGFloat { fitsViewport ? 0 : max(0, bottomOffsetY - offsetY) }
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

    /// The fallback, for when only SwiftUI's own measurements are available and
    /// nothing says who moved the list. Content or the viewport changing size
    /// while the offset stays put is new content: returns true when the list
    /// should be pinned to the end. The offset moving is the reader (or the pin
    /// itself, which lands at the end and so keeps following).
    mutating func observe(_ geometry: Geometry, after previous: Geometry?) -> Bool {
        guard let previous else { return isFollowing }
        if abs(geometry.offsetY - previous.offsetY) > 0.5 {
            readerScrolled(to: geometry)
            return false
        }
        let resized = abs(geometry.contentHeight - previous.contentHeight) > 0.5
            || abs(geometry.viewportHeight - previous.viewportHeight) > 0.5
        return resized && isFollowing && geometry.distanceFromBottom > 0.5
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
    /// Scrolls to the transcript's bottom anchor through SwiftUI. Used only
    /// while no scroll view is attached.
    var fallbackScroll: ((_ animated: Bool) -> Void)?
    private var fallbackGeometry: RelayScrollFollow.Geometry?

    /// True once the backing scroll view was found; until then, and on a system
    /// where it never is, the SwiftUI fallback drives the same follow rule.
    var isAttached: Bool { scrollView != nil }

    #if DEBUG
    /// `RELAY_UITEST_SCROLL_FALLBACK=1` keeps the scroll view unattached so the
    /// fallback can be exercised in the simulator.
    static let forcesFallback = ProcessInfo.processInfo.environment["RELAY_UITEST_SCROLL_FALLBACK"] == "1"
    #else
    static let forcesFallback = false
    #endif

    /// The scroll view's visible height, as SwiftUI lays it out.
    var viewportHeight: CGFloat = 0

    /// The content's frame in the scroll view's space, on every layout and
    /// scroll: all the fallback has to go on.
    func measured(content: CGRect) {
        guard !isAttached, viewportHeight > 0 else { return }
        measured(RelayScrollFollow.Geometry(
            contentHeight: content.height,
            viewportHeight: viewportHeight,
            offsetY: -content.minY
        ))
    }

    func measured(_ geometry: RelayScrollFollow.Geometry) {
        guard !isAttached else { return }
        let previous = fallbackGeometry
        fallbackGeometry = geometry
        let wasFollowing = follow.isFollowing
        let shouldPin = follow.observe(geometry, after: previous)
        if follow.isFollowing != wasFollowing { publish() }
        if shouldPin {
            DispatchQueue.main.async { [weak self] in
                guard let self, !self.isAttached, self.follow.isFollowing else { return }
                self.fallbackScroll?(false)
            }
        }
    }

    func attach(_ scrollView: UIScrollView) {
        guard !Self.forcesFallback, self.scrollView !== scrollView else { return }
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
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if self.isAttached {
                self.pin()
            } else if self.follow.isFollowing {
                self.fallbackScroll?(false)
            }
        }
    }

    /// A different conversation is on screen: start at its end, without a
    /// visible scroll, and keep landing there while its rows are measured.
    func land() {
        follow.resume()
        publish()
        guard isAttached else {
            fallbackScroll?(false)
            DispatchQueue.main.async { [weak self] in self?.fallbackScroll?(false) }
            return
        }
        pin()
        DispatchQueue.main.async { [weak self] in self?.pin() }
    }

    /// The jump button, and sending a message.
    func jumpToLatest(animated: Bool = true) {
        follow.resume()
        publish()
        guard let scrollView, let geometry else {
            fallbackScroll?(animated)
            return
        }
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
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
                .frame(width: 36, height: 36)
                .background(RelayTranscriptStyle.raised, in: Circle())
                .overlay { Circle().stroke(AppTheme.hairlineStrong, lineWidth: 1) }
                .shadow(color: .black.opacity(0.35), radius: 9, y: 6)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Jump to latest")
        .accessibilityIdentifier("relay-jump-to-latest")
    }
}

/// The transcript's type and measures, from the design canvas. Rows read these
/// so a restyle is one place.
enum RelayTranscriptStyle {
    static let gutter: CGFloat = 16
    static let raised = Color(hex: 0x272421)
    static let chevron = AppTheme.textTertiary
    /// DM Sans 13/20: activity rows, the footer's buttons.
    static let small = Font.custom("DMSans-9ptRegular", size: 13, relativeTo: .subheadline)
    /// DM Sans 15/20: a live row's summary, a step row's description.
    static let rowTitle = Font.custom("DMSans-9ptRegular", size: 15, relativeTo: .subheadline)
    /// DM Mono 12: durations.
    static let clock = Font.custom("DMMono-Regular", size: 12, relativeTo: .caption)
    /// DM Mono 13/20: commands, paths, file names.
    static let mono = Font.custom("DMMono-Regular", size: 13, relativeTo: .footnote)
    static let activityRowHeight: CGFloat = 44
    static let liveRowHeight: CGFloat = 60
    /// Two activity rows back to back close up by this much to read as a pair.
    static let activityPairOverlap: CGFloat = 8
}

struct RelayRowChevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(RelayTranscriptStyle.chevron)
            .frame(width: 12, height: 12)
            .accessibilityHidden(true)
    }
}

struct RelayHairline: View {
    var body: some View {
        Rectangle().fill(AppTheme.hairline).frame(height: 1)
    }
}

// MARK: - Turn rows

/// Who is speaking. Drawn once, on a turn's first block.
struct RelayTurnByline: View {
    let provider: CodexProvider?

    var body: some View {
        HStack(spacing: 6) {
            if let provider {
                RelayProviderMark(provider: provider, size: 14)
                Text(provider.relayPresentation.title)
            } else {
                Text("Relay")
            }
        }
        .font(RelayTranscriptStyle.small.weight(.medium))
        .foregroundStyle(RelayChatStyle.secondary)
        .frame(height: 20)
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
/// With no action it is a plain line: nothing behind it to open.
struct RelayActivityRow: View {
    let summary: String
    var failedCount = 0
    var action: (() -> Void)? = nil

    var body: some View {
        if let action {
            Button(action: action) { label(showsChevron: true) }
                .buttonStyle(.plain)
                .accessibilityHint("Shows each step")
                .accessibilityIdentifier("relay-activity-row")
        } else {
            label(showsChevron: false)
        }
    }

    private func label(showsChevron: Bool) -> some View {
        HStack(spacing: 6) {
            Text(summary)
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(1)
                .truncationMode(.tail)
            if failedCount > 0 {
                // The failure never truncates; the sentence gives way to it.
                Text("\(failedCount) failed")
                    .foregroundStyle(AppTheme.statusError)
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(1)
            }
            if showsChevron {
                RelayRowChevron().layoutPriority(1)
            }
            Spacer(minLength: 0)
        }
        .font(RelayTranscriptStyle.small)
        .frame(maxWidth: .infinity, minHeight: RelayTranscriptStyle.activityRowHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(failedCount > 0 ? "\(summary), \(failedCount) failed" : summary)
    }
}

/// A step in flight. Opens the step's detail once there is something in it.
struct RelayLiveStepRow: View {
    let step: RelayStep
    /// Set while the step is parked on an approval: "Waiting".
    var word: String? = nil
    let action: () -> Void

    var body: some View {
        if step.hasDetail {
            Button(action: action) { label(showsChevron: true) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-live-step")
        } else {
            label(showsChevron: false)
        }
    }

    private func label(showsChevron: Bool) -> some View {
        RelayLiveRowLabel(
            word: word ?? step.statusWord,
            since: step.startedAt,
            detail: step.liveDetail,
            showsChevron: showsChevron
        )
    }
}

/// The shape of a live row: a hairline, the status word in ember with a ticking
/// clock, and under it what is happening. Status is the word and the clock,
/// never a dot or a spinner.
struct RelayLiveRowLabel: View {
    let word: String
    let since: Date?
    var detail: String? = nil
    var showsChevron = false

    var body: some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    RelayCapsLabel(text: word, color: AppTheme.accentBright, size: 10)
                        .fixedSize()
                    if let since {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(RelayStepClock.clock(context.date.timeIntervalSince(since)))
                                .font(RelayTranscriptStyle.clock)
                                .foregroundStyle(RelayChatStyle.secondary)
                                .monospacedDigit()
                        }
                        .fixedSize()
                    }
                }
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(RelayTranscriptStyle.rowTitle)
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if showsChevron {
                RelayRowChevron()
            }
        }
        .frame(maxWidth: .infinity, minHeight: RelayTranscriptStyle.liveRowHeight, alignment: .leading)
        .overlay(alignment: .top) { RelayHairline() }
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
    /// An approval is parked: every live row says the idle word instead of its own.
    var isWaiting = false
    var onOpenLoopbackURL: ((URL) -> Void)? = nil
    let onOpenBlock: (String) -> Void
    let onOpenStep: (String) -> Void

    static let maxLiveRows = 3

    var body: some View {
        // Blocks stack with no gap: the 44pt rows give the rhythm.
        VStack(alignment: .leading, spacing: 0) {
            let rows = timeline.transcriptRows(isActive: isActive)
            ForEach(rows) { row in
                switch row.content {
                case .prose(let text):
                    RelayTurnProse(text: text, onOpenLoopbackURL: onOpenLoopbackURL)
                        .equatable()
                        // Prose straight under the byline needs air the rows bring themselves.
                        .padding(.top, row.id == rows.first?.id ? 8 : 0)
                case .activity(let summary, let failedCount, let opens):
                    RelayActivityRow(
                        summary: summary,
                        failedCount: failedCount,
                        action: opens ? { onOpenBlock(row.id) } : nil
                    )
                    .padding(.top, row.followsActivity ? -RelayTranscriptStyle.activityPairOverlap : 0)
                }
            }
            if isActive {
                liveRows
                    .padding(.top, rows.last?.isProse == true ? 12 : 0)
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
                // A parked approval is always worth saying; otherwise prose
                // that is still arriving is its own sign of life.
                proseLength: isWaiting ? nil : timeline.trailingProseLength
            )
        } else {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(running.prefix(Self.maxLiveRows)) { step in
                    RelayLiveStepRow(step: step, word: isWaiting ? idleWord : nil) { onOpenStep(step.id) }
                }
                if running.count > Self.maxLiveRows {
                    Text("+\(running.count - Self.maxLiveRows) more")
                        .font(RelayTranscriptStyle.small)
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: RelayTranscriptStyle.activityRowHeight, alignment: .leading)
                        .overlay(alignment: .top) { RelayHairline() }
                }
            }
        }
    }
}

/// Nothing is running and no prose is arriving, but the job is: say so, with
/// the time since it started, so the screen is never silent.
private struct RelayIdleLiveRow: View {
    let word: String
    let since: Date?
    /// Length of the prose block the turn currently ends with, or nil when it
    /// ends with something else. While this keeps growing the row stays away.
    let proseLength: Int?
    @State private var lastProseChange = Date.distantPast

    private static let quietAfter: TimeInterval = 2

    var body: some View {
        Group {
            if proseLength == nil {
                RelayLiveRowLabel(word: word, since: since)
            } else {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    if context.date.timeIntervalSince(lastProseChange) >= Self.quietAfter {
                        RelayLiveRowLabel(word: word, since: since)
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

/// How the run ended, the full log, and Stop while it is going. While the job
/// runs the live rows carry the status, so the footer adds no second clock.
struct RelayTurnFooter: View {
    let job: CodexJob
    let isCancelling: Bool
    let onFullLog: () -> Void
    let onCancel: () -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            if let outcome = job.status.outcomeWord {
                RelayCapsLabel(
                    text: outcome,
                    color: job.status.didFail ? AppTheme.statusError : AppTheme.textPrimary,
                    size: 10
                )
                if let seconds = job.finishedSeconds {
                    Text(RelayStepClock.clock(seconds))
                        .font(RelayTranscriptStyle.clock)
                        .foregroundStyle(RelayChatStyle.secondary)
                        .monospacedDigit()
                }
            }
            Spacer(minLength: 8)
            Button("View full log", action: onFullLog)
                .frame(minHeight: 44)
                .contentShape(Rectangle())
                .accessibilityIdentifier("relay-job-full-log")
            if job.status.isActive {
                Button(isCancelling ? "Stopping…" : "Stop", action: onCancel)
                    .frame(minWidth: 44, minHeight: 44)
                    .contentShape(Rectangle())
                    .padding(.leading, 12)
                    .disabled(isCancelling || job.status == .canceling)
                    .accessibilityLabel("Stop run")
            }
        }
        .font(RelayTranscriptStyle.small.weight(.medium))
        .foregroundStyle(RelayChatStyle.secondary)
        .buttonStyle(.plain)
        .lineLimit(1)
        .frame(minHeight: 44)
        .overlay(alignment: .top) { RelayHairline() }
        .padding(.top, 16)
    }
}

// MARK: - Presentation helpers

/// One drawn row of a turn: a prose block, or the sentence for a run of steps.
struct RelayTranscriptRow: Identifiable, Equatable {
    enum Content: Equatable {
        case prose(String)
        /// `opens` is false when no step behind the sentence has anything to show.
        case activity(summary: String, failedCount: Int, opens: Bool)
    }

    /// The timeline block's id.
    let id: String
    let content: Content
    /// The row above is an activity row too.
    var followsActivity = false

    var isProse: Bool {
        if case .prose = content { return true }
        return false
    }
}

extension RelayTimeline {
    /// The steps an activity row's sentence counts. While the job runs, a step
    /// still in flight is a live row instead.
    func countedSteps(in block: RelayTimelineBlock, isActive: Bool) -> [RelayStep] {
        let all = steps(in: block)
        return isActive ? all.filter { !$0.status.isRunning } : all
    }

    /// The rows a turn draws, in order. A block whose steps are all still
    /// running draws nothing yet.
    func transcriptRows(isActive: Bool) -> [RelayTranscriptRow] {
        var rows: [RelayTranscriptRow] = []
        for block in blocks {
            switch block.content {
            case .prose(let text):
                rows.append(RelayTranscriptRow(id: block.id, content: .prose(text)))
            case .activity:
                let steps = countedSteps(in: block, isActive: isActive)
                guard !steps.isEmpty else { continue }
                rows.append(RelayTranscriptRow(
                    id: block.id,
                    content: .activity(
                        summary: RelayTimeline.summary(of: steps),
                        failedCount: steps.filter { $0.status == .failed }.count,
                        opens: steps.contains { $0.hasDetail || !children(of: $0.id).isEmpty }
                    ),
                    followsActivity: rows.last.map { !$0.isProse } ?? false
                ))
            }
        }
        return rows
    }

    /// Length of the prose block the turn ends with, or nil when it ends with
    /// steps (or nothing).
    var trailingProseLength: Int? {
        guard case .prose(let text)? = blocks.last?.content else { return nil }
        return text.utf8.count
    }
}

extension RelayStep {
    /// What a step row says, and whether it is code. File names, commands and
    /// search patterns are set in mono; descriptions and tool names are not.
    var rowSummary: (text: String, isCode: Bool) {
        switch kind {
        case .command:
            if let line = input.command?.split(whereSeparator: \.isNewline).first { return (String(line), true) }
        case .read, .edit, .write:
            if let path = input.path?.trimmedNonEmpty { return ((path as NSString).lastPathComponent, true) }
        case .search:
            if let pattern = input.pattern?.trimmedNonEmpty { return (pattern, true) }
        case .reasoning:
            // Thinking has no summary of its own: show the thought, not its title.
            if (summary ?? "").isEmpty,
               let line = output.split(whereSeparator: \.isNewline).first { return (String(line), false) }
        case .fetch, .tool, .agent, .todo:
            break
        }
        return (displaySummary, false)
    }

    /// Line two of a live row: the latest line of a thought, else the one-line
    /// summary. A step often starts with only its title, and that reads fine;
    /// nil only when it would repeat the status word.
    var liveDetail: String? {
        if kind == .reasoning, (summary ?? "").isEmpty {
            return output.split(whereSeparator: \.isNewline).last.map(String.init)
        }
        let text = displaySummary
        return text.caseInsensitiveCompare(statusWord) == .orderedSame ? nil : text
    }

    /// Whether opening the step would show anything. Thinking often arrives
    /// with no text at all, and a step's input can trail its first event.
    var hasDetail: Bool {
        switch kind {
        case .agent:
            return true
        case .reasoning:
            return output.trimmedNonEmpty != nil
        default:
            return !detailFields.isEmpty || output.trimmedNonEmpty != nil || error?.trimmedNonEmpty != nil
                || (input.items?.isEmpty == false)
        }
    }

    /// The labelled input fields a detail page shows, in order, whatever the
    /// kind: Codex runs reads and searches through a shell, so those carry a
    /// command too.
    var detailFields: [(title: String, text: String, isCode: Bool)] {
        var fields: [(String, String, Bool)] = []
        func add(_ title: String, _ value: String?, code: Bool) {
            if let value = value?.trimmedNonEmpty { fields.append((title, value, code)) }
        }
        if kind != .agent {
            add("Description", input.description ?? (kind == .command ? summary : nil), code: false)
        }
        add("Path", input.path, code: true)
        add("Lines", input.range, code: true)
        add("Pattern", input.pattern, code: true)
        add("URL", input.url, code: true)
        add("Query", input.query, code: false)
        if let name = input.name?.trimmedNonEmpty {
            add("Name", input.server?.trimmedNonEmpty.map { "\($0) · \(name)" } ?? name, code: true)
        }
        add("Input", input.json, code: true)
        add("Command", input.command, code: true)
        return fields.map { (title: $0.0, text: $0.1, isCode: $0.2) }
    }

    /// Ember while running, the error tone when it failed, quiet otherwise.
    var statusColor: Color {
        switch status {
        case .running: return AppTheme.accentBright
        case .failed: return AppTheme.statusError
        case .done, .cancelled: return RelayChatStyle.secondary
        }
    }
}

extension CodexJobStatus {
    /// The footer's word for a finished run. Nil while it is still going.
    var outcomeWord: String? {
        switch self {
        case .succeeded: return "Done"
        case .failed: return "Failed"
        case .timeout: return "Timed out"
        case .canceled: return "Stopped"
        case .unknown(let raw): return raw
        case .queued, .running, .waitingForApproval, .canceling: return nil
        }
    }

    var didFail: Bool { self == .failed || self == .timeout }
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
