import AVFoundation
import SwiftUI
import UIKit

struct RelayChatView: View {
    @ObservedObject var viewModel: RelayChatViewModel
    /// Set when the chat is presented as a folder's full-screen cover; shows the
    /// dismiss chevron in the top bar. Dismissing never cancels streams (VM-owned).
    var onDismiss: (() -> Void)? = nil
    @State private var showingThreads = false
    @State private var fullLogRequest: RelayFullLogRequest?

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
                        .simultaneousGesture(keyboardDismissTap)
                    threadAccessBar
                        .simultaneousGesture(keyboardDismissTap)
                    messageList
                        .contentShape(Rectangle())
                        .simultaneousGesture(keyboardDismissTap)
                }
            }
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .bottom) {
                RelayComposer(
                    text: $viewModel.prompt,
                    sections: viewModel.pickerSections,
                    selectedChoice: viewModel.selectedChoice,
                    efforts: viewModel.availableEfforts,
                    selectedEffort: viewModel.effectiveEffort,
                    isSending: viewModel.isSending,
                    isStreaming: viewModel.isStreaming,
                    isTranscribing: viewModel.isTranscribing,
                    onPickChoice: { viewModel.selectChoice($0) },
                    onPickEffort: { viewModel.selectEffort($0) },
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
            }
            .refreshable {
                await viewModel.refreshThreads()
            }
            .sheet(isPresented: $showingThreads) {
                RelayThreadDrawer(viewModel: viewModel)
                    .presentationDetents([.medium, .large])
                    .presentationDragIndicator(.visible)
            }
            .sheet(item: $fullLogRequest) { request in
                RelayFullLogSheet(job: request.job) {
                    await viewModel.loadFullLog(for: request.job)
                }
            }
        }
        // The chat opens as its own full-screen presentation; re-pin the app's
        // deliberate dark-only appearance so the cover can never flash light.
        .preferredColorScheme(.dark)
    }

    private var topBar: some View {
        HStack(spacing: 12) {
            if let onDismiss {
                Button(action: onDismiss) {
                    Image(systemName: "chevron.down")
                        .font(AppTheme.uiFont(size: 16, weight: .semibold))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(width: 36, height: 36)
                        .background(AppTheme.bgSurfaceHi, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close chat")
            }

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
                        Image(systemName: "folder.fill")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundStyle(.white)
                    }
                    .shadow(color: AppTheme.accent.opacity(0.5), radius: 6, y: 2)
                VStack(alignment: .leading, spacing: 1) {
                    Text(viewModel.folderDisplayName)
                        .font(AppTheme.uiFont(size: 22, weight: .bold))
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    Text(selectedModelSubtitle)
                        .font(AppTheme.uiFont(size: 11, weight: .medium))
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                }
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    private var threadAccessBar: some View {
        Button {
            showingThreads = true
        } label: {
            HStack(spacing: 11) {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(AppTheme.uiFont(size: 15, weight: .semibold))
                    .foregroundStyle(AppTheme.accent)
                    .frame(width: 32, height: 32)
                    .background(AppTheme.accent.opacity(0.14), in: Circle())

                VStack(alignment: .leading, spacing: 2) {
                    Text("Threads")
                        .font(AppTheme.uiFont(size: 14, weight: .bold))
                        .foregroundStyle(AppTheme.textPrimary)
                    Text("Past conversations & invocations")
                        .font(AppTheme.uiFont(size: 11, weight: .medium))
                        .foregroundStyle(AppTheme.textSecondary)
                }

                Spacer()

                Text("\(viewModel.historyItems.count)")
                    .font(AppTheme.monoFont(size: 11, weight: .semibold))
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(AppTheme.bgCanvas, in: Capsule())

                Image(systemName: "chevron.right")
                    .font(AppTheme.uiFont(size: 11, weight: .bold))
                    .foregroundStyle(AppTheme.textTertiary)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(AppTheme.bgSurface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .stroke(AppTheme.textTertiary.opacity(0.55), lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Threads, \(viewModel.historyItems.count) conversations and invocations")
        .accessibilityIdentifier("relay-threads")
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
    }

    private var selectedModelSubtitle: String {
        guard let choice = viewModel.selectedChoice else { return "Loading models" }
        return "\(choice.chipLabel) · \(choice.mode.label)"
    }

    private func dismissKeyboard() {
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil
        )
    }

    private var keyboardDismissTap: some Gesture {
        TapGesture().onEnded {
            dismissKeyboard()
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
                    if let error = viewModel.errorMessage {
                        RelayStatusBanner(text: error)
                    }

                    if viewModel.messages.isEmpty && !viewModel.isSending {
                        RelayEmptyConversation(choice: viewModel.selectedChoice)
                    } else {
                        ForEach(viewModel.messages) { item in
                            if let job = item.job {
                                RelayJobCard(
                                    job: job,
                                    liveTail: viewModel.liveJobTails[job.id],
                                    isCancelling: viewModel.cancellingJobIDs.contains(job.id),
                                    onCancel: {
                                        Task { await viewModel.cancel(job: job) }
                                    },
                                    onFullLog: {
                                        fullLogRequest = RelayFullLogRequest(job: job)
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
    let sections: RelayModelPickerSections
    let selectedChoice: RelayModelChoice?
    let efforts: [CodexReasoningEffort]
    let selectedEffort: CodexReasoningEffort?
    let isSending: Bool
    let isStreaming: Bool
    let isTranscribing: Bool
    let onPickChoice: (RelayModelChoice) -> Void
    let onPickEffort: (CodexReasoningEffort) -> Void
    let onVoice: (URL) -> Void
    let onSend: () -> Void
    let onStop: () -> Void
    @FocusState private var isFocused: Bool
    @StateObject private var recorder = RelayPromptAudioRecorder()
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    /// Accessibility text sizes trade the compact pill layout for legibility: chips take
    /// the full row and wrap instead of truncating the harness + model name.
    private var usesAccessibilityLayout: Bool { dynamicTypeSize.isAccessibilitySize }

    private func chipLabel(icon: String, text: String, badge: String? = nil) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(AppTheme.accent)
            Text(text)
                .font(AppTheme.uiFont(size: 13, weight: .medium))
                .lineLimit(usesAccessibilityLayout ? 3 : 1)
                .multilineTextAlignment(.leading)
                .truncationMode(.tail)
            if let badge {
                Text(badge)
                    .font(AppTheme.uiFont(size: 9, weight: .bold))
                    .foregroundStyle(AppTheme.accent)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 2)
                    .background(AppTheme.accent.opacity(0.15), in: Capsule())
                    .layoutPriority(1)
            }
            Image(systemName: "chevron.up.chevron.down")
                .font(AppTheme.uiFont(size: 9, weight: .semibold))
                .foregroundStyle(AppTheme.textSecondary)
        }
        .foregroundStyle(AppTheme.textPrimary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: 34)
        .frame(maxWidth: usesAccessibilityLayout ? .infinity : 240, alignment: .leading)
        .fixedSize(horizontal: !usesAccessibilityLayout, vertical: false)
        .background(AppTheme.bgSurfaceHi, in: Capsule())
    }

    /// Harness-first model picker: each agent harness (Codex, Claude Code, Cursor) is a
    /// submenu holding its own task-mode models; chat-capable models live in a flat
    /// "Chat models" section. Both render only what the server catalog advertises.
    private var modelPickerMenu: some View {
        Menu {
            if !sections.agents.isEmpty {
                Section("Agents") {
                    ForEach(sections.agents) { harness in
                        Menu(harness.title) {
                            ForEach(harness.choices) { choice in
                                choiceButton(choice, title: choice.shortModelLabel)
                            }
                        }
                    }
                }
            }
            if !sections.chatModels.isEmpty {
                Section("Chat models") {
                    ForEach(sections.chatModels) { choice in
                        choiceButton(choice, title: choice.chipLabel)
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "cpu",
                text: selectedChoice?.chipLabel ?? "Model",
                badge: selectedChoice?.mode.label
            )
        }
        .menuOrder(.fixed)
        .accessibilityIdentifier("relay-model-chip")
        .accessibilityLabel("Choose model")
    }

    @ViewBuilder private func choiceButton(_ choice: RelayModelChoice, title: String) -> some View {
        Button {
            onPickChoice(choice)
        } label: {
            if choice == selectedChoice {
                Label(title, systemImage: "checkmark")
            } else {
                Text(title)
            }
        }
    }

    private var effortPickerMenu: some View {
        Menu {
            ForEach(efforts) { effort in
                Button {
                    onPickEffort(effort)
                } label: {
                    Label(effort.label, systemImage: selectedEffort == effort ? "checkmark" : "")
                }
            }
        } label: {
            chipLabel(
                icon: "gauge.with.dots.needle.50percent",
                text: (selectedEffort ?? efforts.first(where: { $0 == .high }) ?? efforts.first)?.label ?? "Effort"
            )
        }
        .accessibilityIdentifier("relay-effort-chip")
    }

    var body: some View {
        VStack(spacing: 10) {
            if usesAccessibilityLayout {
                // Full-width stacked chips so harness + model stay legible at
                // accessibility text sizes (the mode badge remains in the chip).
                VStack(alignment: .leading, spacing: 8) {
                    modelPickerMenu
                    if !efforts.isEmpty {
                        effortPickerMenu
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                HStack(spacing: 8) {
                    modelPickerMenu

                    if !efforts.isEmpty {
                        effortPickerMenu
                    }

                    Spacer(minLength: 0)
                }
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
                            Image(systemName: "arrow.up")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(canSend ? .white : AppTheme.textTertiary)
                        }
                        .shadow(color: canSend ? AppTheme.accent.opacity(0.5) : .clear, radius: 6, y: 2)
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSend)
                    .accessibilityIdentifier("relay-send")
                    .accessibilityLabel("Send")
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

// RelayMarkdownText / RelayMarkdownProse / RelayMarkdownTable / RelayCodeBlock moved to
// Rendering/RelayMarkdownViews.swift (revamp I3) so the file viewer shares the chat's
// markdown rendering. Call sites here are unchanged.

private struct RelayJobCard: View {
    let job: CodexJob
    /// SSE-fed stdout/stderr tail shown while the job is active; polling fills the card
    /// via `job.displayOutput` when the stream is unavailable.
    let liveTail: String?
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
                // Status lives in the pill only (it used to repeat as plain text here);
                // the trailing slot shows the run duration once the server reports one.
                if let duration = job.durationMs {
                    Text("\(max(1, duration / 1000))s")
                        .font(AppTheme.monoFont(size: 11))
                        .foregroundStyle(AppTheme.textTertiary)
                }
            }

            if job.status.isActive {
                if let tail = activeTailText {
                    liveTailView(tail)
                } else {
                    // No output yet but the job is live — show motion so it never looks frozen.
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small).tint(AppTheme.accent)
                        Text(job.status == .queued ? "Queued…" : "Working…")
                            .font(AppTheme.uiFont(size: 13))
                            .foregroundStyle(AppTheme.textSecondary)
                    }
                }
            } else if let text = job.displayOutput?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                // Final result: render markdown like chat replies (bold, code, lists).
                RelayMarkdownText(text: text, userAligned: false)
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
        .onChange(of: job.status.isActive) { _, isActive in
            // Light tap when the job reaches a terminal state while the card is visible.
            if !isActive {
                UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
        }
    }

    /// While active, prefer the SSE live tail; fall back to poll-fetched progress output.
    private var activeTailText: String? {
        if let tail = liveTail?.trimmedNonEmpty { return tail }
        return job.displayOutput?.trimmedNonEmpty
    }

    /// Autoscrolling mono tail: sticks to the newest output while the stream appends.
    private func liveTailView(_ text: String) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(text)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                    Color.clear.frame(height: 1).id(Self.tailAnchor)
                }
            }
            .frame(maxHeight: 180)
            .onAppear { proxy.scrollTo(Self.tailAnchor, anchor: .bottom) }
            .onChange(of: text.count) { _, _ in
                proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
            }
        }
    }

    private static let tailAnchor = "relay-job-tail-anchor"
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

                if viewModel.historyItems.isEmpty {
                    Text("No conversations or invocations in this folder yet.")
                        .font(AppTheme.uiFont(size: 13))
                        .foregroundStyle(AppTheme.textTertiary)
                        .listRowBackground(AppTheme.bgCanvas)
                }

                // Exact-folder conversations plus invocations that do not have a session yet.
                Section("This folder") {
                    ForEach(viewModel.historyItems) { item in
                        historyRow(item)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                if case .thread(let thread) = item.source {
                                    Button(role: .destructive) {
                                        Task { await viewModel.delete(thread) }
                                    } label: {
                                        Label("Delete", systemImage: "trash")
                                    }
                                }
                            }
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("Threads")
            .navigationBarTitleDisplayMode(.inline)
            .task { await viewModel.refreshThreads() }
            .preferredColorScheme(.dark)
        }
    }

    private func historyRow(_ item: CodexThreadFeedItem) -> some View {
        Button {
            Task {
                await viewModel.openHistoryItem(item)
                dismiss()
            }
        } label: {
            VStack(alignment: .leading, spacing: 5) {
                HStack(spacing: 6) {
                    Text(item.title)
                        .foregroundStyle(AppTheme.textPrimary)
                        .lineLimit(1)
                    Spacer()
                    if item.isActive {
                        Circle().fill(AppTheme.statusWarn).frame(width: 7, height: 7)
                    }
                    Text(historyModeLabel(item))
                        .font(AppTheme.uiFont(size: 9, weight: .bold))
                        .foregroundStyle(AppTheme.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(AppTheme.accent.opacity(0.15), in: Capsule())
                }
                Text(item.preview)
                    .font(.caption)
                    .foregroundStyle(AppTheme.textTertiary)
                    .lineLimit(2)
                Text(historyMetadata(item))
                    .font(AppTheme.monoFont(size: 10))
                    .foregroundStyle(AppTheme.textTertiary)
            }
        }
        .listRowBackground(AppTheme.bgSurface)
    }

    private func historyModeLabel(_ item: CodexThreadFeedItem) -> String {
        switch item.source {
        case .thread(let thread):
            return thread.mode.label
        case .pendingJob:
            return "Task"
        }
    }

    private func historyMetadata(_ item: CodexThreadFeedItem) -> String {
        switch item.source {
        case .thread(let thread):
            if thread.mode == .chat {
                return "\(item.workspaceLabel) · \(thread.provider.displayName) · conversation"
            }
            let count = thread.jobCount
            let invocationText = count == 1 ? "1 invocation" : "\(count) invocations"
            return "\(item.workspaceLabel) · \(thread.provider.displayName) · \(invocationText)"
        case .pendingJob(let job):
            return "\(item.workspaceLabel) · \(job.provider.displayName) · invocation · \(job.status.label)"
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
    let choice: RelayModelChoice?

    private var isTask: Bool { choice?.mode == .task }

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: isTask ? "terminal.fill" : "message.fill")
                .font(.system(size: 32, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 78, height: 78)
                .background(AppTheme.accentGradient, in: Circle())
                .shadow(color: AppTheme.accent.opacity(0.45), radius: 16, y: 6)

            VStack(spacing: 6) {
                Text(isTask ? "Run a task" : "Start a conversation")
                    .font(AppTheme.uiFont(size: 20, weight: .semibold))
                    .foregroundStyle(AppTheme.textPrimary)
                Text(isTask
                     ? "Queue an agent job in this folder."
                     : "Stream a reply scoped to this folder.")
                    .font(AppTheme.uiFont(size: 14))
                    .foregroundStyle(AppTheme.textSecondary)
                    .multilineTextAlignment(.center)
            }

            if let label = choice?.chipLabel {
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

private struct RelayFullLogRequest: Identifiable {
    var id: String { job.id }
    let job: CodexJob
}

private struct RelayFullLogSheet: View {
    let job: CodexJob
    let load: () async -> String
    @Environment(\.dismiss) private var dismiss
    @State private var text: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                if let text {
                    Text(text.isEmpty ? "No log output." : text)
                        .font(AppTheme.monoFont(size: 12))
                        .foregroundStyle(AppTheme.textPrimary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                } else {
                    ProgressView("Loading full log…")
                        .tint(AppTheme.accent)
                        .foregroundStyle(AppTheme.textSecondary)
                        .frame(maxWidth: .infinity, minHeight: 260)
                }
            }
            .background(AppTheme.bgCanvas)
            .navigationTitle("Log")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .preferredColorScheme(.dark)
        }
        .task(id: job.id) {
            guard text == nil else { return }
            text = await load()
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
