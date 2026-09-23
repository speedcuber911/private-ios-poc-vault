import QuickLook
import SwiftUI
import UIKit

/// Presentation surface the read-only file viewer uses for an entry. Mostly a straight
/// mapping from `CodexFileCategory`; HTML documents (categorized `.code` by extension and
/// MIME) are special-cased into the authenticated web view alongside PDFs.
enum RelayFileViewerKind: String, Hashable {
    /// Monospaced text with a wrap toggle and Range-request paging (code + plain text).
    case text
    /// Rendered markdown through the shared Relay markdown views, with a raw toggle.
    case markdown
    /// Row-and-column rendering for CSV and TSV files.
    case table
    /// Fit-width bitmap preview.
    case image
    /// Authenticated web view pointed at the raw-file endpoint (PDF + HTML).
    case web
    /// Icon placeholder plus share for unknown or undisplayable content.
    case binary
}

extension CodexWorkspaceDirectoryEntry {
    /// Which viewer surface renders this file.
    var viewerKind: RelayFileViewerKind {
        if readDenied {
            return .binary
        }
        if isHTMLDocument {
            return .web
        }
        if isDelimitedDocument {
            return .table
        }
        switch fileCategory {
        case .code, .text:
            return .text
        case .markdown:
            return .markdown
        case .image:
            return .image
        case .pdf:
            return .web
        case .binary:
            return .binary
        }
    }

    private var isHTMLDocument: Bool {
        let mimeValue = mime?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        if mimeValue.hasPrefix("text/html") || mimeValue.hasPrefix("application/xhtml") {
            return true
        }
        let fileExtension = URL(fileURLWithPath: displayName).pathExtension.lowercased()
        return fileExtension == "html" || fileExtension == "htm"
    }

    private var isDelimitedDocument: Bool {
        let mimeValue = mime?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let fileExtension = URL(fileURLWithPath: displayName).pathExtension.lowercased()
        return mimeValue.hasPrefix("text/csv")
            || mimeValue.hasPrefix("text/tab-separated-values")
            || fileExtension == "csv"
            || fileExtension == "tsv"
    }
}

struct RelayDelimitedTable: Equatable {
    let rows: [[String]]
    let isTruncated: Bool

    static func parse(
        _ text: String,
        delimiter: Character,
        maximumRows: Int = 500,
        maximumColumns: Int = 50
    ) -> RelayDelimitedTable {
        var parsed: [[String]] = []
        var row: [String] = []
        var field = ""
        var insideQuotes = false
        var iterator = text.makeIterator()
        var pending: Character?
        var didTruncateRows = false
        var didTruncateColumns = false

        func finishField() {
            if row.count < maximumColumns {
                row.append(field)
            } else {
                didTruncateColumns = true
            }
            field = ""
        }
        func finishRow() {
            finishField()
            if parsed.count < maximumRows {
                parsed.append(row)
            } else {
                didTruncateRows = true
            }
            row = []
        }

        while let character = pending ?? iterator.next() {
            pending = nil
            if character == "\"" {
                if insideQuotes {
                    if let next = iterator.next() {
                        if next == "\"" {
                            field.append("\"")
                        } else {
                            insideQuotes = false
                            pending = next
                        }
                    } else {
                        insideQuotes = false
                    }
                } else if field.isEmpty {
                    insideQuotes = true
                } else {
                    field.append(character)
                }
            } else if character == delimiter, !insideQuotes {
                finishField()
            } else if (character == "\n" || character == "\r"), !insideQuotes {
                if character == "\r", let next = iterator.next(), next != "\n" { pending = next }
                finishRow()
            } else {
                field.append(character)
            }
        }
        if !field.isEmpty || !row.isEmpty { finishRow() }

        return RelayDelimitedTable(
            rows: parsed,
            isTruncated: didTruncateRows || didTruncateColumns
        )
    }
}

struct RelayDelimitedTableView: View {
    let text: String
    let delimiter: Character

    private var table: RelayDelimitedTable {
        RelayDelimitedTable.parse(text, delimiter: delimiter)
    }

    var body: some View {
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(table.rows.enumerated()), id: \.offset) { rowIndex, row in
                    HStack(spacing: 0) {
                        ForEach(Array(row.enumerated()), id: \.offset) { _, value in
                            Text(value.isEmpty ? " " : value)
                                .font(rowIndex == 0 ? AppTheme.uiFont(size: 12, weight: .semibold) : AppTheme.uiFont(size: 12))
                                .foregroundStyle(AppTheme.textPrimary)
                                .lineLimit(4)
                                .frame(width: 170, alignment: .leading)
                                .padding(9)
                                .background(rowIndex == 0 ? AppTheme.accent.opacity(0.12) : Color.clear)
                                .overlay(alignment: .trailing) {
                                    Rectangle().fill(AppTheme.hairline).frame(width: 0.5)
                                }
                        }
                    }
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
                    }
                }
                if table.isTruncated {
                    Text("Showing the first 500 rows and 50 columns.")
                        .font(AppTheme.uiFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                        .padding(12)
                }
            }
            .padding(12)
        }
    }
}

enum RelaySyntaxTokenKind: String, Hashable {
    case keyword
    case string
    case comment
    case number
    case type
    case function
    case property
    case annotation

    fileprivate var color: Color {
        switch self {
        case .keyword: return Color(red: 0.78, green: 0.56, blue: 0.92)
        case .string: return Color(red: 0.81, green: 0.57, blue: 0.47)
        case .comment: return Color(red: 0.42, green: 0.62, blue: 0.36)
        case .number: return Color(red: 0.71, green: 0.81, blue: 0.66)
        case .type: return Color(red: 0.31, green: 0.79, blue: 0.69)
        case .function: return Color(red: 0.86, green: 0.86, blue: 0.67)
        case .property: return Color(red: 0.61, green: 0.86, blue: 0.98)
        case .annotation: return Color(red: 0.82, green: 0.68, blue: 0.87)
        }
    }
}

struct RelaySyntaxToken: Hashable {
    let kind: RelaySyntaxTokenKind
    let location: Int
    let length: Int

    fileprivate var range: NSRange { NSRange(location: location, length: length) }
}

