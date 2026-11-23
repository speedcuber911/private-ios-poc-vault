import Foundation
import SwiftUI
import UIKit

// MARK: - Streaming Markdown Block Splitter

/// Splits an in-flight Markdown string into a stable closed-block prefix and a
/// small live tail block so 60Hz paced streaming only re-parses the active final
/// paragraph rather than re-parsing the entire message on every tick.
enum RelayStreamingMarkdownSplitter {
    struct Split: Equatable {
        let stablePrefix: String
        let liveTail: String
    }

    static func split(_ markdown: String) -> Split {
        guard !markdown.isEmpty else {
            return Split(stablePrefix: "", liveTail: "")
        }

        // Scan lines tracking fenced code blocks (``` or ~~~) and record the
        // character offset of the last blank line outside any open fence or table.
        var inFence = false
        var fenceChar: Character = "`"
        var fenceCount = 0

        var lastSafeSplitIndex: String.Index?
        var lineStart = markdown.startIndex

        while lineStart < markdown.endIndex {
            let lineEnd = markdown[lineStart...].firstIndex(of: "\n") ?? markdown.endIndex
            let nextLineStart = lineEnd < markdown.endIndex ? markdown.index(after: lineEnd) : markdown.endIndex
            let rawLine = markdown[lineStart..<lineEnd]
            let trimmed = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)

            if let fence = fenceDescriptor(for: trimmed) {
                if !inFence {
                    inFence = true
                    fenceChar = fence.char
                    fenceCount = fence.count
                } else if fence.char == fenceChar && fence.count >= fenceCount && fence.isClosing {
                    inFence = false
                }
            } else if !inFence, trimmed.isEmpty, nextLineStart < markdown.endIndex {
                // A blank line outside a code fence cleanly closes the preceding block.
                lastSafeSplitIndex = nextLineStart
            }

            lineStart = nextLineStart
        }

        // Do not split if we never found a closed block boundary, or if the
        // prefix would be trivially empty.
        guard let splitIndex = lastSafeSplitIndex else {
            return Split(stablePrefix: "", liveTail: markdown)
        }

        let prefix = String(markdown[..<splitIndex]).trimmingCharacters(in: .newlines)
        let tail = String(markdown[splitIndex...])
        if prefix.isEmpty {
            return Split(stablePrefix: "", liveTail: markdown)
        }
        return Split(stablePrefix: prefix, liveTail: tail)
    }

    private struct FenceDescriptor {
        let char: Character
        let count: Int
        let isClosing: Bool
    }

    private static func fenceDescriptor(for trimmedLine: String) -> FenceDescriptor? {
        guard let first = trimmedLine.first, first == "`" || first == "~" else { return nil }
        let count = trimmedLine.prefix { $0 == first }.count
        guard count >= 3 else { return nil }
        let remainder = trimmedLine.dropFirst(count).trimmingCharacters(in: .whitespaces)
        return FenceDescriptor(char: first, count: count, isClosing: remainder.isEmpty)
    }
}

// MARK: - Backlog-Adaptive Pacing Controller

/// Drives smooth 60Hz character reveal while a turn is streaming, adapting speed
/// to the pending backlog so bursty SSE chunks glide fluidly instead of jumping
/// in jagged lumps. Snaps immediately when streaming finishes or Reduce Motion
/// is enabled.
@MainActor
final class RelayStreamRevealController: ObservableObject {
    @Published private(set) var revealedCount: Int

    private var targetText: String
    private var targetCount: Int
    private var isStreaming: Bool
    private var isSceneActive: Bool = true
    private var reduceMotion: Bool = false
    private var tickTask: Task<Void, Never>?

    /// Hydrating an existing long turn (> 48 chars) starts caught up so returning
    /// to an in-progress chat never awkwardly re-types earlier paragraphs.
    private static let initialHydrationThreshold = 48
    /// 60Hz pacing tick (~16ms).
    private static let frameIntervalNanoseconds: UInt64 = 16_000_000

    init(initialText: String, isStreaming: Bool) {
        self.targetText = initialText
        let count = initialText.count
        self.targetCount = count
        self.isStreaming = isStreaming
        if !isStreaming || count > Self.initialHydrationThreshold {
            self.revealedCount = count
        } else {
            self.revealedCount = 0
        }
    }

    deinit {
        tickTask?.cancel()
    }

