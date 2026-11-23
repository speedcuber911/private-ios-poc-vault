import SwiftUI

// MARK: - RelayButton

/// Canonical Paseo pill button with five semantic variants and two touch sizes.
/// Disabled state applies 0.5 opacity only — never a color shift.
struct RelayButton: View {
    enum Variant {
        case primary
        case secondary
        case outline
        case ghost
        case destructive
    }

    enum Size {
        case regular
        case sm

        var height: CGFloat {
            switch self {
            case .regular: return 44
            case .sm: return 32
            }
        }

        var horizontalPadding: CGFloat {
            switch self {
            case .regular: return 20
            case .sm: return 12
            }
        }

        var fontSize: CGFloat {
            switch self {
            case .regular: return 15
            case .sm: return 13
            }
        }

        var iconSize: CGFloat {
            switch self {
            case .regular: return 14
            case .sm: return 12
            }
        }
    }

    let title: String
    let variant: Variant
    let size: Size
    let systemImage: String?
    let isFullWidth: Bool
    let isLoading: Bool
    let isDisabled: Bool
    let action: () -> Void

    @Environment(\.relayTheme) private var theme
    @Environment(\.isEnabled) private var environmentEnabled

    init(
        _ title: String,
        variant: Variant = .secondary,
        size: Size = .regular,
        systemImage: String? = nil,
        isFullWidth: Bool = false,
        isLoading: Bool = false,
        isDisabled: Bool = false,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.variant = variant
        self.size = size
        self.systemImage = systemImage
        self.isFullWidth = isFullWidth
        self.isLoading = isLoading
        self.isDisabled = isDisabled
        self.action = action
    }

    private var effectivelyDisabled: Bool {
        isDisabled || isLoading || !environmentEnabled
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(foregroundColor)
                } else if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: size.iconSize, weight: .medium))
                }
                Text(title)
                    .font(RelayTheme.uiFont(size.fontSize, weight: .medium))
                    .lineLimit(1)
            }
            .padding(.horizontal, size.horizontalPadding)
            .frame(maxWidth: isFullWidth ? .infinity : nil)
            .frame(minHeight: size.height)
        }
        .buttonStyle(
            RelayPillButtonStyle(
                variant: variant,
                theme: theme,
                isDisabled: effectivelyDisabled
            )
        )
        .disabled(effectivelyDisabled)
    }

    private var foregroundColor: Color {
        switch variant {
        case .primary: return theme.accentForeground
        case .secondary, .outline: return theme.foreground
        case .ghost: return theme.foregroundMuted
        case .destructive: return theme.destructiveForeground
        }
    }
}

private struct RelayPillButtonStyle: ButtonStyle {
    let variant: RelayButton.Variant
    let theme: RelayThemePalette
    let isDisabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && !isDisabled
        configuration.label
            .foregroundStyle(labelColor(pressed: pressed))
            .background(backgroundColor(pressed: pressed), in: Capsule())
            .overlay {
                if variant == .outline {
                    Capsule()
                        .strokeBorder(theme.borderAccent, lineWidth: 1)
                }
            }
            .overlay {
                if pressed && (variant == .primary || variant == .secondary || variant == .destructive) {
                    Capsule()
                        .fill(theme.interactionHighlight)
                }
            }
            .contentShape(Capsule())
            .opacity(isDisabled ? 0.5 : (pressed ? 0.88 : 1.0))
            .animation(.easeOut(duration: 0.12), value: pressed)
    }

    private func labelColor(pressed: Bool) -> Color {
        switch variant {
        case .primary: return theme.accentForeground
        case .secondary, .outline: return theme.foreground
        case .ghost: return pressed ? theme.foreground : theme.foregroundMuted
        case .destructive: return theme.destructiveForeground
        }
    }

    private func backgroundColor(pressed: Bool) -> Color {
        switch variant {
        case .primary: return theme.accent
        case .secondary: return theme.surface3
        case .outline: return pressed ? theme.interactionHighlight : .clear
        case .ghost: return pressed ? theme.interactionHighlight : .clear
        case .destructive: return theme.destructive
        }
    }
}

