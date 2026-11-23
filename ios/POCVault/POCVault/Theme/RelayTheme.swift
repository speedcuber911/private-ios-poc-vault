import Combine
import SwiftUI
import UIKit

// MARK: - Hex Color Helper (does not redeclare `Color(hex: UInt32)` from POCVaultApp.swift)

private extension Color {
    init(relayHex hex: UInt32, alpha: Double = 1.0) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: alpha
        )
    }
}

// MARK: - Theme Identifier

enum RelayThemeID: String, CaseIterable, Identifiable, Codable, Hashable {
    case paseoDark
    case zinc
    case midnight
    case claude
    case ghostty
    case pureBlack
    case light
    case ember

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .paseoDark: return "Paseo Dark"
        case .zinc: return "Zinc"
        case .midnight: return "Midnight"
        case .claude: return "Claude"
        case .ghostty: return "Ghostty"
        case .pureBlack: return "Pure Black"
        case .light: return "Light"
        case .ember: return "Ember"
        }
    }

    var swatchHex: UInt32 {
        switch self {
        case .paseoDark: return 0x2D8B62
        case .zinc: return 0x808080
        case .midnight: return 0x4A6BA8
        case .claude: return 0xD97757
        case .ghostty: return 0x8CAAEE
        case .pureBlack: return 0x000000
        case .light: return 0xFFFFFF
        case .ember: return 0xD4804A
        }
    }

    var swatchColor: Color {
        Color(relayHex: swatchHex)
    }

    var isDark: Bool {
        self != .light
    }

    var palette: RelayThemePalette {
        RelayThemePalette.palette(for: self)
    }
}

// MARK: - Chat Sending Behavior

enum RelaySendWhileRunningBehavior: String, CaseIterable, Identifiable, Codable, Hashable {
    case steer
    case queue
    case interrupt

    var id: String { rawValue }

    var title: String {
        switch self {
        case .steer: return "Steer"
        case .queue: return "Queue"
        case .interrupt: return "Interrupt"
        }
    }

    var subtitle: String {
        switch self {
        case .steer: return "Guide the active run with your next message"
        case .queue: return "Send automatically after the active run finishes"
        case .interrupt: return "Stop the active run and send immediately"
        }
    }
}

// MARK: - Semantic Palette

struct RelayThemePalette: Equatable {
    let id: RelayThemeID
    let isDark: Bool

    // Surfaces
    let surfaceSidebar: Color
    let surface0: Color
    let surface1: Color
    let surface2: Color
    let surface3: Color
    let surface4: Color
    let surfaceSidebarHover: Color
    let surfaceSidebarSelected: Color
    let interactionHighlight: Color

    // Foregrounds
    let foreground: Color
    let foregroundMuted: Color
    let foregroundExtraMuted: Color

    // Borders
    let border: Color
    let borderAccent: Color

    // Brand & Destructive
    let accent: Color
    let accentBright: Color
    let accentForeground: Color
    let destructive: Color
    let destructiveForeground: Color

    // Status family (calibrated equal-chroma OKLab band — see Paseo theme.ts)
    let statusSuccess: Color
    let statusDanger: Color
    let statusWarning: Color
    let statusMerged: Color
    let statusSuccessTint: Color
    let statusDangerTint: Color
    let statusWarningTint: Color

    // Status dot family (90% gamut chroma, hue-separated at 6pt)
    let statusDotSuccess: Color
    let statusDotDanger: Color
    let statusDotWarning: Color
    let statusDotRunning: Color

    // Diff tokens
    let diffAddition: Color
    let diffDeletion: Color
    let diffAdditionBg: Color
    let diffDeletionBg: Color
    let diffHunkBg: Color

    // Syntax highlighting tokens
    let syntaxKeyword: Color
    let syntaxString: Color
    let syntaxComment: Color
    let syntaxType: Color
    let syntaxNumber: Color
    let syntaxFunction: Color
    let syntaxProperty: Color
    let syntaxOperator: Color

    // Terminal ANSI tokens
    let terminalBg: Color
    let terminalFg: Color
    let terminalCursor: Color
    let terminalRed: Color
    let terminalGreen: Color
    let terminalYellow: Color
    let terminalBlue: Color
    let terminalMagenta: Color
    let terminalCyan: Color
    let terminalBrightBlack: Color

