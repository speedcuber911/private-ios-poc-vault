import SwiftUI
import UIKit
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers

struct CodexConsoleView: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    @State private var path: [CodexRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                CodexTheme.background.ignoresSafeArea()
                GeometryReader { proxy in
                    ScrollView(.vertical) {
                        VStack(alignment: .leading, spacing: 20) {
                            CodexHeader(viewModel: viewModel)

                            if let errorMessage = viewModel.errorMessage {
                                CodexErrorCard(summary: CodexErrorSummary(message: errorMessage)) {
                                    Task { await viewModel.refreshAll() }
                                }
                            }

                            CodexPromptCard(
                                viewModel: viewModel,
                                onCreated: { jobID in
                                    if let selectedSessionID = viewModel.selectedSessionID {
                                        path.append(.thread(selectedSessionID))
                                    } else {
                                        path.append(.job(jobID))
                                    }
                                },
                                onOpenJob: { jobID in path.append(.job(jobID)) }
                            )

                            CodexThreadFeedSection(
                                viewModel: viewModel,
                                onOpenThread: { sessionID in path.append(.thread(sessionID)) },
                                onOpenJob: { jobID in path.append(.job(jobID)) }
                            )
                        }
                        .padding(.horizontal, AppTheme.screenHorizontalPadding)
                        .padding(.top, AppTheme.screenTopPadding)
                        .padding(.bottom, 28)
                        .frame(width: proxy.size.width, alignment: .leading)
                    }
                    .safeAreaInset(edge: .bottom) {
                        Color.clear
                            .frame(height: AppTheme.tabBarClearance)
                            .allowsHitTesting(false)
                    }
                    .scrollDismissesKeyboard(.interactively)
                }
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await viewModel.refreshAll()
            }
            .navigationDestination(for: CodexRoute.self) { route in
                switch route {
                case .job(let jobID):
                    CodexJobDetailView(
                        jobID: jobID,
                        viewModel: viewModel,
                        onOpenThread: { sessionID in path.append(.thread(sessionID)) },
                        onOpenJob: { jobID in path.append(.job(jobID)) }
                    )
                case .thread(let sessionID):
                    CodexThreadDetailView(
                        sessionID: sessionID,
                        viewModel: viewModel,
                        onOpenJob: { jobID in path.append(.job(jobID)) }
                    )
                }
            }
            .task {
                await viewModel.bootstrapIfNeeded()
                await viewModel.pollJobsWhileVisible()
            }
        }
    }
}

private enum CodexRoute: Hashable {
    case job(String)
    case thread(String)
}

private enum CodexTheme {
    static let background = AppTheme.bgCanvas
    static let panel = AppTheme.bgSurface
    static let raisedPanel = AppTheme.bgSurfaceHi
    static let stroke = AppTheme.strokeStrong
    static let text = AppTheme.textPrimary
    static let muted = AppTheme.textSecondary
    static let dim = AppTheme.textTertiary
    static let accent = AppTheme.accent
}

private struct CodexHeader: View {
    @ObservedObject var viewModel: CodexConsoleViewModel

    var body: some View {
        HStack(spacing: 12) {
            Image(viewModel.provider.tabIconAssetName)
                .renderingMode(.template)
                .resizable()
                .scaledToFit()
                .foregroundStyle(viewModel.provider.activityTint)
                .frame(width: 18, height: 18)
                .frame(width: 34, height: 34)
                .background(CodexTheme.raisedPanel, in: Circle())
                .overlay {
                    Circle().stroke(CodexTheme.stroke, lineWidth: 1)
                }

            Text(viewModel.provider.displayName)
                .font(AppTheme.screenTitleFont)
                .foregroundStyle(CodexTheme.text)

            Spacer()

            Button {
                Task { await viewModel.refreshAll() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(CodexTheme.text)
                    .frame(width: AppTheme.iconButtonSize, height: AppTheme.iconButtonSize)
                    .background(CodexTheme.raisedPanel, in: Circle())
                    .overlay {
                        Circle().stroke(CodexTheme.stroke, lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isRefreshing)
            .accessibilityLabel("Refresh \(viewModel.provider.displayName)")
        }
    }
}

private struct CodexPromptCard: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onCreated: (String) -> Void
    let onOpenJob: (String) -> Void
    @FocusState private var promptIsFocused: Bool
    @State private var showingSkillPicker = false
    @State private var showingThreadPicker = false
    @State private var showingPhotoPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var showingDocumentPicker = false
    @State private var showingCameraPicker = false
    @StateObject private var audioRecorder = CodexPromptAudioRecorder()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(viewModel.selectedSessionID == nil ? "What should \(viewModel.provider.displayName) do?" : "Continue this thread")
                    .font(AppTheme.panelTitleFont)
                    .foregroundStyle(CodexTheme.text)
                Text(contextText)
                    .font(AppTheme.bodyFont)
                    .foregroundStyle(CodexTheme.dim)
                    .lineLimit(2)
            }

            CodexControlStrip(
                viewModel: viewModel,
                skillCount: viewModel.selectedSkills.count,
                showsSkillControls: true
            ) {
                showingSkillPicker = true
            }

            CodexThreadStrip(viewModel: viewModel) {
                showingThreadPicker = true
            }

            if !viewModel.selectedSkills.isEmpty {
                CodexSelectedSkillStrip(viewModel: viewModel)
            }

            ZStack(alignment: .topLeading) {
                if viewModel.prompt.isEmpty {
                    Text("Type a prompt for \(viewModel.provider.displayName)...")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(CodexTheme.dim)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }

                TextEditor(text: $viewModel.prompt)
                    .font(.system(size: 16))
                    .foregroundStyle(CodexTheme.text)
                    .scrollContentBackground(.hidden)
                    .textInputAutocapitalization(.sentences)
                    .autocorrectionDisabled()
                    .focused($promptIsFocused)
                    .frame(minHeight: 168, maxHeight: 260)
                    .background(Color.clear)
            }

            if !viewModel.attachments.isEmpty {
                CodexAttachmentTray(attachments: viewModel.attachments) { attachment in
                    viewModel.removeComposeAttachment(attachment)
                }
            }

            Divider()
                .overlay(CodexTheme.stroke)

            HStack(spacing: 10) {
                Text(disabledReason)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(CodexTheme.dim)
                    .lineLimit(1)

                Spacer()

                CodexAttachmentMenu(
                    disabled: viewModel.isCreating || viewModel.isTranscribing,
                    showingPhotoPicker: $showingPhotoPicker,
                    showingDocumentPicker: $showingDocumentPicker,
                    showingCameraPicker: $showingCameraPicker
                )

                Button {
                    toggleRecording()
                } label: {
                    ZStack {
                        if viewModel.isTranscribing {
                            ProgressView()
                                .tint(CodexTheme.text)
                        } else {
                            Image(systemName: audioRecorder.isRecording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 15, weight: .bold))
                                .foregroundStyle(audioRecorder.isRecording ? Color.white : CodexTheme.text)
                        }
                    }
                    .frame(width: AppTheme.touchTargetSize, height: AppTheme.touchTargetSize)
                    .background(audioRecorder.isRecording ? AppTheme.statusError : CodexTheme.raisedPanel, in: Circle())
                    .overlay {
                        Circle().stroke(CodexTheme.stroke, lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isCreating || viewModel.isTranscribing)
                .accessibilityLabel(audioRecorder.isRecording ? "Stop recording prompt" : "Record prompt")

                Button {
                    promptIsFocused = false
                    Task {
                        if let jobID = await viewModel.createJobFromCompose() {
                            onCreated(jobID)
                        }
                    }
                } label: {
                    Label(viewModel.isCreating ? "Sending" : "Send", systemImage: "paperplane.fill")
                        .font(.subheadline.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                        .foregroundStyle(canCreate ? AppTheme.bgCanvas : CodexTheme.dim)
                        .padding(.horizontal, 18)
                        .frame(minWidth: 104)
                        .frame(height: AppTheme.touchTargetSize)
                        .background((canCreate ? CodexTheme.accent : CodexTheme.raisedPanel), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canCreate)
            }

        }
        .padding(AppTheme.cardPadding)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button {
                    promptIsFocused = false
                } label: {
                    Label("Done", systemImage: "keyboard.chevron.compact.down")
                }
                .font(.body.weight(.semibold))
            }
        }
        .sheet(isPresented: $showingSkillPicker) {
            CodexSkillPickerSheet(viewModel: viewModel)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingThreadPicker) {
            CodexThreadPickerSheet(
                viewModel: viewModel,
                onOpenJob: onOpenJob
            )
            .presentationDetents([.medium, .large])
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingDocumentPicker) {
            CodexDocumentPicker { urls in
                Task { await importDocuments(urls) }
            }
        }
        .fullScreenCover(isPresented: $showingCameraPicker) {
            CodexCameraPicker { data in
                viewModel.addComposeAttachment(
                    data: data,
                    filename: "camera-\(Self.fileTimestamp()).jpg",
                    contentType: "image/jpeg"
                )
            }
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: 6,
            matching: .images
        )
        .onChange(of: selectedPhotoItems) { _, items in
            Task { await importPhotos(items) }
        }
    }

    private var canCreate: Bool {
        (!viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !viewModel.attachments.isEmpty)
            && !viewModel.isCreating
            && !viewModel.isTranscribing
            && !audioRecorder.isRecording
    }

    private var disabledReason: String {
        if audioRecorder.isRecording {
            return "Recording"
        }
        if viewModel.isTranscribing {
            return "Transcribing"
        }
        if viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && viewModel.attachments.isEmpty {
            return "Enter a prompt"
        }
        if !viewModel.attachments.isEmpty {
            return "\(viewModel.attachments.count) attached"
        }
        return "Ready"
    }

