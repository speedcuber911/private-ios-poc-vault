import SwiftUI
import UIKit

struct CodexConsoleView: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    @State private var path: [String] = []
    @State private var resultsExpanded = false

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                CodexTheme.background.ignoresSafeArea()
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        CodexHeader(viewModel: viewModel)

                        CodexPromptCard(
                            viewModel: viewModel,
                            onCreated: { jobID in path.append(jobID) },
                            onOpenJob: { jobID in path.append(jobID) }
                        )

                        if let errorMessage = viewModel.errorMessage {
                            CodexErrorCard(summary: CodexErrorSummary(message: errorMessage)) {
                                Task { await viewModel.refreshAll() }
                            }
                        }

                        CollapsibleResultsSection(
                            viewModel: viewModel,
                            isExpanded: $resultsExpanded
                        ) { jobID in
                            path.append(jobID)
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                    .padding(.bottom, 132)
                }
                .scrollDismissesKeyboard(.interactively)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(.hidden, for: .navigationBar)
            .refreshable {
                await viewModel.refreshAll()
            }
            .navigationDestination(for: String.self) { jobID in
                CodexJobDetailView(
                    jobID: jobID,
                    viewModel: viewModel,
                    onCreated: { newJobID in
                        path.append(newJobID)
                    },
                    onContinueThread: {
                        path.removeAll()
                    }
                )
            }
            .task {
                await viewModel.bootstrapIfNeeded()
                await viewModel.pollJobsWhileVisible()
            }
        }
    }
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
            VaultLogoMark(size: 34)

            Text("Codex")
                .font(.title3.weight(.semibold))
                .foregroundStyle(CodexTheme.text)

            Spacer()

            Button {
                Task { await viewModel.refreshAll() }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(CodexTheme.text)
                    .frame(width: 36, height: 36)
                    .background(CodexTheme.raisedPanel, in: Circle())
                    .overlay {
                        Circle().stroke(CodexTheme.stroke, lineWidth: 1)
                    }
            }
            .buttonStyle(.plain)
            .disabled(viewModel.isRefreshing)
            .accessibilityLabel("Refresh Codex")
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

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text(viewModel.selectedSession == nil ? "What should Codex do?" : "Continue this thread")
                    .font(.title2.weight(.semibold))
                    .foregroundStyle(CodexTheme.text)
                Text(contextText)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(CodexTheme.dim)
                    .lineLimit(2)
            }

            CodexControlStrip(
                viewModel: viewModel,
                skillCount: viewModel.selectedSkills.count
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
                    Text("Type a prompt for Codex...")
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
                    .frame(minHeight: 220, maxHeight: 300)
                    .background(Color.clear)
            }

            Divider()
                .overlay(CodexTheme.stroke)

            HStack(spacing: 10) {
                Text(disabledReason)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(CodexTheme.dim)
                    .lineLimit(1)

                Spacer()

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
                        .foregroundStyle(canCreate ? AppTheme.bgCanvas : CodexTheme.dim)
                        .padding(.horizontal, 20)
                        .frame(height: 44)
                        .background((canCreate ? CodexTheme.accent : CodexTheme.raisedPanel), in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canCreate)
            }

        }
        .padding(18)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(promptIsFocused ? CodexTheme.accent : CodexTheme.stroke, lineWidth: 1)
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
    }

    private var canCreate: Bool {
        !viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !viewModel.isCreating
    }

    private var disabledReason: String {
        if viewModel.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Enter a prompt"
        }
        return "Ready"
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
            .accessibilityLabel("Start a new Codex thread")

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
            .accessibilityLabel("Browse Codex threads")

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
        let count = viewModel.threadsForSelectedWorkspace.count
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

    private var filteredThreads: [CodexThread] {
        let threads = viewModel.threadsForSelectedWorkspace
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
            .navigationTitle("Threads")
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
            ? "Run a Codex job on EC2 and it will appear here."
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
                VStack(alignment: .leading, spacing: 7) {
                    HStack(spacing: 8) {
                        Text(thread.displayTitle)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(CodexTheme.text)
                            .lineLimit(1)
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

                    Text(thread.previewText)
                        .font(.caption)
                        .foregroundStyle(CodexTheme.muted)
                        .lineLimit(2)

                    HStack(spacing: 8) {
                        if let status = thread.lastJobStatus {
                            CodexStatusChip(status: status)
                        }
                        Text("\(thread.jobCount) \(thread.jobCount == 1 ? "job" : "jobs")")
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(CodexTheme.dim)
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

private struct CodexControlStrip: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let skillCount: Int
    let onSkillsTapped: () -> Void

    private let models = [
        "gpt-5.5",
        "gpt-5.4",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.2"
    ]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            controlRow

            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    skillsButton
                    Spacer(minLength: 0)
                }

                HStack(spacing: 10) {
                    modelMenu
                    reasoningMenu
                    Spacer(minLength: 0)
                }
            }
        }
        .padding(12)
        .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var controlRow: some View {
        HStack(spacing: 10) {
            skillsButton
            modelMenu
            reasoningMenu
            Spacer(minLength: 8)
        }
    }

    private var skillsButton: some View {
        Button(action: onSkillsTapped) {
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.caption.weight(.bold))
                Text(skillCount == 0 ? "Skills" : "\(skillCount) skills")
                    .font(.caption.weight(.bold))
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
        .accessibilityLabel("Choose Codex skills")
    }

    private var modelMenu: some View {
        Menu {
            ForEach(models, id: \.self) { model in
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
                    .font(.caption.weight(.bold))
                Text(viewModel.selectedModel)
                    .font(.caption.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.76)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(CodexTheme.text)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(CodexTheme.raisedPanel, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose model")
    }

    private var reasoningMenu: some View {
        Menu {
            ForEach(CodexReasoningEffort.allCases) { effort in
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
                    .font(.caption.weight(.bold))
                Text(viewModel.selectedReasoningEffort.label)
                    .font(.caption.weight(.bold))
                    .lineLimit(1)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(CodexTheme.text)
            .padding(.horizontal, 12)
            .frame(height: 36)
            .background(CodexTheme.raisedPanel, in: Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Choose reasoning effort")
        .accessibilityValue(viewModel.selectedReasoningEffort.label)
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
                            Text(skill.id)
                                .font(.caption.weight(.bold))
                                .lineLimit(1)
                            Image(systemName: "xmark")
                                .font(.caption2.weight(.bold))
                        }
                        .foregroundStyle(AppTheme.bgCanvas)
                        .padding(.horizontal, 10)
                        .frame(height: 30)
                        .background(CodexTheme.accent, in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Remove \(skill.id)")
                }
            }
            .padding(.vertical, 2)
        }
    }
}

private struct CodexSkillPickerSheet: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    @Environment(\.dismiss) private var dismiss
    @State private var searchText = ""

    private var filteredSkills: [CodexSkill] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !query.isEmpty else { return CodexSkill.all }
        return CodexSkill.all.filter { $0.searchText.contains(query) }
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
                        Text("No matches")
                            .font(.headline)
                            .foregroundStyle(CodexTheme.text)
                        Text(searchText)
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

private struct CodexJobsSection: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if viewModel.isRefreshing && viewModel.jobs.isEmpty {
                CodexEmptyState(symbol: "arrow.triangle.2.circlepath", title: "Loading jobs", message: "Fetching Codex activity.")
            } else if viewModel.jobs.isEmpty {
                CodexEmptyState(symbol: "terminal", title: "No results yet", message: "Send a prompt to see the first result here.")
            } else {
                VStack(spacing: 10) {
                    ForEach(viewModel.jobs) { job in
                        Button {
                            onSelect(job.id)
                        } label: {
                            CodexJobRow(job: job, isCancelling: viewModel.isCancelling(job.id))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }
}

private struct CollapsibleResultsSection: View {
    @ObservedObject var viewModel: CodexConsoleViewModel
    @Binding var isExpanded: Bool
    let onSelect: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    isExpanded.toggle()
                }
            } label: {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Results")
                            .font(.caption.weight(.bold))
                            .foregroundStyle(CodexTheme.dim)
                            .tracking(1.4)
                            .textCase(.uppercase)
                        Text(summaryText)
                            .font(.caption.weight(.medium))
                            .foregroundStyle(CodexTheme.dim)
                    }

                    Spacer()

                    Image(systemName: "chevron.down")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(CodexTheme.accent)
                        .rotationEffect(.degrees(isExpanded ? 180 : 0))
                }
                .padding(.horizontal, 14)
                .frame(minHeight: 58)
                .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .stroke(CodexTheme.stroke, lineWidth: 1)
                }
            }
            .buttonStyle(.plain)

            if isExpanded {
                CodexJobsSection(viewModel: viewModel, onSelect: onSelect)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
    }

    private var summaryText: String {
        if viewModel.isRefreshing && viewModel.jobs.isEmpty {
            return "Loading..."
        }
        let count = viewModel.jobs.count
        if count == 0 {
            return "No results yet"
        }
        return "\(count) \(count == 1 ? "result" : "results")"
    }
}

