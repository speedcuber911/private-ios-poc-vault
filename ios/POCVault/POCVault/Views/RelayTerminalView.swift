import Combine
import SwiftUI
import UIKit

// MARK: - Terminal Key & Modifier Encoding

struct RelayTerminalModifiers: Equatable {
    var ctrl: Bool = false
    var shift: Bool = false
    var alt: Bool = false

    static let empty = RelayTerminalModifiers()

    var hasAny: Bool {
        ctrl || shift || alt
    }

    mutating func clear() {
        ctrl = false
        shift = false
        alt = false
    }

    func merged(with other: RelayTerminalModifiers) -> RelayTerminalModifiers {
        RelayTerminalModifiers(
            ctrl: ctrl || other.ctrl,
            shift: shift || other.shift,
            alt: alt || other.alt
        )
    }
}

enum RelayTerminalKey: Equatable {
    case escape
    case tab
    case enter
    case backspace
    case delete
    case arrowUp
    case arrowDown
    case arrowLeft
    case arrowRight
    case home
    case end
    case pageUp
    case pageDown
    case f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12
    case character(String)
}

enum RelayTerminalKeyEncoder {
    private static let bracketedPasteStart = "\u{1B}[200~"
    private static let bracketedPasteEnd = "\u{1B}[201~"

    static func encode(
        key: RelayTerminalKey,
        modifiers: RelayTerminalModifiers,
        applicationCursorKeys: Bool
    ) -> String {
        switch key {
        case .character(let raw):
            return encodeCharacter(raw, modifiers: modifiers)

        case .enter:
            if modifiers.alt && !modifiers.ctrl && !modifiers.shift {
                return "\u{1B}\r"
            }
            return "\r"

        case .tab:
            if modifiers.shift && !modifiers.ctrl && !modifiers.alt {
                return "\u{1B}[Z"
            }
            return applyAlt("\t", modifiers: modifiers)

        case .backspace:
            return applyAlt("\u{7F}", modifiers: modifiers)

        case .escape:
            return "\u{1B}"

        case .arrowUp:
            return encodeArrow("A", modifiers: modifiers, applicationCursorKeys: applicationCursorKeys)

        case .arrowDown:
            return encodeArrow("B", modifiers: modifiers, applicationCursorKeys: applicationCursorKeys)

        case .arrowRight:
            if modifiers.alt && !modifiers.ctrl && !modifiers.shift {
                return "\u{1B}f"
            }
            return encodeArrow("C", modifiers: modifiers, applicationCursorKeys: applicationCursorKeys)

        case .arrowLeft:
            if modifiers.alt && !modifiers.ctrl && !modifiers.shift {
                return "\u{1B}b"
            }
            return encodeArrow("D", modifiers: modifiers, applicationCursorKeys: applicationCursorKeys)

        case .home:
            return csiWithModifier("H", modifiers: modifiers)

        case .end:
            return csiWithModifier("F", modifiers: modifiers)

        case .delete:
            return csiTilde(3, modifiers: modifiers)

        case .pageUp:
            return csiTilde(5, modifiers: modifiers)

        case .pageDown:
            return csiTilde(6, modifiers: modifiers)

        case .f1: return ss3OrCSI("P", modifiers: modifiers)
        case .f2: return ss3OrCSI("Q", modifiers: modifiers)
        case .f3: return ss3OrCSI("R", modifiers: modifiers)
        case .f4: return ss3OrCSI("S", modifiers: modifiers)
        case .f5: return csiTilde(15, modifiers: modifiers)
        case .f6: return csiTilde(17, modifiers: modifiers)
        case .f7: return csiTilde(18, modifiers: modifiers)
        case .f8: return csiTilde(19, modifiers: modifiers)
        case .f9: return csiTilde(20, modifiers: modifiers)
        case .f10: return csiTilde(21, modifiers: modifiers)
        case .f11: return csiTilde(23, modifiers: modifiers)
        case .f12: return csiTilde(24, modifiers: modifiers)
        }
    }

    static func encodePaste(_ text: String, bracketedPasteMode: Bool) -> String {
        guard bracketedPasteMode else { return text }
        let sanitized = text.replacingOccurrences(of: bracketedPasteEnd, with: "[201~")
        return "\(bracketedPasteStart)\(sanitized)\(bracketedPasteEnd)"
    }

    private static func modifierParam(_ modifiers: RelayTerminalModifiers) -> Int {
        var value = 1
        if modifiers.shift { value += 1 }
        if modifiers.alt { value += 2 }
        if modifiers.ctrl { value += 4 }
        return value
    }

    private static func applyAlt(_ sequence: String, modifiers: RelayTerminalModifiers) -> String {
        modifiers.alt ? "\u{1B}\(sequence)" : sequence
    }

    private static func encodeArrow(
        _ finalByte: String,
        modifiers: RelayTerminalModifiers,
        applicationCursorKeys: Bool
    ) -> String {
        if applicationCursorKeys {
            return ss3OrCSI(finalByte, modifiers: modifiers)
        }
        return csiWithModifier(finalByte, modifiers: modifiers)
    }

    private static func csiWithModifier(_ finalByte: String, modifiers: RelayTerminalModifiers) -> String {
        let mod = modifierParam(modifiers)
        return mod == 1 ? "\u{1B}[\(finalByte)" : "\u{1B}[1;\(mod)\(finalByte)"
    }

    private static func ss3OrCSI(_ finalByte: String, modifiers: RelayTerminalModifiers) -> String {
        modifierParam(modifiers) == 1 ? "\u{1B}O\(finalByte)" : csiWithModifier(finalByte, modifiers: modifiers)
    }

    private static func csiTilde(_ base: Int, modifiers: RelayTerminalModifiers) -> String {
        let mod = modifierParam(modifiers)
        return mod == 1 ? "\u{1B}[\(base)~" : "\u{1B}[\(base);\(mod)~"
    }

    private static func encodeCharacter(_ raw: String, modifiers: RelayTerminalModifiers) -> String {
        let char = modifiers.shift ? raw.uppercased() : raw
        if modifiers.ctrl {
            return encodeCtrlCharacter(char, modifiers: modifiers)
        }
        return applyAlt(char, modifiers: modifiers)
    }

