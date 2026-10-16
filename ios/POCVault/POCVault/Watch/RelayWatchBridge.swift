import Combine
import CryptoKit
import Foundation
import WatchConnectivity
import UIKit

/// Owns the phone side for the entire app lifetime, including launches caused
/// by a message from the watch. All API calls use the existing pinned/mTLS client.
@MainActor
final class RelayWatchBridge: NSObject, WCSessionDelegate {
    private let client: CodexClient
    private let nodes: RelayNodeStore
    private var nodeObservation: AnyCancellable?
    private var mutationInFlight = false
    private var receipts: [String: Receipt] = [:]
    private var watchedTimeline: (source: String, jobID: String, timeline: RelayTimeline)?
    private var lastPublishedSnapshot: RelayWatchSnapshot?
    private let dictation = RelayWatchDictationBridge()
    private let receiptURL: URL

    private struct Receipt: Codable {
        let fingerprint: String
        let date: Date
        let reply: RelayWatchReply
    }

    init(client: CodexClient, nodes: RelayNodeStore) {
        self.client = client
        self.nodes = nodes
        receiptURL = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("relay-watch-receipts.json")
        if let data = try? Data(contentsOf: receiptURL),
           let saved = try? JSONDecoder().decode([String: Receipt].self, from: data) {
            receipts = saved
        }
        super.init()
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        nodeObservation = nodes.$pairedNode.dropFirst().sink { [weak self] _ in
            // Clear display data on unpair/re-pair, even when the host is the same.
            self?.lastPublishedSnapshot = nil
            self?.dictation.cancel(reason: "Your iPhone connection changed. Record again after refreshing.")
            let session = WCSession.default
            if session.activationState == .activated, session.isWatchAppInstalled {
                try? session.updateApplicationContext(["relay.watch.reset": true])
            }
        }
    }

    private var sourceID: String {
        let identity = nodes.effectiveBaseURL.absoluteString + "|" + (nodes.pairedNode?.deviceID ?? "personal")
        return Self.digest(Data(identity.utf8))
    }