    private func toggleRecording() {
        if audioRecorder.isRecording {
            guard let fileURL = audioRecorder.stopRecording() else { return }
            Task {
                await viewModel.transcribePromptAudio(fileURL: fileURL)
                audioRecorder.deleteRecording(at: fileURL)
            }
            return
        }

        promptIsFocused = false
        Task {
            do {
                try await audioRecorder.startRecording()
            } catch {
                viewModel.errorMessage = error.localizedDescription
            }
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                await MainActor.run { viewModel.errorMessage = "Could not read the selected photo." }
                continue
            }
            let contentType = item.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
            await MainActor.run {
                viewModel.addComposeAttachment(
                    data: data,
                    filename: "photo-\(Self.fileTimestamp()).\(contentType.preferredFilenameExtension ?? "jpg")",
                    contentType: contentType.preferredMIMEType ?? "image/jpeg"
                )
            }
        }
        await MainActor.run { selectedPhotoItems = [] }
    }

    private func importDocuments(_ urls: [URL]) async {
        for url in urls {
            let isScoped = url.startAccessingSecurityScopedResource()
            defer {
                if isScoped {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            do {
                let data = try Data(contentsOf: url)
                let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                await MainActor.run {
                    viewModel.addComposeAttachment(data: data, filename: url.lastPathComponent, contentType: contentType)
                }
            } catch {
                await MainActor.run {
                    viewModel.errorMessage = "Could not read \(url.lastPathComponent)."
                }
            }
        }
    }

    private static func fileTimestamp() -> String {
        String(Int(Date().timeIntervalSince1970))
    }

    private var contextText: String {
        if let selectedThread = viewModel.selectedThread {
            return "Continuing \(selectedThread.displayTitle) · \(selectedThread.shortID)."
        }
        if let selectedSession = viewModel.selectedSession {
            return "Continuing \(selectedSession.displayTitle) · \(selectedSession.shortID)."
        }
        if let selectedSessionID = viewModel.selectedSessionID {
            return "Continuing thread \(String(selectedSessionID.prefix(12)))."
        }
        return "Start fresh, or choose a recent thread to continue."
    }
}

@MainActor
private final class CodexPromptAudioRecorder: NSObject, ObservableObject, AVAudioRecorderDelegate {
    @Published private(set) var isRecording = false
    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?

    func startRecording() async throws {
        guard !isRecording else { return }
        guard await requestPermission() else {
            throw RecordingError.microphoneDenied
        }

        let session = AVAudioSession.sharedInstance()
        let configuration = CodexPromptAudioRecordingConfiguration.devicePromptDefaults
        do {
            try session.setCategory(configuration.category, mode: configuration.mode, options: configuration.options)
            try session.setActive(true)
        } catch {
            throw RecordingError.startFailed
        }

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("codex-prompt-\(UUID().uuidString)")
            .appendingPathExtension("wav")
        let recorder: AVAudioRecorder
        do {
            recorder = try AVAudioRecorder(url: url, settings: configuration.settings)
        } catch {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw RecordingError.startFailed
        }
        recorder.delegate = self
        recorder.prepareToRecord()
        guard recorder.record() else {
            try? session.setActive(false, options: .notifyOthersOnDeactivation)
            throw RecordingError.startFailed
        }

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
                return "Could not start microphone recording. Please try again."
            }
        }
    }
}

struct CodexPromptAudioRecordingConfiguration {
    let category: AVAudioSession.Category
    let mode: AVAudioSession.Mode
    let options: AVAudioSession.CategoryOptions
    let settings: [String: Any]

    static let devicePromptDefaults = CodexPromptAudioRecordingConfiguration(
        category: .record,
        mode: .default,
        options: [],
        settings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000.0,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsNonInterleaved: false
        ]
    )
}

private struct CodexThreadStrip: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onBrowse: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Button {
                viewModel.startNewThread()
            } label: {
                Label("New", systemImage: "plus.bubble")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(viewModel.selectedSessionID == nil ? AppTheme.bgCanvas : CodexTheme.muted)
                    .padding(.horizontal, 12)
                    .frame(height: 34)
                    .background(
                        viewModel.selectedSessionID == nil ? CodexTheme.accent : CodexTheme.raisedPanel,
                        in: Capsule()
                    )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Start a new \(viewModel.provider.displayName) thread")

            Button(action: onBrowse) {
                HStack(spacing: 8) {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.caption.weight(.bold))
                    Text(selectedThreadText)
                        .font(.caption.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.76)
                    Image(systemName: "chevron.down")
                        .font(.caption2.weight(.bold))
                }
                .foregroundStyle(CodexTheme.text)
                .padding(.horizontal, 12)
                .frame(height: 34)
                .background(CodexTheme.raisedPanel, in: Capsule())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Browse \(viewModel.provider.displayName) threads")

            Spacer(minLength: 0)
        }
    }

    private var selectedThreadText: String {
        if let selectedThread = viewModel.selectedThread {
            return selectedThread.shortID
        }
        if let selectedSessionID = viewModel.selectedSessionID {
            return String(selectedSessionID.prefix(12))
        }
        let count = viewModel.visibleThreadCount
        if count > 0 {
            return "\(count) \(count == 1 ? "thread" : "threads")"
        }
        return "Threads"
    }
}

private struct CodexThreadPickerSheet: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onOpenJob: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""
    @State private var showingSmokeThreads = false

    private var filteredThreads: [CodexThread] {
        let threads = viewModel.threads.filter { showingSmokeThreads || !$0.isSmokeTest }
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return threads }
        return threads.filter { thread in
            [
                thread.sessionId,
                thread.workspaceId,
                thread.workspaceName,
                thread.cwd,
                thread.lastPrompt,
                thread.lastResult,
                thread.lastError
            ]
            .compactMap { $0?.lowercased() }
            .contains { $0.contains(query) }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button {
                        viewModel.startNewThread()
                        dismiss()
                    } label: {
                        Label("Start new thread", systemImage: "plus.bubble")
                    }
                    .listRowBackground(CodexTheme.panel)
                }

                if viewModel.threads.contains(where: \.isSmokeTest) {
                    Section {
                        Toggle(isOn: $showingSmokeThreads) {
                            Text("Show smoke tests")
                                .foregroundStyle(CodexTheme.text)
                        }
                        .toggleStyle(.switch)
                    }
                    .listRowBackground(CodexTheme.panel)
                }

                if filteredThreads.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("No threads")
                            .font(.headline)
                            .foregroundStyle(CodexTheme.text)
                        Text(emptyMessage)
                            .font(.subheadline)
                            .foregroundStyle(CodexTheme.dim)
                    }
                    .listRowBackground(CodexTheme.panel)
                } else {
                    Section("Recent threads") {
                        ForEach(filteredThreads) { thread in
                            CodexThreadRow(
                                thread: thread,
                                isSelected: thread.sessionId == viewModel.selectedSessionID,
                                onContinue: {
                                    viewModel.selectThread(thread)
                                    dismiss()
                                },
                                onOpenJob: thread.lastJobId.map { jobID in
                                    {
                                        viewModel.selectThread(thread)
                                        dismiss()
                                        onOpenJob(jobID)
                                    }
                                }
                            )
                            .listRowBackground(CodexTheme.panel)
                        }
                    }
                }
            }
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search threads")
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("\(viewModel.provider.displayName) Threads")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        Task { await viewModel.refreshThreads() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .accessibilityLabel("Refresh threads")
                    .disabled(viewModel.isRefreshing)
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .font(.body.weight(.semibold))
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var emptyMessage: String {
        searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? "Run a \(viewModel.provider.displayName) job on EC2 and it will appear here."
            : searchText
    }
}