    private static func encodeCtrlCharacter(_ char: String, modifiers: RelayTerminalModifiers) -> String {
        let upper = char.uppercased()
        if upper.unicodeScalars.count == 1, let scalar = upper.unicodeScalars.first {
            let v = scalar.value
            if v >= 0x41 && v <= 0x5A { // 'A'...'Z' -> 0x01...0x1A
                let ctrlScalar = UnicodeScalar(v - 0x40)!
                return applyAlt(String(ctrlScalar), modifiers: modifiers)
            }
        }

        let symbol: String?
        switch char {
        case " ", "@", "2": symbol = "\u{00}"
        case "[", "3":      symbol = "\u{1B}"
        case "\\", "4":     symbol = "\u{1C}"
        case "]", "5":      symbol = "\u{1D}"
        case "^", "6":      symbol = "\u{1E}"
        case "_", "/", "7": symbol = "\u{1F}"
        case "8", "?":      symbol = "\u{7F}"
        default:            symbol = nil
        }

        if let symbol {
            return applyAlt(symbol, modifiers: modifiers)
        }

        if char.unicodeScalars.count == 1, let scalar = char.unicodeScalars.first {
            let code = scalar.value & 0x1F
            if let ctrlScalar = UnicodeScalar(code) {
                return applyAlt(String(ctrlScalar), modifiers: modifiers)
            }
        }
        return applyAlt(char, modifiers: modifiers)
    }
}

// MARK: - Persistent Terminal Session Model

/// Observable session controller that owns the VT100 engine, remote PTY stream,
/// FIFO input queue, and debounced resize synchronization so terminals stay alive
/// across workspace tab switches.
@MainActor
final class RelayTerminalSessionModel: ObservableObject {

    enum Status: Equatable {
        case idle
        case connecting
        case running
        case exited(Int?)
        case failed(String)

        var label: String {
            switch self {
            case .idle:
                return "Idle"
            case .connecting:
                return "Connecting"
            case .running:
                return "Running"
            case .exited(let code):
                if let code {
                    return "Exited (\(code))"
                }
                return "Exited"
            case .failed:
                return "Disconnected"
            }
        }

        var isRunning: Bool {
            if case .running = self { return true }
            return false
        }
    }

    let client: CodexClient
    let workspaceID: String
    let workspaceName: String
    let engine: RelayVT100Engine

    var onTitleChange: ((String) -> Void)?
    var onResizeTerminal: ((String, Int, Int) async -> Void)?

    @Published private(set) var terminal: CodexTerminal?
    @Published private(set) var status: Status = .idle
    @Published private(set) var errorMessage: String?
    @Published private(set) var title: String
    @Published private(set) var renderVersion: UInt64 = 0
    @Published private(set) var hasReceivedOutput: Bool = false
    @Published private(set) var toastMessage: String?

    @Published var modifiers: RelayTerminalModifiers = .empty
    @Published var isScrolledUp: Bool = false
    @Published var isKeyboardVisible: Bool = false
    @Published var hasSelection: Bool = false

    @Published private(set) var focusCommandToken: UInt64 = 0
    @Published private(set) var focusDesiredState: Bool = false
    @Published private(set) var scrollToBottomToken: UInt64 = 0
    @Published private(set) var copySelectionToken: UInt64 = 0

    private var viewportCols: Int
    private var viewportRows: Int
    private var lastSentRemoteSize: (cols: Int, rows: Int)?

    private var streamTask: Task<Void, Never>?
    private var resizeDebounceTask: Task<Void, Never>?
    private var renderCoalesceTask: Task<Void, Never>?
    private var inputDrainTask: Task<Void, Never>?
    private var toastClearTask: Task<Void, Never>?

    private var pendingInputQueue: [String] = []
    private var lastRenderFlushTime: CFTimeInterval = 0

    init(
        client: CodexClient,
        workspaceID: String,
        workspaceName: String,
        initialCols: Int = 80,
        initialRows: Int = 24,
        onTitleChange: ((String) -> Void)? = nil,
        onResizeTerminal: ((String, Int, Int) async -> Void)? = nil
    ) {
        self.client = client
        self.workspaceID = workspaceID
        self.workspaceName = workspaceName
        self.viewportCols = max(24, initialCols)
        self.viewportRows = max(6, initialRows)
        self.title = "Terminal"
        self.engine = RelayVT100Engine(cols: self.viewportCols, rows: self.viewportRows)
        self.onTitleChange = onTitleChange
        self.onResizeTerminal = onResizeTerminal

        self.engine.onTitleChange = { [weak self] newTitle in
            guard let self else { return }
            let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            let resolved = trimmed.isEmpty ? "Terminal" : trimmed
            if self.title != resolved {
                self.title = resolved
                self.onTitleChange?(resolved)
            }
        }
    }

    deinit {
        streamTask?.cancel()
        resizeDebounceTask?.cancel()
        renderCoalesceTask?.cancel()
        inputDrainTask?.cancel()
        toastClearTask?.cancel()
    }

    // MARK: - Session Lifecycle

    func startIfNeeded() {
        guard status == .idle else { return }
        startSession()
    }

    func restart() {
        let oldTerminal = terminal
        streamTask?.cancel()
        streamTask = nil
        resizeDebounceTask?.cancel()
        resizeDebounceTask = nil
        renderCoalesceTask?.cancel()
        renderCoalesceTask = nil
        inputDrainTask?.cancel()
        inputDrainTask = nil
        pendingInputQueue.removeAll()

        if let oldTerminal, oldTerminal.isRunning {
            let clientRef = client
            let oldID = oldTerminal.id
            Task { try? await clientRef.closeTerminal(id: oldID) }
        }

        terminal = nil
        errorMessage = nil
        lastSentRemoteSize = nil
        hasReceivedOutput = false
        modifiers.clear()
        engine.reset()
        engine.resize(cols: viewportCols, rows: viewportRows)
        flushRenderNow()
        startSession()
    }

    func close() {
        streamTask?.cancel()
        streamTask = nil
        resizeDebounceTask?.cancel()
        resizeDebounceTask = nil
        renderCoalesceTask?.cancel()
        renderCoalesceTask = nil
        inputDrainTask?.cancel()
        inputDrainTask = nil
        pendingInputQueue.removeAll()

        guard let active = terminal, active.isRunning else { return }
        let clientRef = client
        let activeID = active.id
        Task { try? await clientRef.closeTerminal(id: activeID) }
    }

    private func startSession() {
        status = .connecting
        errorMessage = nil
        let requestedCols = viewportCols
        let requestedRows = viewportRows

        streamTask = Task { [weak self] in
            guard let self else { return }
            do {
                let created = try await self.client.createTerminal(
                    workspaceID: self.workspaceID,
                    cols: requestedCols,
                    rows: requestedRows
                )
                if Task.isCancelled {
                    try? await self.client.closeTerminal(id: created.id)
                    return
                }
                self.terminal = created
                self.lastSentRemoteSize = (created.cols, created.rows)
                self.status = created.isRunning ? .running : .exited(created.exitCode)

                if self.viewportCols != created.cols || self.viewportRows != created.rows {
                    self.scheduleRemoteResize(cols: self.viewportCols, rows: self.viewportRows)
                }

                self.drainInputQueueIfNeeded()

                for try await event in self.client.terminalEvents(id: created.id) {
                    if Task.isCancelled { break }
                    self.handleStreamEvent(event)
                }

                if !Task.isCancelled, self.status == .running {
                    self.status = .exited(self.terminal?.exitCode)
                }
                self.flushRenderNow()
            } catch {
                if !Task.isCancelled {
                    let message = error.localizedDescription
                    self.errorMessage = message
                    self.status = .failed(message)
                }
            }
        }
    }

