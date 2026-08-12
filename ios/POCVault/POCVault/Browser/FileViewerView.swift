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

    private var hasLoaded = false
    private var shareDirectoryURL: URL?

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
        case .text, .markdown:
            text = String(decoding: data, as: UTF8.self)
            textChunks = Self.chunkedLines(text)
        case .image:
            image = UIImage(data: data)
        case .binary, .web:
            break
        }
        refreshShareFile()
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
        ZStack {
            AppTheme.canvasGradient.ignoresSafeArea()
            content
        }
        .navigationTitle(viewModel.entry.displayName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .task {
            await viewModel.loadIfNeeded()
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
                textContent(raw: false)
            case .markdown:
                markdownContent
            case .image:
                imageContent
            case .binary, .web:
                fallbackContent
            }
        }
    }

    private func textContent(raw: Bool) -> some View {
        Group {
            if raw || wrapsText {
                ScrollView {
                    scrollBody
                }
            } else {
                ScrollView([.horizontal, .vertical]) {
                    scrollBody
                }
            }
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var scrollBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            inlineErrorBanner
            monoText
            statusRows
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var monoText: some View {
        if viewModel.textChunks.isEmpty {
            Text("This file is empty.")
                .font(AppTheme.monoFont(size: 12))
                .foregroundStyle(AppTheme.textTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
        } else {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(viewModel.textChunks.enumerated()), id: \.offset) { _, chunk in
                    Text(chunk)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textPrimary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: !wrapsText, vertical: false)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(16)
        }
    }

    private var markdownContent: some View {
        Group {
            if showsRawMarkdown {
                textContent(raw: true)
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

    /// Binary fallback (also used for undecodable images): file icon, identity, share.
    private var fallbackContent: some View {
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
                Button {
                    wrapsText.toggle()
                } label: {
                    Image(systemName: wrapsText ? "arrow.left.and.right" : "return")
                }
                .accessibilityLabel(wrapsText ? "Scroll long lines horizontally" : "Wrap long lines")
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