    var colorScheme: ColorScheme {
        isDark ? .dark : .light
    }

    static func palette(for id: RelayThemeID) -> RelayThemePalette {
        switch id {
        case .paseoDark: return .paseoDark
        case .zinc: return .zinc
        case .midnight: return .midnight
        case .claude: return .claude
        case .ghostty: return .ghostty
        case .pureBlack: return .pureBlack
        case .light: return .light
        case .ember: return .ember
        }
    }

    // MARK: Presets

    /// Paseo Dark — subtle teal-green tint (default).
    static let paseoDark = makeDark(
        id: .paseoDark,
        surfaceSidebar: 0x141716,
        surface0: 0x181B1A,
        surface1: 0x1E2120,
        surface2: 0x272A29,
        surface3: 0x434645,
        surface4: 0x595B5B,
        surfaceSidebarHover: 0x1F2120,
        surfaceSidebarSelected: 0x282A29,
        foreground: 0xFAFAFA,
        foregroundMuted: 0xA1A5A4,
        foregroundExtraMuted: 0x717574,
        border: 0x252B2A,
        borderAccent: 0x2F3534,
        accent: 0x20744A,
        accentBright: 0x7CCBA0,
        accentForeground: 0xFFFFFF,
        destructive: 0xC64F43,
        terminalBrightBlack: 0x434645
    )

    /// Zinc — neutral monochrome gray, no tint.
    static let zinc = makeDark(
        id: .zinc,
        surfaceSidebar: 0x131316,
        surface0: 0x18181B,
        surface1: 0x1F1F22,
        surface2: 0x27272A,
        surface3: 0x3F3F46,
        surface4: 0x52525B,
        surfaceSidebarHover: 0x1E1E20,
        surfaceSidebarSelected: 0x272729,
        foreground: 0xFAFAFA,
        foregroundMuted: 0xA1A1AA,
        foregroundExtraMuted: 0x71717A,
        border: 0x27272A,
        borderAccent: 0x303036,
        accent: 0xE4E4E7,
        accentBright: 0xFAFAFA,
        accentForeground: 0x18181B,
        destructive: 0xC44A4A,
        terminalBrightBlack: 0x3F3F46
    )

    /// Midnight — subtle blue-tinted dark.
    static let midnight = makeDark(
        id: .midnight,
        surfaceSidebar: 0x121420,
        surface0: 0x161820,
        surface1: 0x1C1E27,
        surface2: 0x252731,
        surface3: 0x3C3E4C,
        surface4: 0x535564,
        surfaceSidebarHover: 0x1D1E27,
        surfaceSidebarSelected: 0x27282F,
        foreground: 0xFAFAFA,
        foregroundMuted: 0x9A9DB0,
        foregroundExtraMuted: 0x6B6E82,
        border: 0x242636,
        borderAccent: 0x2E3040,
        accent: 0x3B6FCF,
        accentBright: 0x7EAAEB,
        accentForeground: 0xFFFFFF,
        destructive: 0xC44A52,
        terminalBrightBlack: 0x3C3E4C
    )

    /// Claude — warm neutral dark with terracotta accent.
    static let claude = makeDark(
        id: .claude,
        surfaceSidebar: 0x1A1918,
        surface0: 0x1F1F1E,
        surface1: 0x262523,
        surface2: 0x2F2D2B,
        surface3: 0x4A4745,
        surface4: 0x605D5B,
        surfaceSidebarHover: 0x232222,
        surfaceSidebarSelected: 0x2C2B2B,
        foreground: 0xFAFAFA,
        foregroundMuted: 0xADA9A5,
        foregroundExtraMuted: 0x78746F,
        border: 0x2C2A27,
        borderAccent: 0x36332F,
        accent: 0xD97757,
        accentBright: 0xE89A7F,
        accentForeground: 0xFFFFFF,
        destructive: 0xCF513E,
        terminalBrightBlack: 0x4A4745
    )