    private func handleStreamEvent(_ event: CodexTerminalStreamEvent) {
        switch event {
        case .snapshot(let value, let snapshot):
            terminal = value
            status = value.isRunning ? .running : .exited(value.exitCode)
            engine.reset()
            engine.resize(cols: viewportCols, rows: viewportRows)
            if !snapshot.isEmpty {
                engine.feed(snapshot)
                hasReceivedOutput = true
            }
            flushRenderNow()

        case .output(let text):
            if !text.isEmpty {
                engine.feed(text)
                hasReceivedOutput = true
                scheduleRenderFlush()
            }

        case .done(let value):
            terminal = value
            status = .exited(value.exitCode)
            flushRenderNow()
        }
    }

    // MARK: - Input Dispatch

    func handleTypedText(_ text: String) {
        guard !text.isEmpty else { return }
        requestScrollToBottom()

        if modifiers.hasAny {
            let activeModifiers = modifiers
            modifiers.clear()

            if text == "\n" || text == "\r" {
                let encoded = RelayTerminalKeyEncoder.encode(
                    key: .enter,
                    modifiers: activeModifiers,
                    applicationCursorKeys: engine.applicationCursorKeys
                )
                sendRawInput(encoded)
                return
            }

            if text.count == 1 {
                let encoded = RelayTerminalKeyEncoder.encode(
                    key: .character(text),
                    modifiers: activeModifiers,
                    applicationCursorKeys: engine.applicationCursorKeys
                )
                sendRawInput(encoded)
                return
            }
        }

        // Software keyboard Return arrives as "\n"; PTY expects CR ("\r").
        let normalized = text.replacingOccurrences(of: "\n", with: "\r")
        sendRawInput(normalized)
    }

    func sendKey(_ key: RelayTerminalKey, hardwareModifiers: RelayTerminalModifiers = .empty) {
        let combined = modifiers.merged(with: hardwareModifiers)
        if modifiers.hasAny {
            modifiers.clear()
        }
        requestScrollToBottom()

        let encoded = RelayTerminalKeyEncoder.encode(
            key: key,
            modifiers: combined,
            applicationCursorKeys: engine.applicationCursorKeys
        )
        guard !encoded.isEmpty else { return }
        sendRawInput(encoded)
    }

    func sendInterrupt() {
        modifiers.clear()
        requestScrollToBottom()
        sendRawInput("\u{03}")
    }

    func sendRawInput(_ text: String) {
        guard !text.isEmpty else { return }
        pendingInputQueue.append(text)
        drainInputQueueIfNeeded()
    }

    @discardableResult
    func pasteFromClipboard() -> Bool {
        guard let text = UIPasteboard.general.string, !text.isEmpty else {
            showToast("Clipboard empty")
            return false
        }
        modifiers.clear()
        requestScrollToBottom()
        let encoded = RelayTerminalKeyEncoder.encodePaste(
            text,
            bracketedPasteMode: engine.bracketedPasteMode
        )
        sendRawInput(encoded)
        showToast("Pasted")
        return true
    }

    func copyAllText() {
        let snapshot = engine.plainTextSnapshot()
        UIPasteboard.general.string = snapshot
        showToast("Copied all")
    }

    func clearDisplay() {
        engine.clearScrollbackAndHistory()
        flushRenderNow()
        requestScrollToBottom()
    }

    // MARK: - Viewport & UI Coordination

    func updateViewportSize(cols: Int, rows: Int) {
        let clampedCols = max(24, min(cols, 240))
        let clampedRows = max(6, min(rows, 120))
        guard clampedCols != viewportCols || clampedRows != viewportRows else { return }

        viewportCols = clampedCols
        viewportRows = clampedRows
        engine.resize(cols: clampedCols, rows: clampedRows)
        flushRenderNow()
        scheduleRemoteResize(cols: clampedCols, rows: clampedRows)
    }

    func requestKeyboardVisible(_ visible: Bool) {
        focusDesiredState = visible
        focusCommandToken &+= 1
    }

    func toggleKeyboard() {
        requestKeyboardVisible(!isKeyboardVisible)
    }

    func requestScrollToBottom() {
        isScrolledUp = false
        scrollToBottomToken &+= 1
    }

    func requestCopySelection() {
        copySelectionToken &+= 1
    }

    func notifySelectionCopied() {
        showToast("Copied")
    }

    func showToast(_ message: String) {
        toastClearTask?.cancel()
        toastMessage = message
        toastClearTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_250_000_000)
            guard let self, !Task.isCancelled else { return }
            self.toastMessage = nil
        }
    }

    // MARK: - Private Helpers

    private func drainInputQueueIfNeeded() {
        guard inputDrainTask == nil, let active = terminal, active.isRunning else { return }
        let terminalID = active.id

        inputDrainTask = Task { [weak self] in
            guard let self else { return }
            defer { self.inputDrainTask = nil }

            while !Task.isCancelled && !self.pendingInputQueue.isEmpty {
                let batch = self.pendingInputQueue.joined()
                self.pendingInputQueue.removeAll(keepingCapacity: true)
                do {
                    try await self.client.sendTerminalInput(id: terminalID, text: batch)
                    if self.errorMessage != nil, self.status.isRunning {
                        self.errorMessage = nil
                    }
                } catch {
                    if !Task.isCancelled {
                        self.errorMessage = error.localizedDescription
                    }
                    break
                }
            }
        }
    }

    private func scheduleRemoteResize(cols: Int, rows: Int) {
        guard let handler = onResizeTerminal else { return }
        resizeDebounceTask?.cancel()
        resizeDebounceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard let self, !Task.isCancelled else { return }
            guard let active = self.terminal, active.isRunning else { return }
            if let last = self.lastSentRemoteSize, last.cols == cols && last.rows == rows {
                return
            }
            self.lastSentRemoteSize = (cols, rows)
            await handler(active.id, cols, rows)
        }
    }

    private func scheduleRenderFlush() {
        let now = CACurrentMediaTime()
        if now - lastRenderFlushTime >= 0.016 {
            flushRenderNow()
            return
        }
        guard renderCoalesceTask == nil else { return }
        renderCoalesceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 16_000_000)
            guard let self, !Task.isCancelled else { return }
            self.flushRenderNow()
        }
    }

    private func flushRenderNow() {
        renderCoalesceTask?.cancel()
        renderCoalesceTask = nil
        lastRenderFlushTime = CACurrentMediaTime()
        renderVersion &+= 1
    }
}

