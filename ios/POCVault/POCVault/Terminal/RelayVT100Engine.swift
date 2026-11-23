import Foundation
import SwiftUI
import UIKit

/// Pure Swift, zero-dependency VT100/xterm ANSI terminal emulator engine.
///
/// Maintains a 2D character cell grid, amortized-O(1) scrollback buffer,
/// alternate screen buffer (`?1049h`/`?1049l`, `?47h`/`?47l`), stateful parser
/// resilient to escape sequences split across stream chunks, and coalesced
/// `NSAttributedString` rendering.
final class RelayVT100Engine {

    // MARK: - Cell & Style Types

    enum ColorValue: Equatable, Hashable {
        case `default`
        case ansi(UInt8)               // 0...15 (0-7 standard, 8-15 bright)
        case indexed(UInt8)            // 0...255 (xterm 256-color palette)
        case rgb(UInt8, UInt8, UInt8)  // 24-bit truecolor
    }

    struct Attributes: OptionSet, Equatable, Hashable {
        let rawValue: UInt8

        static let bold          = Attributes(rawValue: 1 << 0)
        static let dim           = Attributes(rawValue: 1 << 1)
        static let italic        = Attributes(rawValue: 1 << 2)
        static let underline     = Attributes(rawValue: 1 << 3)
        static let inverse       = Attributes(rawValue: 1 << 4)
        static let hidden        = Attributes(rawValue: 1 << 5)
        static let strikethrough = Attributes(rawValue: 1 << 6)
    }

    struct Style: Equatable, Hashable {
        var fg: ColorValue = .default
        var bg: ColorValue = .default
        var attrs: Attributes = []

        static let `default` = Style()

        var eraseStyle: Style {
            Style(fg: .default, bg: bg, attrs: [])
        }
    }

    struct Cell: Equatable {
        var character: Character = " "
        var style: Style = .default
        /// Visual cell width: 1 = normal, 2 = leading half of wide glyph, 0 = trailing continuation.
        var width: UInt8 = 1

        static let blank = Cell()

        static func blank(style: Style) -> Cell {
            Cell(character: " ", style: style.eraseStyle, width: 1)
        }

        var isVisuallyBlank: Bool {
            width == 1 && character == " " && style.bg == .default && !style.attrs.contains(.inverse)
        }
    }

    // MARK: - Constants

    static let maxScrollbackLines = 3_000
    private static let scrollbackCompactionThreshold = 512
    private static let maxOSCBufferScalars = 4_096
    private static let maxCSIParams = 32
    private static let maxCSISubparams = 8
    private static let maxCSIIntermediates = 4

    // MARK: - Public State

    private(set) var cols: Int
    private(set) var rows: Int
    private(set) var cursorRow: Int = 0
    private(set) var cursorCol: Int = 0
    private(set) var isCursorVisible: Bool = true
    private(set) var isAlternateScreenActive: Bool = false
    private(set) var applicationCursorKeys: Bool = false
    private(set) var bracketedPasteMode: Bool = false
    private(set) var autoWrapMode: Bool = true
    private(set) var originMode: Bool = false
    private(set) var windowTitle: String = ""
    private(set) var contentVersion: UInt64 = 0

    var onTitleChange: ((String) -> Void)?
    var onBell: (() -> Void)?

    var scrollbackCount: Int {
        max(0, scrollback.count - scrollbackStart)
    }

    // MARK: - Internal Buffers & Modes

    private var mainGrid: [[Cell]]
    private var altGrid: [[Cell]]
    private var scrollback: [[Cell]] = []
    private var scrollbackStart: Int = 0

    private var scrollTop: Int
    private var scrollBottom: Int
    private var currentStyle: Style = .default
    private var pendingWrap: Bool = false
    private var tabStops: Set<Int> = []

    private var g0LineDrawing: Bool = false
    private var g1LineDrawing: Bool = false
    private var useG1Charset: Bool = false

    private var lastWrittenPosition: (row: Int, col: Int)?

    private struct SavedCursor {
        var row: Int
        var col: Int
        var style: Style
        var originMode: Bool
        var autoWrapMode: Bool
        var pendingWrap: Bool
        var g0LineDrawing: Bool
        var g1LineDrawing: Bool
        var useG1Charset: Bool
    }

    private var savedMainCursor: SavedCursor?
    private var savedAltCursor: SavedCursor?
    private var altScreenSavedMainCursor: SavedCursor?

    // MARK: - Stateful Escape Parser

    private enum ParserState {
        case ground
        case escape
        case escapeCharset(slot: Int)
        case escapeHash
        case csiEntry
        case oscString
        case oscEscape
        case stringSkip
        case stringSkipEscape
    }

    private struct CSIParam {
        var value: Int?
        var subparams: [Int] = []
    }

    private var parserState: ParserState = .ground
    private var csiPrivatePrefix: UInt8?
    private var csiParams: [CSIParam] = []
    private var csiCurrentParam: CSIParam?
    private var csiInSubparam: Bool = false
    private var csiCurrentSubparamValue: Int?
    private var csiIntermediates: [UInt8] = []
    private var oscBuffer: String = ""

    // MARK: - Lifecycle

    init(cols: Int = 80, rows: Int = 24) {
        let clampedCols = Self.clampCols(cols)
        let clampedRows = Self.clampRows(rows)
        self.cols = clampedCols
        self.rows = clampedRows
        self.scrollTop = 0
        self.scrollBottom = clampedRows - 1
        self.mainGrid = Self.makeBlankGrid(cols: clampedCols, rows: clampedRows)
        self.altGrid = Self.makeBlankGrid(cols: clampedCols, rows: clampedRows)
        rebuildDefaultTabStops()
    }

    // MARK: - Public API

    func feed(_ text: String) {
        guard !text.isEmpty else { return }

        for scalar in text.unicodeScalars {
            processScalar(scalar)
        }
        contentVersion &+= 1
    }

    func resize(cols newColsRaw: Int, rows newRowsRaw: Int) {
        let newCols = Self.clampCols(newColsRaw)
        let newRows = Self.clampRows(newRowsRaw)
        guard newCols != cols || newRows != rows else { return }

        if isAlternateScreenActive {
            altGrid = resizeAltGrid(altGrid, newCols: newCols, newRows: newRows)
            mainGrid = resizeMainGridNonActive(mainGrid, newCols: newCols, newRows: newRows)
        } else {
            resizeActiveMainGrid(newCols: newCols, newRows: newRows)
            altGrid = Self.makeBlankGrid(cols: newCols, rows: newRows)
        }

        cols = newCols
        rows = newRows
        scrollTop = 0
        scrollBottom = newRows - 1
        cursorRow = min(max(0, cursorRow), newRows - 1)
        cursorCol = min(max(0, cursorCol), newCols - 1)
        pendingWrap = false
        lastWrittenPosition = nil
        rebuildDefaultTabStops()
        contentVersion &+= 1
    }

    func reset() {
        mainGrid = Self.makeBlankGrid(cols: cols, rows: rows)
        altGrid = Self.makeBlankGrid(cols: cols, rows: rows)
        scrollback.removeAll(keepingCapacity: true)
        scrollbackStart = 0
        isAlternateScreenActive = false
        cursorRow = 0
        cursorCol = 0
        scrollTop = 0
        scrollBottom = rows - 1
        currentStyle = .default
        isCursorVisible = true
        applicationCursorKeys = false
        bracketedPasteMode = false
        autoWrapMode = true
        originMode = false
        pendingWrap = false
        g0LineDrawing = false
        g1LineDrawing = false
        useG1Charset = false
        lastWrittenPosition = nil
        savedMainCursor = nil
        savedAltCursor = nil
        altScreenSavedMainCursor = nil
        resetParser()
        rebuildDefaultTabStops()
        contentVersion &+= 1
    }