    /// Ghostty — slate-blue dark matching Ghostty's default canvas.
    static let ghostty = makeDark(
        id: .ghostty,
        surfaceSidebar: 0x21252D,
        surface0: 0x282C34,
        surface1: 0x2F333D,
        surface2: 0x383C48,
        surface3: 0x4A4F5E,
        surface4: 0x5B6175,
        surfaceSidebarHover: 0x2A2D33,
        surfaceSidebarSelected: 0x32353A,
        foreground: 0xFAFAFA,
        foregroundMuted: 0xC8CCD8,
        foregroundExtraMuted: 0xA0A4B2,
        border: 0x353A47,
        borderAccent: 0x3F4454,
        accent: 0x3570E0,
        accentBright: 0xB4D0FC,
        accentForeground: 0xFFFFFF,
        destructive: 0xC44A55,
        terminalBrightBlack: 0x4A4F5E
    )

    /// Pure Black — OLED zero-luminance canvas with calibrated surface steps.
    static let pureBlack = makeDark(
        id: .pureBlack,
        surfaceSidebar: 0x000000,
        surface0: 0x000000,
        surface1: 0x0A0A0A,
        surface2: 0x181818,
        surface3: 0x202020,
        surface4: 0x2D2D2D,
        surfaceSidebarHover: 0x111111,
        surfaceSidebarSelected: 0x1D1D1D,
        foreground: 0xFAFAFA,
        foregroundMuted: 0xA1A1AA,
        foregroundExtraMuted: 0x71717A,
        border: 0x1C1C1C,
        borderAccent: 0x242424,
        accent: 0x20744A,
        accentBright: 0x7CCBA0,
        accentForeground: 0xFFFFFF,
        destructive: 0xC44A4A,
        terminalBrightBlack: 0x8A8A8A
    )

    /// Light — crisp daylight palette with Paseo emerald accent.
    static let light = RelayThemePalette(
        id: .light,
        isDark: false,
        surfaceSidebar: Color(relayHex: 0xF4F4F5),
        surface0: Color(relayHex: 0xFFFFFF),
        surface1: Color(relayHex: 0xFAFAFA),
        surface2: Color(relayHex: 0xF4F4F5),
        surface3: Color(relayHex: 0xE4E4E7),
        surface4: Color(relayHex: 0xD4D4D8),
        surfaceSidebarHover: Color(relayHex: 0xE5E5E6),
        surfaceSidebarSelected: Color(relayHex: 0xD4D4D5),
        interactionHighlight: Color.black.opacity(0.06),
        foreground: Color(relayHex: 0x1A1A1E),
        foregroundMuted: Color(relayHex: 0x71717A),
        foregroundExtraMuted: Color(relayHex: 0xA1A1AA),
        border: Color(relayHex: 0xE4E4E7),
        borderAccent: Color(relayHex: 0xECECF1),
        accent: Color(relayHex: 0x20744A),
        accentBright: Color(relayHex: 0x239956),
        accentForeground: Color(relayHex: 0xFFFFFF),
        destructive: Color(relayHex: 0xB04138),
        destructiveForeground: Color(relayHex: 0xFFFFFF),
        statusSuccess: Color(relayHex: 0x3E704A),
        statusDanger: Color(relayHex: 0x9D433B),
        statusWarning: Color(relayHex: 0x7B5D39),
        statusMerged: Color(relayHex: 0x7347AF),
        statusSuccessTint: Color(relayHex: 0x3E704A, alpha: 0.12),
        statusDangerTint: Color(relayHex: 0x9D433B, alpha: 0.12),
        statusWarningTint: Color(relayHex: 0x7B5D39, alpha: 0.12),
        statusDotSuccess: Color(relayHex: 0x299F51),
        statusDotDanger: Color(relayHex: 0xF12E2F),
        statusDotWarning: Color(relayHex: 0xB37824),
        statusDotRunning: Color(relayHex: 0x268AE0),
        diffAddition: Color(relayHex: 0x15803D),
        diffDeletion: Color(relayHex: 0xB91C1C),
        diffAdditionBg: Color(relayHex: 0x2EA043, alpha: 0.12),
        diffDeletionBg: Color(relayHex: 0xF85149, alpha: 0.10),
        diffHunkBg: Color(relayHex: 0x268AE0, alpha: 0.08),
        syntaxKeyword: Color(relayHex: 0xCF222E),
        syntaxString: Color(relayHex: 0x0A3069),
        syntaxComment: Color(relayHex: 0x6E7781),
        syntaxType: Color(relayHex: 0x953800),
        syntaxNumber: Color(relayHex: 0x0550AE),
        syntaxFunction: Color(relayHex: 0x8250DF),
        syntaxProperty: Color(relayHex: 0x0550AE),
        syntaxOperator: Color(relayHex: 0x0550AE),
        terminalBg: Color(relayHex: 0xFFFFFF),
        terminalFg: Color(relayHex: 0x1A1A1E),
        terminalCursor: Color(relayHex: 0x1A1A1E),
        terminalRed: Color(relayHex: 0xDC2626),
        terminalGreen: Color(relayHex: 0x16A34A),
        terminalYellow: Color(relayHex: 0xCA8A04),
        terminalBlue: Color(relayHex: 0x2563EB),
        terminalMagenta: Color(relayHex: 0x9333EA),
        terminalCyan: Color(relayHex: 0x0891B2),
        terminalBrightBlack: Color(relayHex: 0x3F3F46)
    )

