import SwiftUI
import UIKit

// The transcript's own pieces: how the list follows new content, and the rows a
// turn is drawn from (byline, prose, Paseo single-line tool rows, collapsible
// reasoning, live steps, and minimal turn footer).

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
    }

    private func offsetChanged() {
        guard let scrollView, let geometry else { return }
        guard !isAdjusting else { return }
        let readerDriven = scrollView.isTracking || scrollView.isDragging || scrollView.isDecelerating
        // SwiftUI also moves this offset when resolving lazy row heights.
        // Treating that as a reader scroll can strand a reopened chat outside
        // its rendered rows and stop all subsequent corrections.
        guard readerDriven else { return }
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
    @Environment(\.relayTheme) private var theme

    var body: some View {
        Button(action: action) {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(theme.foreground)
                .frame(width: 36, height: 36)
                .background(theme.surface2, in: Circle())
                .overlay { Circle().strokeBorder(theme.borderAccent, lineWidth: 1) }
                .shadow(color: Color.black.opacity(theme.isDark ? 0.35 : 0.12), radius: 8, y: 4)
                .frame(width: 44, height: 44)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Jump to latest")
        .accessibilityIdentifier("relay-jump-to-latest")
    }
}

/// Shared transcript metrics and typography tokens preserved for compatibility
/// with sibling views (`RelayApprovalCard`, etc.).
enum RelayTranscriptStyle {
    static let gutter: CGFloat = 18
    static let raised = Color(hex: 0x272421)
    static let chevron = AppTheme.textTertiary
    static let small = Font.subheadline
    static let rowTitle = Font.subheadline
    /// Stable-width digits keep elapsed times from shifting the row.
    static let clock = Font.caption.monospacedDigit()
    /// Commands, paths, and file names.
    static let mono = Font.footnote.monospaced()
    static let activityRowHeight: CGFloat = 44
    static let liveRowHeight: CGFloat = 60
    /// Two activity rows back to back close up by this much to read as a pair.
    static let activityPairOverlap: CGFloat = 8
}

struct RelayRowChevron: View {
    @Environment(\.relayTheme) private var theme

    var body: some View {
        Image(systemName: "chevron.right")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(theme.foregroundExtraMuted)
            .frame(width: 12, height: 12)
            .accessibilityHidden(true)
    }
}

struct RelayHairline: View {
    @Environment(\.relayTheme) private var theme

    var body: some View {
        Rectangle().fill(theme.border).frame(height: 1)
    }
}

// MARK: - Turn rows

/// Who is speaking. Drawn once, on a turn's first block when enabled.
struct RelayTurnByline: View {
    let provider: CodexProvider?
    @Environment(\.relayTheme) private var theme

    var body: some View {
        HStack(spacing: 6) {
            if let provider {
                RelayProviderMark(provider: provider, size: 14)
                Text(provider.relayPresentation.title)
            } else {
                Text("Relay")
            }
        }
        .font(RelayTheme.uiFont(13, weight: .medium))
        .foregroundStyle(theme.foregroundMuted)
        .frame(minHeight: 20)
    }
}

/// One prose block of a turn. Borderless `RelayTheme.contentFont(16)` on `surface0`
/// with Paseo inline code chips and smooth 60Hz paced reveal while streaming.
struct RelayTurnProse: View, Equatable {
    let text: String
    var isStreaming: Bool = false
    var onOpenLoopbackURL: ((URL) -> Void)? = nil

    static func == (lhs: RelayTurnProse, rhs: RelayTurnProse) -> Bool {
        lhs.text == rhs.text && lhs.isStreaming == rhs.isStreaming
    }

    var body: some View {
        RelayPacedRevealText(
            text: text,
            isStreaming: isStreaming,
            onOpenLoopbackURL: onOpenLoopbackURL
        )
    }
}

/// Paseo's signature ultra-quiet single-line tool call row:
/// `[14pt muted icon or live ring] Verb  truncated command / path`
/// Tapping opens the upgraded Paseo Tool Inspection Sheet.
struct RelayToolStepRow: View {
    let step: RelayStep
    /// Set while the step is parked on an approval ("Waiting").
    var waitingWord: String? = nil
    let action: () -> Void

    @Environment(\.relayTheme) private var theme

    private var isFailed: Bool { step.status == .failed }
    private var isRunning: Bool { step.status.isRunning }

    private var verb: String {
        if let waitingWord { return waitingWord }
        return step.paseoVerb
    }

    private var target: String? {
        step.paseoTarget
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: 8) {
                leadingGlyph
                    .frame(width: 16, height: 16, alignment: .center)

                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(verb)
                        .font(RelayTheme.uiFont(14, weight: .regular))
                        .foregroundStyle(isFailed ? theme.statusDanger : theme.foregroundMuted)
                        .lineLimit(1)
                        .fixedSize()

                    if let target, !target.isEmpty {
                        Text(target)
                            .font(RelayTheme.uiFont(14, weight: .regular))
                            .foregroundStyle(isFailed ? theme.statusDanger.opacity(0.85) : theme.foregroundMuted.opacity(0.82))
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                if let diffStat = step.paseoDiffStats, !isRunning {
                    RelayDiffStatView(additions: diffStat.additions, deletions: diffStat.deletions)
                } else if isRunning, let since = step.startedAt {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(RelayStepClock.clock(context.date.timeIntervalSince(since)))
                            .font(RelayTheme.monoFont(11, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .monospacedDigit()
                    }
                    .fixedSize()
                } else if isFailed, let exitCode = step.exitCode, exitCode != 0 {
                    Text("exit \(exitCode)")
                        .font(RelayTheme.monoFont(11, weight: .regular))
                        .foregroundStyle(theme.statusDanger)
                        .fixedSize()
                }
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Inspect step details")
        .accessibilityIdentifier(isRunning ? "relay-live-step" : "relay-activity-row")
    }

    @ViewBuilder
    private var leadingGlyph: some View {
        if isRunning {
            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
        } else if isFailed {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundStyle(theme.statusDanger)
                .accessibilityHidden(true)
        } else {
            Image(systemName: step.kind.paseoSymbol)
                .font(.system(size: 12.5, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
                .accessibilityHidden(true)
        }
    }

    private var accessibilityText: String {
        var parts = [verb]
        if let target, !target.isEmpty { parts.append(target) }
        if isFailed { parts.append("failed") }
        return parts.joined(separator: " ")
    }
}

/// Quiet 1-line collapsible reasoning/thinking row: "Thinking" / "Thought for 4s".
/// Tapping toggles muted inline reasoning prose without pushing a modal sheet.
struct RelayReasoningStepRow: View {
    let steps: [RelayStep]
    @Environment(\.relayTheme) private var theme
    @State private var isExpanded = false

    private var isRunning: Bool {
        steps.contains { $0.status.isRunning }
    }

    private var combinedThought: String? {
        let joined = steps
            .compactMap { $0.output.trimmedNonEmpty }
            .joined(separator: "\n\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return joined.isEmpty ? nil : joined
    }

    private var earliestStart: Date? {
        steps.compactMap(\.startedAt).min()
    }

    private var headerTitle: String {
        if isRunning { return "Thinking" }
        let total = steps.compactMap { $0.duration(now: Date()) }.reduce(0, +)
        return total.rounded() >= 1 ? "Thought for \(RelayStepClock.short(total))" : "Thought"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if combinedThought != nil {
                Button {
                    withAnimation(.easeOut(duration: 0.16)) {
                        isExpanded.toggle()
                    }
                } label: {
                    headerLabel(expandable: true)
                }
                .buttonStyle(.plain)
                .accessibilityHint(isExpanded ? "Collapses thinking" : "Expands thinking")
            } else {
                headerLabel(expandable: false)
            }

            if isExpanded, let thought = combinedThought {
                HStack(alignment: .top, spacing: 10) {
                    Rectangle()
                        .fill(theme.borderAccent)
                        .frame(width: 2)
                        .clipShape(Capsule())

                    Text(thought)
                        .font(RelayTheme.uiFont(14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .lineSpacing(3)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, 6)
                .padding(.bottom, 6)
                .transition(.opacity)
            }
        }
        .accessibilityIdentifier("relay-reasoning-row")
    }

    private func headerLabel(expandable: Bool) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Group {
                if isRunning {
                    RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                } else {
                    Image(systemName: expandable ? (isExpanded ? "chevron.down" : "chevron.right") : "ellipsis")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(theme.foregroundExtraMuted)
                }
            }
            .frame(width: 16, height: 16, alignment: .center)

            Text(headerTitle)
                .font(RelayTheme.uiFont(14, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
                .lineLimit(1)

            if isRunning, let since = earliestStart {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(RelayStepClock.clock(context.date.timeIntervalSince(since)))
                        .font(RelayTheme.monoFont(11, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .monospacedDigit()
                }
                .fixedSize()
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Summary row for a run of finished steps (kept for overflow disclosure and
/// compatibility with callers/previews).
struct RelayActivityRow: View {
    let summary: String
    var failedCount = 0
    var symbol = "list.bullet"
    var action: (() -> Void)? = nil
    @Environment(\.relayTheme) private var theme

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
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 12.5, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
                .frame(width: 16, height: 16, alignment: .center)
                .accessibilityHidden(true)
            Text(summary)
                .foregroundStyle(theme.foregroundMuted)
                .lineLimit(1)
                .truncationMode(.tail)
            if failedCount > 0 {
                Text("\(failedCount) failed")
                    .foregroundStyle(theme.statusDanger)
                    .lineLimit(1)
                    .fixedSize()
                    .layoutPriority(1)
            }
            Spacer(minLength: 0)
            if showsChevron { RelayRowChevron().layoutPriority(1) }
        }
        .font(RelayTheme.uiFont(14, weight: .regular))
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(failedCount > 0 ? "\(summary), \(failedCount) failed" : summary)
    }
}

/// A step in flight. Renders as Paseo's quiet live tool row and opens detail on tap.
struct RelayLiveStepRow: View {
    let step: RelayStep
    /// Set while the step is parked on an approval: "Waiting".
    var word: String? = nil
    let action: () -> Void

    var body: some View {
        RelayToolStepRow(step: step, waitingWord: word, action: action)
    }
}

/// Quiet Paseo live indicator row for idle/waiting/thinking turns when no specific
/// tool call is running yet.
struct RelayLiveRowLabel: View {
    let word: String
    let since: Date?
    var detail: String? = nil
    var showsChevron = false
    @Environment(\.relayTheme) private var theme

    var body: some View {
        HStack(spacing: 8) {
            RelayStatusRing(isActive: true, size: 12, lineWidth: 1.5, showsCenterDot: true)
                .frame(width: 16, height: 16, alignment: .center)

            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(word)
                        .font(RelayTheme.uiFont(14, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                        .fixedSize()
                    if let since {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(RelayStepClock.clock(context.date.timeIntervalSince(since)))
                                .font(RelayTheme.monoFont(11, weight: .regular))
                                .foregroundStyle(theme.foregroundExtraMuted)
                                .monospacedDigit()
                        }
                        .fixedSize()
                    }
                }
                if let detail, !detail.isEmpty {
                    Text(detail)
                        .font(RelayTheme.uiFont(14, weight: .regular))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)

            if showsChevron {
                RelayRowChevron()
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, minHeight: 34, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// The blocks of one job's turn, in order, then whatever is still in flight.
struct RelayTimelineBlocks: View {
    let timeline: RelayTimeline
    /// The job is still going: running steps are drawn live and left out of
    /// their completed rows until they finish.
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
    /// Bursts longer than 6 completed tool steps fold the middle behind a quiet
    /// inline disclosure row ("4 more steps") that expands smoothly in place.
    private static let burstCollapseThreshold = 6
    private static let burstVisibleLeading = 3
    private static let burstVisibleTrailing = 3

    @Environment(\.relayTheme) private var theme
    @State private var expandedBurstBlockIDs: Set<String> = []

    private var lastProseBlockID: String? {
        timeline.blocks.last { block in
            if case .prose = block.content { return true }
            return false
        }?.id
    }

    var body: some View {
        let activeProseID = isActive ? lastProseBlockID : nil
        VStack(alignment: .leading, spacing: 0) {
            ForEach(timeline.blocks) { block in
                switch block.content {
                case .user(let text, let status):
                    VStack(alignment: .trailing, spacing: 4) {
                        Text(text)
                            .font(RelayTheme.contentFont(16))
                            .foregroundStyle(theme.foreground)
                            .textSelection(.enabled)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(theme.surface2, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                        if status != "sent" {
                            Text(status == "failed" ? "Delivery not confirmed" : "Sending…")
                                .font(RelayTheme.uiFont(12, weight: .regular))
                                .foregroundStyle(status == "failed" ? theme.statusDanger : theme.foregroundMuted)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .trailing)
                    .padding(.vertical, 8)

                case .prose(let text):
                    RelayTurnProse(
                        text: text,
                        isStreaming: block.id == activeProseID,
                        onOpenLoopbackURL: onOpenLoopbackURL
                    )
                    .equatable()
                    .padding(.vertical, 8)

                case .activity:
                    activityBlockView(block)
                        .padding(.vertical, 2)
                }
            }
            if isActive, timeline.runningSteps.isEmpty {
                RelayIdleLiveRow(
                    word: idleWord,
                    since: idleSince,
                    proseLength: isWaiting ? nil : timeline.trailingProseLength
                )
                .padding(.top, 4)
            }
        }
    }

    @ViewBuilder
    private func activityBlockView(_ block: RelayTimelineBlock) -> some View {
        let allSteps = timeline.steps(in: block)
        let reasoningSteps = allSteps.filter { $0.kind == .reasoning }
        let toolSteps = allSteps.filter { $0.kind != .reasoning }
        let finishedTools = isActive ? toolSteps.filter { !$0.status.isRunning } : toolSteps
        let runningTools = isActive ? toolSteps.filter { $0.status.isRunning } : []

        if !reasoningSteps.isEmpty {
            RelayReasoningStepRow(steps: reasoningSteps)
        }

        if finishedTools.count > Self.burstCollapseThreshold && !expandedBurstBlockIDs.contains(block.id) {
            let leading = Array(finishedTools.prefix(Self.burstVisibleLeading))
            let trailing = Array(finishedTools.suffix(Self.burstVisibleTrailing))
            let hiddenCount = finishedTools.count - leading.count - trailing.count

            ForEach(leading) { step in
                RelayToolStepRow(step: step) { onOpenStep(step.id) }
            }

            if hiddenCount > 0 {
                Button {
                    withAnimation(.easeOut(duration: 0.18)) {
                        _ = expandedBurstBlockIDs.insert(block.id)
                    }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .frame(width: 16, height: 16, alignment: .center)
                        Text(hiddenCount == 1 ? "1 more step" : "\(hiddenCount) more steps")
                            .font(RelayTheme.uiFont(13.5, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                        Spacer(minLength: 0)
                    }
                    .padding(.vertical, 5)
                    .frame(maxWidth: .infinity, minHeight: 30, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("relay-burst-expand")
            }

            ForEach(trailing) { step in
                RelayToolStepRow(step: step) { onOpenStep(step.id) }
            }
        } else {
            ForEach(finishedTools) { step in
                RelayToolStepRow(step: step) { onOpenStep(step.id) }
            }
        }

        if !runningTools.isEmpty {
            ForEach(runningTools.prefix(Self.maxLiveRows)) { step in
                RelayToolStepRow(step: step, waitingWord: isWaiting ? idleWord : nil) {
                    onOpenStep(step.id)
                }
            }
            if runningTools.count > Self.maxLiveRows {
                RelayActivityRow(summary: "\(runningTools.count - Self.maxLiveRows) more in progress") {
                    onOpenBlock(block.id)
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

// MARK: - Turn Actions & Footer

/// Minimal Paseo turn actions: quiet copy icon (with checkmark feedback),
/// optional Fork menu ("Fork in new chat"), and Select text sheet trigger.
struct RelayMessageActions: View {
    let text: String
    var onFork: (() -> Void)? = nil
    @State private var selectingText = false
    @Environment(\.relayTheme) private var theme

    var body: some View {
        HStack(spacing: 4) {
            RelayCopyButton(text: text, iconOnly: true)

            if let onFork {
                Menu {
                    Button {
                        onFork()
                    } label: {
                        Label("Fork in new chat", systemImage: "arrow.triangle.branch")
                    }
                } label: {
                    Image(systemName: "arrow.triangle.branch")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .accessibilityLabel("Fork conversation")
                .accessibilityIdentifier("relay-turn-fork")
            }

            Button {
                selectingText = true
            } label: {
                Image(systemName: "text.cursor")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(theme.foregroundExtraMuted)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Select text")
        }
        .padding(.top, 4)
        .sheet(isPresented: $selectingText) { RelayTextSelectionSheet(text: text) }
    }
}

struct RelayCopyButton: View {
    let text: String
    var label = "Copy"
    var iconOnly = false
    @State private var copied = false
    @Environment(\.relayTheme) private var theme

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            copied = true
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            if iconOnly {
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    .font(.system(size: 14, weight: .regular))
                    .foregroundStyle(copied ? theme.statusSuccess : theme.foregroundExtraMuted)
                    .frame(width: 34, height: 34)
                    .contentShape(Rectangle())
            } else {
                Label(copied ? "Copied" : label, systemImage: copied ? "checkmark" : "doc.on.doc")
                    .foregroundStyle(copied ? theme.statusSuccess : theme.foregroundMuted)
                    .frame(minWidth: 64, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : label)
        .task(id: copied) {
            guard copied else { return }
            do { try await Task.sleep(for: .seconds(1.8)) } catch { return }
            copied = false
        }
    }
}

struct RelayTextSelectionSheet: View {
    let text: String
    var monospaced = false
    @Environment(\.dismiss) private var dismiss
    @Environment(\.relayTheme) private var theme

    var body: some View {
        NavigationStack {
            RelaySelectableMessageText(text: text, monospaced: monospaced)
                .background(theme.surface0)
                .navigationTitle("Select text")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { RelayCopyButton(text: text, label: "Copy all") }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button("Done") { dismiss() }
                            .foregroundStyle(theme.foreground)
                    }
                }
        }
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationBackground(theme.surface0)
        .preferredColorScheme(theme.colorScheme)
    }
}

struct RelaySelectableMessageText: UIViewRepresentable {
    let text: String
    var monospaced = false
    @Environment(\.relayTheme) private var theme

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.backgroundColor = .clear
        view.textColor = UIColor(theme.foreground)
        view.tintColor = UIColor(theme.accent)
        view.font = monospaced
            ? UIFontMetrics(forTextStyle: .body).scaledFont(for: .monospacedSystemFont(ofSize: 13, weight: .regular))
            : .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textContainerInset = UIEdgeInsets(top: 20, left: 20, bottom: 28, right: 20)
        view.accessibilityLabel = "Message text"
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if view.text != text { view.text = text }
        view.textColor = UIColor(theme.foreground)
        view.tintColor = UIColor(theme.accent)
    }
}

/// Minimal Paseo turn footer: copy + fork icons when finished, live elapsed
/// timer while streaming, and quiet Activity / Stop controls.
struct RelayTurnFooter: View {
    let job: CodexJob
    let isCancelling: Bool
    let onFullLog: () -> Void
    let onCancel: () -> Void
    var copyText: String? = nil
    var onFork: (() -> Void)? = nil

    @Environment(\.relayTheme) private var theme
    @State private var selectingText = false

    var body: some View {
        HStack(alignment: .center, spacing: 6) {
            if !job.status.isActive, let text = copyText?.trimmedNonEmpty {
                RelayCopyButton(text: text, iconOnly: true)

                if let onFork {
                    Menu {
                        Button {
                            onFork()
                        } label: {
                            Label("Fork in new chat", systemImage: "arrow.triangle.branch")
                        }
                    } label: {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 14, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .frame(width: 34, height: 34)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Fork conversation")
                    .accessibilityIdentifier("relay-turn-fork")
                }

                Button {
                    selectingText = true
                } label: {
                    Image(systemName: "text.cursor")
                        .font(.system(size: 14, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .frame(width: 34, height: 34)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Select text")
            }

            if job.status.isActive, let start = job.startedAt ?? job.createdAt {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(RelayStepClock.clock(context.date.timeIntervalSince(start)))
                        .font(RelayTheme.monoFont(11, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .monospacedDigit()
                }
                .fixedSize()
            } else if let outcome = job.status.outcomeWord {
                if job.status.didFail {
                    Text(outcome)
                        .font(RelayTheme.uiFont(12.5, weight: .medium))
                        .foregroundStyle(theme.statusDanger)
                }
                if let seconds = job.finishedSeconds, seconds >= 0.5 {
                    Text(RelayStepClock.short(seconds))
                        .font(RelayTheme.monoFont(11, weight: .regular))
                        .foregroundStyle(theme.foregroundExtraMuted)
                        .monospacedDigit()
                }
            }

            Spacer(minLength: 8)

            Button("Activity", action: onFullLog)
                .font(RelayTheme.uiFont(13, weight: .regular))
                .foregroundStyle(theme.foregroundExtraMuted)
                .frame(minHeight: 36)
                .contentShape(Rectangle())
                .accessibilityIdentifier("relay-job-full-log")
                .accessibilityLabel("View full activity log")

            if job.status.isActive {
                Button(isCancelling ? "Stopping…" : "Stop", action: onCancel)
                    .font(RelayTheme.uiFont(13, weight: .medium))
                    .foregroundStyle(theme.statusDanger)
                    .frame(minWidth: 44, minHeight: 36)
                    .contentShape(Rectangle())
                    .padding(.leading, 8)
                    .disabled(isCancelling || job.status == .canceling)
                    .accessibilityLabel("Stop run")
            }
        }
        .buttonStyle(.plain)
        .lineLimit(1)
        .padding(.top, 4)
        .sheet(isPresented: $selectingText) {
            if let text = copyText?.trimmedNonEmpty {
                RelayTextSelectionSheet(text: text)
            }
        }
    }
}

// MARK: - Presentation helpers

/// One drawn row of a turn: a prose block, or the sentence for a run of steps.
struct RelayTranscriptRow: Identifiable, Equatable {
    enum Content: Equatable {
        case user(text: String, status: String)
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
            case .user(let text, let status):
                rows.append(RelayTranscriptRow(id: block.id, content: .user(text: text, status: status)))
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

    /// Latest todo/plan step items in this timeline, if any.
    var latestTodoItems: [RelayTodoItem] {
        for block in blocks.reversed() {
            guard case .activity = block.content else { continue }
            for step in steps(in: block).reversed() {
                if let items = step.input.items, !items.isEmpty {
                    return items
                }
            }
        }
        return []
    }
}

extension RelayStep {
    /// Paseo single-line tool verb: Shell, Terminal, Read, Edit, Write, Search, Fetch, Task, etc.
    var paseoVerb: String {
        switch kind {
        case .command:
            let loweredTitle = title.lowercased()
            if loweredTitle.contains("terminal") { return "Terminal" }
            return "Shell"
        case .read: return "Read"
        case .edit: return "Edit"
        case .write: return "Write"
        case .search: return "Search"
        case .fetch: return "Fetch"
        case .agent:
            return agent?.name?.trimmedNonEmpty ?? "Task"
        case .todo: return "Tasks"
        case .reasoning: return status.isRunning ? "Thinking" : "Thought"
        case .tool:
            if let name = input.name?.trimmedNonEmpty { return name }
            return title.trimmedNonEmpty ?? "Tool"
        }
    }

    /// Paseo single-line argument/target beside the verb (e.g., command string or file path).
    var paseoTarget: String? {
        switch kind {
        case .command:
            if let command = input.command?.split(whereSeparator: \.isNewline).first {
                let text = String(command).trimmingCharacters(in: .whitespaces)
                if !text.isEmpty { return text }
            }
            if let description = input.description?.trimmedNonEmpty { return description }
            if let summary = summary?.trimmedNonEmpty,
               summary.caseInsensitiveCompare(paseoVerb) != .orderedSame {
                return summary
            }
            return nil
        case .read, .edit, .write:
            if let path = input.path?.trimmedNonEmpty {
                return Self.compactDisplayPath(path)
            }
            return summary?.trimmedNonEmpty
        case .search:
            if let pattern = input.pattern?.trimmedNonEmpty { return pattern }
            if let query = input.query?.trimmedNonEmpty { return query }
            return summary?.trimmedNonEmpty
        case .fetch:
            if let url = input.url?.trimmedNonEmpty {
                return URL(string: url)?.host ?? url
            }
            return summary?.trimmedNonEmpty
        case .agent:
            let detail = displaySummary
            return detail.caseInsensitiveCompare(paseoVerb) == .orderedSame ? nil : detail
        case .todo:
            if let items = input.items, !items.isEmpty {
                let done = items.filter {
                    let norm = ($0.status ?? "").lowercased()
                    return norm == "completed" || norm == "done"
                }.count
                return "\(done)/\(items.count) completed"
            }
            return summary?.trimmedNonEmpty
        case .tool:
            if let summary = summary?.trimmedNonEmpty,
               summary.caseInsensitiveCompare(paseoVerb) != .orderedSame {
                return summary
            }
            if let server = input.server?.trimmedNonEmpty { return server }
            return nil
        case .reasoning:
            return nil
        }
    }

    /// Compact diff addition/deletion count for inline edit/write rows.
    var paseoDiffStats: (additions: Int, deletions: Int)? {
        guard let diff = input.diff?.trimmedNonEmpty else { return nil }
        let lines = RelayDiffLine.parse(diff)
        let added = lines.filter { $0.kind == .added }.count
        let removed = lines.filter { $0.kind == .removed }.count
        guard added > 0 || removed > 0 else { return nil }
        return (added, removed)
    }

    private static func compactDisplayPath(_ rawPath: String) -> String {
        let components = rawPath.split(separator: "/").map(String.init)
        guard components.count > 2 else { return rawPath }
        return components.suffix(2).joined(separator: "/")
    }

    /// What a step row says, and whether it is code. File names, commands and
    /// search patterns are set in mono; descriptions and tool names are not.
    var rowSummary: (text: String, isCode: Bool) {
        switch kind {
        case .command:
            if let description = input.description?.trimmedNonEmpty { return (description, false) }
            if let summary = summary?.trimmedNonEmpty,
               summary != input.command?.split(whereSeparator: \.isNewline).first.map(String.init) {
                return (summary, false)
            }
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

extension RelayStepKind {
    var symbol: String {
        switch self {
        case .command: return "terminal"
        case .read: return "doc.text"
        case .edit, .write: return "pencil.line"
        case .search: return "magnifyingglass"
        case .fetch: return "globe"
        case .agent: return "person.2"
        case .reasoning: return "ellipsis"
        case .todo: return "list.bullet"
        case .tool: return "wrench"
        }
    }

    var paseoSymbol: String {
        switch self {
        case .command: return "terminal"
        case .read: return "doc.text"
        case .edit, .write: return "pencil.line"
        case .search: return "magnifyingglass"
        case .fetch: return "globe"
        case .agent: return "person.2"
        case .reasoning: return "ellipsis"
        case .todo: return "checklist"
        case .tool: return "wrench"
        }
    }
}
