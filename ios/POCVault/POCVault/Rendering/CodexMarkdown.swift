import Foundation

struct CodexMarkdownProseBlock: Hashable {
    enum Kind: Hashable {
        case heading(level: Int)
        case paragraph
        case bullet
        case numbered(index: Int)
        case table(header: [String], rows: [[String]])
    }

    let kind: Kind
    let text: String
}

struct CodexMarkdownSegment: Hashable {
    enum Kind: Hashable {
        case prose
        case code(String?)
    }

    let kind: Kind
    let text: String
}

enum CodexMarkdownParser {
    static func plainText(from text: String) -> String {
        let values = segments(from: text).flatMap { segment -> [String] in
            switch segment.kind {
            case .prose:
                return proseBlocks(from: segment.text).map { block in
                    switch block.kind {
                    case .table(let header, let rows):
                        return ([header] + rows)
                            .flatMap { $0 }
                            .map(inlinePlainText)
                            .joined(separator: " ")
                    default:
                        return inlinePlainText(block.text)
                    }
                }
            case .code:
                return [segment.text]
            }
        }

        return values
            .joined(separator: " ")
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func proseBlocks(from text: String) -> [CodexMarkdownProseBlock] {
        var blocks: [CodexMarkdownProseBlock] = []
        var paragraphLines: [String] = []

        func appendParagraph() {
            let value = paragraphLines
                .joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            paragraphLines = []
            guard !value.isEmpty else { return }
            blocks.append(CodexMarkdownProseBlock(kind: .paragraph, text: value))
        }

        let lines = text.components(separatedBy: .newlines)
        var index = 0

        while index < lines.count {
            let line = lines[index]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.isEmpty {
                appendParagraph()
                index += 1
                continue
            }

            if let table = tableBlock(lines: lines, startIndex: index) {
                appendParagraph()
                blocks.append(table.block)
                index = table.nextIndex
                continue
            }

            if let heading = headingBlock(from: trimmed) {
                appendParagraph()
                blocks.append(heading)
                index += 1
                continue
            }

            if let bullet = bulletBlock(from: trimmed) {
                appendParagraph()
                blocks.append(bullet)
                index += 1
                continue
            }

            if let numbered = numberedBlock(from: trimmed) {
                appendParagraph()
                blocks.append(numbered)
                index += 1
                continue
            }

            paragraphLines.append(line)
            index += 1
        }

        appendParagraph()
        return blocks.isEmpty ? [CodexMarkdownProseBlock(kind: .paragraph, text: text)] : blocks
    }

    static func segments(from text: String) -> [CodexMarkdownSegment] {
        var segments: [CodexMarkdownSegment] = []
        var proseLines: [String] = []
        var codeLines: [String] = []
        var currentLanguage: String?
        var isInsideFence = false

        for line in text.components(separatedBy: .newlines) {
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if isInsideFence {
                    appendCode(&segments, lines: codeLines, language: currentLanguage)
                    codeLines = []
                    currentLanguage = nil
                    isInsideFence = false
                } else {
                    appendProse(&segments, lines: proseLines)
                    proseLines = []
                    currentLanguage = language(fromFence: line)
                    isInsideFence = true
                }
            } else if isInsideFence {
                codeLines.append(line)
            } else {
                proseLines.append(line)
            }
        }

        if isInsideFence {
            appendCode(&segments, lines: codeLines, language: currentLanguage)
        } else {
            appendProse(&segments, lines: proseLines)
        }

        return segments.isEmpty ? [CodexMarkdownSegment(kind: .prose, text: text)] : segments
    }

    private static func appendProse(_ segments: inout [CodexMarkdownSegment], lines: [String]) {
        let value = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        segments.append(CodexMarkdownSegment(kind: .prose, text: value))
    }

    private static func appendCode(_ segments: inout [CodexMarkdownSegment], lines: [String], language: String?) {
        segments.append(CodexMarkdownSegment(kind: .code(language), text: lines.joined(separator: "\n")))
    }