private struct CodexThreadRow: View {
    let thread: CodexThread
    let isSelected: Bool
    let onContinue: () -> Void
    let onOpenJob: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Button(action: onContinue) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(thread.displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(CodexTheme.text)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                        if isSelected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(CodexTheme.accent)
                        }
                        Spacer(minLength: 6)
                        Text(relativeText)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(CodexTheme.dim)
                    }

                    HStack(spacing: 8) {
                        Text(thread.workspaceLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(CodexTheme.dim)
                        if let status = thread.lastJobStatus {
                            CodexStatusChip(status: status)
                        }
                        if thread.isSmokeTest {
                            Text("Smoke")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(CodexTheme.dim)
                                .padding(.horizontal, 8)
                                .frame(height: 24)
                                .background(CodexTheme.raisedPanel, in: Capsule())
                        }
                        if thread.jobCount > 0 {
                            Text("\(thread.jobCount) \(thread.jobCount == 1 ? "job" : "jobs")")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(CodexTheme.dim)
                        } else if thread.hasSessionFile {
                            Text("Session")
                                .font(.caption2.weight(.semibold))
                                .foregroundStyle(CodexTheme.dim)
                        }
                        Text(thread.shortID)
                            .font(.caption2.monospaced())
                            .foregroundStyle(CodexTheme.dim)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if let onOpenJob {
                Button(action: onOpenJob) {
                    Image(systemName: "arrow.up.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.accent)
                        .frame(width: 34, height: 34)
                        .background(CodexTheme.raisedPanel, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open latest job")
            }
        }
        .padding(.vertical, 4)
    }

    private var relativeText: String {
        guard let date = thread.updatedAt ?? thread.timestamp else {
            return ""
        }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

struct CodexControlStripLayout: Equatable {
    let controlHeight: CGFloat = 36
    let visibleRowCount = 3
    let showsSkillButton: Bool
    let reservesSkillSlot: Bool
    let showsRunMode: Bool

    init(provider: CodexProvider) {
        showsSkillButton = true
        reservesSkillSlot = false
        showsRunMode = true
    }
}

private struct CodexControlStrip: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let skillCount: Int
    let showsSkillControls: Bool
    let onSkillsTapped: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                if layout.showsSkillButton && showsSkillControls {
                    skillsButton
                } else if layout.reservesSkillSlot {
                    Color.clear
                        .frame(width: 1, height: layout.controlHeight)
                        .accessibilityHidden(true)
                }
                Spacer(minLength: 0)
            }
            .frame(height: layout.controlHeight, alignment: .leading)

            HStack(spacing: 10) {
                modelMenu
                if layout.showsRunMode {
                    providerModeMenu
                }
                Spacer(minLength: 0)
            }
            .frame(height: layout.controlHeight, alignment: .leading)

            HStack(spacing: 10) {
                reasoningMenu
                Spacer(minLength: 0)
            }
            .frame(height: layout.controlHeight, alignment: .leading)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: AppTheme.compactRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.compactRadius, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var layout: CodexControlStripLayout {
        CodexControlStripLayout(provider: viewModel.provider)
    }

    private var skillsButton: some View {
        Button(action: onSkillsTapped) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(AppTheme.sectionLabelFont)
                Text(skillCount == 0 ? "Skills" : "\(skillCount) skills")
                    .font(AppTheme.sectionLabelFont)
                    .lineLimit(1)
                Image(systemName: "plus")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(skillCount == 0 ? CodexTheme.text : AppTheme.bgCanvas)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(
                skillCount == 0 ? CodexTheme.raisedPanel : CodexTheme.accent,
                in: Capsule()
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose \(viewModel.provider.displayName) skills")
    }

    private var modelMenu: some View {
        Menu {
            ForEach(viewModel.modelOptions, id: \.self) { model in
                Button {
                    viewModel.selectedModel = model
                } label: {
                    if model == viewModel.selectedModel {
                        Label(model, systemImage: "checkmark")
                    } else {
                        Text(model)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "cpu")
                    .font(AppTheme.sectionLabelFont)
                Text(viewModel.selectedModel)
                    .font(AppTheme.sectionLabelFont)
                    .lineLimit(1)
                    .minimumScaleFactor(0.76)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(CodexTheme.text)
            .padding(.horizontal, 12)
            .frame(minWidth: 132, alignment: .leading)
            .frame(height: 36)
            .background(CodexTheme.raisedPanel, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose \(viewModel.provider.displayName) model")
    }

    private var reasoningMenu: some View {
        Menu {
            ForEach(viewModel.reasoningEffortOptions) { effort in
                Button {
                    viewModel.selectedReasoningEffort = effort
                } label: {
                    if effort == viewModel.selectedReasoningEffort {
                        Label(effort.label, systemImage: "checkmark")
                    } else {
                        Text(effort.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "slider.horizontal.3")
                    .font(AppTheme.sectionLabelFont)
                Text(viewModel.selectedReasoningEffort.label)
                    .font(AppTheme.sectionLabelFont)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(CodexTheme.text)
            .padding(.horizontal, 12)
            .frame(minWidth: 110, alignment: .leading)
            .frame(height: 36)
            .background(CodexTheme.raisedPanel, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose \(viewModel.provider == .claude ? "Claude effort" : "reasoning effort")")
        .accessibilityValue(viewModel.selectedReasoningEffort.label)
    }

    private var modeMenu: some View {
        Menu {
            ForEach(CodexRunMode.allCases) { mode in
                Button {
                    viewModel.selectedRunMode = mode
                } label: {
                    if mode == viewModel.selectedRunMode {
                        Label(mode.label, systemImage: "checkmark")
                    } else {
                        Text(mode.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: viewModel.selectedRunMode == .speed ? "bolt.fill" : "dial.medium")
                    .font(AppTheme.sectionLabelFont)
                Text(viewModel.selectedRunMode.label)
                    .font(AppTheme.sectionLabelFont)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(viewModel.selectedRunMode == .speed ? AppTheme.bgCanvas : CodexTheme.text)
            .padding(.horizontal, 12)
            .frame(minWidth: 118, alignment: .leading)
            .frame(height: 36)
            .background(viewModel.selectedRunMode == .speed ? CodexTheme.accent : CodexTheme.raisedPanel, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose Codex run mode")
        .accessibilityValue(viewModel.selectedRunMode.label)
    }

    @ViewBuilder
    private var providerModeMenu: some View {
        if viewModel.provider == .claude {
            claudePermissionModeMenu
        } else {
            modeMenu
        }
    }

    private var claudePermissionModeMenu: some View {
        Menu {
            ForEach(ClaudePermissionMode.allCases) { mode in
                Button {
                    viewModel.selectedClaudePermissionMode = mode
                } label: {
                    if mode == viewModel.selectedClaudePermissionMode {
                        Label(mode.label, systemImage: "checkmark")
                    } else {
                        Text(mode.label)
                    }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Image(systemName: viewModel.selectedClaudePermissionMode == .plan ? "doc.text.magnifyingglass" : "shield.lefthalf.filled")
                    .font(AppTheme.sectionLabelFont)
                Text(viewModel.selectedClaudePermissionMode.label)
                    .font(AppTheme.sectionLabelFont)
                    .lineLimit(1)
                    .minimumScaleFactor(0.82)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(viewModel.selectedClaudePermissionMode == .bypassPermissions ? AppTheme.bgCanvas : CodexTheme.text)
            .padding(.horizontal, 12)
            .frame(minWidth: 118, alignment: .leading)
            .frame(height: 36)
            .background(
                viewModel.selectedClaudePermissionMode == .bypassPermissions ? CodexTheme.accent : CodexTheme.raisedPanel,
                in: Capsule()
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose Claude permission mode")
        .accessibilityValue(viewModel.selectedClaudePermissionMode.label)
    }
}

private struct CodexSelectedSkillStrip: View {
    @ObservedObject var viewModel: CodexConsoleViewModel

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(viewModel.selectedSkills) { skill in
                    Button {
                        viewModel.removeSkill(skill)
                    } label: {
                        HStack(spacing: 6) {
                            Text(skill.chipLabel)
                                .font(.caption.weight(.bold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.82)
                                .frame(maxWidth: 190, alignment: .leading)
                            Image(systemName: "xmark")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(AppTheme.bgCanvas)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(CodexTheme.accent, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(skill.chipLabel)")
                }
            }
            .padding(.vertical, 2)
        }
    }
}

private struct CodexAttachmentMenu: View {
    let disabled: Bool
    @Binding var showingPhotoPicker: Bool
    @Binding var showingDocumentPicker: Bool
    @Binding var showingCameraPicker: Bool

    var body: some View {
        Menu {
            Button {
                showingPhotoPicker = true
            } label: {
                Label("Photo library", systemImage: "photo.on.rectangle")
            }

            Button {
                showingDocumentPicker = true
            } label: {
                Label("Files", systemImage: "doc")
            }

            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button {
                    showingCameraPicker = true
                } label: {
                    Label("Camera", systemImage: "camera")
                }
            }
        } label: {
            Image(systemName: "paperclip")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(disabled ? CodexTheme.dim : CodexTheme.text)
                .frame(width: AppTheme.touchTargetSize, height: AppTheme.touchTargetSize)
                .background(CodexTheme.raisedPanel, in: Circle())
                .overlay {
                    Circle().stroke(CodexTheme.stroke, lineWidth: 1)
                }
        }
        .disabled(disabled)
        .accessibilityLabel("Attach file")
    }
}

private struct CodexAttachmentTray: View {
    let attachments: [CodexJobAttachment]
    let onRemove: (CodexJobAttachment) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(attachments) { attachment in
                    HStack(spacing: 7) {
                        Image(systemName: symbol(for: attachment.contentType))
                            .font(.caption.weight(.bold))
                        VStack(alignment: .leading, spacing: 1) {
                            Text(attachment.filename)
                                .font(.caption.weight(.semibold))
                                .lineLimit(1)
                            Text(byteText(attachment.byteCount))
                                .font(.caption2.weight(.medium))
                                .foregroundStyle(CodexTheme.dim)
                        }
                        Button {
                            onRemove(attachment)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(CodexTheme.dim)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Remove \(attachment.filename)")
                    }
                    .foregroundStyle(CodexTheme.text)
                    .padding(.horizontal, 10)
                    .frame(height: 44)
                    .background(CodexTheme.raisedPanel, in: Capsule())
                }
            }
            .padding(.vertical, 2)
        }
    }

    private func symbol(for contentType: String) -> String {
        if contentType.hasPrefix("image/") { return "photo" }
        if contentType == "application/pdf" { return "doc.richtext" }
        return "doc"
    }

    private func byteText(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}

private struct CodexDocumentPicker: UIViewControllerRepresentable {
    let onPick: ([URL]) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onPick: onPick)
    }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = true
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onPick: ([URL]) -> Void

        init(onPick: @escaping ([URL]) -> Void) {
            self.onPick = onPick
        }

        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
            onPick(urls)
        }
    }
}

private struct CodexCameraPicker: UIViewControllerRepresentable {
    let onImageData: (Data) -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onImageData: onImageData)
    }

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = ["public.image"]
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let onImageData: (Data) -> Void

        init(onImageData: @escaping (Data) -> Void) {
            self.onImageData = onImageData
        }

        func imagePickerController(
            _ picker: UIImagePickerController,
            didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]
        ) {
            if let image = info[.originalImage] as? UIImage,
               let data = image.jpegData(compressionQuality: 0.86) {
                onImageData(data)
            }
            picker.dismiss(animated: true)
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            picker.dismiss(animated: true)
        }
    }
}

private struct CodexSkillPickerSheet: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    private var filteredSkills: [CodexSkill] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return viewModel.availableSkills }
        return viewModel.availableSkills.filter { $0.searchText.contains(query) }
    }

    private var groupedSkills: [(String, [CodexSkill])] {
        Dictionary(grouping: filteredSkills, by: \.group)
            .map { ($0.key, $0.value.sorted { $0.title < $1.title }) }
            .sorted { $0.0 < $1.0 }
    }

    var body: some View {
        NavigationStack {
            List {
                if filteredSkills.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(viewModel.availableSkills.isEmpty ? "No \(viewModel.provider.displayName) skills found" : "No matches")
                            .font(.headline)
                            .foregroundStyle(CodexTheme.text)
                        Text(viewModel.availableSkills.isEmpty ? "Refresh after installing skills on the runner." : searchText)
                            .font(.subheadline)
                            .foregroundStyle(CodexTheme.dim)
                            .lineLimit(1)
                    }
                    .listRowBackground(CodexTheme.panel)
                } else {
                    ForEach(groupedSkills, id: \.0) { group, skills in
                        Section(group) {
                            ForEach(skills) { skill in
                                CodexSkillRow(
                                    skill: skill,
                                    isSelected: viewModel.selectedSkillIDs.contains(skill.id)
                                ) {
                                    viewModel.toggleSkill(skill)
                                }
                                .listRowBackground(CodexTheme.panel)
                            }
                        }
                    }
                }
            }
            .searchable(text: $searchText, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search skills")
            .scrollContentBackground(.hidden)
            .background(AppTheme.bgCanvas)
            .navigationTitle("Skills")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                    .font(.body.weight(.semibold))
                }
            }
        }
        .preferredColorScheme(.dark)
    }
}

private struct CodexSkillRow: View {
    let skill: CodexSkill
    let isSelected: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(skill.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CodexTheme.text)
                    Text(skill.id)
                        .font(.caption.monospaced())
                        .foregroundStyle(CodexTheme.accent)
                        .lineLimit(1)
                    Text(skill.summary)
                        .font(.caption)
                        .foregroundStyle(CodexTheme.muted)
                        .lineLimit(2)
                }

                Spacer()

                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(isSelected ? CodexTheme.accent : CodexTheme.dim)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.vertical, 4)
    }
}

private struct CodexThreadFeedSection: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onOpenThread: (String) -> Void
    let onOpenJob: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Threads")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.dim)
                        .tracking(1.4)
                        .textCase(.uppercase)
                    Text(summaryText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)
                }

                Spacer()

                Button {
                    Task { await viewModel.refreshAll() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.text)
                        .frame(width: 34, height: 34)
                        .background(CodexTheme.raisedPanel, in: Circle())
                }
                .buttonStyle(.plain)
                .disabled(viewModel.isRefreshing)
                .accessibilityLabel("Refresh threads")
            }
            .padding(.horizontal, 2)

            if viewModel.isRefreshing && viewModel.threadFeedItems.isEmpty {
                CodexEmptyState(symbol: "arrow.triangle.2.circlepath", title: "Loading threads", message: "Fetching \(viewModel.provider.displayName) activity.")
            } else if viewModel.connectionNotice != nil && viewModel.threadFeedItems.isEmpty && viewModel.lastRefreshedAt == nil {
                CodexEmptyState(
                    symbol: "wifi.exclamationmark",
                    title: viewModel.connectionNoticeTitle,
                    message: viewModel.connectionNoticeMessage
                )
            } else if viewModel.threadFeedItems.isEmpty {
                CodexEmptyState(symbol: "bubble.left.and.bubble.right", title: "No threads yet", message: "Send a \(viewModel.provider.displayName) prompt and its thread will appear here.")
            } else {
                VStack(spacing: 10) {
                    ForEach(viewModel.threadFeedItems) { item in
                        CodexThreadFeedRow(item: item, isSelected: item.sessionID == viewModel.selectedSessionID) {
                            if let sessionID = item.sessionID {
                                viewModel.selectSessionID(sessionID, workspaceID: item.workspaceID)
                                onOpenThread(sessionID)
                            } else if let jobID = item.jobID {
                                onOpenJob(jobID)
                            }
                        }
                    }
                }
            }
        }
    }

    private var summaryText: String {
        if viewModel.isRefreshing && viewModel.threadFeedItems.isEmpty {
            return "Loading..."
        }
        if viewModel.connectionNotice != nil && viewModel.threadFeedItems.isEmpty && viewModel.lastRefreshedAt == nil {
            return "Reconnecting..."
        }
        if viewModel.connectionNotice != nil && !viewModel.threadFeedItems.isEmpty {
            return "Showing last loaded threads"
        }
        let count = viewModel.threadFeedItems.count
        if count == 0 {
            return "No threads yet"
        }
        return "\(count) \(count == 1 ? "thread" : "threads")"
    }
}