    /// Ember — Relay's classic warm ink-and-ember palette.
    static let ember = makeDark(
        id: .ember,
        surfaceSidebar: 0x181613,
        surface0: 0x1C1B19,
        surface1: 0x232220,
        surface2: 0x2C2A27,
        surface3: 0x3F3C37,
        surface4: 0x534F49,
        surfaceSidebarHover: 0x22201D,
        surfaceSidebarSelected: 0x2B2926,
        foreground: 0xEDE8DF,
        foregroundMuted: 0x9E988F,
        foregroundExtraMuted: 0x726D65,
        border: 0x2E2B27,
        borderAccent: 0x3B3732,
        accent: 0xD4804A,
        accentBright: 0xE8965C,
        accentForeground: 0x1C1207,
        destructive: 0xC9564B,
        terminalBrightBlack: 0x534F49
    )

    private static func makeDark(
        id: RelayThemeID,
        surfaceSidebar: UInt32,
        surface0: UInt32,
        surface1: UInt32,
        surface2: UInt32,
        surface3: UInt32,
        surface4: UInt32,
        surfaceSidebarHover: UInt32,
        surfaceSidebarSelected: UInt32,
        foreground: UInt32,
        foregroundMuted: UInt32,
        foregroundExtraMuted: UInt32,
        border: UInt32,
        borderAccent: UInt32,
        accent: UInt32,
        accentBright: UInt32,
        accentForeground: UInt32,
        destructive: UInt32,
        terminalBrightBlack: UInt32
    ) -> RelayThemePalette {
        RelayThemePalette(
            id: id,
            isDark: true,
            surfaceSidebar: Color(relayHex: surfaceSidebar),
            surface0: Color(relayHex: surface0),
            surface1: Color(relayHex: surface1),
            surface2: Color(relayHex: surface2),
            surface3: Color(relayHex: surface3),
            surface4: Color(relayHex: surface4),
            surfaceSidebarHover: Color(relayHex: surfaceSidebarHover),
            surfaceSidebarSelected: Color(relayHex: surfaceSidebarSelected),
            interactionHighlight: Color.white.opacity(0.08),
            foreground: Color(relayHex: foreground),
            foregroundMuted: Color(relayHex: foregroundMuted),
            foregroundExtraMuted: Color(relayHex: foregroundExtraMuted),
            border: Color(relayHex: border),
            borderAccent: Color(relayHex: borderAccent),
            accent: Color(relayHex: accent),
            accentBright: Color(relayHex: accentBright),
            accentForeground: Color(relayHex: accentForeground),
            destructive: Color(relayHex: destructive),
            destructiveForeground: Color(relayHex: 0xFFFFFF),
            statusSuccess: Color(relayHex: 0x6CB17B),
            statusDanger: Color(relayHex: 0xD8847B),
            statusWarning: Color(relayHex: 0xC09664),
            statusMerged: Color(relayHex: 0xA890D5),
            statusSuccessTint: Color(relayHex: 0x6CB17B, alpha: 0.16),
            statusDangerTint: Color(relayHex: 0xD8847B, alpha: 0.16),
            statusWarningTint: Color(relayHex: 0xC09664, alpha: 0.16),
            statusDotSuccess: Color(relayHex: 0x35C264),
            statusDotDanger: Color(relayHex: 0xF7796D),
            statusDotWarning: Color(relayHex: 0xDB932E),
            statusDotRunning: Color(relayHex: 0x5CAAF6),
            diffAddition: Color(relayHex: 0x4ADE80),
            diffDeletion: Color(relayHex: 0xEF4444),
            diffAdditionBg: Color(relayHex: 0x2EA043, alpha: 0.15),
            diffDeletionBg: Color(relayHex: 0xF85149, alpha: 0.10),
            diffHunkBg: Color(relayHex: 0x5CAAF6, alpha: 0.10),
            syntaxKeyword: Color(relayHex: 0xFF7B72),
            syntaxString: Color(relayHex: 0xA5D6FF),
            syntaxComment: Color(relayHex: 0x8B949E),
            syntaxType: Color(relayHex: 0xFFA657),
            syntaxNumber: Color(relayHex: 0x79C0FF),
            syntaxFunction: Color(relayHex: 0xD2A8FF),
            syntaxProperty: Color(relayHex: 0x79C0FF),
            syntaxOperator: Color(relayHex: 0x79C0FF),
            terminalBg: Color(relayHex: surface0),
            terminalFg: Color(relayHex: foreground),
            terminalCursor: Color(relayHex: foreground),
            terminalRed: Color(relayHex: 0xE07070),
            terminalGreen: Color(relayHex: 0x5DBA80),
            terminalYellow: Color(relayHex: 0xD4A44A),
            terminalBlue: Color(relayHex: 0x6A9DE0),
            terminalMagenta: Color(relayHex: 0xB07AD0),
            terminalCyan: Color(relayHex: 0x4AABB8),
            terminalBrightBlack: Color(relayHex: terminalBrightBlack)
        )
    }
}