// MARK: - RelayToolbarIconButton

/// 36pt circular toolbar icon control with `interactionHighlight` press/selected fill.
struct RelayToolbarIconButton: View {
    let systemImage: String
    let accessibilityLabel: String
    var iconSize: CGFloat = 18
    var weight: Font.Weight = .regular
    var isSelected: Bool = false
    var isMuted: Bool = false
    var tint: Color? = nil
    var isDisabled: Bool = false
    let action: () -> Void

    @Environment(\.relayTheme) private var theme
    @Environment(\.isEnabled) private var environmentEnabled

    private var effectivelyDisabled: Bool {
        isDisabled || !environmentEnabled
    }

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: iconSize, weight: weight))
                .frame(width: 36, height: 36)
        }
        .buttonStyle(
            RelayToolbarDiscButtonStyle(
                theme: theme,
                isSelected: isSelected,
                isMuted: isMuted,
                tint: tint,
                isDisabled: effectivelyDisabled
            )
        )
        .disabled(effectivelyDisabled)
        .accessibilityLabel(accessibilityLabel)
    }
}

private struct RelayToolbarDiscButtonStyle: ButtonStyle {
    let theme: RelayThemePalette
    let isSelected: Bool
    let isMuted: Bool
    let tint: Color?
    let isDisabled: Bool

    func makeBody(configuration: Configuration) -> some View {
        let pressed = configuration.isPressed && !isDisabled
        let baseColor = tint ?? (isMuted ? theme.foregroundMuted : theme.foreground)
        let activeColor = (pressed || isSelected) ? (tint ?? theme.foreground) : baseColor

        configuration.label
            .foregroundStyle(activeColor)
            .background(
                (pressed || isSelected) ? theme.interactionHighlight : Color.clear,
                in: Circle()
            )
            .contentShape(Circle())
            .opacity(isDisabled ? 0.5 : 1.0)
            .animation(.easeOut(duration: 0.12), value: pressed)
    }
}

// MARK: - Settings Primitives

/// Grouped settings section with a medium-weight structural heading and optional info popover.
struct RelaySettingsSection<Trailing: View, Content: View>: View {
    let title: String
    let info: String?
    let flush: Bool
    let trailing: Trailing
    let content: Content

    @Environment(\.relayTheme) private var theme
    @State private var showingInfo = false

    init(
        _ title: String,
        info: String? = nil,
        flush: Bool = false,
        @ViewBuilder trailing: () -> Trailing,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title
        self.info = info
        self.flush = flush
        self.trailing = trailing()
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 6) {
                Text(title)
                    .font(RelayTheme.uiFont(13, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                    .accessibilityAddTraits(.isHeader)

                if let info, !info.isEmpty {
                    Button {
                        showingInfo = true
                    } label: {
                        Image(systemName: "info.circle")
                            .font(.system(size: 13, weight: .regular))
                            .foregroundStyle(theme.foregroundExtraMuted)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("About \(title)")
                    .popover(isPresented: $showingInfo, arrowEdge: .top) {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(title)
                                .font(RelayTheme.uiFont(15, weight: .medium))
                                .foregroundStyle(theme.foreground)
                            Text(info)
                                .font(RelayTheme.uiFont(14, weight: .regular))
                                .foregroundStyle(theme.foregroundMuted)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .padding(16)
                        .frame(width: 280, alignment: .leading)
                        .background(theme.surface1)
                        .presentationCompactAdaptation(.popover)
                        .preferredColorScheme(theme.colorScheme)
                    }
                }

                Spacer(minLength: 8)

                trailing
            }
            .padding(.horizontal, 4)

            VStack(alignment: .leading, spacing: 12) {
                content
            }
        }
        .padding(.bottom, flush ? 0 : 24)
    }
}

extension RelaySettingsSection where Trailing == EmptyView {
    init(
        _ title: String,
        info: String? = nil,
        flush: Bool = false,
        @ViewBuilder content: () -> Content
    ) {
        self.init(title, info: info, flush: flush, trailing: { EmptyView() }, content: content)
    }
}

/// Single `surface1` grouped card with 1pt `border` and 12pt continuous corner radius.
struct RelaySettingsCard<Content: View>: View {
    let content: Content