private struct CodexThreadFeedRow: View {
    let item: CodexThreadFeedItem
    let isSelected: Bool
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(item.title)
                            .font(AppTheme.cardTitleFont)
                            .foregroundStyle(CodexTheme.text)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)

                        if isSelected {
                            Image(systemName: "checkmark.circle.fill")
                                .font(.caption.weight(.bold))
                                .foregroundStyle(CodexTheme.accent)
                        }

                        Spacer(minLength: 8)

                        Text(timestampText)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(CodexTheme.dim)
                    }

                    Text(item.preview)
                        .font(AppTheme.bodyFont)
                        .foregroundStyle(CodexTheme.muted)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 8) {
                        Text(item.workspaceLabel)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(CodexTheme.dim)
                        if let status = item.status {
                            CodexStatusChip(status: status)
                        }
                        if item.isPendingSession {
                            Text("Starting thread")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(CodexTheme.dim)
                                .padding(.horizontal, 8)
                                .frame(height: 24)
                                .background(CodexTheme.raisedPanel, in: Capsule())
                        }
                        Text(item.shortID)
                            .font(.caption2.monospaced())
                            .foregroundStyle(CodexTheme.dim)
                    }
                }

                Image(systemName: item.jobID == nil ? "bubble.left" : "chevron.right")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(CodexTheme.dim)
            }
            .padding(14)
            .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                    .stroke(isSelected ? CodexTheme.accent.opacity(0.7) : CodexTheme.stroke, lineWidth: 1)
            }
        }
        .buttonStyle(.plain)
        .disabled(item.jobID == nil && item.sessionID == nil)
    }

    private var timestampText: String {
        guard let date = item.updatedAt else {
            return ""
        }
        return Self.relativeFormatter.localizedString(for: date, relativeTo: Date())
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

private struct CodexStatusChip: View {
    let status: CodexJobStatus
    var isCancelling = false

    var body: some View {
        Text(isCancelling ? "Canceling" : status.label)
            .font(.caption2.weight(.bold))
        .foregroundStyle(status.tint)
        .padding(.horizontal, 8)
        .frame(height: 24)
        .background(status.tint.opacity(0.14), in: Capsule())
    }
}

private struct CodexErrorCard: View {
    let summary: CodexErrorSummary
    var onRetry: (() -> Void)?
    @State private var showingResponse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(AppTheme.statusError)
                    .padding(.top, 2)

                VStack(alignment: .leading, spacing: 4) {
                    Text("Request failed")
                        .font(AppTheme.cardTitleFont)
                        .foregroundStyle(CodexTheme.text)
                    Text(summary.statusLine)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(CodexTheme.muted)
                    Text(summary.summary)
                        .font(AppTheme.bodyFont)
                        .foregroundStyle(CodexTheme.text)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Spacer()
            }

            HStack(spacing: 12) {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        showingResponse.toggle()
                    }
                } label: {
                    Label(showingResponse ? "Hide response" : "Show response", systemImage: showingResponse ? "chevron.up" : "chevron.down")
                }
                .buttonStyle(CodexPillButtonStyle())

                Button {
                    UIPasteboard.general.string = summary.rawResponse
                } label: {
                    Text("Copy")
                }
                .buttonStyle(CodexPillButtonStyle())

                if let onRetry {
                    Button(action: onRetry) {
                        Text("Retry")
                    }
                    .buttonStyle(CodexPillButtonStyle(isAccent: true))
                }
            }

            if showingResponse {
                ScrollView {
                    Text(summary.rawResponse)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(CodexTheme.muted)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(12)
                }
                .frame(maxHeight: 220)
                .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: AppTheme.controlRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: AppTheme.controlRadius, style: .continuous)
                        .stroke(CodexTheme.stroke, lineWidth: 1)
                }
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                .stroke(AppTheme.statusError.opacity(0.42), lineWidth: 1)
        }
    }
}

private struct CodexNoticeCard: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(CodexTheme.accent)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 4) {
                Text(title)
                    .font(AppTheme.cardTitleFont)
                    .foregroundStyle(CodexTheme.text)
                Text(message)
                    .font(AppTheme.bodyFont)
                    .foregroundStyle(CodexTheme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }
}

private struct CodexPillButtonStyle: ButtonStyle {
    var isAccent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.caption.weight(.semibold))
            .foregroundStyle(isAccent ? CodexTheme.accent : CodexTheme.muted)
            .padding(.horizontal, 14)
            .frame(height: 34)
            .background(CodexTheme.raisedPanel.opacity(configuration.isPressed ? 0.72 : 1), in: Capsule())
    }
}

private struct CodexEmptyState: View {
    let symbol: String
    let title: String
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: symbol)
                .font(.title2.weight(.semibold))
                .foregroundStyle(CodexTheme.accent)
            Text(title)
                .font(AppTheme.cardTitleFont)
                .foregroundStyle(CodexTheme.text)
            Text(message)
                .font(AppTheme.bodyFont)
                .foregroundStyle(CodexTheme.muted)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: AppTheme.cardRadius, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }
}

private struct CodexLoadNotice: Equatable {
    let symbol: String
    let title: String
    let message: String

    static let jobUnavailable = CodexLoadNotice(
        symbol: "terminal",
        title: "Run unavailable",
        message: "This run is no longer available in job history. The thread can still be continued from its saved context."
    )

    static let latestRunUnavailable = CodexLoadNotice(
        symbol: "clock.badge.exclamationmark",
        title: "Latest run unavailable",
        message: "The latest run is no longer available in job history. Showing the saved thread context instead."
    )

    static func connectionInterrupted(provider: CodexProvider, hasCachedContent: Bool) -> CodexLoadNotice {
        CodexLoadNotice(
            symbol: "wifi.exclamationmark",
            title: hasCachedContent ? "Refresh skipped" : "\(provider.displayName) is reconnecting",
            message: hasCachedContent
                ? "The connection dropped while refreshing. Keeping the content already loaded here."
                : "The connection dropped while loading this run. Try refresh once the phone reconnects."
        )
    }
}

private struct CodexJobDetailView: View {
    let jobID: String
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onOpenThread: (String) -> Void
    let onOpenJob: (String) -> Void

