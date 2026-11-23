import SwiftUI
import UIKit

// MARK: - Panel Destination

/// The three mutually exclusive destinations of Relay's unified compact mobile shell.
/// Derived from Paseo's single-position panel architecture (`docs/mobile-panels.md`).
enum RelayMobilePanel: Equatable, Hashable, CaseIterable {
    case leftSidebar
    case center
    case rightExplorer

    /// Normalized position along the single shared track:
    /// `-1.0` = left sidebar open, `0.0` = center workspace, `+1.0` = right explorer open.
    var anchorProgress: CGFloat {
        switch self {
        case .leftSidebar: return -1.0
        case .center: return 0.0
        case .rightExplorer: return 1.0
        }
    }
}

// MARK: - Panel Controller

/// Owns the durable panel selection, command revision, and horizontal-scroll arbitration
/// for `RelayMobilePanelsContainer`.
@MainActor
final class RelayMobilePanelController: ObservableObject {
    /// Canonical requested destination. Updating this directly or via helper methods
    /// increments `revision`, cancels any conflicting drag, and auto-dismisses the keyboard
    /// when sliding away from `.center`.
    @Published var target: RelayMobilePanel {
        didSet {
            guard !isApplyingGestureCommit else { return }
            revision &+= 1
            if target != .center {
                Self.dismissKeyboard()
            }
        }
    }

    /// Last panel that settled at its anchor.
    @Published private(set) var settledPanel: RelayMobilePanel

    /// Monotonically incremented on every semantic command so an older in-flight drag
    /// yields immediately instead of fighting programmatic navigation.
    @Published private(set) var revision: Int = 0

    /// Set to `true` by inner horizontal scrollers (diff hunks, code blocks, horizontal tables)
    /// while they are actively claiming horizontal drag gestures.
    @Published var horizontalScrollBlocked: Bool = false

    private var activeBlockTokens: Set<UUID> = []
    private var isApplyingGestureCommit = false

    var isHorizontalScrollBlocked: Bool {
        horizontalScrollBlocked || !activeBlockTokens.isEmpty
    }

    init(initialTarget: RelayMobilePanel = .center) {
        self.target = initialTarget
        self.settledPanel = initialTarget
    }

    func openSidebar() {
        setTarget(.leftSidebar)
    }

    func openExplorer() {
        setTarget(.rightExplorer)
    }

    func showCenter() {
        setTarget(.center)
    }

    func toggleSidebar() {
        setTarget(target == .leftSidebar ? .center : .leftSidebar)
    }

    func toggleExplorer() {
        setTarget(target == .rightExplorer ? .center : .rightExplorer)
    }

    func setTarget(_ next: RelayMobilePanel) {
        if target != next {
            target = next
        } else {
            // Re-asserting the current target still bumps revision so a partially dragged
            // panel snaps cleanly back to its canonical anchor.
            revision &+= 1
            if next != .center {
                Self.dismissKeyboard()
            }
        }
    }

    /// Registers a scoped horizontal-scroll blocker (safe for nested/concurrent horizontal views).
    func beginHorizontalScrollBlock() -> UUID {
        let token = UUID()
        activeBlockTokens.insert(token)
        return token
    }

    /// Releases a previously registered horizontal-scroll blocker.
    func endHorizontalScrollBlock(_ token: UUID) {
        activeBlockTokens.remove(token)
    }

    fileprivate func commitGestureTarget(_ next: RelayMobilePanel) {
        isApplyingGestureCommit = true
        if target != next {
            target = next
        }
        settledPanel = next
        isApplyingGestureCommit = false
        if next != .center {
            Self.dismissKeyboard()
        }
    }

    fileprivate func markSettled(_ panel: RelayMobilePanel) {
        if settledPanel != panel {
            settledPanel = panel
        }
    }

    static func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }
}

// MARK: - 3-Panel Swipe Container

/// Unified 3-panel compact mobile shell (Left Sidebar, Center Workspace, Right Explorer)
/// driven by a single normalized position in `-1.0 ... +1.0`.
///
/// All three panels stay mounted in one `GeometryReader` + `ZStack` so scroll offsets,
/// expanded rows, and transient UI state survive panel transitions without layout jitter.
struct RelayMobilePanelsContainer<Left: View, Center: View, Right: View>: View {
    @ObservedObject var controller: RelayMobilePanelController
    var leftSidebarEnabled: Bool
    var rightExplorerEnabled: Bool
    let left: Left
    let center: Center
    let right: Right