// MARK: - Theme Store

@MainActor
final class RelayThemeStore: ObservableObject {
    static let shared = RelayThemeStore()

    static let interfaceFontSizeOptions: [CGFloat] = [14, 15, 16]
    static let codeFontSizeRange: ClosedRange<CGFloat> = 11...15

    private enum Keys {
        static let selectedTheme = "com.parikshit.pocvault.theme.selected"
        static let interfaceFontSize = "com.parikshit.pocvault.theme.interfaceFontSize"
        static let codeFontSize = "com.parikshit.pocvault.theme.codeFontSize"
        static let sendWhileRunning = "com.parikshit.pocvault.theme.sendWhileRunning"
    }

    private let defaults: UserDefaults
    private let updatesSharedTypography: Bool

    @Published var selectedTheme: RelayThemeID {
        didSet {
            defaults.set(selectedTheme.rawValue, forKey: Keys.selectedTheme)
        }
    }

    @Published var interfaceFontSize: CGFloat {
        didSet {
            let clamped = Self.normalizedInterfaceFontSize(interfaceFontSize)
            if clamped != interfaceFontSize {
                interfaceFontSize = clamped
                return
            }
            defaults.set(Double(clamped), forKey: Keys.interfaceFontSize)
            if updatesSharedTypography {
                RelayThemeTypographyState.shared.setInterfaceFontSize(clamped)
            }
        }
    }

    @Published var codeFontSize: CGFloat {
        didSet {
            let clamped = Self.normalizedCodeFontSize(codeFontSize)
            if clamped != codeFontSize {
                codeFontSize = clamped
                return
            }
            defaults.set(Double(clamped), forKey: Keys.codeFontSize)
            if updatesSharedTypography {
                RelayThemeTypographyState.shared.setCodeFontSize(clamped)
            }
        }
    }

    @Published var sendWhileRunning: RelaySendWhileRunningBehavior {
        didSet {
            defaults.set(sendWhileRunning.rawValue, forKey: Keys.sendWhileRunning)
        }
    }

    var palette: RelayThemePalette {
        RelayThemePalette.palette(for: selectedTheme)
    }