    @State private var job: CodexJob?
    @State private var errorMessage: String?
    @State private var loadNotice: CodexLoadNotice?
    @State private var isLoading = false
    @State private var isRetrying = false
    @State private var isLoadingFullActivity = false

    var body: some View {
        ZStack {
            CodexTheme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let loadNotice {
                        CodexNoticeCard(
                            symbol: loadNotice.symbol,
                            title: loadNotice.title,
                            message: loadNotice.message
                        )
                    }

                    if let errorMessage {
                        CodexErrorCard(summary: CodexErrorSummary(message: errorMessage)) {
                            Task { await load() }
                        }
                    }

                    if let job {
                        CodexDetailHeader(job: job)
                        CodexMarkdownBlock(
                            title: "Answer",
                            symbol: "text.bubble",
                            preview: job.displayOutputPreview,
                            emptyText: answerEmptyText(for: job)
                        )
                        CodexLogBlock(
                            title: "Prompt",
                            symbol: "text.alignleft",
                            preview: job.promptPreview,
                            emptyText: "No prompt captured."
                        )
                        CodexDetailMetadata(job: job)
                        CodexRawActivityBlock(
                            preview: job.rawActivityPreview,
                            logsIncluded: job.logsIncluded,
                            canLoadFull: canLoadFullActivity(for: job),
                            isLoadingFull: isLoadingFullActivity
                        ) {
                            Task { await load(includeFullLogs: true) }
                        }
                    } else if isLoading {
                        CodexEmptyState(symbol: "arrow.triangle.2.circlepath", title: "Loading job", message: jobID)
                    } else if loadNotice == nil {
                        CodexEmptyState(
                            symbol: "terminal",
                            title: "Run unavailable",
                            message: "This run could not be loaded from job history."
                        )
                    }
                }
                .padding(16)
            }
        }
        .navigationTitle(shortJobID)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    Task { await load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh job")

                if job?.status.isActive == true {
                    Button(role: .destructive) {
                        Task {
                            await viewModel.cancel(id: jobID)
                            await load()
                        }
                    } label: {
                        Image(systemName: "stop.circle")
                    }
                    .accessibilityLabel("Cancel job")
                    .disabled(viewModel.isCancelling(jobID))
                }

                if let sessionID = job?.threadSessionId {
                    Button {
                        viewModel.selectSessionID(sessionID, workspaceID: job?.workspaceId)
                        onOpenThread(sessionID)
                    } label: {
                        Image(systemName: "bubble.left.and.text.bubble.right")
                    }
                    .accessibilityLabel("Open thread")
                }

                Button {
                    Task { await retry() }
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .accessibilityLabel("Retry job")
                .disabled(!canRetry || isRetrying)
            }
        }
        .refreshable {
            await load()
        }
        .task(id: jobID) {
            await pollJobWhileVisible()
        }
    }

    private var shortJobID: String {
        String(jobID.prefix(10))
    }

    private var canRetry: Bool {
        guard let prompt = job?.prompt?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return false
        }
        return !prompt.isEmpty
    }

    private func answerEmptyText(for job: CodexJob) -> String {
        if job.status.isActive {
            return "\(viewModel.provider.displayName) is still working. Pull to refresh or wait for the answer to appear here."
        }
        if job.rawActivityPreview.originalCharacterCount > 0 {
            return "This job has raw activity logs but no clean answer was captured. Open Activity log below."
        }
        return "No response yet."
    }

    private func canLoadFullActivity(for job: CodexJob) -> Bool {
        job.logsIncluded != "full" && (job.hasTruncatedServerOutput || job.rawActivityPreview.isTruncated)
    }

    private func load(includeFullLogs: Bool = false) async {
        if includeFullLogs {
            isLoadingFullActivity = true
        }
        isLoading = true
        defer {
            isLoading = false
            if includeFullLogs {
                isLoadingFullActivity = false
            }
        }

        do {
            job = try await viewModel.loadJob(id: jobID, includeFullLogs: includeFullLogs)
            errorMessage = nil
            loadNotice = nil
        } catch {
            if CodexConsoleViewModel.isHTTPNotFound(error) {
                job = nil
                errorMessage = nil
                loadNotice = .jobUnavailable
            } else if CodexConsoleViewModel.isTransientConnection(error) {
                errorMessage = nil
                loadNotice = .connectionInterrupted(provider: viewModel.provider, hasCachedContent: job != nil)
            } else {
                loadNotice = nil
                errorMessage = error.localizedDescription
            }
        }
    }

    private func pollJobWhileVisible() async {
        await load()
        while !Task.isCancelled {
            guard job?.status.isActive == true else { break }
            try? await Task.sleep(nanoseconds: 2_000_000_000)
            await load()
        }
    }

    private func retry() async {
        guard let job else { return }
        isRetrying = true
        defer { isRetrying = false }

        if let newJobID = await viewModel.retry(job) {
            onOpenJob(newJobID)
        }
    }
}

private struct CodexThreadDetailView: View {
    let sessionID: String
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onOpenJob: (String) -> Void

    @State private var threadDetail: CodexThreadDetail?
    @State private var threadDetailError: String?
    @State private var latestJob: CodexJob?
    @State private var latestJobError: String?
    @State private var latestJobNotice: CodexLoadNotice?
    @State private var isLoadingThreadDetail = false
    @State private var isLoadingLatestJob = false

    private var thread: CodexThread? {
        threadDetail?.thread ?? viewModel.threads.first { $0.sessionId == sessionID || $0.id == sessionID }
    }

    private var latestJobID: String? {
        thread?.lastJobId
    }

    private var chatItems: [CodexThreadChatItem] {
        CodexThreadChatItem.makeTranscript(
            detail: threadDetail,
            thread: thread,
            latestJob: latestJob
        )
    }

    var body: some View {
        ZStack {
            CodexTheme.background.ignoresSafeArea()

            ScrollViewReader { scrollProxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        CodexThreadOverviewCard(
                            provider: viewModel.provider,
                            thread: thread,
                            sessionID: sessionID
                        )

                        if let thread, thread.hasActiveJobs {
                            CodexThreadProgressCard(
                                latestJob: latestJob,
                                provider: viewModel.provider,
                                isLoadingLogs: isLoadingLatestJob,
                                loadError: latestJobError,
                                loadNotice: latestJobNotice
                            ) {
                                Task { await loadLatestJob(includeFullLogs: true) }
                            }
                        }

                        CodexThreadChatTranscriptView(
                            provider: viewModel.provider,
                            thread: thread,
                            items: chatItems,
                            isLoading: isLoadingThreadDetail,
                            loadError: threadDetailError,
                            loadNotice: latestJobNotice
                        ) {
                            Task { await refreshThreadDetailAndLatestJob() }
                        }
                    }
                    .padding(16)
                    .padding(.bottom, 18)
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: chatItems.count) { _, _ in
                    guard let lastID = chatItems.last?.id else { return }
                    withAnimation(.easeOut(duration: 0.2)) {
                        scrollProxy.scrollTo(lastID, anchor: .bottom)
                    }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            CodexThreadComposerDock(
                sessionID: sessionID,
                workspaceID: thread?.workspaceId ?? viewModel.selectedWorkspaceID,
                viewModel: viewModel,
                onSent: {
                    Task { await refreshThreadDetailAndLatestJob() }
                }
            )
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)
            .background(CodexTheme.background.opacity(0.97))
        }
        .navigationTitle(thread?.displayTitle ?? String(sessionID.prefix(10)))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if let latestJobID = thread?.lastJobId {
                    Button {
                        onOpenJob(latestJobID)
                    } label: {
                        Image(systemName: "terminal")
                    }
                    .accessibilityLabel("Open latest run")
                }

                Button {
                    Task {
                        await refreshThreadDetailAndLatestJob()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh thread")
                .disabled(viewModel.isRefreshing)
            }
        }
        .refreshable {
            await refreshThreadDetailAndLatestJob(includeFullLogs: true)
        }
        .task(id: sessionID) {
            viewModel.selectSessionID(sessionID, workspaceID: thread?.workspaceId)
            await refreshThreadDetailAndLatestJob()
        }
        .task(id: latestJobID) {
            await loadLatestJob()
        }
    }

    private func refreshThreadDetailAndLatestJob(includeFullLogs: Bool = false) async {
        await viewModel.refreshJobs()
        await viewModel.refreshThreads()
        await loadThreadDetail()
        await loadLatestJob(includeFullLogs: includeFullLogs)
    }

    private func loadThreadDetail() async {
        isLoadingThreadDetail = true
        defer { isLoadingThreadDetail = false }

        do {
            let detail = try await viewModel.loadThreadDetail(sessionID: sessionID)
            threadDetail = detail
            threadDetailError = nil
            if latestJob == nil, let latestJobID = detail.thread.lastJobId {
                latestJob = detail.jobs.first { $0.id == latestJobID }
            }
        } catch {
            if CodexConsoleViewModel.isTransientConnection(error) {
                threadDetailError = threadDetail == nil
                    ? "Could not load the full chat yet. Showing the saved summary."
                    : nil
            } else if CodexConsoleViewModel.isHTTPNotFound(error) {
                threadDetailError = "Full chat is not available for this thread yet."
            } else {
                threadDetailError = error.localizedDescription
            }
        }
    }

    private func loadLatestJob(includeFullLogs: Bool = false) async {
        guard let latestJobID else {
            latestJob = nil
            latestJobError = nil
            latestJobNotice = nil
            return
        }
        isLoadingLatestJob = true
        defer { isLoadingLatestJob = false }

        do {
            latestJob = try await viewModel.loadJob(id: latestJobID, includeFullLogs: includeFullLogs)
            latestJobError = nil
            latestJobNotice = nil
        } catch {
            if CodexConsoleViewModel.isHTTPNotFound(error) {
                latestJob = nil
                latestJobError = nil
                latestJobNotice = .latestRunUnavailable
            } else if CodexConsoleViewModel.isTransientConnection(error) {
                latestJobError = nil
                latestJobNotice = .connectionInterrupted(provider: viewModel.provider, hasCachedContent: latestJob != nil)
            } else {
                latestJobNotice = nil
                latestJobError = error.localizedDescription
            }
        }
    }
}