// MARK: - Interactive UIKit Terminal Surface

final class RelayInteractiveTerminalView: UIView, UIKeyInput, UITextViewDelegate, UIGestureRecognizerDelegate {

    // MARK: - UITextInputTraits

    var autocorrectionType: UITextAutocorrectionType = .no
    var autocapitalizationType: UITextAutocapitalizationType = .none
    var spellCheckingType: UITextSpellCheckingType = .no
    var smartQuotesType: UITextSmartQuotesType = .no
    var smartDashesType: UITextSmartDashesType = .no
    var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    var keyboardType: UIKeyboardType = .asciiCapable
    var keyboardAppearance: UIKeyboardAppearance = .dark
    var returnKeyType: UIReturnKeyType = .default
    var enablesReturnKeyAutomatically: Bool = false

    // MARK: - Callbacks

    var onTextInput: ((String) -> Void)?
    var onKeyInput: ((RelayTerminalKey, RelayTerminalModifiers) -> Void)?
    var onPasteAction: (() -> Void)?
    var onClearAction: (() -> Void)?
    var onViewportSizeChange: ((Int, Int) -> Void)?
    var onScrolledUpChange: ((Bool) -> Void)?
    var onSelectionChange: ((Bool) -> Void)?
    var onFocusChange: ((Bool) -> Void)?
    var onSelectionCopied: (() -> Void)?

    // MARK: - Subviews & State

    private let textView: UITextView = {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.showsVerticalScrollIndicator = true
        view.showsHorizontalScrollIndicator = false
        view.backgroundColor = .clear
        view.contentInsetAdjustmentBehavior = .never
        view.textContainer.lineFragmentPadding = 0
        view.textContainerInset = UIEdgeInsets(top: 10, left: 10, bottom: 14, right: 10)
        view.dataDetectorTypes = []
        return view
    }()