    @Environment(\.relayTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    /// Single source of truth for transient visual progress (`-1` left, `0` center, `+1` right).
    @State private var progress: CGFloat = 0
    @State private var dragPhase: DragPhase = .idle

    private enum DragPhase: Equatable {
        case idle
        case lockedHorizontal(startRevision: Int, startTarget: RelayMobilePanel)
        case rejected
    }

    private static var snapSpring: Animation {
        .spring(response: 0.30, dampingFraction: 0.90)
    }

    private static var horizontalIntentRatio: CGFloat { 1.4 }
    private static var snapDistanceThreshold: CGFloat { 0.28 }
    private static var snapVelocityThreshold: CGFloat { 380 }
    private static var maxBackdropOpacity: Double { 0.48 }

    init(
        controller: RelayMobilePanelController,
        leftSidebarEnabled: Bool = true,
        rightExplorerEnabled: Bool = true,
        @ViewBuilder left: () -> Left,
        @ViewBuilder center: () -> Center,
        @ViewBuilder right: () -> Right
    ) {
        self.controller = controller
        self.leftSidebarEnabled = leftSidebarEnabled
        self.rightExplorerEnabled = rightExplorerEnabled
        self.left = left()
        self.center = center()
        self.right = right()
        _progress = State(initialValue: controller.target.anchorProgress)
    }

    private var isDraggingHorizontally: Bool {
        if case .lockedHorizontal = dragPhase { return true }
        return false
    }

    var body: some View {
        GeometryReader { geometry in
            let width = max(1, geometry.size.width)
            let height = max(1, geometry.size.height)
            let leftWidth = min(340, width * 0.86)
            let rightWidth = width
            let clampedProgress = clamp(progress, min: leftSidebarEnabled ? -1 : 0, max: rightExplorerEnabled ? 1 : 0)
            let leftOpen = max(0, -clampedProgress)
            let rightOpen = max(0, clampedProgress)
            let backdropOpacity = Double(max(leftOpen, rightOpen)) * Self.maxBackdropOpacity
            let safeLeading = geometry.safeAreaInsets.leading
            let safeTrailing = geometry.safeAreaInsets.trailing

            ZStack(alignment: .leading) {
                // 1. Center Workspace surface (remains stationary underneath drawers)
                center
                    .frame(width: width, height: height)
                    .allowsHitTesting(controller.target == .center && !isDraggingHorizontally)
                    .accessibilityHidden(controller.target != .center)

                // 2. Smoothly interpolated dimming backdrop
                Color.black
                    .opacity(backdropOpacity)
                    .ignoresSafeArea()
                    .allowsHitTesting(controller.target != .center || max(leftOpen, rightOpen) > 0.05)
                    .onTapGesture {
                        controller.showCenter()
                    }
                    .accessibilityElement()
                    .accessibilityLabel("Return to workspace")
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHidden(controller.target == .center)

                // 3. Left Workspaces Sidebar drawer (leading edge, min(340, 86% width))
                if leftSidebarEnabled {
                    left
                        .frame(width: leftWidth, height: height)
                        .background(theme.surfaceSidebar.ignoresSafeArea(edges: .vertical))
                        .overlay(alignment: .trailing) {
                            Rectangle()
                                .fill(theme.border)
                                .frame(width: 1)
                                .ignoresSafeArea(edges: .vertical)
                                .opacity(leftOpen > 0.01 ? 1 : 0)
                        }
                        .shadow(
                            color: Color.black.opacity(leftOpen > 0.01 ? 0.30 * Double(leftOpen) : 0),
                            radius: 18,
                            x: 4,
                            y: 0
                        )
                        .offset(x: -(leftWidth + safeLeading) * (1 - leftOpen))
                        .opacity(leftOpen > 0.002 ? 1 : 0)
                        .allowsHitTesting(controller.target == .leftSidebar && leftOpen > 0.5 && !isDraggingHorizontally)
                        .accessibilityHidden(controller.target != .leftSidebar)
                }

                // 4. Right Explorer / Changes full-screen drawer (trailing edge, 100% width)
                if rightExplorerEnabled {
                    right
                        .frame(width: rightWidth, height: height)
                        .background(theme.surface0.ignoresSafeArea(edges: .vertical))
                        .shadow(
                            color: Color.black.opacity(rightOpen > 0.01 ? 0.24 * Double(rightOpen) : 0),
                            radius: 16,
                            x: -4,
                            y: 0
                        )
                        .offset(x: (rightWidth + safeTrailing) * (1 - rightOpen))
                        .opacity(rightOpen > 0.002 ? 1 : 0)
                        .allowsHitTesting(controller.target == .rightExplorer && rightOpen > 0.5 && !isDraggingHorizontally)
                        .accessibilityHidden(controller.target != .rightExplorer)
                }
            }
            .frame(width: width, height: height, alignment: .leading)
            .simultaneousGesture(
                panelDragGesture(leftWidth: leftWidth, rightWidth: rightWidth)
            )
        }
        .background(theme.surface0.ignoresSafeArea())
        .environmentObject(controller)
        .onAppear {
            syncProgressToTarget(animated: false)
        }
        .onChange(of: controller.revision) { _, _ in
            handleProgrammaticCommand()
        }
        .onChange(of: leftSidebarEnabled) { _, enabled in
            if !enabled, controller.target == .leftSidebar {
                controller.showCenter()
            }
        }
        .onChange(of: rightExplorerEnabled) { _, enabled in
            if !enabled, controller.target == .rightExplorer {
                controller.showCenter()
            }
        }
        .onChange(of: scenePhase) { _, phase in
            // If a system gesture or interruption backgrounds the app mid-drag,
            // settle cleanly back to the canonical anchor instead of leaving a half-open drawer.
            if phase != .active, dragPhase != .idle {
                dragPhase = .idle
                syncProgressToTarget(animated: false)
            }
        }
    }

    // MARK: - Gesture Arbitration

    private func panelDragGesture(leftWidth: CGFloat, rightWidth: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 16, coordinateSpace: .local)
            .onChanged { value in
                handleDragChanged(value, leftWidth: leftWidth, rightWidth: rightWidth)
            }
            .onEnded { value in
                handleDragEnded(value, leftWidth: leftWidth, rightWidth: rightWidth)
            }
    }