private struct CodexThreadOverviewCard: View {
    let provider: CodexProvider
    let thread: CodexThread?
    let sessionID: String

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(thread?.displayTitle ?? "\(provider.displayName) thread")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(CodexTheme.text)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    Text(thread?.workspaceLabel ?? provider.displayName)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(CodexTheme.dim)
                    if let status = thread?.lastJobStatus {
                        CodexStatusChip(status: status)
                    }
                    Text(thread?.shortID ?? String(sessionID.prefix(12)))
                        .font(.caption.monospaced())
                        .foregroundStyle(CodexTheme.dim)
                        .lineLimit(1)
                }
            }

            if let lastPrompt = CodexThreadText.trimmed(thread?.lastPrompt) {
                Text(lastPrompt)
                    .font(.subheadline)
                    .foregroundStyle(CodexTheme.muted)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }
}

private struct CodexThreadProgressCard: View {
    let latestJob: CodexJob?
    let provider: CodexProvider
    let isLoadingLogs: Bool
    let loadError: String?
    let loadNotice: CodexLoadNotice?
    let onLoadLogs: () -> Void
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
                if isExpanded {
                    onLoadLogs()
                }
            } label: {
                HStack(spacing: 10) {
                    ProgressView()
                        .tint(CodexTheme.accent)
                    Text("\(provider.displayName) is working in this thread")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CodexTheme.text)
                    Spacer()
                    Text(isExpanded ? "Hide logs" : "Logs")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.dim)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.accent)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if isExpanded {
                HStack(spacing: 10) {
                    Text(logStatusText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)

                    Spacer()

                    Button(action: onLoadLogs) {
                        Label(isLoadingLogs ? "Loading" : "Refresh", systemImage: "arrow.clockwise")
                    }
                    .buttonStyle(CodexPillButtonStyle())
                    .disabled(isLoadingLogs)
                }

                if let loadNotice {
                    Text(loadNotice.message)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)
                        .fixedSize(horizontal: false, vertical: true)
                } else if let loadError = CodexThreadText.trimmed(loadError) {
                    Text(loadError)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(AppTheme.statusError)
                        .fixedSize(horizontal: false, vertical: true)
                }

                ScrollView(.horizontal) {
                    Text(logText)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(hasLogs ? CodexTheme.muted : CodexTheme.dim)
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity, maxHeight: 260, alignment: .leading)
                .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var hasLogs: Bool {
        latestJob?.rawActivityPreview.originalCharacterCount ?? 0 > 0
    }

    private var logText: String {
        guard let latestJob else {
            if let loadNotice {
                return loadNotice.message
            }
            return isLoadingLogs ? "Loading latest activity..." : "Tap Refresh to load the latest activity."
        }
        return latestJob.rawActivityPreview.text
    }

    private var logStatusText: String {
        guard let latestJob else {
            if loadNotice != nil {
                return "Logs unavailable"
            }
            return isLoadingLogs ? "Loading latest activity" : "No activity loaded"
        }
        if latestJob.rawActivityPreview.isTruncated {
            return "Showing latest activity"
        }
        if latestJob.logsIncluded == "full" {
            return "Full log loaded"
        }
        return "Latest activity"
    }
}

private struct CodexThreadChatTranscriptView: View {
    let provider: CodexProvider
    let thread: CodexThread?
    let items: [CodexThreadChatItem]
    let isLoading: Bool
    let loadError: String?
    let loadNotice: CodexLoadNotice?
    let onRefresh: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Chat")
                        .font(.headline.weight(.semibold))
                        .foregroundStyle(CodexTheme.text)
                    Text(subtitle)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)
                        .lineLimit(1)
                }

                Spacer()

                Button(action: onRefresh) {
                    if isLoading {
                        ProgressView()
                            .tint(CodexTheme.text)
                            .frame(width: 32, height: 32)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 13, weight: .bold))
                            .foregroundStyle(CodexTheme.text)
                            .frame(width: 32, height: 32)
                    }
                }
                .background(CodexTheme.raisedPanel, in: Circle())
                .buttonStyle(.plain)
                .accessibilityLabel("Refresh chat")
            }

            if let loadError = CodexThreadText.trimmed(loadError) {
                Text(loadError)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let loadNotice {
                Text(loadNotice.message)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(CodexTheme.dim)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if items.isEmpty {
                CodexEmptyState(
                    symbol: "bubble.left.and.bubble.right",
                    title: thread?.hasActiveJobs == true ? "Waiting for answer" : "No chat yet",
                    message: thread?.hasActiveJobs == true
                        ? "\(provider.displayName) is working. This chat will update as soon as the backend records a response."
                        : "Send a reply below to continue this thread."
                )
            } else {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(items) { item in
                        CodexThreadChatBubble(provider: provider, item: item)
                            .id(item.id)
                    }
                }
            }
        }
    }

    private var subtitle: String {
        if items.isEmpty {
            return isLoading ? "Loading full thread" : "Thread history"
        }
        let turnCount = max(1, items.filter { $0.role == .user }.count)
        let countText = turnCount == 1 ? "1 turn" : "\(turnCount) turns"
        let progressCount = items.reduce(0) { $0 + $1.progressCount }
        let progressText = progressCount > 0 ? " · \(progressCount) updates collapsed" : ""
        if thread?.hasActiveJobs == true {
            return "\(countText)\(progressText) · live"
        }
        return "\(countText)\(progressText)"
    }
}

private struct CodexThreadChatBubble: View {
    let provider: CodexProvider
    let item: CodexThreadChatItem
    @State private var isExpanded = false

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            if item.alignment == .trailing {
                Spacer(minLength: 20)
            }

            VStack(alignment: bubbleAlignment, spacing: 7) {
                HStack(spacing: 6) {
                    Text(speakerLabel)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(headerColor)
                    if let timestampText {
                        Text(timestampText)
                            .font(.caption2.weight(.medium))
                            .foregroundStyle(item.role == .user ? AppTheme.bgCanvas.opacity(0.62) : CodexTheme.dim)
                    }
                }

                if shouldShowBody {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(Array(visibleSegments.enumerated()), id: \.offset) { _, segment in
                            switch segment.kind {
                            case .prose:
                                CodexMarkdownProse(text: segment.text, color: bodyColor)
                            case .code(let language):
                                CodexMarkdownCode(text: segment.text, language: language)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(shouldCollapse ? 8 : nil)
                } else if item.progressCount > 0 {
                    Text("\(item.progressCount) progress \(item.progressCount == 1 ? "update" : "updates")")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(CodexTheme.muted)
                }

                if item.isLong {
                    Button {
                        withAnimation(.easeInOut(duration: 0.18)) {
                            isExpanded.toggle()
                        }
                    } label: {
                        Label(expandButtonTitle, systemImage: isExpanded ? "chevron.up" : "chevron.down")
                    }
                    .buttonStyle(CodexPillButtonStyle(isAccent: item.role == .assistant || item.kind == .progressSummary))
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .frame(maxWidth: bubbleMaxWidth, alignment: alignment)
            .background(background, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .stroke(strokeColor, lineWidth: item.role == .user ? 0 : 1)
            }

            if item.alignment == .leading {
                Spacer(minLength: 20)
            }
        }
        .frame(maxWidth: .infinity, alignment: alignment)
    }

    private var shouldCollapse: Bool {
        item.kind != .progressSummary && item.isLong && !isExpanded
    }

    private var shouldShowBody: Bool {
        item.kind != .progressSummary || isExpanded
    }

    private var expandButtonTitle: String {
        if item.kind == .progressSummary {
            return isExpanded ? "Hide updates" : "Open updates"
        }
        return isExpanded ? "Collapse" : "Open"
    }

    private var visibleSegments: [CodexMarkdownSegment] {
        CodexMarkdownParser.segments(from: item.text)
    }

    private var speakerLabel: String {
        item.role == .assistant ? provider.displayName : item.speakerLabel
    }

    private var alignment: Alignment {
        switch item.alignment {
        case .leading:
            return .leading
        case .trailing:
            return .trailing
        case .center:
            return .center
        }
    }

    private var bubbleAlignment: HorizontalAlignment {
        item.alignment == .trailing ? .trailing : .leading
    }

    private var bubbleMaxWidth: CGFloat {
        item.alignment == .center ? .infinity : 310
    }

    private var cornerRadius: CGFloat {
        item.role == .user ? 18 : 14
    }

    private var background: Color {
        switch item.role {
        case .user:
            return CodexTheme.accent
        case .assistant:
            return CodexTheme.panel
        case .status:
            return item.isError ? AppTheme.statusError.opacity(0.12) : CodexTheme.raisedPanel.opacity(item.kind == .progressSummary ? 0.72 : 1)
        }
    }

    private var strokeColor: Color {
        item.isError ? AppTheme.statusError.opacity(0.42) : CodexTheme.stroke
    }

    private var headerColor: Color {
        item.role == .user ? AppTheme.bgCanvas.opacity(0.72) : CodexTheme.dim
    }

    private var bodyColor: Color {
        item.role == .user ? AppTheme.bgCanvas.opacity(0.92) : CodexTheme.text
    }

    private var timestampText: String? {
        guard let timestamp = item.timestamp else { return nil }
        return Self.relativeFormatter.localizedString(for: timestamp, relativeTo: Date())
    }

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter
    }()
}

private struct CodexThreadLatestAnswerCard: View {
    let thread: CodexThread?
    let latestJob: CodexJob?
    let isLoadingFullAnswer: Bool
    let loadError: String?
    let loadNotice: CodexLoadNotice?
    let onLoadFullAnswer: () -> Void