    @Environment(\.relayTheme) private var theme

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface1)
        .clipShape(.rect(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
    }
}

/// Subtle 1pt divider separating rows inside a `RelaySettingsCard`.
struct RelaySettingsDivider: View {
    @Environment(\.relayTheme) private var theme

    var body: some View {
        Rectangle()
            .fill(theme.border)
            .frame(height: 1)
    }
}

/// Canonical settings row with leading icon rail, regular-weight title, optional subtitle,
/// trailing slot, and optional disclosure chevron.
struct RelaySettingsRow<Trailing: View>: View {
    let title: String
    let subtitle: String?
    let isErrorSubtitle: Bool
    let systemImage: String?
    let iconColor: Color?
    let showsChevron: Bool
    let showsTopDivider: Bool
    let action: (() -> Void)?
    let trailing: Trailing

    @Environment(\.relayTheme) private var theme

    init(
        _ title: String,
        subtitle: String? = nil,
        isErrorSubtitle: Bool = false,
        systemImage: String? = nil,
        iconColor: Color? = nil,
        showsChevron: Bool = false,
        showsTopDivider: Bool = false,
        action: (() -> Void)? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.isErrorSubtitle = isErrorSubtitle
        self.systemImage = systemImage
        self.iconColor = iconColor
        self.showsChevron = showsChevron
        self.showsTopDivider = showsTopDivider
        self.action = action
        self.trailing = trailing()
    }

    var body: some View {
        VStack(spacing: 0) {
            if showsTopDivider {
                RelaySettingsDivider()
            }

            if let action {
                Button(action: action) {
                    rowContent
                }
                .buttonStyle(RelayRowPressButtonStyle(highlight: theme.interactionHighlight))
            } else {
                rowContent
            }
        }
    }

    private var rowContent: some View {
        HStack(alignment: .center, spacing: 12) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(iconColor ?? theme.foregroundMuted)
                    .frame(width: 22, alignment: .center)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(RelayTheme.uiFont(15, weight: .regular))
                    .foregroundStyle(theme.foreground)
                    .frame(maxWidth: .infinity, alignment: .leading)

                if let subtitle, !subtitle.isEmpty {
                    Text(subtitle)
                        .font(RelayTheme.uiFont(13, weight: .regular))
                        .foregroundStyle(isErrorSubtitle ? theme.statusDanger : theme.foregroundMuted)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }

            trailing

            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(theme.foregroundExtraMuted)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 13)
        .frame(minHeight: 52, alignment: .leading)
        .contentShape(Rectangle())
    }
}

extension RelaySettingsRow where Trailing == EmptyView {
    init(
        _ title: String,
        subtitle: String? = nil,
        isErrorSubtitle: Bool = false,
        systemImage: String? = nil,
        iconColor: Color? = nil,
        showsChevron: Bool = false,
        showsTopDivider: Bool = false,
        action: (() -> Void)? = nil
    ) {
        self.init(
            title,
            subtitle: subtitle,
            isErrorSubtitle: isErrorSubtitle,
            systemImage: systemImage,
            iconColor: iconColor,
            showsChevron: showsChevron,
            showsTopDivider: showsTopDivider,
            action: action,
            trailing: { EmptyView() }
        )
    }
}

private struct RelayRowPressButtonStyle: ButtonStyle {
    let highlight: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? highlight : Color.clear)
            .animation(.easeOut(duration: 0.1), value: configuration.isPressed)
    }
}

// MARK: - Status Indicators

enum RelayStatusBucket: String, CaseIterable, Equatable, Hashable, Codable {
    case idle
    case running
    case needsInput
    case done
    case error

    func dotColor(in theme: RelayThemePalette) -> Color {
        switch self {
        case .idle: return theme.foregroundExtraMuted
        case .running: return theme.statusDotRunning
        case .needsInput: return theme.statusDotWarning
        case .done: return theme.statusDotSuccess
        case .error: return theme.statusDotDanger
        }
    }