    private var terminalFont: UIFont = UIFont.monospacedSystemFont(ofSize: 12.5, weight: .regular)
    private var lastMeasuredGrid: (cols: Int, rows: Int) = (0, 0)
    private var isFollowingBottom: Bool = true
    private var isUserDragging: Bool = false
    private var isApplyingAttributedText: Bool = false
    private var lastReportedScrolledUp: Bool = false
    private var lastReportedHasSelection: Bool = false
    private var lastBoundsSize: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        commonInit()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        commonInit()
    }

    private func commonInit() {
        backgroundColor = .clear
        clipsToBounds = true

        textView.delegate = self
        textView.translatesAutoresizingMaskIntoConstraints = false
        addSubview(textView)

        NSLayoutConstraint.activate([
            textView.topAnchor.constraint(equalTo: topAnchor),
            textView.leadingAnchor.constraint(equalTo: leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: trailingAnchor),
            textView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        let tap = UITapGestureRecognizer(target: self, action: #selector(handleTap))
        tap.cancelsTouchesInView = false
        tap.delegate = self
        addGestureRecognizer(tap)
    }

    // MARK: - Responder & UIKeyInput

    override var canBecomeFirstResponder: Bool { true }

    var hasText: Bool { true }

    @discardableResult
    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted {
            onFocusChange?(true)
        }
        return accepted
    }

    @discardableResult
    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned {
            onFocusChange?(false)
        }
        return resigned
    }

    func insertText(_ text: String) {
        clearTextSelection()
        scrollToBottom(animated: false)
        onTextInput?(text)
    }

    func deleteBackward() {
        clearTextSelection()
        scrollToBottom(animated: false)
        onKeyInput?(.backspace, .empty)
    }

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(UIResponderStandardEditActions.paste(_:)) {
            return UIPasteboard.general.hasStrings
        }
        if action == #selector(UIResponderStandardEditActions.copy(_:)) {
            return textView.selectedRange.length > 0
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        onPasteAction?()
    }

    override func copy(_ sender: Any?) {
        _ = copySelectedText()
    }

    // MARK: - Hardware Keyboard Dispatch

    override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
        var unhandled: Set<UIPress> = []

        for press in presses {
            guard let key = press.key else {
                unhandled.insert(press)
                continue
            }

            let flags = key.modifierFlags
            let hasCmd = flags.contains(.command)
            let hwModifiers = RelayTerminalModifiers(
                ctrl: flags.contains(.control),
                shift: flags.contains(.shift),
                alt: flags.contains(.alternate)
            )

            // Standard hardware keyboard editing shortcuts
            if hasCmd && !hwModifiers.ctrl && !hwModifiers.alt {
                let lower = key.charactersIgnoringModifiers.lowercased()
                if lower == "v" {
                    onPasteAction?()
                    continue
                }
                if lower == "c" && textView.selectedRange.length > 0 {
                    _ = copySelectedText()
                    continue
                }
                if lower == "k" {
                    onClearAction?()
                    continue
                }
                if key.keyCode == .keyboardLeftArrow {
                    onTextInput?("\u{01}")
                    continue
                }
                if key.keyCode == .keyboardRightArrow {
                    onTextInput?("\u{05}")
                    continue
                }
                if key.keyCode == .keyboardDeleteOrBackspace {
                    onTextInput?("\u{15}")
                    continue
                }
                unhandled.insert(press)
                continue
            }

            if let mapped = Self.mapSpecialKey(key.keyCode) {
                clearTextSelection()
                scrollToBottom(animated: false)
                onKeyInput?(mapped, hwModifiers)
                continue
            }

            // Intercept Ctrl/Alt modified printable keys before UIKeyInput drops them.
            if hwModifiers.ctrl || hwModifiers.alt {
                let raw = key.charactersIgnoringModifiers
                if raw.count == 1 {
                    clearTextSelection()
                    scrollToBottom(animated: false)
                    onKeyInput?(.character(raw), hwModifiers)
                    continue
                }
            }

            unhandled.insert(press)
        }

        if !unhandled.isEmpty {
            super.pressesBegan(unhandled, with: event)
        }
    }

    private static func mapSpecialKey(_ code: UIKeyboardHIDUsage) -> RelayTerminalKey? {
        switch code {
        case .keyboardEscape:             return .escape
        case .keyboardTab:                return .tab
        case .keyboardReturnOrEnter,
             .keypadEnter:                return .enter
        case .keyboardDeleteOrBackspace:  return .backspace
        case .keyboardDeleteForward:      return .delete
        case .keyboardUpArrow:            return .arrowUp
        case .keyboardDownArrow:          return .arrowDown
        case .keyboardLeftArrow:          return .arrowLeft
        case .keyboardRightArrow:         return .arrowRight
        case .keyboardHome:               return .home
        case .keyboardEnd:                return .end
        case .keyboardPageUp:             return .pageUp
        case .keyboardPageDown:           return .pageDown
        case .keyboardF1:                 return .f1
        case .keyboardF2:                 return .f2
        case .keyboardF3:                 return .f3
        case .keyboardF4:                 return .f4
        case .keyboardF5:                 return .f5
        case .keyboardF6:                 return .f6
        case .keyboardF7:                 return .f7
        case .keyboardF8:                 return .f8
        case .keyboardF9:                 return .f9
        case .keyboardF10:                return .f10
        case .keyboardF11:                return .f11
        case .keyboardF12:                return .f12
        default:                          return nil
        }
    }

    // MARK: - Layout & Viewport Sizing

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = bounds.size
        guard size.width > 0 && size.height > 0 else { return }

        let sizeChanged = size != lastBoundsSize
        lastBoundsSize = size

        measureAndReportGridSize()

        if sizeChanged && isFollowingBottom && textView.selectedRange.length == 0 {
            scrollToBottom(animated: false)
        }
    }

    func configureAppearance(theme: RelayThemePalette, font: UIFont) {
        let fontChanged = abs(font.pointSize - terminalFont.pointSize) > 0.01
        terminalFont = font

        backgroundColor = UIColor(theme.terminalBg)
        textView.indicatorStyle = theme.isDark ? .white : .black
        textView.tintColor = UIColor(theme.accent)

        let desiredKeyboardAppearance: UIKeyboardAppearance = theme.isDark ? .dark : .light
        if keyboardAppearance != desiredKeyboardAppearance {
            keyboardAppearance = desiredKeyboardAppearance
            if isFirstResponder {
                reloadInputViews()
            }
        }

        if fontChanged {
            measureAndReportGridSize()
        }
    }

    func applyRenderedText(_ attributed: NSAttributedString) {
        let shouldPinToBottom = isFollowingBottom && !isUserDragging && textView.selectedRange.length == 0
        let savedOffset = textView.contentOffset
        let savedSelection = textView.selectedRange

        isApplyingAttributedText = true
        textView.attributedText = attributed
        textView.layoutManager.ensureLayout(for: textView.textContainer)

        if savedSelection.length > 0 {
            let maxLen = attributed.length
            let loc = min(savedSelection.location, maxLen)
            let len = min(savedSelection.length, max(0, maxLen - loc))
            textView.selectedRange = NSRange(location: loc, length: len)
            restoreClampedOffset(savedOffset)
        } else if shouldPinToBottom {
            scrollToBottom(animated: false)
        } else {
            restoreClampedOffset(savedOffset)
        }

        isApplyingAttributedText = false
    }

    func scrollToBottom(animated: Bool) {
        isFollowingBottom = true
        reportScrolledUpIfNeeded(false)
        textView.layoutIfNeeded()
        let targetY = maxContentOffsetY()
        let target = CGPoint(x: 0, y: targetY)
        if animated {
            textView.setContentOffset(target, animated: true)
        } else {
            UIView.performWithoutAnimation {
                textView.contentOffset = target
            }
        }
    }

    @discardableResult
    func copySelectedText() -> Bool {
        let range = textView.selectedRange
        guard range.length > 0 else { return false }
        let nsText = textView.attributedText.string as NSString
        guard range.location + range.length <= nsText.length else { return false }
        let selected = nsText.substring(with: range)
        guard !selected.isEmpty else { return false }
        UIPasteboard.general.string = selected
        clearTextSelection()
        onSelectionCopied?()
        return true
    }

    private func clearTextSelection() {
        if textView.selectedRange.length > 0 {
            textView.selectedRange = NSRange(location: 0, length: 0)
            reportSelectionIfNeeded(false)
        }
    }

    private func measureAndReportGridSize() {
        let inset = textView.textContainerInset
        let usableWidth = max(0, bounds.width - inset.left - inset.right)
        let usableHeight = max(0, bounds.height - inset.top - inset.bottom)
        guard usableWidth > 40 && usableHeight > 30 else { return }

        let sampleWidth = ("MMMMMMMMMM" as NSString).size(withAttributes: [.font: terminalFont]).width
        let cellWidth = max(4.0, sampleWidth / 10.0)
        let lineHeight = max(10.0, ceil(terminalFont.lineHeight + 1.5))

        let cols = max(24, min(240, Int(floor(usableWidth / cellWidth))))
        let rows = max(6, min(120, Int(floor(usableHeight / lineHeight))))

        if cols != lastMeasuredGrid.cols || rows != lastMeasuredGrid.rows {
            lastMeasuredGrid = (cols, rows)
            onViewportSizeChange?(cols, rows)
        }
    }

    private func maxContentOffsetY() -> CGFloat {
        let contentHeight = textView.contentSize.height
        let visibleHeight = textView.bounds.height - textView.adjustedContentInset.top - textView.adjustedContentInset.bottom
        return max(-textView.adjustedContentInset.top, contentHeight - visibleHeight)
    }

    private func restoreClampedOffset(_ offset: CGPoint) {
        let minY = -textView.adjustedContentInset.top
        let maxY = maxContentOffsetY()
        let clampedY = min(max(offset.y, minY), maxY)
        textView.contentOffset = CGPoint(x: 0, y: clampedY)
    }

    private func reportScrolledUpIfNeeded(_ scrolledUp: Bool) {
        guard scrolledUp != lastReportedScrolledUp else { return }
        lastReportedScrolledUp = scrolledUp
        onScrolledUpChange?(scrolledUp)
    }

    private func reportSelectionIfNeeded(_ hasSelection: Bool) {
        guard hasSelection != lastReportedHasSelection else { return }
        lastReportedHasSelection = hasSelection
        onSelectionChange?(hasSelection)
    }

    // MARK: - Gestures & UITextViewDelegate

    @objc private func handleTap() {
        if textView.selectedRange.length > 0 {
            clearTextSelection()
            return
        }
        if !isFirstResponder {
            becomeFirstResponder()
        }
    }

    func gestureRecognizer(
        _ gestureRecognizer: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
    ) -> Bool {
        true
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        isUserDragging = true
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard !isApplyingAttributedText else { return }
        let distanceFromBottom = maxContentOffsetY() - scrollView.contentOffset.y
        let atBottom = distanceFromBottom <= 28
        if isUserDragging || scrollView.isDecelerating || scrollView.isTracking {
            isFollowingBottom = atBottom
            reportScrolledUpIfNeeded(!atBottom)
        }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        isUserDragging = false
        if !decelerate {
            let atBottom = (maxContentOffsetY() - scrollView.contentOffset.y) <= 28
            isFollowingBottom = atBottom
            reportScrolledUpIfNeeded(!atBottom)
        }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        let atBottom = (maxContentOffsetY() - scrollView.contentOffset.y) <= 28
        isFollowingBottom = atBottom
        reportScrolledUpIfNeeded(!atBottom)
    }

    func textViewDidChangeSelection(_ textView: UITextView) {
        guard !isApplyingAttributedText else { return }
        reportSelectionIfNeeded(textView.selectedRange.length > 0)
    }
}