/// A deliberately small, dependency-free highlighter for the read-only phone viewer.
/// It recognizes the token classes that carry most of a code file's visual structure,
/// while keeping the original text byte-for-byte intact for selection and copying.
enum RelayCodeSyntax {
    static func highlighted(_ text: String, fileName: String) -> AttributedString {
        var value = AttributedString(text)
        value.foregroundColor = AppTheme.textPrimary
        for token in tokens(in: text, fileName: fileName) {
            guard let stringRange = Range(token.range, in: text),
                  let lower = AttributedString.Index(stringRange.lowerBound, within: value),
                  let upper = AttributedString.Index(stringRange.upperBound, within: value) else {
                continue
            }
            value[lower..<upper].foregroundColor = token.kind.color
        }
        return value
    }

    static func tokens(in text: String, fileName: String) -> [RelaySyntaxToken] {
        guard !text.isEmpty else { return [] }
        let fileExtension = URL(fileURLWithPath: fileName).pathExtension.lowercased()
        let stringTokens = matches(
            #"\"(?:\\.|[^\"\\])*\"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`"#,
            in: text,
            kind: .string
        )
        let commentTokens = commentPattern(for: fileExtension).map {
            matches($0, in: text, kind: .comment).filter { candidate in
                !stringTokens.contains(where: { contains(candidate.location, in: $0.range) })
            }
        } ?? []
        let protectedRanges = (stringTokens + commentTokens).map(\.range)

        var result: [RelaySyntaxToken] = []
        if let keywordPattern = keywordPattern(for: fileExtension) {
            result += unprotectedMatches(keywordPattern, in: text, kind: .keyword, protectedRanges: protectedRanges)
        }
        result += unprotectedMatches(
            #"(?<![A-Za-z0-9_$])(?:0x[0-9A-Fa-f]+|\d+(?:\.\d+)?)(?![A-Za-z0-9_$])"#,
            in: text,
            kind: .number,
            protectedRanges: protectedRanges
        )
        result += unprotectedMatches(
            #"\b[A-Z][A-Za-z0-9_]*\b"#,
            in: text,
            kind: .type,
            protectedRanges: protectedRanges
        )
        result += unprotectedMatches(
            #"\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()"#,
            in: text,
            kind: .function,
            protectedRanges: protectedRanges
        )
        result += unprotectedMatches(
            #"\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*:)"#,
            in: text,
            kind: .property,
            protectedRanges: protectedRanges
        )
        result += unprotectedMatches(
            #"@[A-Za-z_][A-Za-z0-9_.]*"#,
            in: text,
            kind: .annotation,
            protectedRanges: protectedRanges
        )

        // Literal and comment colors win over identifier-shaped text inside them.
        result += stringTokens
        result += commentTokens
        return result
    }

    private static func commentPattern(for fileExtension: String) -> String? {
        switch fileExtension {
        case "py", "rb", "sh", "bash", "zsh", "pl", "yaml", "yml", "toml":
            return #"(?m:#[^\n]*$)"#
        case "sql":
            return #"(?m:--[^\n]*$)|(?s:/\*.*?\*/)"#
        case "xml":
            return #"(?s:<!--.*?-->)"#
        case "json":
            return nil
        default:
            return #"(?m://[^\n]*$)|(?s:/\*.*?\*/)"#
        }
    }

    private static func keywordPattern(for fileExtension: String) -> String? {
        let words: [String]
        switch fileExtension {
        case "js", "jsx", "mjs", "cjs", "ts", "tsx":
            words = javascriptKeywords
        case "swift":
            words = swiftKeywords
        case "py":
            words = pythonKeywords
        case "sh", "bash", "zsh":
            words = shellKeywords
        case "sql":
            words = sqlKeywords
        case "json", "yaml", "yml", "toml", "xml", "css", "scss", "less", "pbxproj":
            return nil
        default:
            words = generalKeywords
        }
        let alternatives = words
            .sorted { $0.count > $1.count }
            .map(NSRegularExpression.escapedPattern(for:))
            .joined(separator: "|")
        return "(?<![A-Za-z0-9_$])(?:\(alternatives))(?![A-Za-z0-9_$])"
    }

    private static func unprotectedMatches(
        _ pattern: String,
        in text: String,
        kind: RelaySyntaxTokenKind,
        protectedRanges: [NSRange]
    ) -> [RelaySyntaxToken] {
        matches(pattern, in: text, kind: kind).filter { token in
            !protectedRanges.contains { NSIntersectionRange(token.range, $0).length > 0 }
        }
    }