    /// Clears scrollback and visible history above the active cursor line,
    /// moving the active prompt line cleanly to row 0 without injecting bytes
    /// into the running shell.
    func clearScrollbackAndHistory() {
        scrollback.removeAll(keepingCapacity: true)
        scrollbackStart = 0

        if !isAlternateScreenActive {
            let activeLine = mainGrid[cursorRow]
            mainGrid = Self.makeBlankGrid(cols: cols, rows: rows)
            mainGrid[0] = activeLine
            cursorRow = 0
            pendingWrap = false
            lastWrittenPosition = nil
        } else {
            altGrid = Self.makeBlankGrid(cols: cols, rows: rows)
            cursorRow = 0
            cursorCol = 0
            pendingWrap = false
            lastWrittenPosition = nil
        }

        contentVersion &+= 1
    }

    func plainTextSnapshot() -> String {
        var outputLines: [String] = []

        if isAlternateScreenActive {
            outputLines.reserveCapacity(rows)
            for row in altGrid {
                outputLines.append(plainLineString(row))
            }
        } else {
            let lastRow = lastVisibleMainRow(includeCursor: false)
            outputLines.reserveCapacity(scrollbackCount + lastRow + 1)
            if scrollbackStart < scrollback.count {
                for idx in scrollbackStart..<scrollback.count {
                    outputLines.append(plainLineString(scrollback[idx]))
                }
            }
            for r in 0...lastRow {
                outputLines.append(plainLineString(mainGrid[r]))
            }
        }

        return outputLines.joined(separator: "\n")
    }

    func renderAttributedText(
        theme: RelayThemePalette,
        font: UIFont,
        showCursor: Bool = true
    ) -> NSAttributedString {
        let palette = ResolvedPalette(theme: theme, baseFont: font)
        let drawCursor = showCursor && isCursorVisible

        var lines: [[Cell]] = []
        let cursorLineIndex: Int

        if isAlternateScreenActive {
            lines = altGrid
            cursorLineIndex = cursorRow
        } else {
            let lastRow = lastVisibleMainRow(includeCursor: drawCursor)
            let sbCount = scrollbackCount
            lines.reserveCapacity(sbCount + lastRow + 1)
            if scrollbackStart < scrollback.count {
                lines.append(contentsOf: scrollback[scrollbackStart..<scrollback.count])
            }
            for r in 0...lastRow {
                lines.append(mainGrid[r])
            }
            cursorLineIndex = sbCount + cursorRow
        }

        guard !lines.isEmpty else {
            return NSAttributedString(string: "", attributes: palette.baseAttributes)
        }

        var fullText = ""
        fullText.reserveCapacity(lines.count * min(cols, 96))

        struct StyledRun {
            let range: NSRange
            let style: Style
            let isCursor: Bool
        }

        var styledRuns: [StyledRun] = []
        styledRuns.reserveCapacity(lines.count * 2)

        var utf16Offset = 0
        let lastLineIdx = lines.count - 1

        for lineIdx in 0..<lines.count {
            let row = lines[lineIdx]
            let isCursorLine = drawCursor && lineIdx == cursorLineIndex

            var effectiveCursorCol = cursorCol
            if isCursorLine && effectiveCursorCol < row.count && row[effectiveCursorCol].width == 0 && effectiveCursorCol > 0 {
                effectiveCursorCol -= 1
            }

            let trimmedEnd = lastNonBlankColumn(in: row)
            let endCol: Int
            if isCursorLine {
                endCol = max(trimmedEnd, effectiveCursorCol)
            } else {
                endCol = trimmedEnd
            }

            if endCol >= 0 {
                var activeStyle = Style.default
                var activeIsCursor = false
                var runStartUTF16 = utf16Offset
                var hasActiveRun = false

                for col in 0...endCol {
                    let cell: Cell = col < row.count ? row[col] : .blank
                    if cell.width == 0 {
                        continue
                    }

                    let cellIsCursor = isCursorLine && col == effectiveCursorCol
                    let cellStyle = cell.style

                    if !hasActiveRun {
                        activeStyle = cellStyle
                        activeIsCursor = cellIsCursor
                        runStartUTF16 = utf16Offset
                        hasActiveRun = true
                    } else if cellStyle != activeStyle || cellIsCursor != activeIsCursor {
                        if activeIsCursor || activeStyle != .default {
                            let length = utf16Offset - runStartUTF16
                            if length > 0 {
                                styledRuns.append(StyledRun(
                                    range: NSRange(location: runStartUTF16, length: length),
                                    style: activeStyle,
                                    isCursor: activeIsCursor
                                ))
                            }
                        }
                        activeStyle = cellStyle
                        activeIsCursor = cellIsCursor
                        runStartUTF16 = utf16Offset
                    }

                    let ch = cell.character
                    fullText.append(ch)
                    if ch.isASCII {
                        utf16Offset += 1
                    } else {
                        for scalar in ch.unicodeScalars {
                            utf16Offset += scalar.utf16.count
                        }
                    }
                }

                if hasActiveRun && (activeIsCursor || activeStyle != .default) {
                    let length = utf16Offset - runStartUTF16
                    if length > 0 {
                        styledRuns.append(StyledRun(
                            range: NSRange(location: runStartUTF16, length: length),
                            style: activeStyle,
                            isCursor: activeIsCursor
                        ))
                    }
                }
            }

            if lineIdx < lastLineIdx {
                fullText.append("\n")
                utf16Offset += 1
            }
        }

        let attributed = NSMutableAttributedString(string: fullText, attributes: palette.baseAttributes)
        if !styledRuns.isEmpty {
            var styleAttrCache: [Style: [NSAttributedString.Key: Any]] = [:]
            styleAttrCache.reserveCapacity(16)
            attributed.beginEditing()
            for run in styledRuns {
                let attrs: [NSAttributedString.Key: Any]
                if run.isCursor {
                    attrs = palette.attributes(for: run.style, isCursor: true)
                } else if let cached = styleAttrCache[run.style] {
                    attrs = cached
                } else {
                    let built = palette.attributes(for: run.style, isCursor: false)
                    styleAttrCache[run.style] = built
                    attrs = built
                }
                attributed.addAttributes(attrs, range: run.range)
            }
            attributed.endEditing()
        }
        return attributed
    }

    // MARK: - Parser State Machine

    private func resetParser() {
        parserState = .ground
        csiPrivatePrefix = nil
        csiParams.removeAll(keepingCapacity: true)
        csiCurrentParam = nil
        csiInSubparam = false
        csiCurrentSubparamValue = nil
        csiIntermediates.removeAll(keepingCapacity: true)
        oscBuffer.removeAll(keepingCapacity: true)
    }

    private func processScalar(_ scalar: UnicodeScalar) {
        let value = scalar.value

        // CAN (0x18) / SUB (0x1A) abort any active escape sequence.
        if value == 0x18 || value == 0x1A {
            parserState = .ground
            return
        }

        switch parserState {
        case .ground:
            processGround(scalar, value: value)

        case .escape:
            processEscape(scalar, value: value)

        case .escapeCharset(let slot):
            let isLineDrawing = (value == 0x30) // '0' = DEC Special Graphics
            if slot == 0 {
                g0LineDrawing = isLineDrawing
            } else if slot == 1 {
                g1LineDrawing = isLineDrawing
            }
            parserState = .ground

        case .escapeHash:
            if value == 0x38 { // ESC # 8 (DECALN)
                fillScreenWithE()
            }
            parserState = .ground

        case .csiEntry:
            processCSI(scalar, value: value)

        case .oscString:
            processOSC(scalar, value: value)

        case .oscEscape:
            if value == 0x5C { // '\' completes ST (ESC \)
                dispatchOSC()
                parserState = .ground
            } else {
                // Interrupted OSC; start fresh ESC dispatch for this scalar.
                oscBuffer.removeAll(keepingCapacity: true)
                parserState = .escape
                processEscape(scalar, value: value)
            }

        case .stringSkip:
            if value == 0x07 || value == 0x9C {
                parserState = .ground
            } else if value == 0x1B {
                parserState = .stringSkipEscape
            }

        case .stringSkipEscape:
            if value == 0x5C {
                parserState = .ground
            } else if value != 0x1B {
                parserState = .stringSkip
            }
        }
    }