    var body: some View {
        if let answerText {
            CodexThreadMarkdownCard(
                title: latestJob == nil && thread?.lastJobId != nil ? "Latest answer preview" : "Latest answer",
                symbol: "text.bubble",
                text: answerText,
                isLoadingFullAnswer: isLoadingFullAnswer,
                loadError: loadError,
                onLoadFullAnswer: onLoadFullAnswer
            )
        } else if let errorText {
            CodexThreadMarkdownCard(
                title: "Last error",
                symbol: "exclamationmark.bubble",
                text: errorText,
                isError: true,
                isLoadingFullAnswer: isLoadingFullAnswer,
                loadError: loadError,
                onLoadFullAnswer: onLoadFullAnswer
            )
        } else if let loadNotice {
            CodexNoticeCard(
                symbol: loadNotice.symbol,
                title: loadNotice.title,
                message: loadNotice.message
            )
        } else {
            CodexEmptyState(
                symbol: "bubble.left.and.bubble.right",
                title: thread?.hasActiveJobs == true ? "Waiting for answer" : "No answer yet",
                message: thread?.hasActiveJobs == true
                    ? "Pull to refresh, or open the latest run from the toolbar."
                    : "Reply below to continue this thread."
            )
        }
    }

    private var answerText: String? {
        CodexThreadText.trimmed(latestJob?.displayOutput)
            ?? CodexThreadText.trimmed(thread?.lastResult)
    }

    private var errorText: String? {
        CodexThreadText.trimmed(latestJob?.errorMessage)
            ?? CodexThreadText.trimmed(thread?.lastError)
    }
}

private struct CodexThreadMarkdownCard: View {
    let title: String
    let symbol: String
    let text: String
    var isError = false
    var isLoadingFullAnswer = false
    var loadError: String?
    var onLoadFullAnswer: (() -> Void)?
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
                if isExpanded {
                    onLoadFullAnswer?()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: symbol)
                        .foregroundStyle(isError ? AppTheme.statusError : CodexTheme.accent)
                    Text(title)
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(CodexTheme.text)
                    Spacer()
                    if isLoadingFullAnswer {
                        ProgressView()
                            .tint(CodexTheme.text)
                    }
                    Text(isExpanded ? "Hide" : "Open")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.dim)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.accent)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isExpanded ? "Collapse \(title)" : "Expand \(title)")

            if let loadError = CodexThreadText.trimmed(loadError) {
                Text(loadError)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(AppTheme.statusError)
                    .fixedSize(horizontal: false, vertical: true)
            }

            VStack(alignment: .leading, spacing: 12) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    switch segment.kind {
                    case .prose:
                        CodexMarkdownProse(text: segment.text)
                    case .code(let language):
                        CodexMarkdownCode(text: segment.text, language: language)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .lineLimit(isExpanded ? nil : 9)
            .contentShape(Rectangle())
            .onTapGesture {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
                if isExpanded {
                    onLoadFullAnswer?()
                }
            }

            if !isExpanded {
                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        isExpanded = true
                    }
                    onLoadFullAnswer?()
                } label: {
                    Label("Show full answer", systemImage: "arrow.down.right.and.arrow.up.left")
                }
                .buttonStyle(CodexPillButtonStyle(isAccent: true))
            }
        }
        .padding(16)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isError ? AppTheme.statusError.opacity(0.45) : CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var segments: [CodexMarkdownSegment] {
        CodexMarkdownParser.segments(from: text)
    }
}

private struct CodexThreadComposerDock: View {
    let sessionID: String
    let workspaceID: String?
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onSent: () -> Void

    @State private var replyText = ""
    @State private var isSending = false
    @State private var lastSubmittedJobID: String?
    @State private var showingOptions = false
    @State private var showingSkillPicker = false
    @State private var showingPhotoPicker = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var showingDocumentPicker = false
    @State private var showingCameraPicker = false
    @State private var attachments: [CodexJobAttachment] = []
    @StateObject private var audioRecorder = CodexPromptAudioRecorder()
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if showsExpandedControls {
                CodexControlStrip(
                    viewModel: viewModel,
                    skillCount: viewModel.selectedSkills.count,
                    showsSkillControls: true
                ) {
                    showingSkillPicker = true
                }
            }

            if !viewModel.selectedSkills.isEmpty {
                CodexSelectedSkillStrip(viewModel: viewModel)
            }

            ZStack(alignment: .topLeading) {
                if replyText.isEmpty {
                    Text("Reply to this thread...")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(CodexTheme.dim)
                        .padding(.horizontal, 4)
                        .padding(.vertical, 8)
                        .allowsHitTesting(false)
                }

                TextEditor(text: $replyText)
                    .font(.system(size: 15))
                    .foregroundStyle(CodexTheme.text)
                    .scrollContentBackground(.hidden)
                    .textInputAutocapitalization(.sentences)
                    .autocorrectionDisabled()
                    .focused($isFocused)
                    .frame(minHeight: textEditorHeight, maxHeight: expandedForTyping ? 112 : 46)
            }

            if !attachments.isEmpty {
                CodexAttachmentTray(attachments: attachments) { attachment in
                    attachments.removeAll { $0.id == attachment.id }
                }
            }

            HStack(spacing: 10) {
                Text(statusText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(CodexTheme.dim)
                    .lineLimit(1)

                Spacer()

                Button {
                    withAnimation(.easeInOut(duration: 0.18)) {
                        showingOptions.toggle()
                    }
                } label: {
                    Label(optionsLabel, systemImage: "slider.horizontal.3")
                        .labelStyle(.iconOnly)
                        .frame(width: 38, height: 38)
                }
                .background(showsExpandedControls ? CodexTheme.accent.opacity(0.16) : CodexTheme.raisedPanel, in: Circle())
                .overlay {
                    Circle().stroke(showsExpandedControls ? CodexTheme.accent.opacity(0.45) : CodexTheme.stroke, lineWidth: 1)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(optionsLabel)

                CodexAttachmentMenu(
                    disabled: isSending || viewModel.isCreating || viewModel.isTranscribing,
                    showingPhotoPicker: $showingPhotoPicker,
                    showingDocumentPicker: $showingDocumentPicker,
                    showingCameraPicker: $showingCameraPicker
                )

                Button {
                    toggleRecording()
                } label: {
                    ZStack {
                        if viewModel.isTranscribing {
                            ProgressView()
                                .tint(CodexTheme.text)
                        } else {
                            Image(systemName: audioRecorder.isRecording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundStyle(audioRecorder.isRecording ? Color.white : CodexTheme.text)
                        }
                    }
                    .frame(width: 42, height: 42)
                    .background(audioRecorder.isRecording ? AppTheme.statusError : CodexTheme.raisedPanel, in: Circle())
                    .overlay {
                        Circle().stroke(CodexTheme.stroke, lineWidth: 1)
                    }
                }
                .buttonStyle(.plain)
                .disabled(isSending || viewModel.isCreating || viewModel.isTranscribing)
                .accessibilityLabel(audioRecorder.isRecording ? "Stop recording reply" : "Record reply")

                Button {
                    isFocused = false
                    Task { await send() }
                } label: {
                    Label(isSending ? "Sending" : "Send", systemImage: "paperplane.fill")
                        .font(.caption.weight(.bold))
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                        .frame(minWidth: 82)
                }
                .buttonStyle(CodexPillButtonStyle(isAccent: true))
                .disabled(!canSend)
            }
        }
        .padding(10)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(isFocused ? CodexTheme.accent : CodexTheme.stroke, lineWidth: 1)
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button {
                    isFocused = false
                } label: {
                    Label("Done", systemImage: "keyboard.chevron.compact.down")
                }
                .font(.body.weight(.semibold))
            }
        }
        .sheet(isPresented: $showingSkillPicker) {
            CodexSkillPickerSheet(viewModel: viewModel)
                .presentationDetents([.medium, .large])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingDocumentPicker) {
            CodexDocumentPicker { urls in
                Task { await importDocuments(urls) }
            }
        }
        .fullScreenCover(isPresented: $showingCameraPicker) {
            CodexCameraPicker { data in
                appendAttachment(
                    data: data,
                    filename: "camera-\(Self.fileTimestamp()).jpg",
                    contentType: "image/jpeg"
                )
            }
            .ignoresSafeArea()
        }
        .photosPicker(
            isPresented: $showingPhotoPicker,
            selection: $selectedPhotoItems,
            maxSelectionCount: 6,
            matching: .images
        )
        .onChange(of: selectedPhotoItems) { _, items in
            Task { await importPhotos(items) }
        }
        .animation(.easeInOut(duration: 0.18), value: showsExpandedControls)
        .animation(.easeInOut(duration: 0.18), value: expandedForTyping)
    }

    private var canSend: Bool {
        (!replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty)
            && !isSending
            && !viewModel.isCreating
            && !viewModel.isTranscribing
            && !audioRecorder.isRecording
    }

    private var statusText: String {
        if audioRecorder.isRecording { return "Recording" }
        if viewModel.isTranscribing { return "Transcribing" }
        if isSending || viewModel.isCreating { return "Sending" }
        if let lastSubmittedJobID {
            return "Sent \(String(lastSubmittedJobID.prefix(8)))"
        }
        if !attachments.isEmpty {
            return "\(attachments.count) attached"
        }
        return "Thread \(String(sessionID.prefix(8)))"
    }

    private var expandedForTyping: Bool {
        isFocused || !replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var showsExpandedControls: Bool {
        showingOptions || expandedForTyping || !attachments.isEmpty || !viewModel.selectedSkills.isEmpty
    }

    private var textEditorHeight: CGFloat {
        expandedForTyping ? 72 : 36
    }

    private var optionsLabel: String {
        if viewModel.provider == .codex {
            let skillText = viewModel.selectedSkills.isEmpty ? "skills" : "\(viewModel.selectedSkills.count) skills"
            return "\(viewModel.selectedRunMode.label), \(viewModel.selectedReasoningEffort.label), \(skillText)"
        }
        let skillText = viewModel.selectedSkills.isEmpty ? "skills" : "\(viewModel.selectedSkills.count) skills"
        return "\(viewModel.selectedClaudePermissionMode.label), \(viewModel.selectedReasoningEffort.label), \(skillText)"
    }

    private func toggleRecording() {
        if audioRecorder.isRecording {
            guard let fileURL = audioRecorder.stopRecording() else { return }
            Task {
                if let transcript = await viewModel.transcribeAudioText(fileURL: fileURL) {
                    appendTranscription(transcript)
                }
                audioRecorder.deleteRecording(at: fileURL)
            }
            return
        }

        isFocused = false
        Task {
            do {
                try await audioRecorder.startRecording()
            } catch {
                viewModel.errorMessage = error.localizedDescription
            }
        }
    }

    private func appendTranscription(_ text: String) {
        let transcript = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !transcript.isEmpty else { return }

        let existingReply = replyText.trimmingCharacters(in: .whitespacesAndNewlines)
        if existingReply.isEmpty {
            replyText = transcript
        } else {
            replyText = "\(existingReply)\n\n\(transcript)"
        }
    }

    private func appendAttachment(data: Data, filename: String, contentType: String) {
        guard let attachment = viewModel.makeAttachment(
            data: data,
            filename: filename,
            contentType: contentType,
            existing: attachments
        ) else {
            return
        }
        attachments.append(attachment)
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        guard !items.isEmpty else { return }
        for item in items {
            guard let data = try? await item.loadTransferable(type: Data.self) else {
                await MainActor.run { viewModel.errorMessage = "Could not read the selected photo." }
                continue
            }
            let contentType = item.supportedContentTypes.first(where: { $0.conforms(to: .image) }) ?? .jpeg
            await MainActor.run {
                appendAttachment(
                    data: data,
                    filename: "photo-\(Self.fileTimestamp()).\(contentType.preferredFilenameExtension ?? "jpg")",
                    contentType: contentType.preferredMIMEType ?? "image/jpeg"
                )
            }
        }
        await MainActor.run { selectedPhotoItems = [] }
    }

    private func importDocuments(_ urls: [URL]) async {
        for url in urls {
            let isScoped = url.startAccessingSecurityScopedResource()
            defer {
                if isScoped {
                    url.stopAccessingSecurityScopedResource()
                }
            }
            do {
                let data = try Data(contentsOf: url)
                let contentType = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                await MainActor.run {
                    appendAttachment(data: data, filename: url.lastPathComponent, contentType: contentType)
                }
            } catch {
                await MainActor.run {
                    viewModel.errorMessage = "Could not read \(url.lastPathComponent)."
                }
            }
        }
    }

    private static func fileTimestamp() -> String {
        String(Int(Date().timeIntervalSince1970))
    }

    private func send() async {
        let message = replyText
        let outgoingAttachments = attachments
        isSending = true
        defer { isSending = false }

        viewModel.selectSessionID(sessionID, workspaceID: workspaceID)
        if let newJobID = await viewModel.createFollowUp(
            prompt: message,
            sessionID: sessionID,
            workspaceID: workspaceID,
            attachments: outgoingAttachments
        ) {
            replyText = ""
            attachments = []
            showingOptions = false
            lastSubmittedJobID = newJobID
            await viewModel.refreshThreads()
            onSent()
        }
    }
}