    private static func matches(
        _ pattern: String,
        in text: String,
        kind: RelaySyntaxTokenKind
    ) -> [RelaySyntaxToken] {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return [] }
        let searchRange = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.matches(in: text, range: searchRange).map {
            RelaySyntaxToken(kind: kind, location: $0.range.location, length: $0.range.length)
        }
    }

    private static func contains(_ location: Int, in range: NSRange) -> Bool {
        location >= range.location && location < NSMaxRange(range)
    }

    private static let javascriptKeywords = [
        "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
        "declare", "default", "delete", "do", "else", "enum", "export", "extends", "false", "finally",
        "for", "from", "function", "get", "if", "implements", "import", "in", "infer", "instanceof",
        "interface", "keyof", "let", "namespace", "new", "null", "of", "private", "protected", "public",
        "readonly", "return", "satisfies", "set", "static", "super", "switch", "this", "throw", "true",
        "try", "type", "typeof", "undefined", "var", "void", "while", "with", "yield"
    ]
    private static let swiftKeywords = [
        "actor", "any", "as", "associatedtype", "async", "await", "break", "case", "catch", "class",
        "continue", "convenience", "default", "defer", "deinit", "do", "else", "enum", "extension", "false",
        "fileprivate", "for", "func", "guard", "if", "import", "in", "indirect", "init", "inout", "internal",
        "is", "isolated", "let", "mutating", "nil", "nonisolated", "open", "operator", "override", "private",
        "protocol", "public", "repeat", "required", "rethrows", "return", "Self", "self", "some", "static",
        "struct", "subscript", "super", "switch", "throw", "throws", "true", "try", "typealias", "var", "where", "while"
    ]
    private static let pythonKeywords = [
        "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def",
        "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is",
        "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield"
    ]
    private static let shellKeywords = [
        "case", "do", "done", "elif", "else", "esac", "export", "fi", "for", "function", "if", "in", "local",
        "readonly", "return", "select", "then", "time", "until", "while"
    ]
    private static let sqlKeywords = [
        "ADD", "ALTER", "AND", "AS", "ASC", "BEGIN", "BETWEEN", "BY", "CASE", "CREATE", "DELETE", "DESC",
        "DISTINCT", "DROP", "ELSE", "END", "EXISTS", "FROM", "GROUP", "HAVING", "IN", "INDEX", "INNER",
        "INSERT", "INTO", "IS", "JOIN", "LEFT", "LIKE", "LIMIT", "NOT", "NULL", "ON", "OR", "ORDER",
        "OUTER", "PRIMARY", "REFERENCES", "RIGHT", "SELECT", "SET", "TABLE", "THEN", "UNION", "UNIQUE",
        "UPDATE", "VALUES", "WHEN", "WHERE"
    ]
    private static let generalKeywords = [
        "abstract", "break", "case", "catch", "class", "const", "continue", "default", "defer", "do", "else",
        "enum", "false", "final", "finally", "for", "func", "function", "if", "import", "in", "interface",
        "let", "match", "mod", "new", "nil", "null", "override", "package", "private", "protected", "protocol",
        "pub", "public", "return", "static", "struct", "super", "switch", "this", "throw", "trait", "true",
        "try", "type", "use", "using", "var", "void", "while"
    ]
}

struct RelayQuickLookPreview: UIViewControllerRepresentable {
    let fileURL: URL

    func makeCoordinator() -> Coordinator { Coordinator(fileURL: fileURL) }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: QLPreviewController, context: Context) {
        guard context.coordinator.fileURL != fileURL else { return }
        context.coordinator.fileURL = fileURL
        controller.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var fileURL: URL

        init(fileURL: URL) { self.fileURL = fileURL }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            fileURL as NSURL
        }
    }
}

/// Fetch + paging state for one viewed file. Bytes come exclusively from
/// `CodexClient.fetchFile(path:range:)`; truncation is driven by the server's
/// 206/`Content-Range` signal plus the listing's known file size, and "Load more"
/// continues with Range requests that append to the loaded bytes.
@MainActor
final class FileViewerViewModel: ObservableObject {
    /// Bytes requested per "Load more" Range request. Kept below the server's observed
    /// per-request byte cap so each tap pages in a predictable chunk.
    /// `nonisolated`: immutable Sendable constant referenced from nonisolated default
    /// arguments (Swift 6 forbids main-actor statics there).
    nonisolated static let loadMoreChunkByteCount: Int64 = 512 * 1024

    let entry: CodexWorkspaceDirectoryEntry
    let kind: RelayFileViewerKind
    private let client: CodexClient

    /// Lines per mono-text chunk. One `Text` holding a megabyte of log stalls SwiftUI
    /// layout for minutes; rendering bounded chunks in a `LazyVStack` keeps it incremental.
    /// `nonisolated`: immutable Sendable constant referenced from nonisolated default
    /// arguments (Swift 6 forbids main-actor statics there).
    nonisolated static let monoChunkLineCount = 400

    @Published private(set) var data = Data()
    /// UTF-8 (lossy) decode of `data`, maintained for text/markdown kinds.
    @Published private(set) var text = ""
    /// `text` split into bounded line chunks for lazy mono rendering.
    @Published private(set) var textChunks: [String] = []
    /// Decoded bitmap, maintained for the image kind; nil when undecodable (e.g. SVG).
    @Published private(set) var image: UIImage?
    @Published private(set) var isLoading = false
    @Published private(set) var isLoadingMore = false
    /// True while the server holds bytes beyond what is loaded.
    @Published private(set) var hasMoreBytes = false
    @Published private(set) var errorMessage: String?
    /// Loaded bytes staged as a real file in the sandbox tmp dir so ShareLink hands the
    /// share sheet a filename-preserving file URL.
    @Published private(set) var shareURL: URL?
    /// Branch and this file's `+`/`−` counts. Updated while the viewer is open
    /// so a save on the machine shows up without leaving the file.
    @Published private(set) var gitStatus: RelayGitStatus?

    private var hasLoaded = false
    private var shareDirectoryURL: URL?
    /// Last `modifiedAt#size` applied from git status. A later poll with a
    /// different stamp reloads the bytes.
    private var contentStamp: String?

    init(client: CodexClient, entry: CodexWorkspaceDirectoryEntry) {
        self.client = client
        self.entry = entry
        self.kind = entry.viewerKind
    }

    deinit {
        if let shareDirectoryURL {
            try? FileManager.default.removeItem(at: shareDirectoryURL)
        }
    }

    /// Web-rendered kinds stream straight into WKWebView; everything else fetches bytes.
    var needsByteFetch: Bool {
        kind != .web
    }

    var loadedByteLabel: String {
        ByteCountFormatter.string(fromByteCount: Int64(data.count), countStyle: .file)
    }

    var truncationLabel: String {
        if let totalLabel = entry.sizeLabel {
            return "Loaded \(loadedByteLabel) of \(totalLabel)"
        }
        return "Loaded the first \(loadedByteLabel)"
    }