    var colorScheme: ColorScheme {
        palette.colorScheme
    }

    var interfaceScale: CGFloat {
        interfaceFontSize / 15.0
    }

    var contentFontSize: CGFloat {
        (16.0 * interfaceScale).rounded()
    }

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.updatesSharedTypography = (defaults === UserDefaults.standard)

        if let rawTheme = defaults.string(forKey: Keys.selectedTheme),
           let restored = RelayThemeID(rawValue: rawTheme) {
            self.selectedTheme = restored
        } else {
            self.selectedTheme = .paseoDark
        }

        if defaults.object(forKey: Keys.interfaceFontSize) != nil {
            let stored = CGFloat(defaults.double(forKey: Keys.interfaceFontSize))
            self.interfaceFontSize = Self.normalizedInterfaceFontSize(stored)
        } else {
            self.interfaceFontSize = 15
        }

        if defaults.object(forKey: Keys.codeFontSize) != nil {
            let stored = CGFloat(defaults.double(forKey: Keys.codeFontSize))
            self.codeFontSize = Self.normalizedCodeFontSize(stored)
        } else {
            self.codeFontSize = 12
        }

        if let rawBehavior = defaults.string(forKey: Keys.sendWhileRunning),
           let restored = RelaySendWhileRunningBehavior(rawValue: rawBehavior) {
            self.sendWhileRunning = restored
        } else {
            self.sendWhileRunning = .steer
        }

        if updatesSharedTypography {
            RelayThemeTypographyState.shared.setInterfaceFontSize(self.interfaceFontSize)
            RelayThemeTypographyState.shared.setCodeFontSize(self.codeFontSize)
        }
    }

    private static func normalizedInterfaceFontSize(_ size: CGFloat) -> CGFloat {
        interfaceFontSizeOptions.min(by: { abs($0 - size) < abs($1 - size) }) ?? 15
    }

    private static func normalizedCodeFontSize(_ size: CGFloat) -> CGFloat {
        min(max(size.rounded(), codeFontSizeRange.lowerBound), codeFontSizeRange.upperBound)
    }
}

/// Thread-safe snapshot of the active typography scale so `RelayTheme` font helpers
/// can be called cleanly from any view body without requiring MainActor annotations.
private final class RelayThemeTypographyState: @unchecked Sendable {
    static let shared = RelayThemeTypographyState()

    private let lock = NSLock()
    private var _interfaceFontSize: CGFloat = 15
    private var _codeFontSize: CGFloat = 12

    var interfaceScale: CGFloat {
        lock.lock()
        defer { lock.unlock() }
        return _interfaceFontSize / 15.0
    }

    var codeScale: CGFloat {
        lock.lock()
        defer { lock.unlock() }
        return _codeFontSize / 12.0
    }

    func setInterfaceFontSize(_ size: CGFloat) {
        lock.lock()
        _interfaceFontSize = size
        lock.unlock()
    }

    func setCodeFontSize(_ size: CGFloat) {
        lock.lock()
        _codeFontSize = size
        lock.unlock()
    }
}

// MARK: - SwiftUI Environment & Typography Helpers

private struct RelayThemeEnvironmentKey: EnvironmentKey {
    static let defaultValue: RelayThemePalette = .paseoDark
}

extension EnvironmentValues {
    var relayTheme: RelayThemePalette {
        get { self[RelayThemeEnvironmentKey.self] }
        set { self[RelayThemeEnvironmentKey.self] = newValue }
    }
}

extension View {
    func relayTheme(_ palette: RelayThemePalette) -> some View {
        environment(\.relayTheme, palette)
    }

    @MainActor
    func relayThemeStore(_ store: RelayThemeStore) -> some View {
        self
            .environment(\.relayTheme, store.palette)
            .environmentObject(store)
            .preferredColorScheme(store.colorScheme)
    }
}

