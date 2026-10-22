import SwiftUI

struct RelayWatchHome: View {
    @EnvironmentObject private var store: RelayWatchStore

    var body: some View {
        NavigationStack {
            List {
                if let snapshot = store.snapshot {
                    if let machine = snapshot.machine {
                        RelayWatchPowerControl(sourceID: snapshot.sourceID, machine: machine)
                    }
                    RelayWatchFeedback()
                    NavigationLink {
                        RelayWatchComposer(sourceID: snapshot.sourceID)
                    } label: {
                        Label("New chat", systemImage: "square.and.pencil")
                            .font(.headline)
                            .frame(minHeight: 44)
                    }
                    .disabled(snapshot.models.isEmpty || snapshot.folders.isEmpty
                              || snapshot.machine?.blocksRuns == true || store.pendingCommand != nil)
                    .accessibilityIdentifier("watch-new-chat")

                    if !snapshot.approvals.isEmpty {
                        Section("Needs you") {
                            ForEach(snapshot.approvals) { approval in
                                NavigationLink {
                                    RelayWatchApprovalView(sourceID: snapshot.sourceID, approval: approval)
                                } label: { Label(approval.title, systemImage: "hand.raised").lineLimit(2) }
                            }
                        }
                    }
                    Section("Recent chats") {
                        ForEach(snapshot.threads) { thread in
                            NavigationLink {
                                RelayWatchThreadView(sourceID: snapshot.sourceID, initialThread: thread)
                            } label: {
                                VStack(alignment: .leading, spacing: 5) {
                                    Text(thread.title).font(.body.weight(.medium)).lineLimit(2)
                                    if snapshot.activityNotice == nil {
                                        Label(thread.status, systemImage: thread.isActive ? "hourglass" : "bubble.left")
                                            .font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                .padding(.vertical, 4)
                            }
                        }
                        if let notice = snapshot.activityNotice {
                            Text(notice).font(.footnote).foregroundStyle(.secondary)
                        } else if snapshot.threads.isEmpty {
                            Text("Start a chat here or on iPhone.").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    if snapshot.machine?.blocksRuns != true, snapshot.activityNotice == nil,
                       snapshot.models.isEmpty || snapshot.folders.isEmpty {
                        Text("Choose an agent and a project in Relay on iPhone first.").font(.footnote)
                    }
                } else {
                    Label("Connect with iPhone", systemImage: "iphone")
                        .font(.headline)
                    Text("Open Relay on your paired iPhone to see your machine and chats.")
                        .font(.footnote).foregroundStyle(.secondary)
                    RelayWatchFeedback()
                }
                Section {
                    Button { Task { await store.refresh() } } label: {
                        Label(store.isBusy ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                            .frame(minHeight: 44)
                    }.disabled(store.isBusy)
                } footer: {
                    if let snapshot = store.snapshot {
                        Text("Updated \(snapshot.updatedAt, style: .relative) ago")
                    }
                }
            }
            .navigationTitle("Relay")
        }
        .id(store.snapshot?.sourceID ?? "unpaired")
    }
}

struct RelayWatchPowerControl: View {
    @EnvironmentObject private var store: RelayWatchStore
    let sourceID: String
    let machine: RelayWatchMachine
    @State private var confirmsStop = false

    private var canAct: Bool {
        (machine.canStart || machine.canStop) && !store.isBusy
            && store.pendingCommand == nil && store.snapshot?.sourceID == sourceID
    }

    private var isPowered: Bool { machine.state == .on || machine.state == .starting }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(machine.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                HStack(spacing: 6) {
                    if machine.state.isTransitioning {
                        ProgressView().controlSize(.small).frame(width: 14, height: 14)
                    }
                    Text(machine.state.label).font(.body.weight(.medium))
                        .lineLimit(1).minimumScaleFactor(0.8)
                }
            }
            Spacer(minLength: 0)
            // Like the iPhone switch, display confirmed state while a tap requests a change.
            Toggle("Machine power", isOn: .constant(isPowered))
                .toggleStyle(.switch)
                .labelsHidden()
                .allowsHitTesting(false)
                .disabled(!canAct)
        }
        .frame(minHeight: 52)
        .contentShape(Rectangle())
        .overlay {
            Button(action: requestToggle) { Color.clear.contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .disabled(!canAct)
        }
        .accessibilityRepresentation {
            Toggle(machine.name, isOn: Binding(get: { isPowered }, set: { _ in requestToggle() }))
                .accessibilityValue(machine.state.label)
                .disabled(!canAct)
        }
        .accessibilityIdentifier("watch-machine-power")
        .confirmationDialog("Turn off \(machine.name)?", isPresented: $confirmsStop, titleVisibility: .visible) {
            Button("Turn off machine", role: .destructive) { changePower(.powerOff) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Running work will be interrupted.")
        }
    }

    private func requestToggle() {
        guard canAct else { return }
        if machine.canStop { confirmsStop = true }
        else { changePower(.powerOn) }
    }

    private func changePower(_ kind: RelayWatchCommand.Kind) {
        Task {
            if await store.perform(RelayWatchCommand(kind: kind, sourceID: sourceID)) {
                await store.refresh()
            }
        }
    }
}

struct RelayWatchComposer: View {
    @EnvironmentObject private var store: RelayWatchStore
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var dictation = RelayWatchDictation()
    @State private var dictationPrefix = ""
    @State private var restored = false
    let sourceID: String
    var thread: RelayWatchThread?
    @State private var prompt = ""
    @State private var folderID = ""
    @State private var modelID = ""
    @State private var effort = ""
    @State private var showsOptions = false

    private var models: [RelayWatchModel] {
        (store.snapshot?.models ?? []).filter { thread == nil || $0.provider == thread?.provider }
    }
    private var model: RelayWatchModel? { models.first { $0.id == modelID } }
    private var draftKey: String { "relay.watch.draft.\(sourceID).\(thread?.sessionID ?? "new")" }
    private var canSend: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && model != nil
            && !folderID.isEmpty && !store.isBusy && store.pendingCommand == nil
            && store.snapshot?.sourceID == sourceID && store.snapshot?.machine?.blocksRuns != true && !dictation.isActive
    }

    var body: some View {
        Form {
            Section("Prompt") {
                if dictation.isActive {
                    if dictation.phase == .recording {
                        Text("Listening · \(dictation.elapsedSeconds / 60):\(String(format: "%02d", dictation.elapsedSeconds % 60)) / 1:00")
                            .font(.caption).monospacedDigit()
                        ProgressView(value: dictation.level).accessibilityLabel("Microphone level")
                        Button { dictation.stop() } label: { Label("Stop", systemImage: "stop.fill") }
                    } else { ProgressView(dictation.phase == .connecting ? "Connecting…" : "Finishing…") }
                    Button("Cancel", role: .cancel) { prompt = dictationPrefix; dictation.cancel() }
                } else {
                    Button {
                        dictationPrefix = prompt
                        Task { await dictation.start(store: store, sourceID: sourceID) }
                    } label: { Label(prompt.isEmpty ? "Dictate" : "Add dictation", systemImage: "mic.fill") }
                        .disabled(store.pendingCommand != nil || store.snapshot?.sourceID != sourceID)
                    TextField(prompt.isEmpty ? "Type instead" : "Edit transcript", text: $prompt)
                }
                if !prompt.isEmpty { Text(prompt).font(.body) }
                if let error = dictation.errorMessage { Text(error).font(.footnote).foregroundStyle(.orange) }
                Text("Review your words before sending.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !dictation.isActive {
                if let folder = store.snapshot?.folders.first(where: { $0.id == folderID }) {
                    Text(folder.name).font(.footnote).foregroundStyle(.secondary)
                }
                if let model { Text(model.label).font(.caption2).foregroundStyle(.secondary) }
                Section {
                    Button { showsOptions.toggle() } label: {
                        HStack {
                            Text("Options")
                            Spacer()
                            Image(systemName: showsOptions ? "chevron.up" : "chevron.down")
                                .font(.caption)
                        }
                        .frame(minHeight: 44)
                    }
                    .accessibilityValue(showsOptions ? "Expanded" : "Collapsed")
                    if showsOptions {
                        if thread == nil {
                            Picker("Folder", selection: $folderID) {
                                Text("Choose folder").tag("")
                                ForEach(store.snapshot?.folders ?? []) { Text($0.name).tag($0.id) }
                            }
                        } else {
                            Text(store.snapshot?.folders.first(where: { $0.id == folderID })?.name ?? "Thread folder")
                        }
                        Picker("Model", selection: $modelID) {
                            Text("Choose model").tag("")
                            ForEach(models) { Text($0.label).tag($0.id) }
                        }
                        if let model, !model.efforts.isEmpty {
                            Picker("Effort", selection: $effort) {
                                Text("Model default").tag("")
                                ForEach(model.efforts, id: \.self) { Text($0.capitalized).tag($0) }
                            }
                        }
                    }
                }
            }
            Button {
                var command = RelayWatchCommand(kind: .send, sourceID: sourceID)
                command.prompt = prompt
                command.workspaceID = folderID
                command.modelID = modelID
                command.effort = effort.isEmpty ? nil : effort
                command.sessionID = thread?.sessionID
                Task {
                    if await store.perform(command) {
                        UserDefaults.standard.removeObject(forKey: draftKey)
                        dismiss()
                        await store.refresh()
                    }
                }
            } label: { Label("Send", systemImage: "arrow.up").frame(minHeight: 44) }
            .disabled(!canSend)
            RelayWatchFeedback()
        }
        .navigationTitle(thread == nil ? "New chat" : "Reply")
        .onAppear {
            store.isComposing = true
            guard !restored else { return }
            restored = true
            prompt = UserDefaults.standard.string(forKey: draftKey) ?? ""
            folderID = thread?.workspaceID ?? UserDefaults.standard.string(forKey: "relay.watch.folder.\(sourceID)") ?? ""
            let remembered = UserDefaults.standard.string(forKey: "relay.watch.model.\(sourceID)")
            modelID = models.first(where: { $0.id == remembered })?.id ?? models.first?.id ?? ""
            if !(store.snapshot?.folders.contains(where: { $0.id == folderID }) ?? false) {
                folderID = store.snapshot?.folders.count == 1 ? store.snapshot?.folders.first?.id ?? "" : ""
            }
            showsOptions = folderID.isEmpty
        }
        .onDisappear { dictation.cancel(discard: false); store.isComposing = false }
        .onChange(of: dictation.transcript) { text in
            guard !text.isEmpty else { return }
            prompt = dictationPrefix.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : dictationPrefix + " " + text
        }
        .onChange(of: scenePhase) { phase in
            if phase != .active, dictation.phase == .recording { dictation.stop() }
            if phase == .background, dictation.phase == .connecting { dictation.cancel(discard: false) }
        }
        .onChange(of: store.snapshot?.sourceID) { current in
            if current != sourceID { dictation.cancel(discard: false) }
        }
        .onChange(of: prompt) { UserDefaults.standard.set($0, forKey: draftKey) }
        .onChange(of: folderID) { UserDefaults.standard.set($0, forKey: "relay.watch.folder.\(sourceID)") }
        .onChange(of: modelID) {
            UserDefaults.standard.set($0, forKey: "relay.watch.model.\(sourceID)")
            effort = ""
        }
        .onChange(of: store.lastSentCommand) { command in
            if command?.draftKey == draftKey { dismiss() }
        }
    }
}

struct RelayWatchThreadView: View {
    @EnvironmentObject private var store: RelayWatchStore
    let sourceID: String
    let initialThread: RelayWatchThread
    @State private var confirmCancel = false

    private var thread: RelayWatchThread {
        store.snapshot?.threads.first {
            $0.id == initialThread.id || (initialThread.jobID != nil && $0.jobID == initialThread.jobID)
        } ?? initialThread
    }
    private var sameMachine: Bool { store.snapshot?.sourceID == sourceID }

    var body: some View {
        List {
            Text(thread.title).font(.headline)
            if let notice = store.snapshot?.activityNotice {
                Text(notice).font(.footnote).foregroundStyle(.secondary)
            } else {
                Label(thread.status, systemImage: thread.isActive ? "hourglass" : "bubble.left")
            }
            if let progress = thread.progress { Text(progress).font(.footnote).foregroundStyle(.secondary) }
            Section("Latest reply") {
                Text(thread.excerpt.isEmpty ? (thread.isActive ? "Working on your request." : "Open Relay on iPhone for this conversation.") : thread.excerpt)
                    .font(.body)
                Text("Long replies are shortened. Full conversation on iPhone.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            ForEach((store.snapshot?.approvals ?? []).filter { $0.jobID == thread.jobID }) { approval in
                NavigationLink("Needs your approval") {
                    RelayWatchApprovalView(sourceID: sourceID, approval: approval)
                }
            }
            if !thread.isActive, thread.sessionID != nil, thread.workspaceID != nil {
                NavigationLink {
                    RelayWatchComposer(sourceID: sourceID, thread: thread)
                } label: { Label("Reply", systemImage: "mic") }
                .disabled(!sameMachine || store.pendingCommand != nil || store.snapshot?.machine?.blocksRuns == true)
            }
            if thread.isActive, thread.jobID != nil {
                Button("Stop run", role: .destructive) { confirmCancel = true }
                    .disabled(store.isBusy || !sameMachine || store.pendingCommand != nil || store.snapshot?.machine?.blocksRuns == true)
            }
            RelayWatchFeedback()
        }
        .navigationTitle("Thread")
        .onAppear { store.watchedJobID = thread.jobID; Task { await store.refresh() } }
        .onDisappear { store.watchedJobID = nil }
        .confirmationDialog("Stop this run?", isPresented: $confirmCancel, titleVisibility: .visible) {
            Button("Stop run", role: .destructive) {
                var command = RelayWatchCommand(kind: .cancel, sourceID: sourceID)
                command.jobID = thread.jobID
                Task { if await store.perform(command) { await store.refresh() } }
            }
        }
    }
}

struct RelayWatchApprovalView: View {
    @EnvironmentObject private var store: RelayWatchStore
    @Environment(\.dismiss) private var dismiss
    let sourceID: String
    let approval: RelayWatchApproval
    @State private var confirmApproval = false

    private var stillPending: Bool {
        store.snapshot?.sourceID == sourceID && store.snapshot?.approvals.contains(approval) == true
    }

    var body: some View {
        List {
            Text(approval.title).font(.headline)
            Text(approval.detail).font(.footnote)
            if approval.requiresPhone {
                Text("This request is too long to review here. Open Relay on iPhone.")
            } else if stillPending {
                if approval.decisions.contains("accept") {
                    Button("Approve once") { confirmApproval = true }
                        .disabled(store.isBusy || store.pendingCommand != nil)
                }
                if approval.decisions.contains("decline") {
                    Button("Deny", role: .destructive) { decide("decline") }
                        .disabled(store.isBusy || store.pendingCommand != nil)
                }
            } else { Text("This request has changed. Refresh Relay.") }
            RelayWatchFeedback()
        }
        .navigationTitle("Needs you")
        .confirmationDialog("Allow this request once?", isPresented: $confirmApproval, titleVisibility: .visible) {
            Button("Approve once") { decide("accept") }
        }
    }

    private func decide(_ decision: String) {
        var command = RelayWatchCommand(kind: .decide, sourceID: sourceID)
        command.approvalID = approval.id
        command.jobID = approval.jobID
        command.decision = decision
        Task {
            if await store.perform(command) { dismiss(); await store.refresh() }
        }
    }
}

struct RelayWatchFeedback: View {
    @EnvironmentObject private var store: RelayWatchStore
    @State private var confirmCheckedPhone = false

    var body: some View {
        if let error = store.errorMessage { Text(error).font(.footnote).foregroundStyle(.orange) }
        if let notice = store.notice { Text(notice).font(.footnote) }
        if store.pendingCommand != nil {
            Button("Check delivery") { Task { await store.checkDelivery() } }.disabled(store.isBusy)
            Button("I checked on iPhone") { confirmCheckedPhone = true }
                .disabled(store.isBusy)
                .confirmationDialog("Only clear this after checking whether the action ran on iPhone.", isPresented: $confirmCheckedPhone, titleVisibility: .visible) {
                    Button("Clear delivery warning") { store.acknowledgeUnconfirmedDelivery() }
                }
        }
    }
}