// MARK: - SwiftUI Bridge

struct RelayTerminalSurfaceView: UIViewRepresentable {
    @ObservedObject var session: RelayTerminalSessionModel
    let theme: RelayThemePalette
    var fontSize: CGFloat = 12.5

    func makeCoordinator() -> Coordinator {
        Coordinator(session: session)
    }

    func makeUIView(context: Context) -> RelayInteractiveTerminalView {
        let view = RelayInteractiveTerminalView()
        let coordinator = context.coordinator

        view.onTextInput = { [weak coordinator] text in
            Task { @MainActor in
                coordinator?.session.handleTypedText(text)
            }
        }
        view.onKeyInput = { [weak coordinator] key, hwModifiers in
            Task { @MainActor in
                coordinator?.session.sendKey(key, hardwareModifiers: hwModifiers)
            }
        }
        view.onPasteAction = { [weak coordinator] in
            Task { @MainActor in
                coordinator?.session.pasteFromClipboard()
            }
        }
        view.onClearAction = { [weak coordinator] in
            Task { @MainActor in
                coordinator?.session.clearDisplay()
            }
        }
        view.onViewportSizeChange = { [weak coordinator] cols, rows in
            Task { @MainActor in
                coordinator?.session.updateViewportSize(cols: cols, rows: rows)
            }
        }
        view.onScrolledUpChange = { [weak coordinator] scrolledUp in
            Task { @MainActor in
                coordinator?.session.isScrolledUp = scrolledUp
            }
        }
        view.onSelectionChange = { [weak coordinator] hasSelection in
            Task { @MainActor in
                coordinator?.session.hasSelection = hasSelection
            }
        }
        view.onFocusChange = { [weak coordinator] focused in
            Task { @MainActor in
                coordinator?.session.isKeyboardVisible = focused
            }
        }
        view.onSelectionCopied = { [weak coordinator] in
            Task { @MainActor in
                coordinator?.session.notifySelectionCopied()
            }
        }

        let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        view.configureAppearance(theme: theme, font: font)
        return view
    }

    func updateUIView(_ uiView: RelayInteractiveTerminalView, context: Context) {
        let coordinator = context.coordinator
        coordinator.session = session

        let font = UIFont.monospacedSystemFont(ofSize: fontSize, weight: .regular)
        uiView.configureAppearance(theme: theme, font: font)

        let showCursor = session.status.isRunning || session.status == .connecting
        let needsRender =
            coordinator.lastRenderVersion != session.renderVersion ||
            coordinator.lastTheme != theme ||
            abs(coordinator.lastFontSize - fontSize) > 0.01 ||
            coordinator.lastShowCursor != showCursor

        if needsRender {
            coordinator.lastRenderVersion = session.renderVersion
            coordinator.lastTheme = theme
            coordinator.lastFontSize = fontSize
            coordinator.lastShowCursor = showCursor
            let attributed = session.engine.renderAttributedText(
                theme: theme,
                font: font,
                showCursor: showCursor
            )
            uiView.applyRenderedText(attributed)
        }

        if coordinator.lastFocusCommandToken != session.focusCommandToken {
            coordinator.lastFocusCommandToken = session.focusCommandToken
            let desired = session.focusDesiredState
            DispatchQueue.main.async {
                if desired {
                    if !uiView.isFirstResponder {
                        uiView.becomeFirstResponder()
                    }
                } else if uiView.isFirstResponder {
                    uiView.resignFirstResponder()
                }
            }
        }

        if coordinator.lastScrollToBottomToken != session.scrollToBottomToken {
            coordinator.lastScrollToBottomToken = session.scrollToBottomToken
            DispatchQueue.main.async {
                uiView.scrollToBottom(animated: true)
            }
        }

        if coordinator.lastCopySelectionToken != session.copySelectionToken {
            coordinator.lastCopySelectionToken = session.copySelectionToken
            DispatchQueue.main.async {
                _ = uiView.copySelectedText()
            }
        }
    }

    final class Coordinator {
        var session: RelayTerminalSessionModel
        var lastRenderVersion: UInt64 = .max
        var lastTheme: RelayThemePalette?
        var lastFontSize: CGFloat = 0
        var lastShowCursor: Bool = true
        var lastFocusCommandToken: UInt64 = 0
        var lastScrollToBottomToken: UInt64 = 0
        var lastCopySelectionToken: UInt64 = 0

        init(session: RelayTerminalSessionModel) {
            self.session = session
        }
    }
}

// MARK: - Paseo Mobile Virtual Key Bar

struct RelayTerminalKeyBar: View {
    @ObservedObject var session: RelayTerminalSessionModel
    @Environment(\.relayTheme) private var theme

    @State private var availableWidth: CGFloat = 390

    private var isWideLayout: Bool {
        availableWidth >= 640
    }