    func sync(target: String, isStreaming: Bool, reduceMotion: Bool, isSceneActive: Bool) {
        self.targetText = target
        let count = target.count
        self.targetCount = count
        self.isStreaming = isStreaming
        self.reduceMotion = reduceMotion
        self.isSceneActive = isSceneActive

        if !isStreaming || reduceMotion {
            stopTicking()
            if revealedCount != count {
                revealedCount = count
            }
            return
        }

        if count < revealedCount {
            revealedCount = count
        }

        if revealedCount < count && isSceneActive {
            startTickingIfNeeded()
        } else {
            stopTicking()
        }
    }

    func stop() {
        stopTicking()
    }

    /// Adaptive characters-per-16ms-frame curve derived from backlog size.
    static func charactersPerTick(backlog: Int) -> Int {
        switch backlog {
        case ...0:
            return 0
        case 1...12:
            return 1
        case 13...40:
            return max(2, backlog / 10)
        case 41...160:
            return max(4, backlog / 7)
        case 161...600:
            return max(16, backlog / 5)
        default:
            return max(48, backlog / 4)
        }
    }

    private func startTickingIfNeeded() {
        guard tickTask == nil else { return }
        tickTask = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                guard self.isStreaming, !self.reduceMotion, self.isSceneActive else {
                    self.tickTask = nil
                    return
                }
                let backlog = self.targetCount - self.revealedCount
                guard backlog > 0 else {
                    self.tickTask = nil
                    return
                }
                let step = Self.charactersPerTick(backlog: backlog)
                self.revealedCount = min(self.targetCount, self.revealedCount + max(1, step))
                if self.revealedCount >= self.targetCount {
                    self.tickTask = nil
                    return
                }
                do {
                    try await Task.sleep(nanoseconds: Self.frameIntervalNanoseconds)
                } catch {
                    self.tickTask = nil
                    return
                }
            }
        }
    }

    private func stopTicking() {
        tickTask?.cancel()
        tickTask = nil
    }
}

// MARK: - RelayPacedRevealText

/// Paced streaming markdown text matching Paseo's smooth character reveal:
/// - Finished turns (`isStreaming == false`) render full text immediately with zero delay.
/// - Active turns (`isStreaming == true`) pace newly arrived characters at 60Hz
///   and split closed Markdown blocks into an Equatable memoized prefix so only
///   the trailing active paragraph re-parses each tick.
struct RelayPacedRevealText: View {
    let text: String
    let isStreaming: Bool
    var onOpenLoopbackURL: ((URL) -> Void)? = nil
    var bodyFont: Font? = nil
    var hidesLocalPreviewURLs: Bool = true