    private func processGround(_ scalar: UnicodeScalar, value: UInt32) {
        if value < 0x20 {
            executeC0(value)
            return
        }

        if value == 0x7F {
            // DEL is ignored in ground output stream.
            return
        }

        // 8-bit C1 controls
        if value >= 0x80 && value <= 0x9F {
            switch value {
            case 0x84: // IND
                indexDown()
            case 0x85: // NEL
                cursorCol = 0
                pendingWrap = false
                indexDown()
            case 0x88: // HTS
                tabStops.insert(cursorCol)
            case 0x8D: // RI
                reverseIndex()
            case 0x90, 0x98, 0x9E, 0x9F: // DCS, SOS, PM, APC
                parserState = .stringSkip
            case 0x9B: // CSI
                beginCSI()
            case 0x9D: // OSC
                oscBuffer.removeAll(keepingCapacity: true)
                parserState = .oscString
            default:
                break
            }
            return
        }

        putPrintableScalar(scalar)
    }

    private func executeC0(_ value: UInt32) {
        switch value {
        case 0x07: // BEL
            onBell?()
        case 0x08: // BS
            pendingWrap = false
            lastWrittenPosition = nil
            if cursorCol > 0 {
                cursorCol -= 1
            }
        case 0x09: // HT (Tab)
            pendingWrap = false
            lastWrittenPosition = nil
            cursorCol = nextTabStop(after: cursorCol)
        case 0x0A, 0x0B, 0x0C: // LF, VT, FF
            pendingWrap = false
            lastWrittenPosition = nil
            indexDown()
        case 0x0D: // CR
            cursorCol = 0
            pendingWrap = false
            lastWrittenPosition = nil
        case 0x0E: // SO (Shift Out -> G1)
            useG1Charset = true
        case 0x0F: // SI (Shift In -> G0)
            useG1Charset = false
        case 0x1B: // ESC
            parserState = .escape
        default:
            break
        }
    }

    private func processEscape(_ scalar: UnicodeScalar, value: UInt32) {
        // C0 controls inside ESC execute immediately.
        if value < 0x20 && value != 0x1B {
            executeC0(value)
            return
        }

        switch value {
        case 0x5B: // '[' -> CSI
            beginCSI()
        case 0x5D: // ']' -> OSC
            oscBuffer.removeAll(keepingCapacity: true)
            parserState = .oscString
        case 0x28: // '(' -> Designate G0
            parserState = .escapeCharset(slot: 0)
        case 0x29: // ')' -> Designate G1
            parserState = .escapeCharset(slot: 1)
        case 0x2A, 0x2B: // '*', '+' -> G2/G3 (consume designation byte)
            parserState = .escapeCharset(slot: 2)
        case 0x23: // '#'
            parserState = .escapeHash
        case 0x50, 0x58, 0x5E, 0x5F: // P (DCS), X (SOS), ^ (PM), _ (APC)
            parserState = .stringSkip
        case 0x37: // '7' DECSC Save Cursor
            saveCursor()
            parserState = .ground
        case 0x38: // '8' DECRC Restore Cursor
            restoreCursor()
            parserState = .ground
        case 0x44: // 'D' IND
            pendingWrap = false
            indexDown()
            parserState = .ground
        case 0x45: // 'E' NEL
            cursorCol = 0
            pendingWrap = false
            indexDown()
            parserState = .ground
        case 0x48: // 'H' HTS
            tabStops.insert(cursorCol)
            parserState = .ground
        case 0x4D: // 'M' RI
            pendingWrap = false
            reverseIndex()
            parserState = .ground
        case 0x63: // 'c' RIS Full Reset
            reset()
        case 0x3D, 0x3E, 0x5C: // '=', '>', '\'
            parserState = .ground
        case 0x1B:
            parserState = .escape
        default:
            parserState = .ground
        }
    }

    // MARK: - CSI Parsing & Dispatch

    private func beginCSI() {
        csiPrivatePrefix = nil
        csiParams.removeAll(keepingCapacity: true)
        csiCurrentParam = nil
        csiInSubparam = false
        csiCurrentSubparamValue = nil
        csiIntermediates.removeAll(keepingCapacity: true)
        parserState = .csiEntry
    }

    private func finalizeCurrentSubparamIfNeeded() {
        guard csiInSubparam else { return }
        if var param = csiCurrentParam {
            if param.subparams.count < Self.maxCSISubparams {
                param.subparams.append(csiCurrentSubparamValue ?? 0)
            }
            csiCurrentParam = param
        }
        csiCurrentSubparamValue = nil
        csiInSubparam = false
    }

    private func pushCurrentCSIParam() {
        finalizeCurrentSubparamIfNeeded()
        if csiParams.count < Self.maxCSIParams {
            csiParams.append(csiCurrentParam ?? CSIParam(value: nil))
        }
        csiCurrentParam = nil
    }

    private func processCSI(_ scalar: UnicodeScalar, value: UInt32) {
        if value == 0x1B {
            parserState = .escape
            return
        }
        if value < 0x20 {
            executeC0(value)
            return
        }
        if value == 0x7F {
            return
        }

        // Private prefix bytes: '<', '=', '>', '?'
        if value >= 0x3C && value <= 0x3F {
            if csiPrivatePrefix == nil && csiParams.isEmpty && csiCurrentParam == nil && csiIntermediates.isEmpty {
                csiPrivatePrefix = UInt8(value)
            }
            return
        }

        // Digits '0'...'9'
        if value >= 0x30 && value <= 0x39 {
            let digit = Int(value - 0x30)
            if csiInSubparam {
                let current = csiCurrentSubparamValue ?? 0
                csiCurrentSubparamValue = min(999_999, current * 10 + digit)
            } else {
                var param = csiCurrentParam ?? CSIParam(value: 0)
                let current = param.value ?? 0
                param.value = min(999_999, current * 10 + digit)
                csiCurrentParam = param
            }
            return
        }

        // Colon ':' introduces subparameter (e.g. 38:2::r:g:b or 4:3)
        if value == 0x3A {
            if csiCurrentParam == nil {
                csiCurrentParam = CSIParam(value: nil)
            }
            if csiInSubparam {
                finalizeCurrentSubparamIfNeeded()
            }
            csiInSubparam = true
            csiCurrentSubparamValue = nil
            return
        }

        // Semicolon ';' finishes parameter
        if value == 0x3B {
            pushCurrentCSIParam()
            return
        }

        // Intermediate bytes 0x20...0x2F
        if value >= 0x20 && value <= 0x2F {
            if csiIntermediates.count < Self.maxCSIIntermediates {
                csiIntermediates.append(UInt8(value))
            }
            return
        }

        // Final byte 0x40...0x7E
        if value >= 0x40 && value <= 0x7E {
            if csiCurrentParam != nil || csiInSubparam || !csiParams.isEmpty {
                pushCurrentCSIParam()
            }
            dispatchCSI(finalByte: UInt8(value))
            parserState = .ground
            return
        }

        parserState = .ground
    }