private struct CodexJobRow: View {
    let job: CodexJob
    let isCancelling: Bool

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(isCancelling ? "Canceling" : job.status.label)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(job.status.tint)

                    Spacer(minLength: 8)

                    Text(timestampText)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(CodexTheme.dim)
                }

                Text("\"\(job.displayPrompt)\"")
                    .font(.subheadline.italic())
                    .foregroundStyle(CodexTheme.muted)
                    .lineLimit(1)
            }

            Image(systemName: "chevron.right")
                .font(.caption.weight(.bold))
                .foregroundStyle(CodexTheme.dim)
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(CodexTheme.stroke, lineWidth: 1)
        }
    }

    private var timestampText: String {
        guard let date = job.updatedAt ?? job.createdAt else {
            return job.id
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
                        .font(.subheadline.weight(.bold))
                        .foregroundStyle(CodexTheme.text)
                    Text(summary.statusLine)
                        .font(.system(size: 12, weight: .medium, design: .monospaced))
                        .foregroundStyle(CodexTheme.muted)
                    Text(summary.summary)
                        .font(.callout)
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
                .background(CodexTheme.raisedPanel, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .stroke(CodexTheme.stroke, lineWidth: 1)
                }
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .stroke(AppTheme.statusError.opacity(0.42), lineWidth: 1)
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
                .font(.headline)
                .foregroundStyle(CodexTheme.text)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(CodexTheme.muted)
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

private struct CodexJobDetailView: View {
    let jobID: String
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onCreated: (String) -> Void
    let onContinueThread: () -> Void

    @State private var job: CodexJob?
    @State private var errorMessage: String?
    @State private var isLoading = false
    @State private var isRetrying = false
    @State private var isLoadingFullActivity = false

    var body: some View {
        ZStack {
            CodexTheme.background.ignoresSafeArea()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let errorMessage {
                        CodexErrorCard(summary: CodexErrorSummary(message: errorMessage)) {
                            Task { await load() }
                        }
                    }

                    if let job {
                        CodexDetailHeader(job: job)
                        if let threadSessionID = job.threadSessionId {
                            CodexThreadReplyCard(
                                sessionID: threadSessionID,
                                workspaceID: job.workspaceId,
                                viewModel: viewModel,
                                onCreated: onCreated
                            )
                        }
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
                    } else {
                        CodexEmptyState(symbol: "terminal", title: "Job unavailable", message: jobID)
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
                        onContinueThread()
                    } label: {
                        Image(systemName: "bubble.left.and.text.bubble.right")
                    }
                    .accessibilityLabel("Continue thread in compose")
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
            return "Codex is still working. Pull to refresh or wait for the answer to appear here."
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
        } catch {
            errorMessage = error.localizedDescription
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
            onCreated(newJobID)
        }
    }
}

private struct CodexThreadReplyCard: View {
    let sessionID: String
    let workspaceID: String?
    @ObservedObject var viewModel: CodexConsoleViewModel
    let onCreated: (String) -> Void

    @State private var replyText = ""
    @State private var isSending = false
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .foregroundStyle(CodexTheme.accent)
                Text("Reply in this thread")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(CodexTheme.text)
                Spacer()
                Text(String(sessionID.prefix(12)))
                    .font(.caption2.monospaced())
                    .foregroundStyle(CodexTheme.dim)
            }

            ZStack(alignment: .topLeading) {
                if replyText.isEmpty {
                    Text("Write the next message...")
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
                    .frame(minHeight: 104, maxHeight: 150)
            }

            HStack(spacing: 10) {
                Button {
                    viewModel.selectSessionID(sessionID, workspaceID: workspaceID)
                    isFocused = false
                } label: {
                    Text("Use in compose")
                }
                .buttonStyle(CodexPillButtonStyle())

                Spacer()

                Button {
                    isFocused = false
                    Task { await send() }
                } label: {
                    Label(isSending ? "Sending" : "Send reply", systemImage: "paperplane.fill")
                }
                .buttonStyle(CodexPillButtonStyle(isAccent: true))
                .disabled(!canSend)
            }
        }
        .padding(14)
        .background(CodexTheme.panel, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
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
    }

    private var canSend: Bool {
        !replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSending
    }

    private func send() async {
        let message = replyText
        isSending = true
        defer { isSending = false }

        if let newJobID = await viewModel.createFollowUp(prompt: message, sessionID: sessionID, workspaceID: workspaceID) {
            replyText = ""
            onCreated(newJobID)
        }
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
        if preview.isTruncated {
            return "Showing a safe preview"
        }
        if logsIncluded == "full" {
            return "Full log loaded"
        }
        return "Preview"
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

    var body: some View {
        Text(text)
            .font(.system(size: 14))
            .foregroundStyle(CodexTheme.text)
            .lineSpacing(3)
            .textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
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
