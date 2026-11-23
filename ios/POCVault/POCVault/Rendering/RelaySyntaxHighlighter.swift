import Foundation
import SwiftUI

/// Fast, deterministic, zero-dependency syntax highlighter for unified diffs and the
/// compact file viewer. Uses a single-pass UTF-16/Unicode-scalar scanner (no regex
/// backtracking) backed by a thread-safe bounded `NSCache` so scrolling 1,000+ line
/// diffs stays locked at 120fps.
enum RelaySyntaxHighlighter {
    enum Language: String, Hashable, Sendable {
        case swift
        case typescript
        case javascript
        case python
        case go
        case rust
        case json
        case yaml
        case shell
        case css
        case html
        case markdown
        case cFamily
        case plain

        static func detect(from languageOrPath: String) -> Language {
            let trimmed = languageOrPath.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return .plain }

            let lower = trimmed.lowercased()
            let fileName = URL(fileURLWithPath: lower).lastPathComponent
            let ext = URL(fileURLWithPath: lower).pathExtension
            let token = ext.isEmpty ? fileName : ext

            switch token {
            case "swift":
                return .swift
            case "ts", "tsx", "mts", "cts", "typescript":
                return .typescript
            case "js", "jsx", "mjs", "cjs", "javascript":
                return .javascript
            case "py", "pyi", "pyw", "python":
                return .python
            case "go", "golang":
                return .go
            case "rs", "rust":
                return .rust
            case "json", "jsonc", "json5", "arb":
                return .json
            case "yml", "yaml", "toml":
                return .yaml
            case "sh", "bash", "zsh", "fish", "shell", "dockerfile", "makefile", "zshrc", "bashrc", "env":
                return .shell
            case "css", "scss", "sass", "less":
                return .css
            case "html", "htm", "xml", "svg", "xhtml", "plist":
                return .html
            case "md", "markdown", "mdx", "mdown":
                return .markdown
            case "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "m", "mm", "objc", "c++":
                return .cFamily
            default:
                if fileName == "dockerfile" || fileName == "makefile" || fileName == "podfile" || fileName == "gemfile" {
                    return .shell
                }
                return .plain
            }
        }
    }

    private enum TokenRole {
        case keyword
        case string
        case comment
        case type
        case number
        case function
        case property
        case `operator`
    }

    private struct TokenSpan {
        let start: Int
        let end: Int
        let role: TokenRole
    }

    private final class CacheEntry: NSObject {
        let source: String
        let attributed: AttributedString

        init(source: String, attributed: AttributedString) {
            self.source = source
            self.attributed = attributed
        }
    }

    private final class BoundedCache: @unchecked Sendable {
        let storage: NSCache<NSString, CacheEntry> = {
            let cache = NSCache<NSString, CacheEntry>()
            cache.countLimit = 4096
            return cache
        }()
    }

    private static let lineCache = BoundedCache()
    /// Guard against minified 50KB single-line bundles stalling layout/tokenization.
    private static let maxHighlightableLineLength = 2_000

    // MARK: - Public API

    /// Highlights a single line of code (such as one row in a unified diff or code viewer)
    /// using an in-memory bounded `NSCache` keyed by `(paletteSignature, language, lineHash)`.
    static func highlight(line: String, filePath: String, theme: RelayThemePalette) -> AttributedString {
        guard !line.isEmpty else {
            return AttributedString(" ")
        }
        let language = Language.detect(from: filePath)
        guard language != .plain, line.count <= maxHighlightableLineLength else {
            return plainAttributed(line, foreground: theme.foreground)
        }

        let cacheKey = makeCacheKey(line: line, language: language, theme: theme)
        if let cached = lineCache.storage.object(forKey: cacheKey), cached.source == line {
            return cached.attributed
        }

        var inBlockComment = false
        let spans = tokenizeLine(line, language: language, inBlockComment: &inBlockComment, allowLeadingCommentContinuation: true)
        let attributed = buildAttributedString(from: line, spans: spans, theme: theme)
        lineCache.storage.setObject(CacheEntry(source: line, attributed: attributed), forKey: cacheKey)
        return attributed
    }

    /// Highlights a multi-line code block, tracking `/* ... */` block comments across lines.
    static func highlightBlock(_ code: String, languageOrPath: String, theme: RelayThemePalette) -> AttributedString {
        guard !code.isEmpty else { return AttributedString() }
        let language = Language.detect(from: languageOrPath)
        guard language != .plain else {
            return plainAttributed(code, foreground: theme.foreground)
        }

        let lines = code.split(separator: "\n", omittingEmptySubsequences: false)
        var result = AttributedString()
        var inBlockComment = false

        for (index, rawLine) in lines.enumerated() {
            if index > 0 {
                result.append(AttributedString("\n"))
            }
            let line = String(rawLine)
            if line.isEmpty { continue }
            if line.count > maxHighlightableLineLength {
                result.append(plainAttributed(line, foreground: theme.foreground))
                continue
            }
            let spans = tokenizeLine(line, language: language, inBlockComment: &inBlockComment, allowLeadingCommentContinuation: false)
            result.append(buildAttributedString(from: line, spans: spans, theme: theme))
        }
        return result
    }

    // MARK: - Cache Key

    private static func makeCacheKey(
        line: String,
        language: Language,
        theme: RelayThemePalette
    ) -> NSString {
        var lineHasher = Hasher()
        lineHasher.combine(line)
        let lineHash = lineHasher.finalize()
        return "\(theme.id.rawValue)|\(language.rawValue)|\(line.utf8.count)|\(lineHash)" as NSString
    }

    // MARK: - AttributedString Assembly

    private static func plainAttributed(_ text: String, foreground: Color) -> AttributedString {
        var attributed = AttributedString(text)
        attributed.foregroundColor = foreground
        return attributed
    }

    private static func buildAttributedString(
        from line: String,
        spans: [TokenSpan],
        theme: RelayThemePalette
    ) -> AttributedString {
        guard !spans.isEmpty else {
            return plainAttributed(line, foreground: theme.foreground)
        }

        let scalars = Array(line.unicodeScalars)
        let count = scalars.count
        var result = AttributedString()
        var cursor = 0

        for span in spans {
            let start = max(cursor, min(span.start, count))
            let end = max(start, min(span.end, count))
            if start > cursor {
                var plain = AttributedString(String(String.UnicodeScalarView(scalars[cursor..<start])))
                plain.foregroundColor = theme.foreground
                result.append(plain)
            }
            if end > start {
                var segment = AttributedString(String(String.UnicodeScalarView(scalars[start..<end])))
                segment.foregroundColor = color(for: span.role, theme: theme)
                result.append(segment)
            }
            cursor = end
        }

        if cursor < count {
            var tail = AttributedString(String(String.UnicodeScalarView(scalars[cursor..<count])))
            tail.foregroundColor = theme.foreground
            result.append(tail)
        }
        return result
    }

    private static func color(for role: TokenRole, theme: RelayThemePalette) -> Color {
        switch role {
        case .keyword: return theme.syntaxKeyword
        case .string: return theme.syntaxString
        case .comment: return theme.syntaxComment
        case .type: return theme.syntaxType
        case .number: return theme.syntaxNumber
        case .function: return theme.syntaxFunction
        case .property: return theme.syntaxProperty
        case .operator: return theme.syntaxOperator
        }
    }

    // MARK: - Single-Pass Line Tokenizer

    private static func tokenizeLine(
        _ line: String,
        language: Language,
        inBlockComment: inout Bool,
        allowLeadingCommentContinuation: Bool
    ) -> [TokenSpan] {
        switch language {
        case .markdown:
            return tokenizeMarkdownLine(line)
        case .yaml:
            return tokenizeYAMLLine(line)
        case .json:
            return tokenizeJSONLine(line)
        case .html:
            return tokenizeHTMLLine(line, inBlockComment: &inBlockComment)
        case .css:
            return tokenizeCSSLine(line, inBlockComment: &inBlockComment)
        case .plain:
            return []
        default:
            return tokenizeCodeLine(
                line,
                language: language,
                inBlockComment: &inBlockComment,
                allowLeadingCommentContinuation: allowLeadingCommentContinuation
            )
        }
    }

    private static func tokenizeCodeLine(
        _ line: String,
        language: Language,
        inBlockComment: inout Bool,
        allowLeadingCommentContinuation: Bool
    ) -> [TokenSpan] {
        let chars = Array(line.unicodeScalars)
        let n = chars.count
        var spans: [TokenSpan] = []
        var i = 0

        let usesSlashComments = language != .python && language != .shell
        let usesHashComments = language == .python || language == .shell
        let keywords = keywordSet(for: language)
        let builtInTypes = builtInTypeSet(for: language)

        // Single-line diff heuristic: recognize doc-comment continuation lines (` * ...` or `*/`).
        if allowLeadingCommentContinuation && usesSlashComments && !inBlockComment {
            var ws = 0
            while ws < n && isWhitespace(chars[ws]) { ws += 1 }
            if ws < n && chars[ws] == "*" {
                if ws + 1 == n || chars[ws + 1] == " " || chars[ws + 1] == "\t" || chars[ws + 1] == "/" {
                    spans.append(TokenSpan(start: ws, end: n, role: .comment))
                    return spans
                }
            }
        }

        var prevWasDot = false
        var prevWasDoubleColon = false
        var prevKeywordExpectsType = false

        while i < n {
            if inBlockComment {
                let start = i
                var closed = false
                while i < n {
                    if chars[i] == "*" && i + 1 < n && chars[i + 1] == "/" {
                        i += 2
                        inBlockComment = false
                        closed = true
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .comment))
                if !closed { return spans }
                continue
            }

            let ch = chars[i]

            if isWhitespace(ch) {
                i += 1
                continue
            }

            // Line comments: // ...
            if usesSlashComments && ch == "/" && i + 1 < n && chars[i + 1] == "/" {
                spans.append(TokenSpan(start: i, end: n, role: .comment))
                return spans
            }

            // Block comments: /* ... */
            if usesSlashComments && ch == "/" && i + 1 < n && chars[i + 1] == "*" {
                let start = i
                i += 2
                inBlockComment = true
                while i < n {
                    if chars[i] == "*" && i + 1 < n && chars[i + 1] == "/" {
                        i += 2
                        inBlockComment = false
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .comment))
                continue
            }

            // Hash comments (# ...) for Python & Shell; preprocessor/attributes for C/Swift/Rust
            if ch == "#" {
                if usesHashComments {
                    spans.append(TokenSpan(start: i, end: n, role: .comment))
                    return spans
                } else if language == .cFamily || language == .swift || language == .rust {
                    let start = i
                    i += 1
                    while i < n && isIdentPart(chars[i]) { i += 1 }
                    spans.append(TokenSpan(start: start, end: i, role: .keyword))
                    prevWasDot = false
                    prevWasDoubleColon = false
                    prevKeywordExpectsType = false
                    continue
                }
            }

            // Annotations / decorators (@State, @MainActor, @property)
            if ch == "@" && (language == .swift || language == .python || language == .typescript || language == .javascript) {
                let start = i
                i += 1
                while i < n && (isIdentPart(chars[i]) || chars[i] == ".") { i += 1 }
                if i > start + 1 {
                    spans.append(TokenSpan(start: start, end: i, role: .property))
                    prevWasDot = false
                    prevWasDoubleColon = false
                    prevKeywordExpectsType = false
                    continue
                }
            }

            // Shell variables ($VAR, ${VAR})
            if language == .shell && ch == "$" {
                let start = i
                i += 1
                if i < n && chars[i] == "{" {
                    i += 1
                    while i < n && chars[i] != "}" { i += 1 }
                    if i < n { i += 1 }
                } else {
                    while i < n && isIdentPart(chars[i]) { i += 1 }
                }
                spans.append(TokenSpan(start: start, end: i, role: .property))
                continue
            }

            // Strings: "...", '...', `...`
            if ch == "\"" || ch == "'" || ch == "`" {
                // In Rust, `'a` is a lifetime rather than a char literal if no closing quote soon.
                if language == .rust && ch == "'" {
                    let isCharLiteral = (i + 2 < n && chars[i + 2] == "'")
                        || (i + 3 < n && chars[i + 1] == "\\" && chars[i + 3] == "'")
                    if !isCharLiteral {
                        let start = i
                        i += 1
                        while i < n && isIdentPart(chars[i]) { i += 1 }
                        spans.append(TokenSpan(start: start, end: i, role: .type))
                        continue
                    }
                }
                let quote = ch
                let start = i
                i += 1
                while i < n {
                    if chars[i] == "\\" && quote != "`" && i + 1 < n {
                        i += 2
                        continue
                    }
                    if chars[i] == "\\" && quote == "`" && i + 1 < n {
                        i += 2
                        continue
                    }
                    if chars[i] == quote {
                        i += 1
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .string))
                prevWasDot = false
                prevWasDoubleColon = false
                prevKeywordExpectsType = false
                continue
            }

            // Numbers (decimal, float, hex, binary, octal, underscores)
            if isDigit(ch) {
                let start = i
                if ch == "0" && i + 1 < n && (chars[i + 1] == "x" || chars[i + 1] == "X" || chars[i + 1] == "b" || chars[i + 1] == "B" || chars[i + 1] == "o" || chars[i + 1] == "O") {
                    i += 2
                    while i < n && (isHexDigit(chars[i]) || chars[i] == "_") { i += 1 }
                } else {
                    while i < n && (isDigit(chars[i]) || chars[i] == "_") { i += 1 }
                    if i < n && chars[i] == "." && i + 1 < n && isDigit(chars[i + 1]) {
                        i += 1
                        while i < n && (isDigit(chars[i]) || chars[i] == "_") { i += 1 }
                    }
                    if i < n && (chars[i] == "e" || chars[i] == "E") {
                        var exp = i + 1
                        if exp < n && (chars[exp] == "+" || chars[exp] == "-") { exp += 1 }
                        if exp < n && isDigit(chars[exp]) {
                            i = exp
                            while i < n && (isDigit(chars[i]) || chars[i] == "_") { i += 1 }
                        }
                    }
                }
                // Numeric type suffixes like 42u64, 1.0f
                while i < n && isAsciiLetter(chars[i]) { i += 1 }
                spans.append(TokenSpan(start: start, end: i, role: .number))
                prevWasDot = false
                prevWasDoubleColon = false
                prevKeywordExpectsType = false
                continue
            }

            // Identifiers, keywords, types, functions, properties
            if isIdentStart(ch) {
                let start = i
                i += 1
                while i < n && isIdentPart(chars[i]) { i += 1 }
                let word = String(String.UnicodeScalarView(chars[start..<i]))

                var lookahead = i
                while lookahead < n && (chars[lookahead] == " " || chars[lookahead] == "\t") {
                    lookahead += 1
                }
                let nextChar: UnicodeScalar? = lookahead < n ? chars[lookahead] : nil
                let isFollowedByParen = nextChar == "("
                let isFollowedByColon = nextChar == ":" && (lookahead + 1 >= n || chars[lookahead + 1] != ":")

                if keywords.contains(word) && !prevWasDot {
                    spans.append(TokenSpan(start: start, end: i, role: .keyword))
                    prevKeywordExpectsType = (word == "struct" || word == "class" || word == "enum" || word == "protocol" || word == "interface" || word == "type" || word == "trait" || word == "actor")
                } else if builtInTypes.contains(word) && !prevWasDot {
                    spans.append(TokenSpan(start: start, end: i, role: .type))
                    prevKeywordExpectsType = false
                } else if prevKeywordExpectsType {
                    spans.append(TokenSpan(start: start, end: i, role: .type))
                    prevKeywordExpectsType = false
                } else if isFollowedByParen {
                    let isUpper = isAsciiUpper(chars[start])
                    spans.append(TokenSpan(start: start, end: i, role: isUpper && !prevWasDot ? .type : .function))
                    prevKeywordExpectsType = false
                } else if isAsciiUpper(chars[start]) && !isAllCapsConstant(word) {
                    spans.append(TokenSpan(start: start, end: i, role: .type))
                    prevKeywordExpectsType = false
                } else if prevWasDot || prevWasDoubleColon {
                    spans.append(TokenSpan(start: start, end: i, role: .property))
                    prevKeywordExpectsType = false
                } else if isFollowedByColon && (language == .typescript || language == .javascript || language == .swift) {
                    spans.append(TokenSpan(start: start, end: i, role: .property))
                    prevKeywordExpectsType = false
                } else {
                    prevKeywordExpectsType = false
                }

                prevWasDot = false
                prevWasDoubleColon = false
                continue
            }

            // Shell flags (--flag, -f)
            if language == .shell && ch == "-" && i + 1 < n && (chars[i + 1] == "-" || isAsciiLetter(chars[i + 1])) {
                let start = i
                i += 1
                while i < n && (isIdentPart(chars[i]) || chars[i] == "-") { i += 1 }
                spans.append(TokenSpan(start: start, end: i, role: .operator))
                continue
            }

            // Track member access dot / ::
            if ch == "." {
                let isRange = i + 1 < n && chars[i + 1] == "."
                if isRange {
                    let start = i
                    while i < n && (chars[i] == "." || chars[i] == "<" || chars[i] == "=") { i += 1 }
                    spans.append(TokenSpan(start: start, end: i, role: .operator))
                    prevWasDot = false
                } else {
                    prevWasDot = true
                    i += 1
                }
                prevWasDoubleColon = false
                continue
            }

            if ch == ":" && i + 1 < n && chars[i + 1] == ":" {
                spans.append(TokenSpan(start: i, end: i + 2, role: .operator))
                i += 2
                prevWasDoubleColon = true
                prevWasDot = false
                continue
            }

            // Operators
            if isOperatorChar(ch) {
                let start = i
                i += 1
                while i < n && isOperatorContinuation(chars[i], first: ch) {
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .operator))
                prevWasDot = false
                prevWasDoubleColon = false
                continue
            }

            // Punctuation resets member-access flags
            prevWasDot = false
            prevWasDoubleColon = false
            i += 1
        }

        return spans
    }

    // MARK: - JSON Tokenizer

    private static func tokenizeJSONLine(_ line: String) -> [TokenSpan] {
        let chars = Array(line.unicodeScalars)
        let n = chars.count
        var spans: [TokenSpan] = []
        var i = 0

        while i < n {
            let ch = chars[i]
            if isWhitespace(ch) { i += 1; continue }

            // JSONC comment support
            if ch == "/" && i + 1 < n && chars[i + 1] == "/" {
                spans.append(TokenSpan(start: i, end: n, role: .comment))
                return spans
            }

            if ch == "\"" {
                let start = i
                i += 1
                while i < n {
                    if chars[i] == "\\" && i + 1 < n { i += 2; continue }
                    if chars[i] == "\"" { i += 1; break }
                    i += 1
                }
                var lookahead = i
                while lookahead < n && isWhitespace(chars[lookahead]) { lookahead += 1 }
                let isKey = lookahead < n && chars[lookahead] == ":"
                spans.append(TokenSpan(start: start, end: i, role: isKey ? .property : .string))
                continue
            }

            if isDigit(ch) || (ch == "-" && i + 1 < n && isDigit(chars[i + 1])) {
                let start = i
                i += 1
                while i < n && (isDigit(chars[i]) || chars[i] == "." || chars[i] == "e" || chars[i] == "E" || chars[i] == "+" || chars[i] == "-") {
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .number))
                continue
            }

            if isAsciiLetter(ch) {
                let start = i
                while i < n && isAsciiLetter(chars[i]) { i += 1 }
                let word = String(String.UnicodeScalarView(chars[start..<i]))
                if word == "true" || word == "false" || word == "null" {
                    spans.append(TokenSpan(start: start, end: i, role: .keyword))
                }
                continue
            }

            i += 1
        }
        return spans
    }

    // MARK: - YAML / TOML Tokenizer

    private static func tokenizeYAMLLine(_ line: String) -> [TokenSpan] {
        let chars = Array(line.unicodeScalars)
        let n = chars.count
        var spans: [TokenSpan] = []
        var i = 0

        while i < n && isWhitespace(chars[i]) { i += 1 }
        if i >= n { return spans }

        if chars[i] == "#" {
            spans.append(TokenSpan(start: i, end: n, role: .comment))
            return spans
        }

        // TOML [section] header
        if chars[i] == "[" {
            let start = i
            while i < n && chars[i] != "]" { i += 1 }
            if i < n { i += 1 }
            spans.append(TokenSpan(start: start, end: i, role: .type))
            return spans
        }

        // List bullet `- `
        if chars[i] == "-" && (i + 1 == n || chars[i + 1] == " ") {
            spans.append(TokenSpan(start: i, end: i + 1, role: .operator))
            i += 1
            while i < n && isWhitespace(chars[i]) { i += 1 }
        }

        // Key before `:` or `=`
        let keyStart = i
        var colonIdx: Int?
        var scan = i
        while scan < n && chars[scan] != "#" && chars[scan] != "\"" && chars[scan] != "'" {
            if (chars[scan] == ":" && (scan + 1 == n || chars[scan + 1] == " ")) || chars[scan] == "=" {
                colonIdx = scan
                break
            }
            scan += 1
        }
        if let colon = colonIdx, colon > keyStart {
            spans.append(TokenSpan(start: keyStart, end: colon, role: .property))
            spans.append(TokenSpan(start: colon, end: colon + 1, role: .operator))
            i = colon + 1
        }

        // Value portion
        while i < n {
            let ch = chars[i]
            if isWhitespace(ch) { i += 1; continue }
            if ch == "#" {
                spans.append(TokenSpan(start: i, end: n, role: .comment))
                return spans
            }
            if ch == "\"" || ch == "'" {
                let quote = ch
                let start = i
                i += 1
                while i < n {
                    if chars[i] == "\\" && i + 1 < n { i += 2; continue }
                    if chars[i] == quote { i += 1; break }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .string))
                continue
            }
            if isDigit(ch) || (ch == "-" && i + 1 < n && isDigit(chars[i + 1])) {
                let start = i
                i += 1
                while i < n && (isDigit(chars[i]) || chars[i] == "." || chars[i] == "_") { i += 1 }
                spans.append(TokenSpan(start: start, end: i, role: .number))
                continue
            }
            if isAsciiLetter(ch) {
                let start = i
                while i < n && (isIdentPart(chars[i]) || chars[i] == "-") { i += 1 }
                let word = String(String.UnicodeScalarView(chars[start..<i])).lowercased()
                if word == "true" || word == "false" || word == "null" || word == "yes" || word == "no" {
                    spans.append(TokenSpan(start: start, end: i, role: .keyword))
                }
                continue
            }
            i += 1
        }
        return spans
    }

    // MARK: - CSS Tokenizer

    private static func tokenizeCSSLine(_ line: String, inBlockComment: inout Bool) -> [TokenSpan] {
        let chars = Array(line.unicodeScalars)
        let n = chars.count
        var spans: [TokenSpan] = []
        var i = 0

        while i < n {
            if inBlockComment {
                let start = i
                while i < n {
                    if chars[i] == "*" && i + 1 < n && chars[i + 1] == "/" {
                        i += 2
                        inBlockComment = false
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .comment))
                continue
            }

            let ch = chars[i]
            if isWhitespace(ch) { i += 1; continue }

            if ch == "/" && i + 1 < n && chars[i + 1] == "*" {
                let start = i
                i += 2
                inBlockComment = true
                while i < n {
                    if chars[i] == "*" && i + 1 < n && chars[i + 1] == "/" {
                        i += 2
                        inBlockComment = false
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .comment))
                continue
            }

            if ch == "/" && i + 1 < n && chars[i + 1] == "/" {
                spans.append(TokenSpan(start: i, end: n, role: .comment))
                return spans
            }

            if ch == "\"" || ch == "'" {
                let quote = ch
                let start = i
                i += 1
                while i < n {
                    if chars[i] == "\\" && i + 1 < n { i += 2; continue }
                    if chars[i] == quote { i += 1; break }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .string))
                continue
            }

            if ch == "@" {
                let start = i
                i += 1
                while i < n && (isIdentPart(chars[i]) || chars[i] == "-") { i += 1 }
                spans.append(TokenSpan(start: start, end: i, role: .keyword))
                continue
            }

            if ch == "#" {
                let start = i
                i += 1
                while i < n && (isHexDigit(chars[i]) || isIdentPart(chars[i]) || chars[i] == "-") { i += 1 }
                spans.append(TokenSpan(start: start, end: i, role: .number))
                continue
            }

            if isDigit(ch) {
                let start = i
                while i < n && (isDigit(chars[i]) || chars[i] == "." || isAsciiLetter(chars[i]) || chars[i] == "%") {
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .number))
                continue
            }

            if isIdentStart(ch) || ch == "-" {
                let start = i
                i += 1
                while i < n && (isIdentPart(chars[i]) || chars[i] == "-") { i += 1 }
                var lookahead = i
                while lookahead < n && isWhitespace(chars[lookahead]) { lookahead += 1 }
                if lookahead < n && chars[lookahead] == ":" {
                    spans.append(TokenSpan(start: start, end: i, role: .property))
                } else if lookahead < n && chars[lookahead] == "(" {
                    spans.append(TokenSpan(start: start, end: i, role: .function))
                }
                continue
            }

            i += 1
        }
        return spans
    }

    // MARK: - HTML / XML Tokenizer

    private static func tokenizeHTMLLine(_ line: String, inBlockComment: inout Bool) -> [TokenSpan] {
        let chars = Array(line.unicodeScalars)
        let n = chars.count
        var spans: [TokenSpan] = []
        var i = 0

        while i < n {
            if inBlockComment {
                let start = i
                while i < n {
                    if chars[i] == "-" && i + 2 < n && chars[i + 1] == "-" && chars[i + 2] == ">" {
                        i += 3
                        inBlockComment = false
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .comment))
                continue
            }

            if chars[i] == "<" && i + 3 < n && chars[i + 1] == "!" && chars[i + 2] == "-" && chars[i + 3] == "-" {
                let start = i
                i += 4
                inBlockComment = true
                while i < n {
                    if chars[i] == "-" && i + 2 < n && chars[i + 1] == "-" && chars[i + 2] == ">" {
                        i += 3
                        inBlockComment = false
                        break
                    }
                    i += 1
                }
                spans.append(TokenSpan(start: start, end: i, role: .comment))
                continue
            }

            if chars[i] == "<" {
                let openEnd = (i + 1 < n && (chars[i + 1] == "/" || chars[i + 1] == "!")) ? i + 2 : i + 1
                spans.append(TokenSpan(start: i, end: openEnd, role: .operator))
                i = openEnd
                let tagStart = i
                while i < n && (isIdentPart(chars[i]) || chars[i] == "-" || chars[i] == ":") { i += 1 }
                if i > tagStart {
                    spans.append(TokenSpan(start: tagStart, end: i, role: .keyword))
                }
                // Attributes until `>`
                while i < n && chars[i] != ">" {
                    if isWhitespace(chars[i]) { i += 1; continue }
                    if chars[i] == "\"" || chars[i] == "'" {
                        let quote = chars[i]
                        let start = i
                        i += 1
                        while i < n && chars[i] != quote { i += 1 }
                        if i < n { i += 1 }
                        spans.append(TokenSpan(start: start, end: i, role: .string))
                        continue
                    }
                    if chars[i] == "=" || chars[i] == "/" {
                        spans.append(TokenSpan(start: i, end: i + 1, role: .operator))
                        i += 1
                        continue
                    }
                    if isIdentStart(chars[i]) {
                        let start = i
                        while i < n && (isIdentPart(chars[i]) || chars[i] == "-" || chars[i] == ":") { i += 1 }
                        spans.append(TokenSpan(start: start, end: i, role: .property))
                        continue
                    }
                    i += 1
                }
                if i < n && chars[i] == ">" {
                    spans.append(TokenSpan(start: i, end: i + 1, role: .operator))
                    i += 1
                }
                continue
            }

            i += 1
        }
        return spans
    }

    // MARK: - Markdown Tokenizer

    private static func tokenizeMarkdownLine(_ line: String) -> [TokenSpan] {
        let chars = Array(line.unicodeScalars)
        let n = chars.count
        var spans: [TokenSpan] = []
        var i = 0

        while i < n && isWhitespace(chars[i]) { i += 1 }
        if i >= n { return spans }

        if chars[i] == "#" {
            spans.append(TokenSpan(start: i, end: n, role: .keyword))
            return spans
        }
        if i + 2 < n && chars[i] == "`" && chars[i + 1] == "`" && chars[i + 2] == "`" {
            spans.append(TokenSpan(start: i, end: n, role: .comment))
            return spans
        }
        if chars[i] == ">" {
            spans.append(TokenSpan(start: i, end: n, role: .comment))
            return spans
        }
        if (chars[i] == "-" || chars[i] == "*" || chars[i] == "+") && i + 1 < n && chars[i + 1] == " " {
            spans.append(TokenSpan(start: i, end: i + 1, role: .operator))
            i += 2
        }

        // Inline code spans `...`
        while i < n {
            if chars[i] == "`" {
                let start = i
                i += 1
                while i < n && chars[i] != "`" { i += 1 }
                if i < n { i += 1 }
                spans.append(TokenSpan(start: start, end: i, role: .string))
                continue
            }
            i += 1
        }
        return spans
    }

    // MARK: - Character Helpers

    @inline(__always)
    private static func isWhitespace(_ s: UnicodeScalar) -> Bool {
        s == " " || s == "\t" || s == "\r" || s == "\n"
    }

    @inline(__always)
    private static func isDigit(_ s: UnicodeScalar) -> Bool {
        s.value >= 48 && s.value <= 57
    }

    @inline(__always)
    private static func isHexDigit(_ s: UnicodeScalar) -> Bool {
        isDigit(s) || (s.value >= 65 && s.value <= 70) || (s.value >= 97 && s.value <= 102)
    }

    @inline(__always)
    private static func isAsciiUpper(_ s: UnicodeScalar) -> Bool {
        s.value >= 65 && s.value <= 90
    }

    @inline(__always)
    private static func isAsciiLetter(_ s: UnicodeScalar) -> Bool {
        (s.value >= 65 && s.value <= 90) || (s.value >= 97 && s.value <= 122)
    }

    @inline(__always)
    private static func isIdentStart(_ s: UnicodeScalar) -> Bool {
        isAsciiLetter(s) || s == "_" || s == "$"
    }

    @inline(__always)
    private static func isIdentPart(_ s: UnicodeScalar) -> Bool {
        isAsciiLetter(s) || isDigit(s) || s == "_" || s == "$"
    }

    @inline(__always)
    private static func isAllCapsConstant(_ word: String) -> Bool {
        guard word.count >= 2 else { return false }
        return word.unicodeScalars.allSatisfy { isAsciiUpper($0) || isDigit($0) || $0 == "_" }
    }

    @inline(__always)
    private static func isOperatorChar(_ s: UnicodeScalar) -> Bool {
        switch s {
        case "+", "-", "*", "/", "%", "=", "!", "<", ">", "&", "|", "^", "~", "?", ":":
            return true
        default:
            return false
        }
    }

    @inline(__always)
    private static func isOperatorContinuation(_ s: UnicodeScalar, first: UnicodeScalar) -> Bool {
        switch (first, s) {
        case ("=", "="), ("=", ">"), ("!", "="), ("<", "="), (">", "="),
             ("-", ">"), ("&", "&"), ("|", "|"), ("?", "?"), ("+", "="),
             ("-", "="), ("*", "="), ("/", "="), ("+", "+"), ("-", "-"),
             ("<", "<"), (">", ">"):
            return true
        default:
            return false
        }
    }

    // MARK: - Language Tables

    private static func keywordSet(for language: Language) -> Set<String> {
        switch language {
        case .swift: return swiftKeywords
        case .typescript, .javascript: return jsTsKeywords
        case .python: return pythonKeywords
        case .go: return goKeywords
        case .rust: return rustKeywords
        case .shell: return shellKeywords
        case .cFamily: return cFamilyKeywords
        default: return []
        }
    }

    private static func builtInTypeSet(for language: Language) -> Set<String> {
        switch language {
        case .typescript, .javascript:
            return ["string", "number", "boolean", "void", "never", "unknown", "any", "object", "symbol", "bigint"]
        case .go:
            return ["bool", "byte", "complex64", "complex128", "error", "float32", "float64", "int", "int8", "int16", "int32", "int64", "rune", "string", "uint", "uint8", "uint16", "uint32", "uint64", "uintptr"]
        case .rust:
            return ["bool", "char", "str", "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64", "Self"]
        case .cFamily:
            return ["void", "bool", "char", "short", "int", "long", "float", "double", "signed", "unsigned", "size_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int32_t", "int64_t"]
        case .swift:
            return ["Self", "Any", "AnyObject"]
        default:
            return []
        }
    }

    private static let swiftKeywords: Set<String> = [
        "actor", "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
        "continue", "convenience", "default", "defer", "deinit", "do", "else", "enum", "extension",
        "fallthrough", "false", "fileprivate", "final", "for", "func", "get", "guard", "if", "import",
        "in", "indirect", "infix", "init", "inout", "internal", "is", "isolated", "lazy", "let",
        "mutating", "nil", "nonisolated", "nonmutating", "open", "operator", "optional", "override",
        "postfix", "prefix", "private", "protocol", "public", "repeat", "required", "rethrows",
        "return", "self", "set", "some", "static", "struct", "subscript", "super", "switch", "throw",
        "throws", "true", "try", "typealias", "unowned", "var", "weak", "where", "while"
    ]

    private static let jsTsKeywords: Set<String> = [
        "abstract", "as", "asserts", "async", "await", "break", "case", "catch", "class", "const",
        "continue", "debugger", "declare", "default", "delete", "do", "else", "enum", "export",
        "extends", "false", "finally", "for", "from", "function", "get", "if", "implements", "import",
        "in", "infer", "instanceof", "interface", "is", "keyof", "let", "module", "namespace", "new",
        "null", "of", "override", "private", "protected", "public", "readonly", "return", "satisfies",
        "set", "static", "super", "switch", "this", "throw", "true", "try", "type", "typeof",
        "undefined", "var", "void", "while", "with", "yield"
    ]

    private static let pythonKeywords: Set<String> = [
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "case", "class",
        "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
        "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return",
        "self", "try", "while", "with", "yield"
    ]

    private static let goKeywords: Set<String> = [
        "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough",
        "false", "for", "func", "go", "goto", "if", "import", "interface", "iota", "map", "nil",
        "package", "range", "return", "select", "struct", "switch", "true", "type", "var"
    ]

    private static let rustKeywords: Set<String> = [
        "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum",
        "extern", "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move",
        "mut", "pub", "ref", "return", "self", "static", "struct", "super", "trait", "true", "type",
        "unsafe", "use", "where", "while"
    ]

    private static let shellKeywords: Set<String> = [
        "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in",
        "local", "readonly", "return", "select", "set", "shift", "source", "then", "time", "unset",
        "until", "while"
    ]

    private static let cFamilyKeywords: Set<String> = [
        "auto", "break", "case", "catch", "class", "const", "constexpr", "continue", "default",
        "delete", "do", "else", "enum", "explicit", "extern", "false", "final", "for", "friend",
        "goto", "if", "inline", "namespace", "new", "noexcept", "nullptr", "NULL", "operator",
        "override", "private", "protected", "public", "return", "sizeof", "static", "struct",
        "switch", "template", "this", "throw", "true", "try", "typedef", "typename", "union",
        "using", "virtual", "volatile", "while"
    ]
}