    private func handleDragChanged(
        _ value: DragGesture.Value,
        leftWidth: CGFloat,
        rightWidth: CGFloat
    ) {
        let dx = value.translation.width
        let dy = value.translation.height

        switch dragPhase {
        case .rejected:
            return

        case .idle:
            // Respect inner horizontal scrollers (diff hunks, wide code blocks, horizontal rails).
            if controller.isHorizontalScrollBlocked {
                dragPhase = .rejected
                return
            }

            let absX = abs(dx)
            let absY = abs(dy)

            // Wait until the gesture decisively breaks either horizontal or vertical intent.
            if absX > absY * Self.horizontalIntentRatio, absX >= 16 {
                let startTarget = controller.target

                // Ignore outward drags that have no destination in that direction so we never
                // swallow horizontal interactions inside an open panel.
                if startTarget == .leftSidebar && dx > 0 {
                    dragPhase = .rejected
                    return
                }
                if startTarget == .rightExplorer && dx < 0 {
                    dragPhase = .rejected
                    return
                }
                if startTarget == .center {
                    if dx > 0 && !leftSidebarEnabled {
                        dragPhase = .rejected
                        return
                    }
                    if dx < 0 && !rightExplorerEnabled {
                        dragPhase = .rejected
                        return
                    }
                }

                dragPhase = .lockedHorizontal(startRevision: controller.revision, startTarget: startTarget)
                if startTarget == .center {
                    RelayMobilePanelController.dismissKeyboard()
                }
                progress = draggedProgress(dx: dx, startTarget: startTarget, leftWidth: leftWidth, rightWidth: rightWidth)
            } else if absY >= 16 {
                dragPhase = .rejected
            }

        case .lockedHorizontal(let startRevision, let startTarget):
            // An imperative command superseded this drag — yield immediately.
            guard startRevision == controller.revision else {
                dragPhase = .rejected
                return
            }
            progress = draggedProgress(dx: dx, startTarget: startTarget, leftWidth: leftWidth, rightWidth: rightWidth)
        }
    }

    private func handleDragEnded(
        _ value: DragGesture.Value,
        leftWidth: CGFloat,
        rightWidth: CGFloat
    ) {
        defer { dragPhase = .idle }

        guard case .lockedHorizontal(let startRevision, let startTarget) = dragPhase,
              startRevision == controller.revision else {
            return
        }

        let currentProgress = draggedProgress(
            dx: value.translation.width,
            startTarget: startTarget,
            leftWidth: leftWidth,
            rightWidth: rightWidth
        )
        let velocityX = value.velocity.width
        let destination = resolvedDestination(
            from: startTarget,
            progress: currentProgress,
            velocityX: velocityX
        )

        controller.commitGestureTarget(destination)
        animateProgress(to: destination.anchorProgress, settling: destination)
    }