    private static func language(fromFence line: String) -> String? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count > 3 else { return nil }
        return String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func headingBlock(from line: String) -> CodexMarkdownProseBlock? {
        let markerCount = line.prefix { $0 == "#" }.count
        guard (1...6).contains(markerCount),
              line.dropFirst(markerCount).first == " " else {
            return nil
        }
        let text = line
            .dropFirst(markerCount)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return CodexMarkdownProseBlock(kind: .heading(level: markerCount), text: text)
    }

    private static func bulletBlock(from line: String) -> CodexMarkdownProseBlock? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            let text = line
                .dropFirst(marker.count)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return nil }
            return CodexMarkdownProseBlock(kind: .bullet, text: text)
        }
        return nil
    }

    private static func numberedBlock(from line: String) -> CodexMarkdownProseBlock? {
        guard let dotIndex = line.firstIndex(of: ".") else { return nil }
        let numberText = line[..<dotIndex]
        guard let index = Int(numberText),
              index > 0 else {
            return nil
        }
        let textStart = line.index(after: dotIndex)
        guard textStart < line.endIndex,
              line[textStart] == " " else {
            return nil
        }
        let text = line[textStart...]
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        return CodexMarkdownProseBlock(kind: .numbered(index: index), text: text)
    }

    private static func tableBlock(
        lines: [String],
        startIndex: Int
    ) -> (block: CodexMarkdownProseBlock, nextIndex: Int)? {
        guard startIndex + 1 < lines.count,
              let header = tableCells(from: lines[startIndex]),
              let separator = tableCells(from: lines[startIndex + 1]),
              isTableSeparator(separator) else {
            return nil
        }

        let columnCount = max(header.count, separator.count)
        var rows: [[String]] = []
        var index = startIndex + 2

        while index < lines.count {
            guard let cells = tableCells(from: lines[index]),
                  !isTableSeparator(cells) else {
                break
            }
            rows.append(normalizedTableRow(cells, columnCount: columnCount))
            index += 1
        }

        guard !rows.isEmpty else { return nil }
        let normalizedHeader = normalizedTableRow(header, columnCount: columnCount)
        let text = ([normalizedHeader] + rows)
            .map { $0.joined(separator: " ") }
            .joined(separator: "\n")

        return (
            CodexMarkdownProseBlock(
                kind: .table(header: normalizedHeader, rows: rows),
                text: text
            ),
            index
        )
    }

    private static func tableCells(from line: String) -> [String]? {
        var value = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard value.contains("|") else { return nil }
        if value.hasPrefix("|") {
            value.removeFirst()
        }
        if value.hasSuffix("|") {
            value.removeLast()
        }

        let cells = value
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard cells.count >= 2,
              cells.contains(where: { !$0.isEmpty }) else {
            return nil
        }
        return cells
    }

    private static func isTableSeparator(_ cells: [String]) -> Bool {
        cells.allSatisfy { cell in
            let trimmed = cell.trimmingCharacters(in: .whitespaces)
            let core = trimmed.trimmingCharacters(in: CharacterSet(charactersIn: ":"))
            return core.count >= 3 && core.allSatisfy { $0 == "-" }
        }
    }

    private static func normalizedTableRow(_ row: [String], columnCount: Int) -> [String] {
        if row.count == columnCount {
            return row
        }
        if row.count > columnCount {
            return Array(row.prefix(columnCount))
        }
        return row + Array(repeating: "", count: columnCount - row.count)
    }

    private static func inlinePlainText(_ value: String) -> String {
        var text = value
        let replacements = [
            (#"!\[([^\]]*)\]\([^)]+\)"#, "$1"),
            (#"\[([^\]]+)\]\([^)]+\)"#, "$1"),
            (#"`([^`]+)`"#, "$1"),
            (#"\*\*([^*]+)\*\*"#, "$1"),
            (#"__([^_]+)__"#, "$1"),
            (#"\*([^*]+)\*"#, "$1"),
            (#"_([^_]+)_"#, "$1"),
            (#"~~([^~]+)~~"#, "$1")
        ]

        for (pattern, replacement) in replacements {
            text = text.replacingOccurrences(
                of: pattern,
                with: replacement,
                options: .regularExpression
            )
        }

        return text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

enum CodexInlineMarkdown {
    static func attributed(_ value: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: value, options: options)) ?? AttributedString(value)
    }
}