    private static func digest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func fingerprint(_ command: RelayWatchCommand) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return digest(try encoder.encode(command))
    }

    private func requireMachine(_ expectedID: String? = nil) throws {
        guard nodes.hasMachine, nodes.pendingVerificationCode == nil else {
            throw RelayWatchError("Finish connecting your machine in Relay on iPhone.")
        }
        guard client.baseURL == nodes.effectiveBaseURL, expectedID == nil || expectedID == sourceID else {
            throw RelayWatchError("The linked machine changed. Refresh before sending.")
        }
    }

    private func loadSnapshot(watchedJobID: String? = nil) async throws -> (RelayWatchSnapshot, [CodexModelDescriptor]) {
        try requireMachine()
        let source = sourceID
        async let models = client.fetchModels()
        async let folders = client.fetchCodexWorkspaces()
        async let threads = client.fetchThreads(limit: 30, budget: .listPoll)
        async let jobs = client.fetchJobs(limit: 30, budget: .listPoll)
        async let approvals = client.fetchPendingApprovalsIfSupported(budget: .listPoll)
        let values = try await (models, folders, threads, jobs, approvals)
        try requireMachine(source)
        var snapshot = RelayWatchProjection.snapshot(
            sourceID: source, models: values.0, folders: values.1,
            threads: values.2, jobs: values.3, approvals: values.4
        )
        if let watchedJobID, let index = snapshot.threads.firstIndex(where: { $0.jobID == watchedJobID }),
           values.3.contains(where: { $0.id == watchedJobID && ($0.timelineEvents ?? 0) > 0 }) {
            var timeline = watchedTimeline.flatMap { $0.source == source && $0.jobID == watchedJobID ? $0.timeline : nil } ?? RelayTimeline()
            if let page = try? await client.fetchTimeline(jobID: watchedJobID, since: timeline.cursor) {
                for event in page.events { timeline.apply(event) }
                watchedTimeline = (source, watchedJobID, timeline)
                RelayWatchProjection.update(&snapshot.threads[index], from: timeline)
            }
        }
        try requireMachine(source)
        return (snapshot, values.0)
    }

    private func publish(_ snapshot: RelayWatchSnapshot) {
        let session = WCSession.default
        guard session.activationState == .activated, session.isWatchAppInstalled,
              snapshot.sourceID == sourceID else { return }
        if let lastPublishedSnapshot, snapshot.hasSameContent(as: lastPublishedSnapshot) { return }
        do {
            try session.updateApplicationContext(RelayWatchWire.encode(snapshot))
            lastPublishedSnapshot = snapshot
        } catch { /* The immediate reply still carries the fresh snapshot. */ }
    }

    private func saveReceipt(_ command: RelayWatchCommand, reply: RelayWatchReply) throws {
        let fingerprint = try Self.fingerprint(command)
        receipts[command.id] = Receipt(fingerprint: fingerprint, date: Date(), reply: reply)
        // Keep unresolved commands; they must never turn into automatic retries.
        let completed = receipts.filter { $0.value.reply.outcome != .uncertain }
            .sorted { $0.value.date > $1.value.date }
        for entry in completed.dropFirst(256) { receipts.removeValue(forKey: entry.key) }
        try FileManager.default.createDirectory(at: receiptURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(receipts).write(to: receiptURL, options: .atomic)
    }

    private func handle(_ command: RelayWatchCommand) async -> RelayWatchReply {
        guard command.version == RelayWatchWire.version else {
            return RelayWatchReply(outcome: .rejected, error: "Update Relay on both devices.")
        }
        if command.kind == .delivery {
            // A receipt lookup can NEVER start a run, including when the
            // original message was lost before this phone received it.
            return command.originalRequestID.flatMap { receipts[$0]?.reply }
                ?? RelayWatchReply(outcome: .uncertain, error: "No delivery receipt yet. Check Threads on iPhone before clearing this warning.")
        }
        if let receipt = receipts[command.id] {
            guard (try? Self.fingerprint(command)) == receipt.fingerprint else {
                return RelayWatchReply(outcome: .rejected, error: "This request identifier has already been used.")
            }
            return receipt.reply
        }
        guard !mutationInFlight || !command.isMutation else {
            return RelayWatchReply(outcome: .rejected, error: "Another watch action is in progress. Refresh shortly.")
        }
        if command.isMutation { mutationInFlight = true }
        defer { if command.isMutation { mutationInFlight = false } }
        var sentToServer = false
        do {
            let (snapshot, models) = try await loadSnapshot(watchedJobID: command.isMutation ? nil : command.jobID)
            if !command.isMutation {
                publish(snapshot)
                return RelayWatchReply(snapshot: snapshot)
            }
            try command.validate(against: snapshot)
            if command.kind == .send {
                guard let model = models.first(where: { $0.id == command.modelID }),
                      RelayAIDataConsentStore.hasConsent(for: model.provider) else {
                    throw RelayWatchError("Start a conversation with this provider on iPhone first to review data sharing.")
                }
            }
            // Recheck after every read and immediately before the write. No
            // suspension occurs between this check and starting the API request.
            try requireMachine(command.sourceID)
            let requestBaseURL = client.baseURL
            let uncertain = RelayWatchReply(outcome: .uncertain, error: "Delivery is unconfirmed. Check Threads on iPhone before sending again.")
            try saveReceipt(command, reply: uncertain)
            sentToServer = true
            var reply = RelayWatchReply()
            switch command.kind {
            case .refresh, .delivery: break
            case .send:
                guard let model = models.first(where: { $0.id == command.modelID }), let folder = command.workspaceID else {
                    throw RelayWatchError("Refresh your model and folder choices.")
                }
                let created = try await client.createJob(CodexCreateJobRequest(
                    workspaceId: folder, prompt: (command.prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
                    timeoutMs: nil, model: RelayChatViewModel.taskModelParameter(for: model),
                    reasoningEffort: command.effort, provider: model.provider,
                    permissionMode: model.provider == .claude ? "manual" : nil,
                    approvalPolicy: model.provider == .codex ? "on-request" : nil,
                    sandbox: model.provider == .codex ? "workspace-write" : nil,
                    resumeSessionId: command.sessionID
                ), expectedBaseURL: requestBaseURL)
                reply.jobID = created.id
            case .decide:
                guard let id = command.approvalID, let raw = command.decision,
                      let decision = CodexApprovalDecision(rawValue: raw) else {
                    throw RelayWatchError("Review this request on iPhone.")
                }
                _ = try await client.decideApproval(id: id, decision: decision, expectedBaseURL: requestBaseURL)
            case .cancel:
                guard let id = command.jobID else { throw RelayWatchError("Choose a run first.") }
                _ = try await client.cancelJob(id: id, expectedBaseURL: requestBaseURL)
            }
            // Persist the receipt BEFORE attempting another read. A failed
            // refresh must never turn an accepted send into a second job.
            try saveReceipt(command, reply: reply)
            return reply
        } catch {
            return RelayWatchReply(
                outcome: sentToServer ? .uncertain : .rejected,
                error: sentToServer
                    ? "Delivery is unconfirmed. Check Threads on iPhone before sending again."
                    : error.localizedDescription
            )
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        Task { @MainActor in
            if message[RelayWatchDictationWire.key] != nil {
                var sessionID = ""
                let reply: RelayWatchDictationReply
                do {
                    let request = try RelayWatchDictationWire.decode(RelayWatchDictationRequest.self, from: message)
                    sessionID = request.sessionID
                    try self.requireMachine(request.sourceID)
                    reply = await self.dictation.handle(request)
                } catch {
                    reply = RelayWatchDictationReply(sessionID: sessionID, finished: true, error: error.localizedDescription)
                }
                replyHandler((try? RelayWatchDictationWire.encode(reply)) ?? [:])
                return
            }
            let reply: RelayWatchReply
            do {
                reply = await handle(try RelayWatchWire.decode(RelayWatchCommand.self, from: message))
            } catch {
                reply = RelayWatchReply(outcome: .rejected, error: "Update Relay on both devices.")
            }
            do { replyHandler(try RelayWatchWire.encode(reply)) }
            catch { replyHandler((try? RelayWatchWire.encode(RelayWatchReply(outcome: .rejected, error: error.localizedDescription))) ?? [:]) }
        }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        Task { @MainActor in
            self.lastPublishedSnapshot = nil
            self.dictation.cancel(reason: "Your watch connection changed. Please record again.")
            session.activate()
        }
    }
}

@MainActor
protocol RelayWatchTranscribing: AnyObject {
    var transcript: String { get }
    func startExternalAudio() throws
    func appendExternalAudio(_ data: Data) async throws
    func finishExternalAudio() async throws -> String
    func cancel()
}

extension RelayStreamingTranscriber: RelayWatchTranscribing {}

/// One short, foreground-initiated dictation. iOS background time is finite;
/// expiration closes the socket and returns partial text on the next request.
@MainActor
final class RelayWatchDictationBridge {
    private let transcriber: any RelayWatchTranscribing
    private let managesBackgroundTime: Bool
    private var sessionID: String?
    private var sourceID: String?
    private var startedAt: Date?
    private var ledger = RelayWatchAudioLedger()
    private var operationID: UUID?
    private var deadline: Task<Void, Never>?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid
    private var closedReply: RelayWatchDictationReply?
    private var closedSourceID: String?

    init(transcriber: (any RelayWatchTranscribing)? = nil, managesBackgroundTime: Bool = true) {
        self.transcriber = transcriber ?? RelayStreamingTranscriber()
        self.managesBackgroundTime = managesBackgroundTime
    }

    func handle(_ request: RelayWatchDictationRequest) async -> RelayWatchDictationReply {
        guard request.version == 1, UUID(uuidString: request.sessionID) != nil, !request.sourceID.isEmpty else {
            return RelayWatchDictationReply(sessionID: request.sessionID, finished: true, error: "Update Relay on both devices.")
        }
        if let closedReply, closedReply.sessionID == request.sessionID {
            return endedReply(for: request)
        }
        if request.kind == .cancel {
            if sessionID == request.sessionID, sourceID == request.sourceID { cancel(reason: nil) }
            return RelayWatchDictationReply(sessionID: request.sessionID, finished: true)
        }
        if request.kind == .begin {
            if sessionID == request.sessionID, sourceID == request.sourceID { return currentReply() }
            guard sessionID == nil else {
                return RelayWatchDictationReply(sessionID: request.sessionID, finished: true, error: "Another dictation is finishing. Try again shortly.")
            }
            do {
                try transcriber.startExternalAudio()
                sessionID = request.sessionID
                sourceID = request.sourceID
                startedAt = Date()
                ledger = RelayWatchAudioLedger()
                closedReply = nil
                closedSourceID = nil
                if managesBackgroundTime {
                    backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "Relay watch dictation") { [weak self] in
                        Task { @MainActor in
                            self?.cancel(reason: "iPhone paused dictation. Open Relay on iPhone and review your text.")
                        }
                    }
                }
                renewDeadline()
                return currentReply()
            } catch {
                transcriber.cancel()
                return RelayWatchDictationReply(sessionID: request.sessionID, finished: true, error: error.localizedDescription)
            }
        }
        guard sessionID == request.sessionID, sourceID == request.sourceID else {
            return RelayWatchDictationReply(sessionID: request.sessionID, finished: true, error: "Dictation ended. Please record again.")
        }
        guard operationID == nil else {
            return RelayWatchDictationReply(sessionID: request.sessionID, finished: true, error: "Dictation is still processing a batch.")
        }
        let operation = UUID()
        operationID = operation
        defer { if operationID == operation { operationID = nil } }
        do {
            guard let startedAt, Date().timeIntervalSince(startedAt) < 70 else {
                throw RelayWatchError("Dictation reached its time limit. Review your text.")
            }
            renewDeadline()
            switch request.kind {
            case .audio:
                guard let audio = request.audio else { throw RelayWatchError("Missing audio batch.") }
                try ledger.accept(audio, sequence: request.sequence)
                try await transcriber.appendExternalAudio(audio)
            case .finish:
                guard request.sequence == ledger.nextSequence else { throw RelayWatchError("Some audio did not arrive. Review your text.") }
                _ = try await transcriber.finishExternalAudio()
            case .begin, .cancel: break
            }
            guard sessionID == request.sessionID else {
                return endedReply(for: request)
            }
            if request.kind == .finish {
                let reply = currentReply(finished: true)
                close(reply)
                return reply
            }
            return currentReply()
        } catch {
            guard sessionID == request.sessionID else {
                return endedReply(for: request)
            }
            let reply = currentReply(finished: true, error: error.localizedDescription)
            close(reply)
            return reply
        }
    }

    func cancel(reason: String?) {
        guard sessionID != nil else { return }
        close(currentReply(finished: true, error: reason))
    }

    private func currentReply(finished: Bool = false, error: String? = nil) -> RelayWatchDictationReply {
        RelayWatchDictationReply(sessionID: sessionID ?? "", nextSequence: ledger.nextSequence,
            transcript: String(transcriber.transcript.prefix(8_000)), finished: finished, error: error)
    }

    private func endedReply(for request: RelayWatchDictationRequest) -> RelayWatchDictationReply {
        if let closedReply, closedReply.sessionID == request.sessionID, closedSourceID == request.sourceID {
            return closedReply
        }
        return RelayWatchDictationReply(sessionID: request.sessionID, finished: true, error: "Dictation ended. Please record again.")
    }

    private func renewDeadline() {
        deadline?.cancel()
        let id = sessionID
        deadline = Task { @MainActor [weak self] in
            do { try await Task.sleep(nanoseconds: 12_000_000_000) }
            catch { return }
            guard self?.sessionID == id else { return }
            self?.cancel(reason: "Dictation disconnected. Review the words received so far.")
        }
    }

    private func close(_ reply: RelayWatchDictationReply) {
        closedReply = reply
        closedSourceID = sourceID
        sessionID = nil
        sourceID = nil
        operationID = nil
        startedAt = nil
        deadline?.cancel()
        deadline = nil
        transcriber.cancel()
        if backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
}
