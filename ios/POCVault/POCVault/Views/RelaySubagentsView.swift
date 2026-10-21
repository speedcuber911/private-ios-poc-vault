import SwiftUI

enum RelayChatSection: Hashable {
    case chat, subagents
}

/// A task in the open conversation, with a route back to its live activity.
/// Both native desktop history and Relay jobs use the same timeline contract.
struct RelaySubagent: Identifiable, Hashable {
    let request: RelayActivityRequest
    let step: RelayStep
    let provider: CodexProvider?
    let parentTitle: String?
    let descendants: [RelayStep]
    private(set) var parentID: String? = nil
    private(set) var depth: Int = 0
    private let priority: Int

    var id: String { step.agent?.id.map { "\(provider?.rawValue ?? "agent"):\($0)" } ?? request.id }
    var name: String { step.agent?.name ?? step.agent?.role ?? step.input.agentType ?? "Subagent" }
    var isWorking: Bool {
        if let status = step.agent?.statusLabel {
            return status == "Working" || status == "Waiting"
        }
        return step.status == .running || descendants.contains { $0.status == .running }
    }

    var statusLabel: String? {
        if let status = step.agent?.statusLabel { return status }
        if isWorking { return "In progress" }
        switch step.status {
        case .failed: return "Failed"
        case .cancelled: return "Stopped"
        // A completed spawn call only confirms launch, especially in Codex
        // and background Claude tasks. It does not prove the child finished.
        case .done, .running: return nil
        }
    }

    static func collect(messages: [RelayConversationItem], timelines: [String: RelayTimeline]) -> [RelaySubagent] {
        var result: [RelaySubagent] = []
        var aliases: [String: String] = [:]

        func append(_ timeline: RelayTimeline, source: RelayActivityRequest.Source, provider: CodexProvider?, priority: Int) {
            for step in timeline.subagentSteps {
                var entry = RelaySubagent(
                    request: RelayActivityRequest(source: source, root: .step(step.id)),
                    step: step,
                    provider: provider,
                    parentTitle: step.parentID.flatMap { timeline.step($0)?.displaySummary },
                    descendants: timeline.descendants(of: step.id),
                    priority: priority
                )
                var ancestor = step.parentID
                var visited: Set<String> = [step.id]
                while let ancestorID = ancestor, visited.insert(ancestorID).inserted,
                      let parent = timeline.step(ancestorID) {
                    if parent.kind == .agent {
                        entry.parentID = parent.agent?.id.map { "\(provider?.rawValue ?? "agent"):\($0)" }
                            ?? RelayActivityRequest(source: source, root: .step(parent.id)).id
                        break
                    }
                    ancestor = parent.parentID
                }
                // A restored turn and its job can carry the same native call.
                // Prefer the live job while active, then the richer transcript.
                // Different jobs may reuse short item ids; keep those separate.
                let duplicate = result.firstIndex { existing in
                    if let id = step.agent?.id, existing.step.agent?.id == id, existing.provider == provider { return true }
                    if let callID = step.agent?.callId, existing.step.agent?.callId == callID, existing.provider == provider { return true }
                    guard existing.step.id == step.id, existing.provider == provider,
                          existing.step.startedAt == step.startedAt else { return false }
                    if case .job(let first) = existing.request.source, case .job(let second) = source {
                        return first == second
                    }
                    return true
                }
                if let duplicate {
                    let existing = result[duplicate]
                    if priority > existing.priority || (priority == existing.priority && step.agent?.id != nil &&
                        (step.input.prompt != nil || existing.step.input.prompt == nil)) {
                        entry.parentID = entry.parentID ?? existing.parentID
                        result[duplicate] = entry
                        aliases[existing.id] = entry.id
                        aliases[existing.request.id] = entry.id
                    } else if existing.parentID == nil {
                        result[duplicate].parentID = entry.parentID
                    }
                    aliases[entry.id] = result[duplicate].id
                    aliases[entry.request.id] = result[duplicate].id
                } else {
                    result.append(entry)
                }
            }
        }

        // Never traverse all cached jobs: only tasks belonging to this chat.
        for message in messages {
            if let history = message.historyTimeline {
                append(history, source: .message(message.id), provider: message.provider, priority: 1)
            }
            if let job = message.job, let timeline = timelines[job.id] {
                append(timeline, source: .job(job.id), provider: job.provider, priority: job.status.isActive ? 2 : 0)
            }
        }
        // Sort sibling groups only, then walk each entire branch. A working
        // grandchild must never jump out above its parent. Broken/cyclic links
        // remain visible once instead of hiding tasks or recursing forever.
        for index in result.indices {
            var parent = result[index].parentID
            var visited = Set<String>()
            while let id = parent, visited.insert(id).inserted, let replacement = aliases[id], replacement != id {
                parent = replacement
            }
            result[index].parentID = parent
        }
        let ids = Set(result.map(\.id))
        var ordered: [RelaySubagent] = []
        var visited = Set<String>()
        func appendBranch(_ entry: RelaySubagent, depth: Int) {
            guard visited.insert(entry.id).inserted else { return }
            var row = entry
            row.depth = depth
            ordered.append(row)
            let children = result.filter { $0.parentID == entry.id }
            for child in children.filter(\.isWorking) + children.filter({ !$0.isWorking }) {
                appendBranch(child, depth: depth + 1)
            }
        }
        let roots = result.filter { $0.parentID == nil || !ids.contains($0.parentID!) }
        for root in roots.filter(\.isWorking) + roots.filter({ !$0.isWorking }) { appendBranch(root, depth: 0) }
        for orphan in result where !visited.contains(orphan.id) { appendBranch(orphan, depth: 0) }
        return ordered
    }
}

