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

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment.kind {
                case .prose:
                    RelayMarkdownProse(
                        text: segment.text,
                        color: userAligned ? AppTheme.onEmber : AppTheme.textPrimary,
                        isOnAccent: userAligned
                    )
                case .code(let language):
                    RelayCodeBlock(text: segment.text, language: language)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var segments: [CodexMarkdownSegment] {
        CodexMarkdownParser.segments(from: text)
    }
}

struct RelayMarkdownProse: View {
    let text: String
    let color: Color
    let isOnAccent: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
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
                        .font(AppTheme.uiFont(size: 14))
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
        CodexMarkdownParser.proseBlocks(from: text)
    }

    private func listRow(marker: String, text: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Text(marker)
                .font(AppTheme.uiFont(size: 13, weight: .semibold))
                .foregroundStyle(color.opacity(0.78))
                .frame(width: 22, alignment: .trailing)
            Text(inlineMarkdown(text))
                .font(AppTheme.uiFont(size: 14))
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
            if !header.isEmpty {
                tableRow(header, isHeader: true)
            }

            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 || !header.isEmpty {
                    Divider()
                        .overlay(borderColor.opacity(0.72))
                }
                tableRow(row, isHeader: false)
            }
        }
        .background(tableFill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(borderColor, lineWidth: 0.75)
        }
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .textSelection(.enabled)
    }

    private func tableRow(_ row: [String], isHeader: Bool) -> some View {
        Group {
            if row.count == 2 {
                HStack(alignment: .top, spacing: 10) {
                    tableCell(row[0], isHeader: isHeader)
                        .frame(maxWidth: 104, alignment: .leading)
                        .layoutPriority(0.35)
                    tableCell(row[1], isHeader: isHeader)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .layoutPriority(1)
                }
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(row.enumerated()), id: \.offset) { index, value in
                        VStack(alignment: .leading, spacing: 3) {
                            if !isHeader, header.indices.contains(index), !header[index].isEmpty {
                                Text(CodexInlineMarkdown.attributed(header[index]))
                                    .font(AppTheme.uiFont(size: 11, weight: .bold))
                                    .foregroundStyle(color.opacity(0.68))
                            }
                            tableCell(value, isHeader: isHeader)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, isHeader ? 8 : 9)
    }

    private func tableCell(_ value: String, isHeader: Bool) -> some View {
        Text(CodexInlineMarkdown.attributed(value))
            .font(AppTheme.uiFont(size: isHeader ? 12 : 13.5, weight: isHeader ? .semibold : .regular))
            .foregroundStyle(isHeader ? color.opacity(0.72) : color)
            .lineSpacing(2)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var tableFill: Color {
        isOnAccent ? AppTheme.onEmber.opacity(0.10) : Color.clear
    }

    private var borderColor: Color {
        isOnAccent ? AppTheme.bgCanvas.opacity(0.24) : AppTheme.hairline
    }
}

struct RelayCodeBlock: View {
    let text: String
    let language: String?
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

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
            if dynamicTypeSize.isAccessibilitySize {
                // Accessibility sizes would wrap mono text mid-token ("qu ery");
                // keep lines intact and let the block scroll sideways instead.
                ScrollView(.horizontal, showsIndicators: false) {
                    codeText
                        .fixedSize(horizontal: true, vertical: false)
                }
            } else {
                codeText
            }
        }
        .padding(10)
        .background(AppTheme.textPrimary.opacity(0.05), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var codeText: some View {
        Text(text)
            .font(AppTheme.monoFont(size: 12))
            .foregroundStyle(AppTheme.textPrimary)
            .textSelection(.enabled)
            .lineLimit(24)
    }

    private var languageLabel: String {
        language?.trimmedNonEmpty?.uppercased() ?? "Code"
    }
}