    func statusColor(in theme: RelayThemePalette) -> Color {
        switch self {
        case .idle: return theme.foregroundMuted
        case .running: return theme.statusDotRunning
        case .needsInput: return theme.statusWarning
        case .done: return theme.statusSuccess
        case .error: return theme.statusDanger
        }
    }
}

/// 6pt calibrated solid status dot reading exclusively from the `statusDot*` family.
struct RelayStatusDot: View {
    let bucket: RelayStatusBucket
    var size: CGFloat = 6

    @Environment(\.relayTheme) private var theme

    var body: some View {
        Circle()
            .fill(bucket.dotColor(in: theme))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

/// 12pt calm animated spinning arc in `statusDotRunning`.
/// Phase-synchronized across rows via wall-clock time; stops completely when inactive or reduced motion is enabled.
struct RelayStatusRing: View {
    var isActive: Bool = true
    var size: CGFloat = 12
    var lineWidth: CGFloat = 1.5
    var showsCenterDot: Bool = true

    @Environment(\.relayTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    private var shouldAnimate: Bool {
        isActive && !reduceMotion && scenePhase == .active
    }

    var body: some View {
        TimelineView(.animation(paused: !shouldAnimate)) { context in
            let periodSeconds = 0.9
            let phase = shouldAnimate
                ? context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: periodSeconds) / periodSeconds
                : 0
            let angle = Angle.degrees(phase * 360)

            ZStack {
                Circle()
                    .stroke(theme.statusDotRunning.opacity(0.30), lineWidth: lineWidth)

                if isActive {
                    Circle()
                        .trim(from: 0, to: 0.28)
                        .stroke(
                            theme.statusDotRunning.opacity(0.90),
                            style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                        )
                        .rotationEffect(angle - .degrees(90))
                }

                if showsCenterDot {
                    Circle()
                        .fill(theme.statusDotRunning)
                        .frame(width: max(4, size * 0.42), height: max(4, size * 0.42))
                }
            }
            .frame(width: size, height: size)
        }
        .accessibilityHidden(true)
    }
}

/// Neutral `surface3` + 1pt `border` status pill with regular-weight status text.
struct RelayStatusBadge: View {
    let label: String
    var bucket: RelayStatusBucket = .idle
    var showsDot: Bool = false
    var compact: Bool = false

    @Environment(\.relayTheme) private var theme

    init(
        _ label: String,
        bucket: RelayStatusBucket = .idle,
        showsDot: Bool = false,
        compact: Bool = false
    ) {
        self.label = label
        self.bucket = bucket
        self.showsDot = showsDot
        self.compact = compact
    }

    var body: some View {
        HStack(spacing: 5) {
            if showsDot {
                if bucket == .running {
                    RelayStatusRing(isActive: true, size: 10, lineWidth: 1.3, showsCenterDot: true)
                } else {
                    RelayStatusDot(bucket: bucket, size: 6)
                }
            }

            Text(label)
                .font(RelayTheme.uiFont(12, weight: .regular))
                .foregroundStyle(bucket.statusColor(in: theme))
                .lineLimit(1)
        }
        .padding(.horizontal, compact ? 6 : 8)
        .padding(.vertical, compact ? 2 : 3)
        .background(theme.surface3, in: Capsule())
        .overlay {
            Capsule()
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .fixedSize()
    }
}

// MARK: - Identity & Diff Primitives

/// 20pt rounded-6 square monogram tile using `RelayIdentityColor`, or an optional SF Symbol.
struct RelayProjectIcon: View {
    let name: String
    var seed: String? = nil
    var colorIndex: Int? = nil
    var systemImage: String? = nil
    var size: CGFloat = 20

    private var cornerRadius: CGFloat {
        max(4, (size * 0.30).rounded())
    }

    private var tileColor: Color {
        if let colorIndex {
            return RelayIdentityColor.color(at: colorIndex)
        }
        return RelayIdentityColor.color(for: seed ?? name)
    }

    private var initial: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if let first = trimmed.first(where: { $0.isLetter || $0.isNumber }) {
            return String(first).uppercased()
        }
        if let first = trimmed.first {
            return String(first).uppercased()
        }
        return "R"
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                .fill(tileColor)

            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: (size * 0.52).rounded(), weight: .semibold))
                    .foregroundStyle(Color.white)
            } else {
                Text(initial)
                    .font(.system(size: (size * 0.55).rounded(), weight: .semibold))
                    .foregroundStyle(Color.white)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// Compact monospaced diff stat (`+68` in `statusSuccess`, `-23` in `statusDanger`).
struct RelayDiffStatView: View {
    let additions: Int
    let deletions: Int

    @Environment(\.relayTheme) private var theme

    var body: some View {
        HStack(spacing: 4) {
            Text("+\(max(0, additions))")
                .foregroundStyle(theme.statusSuccess)
            Text("-\(max(0, deletions))")
                .foregroundStyle(theme.statusDanger)
        }
        .font(RelayTheme.monoFont(12, weight: .regular))
        .monospacedDigit()
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(additions) additions, \(deletions) deletions")
    }
}

// MARK: - Sheet Header & Empty State

/// Uniform Paseo sheet header: leading icon, medium-weight title, optional subtitle,
/// trailing icon actions, circular close button, separated by a 1pt bottom border.
struct RelaySheetHeader<Actions: View>: View {
    let title: String
    let subtitle: String?
    let systemImage: String?
    let onClose: (() -> Void)?
    let actions: Actions

    @Environment(\.relayTheme) private var theme

    init(
        _ title: String,
        subtitle: String? = nil,
        systemImage: String? = nil,
        onClose: (() -> Void)? = nil,
        @ViewBuilder actions: () -> Actions
    ) {
        self.title = title
        self.subtitle = subtitle
        self.systemImage = systemImage
        self.onClose = onClose
        self.actions = actions()
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 17, weight: .regular))
                        .foregroundStyle(theme.foregroundMuted)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(RelayTheme.uiFont(16, weight: .medium))
                        .foregroundStyle(theme.foreground)
                        .lineLimit(1)

                    if let subtitle, !subtitle.isEmpty {
                        Text(subtitle)
                            .font(RelayTheme.uiFont(13, weight: .regular))
                            .foregroundStyle(theme.foregroundMuted)
                            .lineLimit(1)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                HStack(spacing: 4) {
                    actions

                    if let onClose {
                        RelayToolbarIconButton(
                            systemImage: "xmark",
                            accessibilityLabel: "Close",
                            iconSize: 15,
                            weight: .medium,
                            isMuted: true,
                            action: onClose
                        )
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .frame(minHeight: 56)
            .background(theme.surface0)

            Rectangle()
                .fill(theme.border)
                .frame(height: 1)
        }
    }
}

extension RelaySheetHeader where Actions == EmptyView {
    init(
        _ title: String,
        subtitle: String? = nil,
        systemImage: String? = nil,
        onClose: (() -> Void)? = nil
    ) {
        self.init(title, subtitle: subtitle, systemImage: systemImage, onClose: onClose) {
            EmptyView()
        }
    }
}

/// Quiet centered muted noun phrase with at most one ghost action button, zero illustrations.
struct RelayEmptyStateView: View {
    let message: String
    var actionTitle: String? = nil
    var action: (() -> Void)? = nil

    @Environment(\.relayTheme) private var theme

    init(_ message: String, actionTitle: String? = nil, action: (() -> Void)? = nil) {
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        VStack(spacing: 12) {
            Text(message)
                .font(RelayTheme.uiFont(15, weight: .regular))
                .foregroundStyle(theme.foregroundMuted)
                .multilineTextAlignment(.center)

            if let actionTitle, let action {
                RelayButton(actionTitle, variant: .ghost, size: .sm, action: action)
            }
        }
        .padding(.horizontal, 24)
        .padding(.vertical, 32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