    func loadIfNeeded() async {
        guard needsByteFetch, !hasLoaded, !isLoading else { return }
        await load()
        if kind == .binary {
            while hasMoreBytes, errorMessage == nil {
                let previousCount = data.count
                await loadMore()
                if data.count == previousCount { break }
            }
        }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let result = try await client.fetchFile(path: entry.path)
            hasLoaded = true
            data = result.data
            hasMoreBytes = Self.remainingBytesExist(
                responseTruncated: result.truncated,
                receivedByteCount: result.data.count,
                loadedByteCount: data.count,
                knownFileSize: entry.size
            )
            errorMessage = nil
            applyDerivedContent()
        } catch {
            guard !isCancellation(error) else { return }
            errorMessage = error.localizedDescription
        }
    }

    /// Append the next byte chunk of a server-truncated file via a Range request.
    func loadMore() async {
        guard hasMoreBytes, !isLoadingMore, !isLoading else { return }
        isLoadingMore = true
        defer { isLoadingMore = false }
        let range = Self.nextRange(afterLoadedByteCount: data.count)
        do {
            let result = try await client.fetchFile(path: entry.path, range: range)
            data.append(result.data)
            hasMoreBytes = Self.remainingBytesExist(
                responseTruncated: result.truncated,
                requestedByteCount: range.upperBound - range.lowerBound + 1,
                receivedByteCount: result.data.count,
                loadedByteCount: data.count,
                knownFileSize: entry.size
            )
            errorMessage = nil
            applyDerivedContent()
        } catch {
            guard !isCancellation(error) else { return }
            if (error as? CodexClientError)?.statusCode == 416 {
                // The previous chunk already reached EOF (file size was unknown).
                hasMoreBytes = false
                return
            }
            errorMessage = error.localizedDescription
        }
    }

    /// Poll this file's branch and diff counts, and reload the bytes when the
    /// file's mtime or size changes underneath the viewer. A daemon without the
    /// git route still re-reads the bytes, so a save is not stuck on screen.
    func watchGitStatus() async {
        var gitUnavailable = false
        while !Task.isCancelled {
            if gitUnavailable {
                await reloadBytesIfChanged()
            } else {
                switch await refreshGitStatus() {
                case .cancelled:
                    return
                case .unavailable:
                    gitUnavailable = true
                case .ok:
                    break
                }
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    private enum GitPoll { case ok, unavailable, cancelled }

    /// `.unavailable` when this daemon has no git route. `.cancelled` ends the watch.
    private func refreshGitStatus() async -> GitPoll {
        do {
            let status = try await client.fetchGitStatus(path: entry.path)
            let next = status.showsBar ? status : nil
            if gitStatus != next { gitStatus = next }
            // Wait until the first byte load finishes before remembering a stamp.
            // Otherwise a save that lands during that load would look unchanged.
            guard hasLoaded else { return .ok }
            let stamp = status.contentStamp
            if contentStamp == nil {
                contentStamp = stamp
                if shouldReloadForSizeMismatch(status) { _ = await reloadBytesIfChanged() }
                return .ok
            }
            guard stamp != contentStamp else { return .ok }
            let previousStamp = contentStamp
            contentStamp = stamp
            let applied = await reloadBytesIfChanged()
            if !applied || errorMessage != nil { contentStamp = previousStamp }
            return .ok
        } catch {
            if isCancellation(error) { return .cancelled }
            if (error as? CodexClientError)?.isGenericRouteNotFound == true {
                gitStatus = nil
                return .unavailable
            }
            return .ok
        }
    }

    /// Re-read a file that still fits in one response. A "Load more" session is
    /// left alone so a poll cannot throw away pages the user already fetched.
    /// False when the read did not happen, so the caller can retry the stamp.
    private func reloadBytesIfChanged() async -> Bool {
        guard hasLoaded, !isLoading, !isLoadingMore, needsByteFetch else { return false }
        guard data.count <= Self.loadMoreChunkByteCount else { return false }
        do {
            let result = try await client.fetchFile(path: entry.path)
            guard result.data != data else { return true }
            data = result.data
            hasMoreBytes = Self.remainingBytesExist(
                responseTruncated: result.truncated,
                receivedByteCount: result.data.count,
                loadedByteCount: result.data.count,
                knownFileSize: nil
            )
            errorMessage = nil
            applyDerivedContent()
            return true
        } catch {
            return false
        }
    }

    /// The listing size and the loaded bytes disagree, and the whole file is
    /// already in memory, so a save raced the first read.
    private func shouldReloadForSizeMismatch(_ status: RelayGitStatus) -> Bool {
        guard !hasMoreBytes, let size = status.size else { return false }
        return Int64(data.count) != size
    }

    /// Byte range for the next "Load more" request, continuing from the loaded bytes.
    static func nextRange(
        afterLoadedByteCount loaded: Int,
        chunkByteCount: Int64 = loadMoreChunkByteCount
    ) -> ClosedRange<Int64> {
        let start = Int64(max(0, loaded))
        return start...(start + max(1, chunkByteCount) - 1)
    }

    /// Whether the server still holds bytes past what is loaded. The listing's known file
    /// size wins when present; otherwise an empty or short Range response means EOF, and
    /// the 206/`Content-Range` truncation flag decides for plain (un-ranged) fetches.
    static func remainingBytesExist(
        responseTruncated: Bool,
        requestedByteCount: Int64? = nil,
        receivedByteCount: Int,
        loadedByteCount: Int,
        knownFileSize: Int64?
    ) -> Bool {
        if let knownFileSize {
            return Int64(loadedByteCount) < knownFileSize
        }
        if receivedByteCount == 0 {
            return false
        }
        if let requestedByteCount, Int64(receivedByteCount) < requestedByteCount {
            return false
        }
        return responseTruncated
    }

    /// Split text into chunks of at most `linesPerChunk` lines, preserving content
    /// exactly (joining the chunks with newlines reproduces the input).
    static func chunkedLines(_ text: String, linesPerChunk: Int = monoChunkLineCount) -> [String] {
        guard !text.isEmpty else { return [] }
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
        guard lines.count > linesPerChunk else { return [text] }
        var chunks: [String] = []
        chunks.reserveCapacity(lines.count / linesPerChunk + 1)
        var index = 0
        while index < lines.count {
            let end = min(index + linesPerChunk, lines.count)
            chunks.append(lines[index..<end].joined(separator: "\n"))
            index = end
        }
        return chunks
    }

    private func applyDerivedContent() {
        switch kind {
        case .text, .markdown, .table:
            text = String(decoding: data, as: UTF8.self)
            textChunks = Self.chunkedLines(text)
        case .image:
            image = UIImage(data: data)
        case .binary, .web:
            break
        }
        if kind != .binary || !hasMoreBytes {
            refreshShareFile()
        }
    }

    private func refreshShareFile() {
        guard !data.isEmpty else { return }
        do {
            let directory = try ensureShareDirectory()
            let fileURL = directory.appendingPathComponent(entry.displayName)
            try data.write(to: fileURL, options: .atomic)
            shareURL = fileURL
        } catch {
            shareURL = nil
        }
    }

    private func ensureShareDirectory() throws -> URL {
        if let shareDirectoryURL {
            return shareDirectoryURL
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-file-viewer-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        shareDirectoryURL = directory
        return directory
    }
}

/// Read-only viewer for one `.file` browser route, switching its surface on
/// `RelayFileViewerKind`. PDF/HTML render full-bleed through `AuthenticatedWebView`
/// (which owns its chrome, like the Library's POC pages); every other kind fetches bytes
/// and shows them under the standard nav bar with Copy path / Share and per-kind toggles.
struct FileViewerView: View {
    @StateObject private var viewModel: FileViewerViewModel
    @ObservedObject private var identityStore: ClientIdentityStore
    private let client: CodexClient

    @State private var wrapsText = true
    @State private var showsRawMarkdown = false
    @Environment(\.scenePhase) private var scenePhase

    init(client: CodexClient, identityStore: ClientIdentityStore, entry: CodexWorkspaceDirectoryEntry) {
        _viewModel = StateObject(wrappedValue: FileViewerViewModel(client: client, entry: entry))
        _identityStore = ObservedObject(wrappedValue: identityStore)
        self.client = client
    }

    var body: some View {
        if viewModel.kind == .web, let url = client.fileWebViewURL(path: viewModel.entry.path) {
            AuthenticatedWebView(
                url: url,
                title: viewModel.entry.displayName,
                identityStore: identityStore
            )
        } else {
            fetchedContent
        }
    }

    // MARK: - Fetched kinds (text / markdown / image / binary)

    private var fetchedContent: some View {
        VStack(spacing: 0) {
            gitStatusBar
            ZStack {
                content
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(AppTheme.canvasGradient.ignoresSafeArea())
        .navigationTitle(viewModel.entry.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .toolbarBackground(AppTheme.canvasBottom, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .task {
            await viewModel.loadIfNeeded()
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            await viewModel.watchGitStatus()
        }
    }

    @ViewBuilder
    private var gitStatusBar: some View {
        if let branch = viewModel.gitStatus?.branchLabel {
            RelayGitStatusBar(
                branch: branch,
                added: viewModel.gitStatus?.added ?? 0,
                deleted: viewModel.gitStatus?.deleted ?? 0
            )
        }
    }

    @ViewBuilder
    private var content: some View {
        if viewModel.data.isEmpty, viewModel.isLoading {
            ProgressView()
                .tint(AppTheme.accent)
        } else if viewModel.data.isEmpty, let error = viewModel.errorMessage {
            errorState(error)
        } else {
            switch viewModel.kind {
            case .text:
                textContent(forceWrap: false)
            case .markdown:
                markdownContent
            case .table:
                RelayDelimitedTableView(
                    text: viewModel.text,
                    delimiter: viewModel.entry.displayName.lowercased().hasSuffix(".tsv") ? "\t" : ","
                )
            case .image:
                imageContent
            case .binary, .web:
                fallbackContent
            }
        }
    }

    private func textContent(forceWrap: Bool) -> some View {
        VStack(spacing: 0) {
            inlineErrorBanner
            if viewModel.text.isEmpty {
                Text("This file is empty.")
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textTertiary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(16)
            } else {
                RelayNumberedCodeView(
                    text: viewModel.text,
                    fileName: viewModel.entry.displayName,
                    highlight: viewModel.entry.fileCategory == .code,
                    wraps: forceWrap || wrapsText,
                    addedLines: viewModel.gitStatus?.addedLines ?? [],
                    removedAt: viewModel.gitStatus?.removedAt ?? []
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            statusRows
        }
    }

    private var markdownContent: some View {
        Group {
            if showsRawMarkdown {
                textContent(forceWrap: true)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        inlineErrorBanner
                        RelayMarkdownText(text: viewModel.text, userAligned: false)
                            .padding(16)
                        statusRows
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }

    @ViewBuilder
    private var imageContent: some View {
        if let image = viewModel.image {
            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 0) {
                        inlineErrorBanner
                        Spacer(minLength: 12)
                        imageCanvas(image, fitWidth: max(proxy.size.width - 32, 1))
                        Spacer(minLength: 12)
                        statusRows
                    }
                    .frame(width: proxy.size.width)
                    .frame(minHeight: proxy.size.height)
                }
            }
        } else {
            // Bytes arrived but did not decode as a bitmap (e.g. SVG) — fall back to the
            // placeholder so the file can still be shared to an app that can open it.
            fallbackContent
        }
    }

    /// Centered bitmap at intrinsic pixel size, downscaled to fit the width and never
    /// upscaled beyond 2x — a 1x1 test PNG stays a dot instead of a full-screen square —
    /// with a `width × height px · file size` caption beneath.
    private func imageCanvas(_ image: UIImage, fitWidth: CGFloat) -> some View {
        let pixelWidth = max(image.size.width * image.scale, 1)
        let pixelHeight = max(image.size.height * image.scale, 1)
        let displayScale = min(fitWidth / pixelWidth, 2)
        return VStack(spacing: 12) {
            Image(uiImage: image)
                .resizable()
                .frame(width: pixelWidth * displayScale, height: pixelHeight * displayScale)
            Text(imageMetadataLabel(pixelWidth: pixelWidth, pixelHeight: pixelHeight))
                .font(AppTheme.uiFont(size: 12))
                .foregroundStyle(AppTheme.textSecondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func imageMetadataLabel(pixelWidth: CGFloat, pixelHeight: CGFloat) -> String {
        let dimensions = "\(Int(pixelWidth.rounded())) × \(Int(pixelHeight.rounded())) px"
        let size = viewModel.entry.sizeLabel ?? viewModel.loadedByteLabel
        return "\(dimensions) · \(size)"
    }

    /// Quick Look covers common documents (Excel, Word, PowerPoint, archives and media).
    /// If the platform cannot render one, the same staged file remains shareable.
    @ViewBuilder private var fallbackContent: some View {
        if let shareURL = viewModel.shareURL {
            RelayQuickLookPreview(fileURL: shareURL)
        } else {
            VStack(spacing: 14) {
            Image(systemName: viewModel.entry.browserGlyph)
                .font(.system(size: 30, weight: .semibold))
                .foregroundStyle(AppTheme.accent)

            Text(viewModel.entry.displayName)
                .font(AppTheme.serifFont(size: 20))
                .foregroundStyle(AppTheme.textPrimary)
                .multilineTextAlignment(.center)

            VStack(spacing: 5) {
                Text("No inline preview for this file type.")
                    .font(AppTheme.uiFont(size: 13))
                    .foregroundStyle(AppTheme.textSecondary)
                Text(viewModel.entry.path)
                    .font(AppTheme.monoFont(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(2)
                    .truncationMode(.head)
                    .multilineTextAlignment(.center)
            }

            if let shareURL = viewModel.shareURL {
                ShareLink(item: shareURL) {
                    Label("Share file", systemImage: "square.and.arrow.up")
                        .font(AppTheme.uiFont(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                        .overlay(Capsule().stroke(AppTheme.hairlineStrong, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }

            if let error = viewModel.errorMessage {
                FileViewerErrorBanner(text: error)
            }
            }
            .padding(.horizontal, 28)
        }
    }

    // MARK: - Shared rows

    /// Non-fatal errors (e.g. a failed "Load more") shown above content that did load.
    @ViewBuilder
    private var inlineErrorBanner: some View {
        if !viewModel.data.isEmpty, let error = viewModel.errorMessage {
            FileViewerErrorBanner(text: error)
                .padding(.horizontal, 16)
                .padding(.top, 10)
        }
    }

    /// Byte-cap truncation banner + "Load more" beneath the loaded content.
    @ViewBuilder
    private var statusRows: some View {
        if viewModel.hasMoreBytes {
            VStack(spacing: 8) {
                Text(viewModel.truncationLabel)
                    .font(AppTheme.uiFont(size: 12))
                    .foregroundStyle(AppTheme.textSecondary)
                Button {
                    Task { await viewModel.loadMore() }
                } label: {
                    if viewModel.isLoadingMore {
                        ProgressView()
                            .controlSize(.small)
                            .tint(AppTheme.accent)
                    } else {
                        Text("Load more")
                            .font(AppTheme.uiFont(size: 14, weight: .semibold))
                            .foregroundStyle(AppTheme.accent)
                    }
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isLoadingMore)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 16)
            .overlay(alignment: .top) {
                Rectangle()
                    .fill(AppTheme.hairline)
                    .frame(height: 0.5)
            }
        }
    }

    private func errorState(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 28, weight: .medium))
                .foregroundStyle(AppTheme.statusError)
            Text("Could not open this file")
                .font(AppTheme.uiFont(size: 16, weight: .semibold))
                .foregroundStyle(AppTheme.textPrimary)
            Text(message)
                .font(AppTheme.uiFont(size: 13))
                .foregroundStyle(AppTheme.textSecondary)
                .multilineTextAlignment(.center)
            Button {
                Task { await viewModel.load() }
            } label: {
                Text("Try again")
                    .font(AppTheme.uiFont(size: 14, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 32)
    }

    // MARK: - Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text(viewModel.entry.displayName)
                    .font(AppTheme.serifFont(size: 16))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(1)
                if let metadata = metadataLine {
                    Text(metadata)
                        .font(AppTheme.monoFont(size: 10))
                        .foregroundStyle(AppTheme.textTertiary)
                        .lineLimit(1)
                }
            }
        }

        if viewModel.kind == .text {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button {
                        wrapsText = true
                    } label: {
                        Label("Wrap long lines", systemImage: wrapsText ? "checkmark" : "return")
                    }
                    Button {
                        wrapsText = false
                    } label: {
                        Label("Scroll horizontally", systemImage: wrapsText ? "arrow.left.and.right" : "checkmark")
                    }
                } label: {
                    Image(systemName: "textformat")
                }
                .accessibilityLabel(wrapsText ? "Text layout, wrapped" : "Text layout, horizontal scrolling")
                .accessibilityIdentifier("relay-viewer-wrap-toggle")
            }
        }

        if viewModel.kind == .markdown {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showsRawMarkdown.toggle()
                } label: {
                    Image(systemName: showsRawMarkdown ? "doc.richtext" : "curlybraces")
                }
                .accessibilityLabel(showsRawMarkdown ? "Show rendered markdown" : "Show raw markdown")
                .accessibilityIdentifier("relay-viewer-raw-toggle")
            }
        }

        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button {
                    UIPasteboard.general.string = viewModel.entry.path
                } label: {
                    Label("Copy path", systemImage: "doc.on.doc")
                }
                if let shareURL = viewModel.shareURL {
                    ShareLink(item: shareURL) {
                        Label("Share", systemImage: "square.and.arrow.up")
                    }
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .accessibilityLabel("File options")
        }
    }

    private var metadataLine: String? {
        let parts = [viewModel.entry.sizeLabel, viewModel.entry.mtimeLabel].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

private struct FileViewerErrorBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .font(AppTheme.uiFont(size: 13))
            .foregroundStyle(AppTheme.statusError)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .overlay {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(AppTheme.statusError.opacity(0.3), lineWidth: 1)
            }
    }
}

/// One quiet row under the folder path or the file title: branch, then the
/// working-tree line counts. Zeros stay off the row so a clean file is just
/// the branch, and the counts tick as saves land.
struct RelayGitStatusBar: View {
    let branch: String
    let added: Int
    let deleted: Int

    private static let additionInk = Color(red: 0.62, green: 0.75, blue: 0.56)

    var body: some View {
        HStack(spacing: 0) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(AppTheme.textTertiary)
                .padding(.trailing, 6)
            Text(branch)
                .font(AppTheme.monoFont(size: 11, weight: .medium))
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(-1)
            Spacer(minLength: 12)
            HStack(spacing: 8) {
                if added > 0 {
                    Text("+\(added)")
                        .foregroundStyle(Self.additionInk)
                }
                if deleted > 0 {
                    Text("−\(deleted)")
                        .foregroundStyle(AppTheme.statusError)
                }
            }
            .font(AppTheme.monoFont(size: 11, weight: .medium))
            .monospacedDigit()
            .fixedSize(horizontal: true, vertical: false)
            .layoutPriority(1)
        }
        .padding(.horizontal, 16)
        .frame(height: 28)
        .background(AppTheme.canvasBottom)
        .overlay(alignment: .bottom) {
            Rectangle().fill(AppTheme.hairline).frame(height: 0.5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityIdentifier("relay-git-status")
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        var parts = ["Branch \(branch)"]
        if added > 0 { parts.append("\(added) lines added") }
        if deleted > 0 { parts.append("\(deleted) lines removed") }
        return parts.joined(separator: ", ")
    }
}

/// Character indexes where each editor line begins. A trailing newline does
/// not invent an extra line, matching the gutter in a typical editor.
enum RelaySourceLineIndex {
    static func starts(in text: String) -> [Int] {
        guard !text.isEmpty else { return [] }
        let ns = text as NSString
        var starts: [Int] = []
        var index = 0
        while index < ns.length {
            starts.append(index)
            let range = ns.lineRange(for: NSRange(location: index, length: 0))
            let next = NSMaxRange(range)
            if next <= index { break }
            index = next
        }
        return starts
    }

    static func lineNumber(containing character: Int, starts: [Int]) -> Int {
        guard !starts.isEmpty else { return 0 }
        var low = 0
        var high = starts.count - 1
        var found = 0
        while low <= high {
            let mid = (low + high) / 2
            if starts[mid] <= character {
                found = mid
                low = mid + 1
            } else {
                high = mid - 1
            }
        }
        return found
    }

    static func gutterWidth(lineCount: Int) -> CGFloat {
        let digits = max(2, String(max(lineCount, 1)).count)
        return CGFloat(digits) * 7.2 + 18
    }
}

/// Read-only code surface: a pinned line-number gutter and a text view that
/// keeps selection. The gutter stays put while the code scrolls sideways.
struct RelayNumberedCodeView: UIViewRepresentable {
    let text: String
    let fileName: String
    let highlight: Bool
    let wraps: Bool
    var addedLines: [[Int]] = []
    var removedAt: [Int] = []

    func makeUIView(context: Context) -> RelayCodeCanvasView {
        let view = RelayCodeCanvasView()
        view.apply(
            text: text,
            fileName: fileName,
            highlight: highlight,
            wraps: wraps,
            addedLines: addedLines,
            removedAt: removedAt
        )
        return view
    }

    func updateUIView(_ view: RelayCodeCanvasView, context: Context) {
        view.apply(
            text: text,
            fileName: fileName,
            highlight: highlight,
            wraps: wraps,
            addedLines: addedLines,
            removedAt: removedAt
        )
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: RelayCodeCanvasView, context: Context) -> CGSize? {
        guard let width = proposal.width, let height = proposal.height, width.isFinite, height.isFinite else {
            return nil
        }
        return CGSize(width: width, height: height)
    }
}

final class RelayCodeCanvasView: UIView, UITextViewDelegate {
    private let gutter = RelayCodeGutterView()
    private let textView = UITextView(usingTextLayoutManager: false)
    private var gutterWidthConstraint: NSLayoutConstraint?
    private var lineStarts: [Int] = []
    private var appliedText: String?
    private var appliedFileName = ""
    private var appliedHighlight = false
    private var appliedWraps = true
    private var addedLines: [[Int]] = []
    private var removedAt: [Int] = []

    private let codeFont = UIFont(name: "DMMono-Regular", size: 12) ?? UIFont.monospacedSystemFont(ofSize: 12, weight: .regular)
    private let gutterFont = UIFont(name: "DMMono-Regular", size: 11) ?? UIFont.monospacedSystemFont(ofSize: 11, weight: .regular)
    private let ink = UIColor(red: 237 / 255, green: 232 / 255, blue: 223 / 255, alpha: 1)
    private let gutterInk = UIColor(red: 237 / 255, green: 232 / 255, blue: 223 / 255, alpha: 0.38)
    private let additionInk = UIColor(red: 0.62, green: 0.75, blue: 0.56, alpha: 1)
    private let deletionInk = UIColor(red: 217 / 255, green: 119 / 255, blue: 107 / 255, alpha: 1)
    private let hairline = UIColor(red: 237 / 255, green: 232 / 255, blue: 223 / 255, alpha: 0.10)

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        gutter.canvas = self
        gutter.backgroundColor = .clear
        gutter.isUserInteractionEnabled = false
        gutter.isAccessibilityElement = false
        gutter.translatesAutoresizingMaskIntoConstraints = false

        textView.backgroundColor = .clear
        textView.isEditable = false
        textView.isSelectable = true
        textView.tintColor = UIColor(red: 212 / 255, green: 128 / 255, blue: 74 / 255, alpha: 1)
        textView.textContainer.lineFragmentPadding = 0
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 16)
        textView.contentInsetAdjustmentBehavior = .never
        textView.indicatorStyle = .white
        textView.alwaysBounceVertical = true
        textView.autocorrectionType = .no
        textView.autocapitalizationType = .none
        textView.spellCheckingType = .no
        textView.smartDashesType = .no
        textView.smartQuotesType = .no
        textView.smartInsertDeleteType = .no
        textView.dataDetectorTypes = []
        textView.adjustsFontForContentSizeCategory = false
        textView.delegate = self
        textView.translatesAutoresizingMaskIntoConstraints = false

        addSubview(gutter)
        addSubview(textView)
        let width = gutter.widthAnchor.constraint(equalToConstant: RelaySourceLineIndex.gutterWidth(lineCount: 1))
        gutterWidthConstraint = width
        NSLayoutConstraint.activate([
            gutter.leadingAnchor.constraint(equalTo: leadingAnchor),
            gutter.topAnchor.constraint(equalTo: topAnchor),
            gutter.bottomAnchor.constraint(equalTo: bottomAnchor),
            width,
            textView.leadingAnchor.constraint(equalTo: gutter.trailingAnchor),
            textView.trailingAnchor.constraint(equalTo: trailingAnchor),
            textView.topAnchor.constraint(equalTo: topAnchor),
            textView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        setContentCompressionResistancePriority(.defaultLow, for: .vertical)
        setContentHuggingPriority(.defaultLow, for: .vertical)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { nil }

    override func layoutSubviews() {
        super.layoutSubviews()
        gutter.setNeedsDisplay()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        gutter.setNeedsDisplay()
    }

    func apply(
        text: String,
        fileName: String,
        highlight: Bool,
        wraps: Bool,
        addedLines: [[Int]],
        removedAt: [Int]
    ) {
        let marksChanged = self.addedLines != addedLines || self.removedAt != removedAt
        self.addedLines = addedLines
        self.removedAt = removedAt
        if appliedText == text, appliedFileName == fileName, appliedHighlight == highlight, appliedWraps == wraps {
            if marksChanged {
                updateGutterWidth()
                gutter.setNeedsDisplay()
            }
            return
        }
        let offset = textView.contentOffset
        let hadText = appliedText != nil
        appliedText = text
        appliedFileName = fileName
        appliedHighlight = highlight
        appliedWraps = wraps

        configureWrap(wraps)
        textView.attributedText = attributed(text: text, fileName: fileName, highlight: highlight, wraps: wraps)
        lineStarts = RelaySourceLineIndex.starts(in: text)
        updateGutterWidth()
        if hadText {
            textView.layoutIfNeeded()
            let maxOffset = max(0, textView.contentSize.height - textView.bounds.height)
            textView.setContentOffset(CGPoint(x: offset.x, y: min(offset.y, maxOffset)), animated: false)
        }
        gutter.setNeedsDisplay()
    }

    private func updateGutterWidth() {
        let extra: CGFloat = removedAt.isEmpty ? 0 : 10
        gutterWidthConstraint?.constant = RelaySourceLineIndex.gutterWidth(lineCount: lineStarts.count) + extra
    }

    func drawGutter() {
        guard gutter.bounds.height > 0, !lineStarts.isEmpty else { return }
        let layoutManager = textView.layoutManager
        layoutManager.ensureLayout(for: textView.textContainer)
        let length = textView.textStorage.length
        guard length > 0 else { return }
        let container = textView.textContainer
        let originY = textView.textContainerInset.top
        let attributes: [NSAttributedString.Key: Any] = [
            .font: gutterFont,
            .foregroundColor: gutterInk,
        ]
        let lookupY = max(0, textView.contentOffset.y - originY)
        var fraction: CGFloat = 0
        let glyph = layoutManager.glyphIndex(
            for: CGPoint(x: 1, y: lookupY),
            in: container,
            fractionOfDistanceThroughGlyph: &fraction
        )
        let character = min(layoutManager.characterIndexForGlyph(at: glyph), length - 1)
        var line = RelaySourceLineIndex.lineNumber(containing: character, starts: lineStarts)

        while line < lineStarts.count {
            let charIndex = lineStarts[line]
            if charIndex >= length { break }
            let glyphIndex = layoutManager.glyphIndexForCharacter(at: charIndex)
            let fragment = layoutManager.lineFragmentRect(forGlyphAt: glyphIndex, effectiveRange: nil)
            let viewY = originY + fragment.minY - textView.contentOffset.y
            if viewY > gutter.bounds.height { break }
            if viewY + fragment.height >= 0 {
                let lineNumber = line + 1
                let added = marksAddedLine(lineNumber)
                let removed = removedAt.contains(lineNumber)
                var lineAttributes = attributes
                if added { lineAttributes[.foregroundColor] = additionInk }
                let label = "\(lineNumber)" as NSString
                let size = label.size(withAttributes: lineAttributes)
                let y = viewY + max(0, (fragment.height - size.height) / 2)
                label.draw(
                    at: CGPoint(x: gutter.bounds.width - 10 - size.width, y: y),
                    withAttributes: lineAttributes
                )
                if removed {
                    let mark = "−" as NSString
                    var markAttributes = attributes
                    markAttributes[.foregroundColor] = deletionInk
                    let markSize = mark.size(withAttributes: markAttributes)
                    mark.draw(
                        at: CGPoint(x: 2, y: y + max(0, (size.height - markSize.height) / 2)),
                        withAttributes: markAttributes
                    )
                }
            }
            line += 1
        }

        if let context = UIGraphicsGetCurrentContext() {
            context.setFillColor(hairline.cgColor)
            context.fill(CGRect(x: gutter.bounds.width - 0.5, y: 0, width: 0.5, height: gutter.bounds.height))
        }
    }

    private func marksAddedLine(_ line: Int) -> Bool {
        addedLines.contains { span in
            span.count == 2 && line >= span[0] && line <= span[1]
        }
    }

    private func configureWrap(_ wraps: Bool) {
        if wraps {
            textView.textContainer.widthTracksTextView = true
            textView.textContainer.lineBreakMode = .byWordWrapping
        } else {
            textView.textContainer.widthTracksTextView = false
            textView.textContainer.lineBreakMode = .byClipping
            textView.textContainer.size = CGSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        }
        textView.alwaysBounceHorizontal = !wraps
        textView.showsHorizontalScrollIndicator = !wraps
    }

    private func attributed(text: String, fileName: String, highlight: Bool, wraps: Bool) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        paragraph.lineBreakMode = wraps ? .byWordWrapping : .byClipping
        let rangeAttributes: [NSAttributedString.Key: Any] = [
            .font: codeFont,
            .paragraphStyle: paragraph,
        ]
        if highlight {
            let mutable = NSMutableAttributedString(RelayCodeSyntax.highlighted(text, fileName: fileName))
            mutable.addAttributes(rangeAttributes, range: NSRange(location: 0, length: mutable.length))
            return mutable
        }
        var plain = rangeAttributes
        plain[.foregroundColor] = ink
        return NSAttributedString(string: text, attributes: plain)
    }
}

private final class RelayCodeGutterView: UIView {
    weak var canvas: RelayCodeCanvasView?

    override func draw(_ rect: CGRect) {
        canvas?.drawGutter()
    }
}