    /// Maps finger displacement into normalized `-1 ... +1` progress, constrained so a single
    /// swipe transitions only between adjacent anchors (`left <-> center` or `center <-> right`).
    private func draggedProgress(
        dx: CGFloat,
        startTarget: RelayMobilePanel,
        leftWidth: CGFloat,
        rightWidth: CGFloat
    ) -> CGFloat {
        switch startTarget {
        case .center:
            if dx >= 0 {
                guard leftSidebarEnabled else { return 0 }
                return clamp(-dx / max(1, leftWidth), min: -1, max: 0)
            } else {
                guard rightExplorerEnabled else { return 0 }
                return clamp(-dx / max(1, rightWidth), min: 0, max: 1)
            }
        case .leftSidebar:
            let raw = -1 + (-dx / max(1, leftWidth))
            return clamp(raw, min: -1, max: 0)
        case .rightExplorer:
            let raw = 1 + (-dx / max(1, rightWidth))
            return clamp(raw, min: 0, max: 1)
        }
    }

    private func resolvedDestination(
        from startTarget: RelayMobilePanel,
        progress current: CGFloat,
        velocityX: CGFloat
    ) -> RelayMobilePanel {
        let distance = Self.snapDistanceThreshold
        let velocity = Self.snapVelocityThreshold

        switch startTarget {
        case .center:
            if leftSidebarEnabled,
               current <= -distance || (current < -0.05 && velocityX > velocity) {
                return .leftSidebar
            }
            if rightExplorerEnabled,
               current >= distance || (current > 0.05 && velocityX < -velocity) {
                return .rightExplorer
            }
            return .center

        case .leftSidebar:
            let closedFraction = 1 + current
            if closedFraction >= distance || velocityX < -velocity {
                return .center
            }
            return .leftSidebar

        case .rightExplorer:
            let closedFraction = 1 - current
            if closedFraction >= distance || velocityX > velocity {
                return .center
            }
            return .rightExplorer
        }
    }

    // MARK: - Command Synchronization

    private func handleProgrammaticCommand() {
        if case .lockedHorizontal(let startRevision, _) = dragPhase,
           startRevision != controller.revision {
            dragPhase = .rejected
        }
        var destination = controller.target
        if destination == .leftSidebar && !leftSidebarEnabled { destination = .center }
        if destination == .rightExplorer && !rightExplorerEnabled { destination = .center }
        if destination != .center {
            RelayMobilePanelController.dismissKeyboard()
        }
        animateProgress(to: destination.anchorProgress, settling: destination)
    }

    private func syncProgressToTarget(animated: Bool) {
        let destination = controller.target
        if animated {
            animateProgress(to: destination.anchorProgress, settling: destination)
        } else {
            progress = destination.anchorProgress
            controller.markSettled(destination)
        }
    }

    private func animateProgress(to targetProgress: CGFloat, settling panel: RelayMobilePanel) {
        if reduceMotion {
            progress = targetProgress
            controller.markSettled(panel)
        } else {
            withAnimation(Self.snapSpring) {
                progress = targetProgress
            }
            controller.markSettled(panel)
        }
    }

    private func clamp(_ value: CGFloat, min lower: CGFloat, max upper: CGFloat) -> CGFloat {
        Swift.min(Swift.max(value, lower), upper)
    }
}

// MARK: - Horizontal Scroll Arbitration Modifier

private struct RelayHorizontalScrollBlockerModifier: ViewModifier {
    let isBlocked: Bool
    @ObservedObject var controller: RelayMobilePanelController
    @State private var token: UUID?

    func body(content: Content) -> some View {
        content
            .onAppear { sync(isBlocked) }
            .onChange(of: isBlocked) { _, blocked in sync(blocked) }
            .onDisappear { release() }
    }

    private func sync(_ blocked: Bool) {
        if blocked {
            if token == nil {
                token = controller.beginHorizontalScrollBlock()
            }
        } else {
            release()
        }
    }

    private func release() {
        if let existing = token {
            controller.endHorizontalScrollBlock(existing)
            token = nil
        }
    }
}

extension View {
    /// Registers a scoped horizontal-scroll blocker on `controller` while `isBlocked` is true
    /// so wide code blocks, diffs, or horizontal scrollers do not fight panel swipes.
    func relayBlocksPanelSwipe(
        _ isBlocked: Bool,
        controller: RelayMobilePanelController
    ) -> some View {
        modifier(RelayHorizontalScrollBlockerModifier(isBlocked: isBlocked, controller: controller))
    }
}