enum RelayTheme {
    /// Interface typography (SF Pro), proportionally scaled by the user's Interface Size setting.
    static func uiFont(_ size: CGFloat = 15, weight: Font.Weight = .regular) -> Font {
        let scaled = (size * RelayThemeTypographyState.shared.interfaceScale * 2).rounded() / 2
        return Font(UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: scaled))).weight(weight)
    }

    /// Primary readable content typography (message bodies, composer input, Markdown prose).
    static func contentFont(_ size: CGFloat = 16, weight: Font.Weight = .regular) -> Font {
        let scaled = (size * RelayThemeTypographyState.shared.interfaceScale * 2).rounded() / 2
        return Font(UIFontMetrics.default.scaledFont(for: UIFont.systemFont(ofSize: scaled))).weight(weight)
    }

    /// Monospace typography (code, diffs, terminal, tabular counters), scaled by the user's Code Size setting.
    static func monoFont(_ size: CGFloat = 12, weight: Font.Weight = .regular) -> Font {
        let scaled = (size * RelayThemeTypographyState.shared.codeScale * 2).rounded() / 2
        return Font(UIFontMetrics.default.scaledFont(for: UIFont.monospacedSystemFont(ofSize: scaled, weight: .regular))).weight(weight)
    }
}

// MARK: - Deterministic Identity Colors (Paseo identity-colors.ts)

/// Fixed ten-color identity palette held to one contrast band (4.2–4.8:1 against white text)
/// so identity color distinguishes projects and hosts without ranking them.
///
/// Order is load-bearing — reordering changes deterministic assignments.
enum RelayIdentityColor {
    static let names: [String] = [
        "Violet",
        "Sky",
        "Emerald",
        "Orange",
        "Pink",
        "Indigo",
        "Teal",
        "Red",
        "Amber",
        "Blue"
    ]

    private static let fillHexes: [UInt32] = [
        0x7A6AA8, // violet
        0x3D7EA6, // sky
        0x388068, // emerald
        0xA4673A, // orange
        0xB05C80, // pink
        0x6A70B8, // indigo
        0x368080, // teal
        0xB06260, // red
        0x8F7838, // amber
        0x5179B0  // blue
    ]

    private static let foregroundLightHexes: [UInt32] = [
        0x6D49B5, // violet
        0x3D6985, // sky
        0x3E6E5D, // emerald
        0x845838, // orange
        0x974168, // pink
        0x5251C2, // indigo
        0x3E6D6C, // teal
        0x9C4243, // red
        0x716239, // amber
        0x39649E  // blue
    ]

    private static let foregroundDarkHexes: [UInt32] = [
        0xA392D5, // violet
        0x6AA6CE, // sky
        0x6CAE96, // emerald
        0xCC8F64, // orange
        0xD87DA3, // pink
        0x9299D5, // indigo
        0x6CACAB, // teal
        0xD88381, // red
        0xB29D64, // amber
        0x7BA1D5  // blue
    ]

    static var count: Int { fillHexes.count }

    /// Deterministic hash matching Paseo's `hashIdentityKey` (31-multiplier over UTF-16 code units).
    static func index(for seed: String) -> Int {
        var hash: UInt32 = 0
        for unit in seed.utf16 {
            hash = hash &* 31 &+ UInt32(unit)
        }
        return Int(hash % UInt32(fillHexes.count))
    }

    static func color(at index: Int) -> Color {
        Color(relayHex: fillHexes[normalizedIndex(index)])
    }

    static func color(for seed: String) -> Color {
        color(at: index(for: seed))
    }

    /// Scheme-calibrated foreground color for host badges painted directly over a sidebar or row surface.
    static func foregroundColor(at index: Int, isDark: Bool) -> Color {
        let idx = normalizedIndex(index)
        let hex = isDark ? foregroundDarkHexes[idx] : foregroundLightHexes[idx]
        return Color(relayHex: hex)
    }

    static func foregroundColor(for seed: String, isDark: Bool) -> Color {
        foregroundColor(at: index(for: seed), isDark: isDark)
    }

    /// 10% alpha fill matching Paseo's `identityTint`.
    static func tintColor(at index: Int) -> Color {
        Color(relayHex: fillHexes[normalizedIndex(index)], alpha: 0.10)
    }

    static func tintColor(for seed: String) -> Color {
        tintColor(at: index(for: seed))
    }

    private static func normalizedIndex(_ index: Int) -> Int {
        let count = fillHexes.count
        return ((index % count) + count) % count
    }
}