    @Environment(\.relayTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var controller: RelayStreamRevealController

    init(
        text: String,
        isStreaming: Bool,
        onOpenLoopbackURL: ((URL) -> Void)? = nil,
        bodyFont: Font? = nil,
        hidesLocalPreviewURLs: Bool = true
    ) {
        self.text = text
        self.isStreaming = isStreaming
        self.onOpenLoopbackURL = onOpenLoopbackURL
        self.bodyFont = bodyFont
        self.hidesLocalPreviewURLs = hidesLocalPreviewURLs
        let normalized = hidesLocalPreviewURLs
            ? relaySharedContract.displayTextHidingLocalPreviewURLs(value: text)
            : text
        _controller = StateObject(
            wrappedValue: RelayStreamRevealController(
                initialText: normalized,
                isStreaming: isStreaming
            )
        )
    }

    private var normalizedTarget: String {
        hidesLocalPreviewURLs
            ? relaySharedContract.displayTextHidingLocalPreviewURLs(value: text)
            : text
    }

    private var visibleText: String {
        let target = normalizedTarget
        guard isStreaming, !reduceMotion else { return target }
        let count = target.count
        let revealed = min(max(0, controller.revealedCount), count)
        if revealed >= count { return target }
        if revealed == 0 { return "" }
        // O(backlog) slice from the trailing end when close to caught up.
        let remaining = count - revealed
        if remaining < revealed,
           let endIndex = target.index(target.endIndex, offsetBy: -remaining, limitedBy: target.startIndex) {
            return String(target[..<endIndex])
        }
        return String(target.prefix(revealed))
    }

    private var resolvedBodyFont: Font {
        bodyFont ?? RelayTheme.contentFont(16)
    }

    var body: some View {
        let shown = visibleText
        Group {
            if isStreaming {
                let split = RelayStreamingMarkdownSplitter.split(shown)
                if !split.stablePrefix.isEmpty {
                    VStack(alignment: .leading, spacing: 14) {
                        RelayPaseoMarkdownView(
                            text: split.stablePrefix,
                            theme: theme,
                            bodyFont: resolvedBodyFont,
                            onOpenLoopbackURL: onOpenLoopbackURL
                        )
                        .equatable()

                        if !split.liveTail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                            RelayPaseoMarkdownView(
                                text: split.liveTail,
                                theme: theme,
                                bodyFont: resolvedBodyFont,
                                onOpenLoopbackURL: onOpenLoopbackURL
                            )
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                } else if !shown.isEmpty {
                    RelayPaseoMarkdownView(
                        text: shown,
                        theme: theme,
                        bodyFont: resolvedBodyFont,
                        onOpenLoopbackURL: onOpenLoopbackURL
                    )
                }
            } else {
                RelayPaseoMarkdownView(
                    text: shown,
                    theme: theme,
                    bodyFont: resolvedBodyFont,
                    onOpenLoopbackURL: onOpenLoopbackURL
                )
                .equatable()
            }
        }
        .onAppear {
            controller.sync(
                target: normalizedTarget,
                isStreaming: isStreaming,
                reduceMotion: reduceMotion,
                isSceneActive: scenePhase == .active
            )
        }
        .onChange(of: text) { _, _ in
            controller.sync(
                target: normalizedTarget,
                isStreaming: isStreaming,
                reduceMotion: reduceMotion,
                isSceneActive: scenePhase == .active
            )
        }
        .onChange(of: isStreaming) { _, streaming in
            controller.sync(
                target: normalizedTarget,
                isStreaming: streaming,
                reduceMotion: reduceMotion,
                isSceneActive: scenePhase == .active
            )
        }
        .onChange(of: scenePhase) { _, phase in
            controller.sync(
                target: normalizedTarget,
                isStreaming: isStreaming,
                reduceMotion: reduceMotion,
                isSceneActive: phase == .active
            )
        }
        .onDisappear {
            controller.stop()
        }
    }
}

// MARK: - Paseo-Styled Markdown Renderer

/// Renders assistant Markdown on Relay's themed `surface0` canvas with crisp
/// `surface2` inline code chips (`SF Mono`), syntax-highlighted fenced code
/// blocks via `RelaySyntaxHighlighter`, and clean mobile-native tables.
struct RelayPaseoMarkdownView: View, Equatable {
    let text: String
    let theme: RelayThemePalette
    var bodyFont: Font = RelayTheme.contentFont(16)
    var onOpenLoopbackURL: ((URL) -> Void)? = nil

    @State private var blockedLoopbackURL: URL?
    @State private var memo = RelayMarkdownMemo<[CodexMarkdownSegment]>()

    static func == (lhs: RelayPaseoMarkdownView, rhs: RelayPaseoMarkdownView) -> Bool {
        lhs.text == rhs.text && lhs.theme == rhs.theme
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            let segments = memo.value(for: text, CodexMarkdownParser.segments(from:))
            ForEach(segments.indices, id: \.self) { index in
                let segment = segments[index]
                switch segment.kind {
                case .prose:
                    RelayPaseoProseView(
                        text: segment.text,
                        theme: theme,
                        bodyFont: bodyFont
                    )
                    .equatable()
                case .code(let language):
                    RelayPaseoCodeBlock(
                        text: segment.text,
                        language: language,
                        theme: theme
                    )
                    .equatable()
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .environment(\.openURL, OpenURLAction { url in
            guard RelayOutputURLPolicy.isLoopbackURL(url) else {
                return .systemAction
            }
            if let onOpenLoopbackURL {
                onOpenLoopbackURL(url)
                return .handled
            }
            blockedLoopbackURL = url
            return .handled
        })
        .alert(
            "Local preview is on the linked computer",
            isPresented: Binding(
                get: { blockedLoopbackURL != nil },
                set: { if !$0 { blockedLoopbackURL = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text("This localhost URL was not attached to a Relay task, so Relay cannot prove which linked computer should serve it.")
        }
    }
}

private struct RelayPaseoProseView: View, Equatable {
    let text: String
    let theme: RelayThemePalette
    let bodyFont: Font
    @State private var memo = RelayMarkdownMemo<[CodexMarkdownProseBlock]>()

    static func == (lhs: RelayPaseoProseView, rhs: RelayPaseoProseView) -> Bool {
        lhs.text == rhs.text && lhs.theme == rhs.theme
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 11) {
            let blocks = memo.value(for: text, CodexMarkdownParser.proseBlocks(from:))
            ForEach(blocks.indices, id: \.self) { index in
                let block = blocks[index]
                switch block.kind {
                case .heading(let level):
                    Text(RelayPaseoInlineMarkdown.attributed(block.text, theme: theme))
                        .font(headingFont(for: level))
                        .foregroundStyle(theme.foreground)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.top, level <= 2 ? 4 : 2)
                case .paragraph:
                    Text(RelayPaseoInlineMarkdown.attributed(block.text, theme: theme))
                        .font(bodyFont)
                        .foregroundStyle(theme.foreground)
                        .lineSpacing(4)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                case .bullet:
                    listRow(marker: "•", text: block.text)
                case .numbered(let number):
                    listRow(marker: "\(number).", text: block.text)
                case .table(let header, let rows):
                    RelayPaseoMarkdownTable(header: header, rows: rows, theme: theme)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func listRow(marker: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 9) {
            Text(marker)
                .font(bodyFont)
                .foregroundStyle(theme.foregroundExtraMuted)
                .monospacedDigit()
                .frame(minWidth: 10, alignment: .leading)
            Text(RelayPaseoInlineMarkdown.attributed(text, theme: theme))
                .font(bodyFont)
                .foregroundStyle(theme.foreground)
                .lineSpacing(4)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
        .padding(.leading, 4)
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1: return RelayTheme.uiFont(20, weight: .semibold)
        case 2: return RelayTheme.uiFont(18, weight: .semibold)
        case 3: return RelayTheme.uiFont(16, weight: .semibold)
        default: return RelayTheme.uiFont(15, weight: .semibold)
        }
    }
}

/// Inline Markdown styler that renders Paseo's signature crisp inline code chips
/// (`surface2` fill, `SF Mono`, subtle hair-space horizontal breathing room)
/// and detects bare links while caching results per `(theme, text)`.
enum RelayPaseoInlineMarkdown {
    private static let linkDetector = try? NSDataDetector(
        types: NSTextCheckingResult.CheckingType.link.rawValue
    )

    private final class CachedEntry: NSObject {
        let value: AttributedString
        init(_ value: AttributedString) { self.value = value }
    }

    private static let cache: NSCache<NSString, CachedEntry> = {
        let cache = NSCache<NSString, CachedEntry>()
        cache.countLimit = 1024
        cache.totalCostLimit = 1_500_000
        return cache
    }()

    static func attributed(_ value: String, theme: RelayThemePalette) -> AttributedString {
        let key = "\(theme.id.rawValue)|\(value)" as NSString
        if let cached = cache.object(forKey: key) {
            return cached.value
        }
        let parsed = parse(value, theme: theme)
        cache.setObject(CachedEntry(parsed), forKey: key, cost: key.length)
        return parsed
    }

    private static func parse(_ value: String, theme: RelayThemePalette) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        let raw = (try? AttributedString(markdown: value, options: options))
            ?? AttributedString(value)

        // Rebuild with crisp inline code chips: `surface2` fill + SF Mono + thin
        // leading/trailing hair spaces so chips breathe optically inside prose.
        var styled = AttributedString()
        let codeFont = RelayTheme.monoFont(14, weight: .regular)
        let pad = "\u{200A}"

        for run in raw.runs {
            var slice = AttributedString(raw[run.range])
            if run.inlinePresentationIntent?.contains(.code) == true {
                var chip = AttributedString(pad)
                chip.append(slice)
                chip.append(AttributedString(pad))
                chip.font = codeFont
                chip.foregroundColor = theme.foreground
                chip.backgroundColor = theme.surface2
                styled.append(chip)
            } else {
                if run.link != nil {
                    slice.foregroundColor = theme.accentBright
                }
                styled.append(slice)
            }
        }

        // Attach link attributes for bare URLs (including localhost previews).
        let plainText = String(styled.characters)
        if let detector = linkDetector {
            let fullRange = NSRange(plainText.startIndex..<plainText.endIndex, in: plainText)
            for match in detector.matches(in: plainText, options: [], range: fullRange) {
                guard let url = match.url,
                      let stringRange = Range(match.range, in: plainText),
                      let lower = AttributedString.Index(stringRange.lowerBound, within: styled),
                      let upper = AttributedString.Index(stringRange.upperBound, within: styled) else {
                    continue
                }
                let range = lower..<upper
                guard styled[range].runs.allSatisfy({ $0.link == nil }) else { continue }
                styled[range].link = url
                styled[range].foregroundColor = theme.accentBright
            }
        }

        return styled
    }
}

private struct RelayPaseoMarkdownTable: View {
    let header: [String]
    let rows: [[String]]
    let theme: RelayThemePalette

    private var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    private var displayRows: [[String]] {
        rows.filter { row in row.contains { $0.trimmedNonEmpty != nil } }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if columnCount == 1, let title = header.first?.trimmedNonEmpty {
                Text(RelayPaseoInlineMarkdown.attributed(title, theme: theme))
                    .font(RelayTheme.uiFont(12, weight: .medium))
                    .foregroundStyle(theme.foregroundMuted)
                    .padding(.horizontal, 12)
                    .padding(.top, 10)
                    .padding(.bottom, 8)
            }

            ForEach(Array(displayRows.enumerated()), id: \.offset) { index, row in
                if index > 0 || (columnCount == 1 && header.first?.trimmedNonEmpty != nil) {
                    Rectangle().fill(theme.border).frame(height: 1)
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(nonEmptyCells(in: row).enumerated()), id: \.offset) { _, cell in
                        VStack(alignment: .leading, spacing: 3) {
                            if columnCount > 1, let label = headerLabel(at: cell.column) {
                                Text(RelayPaseoInlineMarkdown.attributed(label, theme: theme))
                                    .font(RelayTheme.uiFont(11, weight: .medium))
                                    .foregroundStyle(theme.foregroundMuted)
                            }
                            Text(RelayPaseoInlineMarkdown.attributed(cell.value, theme: theme))
                                .font(RelayTheme.uiFont(14, weight: .regular))
                                .foregroundStyle(theme.foreground)
                                .lineSpacing(2)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .textSelection(.enabled)
    }

    private func nonEmptyCells(in row: [String]) -> [(column: Int, value: String)] {
        row.enumerated().compactMap { index, value in
            guard value.trimmedNonEmpty != nil else { return nil }
            return (index, value)
        }
    }

    private func headerLabel(at index: Int) -> String? {
        guard header.indices.contains(index) else { return nil }
        return header[index].trimmedNonEmpty
    }
}

private struct RelayPaseoCodeBlock: View, Equatable {
    let text: String
    let language: String?
    let theme: RelayThemePalette

    @State private var copied = false
    @State private var showingFullCode = false

    static func == (lhs: RelayPaseoCodeBlock, rhs: RelayPaseoCodeBlock) -> Bool {
        lhs.text == rhs.text && lhs.language == rhs.language && lhs.theme == rhs.theme
    }

    private var lineCount: Int {
        text.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text(language?.trimmedNonEmpty ?? "code")
                    .font(RelayTheme.monoFont(11, weight: .medium))
                    .foregroundStyle(theme.foregroundExtraMuted)
                    .lineLimit(1)

                Spacer(minLength: 8)

                if lineCount > 24 {
                    Button {
                        showingFullCode = true
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(theme.foregroundMuted)
                            .frame(width: 28, height: 28)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Expand code")
                }

                Button {
                    UIPasteboard.general.string = text
                    copied = true
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(copied ? theme.statusSuccess : theme.foregroundMuted)
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Copied code" : "Copy code")
                .task(id: copied) {
                    guard copied else { return }
                    try? await Task.sleep(for: .seconds(1.8))
                    copied = false
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)

            Rectangle()
                .fill(theme.border)
                .frame(height: 1)

            Text(RelaySyntaxHighlighter.highlightBlock(text, languageOrPath: language ?? "", theme: theme))
                .font(RelayTheme.monoFont(12, weight: .regular))
                .lineSpacing(4)
                .textSelection(.enabled)
                .lineLimit(26)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
        }
        .background(theme.surface1, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(theme.border, lineWidth: 1)
        }
        .sheet(isPresented: $showingFullCode) {
            RelayTextSelectionSheet(text: text, monospaced: true)
        }
    }
}
