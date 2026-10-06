import SwiftUI
import UIKit

/// Shared Relay markdown rendering surface.
///
/// Promoted verbatim out of `RelayChatView.swift` (revamp I3) so the chat transcript and
/// the read-only file viewer render markdown identically. `RelayMarkdownText` is the
/// entry point: it splits text into prose/code segments via `CodexMarkdownParser` and
/// delegates to `RelayMarkdownProse` (headings, lists, tables) and `RelayCodeBlock`.
struct RelayMarkdownText: View {
    let text: String
    let userAligned: Bool
    let onOpenLoopbackURL: ((URL) -> Void)?
    let bodyFont: Font
    @State private var blockedLoopbackURL: URL?
    /// The parse survives body passes: a transcript re-evaluates every visible
    /// message on each streamed token, and only the one that grew parses again.
    @State private var memo = RelayMarkdownMemo<[CodexMarkdownSegment]>()

    init(
        text: String,
        userAligned: Bool,
        onOpenLoopbackURL: ((URL) -> Void)? = nil,
        bodyFont: Font = AppTheme.uiFont(size: 14)
    ) {
        self.text = text
        self.userAligned = userAligned
        self.onOpenLoopbackURL = onOpenLoopbackURL
        self.bodyFont = bodyFont
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Text only ever grows at its end, so a segment's position is its
            // identity: earlier segments keep their views and, being equatable,
            // are skipped while the last one streams.
            let segments = segments
            ForEach(segments.indices, id: \.self) { index in
                let segment = segments[index]
                switch segment.kind {
                case .prose:
                    RelayMarkdownProse(
                        text: segment.text,
                        color: userAligned ? AppTheme.onEmber : AppTheme.textPrimary,
                        isOnAccent: userAligned,
                        bodyFont: bodyFont
                    )
                    .equatable()
                case .code(let language):
                    RelayCodeBlock(text: segment.text, language: language)
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

    private var segments: [CodexMarkdownSegment] {
        memo.value(for: text, CodexMarkdownParser.segments(from:))
    }
}

/// Holds the last parse of a markdown view's text. A reference in `@State`, so
/// reading it in `body` neither copies the result nor invalidates the view.
final class RelayMarkdownMemo<Value> {
    private var text: String?
    private var value: Value?

    func value(for text: String, _ parse: (String) -> Value) -> Value {
        if let value, self.text == text { return value }
        let parsed = parse(text)
        self.text = text
        value = parsed
        return parsed
    }
}

/// Output links are evaluated on the phone. Loopback therefore never reaches a process
/// running on the linked Mac/EC2 machine and must not silently open as if it did.
enum RelayOutputURLPolicy {
    static func isLoopbackURL(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "http" || url.scheme?.lowercased() == "https" else {
            return false
        }
        switch url.host?.lowercased() {
        case "localhost", "127.0.0.1", "::1":
            return true
        default:
            return false
        }
    }

    static func containsLoopbackURL(in text: String) -> Bool {
        !loopbackURLs(in: text).isEmpty
    }

    static func loopbackURLs(in text: String) -> [URL] {
        guard let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else {
            return []
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var seen = Set<String>()
        return detector.matches(in: text, options: [], range: range).compactMap { match in
            guard
                let swiftRange = Range(match.range, in: text),
                let url = URL(string: String(text[swiftRange]).trimmingCharacters(in: CharacterSet(charactersIn: "`"))),
                isLoopbackURL(url),
                seen.insert(url.absoluteString).inserted
            else {
                return nil
            }
            return url
        }
    }
}

struct RelayMarkdownProse: View, Equatable {
    let text: String
    let color: Color
    let isOnAccent: Bool
    var bodyFont: Font = AppTheme.uiFont(size: 14)
    @State private var memo = RelayMarkdownMemo<[CodexMarkdownProseBlock]>()

    static func == (lhs: RelayMarkdownProse, rhs: RelayMarkdownProse) -> Bool {
        lhs.text == rhs.text
            && lhs.color == rhs.color
            && lhs.isOnAccent == rhs.isOnAccent
            && lhs.bodyFont == rhs.bodyFont
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            let blocks = blocks
            ForEach(blocks.indices, id: \.self) { index in
                let block = blocks[index]
                switch block.kind {
                case .heading(let level):
                    Text(inlineMarkdown(block.text))
                        .font(headingFont(for: level))
                        .foregroundStyle(color)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(.top, level <= 2 ? 2 : 0)
                case .paragraph:
                    Text(inlineMarkdown(block.text))
                        .font(bodyFont)
                        .foregroundStyle(color)
                        .lineSpacing(3)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                case .bullet:
                    listRow(marker: "•", text: block.text)
                case .numbered(let index):
                    listRow(marker: "\(index).", text: block.text)
                case .table(let header, let rows):
                    RelayMarkdownTable(header: header, rows: rows, color: color, isOnAccent: isOnAccent)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var blocks: [CodexMarkdownProseBlock] {
        memo.value(for: text, CodexMarkdownParser.proseBlocks(from:))
    }

    private func listRow(marker: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text(marker)
                .font(AppTheme.uiFont(size: 13, weight: .semibold))
                .foregroundStyle(color.opacity(0.78))
                .frame(width: 22, alignment: .trailing)
            Text(inlineMarkdown(text))
                .font(bodyFont)
                .foregroundStyle(color)
                .lineSpacing(3)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }
    }

    private func headingFont(for level: Int) -> Font {
        switch level {
        case 1:
            AppTheme.uiFont(size: 19, weight: .bold)
        case 2:
            AppTheme.uiFont(size: 17, weight: .bold)
        case 3:
            AppTheme.uiFont(size: 15, weight: .semibold)
        default:
            AppTheme.uiFont(size: 14, weight: .semibold)
        }
    }

    private func inlineMarkdown(_ value: String) -> AttributedString {
        CodexInlineMarkdown.attributed(value)
    }
}

struct RelayMarkdownTable: View {
    let header: [String]
    let rows: [[String]]
    let color: Color
    let isOnAccent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if columnCount == 1, let title = header.first?.trimmedNonEmpty {
                Text(CodexInlineMarkdown.attributed(title))
                    .font(AppTheme.uiFont(size: 11, weight: .bold))
                    .foregroundStyle(color.opacity(0.68))
                    .padding(.horizontal, 10)
                    .padding(.top, 9)
                    .padding(.bottom, 7)
            }

            ForEach(Array(displayRows.enumerated()), id: \.offset) { index, row in
                if index > 0 || (columnCount == 1 && header.first?.trimmedNonEmpty != nil) {
                    Divider()
                        .overlay(borderColor.opacity(0.72))
                }
                tableRow(row)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tableFill, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(borderColor, lineWidth: 0.75)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .textSelection(.enabled)
    }

    /// Tables become labeled records on the phone instead of compressed desktop
    /// grids. This keeps long values readable, survives Dynamic Type, and avoids
    /// allocating line height to empty columns from imperfect agent Markdown.
    private func tableRow(_ row: [String]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(nonEmptyCells(in: row).enumerated()), id: \.offset) { _, cell in
                VStack(alignment: .leading, spacing: 3) {
                    if columnCount > 1, let label = headerLabel(at: cell.column) {
                        Text(CodexInlineMarkdown.attributed(label))
                            .font(AppTheme.uiFont(size: 10.5, weight: .bold))
                            .foregroundStyle(color.opacity(0.64))
                            .textCase(.uppercase)
                            .tracking(0.45)
                    }
                    tableCell(cell.value)
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tableCell(_ value: String) -> some View {
        Text(CodexInlineMarkdown.attributed(value))
            .font(AppTheme.uiFont(size: 13.5))
            .foregroundStyle(color)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var columnCount: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    private var displayRows: [[String]] {
        rows.filter { row in
            row.contains { $0.trimmedNonEmpty != nil }
        }
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

    private var tableFill: Color {
        isOnAccent ? AppTheme.onEmber.opacity(0.10) : Color.clear
    }

    private var borderColor: Color {
        isOnAccent ? AppTheme.bgCanvas.opacity(0.24) : AppTheme.hairline
    }
}

struct RelayCodeBlock: View, Equatable {
    let text: String
    let language: String?

    static func == (lhs: RelayCodeBlock, rhs: RelayCodeBlock) -> Bool {
        lhs.text == rhs.text && lhs.language == rhs.language
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(languageLabel)
                    .font(AppTheme.monoFont(size: 11, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = text
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(AppTheme.monoFont(size: 12, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Copy code")
            }
            // Code wraps inside its block at every type size: nothing in the
            // transcript asks for a sideways swipe.
            codeText
        }
        .padding(12)
        .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var codeText: some View {
        Text(text)
            .font(AppTheme.monoFont(size: 12))
            .foregroundStyle(AppTheme.textPrimary)
            .textSelection(.enabled)
            .lineLimit(24)
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var languageLabel: String {
        language?.trimmedNonEmpty?.uppercased() ?? "Code"
    }
}