extension RelayStep {
    var subagentAvatarSeed: String { agent?.id ?? agent?.callId ?? id }
}

/// A deterministic identity mark, independent of status and row order.
/// Swift's randomized Hasher would change the avatar after every app launch.
struct RelayAgentAvatar: View {
    let seed: String

    static func fingerprint(_ seed: String) -> UInt32 {
        seed.utf8.reduce(UInt32(2_166_136_261)) { ($0 ^ UInt32($1)) &* 16_777_619 }
    }

    private var tint: Color {
        let palette: [Color] = [Color(hex: 0x9B9AF4), Color(hex: 0x75B8E8), Color(hex: 0x72C7A7),
                                Color(hex: 0xE5AB68), Color(hex: 0xD590C2), Color(hex: 0x8DC8CF)]
        return palette[Int(Self.fingerprint(seed) % UInt32(palette.count))]
    }

    var body: some View {
        Canvas { context, size in
            let bits = Self.fingerprint(seed)
            let unit = size.width / 7
            for row in 0..<5 {
                for column in 0..<5 {
                    let mirrored = min(column, 4 - column)
                    if (bits >> (row * 3 + mirrored)) & 1 == 1 || (row == 2 && column == 2) {
                        let rect = CGRect(x: CGFloat(column + 1) * unit, y: CGFloat(row + 1) * unit,
                                          width: unit, height: unit)
                        context.fill(Path(rect), with: .color(tint))
                    }
                }
            }
        }
        .frame(width: 28, height: 28)
        .background(tint.opacity(0.12), in: RoundedRectangle(cornerRadius: 7))
        .accessibilityHidden(true)
    }
}

struct RelayChatSectionPicker: View {
    @Binding var selection: RelayChatSection
    let subagentCount: Int

    var body: some View {
        HStack(spacing: 4) {
            sectionButton("Chat", section: .chat)
            sectionButton(subagentCount == 0 ? "Subagents" : "Subagents (\(subagentCount))", section: .subagents)
        }
        .padding(4)
        .background(Color.black.opacity(0.16), in: RoundedRectangle(cornerRadius: 13))
        .padding(.horizontal, 16)
        .padding(.bottom, 8)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Conversation view")
        .accessibilityIdentifier("relay-chat-sections")
    }