    var body: some View {
        VStack(spacing: 0) {
            Rectangle()
                .fill(theme.border)
                .frame(height: 1)

            Group {
                if isWideLayout {
                    wideRow
                } else {
                    compactTwoRows
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: 880)
            .frame(maxWidth: .infinity)
        }
        .background(theme.surface0)
        .background(
            GeometryReader { proxy in
                Color.clear
                    .onAppear { availableWidth = proxy.size.width }
                    .onChange(of: proxy.size.width) { _, width in
                        if width > 0 { availableWidth = width }
                    }
            }
        )
    }

    // MARK: - Compact Mobile Layout (2 rows, zero horizontal scrolling needed)

    private var compactTwoRows: some View {
        VStack(spacing: 5) {
            HStack(spacing: 5) {
                modifierCap(title: "Ctrl", active: session.modifiers.ctrl) {
                    session.modifiers.ctrl.toggle()
                }
                modifierCap(title: "Shift", active: session.modifiers.shift) {
                    session.modifiers.shift.toggle()
                }
                modifierCap(title: "Alt", active: session.modifiers.alt) {
                    session.modifiers.alt.toggle()
                }
                keyCap(title: "Esc") {
                    session.sendKey(.escape)
                }
                keyCap(title: "↑", isArrow: true) {
                    session.sendKey(.arrowUp)
                }
                keyCap(title: "Tab") {
                    session.sendKey(.tab)
                }
                keyboardToggleCap
            }

            HStack(spacing: 5) {
                keyCap(title: "^C", isAccentMuted: true) {
                    session.sendInterrupt()
                }
                keyCap(title: "Paste") {
                    session.pasteFromClipboard()
                }
                moreActionsCap
                keyCap(title: "←", isArrow: true) {
                    session.sendKey(.arrowLeft)
                }
                keyCap(title: "↓", isArrow: true) {
                    session.sendKey(.arrowDown)
                }
                keyCap(title: "→", isArrow: true) {
                    session.sendKey(.arrowRight)
                }
                keyCap(title: "Enter") {
                    session.sendKey(.enter)
                }
            }
        }
    }

    // MARK: - Wide Layout (iPad / Landscape single row)

    private var wideRow: some View {
        HStack(spacing: 5) {
            modifierCap(title: "Ctrl", active: session.modifiers.ctrl) {
                session.modifiers.ctrl.toggle()
            }
            modifierCap(title: "Shift", active: session.modifiers.shift) {
                session.modifiers.shift.toggle()
            }
            modifierCap(title: "Alt", active: session.modifiers.alt) {
                session.modifiers.alt.toggle()
            }
            keyCap(title: "Esc") { session.sendKey(.escape) }
            keyCap(title: "Tab") { session.sendKey(.tab) }
            keyCap(title: "^C", isAccentMuted: true) { session.sendInterrupt() }
            keyCap(title: "←", isArrow: true) { session.sendKey(.arrowLeft) }
            keyCap(title: "↓", isArrow: true) { session.sendKey(.arrowDown) }
            keyCap(title: "↑", isArrow: true) { session.sendKey(.arrowUp) }
            keyCap(title: "→", isArrow: true) { session.sendKey(.arrowRight) }
            keyCap(title: "Paste") { session.pasteFromClipboard() }
            moreActionsCap
            keyboardToggleCap
            keyCap(title: "Enter") { session.sendKey(.enter) }
        }
    }

    // MARK: - Keycap Primitives

    private func modifierCap(title: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button {
            fireKeyHaptic()
            action()
        } label: {
            Text(title)
                .font(RelayTheme.monoFont(12.5, weight: active ? .semibold : .medium))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(active ? theme.accentForeground : theme.foreground)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
        }
        .buttonStyle(
            RelayTerminalKeycapStyle(
                background: active ? theme.accent : theme.surface2,
                pressedBackground: active ? theme.accent.opacity(0.85) : theme.surface3,
                border: active ? theme.accent : theme.border
            )
        )
        .accessibilityLabel(title)
        .accessibilityAddTraits(active ? .isSelected : [])
    }

    private func keyCap(
        title: String,
        isArrow: Bool = false,
        isAccentMuted: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            fireKeyHaptic()
            action()
        } label: {
            Text(title)
                .font(
                    isArrow
                        ? .system(size: 14, weight: .medium, design: .monospaced)
                        : RelayTheme.monoFont(12.5, weight: .medium)
                )
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .foregroundStyle(isAccentMuted ? theme.statusDanger : theme.foreground)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
        }
        .buttonStyle(
            RelayTerminalKeycapStyle(
                background: theme.surface2,
                pressedBackground: theme.surface3,
                border: theme.border
            )
        )
        .accessibilityLabel(title)
    }

    private var keyboardToggleCap: some View {
        Button {
            fireKeyHaptic()
            session.toggleKeyboard()
        } label: {
            Image(systemName: session.isKeyboardVisible ? "keyboard.chevron.compact.down" : "keyboard")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(theme.foregroundMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
        }
        .buttonStyle(
            RelayTerminalKeycapStyle(
                background: theme.surface2,
                pressedBackground: theme.surface3,
                border: theme.border
            )
        )
        .accessibilityLabel(session.isKeyboardVisible ? "Hide keyboard" : "Show keyboard")
    }

    private var moreActionsCap: some View {
        Menu {
            Button {
                session.copyAllText()
            } label: {
                Label("Copy all", systemImage: "doc.on.doc")
            }

            Button {
                session.pasteFromClipboard()
            } label: {
                Label("Paste", systemImage: "doc.on.clipboard")
            }

            Button {
                session.clearDisplay()
            } label: {
                Label("Clear", systemImage: "trash")
            }

            Divider()

            Button {
                session.restart()
            } label: {
                Label("Restart shell", systemImage: "arrow.clockwise")
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(theme.foregroundMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 34)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(theme.surface2)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(theme.border, lineWidth: 1)
                )
        }
        .accessibilityLabel("Terminal actions")
    }

    private func fireKeyHaptic() {
        let generator = UIImpactFeedbackGenerator(style: .light)
        generator.impactOccurred()
    }
}

private struct RelayTerminalKeycapStyle: ButtonStyle {
    let background: Color
    let pressedBackground: Color
    let border: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(configuration.isPressed ? pressedBackground : background)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(border, lineWidth: 1)
            )
            .scaleEffect(configuration.isPressed ? 0.96 : 1.0)
            .animation(.easeOut(duration: 0.08), value: configuration.isPressed)
    }
}

// MARK: - Main Terminal View (Standalone Modal + Embedded Workspace Tab)

struct RelayTerminalView: View {
    @StateObject private var ownedSessionBox: OwnedSessionBox
    private let externalSession: RelayTerminalSessionModel?
    private let isEmbeddedTab: Bool
    private let onDismiss: () -> Void

    /// Standalone modal or self-managed embedded terminal tab.
    /// Keeps exact backwards-compatibility with
    /// `RelayTerminalView(client:workspaceID:workspaceName:onDismiss:)`.
    init(
        client: CodexClient,
        workspaceID: String,
        workspaceName: String,
        isEmbeddedTab: Bool = false,
        onTitleChange: ((String) -> Void)? = nil,
        onResizeRequest: ((String, Int, Int) -> Void)? = nil,
        onDismiss: @escaping () -> Void = {}
    ) {
        let resizeBridge: ((String, Int, Int) async -> Void)? = onResizeRequest.map { callback in
            { id, cols, rows in
                callback(id, cols, rows)
            }
        }
        _ownedSessionBox = StateObject(
            wrappedValue: OwnedSessionBox(
                session: RelayTerminalSessionModel(
                    client: client,
                    workspaceID: workspaceID,
                    workspaceName: workspaceName,
                    onTitleChange: onTitleChange,
                    onResizeTerminal: resizeBridge
                )
            )
        )
        self.externalSession = nil
        self.isEmbeddedTab = isEmbeddedTab
        self.onDismiss = onDismiss
    }

    /// Embedded or modal view backed by a caller-retained `RelayTerminalSessionModel`
    /// so the remote PTY stays alive across workspace tab switches.
    init(
        session: RelayTerminalSessionModel,
        isEmbeddedTab: Bool = true,
        onDismiss: @escaping () -> Void = {}
    ) {
        _ownedSessionBox = StateObject(wrappedValue: OwnedSessionBox(session: nil))
        self.externalSession = session
        self.isEmbeddedTab = isEmbeddedTab
        self.onDismiss = onDismiss
    }

    var body: some View {
        if let activeSession = externalSession ?? ownedSessionBox.session {
            RelayTerminalBodyView(
                session: activeSession,
                isEmbeddedTab: isEmbeddedTab,
                closesOnDisappear: !isEmbeddedTab && externalSession == nil,
                onDismiss: onDismiss
            )
        }
    }