    private func param(_ index: Int, default defaultValue: Int) -> Int {
        guard index < csiParams.count, let v = csiParams[index].value else {
            return defaultValue
        }
        return v
    }

    private func positiveParam(_ index: Int, default defaultValue: Int = 1) -> Int {
        let v = param(index, default: defaultValue)
        return v <= 0 ? defaultValue : v
    }

    private func dispatchCSI(finalByte: UInt8) {
        // Ignore sequences with unexpected private prefixes other than '?' (except harmless SGR/cursor shape).
        if let prefix = csiPrivatePrefix {
            if prefix == UInt8(ascii: "?") {
                switch finalByte {
                case UInt8(ascii: "h"):
                    applyDECPrivateModes(set: true)
                case UInt8(ascii: "l"):
                    applyDECPrivateModes(set: false)
                default:
                    break
                }
            }
            return
        }

        // Sequences with intermediates (e.g. CSI 2 SP q DECSCUSR) are consumed silently.
        if !csiIntermediates.isEmpty {
            return
        }

        lastWrittenPosition = nil

        switch finalByte {
        case UInt8(ascii: "A"): // CUU Cursor Up
            let n = positiveParam(0)
            let minRow = cursorRow >= scrollTop ? scrollTop : 0
            cursorRow = max(minRow, cursorRow - n)
            pendingWrap = false

        case UInt8(ascii: "B"), UInt8(ascii: "e"): // CUD / VPR Cursor Down
            let n = positiveParam(0)
            let maxRow = cursorRow <= scrollBottom ? scrollBottom : rows - 1
            cursorRow = min(maxRow, cursorRow + n)
            pendingWrap = false

        case UInt8(ascii: "C"), UInt8(ascii: "a"): // CUF / HPR Cursor Forward
            let n = positiveParam(0)
            cursorCol = min(cols - 1, cursorCol + n)
            pendingWrap = false

        case UInt8(ascii: "D"): // CUB Cursor Backward
            let n = positiveParam(0)
            cursorCol = max(0, cursorCol - n)
            pendingWrap = false

        case UInt8(ascii: "E"): // CNL Cursor Next Line
            let n = positiveParam(0)
            let maxRow = cursorRow <= scrollBottom ? scrollBottom : rows - 1
            cursorRow = min(maxRow, cursorRow + n)
            cursorCol = 0
            pendingWrap = false

        case UInt8(ascii: "F"): // CPL Cursor Preceding Line
            let n = positiveParam(0)
            let minRow = cursorRow >= scrollTop ? scrollTop : 0
            cursorRow = max(minRow, cursorRow - n)
            cursorCol = 0
            pendingWrap = false

        case UInt8(ascii: "G"), UInt8(ascii: "`"): // CHA / HPA Cursor Character Absolute
            let col = positiveParam(0) - 1
            cursorCol = min(max(0, col), cols - 1)
            pendingWrap = false

        case UInt8(ascii: "H"), UInt8(ascii: "f"): // CUP / HVP Cursor Position
            let rowArg = positiveParam(0) - 1
            let colArg = positiveParam(1) - 1
            if originMode {
                cursorRow = min(scrollBottom, scrollTop + max(0, rowArg))
            } else {
                cursorRow = min(rows - 1, max(0, rowArg))
            }
            cursorCol = min(cols - 1, max(0, colArg))
            pendingWrap = false

        case UInt8(ascii: "d"): // VPA Line Position Absolute
            let rowArg = positiveParam(0) - 1
            if originMode {
                cursorRow = min(scrollBottom, scrollTop + max(0, rowArg))
            } else {
                cursorRow = min(rows - 1, max(0, rowArg))
            }
            pendingWrap = false

        case UInt8(ascii: "J"): // ED Erase in Display
            pendingWrap = false
            eraseInDisplay(mode: param(0, default: 0))

        case UInt8(ascii: "K"): // EL Erase in Line
            pendingWrap = false
            eraseInLine(mode: param(0, default: 0))

        case UInt8(ascii: "X"): // ECH Erase Characters
            pendingWrap = false
            eraseCharacters(count: positiveParam(0))

        case UInt8(ascii: "L"): // IL Insert Lines
            pendingWrap = false
            insertLines(count: positiveParam(0))

        case UInt8(ascii: "M"): // DL Delete Lines
            pendingWrap = false
            deleteLines(count: positiveParam(0))

        case UInt8(ascii: "P"): // DCH Delete Characters
            pendingWrap = false
            deleteCharacters(count: positiveParam(0))

        case UInt8(ascii: "@"): // ICH Insert Characters
            pendingWrap = false
            insertCharacters(count: positiveParam(0))

        case UInt8(ascii: "S"): // SU Scroll Up
            pendingWrap = false
            scrollUp(lines: positiveParam(0), recordScrollback: !isAlternateScreenActive && scrollTop == 0)

        case UInt8(ascii: "T"): // SD Scroll Down
            pendingWrap = false
            scrollDown(lines: positiveParam(0))

        case UInt8(ascii: "r"): // DECSTBM Set Top & Bottom Margins
            let top = positiveParam(0, default: 1) - 1
            let bottom = positiveParam(1, default: rows) - 1
            if top >= 0 && bottom < rows && top < bottom {
                scrollTop = top
                scrollBottom = bottom
            } else {
                scrollTop = 0
                scrollBottom = rows - 1
            }
            cursorRow = originMode ? scrollTop : 0
            cursorCol = 0
            pendingWrap = false

        case UInt8(ascii: "m"): // SGR Select Graphic Rendition
            applySGR()

        case UInt8(ascii: "s"): // SCOSC Save Cursor
            if csiParams.isEmpty {
                saveCursor()
            }

        case UInt8(ascii: "u"): // SCORC Restore Cursor
            if csiParams.isEmpty {
                restoreCursor()
            }

        case UInt8(ascii: "g"): // TBC Tab Clear
            let mode = param(0, default: 0)
            if mode == 0 {
                tabStops.remove(cursorCol)
            } else if mode == 3 {
                tabStops.removeAll()
            }

        default:
            // Consume unknown/unhandled CSI cleanly (DA, DSR, XTWINOPS, etc.)
            break
        }
    }

    private func applyDECPrivateModes(set: Bool) {
        for p in csiParams {
            guard let mode = p.value else { continue }
            switch mode {
            case 1: // DECCKM Application Cursor Keys
                applicationCursorKeys = set
            case 6: // DECOM Origin Mode
                originMode = set
                cursorRow = set ? scrollTop : 0
                cursorCol = 0
                pendingWrap = false
            case 7: // DECAWM Auto-Wrap Mode
                autoWrapMode = set
            case 25: // DECTCEM Text Cursor Enable Mode
                isCursorVisible = set
            case 47, 1047: // Alternate Screen Buffer (no cursor save/restore)
                setAlternateScreen(active: set, saveRestoreCursor: false)
            case 1048: // Save/Restore Cursor
                if set { saveCursor() } else { restoreCursor() }
            case 1049: // Alternate Screen Buffer with Save/Restore Cursor & Clear
                setAlternateScreen(active: set, saveRestoreCursor: true)
            case 2004: // Bracketed Paste Mode
                bracketedPasteMode = set
            default:
                break
            }
        }
    }

    private func setAlternateScreen(active: Bool, saveRestoreCursor: Bool) {
        if active {
            if saveRestoreCursor {
                altScreenSavedMainCursor = captureCursor()
            }
            if !isAlternateScreenActive {
                altGrid = Self.makeBlankGrid(cols: cols, rows: rows)
                isAlternateScreenActive = true
                scrollTop = 0
                scrollBottom = rows - 1
                cursorRow = 0
                cursorCol = 0
                pendingWrap = false
                lastWrittenPosition = nil
            }
        } else {
            if isAlternateScreenActive {
                isAlternateScreenActive = false
                scrollTop = 0
                scrollBottom = rows - 1
                pendingWrap = false
                lastWrittenPosition = nil
            }
            if saveRestoreCursor, let saved = altScreenSavedMainCursor {
                applySavedCursor(saved)
                altScreenSavedMainCursor = nil
            }
        }
    }