    private func sectionButton(_ title: String, section: RelayChatSection) -> some View {
        let isSelected = selection == section
        return Button { selection = section } label: {
            Text(title)
                .font(AppTheme.uiFont(size: 16, weight: isSelected ? .semibold : .medium))
                .foregroundStyle(isSelected ? AppTheme.textPrimary : AppTheme.textSecondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 10)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(isSelected ? AppTheme.textPrimary.opacity(0.12) : .clear,
                            in: RoundedRectangle(cornerRadius: 9))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}

struct RelaySubagentsView: View {
    let subagents: [RelaySubagent]
    let isLoading: Bool
    let errorMessage: String?
    let onOpen: (RelaySubagent) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if let errorMessage {
                    RelayInlineNotice(text: errorMessage)
                        .padding(.bottom, 16)
                }
                if subagents.isEmpty {
                    if isLoading {
                        ProgressView("Loading subagents…")
                            .tint(AppTheme.accent)
                            .frame(maxWidth: .infinity, minHeight: 180)
                    } else if errorMessage == nil {
                        ContentUnavailableView {
                            Label("No subagents to show", systemImage: "person.2")
                        } description: {
                            Text("Subagent tasks reported by this chat will appear here.")
                        }
                        .padding(.top, 40)
                        .accessibilityIdentifier("relay-subagents-empty")
                    }
                } else {
                    ForEach(Array(subagents.enumerated()), id: \.element.id) { index, subagent in
                        Button { onOpen(subagent) } label: {
                            row(subagent)
                        }
                        .padding(.leading, CGFloat(min(subagent.depth, 4)) * 20)
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("relay-subagent-row")
                        if index + 1 < subagents.count, subagents[index + 1].depth == 0 {
                            Divider().overlay(AppTheme.textPrimary.opacity(0.08))
                        }
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .padding(.bottom, 24)
        }
        .scrollDismissesKeyboard(.interactively)
        .accessibilityIdentifier("relay-subagents")
    }

    private func row(_ subagent: RelaySubagent) -> some View {
        HStack(alignment: .top, spacing: 12) {
            if subagent.depth > 0 {
                Image(systemName: "arrow.turn.down.right")
                    .font(.caption)
                    .foregroundStyle(AppTheme.textSecondary)
                    .padding(.top, 8)
                    .accessibilityHidden(true)
            }
            RelayAgentAvatar(seed: subagent.step.subagentAvatarSeed)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 6) {
                Text(subagent.name)
                    .font(.body.weight(.medium))
                    .foregroundStyle(AppTheme.textPrimary)
                    .lineLimit(3)
                    .multilineTextAlignment(.leading)
                if subagent.name != subagent.step.displaySummary {
                    Text(subagent.step.displaySummary)
                        .font(.subheadline)
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if let parent = subagent.parentTitle, subagent.depth == 0 || subagent.depth > 4 {
                    Text("Within \(parent)")
                        .font(.caption)
                        .foregroundStyle(AppTheme.textSecondary)
                        .lineLimit(1)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { metadata(subagent) }
                    VStack(alignment: .leading, spacing: 4) { metadata(subagent) }
                }
                .font(.caption)
                .foregroundStyle(AppTheme.textSecondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            RelayRowChevron().padding(.top, 5)
        }
        .padding(.vertical, 16)
        .frame(minHeight: 72)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Level \(subagent.depth + 1). Opens the subagent conversation")
    }

    @ViewBuilder
    private func metadata(_ subagent: RelaySubagent) -> some View {
        if let status = subagent.statusLabel {
            Text(status)
                .foregroundStyle(status == "Failed" ? AppTheme.statusError : AppTheme.textSecondary)
        }
        if let type = (subagent.step.agent?.role ?? subagent.step.input.agentType)?.trimmedNonEmpty, type != subagent.name {
            Text(type).lineLimit(1)
        }
        let count = subagent.descendants.count
        if count > 0 {
            Text(count == 1 ? "1 step" : "\(count) steps")
        } else if subagent.statusLabel == nil, subagent.step.input.agentType?.trimmedNonEmpty == nil {
            Text("View task")
        }
    }
}

@MainActor
final class RelaySubagentChatModel: ObservableObject {
    @Published private(set) var messages: [RelayConversationItem] = []
    @Published private(set) var errorMessage: String?
    @Published private(set) var isLoading = true
    private let fetch: () async throws -> CodexThreadDetail
    private var isRefreshing = false

    init(fetch: @escaping () async throws -> CodexThreadDetail) { self.fetch = fetch }

    var subagents: [RelaySubagent] { RelaySubagent.collect(messages: messages, timelines: [:]) }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false; isLoading = false }
        do {
            let detail = try await fetch()
            guard !Task.isCancelled else { return }
            let next = RelayChatViewModel.conversationItems(from: detail, modelLabel: nil)
            if messages != next { messages = next }
            errorMessage = nil
        } catch {
            guard !Task.isCancelled else { return }
            errorMessage = "Couldn’t load this subagent’s conversation. It may not have synced to this machine yet."
        }
    }
}

/// A separate reader keeps the parent's draft, selection and scroll intact.
/// It reads the provider's own child transcript and never starts another job.
struct RelaySubagentChatView: View {
    let agent: RelaySubagent
    let parentSessionID: String
    let client: CodexClient
    @ObservedObject var parentModel: RelayChatViewModel
    @ObservedObject var powerModel: RelayMachinePowerModel
    var onClose: (() -> Void)?
    @StateObject private var model: RelaySubagentChatModel
    @StateObject private var scroller = RelayTranscriptScroller()
    @Environment(\.scenePhase) private var scenePhase
    @State private var activityRequest: RelayActivityRequest?
    @State private var attachmentRequest: RelayDisplayedAttachment?
    @State private var nestedAgent: RelaySubagent?
    @State private var showsRecordedActivity = false

    init(agent: RelaySubagent, parentSessionID: String, client: CodexClient,
         parentModel: RelayChatViewModel, powerModel: RelayMachinePowerModel, onClose: (() -> Void)? = nil) {
        self.agent = agent
        self.parentSessionID = parentSessionID
        self.client = client
        self.parentModel = parentModel
        self.powerModel = powerModel
        self.onClose = onClose
        _model = StateObject(wrappedValue: RelaySubagentChatModel {
            try await client.fetchSubagentDetail(parentSessionID: parentSessionID,
                agentID: agent.step.agent?.id ?? "", provider: agent.provider ?? .codex)
        })
    }

    private var currentAgent: RelaySubagent {
        parentModel.subagents.first { $0.id == agent.id } ?? agent
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 24) {
                    if let error = model.errorMessage {
                        VStack(alignment: .leading, spacing: 12) {
                            RelayInlineNotice(text: error)
                            HStack(spacing: 24) {
                                Button("Retry") { Task { await model.refresh() } }
                                if onClose != nil {
                                    Button("View recorded activity") { showsRecordedActivity = true }
                                }
                            }
                            .font(.subheadline)
                        }
                    }
                    if model.isLoading {
                        ProgressView("Loading conversation…").frame(maxWidth: .infinity, minHeight: 180)
                    } else if model.messages.isEmpty && model.errorMessage == nil {
                        ContentUnavailableView("No messages yet", systemImage: "bubble.left.and.bubble.right",
                            description: Text("This subagent’s conversation will appear here as it works."))
                    }
                    ForEach(model.messages) { item in
                        RelayChatBubble(item: item, client: client, showsByline: false, showsActions: false,
                            onOpenAttachment: { attachmentRequest = $0 },
                            onOpenActivity: { activityRequest = .init(source: .message(item.id), root: .block($0)) },
                            onOpenStep: { id in
                                if let child = model.subagents.first(where: { $0.step.id == id }), child.step.agent?.id != nil {
                                    nestedAgent = child
                                } else {
                                    activityRequest = .init(source: .message(item.id), root: .step(id))
                                }
                            })
                    }
                    if !model.subagents.isEmpty {
                        VStack(alignment: .leading, spacing: 16) {
                            Text("Subagents").font(.subheadline).foregroundStyle(AppTheme.textSecondary)
                            ForEach(model.subagents) { child in
                                Button {
                                    if child.step.agent?.id != nil { nestedAgent = child }
                                    else { activityRequest = child.request }
                                } label: {
                                    HStack(spacing: 12) {
                                        RelayAgentAvatar(seed: child.step.subagentAvatarSeed)
                                        Text(child.name).foregroundStyle(AppTheme.textPrimary)
                                        Spacer()
                                        if let status = child.statusLabel { Text(status).font(.caption) }
                                        RelayRowChevron()
                                    }
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .padding(.leading, CGFloat(min(child.depth, 4)) * 20)
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id("child-bottom")
                }
                .padding(20)
                .background(RelayScrollViewFinder(scroller: scroller))
            }
            .onAppear {
                scroller.fallbackScroll = { _ in proxy.scrollTo("child-bottom", anchor: .bottom) }
                scroller.land()
            }
            .overlay(alignment: .bottomTrailing) {
                if !scroller.isAtBottom {
                    RelayJumpToLatestButton { scroller.jumpToLatest() }.padding(16)
                }
            }
        }
        .background(AppTheme.bgCanvas)
        .toolbarBackground(AppTheme.bgCanvas, for: .navigationBar)
        .toolbarBackground(.visible, for: .navigationBar)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                HStack(spacing: 10) {
                    RelayAgentAvatar(seed: agent.step.subagentAvatarSeed)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(currentAgent.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        if let status = currentAgent.statusLabel {
                            Text(status).font(.caption).foregroundStyle(AppTheme.textSecondary)
                        }
                    }
                }
            }
            if let onClose {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: onClose) { Image(systemName: "chevron.left") }
                        .accessibilityLabel("Back to subagents")
                }
            }
        }
        .task(id: scenePhase) {
            guard scenePhase == .active else { return }
            while !Task.isCancelled {
                if !powerModel.isDown { await model.refresh() }
                do { try await Task.sleep(for: .seconds(currentAgent.isWorking ? 3 : 8)) }
                catch { return }
            }
        }
        .sheet(item: $activityRequest) { request in
            if case .message(let id) = request.source {
                RelayActivitySheet(request: request, viewModel: parentModel,
                    timelineOverride: model.messages.first { $0.id == id }?.historyTimeline ?? RelayTimeline())
            }
        }
        .sheet(isPresented: $showsRecordedActivity) {
            RelayActivitySheet(request: agent.request, viewModel: parentModel)
        }
        .fullScreenCover(item: $attachmentRequest) { attachment in
            RelayAttachmentViewer(attachment: attachment, client: client)
        }
        .navigationDestination(item: $nestedAgent) { child in
            RelaySubagentChatView(agent: child, parentSessionID: parentSessionID, client: client,
                parentModel: parentModel, powerModel: powerModel)
        }
        .accessibilityIdentifier("relay-subagent-conversation")
    }
}
