import AVFoundation
import SwiftUI
import UIKit

struct RelayChatView: View {
    @ObservedObject var viewModel: RelayChatViewModel
    @State private var showingModels = false
    @State private var showingThreads = false
    @State private var showingOptions = false
    @State private var fullLogText: String?

    var body: some View {
        NavigationStack {
            ZStack {
                AppTheme.canvasGradient.ignoresSafeArea()
                AppTheme.accent.opacity(0.06)
                    .blur(radius: 80)
                    .frame(height: 200)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    topBar
                    messageList
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom) {
                RelayComposer(
                    text: $viewModel.prompt,
                    mode: $viewModel.mode,
                    model: viewModel.selectedModel,
                    workspaceName: viewModel.selectedWorkspace?.name,
                    efforts: viewModel.availableEfforts,
                    selectedEffort: viewModel.effectiveEffort,
                    showsModeToggle: viewModel.lockedMode == nil,
                    isSending: viewModel.isSending,
                    isStreaming: viewModel.isStreaming,
                    isTranscribing: viewModel.isTranscribing,
                    onPickModel: { showingModels = true },
                    onPickEffort: { viewModel.selectEffort($0) },
                    onOptions: { showingOptions = true },
                    onVoice: { fileURL in
                        Task { await viewModel.transcribePromptAudio(fileURL: fileURL) }
                    },
                    onSend: {
                        UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                        Task { await viewModel.sendCurrentPrompt() }
                    },
                    onStop: {
                        UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
                        viewModel.stopStreaming()
                    }
                )
            }
            .task {
                await viewModel.bootstrap()
                #if DEBUG
                if ProcessInfo.processInfo.environment["RELAY_UITEST_OPEN"] == "workspace",
                   viewModel.lockedMode == .task {
                    showingOptions = true
                }
                #endif
            }
            .task {
                // Live job polling for the Task tab; cancelled automatically when the
                // view leaves the screen. No-op on the Chat tab.
                await viewModel.monitorActiveJobs()
            }
            .refreshable {
                await viewModel.refreshThreads()
            }
            .sheet(isPresented: $showingModels) {
                RelayModelPickerSheet(viewModel: viewModel)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingThreads) {
                RelayThreadDrawer(viewModel: viewModel)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(isPresented: $showingOptions) {
                RelayWorkspaceSheet(viewModel: viewModel)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: Binding(
                get: { fullLogText.map(RelayFullLogText.init(text:)) },
                set: { fullLogText = $0?.text }
            )) { payload in
                RelayFullLogSheet(text: payload.text)
            }
        }
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            Button {
                viewModel.startNewConversation()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(AppTheme.uiFont(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(width: 36, height: 36)
                    .background(AppTheme.bgSurfaceHi, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("New conversation")

            HStack(spacing: 9) {
                Circle()
                    .fill(AppTheme.accentGradient)
                    .frame(width: 30, height: 30)
                    .overlay {
                        Image(systemName: "sparkle")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    .shadow(color: AppTheme.accent.opacity(0.5), radius: 6, y: 2)
                VStack(alignment: .leading, spacing: 1) {
                    Text(viewModel.lockedMode == .task ? "Task" : viewModel.lockedMode == .chat ? "Chat" : "Relay")
                        .font(AppTheme.uiFont(size: 22, weight: .bold))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text(viewModel.selectedModel?.label ?? "Loading models")
                        .font(AppTheme.uiFont(size: 11, weight: .medium))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer()

            Button {
                showingThreads = true
            } label: {
                Image(systemName: "sidebar.left")
                    .font(AppTheme.uiFont(size: 16, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                    .frame(width: 36, height: 36)
                    .background(AppTheme.bgSurfaceHi, in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Threads")
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    if let error = viewModel.errorMessage {
                        RelayStatusBanner(text: error)
                    }

                    if viewModel.messages.isEmpty && !viewModel.isSending {
                        RelayEmptyConversation(model: viewModel.selectedModel, mode: viewModel.mode)
                    } else {
                        ForEach(viewModel.messages) { item in
                            if let job = item.job {
                                RelayJobCard(
                                    job: job,
                                    isCancelling: viewModel.cancellingJobIDs.contains(job.id),
                                    onCancel: {
                                        Task { await viewModel.cancel(job: job) }
                                    },
                                    onFullLog: {
                                        Task { fullLogText = await viewModel.loadFullLog(for: job) }
                                    }
                                )
                                .id(item.id)
                                .transition(.move(edge: .bottom).combined(with: .opacity))
                            } else {
                                RelayChatBubble(item: item)
                                    .id(item.id)
                                    .transition(.move(edge: item.role == .user ? .trailing : .leading).combined(with: .opacity))
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id(Self.bottomAnchor)
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .padding(.bottom, 20)
            }
            .scrollDismissesKeyboard(.interactively)
            .animation(.spring(response: 0.36, dampingFraction: 0.82), value: viewModel.messages.count)
            .onChange(of: viewModel.messages.count) { _, _ in scrollToBottom(proxy) }
            .onChange(of: streamingTextLength) { _, _ in scrollToBottom(proxy, animated: false) }
            .overlay(alignment: .bottomTrailing) { scrollToBottomButton(proxy) }
        }
    }

    /// Total length of the streaming assistant message; changing this drives auto-follow scroll.
    private var streamingTextLength: Int {
        guard let id = viewModel.streamingMessageID,
              let item = viewModel.messages.first(where: { $0.id == id }) else { return 0 }
        return item.text.count
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool = true) {
        if animated {
            withAnimation(.easeOut(duration: 0.22)) { proxy.scrollTo(Self.bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(Self.bottomAnchor, anchor: .bottom)
        }
    }

    @ViewBuilder private func scrollToBottomButton(_ proxy: ScrollViewProxy) -> some View {
        if viewModel.isStreaming {
            Button {
                scrollToBottom(proxy)
            } label: {
                Image(systemName: "arrow.down")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(AppTheme.textPrimary)
                    .frame(width: 38, height: 38)
                    .background(.ultraThinMaterial, in: Circle())
                    .overlay { Circle().stroke(AppTheme.glassStroke, lineWidth: 0.6) }
                    .shadow(color: AppTheme.shadowColor, radius: 8, y: 3)
            }
            .buttonStyle(.plain)
            .padding(.trailing, 16)
            .padding(.bottom, 8)
            .transition(.scale.combined(with: .opacity))
        }
    }

    private static let bottomAnchor = "relay-bottom-anchor"
}

private struct RelayComposer: View {
    private static let normalBottomPadding: CGFloat = 8

    @Binding var text: String
    @Binding var mode: RelayInteractionMode
    let model: CodexModelDescriptor?
    let workspaceName: String?
    let efforts: [CodexReasoningEffort]
    let selectedEffort: CodexReasoningEffort?
    let showsModeToggle: Bool
    let isSending: Bool
    let isStreaming: Bool
    let isTranscribing: Bool
    let onPickModel: () -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onOptions: () -> Void
    let onVoice: (URL) -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    @FocusState private var isFocused: Bool
    @StateObject private var recorder = RelayPromptAudioRecorder()

    private func chip(icon: String, text: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { chipLabel(icon: icon, text: text) }
            .buttonStyle(.plain)
    }

    private func chipLabel(icon: String, text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
            Text(text)
                .font(AppTheme.uiFont(size: 13, weight: .medium))
                .lineLimit(1)
                .truncationMode(.tail)
            Image(systemName: "chevron.up.chevron.down")
                .font(AppTheme.uiFont(size: 9, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
        }
        .foregroundStyle(AppTheme.textPrimary)
        .padding(.horizontal, 12)
        .frame(height: 34)
        .frame(maxWidth: 200, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        .background(AppTheme.bgSurfaceHi, in: Capsule())
    }

    var body: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button(action: onPickModel) {
                    HStack(spacing: 7) {
                        Circle()
                            .fill(AppTheme.accent)
                            .frame(width: 7, height: 7)
                        // Label already carries the provider (e.g. "gpt-4o (Azure)"), so no
                        // separate provider badge here — just the name and a chevron affordance.
                        Text(model?.label ?? "Model")
                            .font(AppTheme.uiFont(size: 13, weight: .medium))
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(AppTheme.uiFont(size: 9, weight: .semibold))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .frame(maxWidth: 220, alignment: .leading)
                    .background(AppTheme.bgSurfaceHi, in: Capsule())
                }
                .buttonStyle(.plain)

                Spacer()

                if showsModeToggle {
                    Picker("Mode", selection: $mode) {
                        ForEach(RelayInteractionMode.allCases) { mode in
                            Text(mode.label).tag(mode)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(width: 132)
                }
            }

            // Task-only controls: workspace + reasoning effort. A plain bounded row (no
            // horizontal ScrollView, which renders unbounded inside a safeAreaInset and
            // blanks the screen on device). Chips truncate rather than scroll.
            if mode == .task {
                HStack(spacing: 8) {
                    chip(icon: "folder.fill", text: workspaceName ?? "Workspace", action: onOptions)
                        .accessibilityIdentifier("relay-workspace-chip")
                        .layoutPriority(1)

                    if !efforts.isEmpty {
                        Menu {
                            ForEach(efforts) { effort in
                                Button {
                                    onPickEffort(effort)
                                } label: {
                                    Label(effort.label, systemImage: selectedEffort == effort ? "checkmark" : "")
                                }
                            }
                        } label: {
                            chipLabel(icon: "gauge.with.dots.needle.50percent",
                                      text: (selectedEffort ?? efforts.first(where: { $0 == .high }) ?? efforts.first)?.label ?? "Effort")
                        }
                        .accessibilityIdentifier("relay-effort-chip")
                    }

                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity)
            }

            HStack(alignment: .bottom, spacing: 9) {
                Button {
                    toggleRecording()
                } label: {
                    ZStack {
                        if isTranscribing {
                            ProgressView()
                                .tint(AppTheme.textSecondary)
                                .controlSize(.small)
                        } else {
                            Image(systemName: recorder.isRecording ? "stop.fill" : "mic.fill")
                                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                                .foregroundStyle(recorder.isRecording ? AppTheme.statusWarn : AppTheme.textSecondary)
                        }
                    }
                    .frame(width: 30, height: 34)
                }
                .buttonStyle(.plain)
                .disabled(isSending || isTranscribing)
                .accessibilityLabel(recorder.isRecording ? "Stop recording" : "Record prompt")

                TextField("Message...", text: $text, axis: .vertical)
                    .font(AppTheme.uiFont(size: 15))
                    .lineLimit(1...6)
                    .textFieldStyle(.plain)
                    .focused($isFocused)
                    .foregroundStyle(AppTheme.textPrimary)
                    .padding(.vertical, 8)

                if isStreaming {
                    Button(action: onStop) {
                        ZStack {
                            Circle().fill(AppTheme.accentGradient).frame(width: 34, height: 34)
                            RoundedRectangle(cornerRadius: 3).fill(.white).frame(width: 12, height: 12)
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("relay-stop")
                    .accessibilityLabel("Stop")
                    .transition(.scale.combined(with: .opacity))
                } else {
                    Button {
                        isFocused = false
                        onSend()
                    } label: {
                        ZStack {
                            Circle()
                                .fill(canSend ? AnyShapeStyle(AppTheme.accentGradient) : AnyShapeStyle(AppTheme.bgSurface))
                                .frame(width: 34, height: 34)
                            Image(systemName: mode == .chat ? "arrow.up" : "play.fill")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? .white : AppTheme.textTertiary)
                        }
                        .shadow(color: canSend ? AppTheme.accent.opacity(0.5) : .clear, radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityIdentifier("relay-send")
                    .accessibilityLabel(mode == .chat ? "Send" : "Run job")
                    .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(.ultraThinMaterial)
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .fill(AppTheme.glassTint)
                    }
                    .overlay {
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .stroke(AppTheme.glassStroke, lineWidth: 0.7)
                    }
            }
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isStreaming)
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, Self.normalBottomPadding)
        .background(AppTheme.bgCanvas)
        .animation(.easeOut(duration: 0.18), value: isFocused)
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button {
                    isFocused = false
                } label: {
                    Image(systemName: "keyboard.chevron.compact.down")
                        .font(AppTheme.uiFont(size: 17, weight: .semibold))
                }
                .foregroundStyle(AppTheme.accent)
                .accessibilityLabel("Dismiss keyboard")
            }
        }
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending && !isTranscribing && !recorder.isRecording
    }

    private func toggleRecording() {
        if recorder.isRecording {
            if let fileURL = recorder.stopRecording() {
                onVoice(fileURL)
            }
            return
        }
        isFocused = false
        Task {
            try? await recorder.startRecording()
        }
    }
}

private struct RelayChatBubble: View {
    let item: RelayConversationItem
    @State private var showCopied = false

    private var showWaitingDots: Bool { item.isStreaming && item.text.isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if isUser { Spacer(minLength: 44) }
            if !isUser { avatar }

            VStack(alignment: .leading, spacing: 7) {
                HStack(spacing: 6) {
                    Text(label)
                        .font(AppTheme.uiFont(size: 11, weight: .semibold))
                        .foregroundStyle(metaColor)
                    if let model = item.modelLabel, !isUser {
                        Text(model)
                            .font(AppTheme.uiFont(size: 11))
                            .foregroundStyle(AppTheme.textTertiary)
                            .lineLimit(1)
                    }
                    if showCopied {
                        Text("Copied")
                            .font(AppTheme.uiFont(size: 10, weight: .semibold))
                            .foregroundStyle(AppTheme.statusOK)
                            .transition(.opacity)
                    }
                }

                if showWaitingDots {
                    RelayTypingDots()
                        .padding(.vertical, 2)
                } else {
                    RelayStreamingContent(text: item.text, isStreaming: item.isStreaming, userAligned: isUser)
                }

                if let footer = footerText {
                    Text(footer)
                        .font(AppTheme.monoFont(size: 10))
                        .foregroundStyle(isUser ? AppTheme.bgCanvas.opacity(0.6) : AppTheme.textTertiary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(bubbleBackground)
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(bubbleStroke, lineWidth: 0.6)
            }
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .shadow(color: AppTheme.shadowColor.opacity(isUser ? 0.4 : 0.25), radius: isUser ? 10 : 6, x: 0, y: 4)
            .contextMenu {
                Button {
                    UIPasteboard.general.string = item.text
                    flashCopied()
                } label: { Label("Copy", systemImage: "doc.on.doc") }
            }

            if !isUser { Spacer(minLength: 44) }
        }
    }

    @ViewBuilder private var bubbleBackground: some View {
        if isUser {
            AppTheme.userBubbleGradient
        } else {
            ZStack {
                AppTheme.bgSurfaceHi
                AppTheme.glassTint
            }
        }
    }

    private var avatar: some View {
        Circle()
            .fill(AppTheme.accentGradient)
            .frame(width: 26, height: 26)
            .overlay {
                Image(systemName: "sparkle")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(.white)
            }
            .shadow(color: AppTheme.accent.opacity(0.5), radius: 5, x: 0, y: 2)
    }

    private func flashCopied() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation(.easeOut(duration: 0.2)) { showCopied = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            withAnimation(.easeOut(duration: 0.3)) { showCopied = false }
        }
    }

    private var footerText: String? {
        guard !item.isStreaming else { return nil }
        var parts: [String] = []
        if let usage = item.usage, !usage.isEmpty {
            let tin = usage.inputTokens.map { "\($0) in" }
            let tout = usage.outputTokens.map { "\($0) out" }
            let toks = [tin, tout].compactMap { $0 }.joined(separator: " · ")
            if !toks.isEmpty { parts.append(toks) }
        }
        if let secs = item.elapsedSeconds, secs >= 0.05, !isUser {
            parts.append(String(format: "%.1fs", secs))
        }
        return parts.isEmpty ? nil : parts.joined(separator: "  ·  ")
    }

    private var isUser: Bool { item.role == .user }
    private var label: String { isUser ? "You" : item.provider?.displayName ?? "Relay" }
    private var metaColor: Color { isUser ? AppTheme.bgCanvas.opacity(0.78) : AppTheme.accent }
    private var bubbleStroke: Color { isUser ? Color.white.opacity(0.14) : AppTheme.glassStroke }
}

/// Animated three-dot "thinking" indicator shown before the first token arrives.
private struct RelayTypingDots: View {
    @State private var phase = 0.0

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(AppTheme.accent)
                    .frame(width: 7, height: 7)
                    .scaleEffect(scale(for: i))
                    .opacity(0.5 + 0.5 * scale(for: i))
            }
        }
        .onAppear {
            withAnimation(.easeInOut(duration: 0.6).repeatForever(autoreverses: true)) {
                phase = 1.0
            }
        }
    }

    private func scale(for index: Int) -> Double {
        let offset = Double(index) * 0.22
        let v = sin((phase + offset) * .pi)
        return 0.7 + 0.45 * abs(v)
    }
}

/// Renders streamed assistant text with a blinking caret appended while streaming.
private struct RelayStreamingContent: View {
    let text: String
    let isStreaming: Bool
    let userAligned: Bool
    @State private var caretOn = true

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            RelayMarkdownText(text: text, userAligned: userAligned)
            if isStreaming {
                Rectangle()
                    .fill(AppTheme.accent)
                    .frame(width: 8, height: 16)
                    .opacity(caretOn ? 1 : 0)
                    .padding(.top, 2)
                    .onAppear {
                        withAnimation(.easeInOut(duration: 0.5).repeatForever(autoreverses: true)) {
                            caretOn = false
                        }
                    }
            }
        }
    }
}

private struct RelayMarkdownText: View {
    let text: String
    let userAligned: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                switch segment.kind {
                case .prose:
                    RelayMarkdownProse(
                        text: segment.text,
                        color: userAligned ? AppTheme.bgCanvas.opacity(0.94) : AppTheme.textPrimary,
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

private struct RelayMarkdownProse: View {
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

private struct RelayMarkdownTable: View {
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
        isOnAccent ? AppTheme.bgCanvas.opacity(0.13) : AppTheme.bgCanvas.opacity(0.72)
    }

    private var borderColor: Color {
        isOnAccent ? AppTheme.bgCanvas.opacity(0.24) : AppTheme.strokeSubtle
    }
}

private struct RelayCodeBlock: View {
    let text: String
    let language: String?

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
            Text(text)
                .font(AppTheme.monoFont(size: 12))
                .foregroundStyle(AppTheme.textPrimary)
                .textSelection(.enabled)
                .lineLimit(24)
        }
        .padding(10)
        .background(AppTheme.bgCanvas, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private var languageLabel: String {
        language?.trimmedNonEmpty?.uppercased() ?? "Code"
    }
}

private struct RelayJobCard: View {
    let job: CodexJob
    let isCancelling: Bool
    let onCancel: () -> Void
    let onFullLog: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                RelayStatusPill(status: job.status)
                Text(job.provider.displayName)
                    .font(AppTheme.uiFont(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)
                Spacer()
                Text(elapsedText)
                    .font(AppTheme.monoFont(size: 11))
                    .foregroundStyle(AppTheme.textTertiary)
            }

            if let text = job.displayOutput?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                if job.status.isActive {
                    // While running, show raw streaming logs in mono (it's progress output).
                    Text(text)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(10)
                        .textSelection(.enabled)
                } else {
                    // Final result: render markdown like chat replies (bold, code, lists).
                    RelayMarkdownText(text: text, userAligned: false)
                }
            } else if job.status.isActive {
                // No output yet but the job is live — show motion so it never looks frozen.
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small).tint(AppTheme.accent)
                    Text(job.status == .queued ? "Queued…" : "Working…")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textSecondary)
                }
            }

            HStack {
                if job.status.isActive {
                    Button(isCancelling ? "Canceling" : "Cancel", role: .destructive, action: onCancel)
                        .foregroundStyle(AppTheme.statusError)
                        .disabled(isCancelling)
                }
                Spacer()
                Button("View full log", action: onFullLog)
                    .foregroundStyle(AppTheme.accent)
            }
            .font(AppTheme.uiFont(size: 13, weight: .medium))
        }
        .padding(14)
        .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(AppTheme.accent.opacity(0.22), lineWidth: 0.8)
        }
    }

    private var elapsedText: String {
        guard let duration = job.durationMs else { return job.status.label }
        return "\(max(1, duration / 1000))s"
    }
}

private struct RelayStatusPill: View {
    let status: CodexJobStatus

    var body: some View {
        Text(status.label)
            .font(AppTheme.uiFont(size: 11, weight: .semibold))
            .foregroundStyle(status.relayTint)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(status.relayTint.opacity(0.12), in: Capsule())
    }
}

private extension CodexJobStatus {
    var relayTint: Color {
        switch self {
        case .queued, .running, .canceling:
            return AppTheme.statusWarn
        case .succeeded:
            return AppTheme.statusOK
        case .failed:
            return AppTheme.statusError
        case .canceled, .timeout:
            return AppTheme.statusNeutral
        case .unknown:
            return AppTheme.statusInfo
        }
    }
}

private struct RelayModelPickerSheet: View {
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var bucket: RelayModelPickerBucket = .latest
    @State private var searchText = ""

    // Task mode has a small fixed model set, so the chat-style Latest/All bucket toggle is
    // irrelevant noise there — show a clean provider-grouped list. Chat keeps the buckets.
    private var isTask: Bool { viewModel.mode == .task }

    var body: some View {
        NavigationStack {
            List {
                if !isTask {
                    Section {
                        Picker("Model list", selection: $bucket) {
                            ForEach(RelayModelPickerBucket.allCases) { bucket in
                                Text(bucket.label).tag(bucket)
                            }
                        }
                        .pickerStyle(.segmented)
                        .labelsHidden()
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowBackground(AppTheme.bgCanvas)
                    }
                }

                let sections = isTask
                    ? viewModel.modelSections(bucket: .all, searchText: searchText)
                    : viewModel.modelSections(bucket: bucket, searchText: searchText)
                ForEach(sections) { section in
                    Section(section.title) {
                        ForEach(section.models) { model in
                            RelayModelPickerRow(
                                model: model,
                                isSelected: viewModel.selectedModelID == model.id,
                                isEnabled: model.supports(viewModel.mode)
                            ) {
                                viewModel.selectModel(model)
                                dismiss()
                            }
                        }
                    }
                }
            }
            .searchable(text: $searchText, prompt: "Search models")
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle(isTask ? "Task model" : "Models")
            .navigationBarTitleDisplayMode(.inline)
            .preferredColorScheme(.dark)
        }
    }
}

private struct RelayModelPickerRow: View {
    let model: CodexModelDescriptor
    let isSelected: Bool
    let isEnabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Circle()
                    .fill(isEnabled ? AppTheme.accent : AppTheme.textTertiary)
                    .frame(width: 8, height: 8)

                VStack(alignment: .leading, spacing: 5) {
                    Text(model.label)
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(isEnabled ? AppTheme.textPrimary : AppTheme.textTertiary)
                        .lineLimit(2)
                    // The provider already lives in the label ("… (Azure)") and rows are
                    // grouped by provider in the All bucket, so only surface a subtitle when
                    // it adds information: a model that supports more than one mode.
                    if model.modes.count > 1 {
                        Text(model.modes.map(\.label).joined(separator: " / "))
                            .font(AppTheme.uiFont(size: 12, weight: .medium))
                            .foregroundStyle(AppTheme.textSecondary)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 8)

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(!isEnabled)
        .listRowBackground(AppTheme.bgSurface)
    }
}

private struct RelayThreadDrawer: View {
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        viewModel.startNewConversation()
                        dismiss()
                    } label: {
                        Label("New conversation", systemImage: "square.and.pencil")
                            .foregroundStyle(AppTheme.accent)
                    }
                    .listRowBackground(AppTheme.bgSurface)
                }

                if viewModel.visibleThreads.isEmpty {
                    Text("No threads yet.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                        .listRowBackground(AppTheme.bgCanvas)
                }

                // Threads grouped per workspace folder, newest folder first.
                ForEach(viewModel.threadsByWorkspace, id: \.workspace) { group in
                    Section {
                        ForEach(group.threads) { thread in
                            threadRow(thread)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Image(systemName: "folder.fill")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(AppTheme.accent)
                            Text(group.workspace)
                                .font(AppTheme.uiFont(size: 12, weight: .semibold))
                                .foregroundStyle(AppTheme.textSecondary)
                            Spacer()
                            Text("\(group.threads.count)")
                                .font(AppTheme.monoFont(size: 11))
                                .foregroundStyle(AppTheme.textTertiary)
                        }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle(viewModel.lockedMode == .task ? "Task threads" : "Threads")
            .navigationBarTitleDisplayMode(.inline)
            .task { await viewModel.refreshThreads() }
            .preferredColorScheme(.dark)
        }
    }

    private func threadRow(_ thread: CodexThread) -> some View {
        Button {
            Task {
                await viewModel.openThread(thread)
                dismiss()
            }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(thread.displayTitle)
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    if thread.hasActiveJobs {
                        Circle().fill(AppTheme.statusWarn).frame(width: 7, height: 7)
                    } else if viewModel.lockedMode == nil {
                        Text(thread.mode.label)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(AppTheme.accent)
                    }
                }
                Text(thread.feedPreview)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(2)
            }
        }
        .listRowBackground(AppTheme.bgSurface)
    }
}

/// Unified folder browser for picking the task workspace.
///
/// Mental model: you are always navigating a folder tree rooted at the workspace root.
/// Tapping a folder row drills INTO it (never dismisses). A persistent primary button
/// selects whichever folder you are currently in. Registered workspaces also expose a
/// per-row quick-pick so you can choose one without navigating. Create-new is inline.
private struct RelayWorkspaceSheet: View {
    @ObservedObject var viewModel: RelayChatViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var creatingName = ""
    @State private var showCreateField = false
    @FocusState private var createFieldFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                breadcrumb
                Divider().overlay(AppTheme.glassStroke)
                folderList
                confirmBar
            }
            .background(AppTheme.canvasGradient.ignoresSafeArea())
            .navigationTitle("Choose workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .font(AppTheme.uiFont(size: 14, weight: .semibold))
                        .foregroundStyle(AppTheme.accent)
                }
            }
            .task {
                #if DEBUG
                // Visual-test deep link to a starting folder, e.g. RELAY_UITEST_WS_PATH=/srv/codex-workspaces/sigiq
                if let start = ProcessInfo.processInfo.environment["RELAY_UITEST_WS_PATH"], !start.isEmpty {
                    await viewModel.loadWorkspaceDirectories(path: start)
                    return
                }
                #endif
                await viewModel.loadWorkspaceDirectories()
            }
            .preferredColorScheme(.dark)
        }
    }

    private var listing: CodexWorkspaceDirectoryListing? { viewModel.directoryListing }

    // MARK: breadcrumb / current location

    private var breadcrumb: some View {
        HStack(spacing: 8) {
            if let up = listing?.upNavigationPath {
                Button {
                    UISelectionFeedbackGenerator().selectionChanged()
                    Task { await viewModel.loadWorkspaceDirectories(path: up) }
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(AppTheme.accent)
                        .frame(width: 32, height: 32)
                        .background(AppTheme.bgSurfaceHi, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Up one level")
            }

            Image(systemName: "folder.fill")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
            Text(currentLocationText)
                .font(AppTheme.monoFont(size: 12))
                .foregroundStyle(AppTheme.textSecondary)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    private var currentLocationText: String {
        guard let listing else { return "…" }
        let rel = listing.displayPath.trimmingCharacters(in: .whitespaces)
        return rel.isEmpty ? "All workspaces" : rel
    }

    // MARK: folder list

    private var folderList: some View {
        ScrollView {
            LazyVStack(spacing: 10) {
                if let error = viewModel.workspaceActionError {
                    RelayStatusBanner(text: error)
                }

                if let listing {
                    if listing.entries.isEmpty {
                        Text("No subfolders here.")
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(AppTheme.textTertiary)
                            .frame(maxWidth: .infinity, alignment: .center)
                            .padding(.top, 28)
                    }
                    ForEach(listing.entries) { entry in
                        RelayFolderRow(
                            entry: entry,
                            isCurrentSelection: isSelected(entry),
                            onOpen: {
                                UISelectionFeedbackGenerator().selectionChanged()
                                Task { await viewModel.loadWorkspaceDirectories(path: entry.path) }
                            },
                            onQuickPick: entry.isRegistered ? {
                                UINotificationFeedbackGenerator().notificationOccurred(.success)
                                Task {
                                    await viewModel.selectBrowsedDirectory(path: entry.path)
                                    dismiss()
                                }
                            } : nil
                        )
                    }
                    createRow(parentPath: listing.currentPath)
                } else if viewModel.isBrowsingDirectories {
                    ProgressView().tint(AppTheme.accent).padding(.top, 44)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    private func isSelected(_ entry: CodexWorkspaceDirectoryEntry) -> Bool {
        if let id = entry.workspaceId { return viewModel.selectedWorkspaceID == id }
        return false
    }

    @ViewBuilder private func createRow(parentPath: String) -> some View {
        if showCreateField {
            HStack(spacing: 8) {
                Image(systemName: "folder.badge.plus")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                    .frame(width: 40, height: 40)
                    .background(AppTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                TextField("New folder name", text: $creatingName)
                    .font(AppTheme.uiFont(size: 14))
                    .textFieldStyle(.plain)
                    .foregroundStyle(AppTheme.textPrimary)
                    .focused($createFieldFocused)
                    .submitLabel(.done)
                    .onSubmit { submitCreate(parentPath: parentPath) }
                Button { submitCreate(parentPath: parentPath) } label: {
                    Image(systemName: "checkmark")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(AppTheme.accentGradient, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                }
                .buttonStyle(.plain)
                .disabled(creatingName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(10)
            .background(AppTheme.bgSurfaceHi, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        } else {
            Button {
                withAnimation { showCreateField = true }
                createFieldFocused = true
            } label: {
                HStack(spacing: 13) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundStyle(AppTheme.accent)
                        .frame(width: 40, height: 40)
                        .background(AppTheme.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 11, style: .continuous))
                    Text("New folder here")
                        .font(AppTheme.uiFont(size: 15, weight: .medium))
                        .foregroundStyle(AppTheme.accent)
                    Spacer()
                }
                .padding(.vertical, 4)
            }
            .buttonStyle(.plain)
        }
    }

    private func submitCreate(parentPath: String) {
        let name = creatingName
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return }
        Task {
            await viewModel.createWorkspace(parentPath: parentPath, name: name)
            creatingName = ""
            showCreateField = false
        }
    }

    // MARK: confirm bar

    private var confirmBar: some View {
        VStack(spacing: 0) {
            Divider().overlay(AppTheme.glassStroke)
            Button {
                guard let listing else { return }
                UINotificationFeedbackGenerator().notificationOccurred(.success)
                Task {
                    await viewModel.selectBrowsedDirectory(path: listing.currentPath)
                    dismiss()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 16, weight: .bold))
                    Text(confirmTitle)
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .lineLimit(1)
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 52)
                .background(canConfirm ? AnyShapeStyle(AppTheme.accentGradient) : AnyShapeStyle(AppTheme.bgSurface))
                .clipShape(RoundedRectangle(cornerRadius: 15, style: .continuous))
                .shadow(color: canConfirm ? AppTheme.accent.opacity(0.45) : .clear, radius: 10, y: 4)
            }
            .buttonStyle(.plain)
            .disabled(!canConfirm)
            .padding(16)
        }
        .background(.ultraThinMaterial)
    }

    /// You can't select the synthetic root ("All workspaces") — only a real folder.
    private var canConfirm: Bool {
        guard let listing else { return false }
        return listing.currentPath != listing.rootPath
    }

    private var confirmTitle: String {
        guard let listing, canConfirm else { return "Open a folder to select it" }
        let name = URL(fileURLWithPath: listing.currentPath).lastPathComponent
        return "Use “\(name)” as workspace"
    }
}

/// A single folder row in the workspace browser. The whole row drills in; registered
/// workspaces show a quick-pick checkmark on the trailing edge.
private struct RelayFolderRow: View {
    let entry: CodexWorkspaceDirectoryEntry
    let isCurrentSelection: Bool
    let onOpen: () -> Void
    let onQuickPick: (() -> Void)?

    var body: some View {
        HStack(spacing: 12) {
            Button(action: onOpen) {
                HStack(spacing: 13) {
                    Image(systemName: entry.hasGit ? "arrow.triangle.branch" : "folder.fill")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(isCurrentSelection ? .white : AppTheme.accent)
                        .frame(width: 40, height: 40)
                        .background(
                            isCurrentSelection ? AnyShapeStyle(AppTheme.accentGradient) : AnyShapeStyle(AppTheme.accent.opacity(0.14)),
                            in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                        )
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(entry.displayName)
                                .font(AppTheme.uiFont(size: 15, weight: .semibold))
                                .foregroundStyle(AppTheme.textPrimary)
                                .lineLimit(1)
                            if entry.isRegistered {
                                Text("Workspace")
                                    .font(AppTheme.uiFont(size: 9, weight: .bold))
                                    .foregroundStyle(AppTheme.accent)
                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                    .background(AppTheme.accent.opacity(0.15), in: Capsule())
                            }
                        }
                        Text(entry.hasGit ? "Git repository" : "Folder")
                            .font(AppTheme.uiFont(size: 11))
                            .foregroundStyle(AppTheme.textTertiary)
                    }
                    Spacer(minLength: 6)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isCurrentSelection {
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 20))
                    .foregroundStyle(AppTheme.accent)
            } else if let onQuickPick {
                Button(action: onQuickPick) {
                    Image(systemName: "circle")
                        .font(.system(size: 20))
                        .foregroundStyle(AppTheme.textTertiary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Select \(entry.displayName)")
            } else {
                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(AppTheme.textTertiary)
            }
        }
        .padding(12)
        .background {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(AppTheme.bgSurfaceHi)
                .overlay { RoundedRectangle(cornerRadius: 16, style: .continuous).fill(AppTheme.glassTint) }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isCurrentSelection ? AppTheme.accent.opacity(0.6) : AppTheme.glassStroke, lineWidth: isCurrentSelection ? 1.2 : 0.7)
        }
    }
}

private struct RelayStatusBanner: View {
    let text: String

    var body: some View {
        Text(text)
            .font(AppTheme.uiFont(size: 13))
            .foregroundStyle(AppTheme.statusError)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(AppTheme.statusError.opacity(0.10), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct RelayEmptyConversation: View {
    let model: CodexModelDescriptor?
    let mode: RelayInteractionMode

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: mode == .chat ? "message.fill" : "terminal.fill")
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 78, height: 78)
                .background(AppTheme.accentGradient, in: Circle())
                .shadow(color: AppTheme.accent.opacity(0.45), radius: 16, y: 6)

            VStack(spacing: 6) {
                Text(mode == .chat ? "Start a conversation" : "Run a task")
                    .font(AppTheme.uiFont(size: 20, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(mode == .chat
                     ? "Stream a reply from your selected model."
                     : "Queue a Codex or Claude job in your workspace.")
                    .font(AppTheme.uiFont(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }

            if let label = model?.label {
                Text(label)
                    .font(AppTheme.uiFont(size: 12, weight: .medium))
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.horizontal, 12)
                    .frame(height: 30)
                    .background(AppTheme.bgSurfaceHi, in: Capsule())
            }
        }
        .frame(maxWidth: .infinity, minHeight: 320, alignment: .center)
        .padding(.horizontal, 24)
        .padding(.bottom, 18)
    }
}

private struct RelayFullLogText: Identifiable {
    let id = UUID()
    let text: String
}

private struct RelayFullLogSheet: View {
    let text: String

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text.isEmpty ? "No log output." : text)
                    .font(AppTheme.monoFont(size: 12))
                    .foregroundStyle(AppTheme.textPrimary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
            }
            .background(AppTheme.bgCanvas)
            .navigationTitle("Log")
            .navigationBarTitleDisplayMode(.inline)
            .preferredColorScheme(.dark)
        }
    }
}

@MainActor
private final class RelayPromptAudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    func startRecording() async throws {
        guard !isRecording else { return }
        guard await requestPermission() else { throw RecordingError.microphoneDenied }
        let session = AVAudioSession.sharedInstance()
        let configuration = CodexPromptAudioRecordingConfiguration.devicePromptDefaults
        try session.setCategory(configuration.category, mode: configuration.mode, options: configuration.options)
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("relay-chat-\(UUID().uuidString)")
            .appendingPathExtension("wav")
        let recorder = try AVAudioRecorder(url: url, settings: configuration.settings)
        recorder.delegate = self
        recorder.prepareToRecord()
        guard recorder.record() else { throw RecordingError.startFailed }
        self.recorder = recorder
        recordingURL = url
        isRecording = true
    }

    func stopRecording() -> URL? {
        guard isRecording else { return nil }
        recorder?.stop()
        recorder = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return recordingURL
    }

    func deleteRecording(at url: URL) {
        try? FileManager.default.removeItem(at: url)
        if recordingURL == url {
            recordingURL = nil
        }
    }

    private func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    private enum RecordingError: LocalizedError {
        case microphoneDenied
        case startFailed

        var errorDescription: String? {
            switch self {
            case .microphoneDenied:
                return "Microphone access is not enabled for Relay."
            case .startFailed:
                return "Could not start microphone recording."
            }
        }
    }
}