private enum CodexThreadText {
    static func trimmed(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}

private struct CodexDetailHeader: View {
    let job: CodexJob

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(job.displayPrompt)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(CodexTheme.text)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    CodexStatusChip(status: job.status)
                    Text(job.id)
                        .font(.caption2.monospaced())
                        .foregroundStyle(CodexTheme.dim)
                        .lineLimit(1)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }
}

private struct CodexDetailMetadata: View {
    let job: CodexJob

    var body: some View {
        VStack(spacing: 10) {
            CodexMetadataRow(label: "Workspace", value: job.workspaceName ?? job.workspaceId ?? "Unknown", symbol: "folder")
            if let threadSessionId = job.threadSessionId {
                CodexMetadataRow(label: "Thread", value: String(threadSessionId.prefix(18)), symbol: "bubble.left.and.bubble.right")
            }
            if let model = trimmed(job.model) {
                CodexMetadataRow(label: "Model", value: model, symbol: "cpu")
            }
            if let reasoningEffort = trimmed(job.reasoningEffort) {
                CodexMetadataRow(label: "Reasoning", value: reasoningEffort.uppercased(), symbol: "slider.horizontal.3")
            }
            CodexMetadataRow(label: "Created", value: formatted(job.createdAt), symbol: "calendar")
            CodexMetadataRow(label: "Updated", value: formatted(job.updatedAt), symbol: "clock.arrow.circlepath")
            if let exitCode = job.exitCode {
                CodexMetadataRow(label: "Exit", value: String(exitCode), symbol: "number")
            }
            if let timeoutMs = job.timeoutMs {
                CodexMetadataRow(label: "Timeout", value: "\(timeoutMs / 1_000)s", symbol: "timer")
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private func formatted(_ date: Date?) -> String {
        guard let date else { return "Unknown" }
        return Self.dateFormatter.string(from: date)
    }

    private func trimmed(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .medium
        return formatter
    }()
}

private struct CodexMetadataRow: View {
    let label: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol)
                .font(.caption.weight(.bold))
                .foregroundStyle(CodexTheme.accent)
                .frame(width: 20)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(CodexTheme.muted)
            Spacer()
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(CodexTheme.text)
                .lineLimit(1)
        }
    }
}

private struct CodexRawActivityBlock: View {
    let preview: CodexTextPreview
    let logsIncluded: String?
    let canLoadFull: Bool
    let isLoadingFull: Bool
    let onLoadFull: () -> Void
    @State private var isExpanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "terminal")
                        .foregroundStyle(CodexTheme.accent)
                    Text("Activity log")
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(CodexTheme.text)
                    Spacer()
                    Text(summary)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)
                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.accent)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                HStack(spacing: 10) {
                    Text(statusText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)

                    Spacer()

                    if canLoadFull {
                        Button(action: onLoadFull) {
                            Label(isLoadingFull ? "Loading" : "Load full", systemImage: "arrow.down.doc")
                        }
                        .buttonStyle(CodexPillButtonStyle())
                        .disabled(isLoadingFull)
                    }
                }

                ScrollView(.horizontal) {
                    Text(preview.text)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(CodexTheme.muted)
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxWidth: .infinity, maxHeight: 260, alignment: .leading)
                .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var summary: String {
        if preview.originalCharacterCount == 0 { return "Empty" }
        return "\(Self.compactCount(preview.originalCharacterCount)) chars"
    }

    private var statusText: String {
        if preview.originalCharacterCount == 0 {
            return "Empty"
        }
        if preview.isTruncated {
            return "Showing latest activity"
        }
        if logsIncluded == "full" {
            return "Full log loaded"
        }
        return "Latest activity"
    }

    private static func compactCount(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fm", Double(value) / 1_000_000)
        }
        if value >= 1_000 {
            return String(format: "%.1fk", Double(value) / 1_000)
        }
        return String(value)
    }
}

private struct CodexLogBlock: View {
    let title: String
    let symbol: String
    let preview: CodexTextPreview
    let emptyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .foregroundStyle(CodexTheme.accent)
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(CodexTheme.text)
                Spacer()
                Text("\(preview.originalCharacterCount) chars")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(CodexTheme.dim)
            }

            ScrollView(.horizontal) {
                Text(displayText)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(hasText ? CodexTheme.text : CodexTheme.dim)
                    .textSelection(.enabled)
                    .padding(12)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var hasText: Bool {
        preview.originalCharacterCount > 0
    }

    private var displayText: String {
        hasText ? preview.text : emptyText
    }
}

private struct CodexMarkdownBlock: View {
    let title: String
    let symbol: String
    let preview: CodexTextPreview
    let emptyText: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: symbol)
                    .foregroundStyle(CodexTheme.accent)
                Text(title)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(CodexTheme.text)
                Spacer()
                Text("\(preview.originalCharacterCount) chars")
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(CodexTheme.dim)
            }

            if hasText {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                        switch segment.kind {
                        case .prose:
                            CodexMarkdownProse(text: segment.text)
                        case .code(let language):
                            CodexMarkdownCode(text: segment.text, language: language)
                        }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
                .background(CodexTheme.raisedPanel.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            } else {
                Text(emptyText)
                    .font(.system(size: 14))
                    .foregroundStyle(CodexTheme.dim)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(CodexTheme.raisedPanel.opacity(0.78), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var hasText: Bool {
        preview.hasText
    }

    private var displayText: String {
        hasText ? preview.text : emptyText
    }

    private var segments: [CodexMarkdownSegment] {
        CodexMarkdownParser.segments(from: displayText)
    }
}

private struct CodexMarkdownProse: View {
    let text: String
    var color: Color = CodexTheme.text

    var body: some View {
        Text(markdownText)
            .font(.system(size: 14))
            .foregroundStyle(color)
            .lineSpacing(3)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
    }

    private var markdownText: AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace
        )
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}

private struct CodexMarkdownCode: View {
    let text: String
    let language: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let language, !language.isEmpty {
                Text(language.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(CodexTheme.dim)
            }

            ScrollView(.horizontal) {
                Text(text.isEmpty ? " " : text)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundStyle(CodexTheme.text)
                    .textSelection(.enabled)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

private struct CodexMarkdownSegment: Hashable {
    enum Kind: Hashable {
        case prose
        case code(String?)
    }

    let kind: Kind
    let text: String
}

private enum CodexMarkdownParser {
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
}

private extension CodexJobStatus {
    var tint: Color {
        switch self {
        case .queued:
            return AppTheme.statusWarn
        case .running:
            return CodexTheme.accent
        case .succeeded:
            return AppTheme.statusOK
        case .failed:
            return AppTheme.statusError
        case .canceling:
            return AppTheme.statusWarn
        case .canceled, .timeout:
            return AppTheme.statusNeutral
        case .unknown:
            return AppTheme.statusInfo
        }
    }
}