    private final class OwnedSessionBox: ObservableObject {
        let session: RelayTerminalSessionModel?

        init(session: RelayTerminalSessionModel?) {
            self.session = session
        }
    }
}

// MARK: - Terminal Body View

private struct RelayTerminalBodyView: View {
    @ObservedObject var session: RelayTerminalSessionModel
    @Environment(\.relayTheme) private var theme

    let isEmbeddedTab: Bool
    let closesOnDisappear: Bool
    let onDismiss: () -> Void

    var body: some View {
        Group {
            if isEmbeddedTab {
                terminalCore
            } else {
                NavigationStack {
                    terminalCore
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbarBackground(theme.surface0, for: .navigationBar)
                        .toolbarBackground(.visible, for: .navigationBar)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Close") {
                                    session.close()
                                    onDismiss()
                                }
                                .font(RelayTheme.uiFont(15, weight: .medium))
                                .foregroundStyle(theme.foreground)
                            }
                            ToolbarItem(placement: .principal) {
                                VStack(spacing: 1) {
                                    Text(session.title)
                                        .font(RelayTheme.uiFont(14, weight: .semibold))
                                        .foregroundStyle(theme.foreground)
                                        .lineLimit(1)
                                    Text("\(session.workspaceName) · \(session.status.label)")
                                        .font(RelayTheme.uiFont(11, weight: .regular))
                                        .foregroundStyle(theme.foregroundMuted)
                                        .lineLimit(1)
                                }
                            }
                            ToolbarItem(placement: .topBarTrailing) {
                                Menu {
                                    Button {
                                        session.copyAllText()
                                    } label: {
                                        Label("Copy all", systemImage: "doc.on.doc")
                                    }
                                    Button {
                                        session.pasteFromClipboard()
                                    } label: {
                                        Label("Paste", systemImage: "doc.on.clipboard")
                                    }
                                    Button {
                                        session.clearDisplay()
                                    } label: {
                                        Label("Clear", systemImage: "trash")
                                    }
                                    Divider()
                                    Button {
                                        session.restart()
                                    } label: {
                                        Label("Restart shell", systemImage: "arrow.clockwise")
                                    }
                                } label: {
                                    Image(systemName: "ellipsis.circle")
                                        .font(.system(size: 16, weight: .regular))
                                        .foregroundStyle(theme.foregroundMuted)
                                }
                            }
                        }
                }
                .preferredColorScheme(theme.isDark ? .dark : .light)
            }
        }
        .onAppear {
            session.startIfNeeded()
        }
        .onDisappear {
            if closesOnDisappear {
                session.close()
            }
        }
    }

    private var terminalCore: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .bottomTrailing) {
                RelayTerminalSurfaceView(
                    session: session,
                    theme: theme,
                    fontSize: 12.5
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(theme.terminalBg)

                if session.status == .connecting && !session.hasReceivedOutput {
                    VStack(spacing: 8) {
                        ProgressView()
                            .tint(theme.foregroundMuted)
                        Text("Starting terminal…")
                            .font(RelayTheme.monoFont(12))
                            .foregroundStyle(theme.foregroundMuted)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .allowsHitTesting(false)
                }

                // Floating action pills (Copy selection / Jump to bottom)
                VStack(alignment: .trailing, spacing: 8) {
                    if session.hasSelection {
                        floatingPill(title: "Copy", systemImage: "doc.on.doc") {
                            session.requestCopySelection()
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.92)))
                    }

                    if session.isScrolledUp {
                        floatingPill(title: "Jump to bottom", systemImage: "arrow.down") {
                            session.requestScrollToBottom()
                        }
                        .transition(.opacity.combined(with: .scale(scale: 0.92)))
                    }
                }
                .padding(.trailing, 12)
                .padding(.bottom, 12)
                .animation(.easeOut(duration: 0.16), value: session.hasSelection)
                .animation(.easeOut(duration: 0.16), value: session.isScrolledUp)

                // Ephemeral confirmation toast (Copied / Pasted)
                if let toast = session.toastMessage {
                    VStack {
                        Text(toast)
                            .font(RelayTheme.uiFont(12, weight: .medium))
                            .foregroundStyle(theme.foreground)
                            .padding(.horizontal, 12)
                            .padding(.vertical, 6)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(theme.surface2)
                            )
                            .overlay(
                                Capsule(style: .continuous)
                                    .strokeBorder(theme.border, lineWidth: 1)
                            )
                            .padding(.top, 10)
                        Spacer()
                    }
                    .frame(maxWidth: .infinity)
                    .allowsHitTesting(false)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
            .animation(.easeOut(duration: 0.15), value: session.toastMessage)

            if let banner = statusBanner {
                statusBannerRow(text: banner.text, isError: banner.isError)
            }

            RelayTerminalKeyBar(session: session)
        }
        .background(theme.terminalBg)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            session.isKeyboardVisible = false
        }
    }

    private var statusBanner: (text: String, isError: Bool)? {
        switch session.status {
        case .failed(let message):
            return (message, true)
        case .exited(let code):
            if let code {
                return ("Process exited with code \(code)", code != 0)
            }
            return ("Terminal session ended", false)
        case .running, .connecting, .idle:
            if let errorMessage = session.errorMessage {
                return (errorMessage, true)
            }
            return nil
        }
    }

    private func statusBannerRow(text: String, isError: Bool) -> some View {
        HStack(spacing: 10) {
            Text(text)
                .font(RelayTheme.uiFont(12, weight: .regular))
                .foregroundStyle(isError ? theme.statusDanger : theme.foregroundMuted)
                .lineLimit(2)
                .frame(maxWidth: .infinity, alignment: .leading)

            Button {
                session.restart()
            } label: {
                Text("Restart")
                    .font(RelayTheme.uiFont(12, weight: .semibold))
                    .foregroundStyle(theme.foreground)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .fill(theme.surface2)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                            .strokeBorder(theme.border, lineWidth: 1)
                    )
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(theme.surface1)
        .overlay(alignment: .top) {
            Rectangle()
                .fill(theme.border)
                .frame(height: 1)
        }
    }

    private func floatingPill(
        title: String,
        systemImage: String,
        action: @escaping () -> Void
    ) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            action()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: systemImage)
                    .font(.system(size: 11, weight: .semibold))
                Text(title)
                    .font(RelayTheme.uiFont(12, weight: .medium))
            }
            .foregroundStyle(theme.foreground)
            .padding(.horizontal, 11)
            .padding(.vertical, 7)
            .background(
                Capsule(style: .continuous)
                    .fill(theme.surface2.opacity(0.95))
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(theme.border, lineWidth: 1)
            )
            .shadow(color: Color.black.opacity(theme.isDark ? 0.4 : 0.14), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
    }
}