    // MARK: - SGR Parsing

    private func applySGR() {
        if csiParams.isEmpty {
            currentStyle = .default
            return
        }

        var i = 0
        while i < csiParams.count {
            let p = csiParams[i]
            let code = p.value ?? 0

            switch code {
            case 0:
                currentStyle = .default
            case 1:
                currentStyle.attrs.insert(.bold)
            case 2:
                currentStyle.attrs.insert(.dim)
            case 3:
                currentStyle.attrs.insert(.italic)
            case 4:
                if let sub = p.subparams.first, sub == 0 {
                    currentStyle.attrs.remove(.underline)
                } else {
                    currentStyle.attrs.insert(.underline)
                }
            case 7:
                currentStyle.attrs.insert(.inverse)
            case 8:
                currentStyle.attrs.insert(.hidden)
            case 9:
                currentStyle.attrs.insert(.strikethrough)
            case 21:
                currentStyle.attrs.insert(.underline)
            case 22:
                currentStyle.attrs.remove([.bold, .dim])
            case 23:
                currentStyle.attrs.remove(.italic)
            case 24:
                currentStyle.attrs.remove(.underline)
            case 27:
                currentStyle.attrs.remove(.inverse)
            case 28:
                currentStyle.attrs.remove(.hidden)
            case 29:
                currentStyle.attrs.remove(.strikethrough)
            case 30...37:
                currentStyle.fg = .ansi(UInt8(code - 30))
            case 38:
                let (color, consumed) = parseExtendedColor(at: i)
                if let color { currentStyle.fg = color }
                i += consumed
            case 39:
                currentStyle.fg = .default
            case 40...47:
                currentStyle.bg = .ansi(UInt8(code - 40))
            case 48:
                let (color, consumed) = parseExtendedColor(at: i)
                if let color { currentStyle.bg = color }
                i += consumed
            case 49:
                currentStyle.bg = .default
            case 90...97:
                currentStyle.fg = .ansi(UInt8(code - 90 + 8))
            case 100...107:
                currentStyle.bg = .ansi(UInt8(code - 100 + 8))
            default:
                break
            }

            i += 1
        }
    }

    private func parseExtendedColor(at index: Int) -> (ColorValue?, Int) {
        let p = csiParams[index]

        // Colon-separated subparameter form: 38:5:n or 38:2:r:g:b or 38:2::r:g:b
        if !p.subparams.isEmpty {
            let mode = p.subparams[0]
            if mode == 5, p.subparams.count >= 2 {
                return (.indexed(UInt8(clamping: p.subparams[1])), 0)
            }
            if mode == 2 {
                if p.subparams.count >= 5 {
                    return (
                        .rgb(
                            UInt8(clamping: p.subparams[2]),
                            UInt8(clamping: p.subparams[3]),
                            UInt8(clamping: p.subparams[4])
                        ),
                        0
                    )
                } else if p.subparams.count >= 4 {
                    return (
                        .rgb(
                            UInt8(clamping: p.subparams[1]),
                            UInt8(clamping: p.subparams[2]),
                            UInt8(clamping: p.subparams[3])
                        ),
                        0
                    )
                }
            }
            return (nil, 0)
        }

        // Semicolon-separated form: 38;5;n or 38;2;r;g;b
        guard index + 1 < csiParams.count, let mode = csiParams[index + 1].value else {
            return (nil, 0)
        }

        if mode == 5, index + 2 < csiParams.count {
            let n = csiParams[index + 2].value ?? 0
            return (.indexed(UInt8(clamping: n)), 2)
        }

        if mode == 2, index + 4 < csiParams.count {
            let r = csiParams[index + 2].value ?? 0
            let g = csiParams[index + 3].value ?? 0
            let b = csiParams[index + 4].value ?? 0
            return (.rgb(UInt8(clamping: r), UInt8(clamping: g), UInt8(clamping: b)), 4)
        }

        return (nil, 0)
    }

    // MARK: - OSC Parsing

    private func processOSC(_ scalar: UnicodeScalar, value: UInt32) {
        if value == 0x07 || value == 0x9C { // BEL or 8-bit ST
            dispatchOSC()
            parserState = .ground
            return
        }
        if value == 0x1B {
            parserState = .oscEscape
            return
        }
        if oscBuffer.unicodeScalars.count < Self.maxOSCBufferScalars {
            oscBuffer.unicodeScalars.append(scalar)
        }
    }

    private func dispatchOSC() {
        defer { oscBuffer.removeAll(keepingCapacity: true) }
        guard let separator = oscBuffer.firstIndex(of: ";") else { return }
        let code = oscBuffer[..<separator]
        let payload = String(oscBuffer[oscBuffer.index(after: separator)...])

        if code == "0" || code == "2" {
            let cleaned = payload.trimmingCharacters(in: .controlCharacters)
            if cleaned != windowTitle {
                windowTitle = cleaned
                onTitleChange?(cleaned)
            }
        }
        // All other OSC codes (hyperlinks OSC 8, shell integration OSC 133, OSC 7, etc.)
        // are intentionally consumed silently so raw escape sequences never leak.
    }

    // MARK: - Character Writing & Grid Mutations

    private var activeGrid: [[Cell]] {
        get { isAlternateScreenActive ? altGrid : mainGrid }
        set {
            if isAlternateScreenActive {
                altGrid = newValue
            } else {
                mainGrid = newValue
            }
        }
    }

    private func putPrintableScalar(_ scalar: UnicodeScalar) {
        // Attach combining / grapheme-extending marks and ZWJ to the immediately preceding cell.
        if Self.isCombiningScalar(scalar) {
            if let pos = lastWrittenPosition, pos.row < rows, pos.col < cols {
                var grid = activeGrid
                var str = String(grid[pos.row][pos.col].character)
                str.unicodeScalars.append(scalar)
                if let combined = str.first {
                    grid[pos.row][pos.col].character = combined
                    activeGrid = grid
                }
            }
            return
        }

        if Self.isZeroWidthIgnoredScalar(scalar) {
            return
        }

        let mappedChar = mapCharsetScalar(scalar)
        let charWidth: UInt8 = Self.isWideScalar(scalar) ? 2 : 1

        if pendingWrap {
            if autoWrapMode {
                cursorCol = 0
                indexDown()
            }
            pendingWrap = false
        }

        // If a wide character does not fit in the final column, wrap first.
        if charWidth == 2 && cursorCol == cols - 1 {
            if autoWrapMode {
                clearCellPreservingPairs(row: cursorRow, col: cursorCol)
                cursorCol = 0
                indexDown()
            } else {
                return
            }
        }

        var grid = activeGrid
        clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol)
        if charWidth == 2 && cursorCol + 1 < cols {
            clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol + 1)
        }

        grid[cursorRow][cursorCol] = Cell(character: mappedChar, style: currentStyle, width: charWidth)
        if charWidth == 2 && cursorCol + 1 < cols {
            grid[cursorRow][cursorCol + 1] = Cell(character: " ", style: currentStyle, width: 0)
        }
        activeGrid = grid
        lastWrittenPosition = (cursorRow, cursorCol)

        let advance = Int(charWidth)
        if cursorCol + advance >= cols {
            if autoWrapMode {
                cursorCol = cols - 1
                pendingWrap = true
            } else {
                cursorCol = cols - 1
            }
        } else {
            cursorCol += advance
        }
    }

    private func clearCellPreservingPairs(row: Int, col: Int) {
        var grid = activeGrid
        clearConflictingWideCell(in: &grid, row: row, col: col)
        grid[row][col] = Cell.blank(style: currentStyle)
        activeGrid = grid
    }

    private func clearConflictingWideCell(in grid: inout [[Cell]], row: Int, col: Int) {
        let existing = grid[row][col]
        if existing.width == 0 && col > 0 {
            grid[row][col - 1] = Cell.blank(style: currentStyle)
        } else if existing.width == 2 && col + 1 < cols {
            grid[row][col + 1] = Cell.blank(style: currentStyle)
        }
    }

    private func mapCharsetScalar(_ scalar: UnicodeScalar) -> Character {
        let lineDrawing = useG1Charset ? g1LineDrawing : g0LineDrawing
        if lineDrawing, scalar.value >= 0x60 && scalar.value <= 0x7E {
            switch scalar.value {
            case 0x60: return "◆"
            case 0x61: return "▒"
            case 0x66: return "°"
            case 0x67: return "±"
            case 0x6A: return "┘"
            case 0x6B: return "┐"
            case 0x6C: return "┌"
            case 0x6D: return "└"
            case 0x6E: return "┼"
            case 0x71: return "─"
            case 0x74: return "├"
            case 0x75: return "┤"
            case 0x76: return "┴"
            case 0x77: return "┬"
            case 0x78: return "│"
            case 0x79: return "≤"
            case 0x7A: return "≥"
            case 0x7B: return "π"
            case 0x7C: return "≠"
            case 0x7D: return "£"
            case 0x7E: return "·"
            default: break
            }
        }
        return Character(scalar)
    }

    private func indexDown() {
        if cursorRow == scrollBottom {
            scrollUp(lines: 1, recordScrollback: !isAlternateScreenActive && scrollTop == 0)
        } else if cursorRow < rows - 1 {
            cursorRow += 1
        }
    }

    private func reverseIndex() {
        if cursorRow == scrollTop {
            scrollDown(lines: 1)
        } else if cursorRow > 0 {
            cursorRow -= 1
        }
    }

    private func scrollUp(lines count: Int, recordScrollback: Bool) {
        let regionHeight = scrollBottom - scrollTop + 1
        let shift = min(max(1, count), regionHeight)
        var grid = activeGrid

        if recordScrollback {
            for r in scrollTop..<(scrollTop + shift) {
                appendScrollbackLine(grid[r])
            }
        }

        if shift < regionHeight {
            for r in scrollTop...(scrollBottom - shift) {
                grid[r] = grid[r + shift]
            }
        }

        let blankRow = Self.makeBlankRow(cols: cols, style: currentStyle)
        for r in (scrollBottom - shift + 1)...scrollBottom {
            grid[r] = blankRow
        }

        activeGrid = grid
    }

    private func scrollDown(lines count: Int) {
        let regionHeight = scrollBottom - scrollTop + 1
        let shift = min(max(1, count), regionHeight)
        var grid = activeGrid

        if shift < regionHeight {
            for r in stride(from: scrollBottom, through: scrollTop + shift, by: -1) {
                grid[r] = grid[r - shift]
            }
        }

        let blankRow = Self.makeBlankRow(cols: cols, style: currentStyle)
        for r in scrollTop..<(scrollTop + shift) {
            grid[r] = blankRow
        }

        activeGrid = grid
    }

    private func appendScrollbackLine(_ line: [Cell]) {
        scrollback.append(line)
        let activeCount = scrollback.count - scrollbackStart
        if activeCount > Self.maxScrollbackLines {
            scrollbackStart += (activeCount - Self.maxScrollbackLines)
            if scrollbackStart >= Self.scrollbackCompactionThreshold {
                scrollback.removeFirst(scrollbackStart)
                scrollbackStart = 0
            }
        }
    }

    private func eraseInDisplay(mode: Int) {
        var grid = activeGrid
        let blankCell = Cell.blank(style: currentStyle)
        let blankRow = Self.makeBlankRow(cols: cols, style: currentStyle)

        switch mode {
        case 0: // Cursor to end of display
            if cursorCol < cols {
                clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol)
                for c in cursorCol..<cols {
                    grid[cursorRow][c] = blankCell
                }
            }
            if cursorRow + 1 < rows {
                for r in (cursorRow + 1)..<rows {
                    grid[r] = blankRow
                }
            }

        case 1: // Start of display to cursor (inclusive)
            for r in 0..<cursorRow {
                grid[r] = blankRow
            }
            let end = min(cursorCol, cols - 1)
            clearConflictingWideCell(in: &grid, row: cursorRow, col: end)
            for c in 0...end {
                grid[cursorRow][c] = blankCell
            }

        case 2: // Entire display
            for r in 0..<rows {
                grid[r] = blankRow
            }

        case 3: // Entire display + scrollback
            for r in 0..<rows {
                grid[r] = blankRow
            }
            scrollback.removeAll(keepingCapacity: true)
            scrollbackStart = 0

        default:
            break
        }

        activeGrid = grid
    }

    private func eraseInLine(mode: Int) {
        var grid = activeGrid
        let blankCell = Cell.blank(style: currentStyle)

        switch mode {
        case 0: // Cursor to end of line
            clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol)
            for c in cursorCol..<cols {
                grid[cursorRow][c] = blankCell
            }

        case 1: // Start of line to cursor (inclusive)
            let end = min(cursorCol, cols - 1)
            clearConflictingWideCell(in: &grid, row: cursorRow, col: end)
            for c in 0...end {
                grid[cursorRow][c] = blankCell
            }

        case 2: // Entire line
            grid[cursorRow] = Self.makeBlankRow(cols: cols, style: currentStyle)

        default:
            break
        }

        activeGrid = grid
    }

    private func eraseCharacters(count: Int) {
        var grid = activeGrid
        let blankCell = Cell.blank(style: currentStyle)
        let end = min(cols, cursorCol + count)
        if cursorCol < end {
            clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol)
            clearConflictingWideCell(in: &grid, row: cursorRow, col: end - 1)
            for c in cursorCol..<end {
                grid[cursorRow][c] = blankCell
            }
        }
        activeGrid = grid
    }

    private func insertLines(count: Int) {
        guard cursorRow >= scrollTop && cursorRow <= scrollBottom else { return }
        let maxInsert = scrollBottom - cursorRow + 1
        let shift = min(max(1, count), maxInsert)
        var grid = activeGrid

        if shift < maxInsert {
            for r in stride(from: scrollBottom, through: cursorRow + shift, by: -1) {
                grid[r] = grid[r - shift]
            }
        }
        let blankRow = Self.makeBlankRow(cols: cols, style: currentStyle)
        for r in cursorRow..<(cursorRow + shift) {
            grid[r] = blankRow
        }
        cursorCol = 0
        activeGrid = grid
    }

    private func deleteLines(count: Int) {
        guard cursorRow >= scrollTop && cursorRow <= scrollBottom else { return }
        let maxDelete = scrollBottom - cursorRow + 1
        let shift = min(max(1, count), maxDelete)
        var grid = activeGrid

        if shift < maxDelete {
            for r in cursorRow...(scrollBottom - shift) {
                grid[r] = grid[r + shift]
            }
        }
        let blankRow = Self.makeBlankRow(cols: cols, style: currentStyle)
        for r in (scrollBottom - shift + 1)...scrollBottom {
            grid[r] = blankRow
        }
        cursorCol = 0
        activeGrid = grid
    }

    private func insertCharacters(count: Int) {
        var grid = activeGrid
        let shift = min(max(1, count), cols - cursorCol)
        clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol)

        if cursorCol + shift < cols {
            for c in stride(from: cols - 1, through: cursorCol + shift, by: -1) {
                grid[cursorRow][c] = grid[cursorRow][c - shift]
            }
        }
        let blankCell = Cell.blank(style: currentStyle)
        for c in cursorCol..<(cursorCol + shift) {
            grid[cursorRow][c] = blankCell
        }
        if grid[cursorRow][cols - 1].width == 2 {
            grid[cursorRow][cols - 1] = blankCell
        }
        activeGrid = grid
    }

    private func deleteCharacters(count: Int) {
        var grid = activeGrid
        let shift = min(max(1, count), cols - cursorCol)
        clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol)
        if cursorCol + shift < cols {
            clearConflictingWideCell(in: &grid, row: cursorRow, col: cursorCol + shift)
            for c in cursorCol..<(cols - shift) {
                grid[cursorRow][c] = grid[cursorRow][c + shift]
            }
        }
        let blankCell = Cell.blank(style: currentStyle)
        for c in (cols - shift)..<cols {
            grid[cursorRow][c] = blankCell
        }
        activeGrid = grid
    }

    private func fillScreenWithE() {
        var grid = activeGrid
        let eCell = Cell(character: "E", style: .default, width: 1)
        let row = Array(repeating: eCell, count: cols)
        for r in 0..<rows {
            grid[r] = row
        }
        activeGrid = grid
        cursorRow = 0
        cursorCol = 0
        scrollTop = 0
        scrollBottom = rows - 1
        pendingWrap = false
    }

    // MARK: - Save / Restore Cursor & Tab Stops

    private func captureCursor() -> SavedCursor {
        SavedCursor(
            row: cursorRow,
            col: cursorCol,
            style: currentStyle,
            originMode: originMode,
            autoWrapMode: autoWrapMode,
            pendingWrap: pendingWrap,
            g0LineDrawing: g0LineDrawing,
            g1LineDrawing: g1LineDrawing,
            useG1Charset: useG1Charset
        )
    }

    private func applySavedCursor(_ saved: SavedCursor) {
        cursorRow = min(max(0, saved.row), rows - 1)
        cursorCol = min(max(0, saved.col), cols - 1)
        currentStyle = saved.style
        originMode = saved.originMode
        autoWrapMode = saved.autoWrapMode
        pendingWrap = saved.pendingWrap
        g0LineDrawing = saved.g0LineDrawing
        g1LineDrawing = saved.g1LineDrawing
        useG1Charset = saved.useG1Charset
    }

    private func saveCursor() {
        let snapshot = captureCursor()
        if isAlternateScreenActive {
            savedAltCursor = snapshot
        } else {
            savedMainCursor = snapshot
        }
    }

    private func restoreCursor() {
        if isAlternateScreenActive {
            if let saved = savedAltCursor {
                applySavedCursor(saved)
            }
        } else if let saved = savedMainCursor {
            applySavedCursor(saved)
        }
    }

    private func rebuildDefaultTabStops() {
        tabStops.removeAll(keepingCapacity: true)
        var c = 8
        while c < cols {
            tabStops.insert(c)
            c += 8
        }
    }

    private func nextTabStop(after col: Int) -> Int {
        guard col < cols - 1 else { return cols - 1 }
        for candidate in (col + 1)..<cols {
            if tabStops.contains(candidate) {
                return candidate
            }
        }
        return cols - 1
    }

    // MARK: - Resize Helpers

    private func resizeActiveMainGrid(newCols: Int, newRows: Int) {
        var grid = mainGrid.map { Self.resizeRow($0, to: newCols) }

        if newRows < rows {
            // Drop trailing blank lines below cursor first so keyboard opening doesn't
            // needlessly shove the active prompt into scrollback.
            while grid.count > newRows && grid.count - 1 > cursorRow && isRowBlank(grid[grid.count - 1]) {
                grid.removeLast()
            }
            while grid.count > newRows {
                let top = grid.removeFirst()
                appendScrollbackLine(top)
                if cursorRow > 0 {
                    cursorRow -= 1
                }
            }
        } else if newRows > rows {
            // Pull recent lines back out of scrollback when viewport grows (e.g. keyboard dismissed).
            var growRemaining = newRows - rows
            var pulled: [[Cell]] = []
            while growRemaining > 0 && scrollbackStart < scrollback.count {
                let line = scrollback.removeLast()
                pulled.append(Self.resizeRow(line, to: newCols))
                growRemaining -= 1
            }
            if !pulled.isEmpty {
                pulled.reverse()
                grid.insert(contentsOf: pulled, at: 0)
                cursorRow += pulled.count
            }
            while grid.count < newRows {
                grid.append(Self.makeBlankRow(cols: newCols))
            }
        }

        mainGrid = grid
    }

    private func resizeMainGridNonActive(_ grid: [[Cell]], newCols: Int, newRows: Int) -> [[Cell]] {
        var resized = grid.map { Self.resizeRow($0, to: newCols) }
        if resized.count > newRows {
            resized = Array(resized.prefix(newRows))
        } else {
            while resized.count < newRows {
                resized.append(Self.makeBlankRow(cols: newCols))
            }
        }
        return resized
    }

    private func resizeAltGrid(_ grid: [[Cell]], newCols: Int, newRows: Int) -> [[Cell]] {
        var resized = grid.map { Self.resizeRow($0, to: newCols) }
        if resized.count > newRows {
            resized = Array(resized.prefix(newRows))
        } else {
            while resized.count < newRows {
                resized.append(Self.makeBlankRow(cols: newCols))
            }
        }
        return resized
    }

    private static func resizeRow(_ row: [Cell], to newCols: Int) -> [Cell] {
        if row.count == newCols {
            return row
        }
        if row.count > newCols {
            var truncated = Array(row.prefix(newCols))
            if let last = truncated.last, last.width == 2 {
                truncated[newCols - 1] = .blank
            }
            return truncated
        }
        var padded = row
        padded.append(contentsOf: repeatElement(Cell.blank, count: newCols - row.count))
        return padded
    }

    private func isRowBlank(_ row: [Cell]) -> Bool {
        for cell in row {
            if !cell.isVisuallyBlank {
                return false
            }
        }
        return true
    }

    private func lastNonBlankColumn(in row: [Cell]) -> Int {
        for col in stride(from: row.count - 1, through: 0, by: -1) {
            if !row[col].isVisuallyBlank {
                return col
            }
        }
        return -1
    }

    private func lastVisibleMainRow(includeCursor: Bool) -> Int {
        var last = includeCursor ? cursorRow : 0
        for r in stride(from: mainGrid.count - 1, through: 0, by: -1) {
            if !isRowBlank(mainGrid[r]) {
                last = max(last, r)
                break
            }
        }
        return min(max(0, last), mainGrid.count - 1)
    }

    private func plainLineString(_ row: [Cell]) -> String {
        let end = lastNonBlankColumn(in: row)
        guard end >= 0 else { return "" }
        var out = ""
        out.reserveCapacity(end + 1)
        for col in 0...end {
            let cell = row[col]
            if cell.width == 0 { continue }
            out.append(cell.character)
        }
        return out
    }

    private static func makeBlankRow(cols: Int, style: Style = .default) -> [Cell] {
        Array(repeating: Cell.blank(style: style), count: cols)
    }

    private static func makeBlankGrid(cols: Int, rows: Int) -> [[Cell]] {
        Array(repeating: makeBlankRow(cols: cols), count: rows)
    }

    private static func clampCols(_ value: Int) -> Int {
        max(20, min(value, 500))
    }

    private static func clampRows(_ value: Int) -> Int {
        max(4, min(value, 200))
    }

    // MARK: - Unicode Width Helpers

    private static func isCombiningScalar(_ scalar: UnicodeScalar) -> Bool {
        let v = scalar.value
        if v == 0x200D { return true } // ZWJ
        if (0xFE00...0xFE0F).contains(v) || (0xE0100...0xE01EF).contains(v) { return true }
        return scalar.properties.isGraphemeExtend
    }

    private static func isZeroWidthIgnoredScalar(_ scalar: UnicodeScalar) -> Bool {
        switch scalar.value {
        case 0x200B, 0x200C, 0x200E, 0x200F, 0xFEFF, 0x00AD:
            return true
        default:
            return false
        }
    }

    private static func isWideScalar(_ scalar: UnicodeScalar) -> Bool {
        let v = scalar.value
        if v < 0x1100 { return false }
        if scalar.properties.isEmojiPresentation { return true }
        switch v {
        case 0x1100...0x115F,
             0x2329...0x232A,
             0x2E80...0x303E,
             0x3040...0xA4CF,
             0xAC00...0xD7A3,
             0xF900...0xFAFF,
             0xFE10...0xFE19,
             0xFE30...0xFE6F,
             0xFF00...0xFF60,
             0xFFE0...0xFFE6,
             0x1F300...0x1FAFF,
             0x20000...0x2FFFD,
             0x30000...0x3FFFD:
            return true
        default:
            return false
        }
    }

    // MARK: - Palette & Font Resolution

    private struct ResolvedPalette {
        let bg: UIColor
        let fg: UIColor
        let cursor: UIColor
        let ansi: [UIColor]
        let regularFont: UIFont
        let boldFont: UIFont
        let italicFont: UIFont
        let boldItalicFont: UIFont
        let paragraphStyle: NSParagraphStyle
        let baseAttributes: [NSAttributedString.Key: Any]

        init(theme: RelayThemePalette, baseFont: UIFont) {
            let bgColor = UIColor(theme.terminalBg)
            let fgColor = UIColor(theme.terminalFg)
            let cursorColor = UIColor(theme.terminalCursor)
            let red = UIColor(theme.terminalRed)
            let green = UIColor(theme.terminalGreen)
            let yellow = UIColor(theme.terminalYellow)
            let blue = UIColor(theme.terminalBlue)
            let magenta = UIColor(theme.terminalMagenta)
            let cyan = UIColor(theme.terminalCyan)
            let brightBlack = UIColor(theme.terminalBrightBlack)
            let brightWhite = UIColor(theme.foreground)

            let black = theme.isDark
                ? UIColor(red: 0.11, green: 0.11, blue: 0.13, alpha: 1.0)
                : UIColor(theme.foreground)

            let brightRed = Self.brightened(red, isDark: theme.isDark)
            let brightGreen = Self.brightened(green, isDark: theme.isDark)
            let brightYellow = Self.brightened(yellow, isDark: theme.isDark)
            let brightBlue = Self.brightened(blue, isDark: theme.isDark)
            let brightMagenta = Self.brightened(magenta, isDark: theme.isDark)
            let brightCyan = Self.brightened(cyan, isDark: theme.isDark)

            self.bg = bgColor
            self.fg = fgColor
            self.cursor = cursorColor
            self.ansi = [
                black, red, green, yellow, blue, magenta, cyan, fgColor,
                brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite,
            ]

            self.regularFont = baseFont
            self.boldFont = UIFont.monospacedSystemFont(ofSize: baseFont.pointSize, weight: .bold)
            self.italicFont = Self.fontWithTraits(baseFont, traits: .traitItalic)
            self.boldItalicFont = Self.fontWithTraits(baseFont, traits: [.traitBold, .traitItalic])

            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 1.5
            paragraph.lineBreakMode = .byCharWrapping
            self.paragraphStyle = paragraph

            self.baseAttributes = [
                .font: baseFont,
                .foregroundColor: fgColor,
                .paragraphStyle: paragraph,
            ]
        }

        func attributes(for style: Style, isCursor: Bool) -> [NSAttributedString.Key: Any] {
            var resolvedFG: UIColor
            var resolvedBG: UIColor?

            if style.attrs.contains(.bold), case .ansi(let code) = style.fg, code < 8 {
                resolvedFG = ansi[Int(code + 8)]
            } else {
                resolvedFG = resolveColor(style.fg, fallback: fg)
            }

            if style.bg != .default {
                resolvedBG = resolveColor(style.bg, fallback: bg)
            }

            if style.attrs.contains(.inverse) {
                let effectiveBG = resolvedBG ?? bg
                resolvedBG = resolvedFG
                resolvedFG = effectiveBG
            }

            if style.attrs.contains(.dim) {
                resolvedFG = resolvedFG.withAlphaComponent(0.55)
            }

            if style.attrs.contains(.hidden) {
                resolvedFG = resolvedBG ?? bg
            }

            if isCursor {
                resolvedBG = cursor
                resolvedFG = bg
            }

            var attrs: [NSAttributedString.Key: Any] = [
                .foregroundColor: resolvedFG,
            ]

            if let resolvedBG {
                attrs[.backgroundColor] = resolvedBG
            }

            let isBold = style.attrs.contains(.bold)
            let isItalic = style.attrs.contains(.italic)
            if isBold && isItalic {
                attrs[.font] = boldItalicFont
            } else if isBold {
                attrs[.font] = boldFont
            } else if isItalic {
                attrs[.font] = italicFont
            }

            if style.attrs.contains(.underline) {
                attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
            }

            if style.attrs.contains(.strikethrough) {
                attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
            }

            return attrs
        }

        private func resolveColor(_ value: ColorValue, fallback: UIColor) -> UIColor {
            switch value {
            case .default:
                return fallback
            case .ansi(let code):
                return ansi[Int(code) & 0x0F]
            case .indexed(let index):
                return Self.xterm256Color(index, ansi: ansi)
            case .rgb(let r, let g, let b):
                return UIColor(
                    red: CGFloat(r) / 255.0,
                    green: CGFloat(g) / 255.0,
                    blue: CGFloat(b) / 255.0,
                    alpha: 1.0
                )
            }
        }

        private static func xterm256Color(_ index: UInt8, ansi: [UIColor]) -> UIColor {
            if index < 16 {
                return ansi[Int(index)]
            }
            if index < 232 {
                let cube = Int(index - 16)
                let rIdx = cube / 36
                let gIdx = (cube / 6) % 6
                let bIdx = cube % 6
                let levels: [CGFloat] = [0, 95, 135, 175, 215, 255]
                return UIColor(
                    red: levels[rIdx] / 255.0,
                    green: levels[gIdx] / 255.0,
                    blue: levels[bIdx] / 255.0,
                    alpha: 1.0
                )
            }
            let gray = CGFloat(8 + Int(index - 232) * 10) / 255.0
            return UIColor(red: gray, green: gray, blue: gray, alpha: 1.0)
        }

        private static func brightened(_ color: UIColor, isDark: Bool) -> UIColor {
            var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
            guard color.getRed(&r, green: &g, blue: &b, alpha: &a) else { return color }
            let target: CGFloat = isDark ? 1.0 : 0.0
            let blend: CGFloat = isDark ? 0.18 : 0.12
            return UIColor(
                red: r + (target - r) * blend,
                green: g + (target - g) * blend,
                blue: b + (target - b) * blend,
                alpha: a
            )
        }

        private static func fontWithTraits(_ font: UIFont, traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
            let combined = font.fontDescriptor.symbolicTraits.union(traits)
            guard let descriptor = font.fontDescriptor.withSymbolicTraits(combined) else {
                return font
            }
            return UIFont(descriptor: descriptor, size: font.pointSize)
        }
    }
}
