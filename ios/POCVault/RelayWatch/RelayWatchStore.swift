import Foundation
import SwiftUI
import WatchConnectivity
import WatchKit

@MainActor
final class RelayWatchStore: NSObject, ObservableObject, WCSessionDelegate {
    @Published private(set) var snapshot: RelayWatchSnapshot?
    @Published private(set) var isBusy = false
    @Published private(set) var errorMessage: String?
    @Published private(set) var notice: String?
    @Published private(set) var pendingCommand: RelayWatchCommand?
    @Published private(set) var lastSentCommand: RelayWatchCommand?
    @Published var watchedJobID: String?
    @Published var isComposing = false
    var isSceneActive = false
    private var requests: [String: CheckedContinuation<[String: Any], Error>] = [:]
    private var requestTimeouts: [String: Task<Void, Never>] = [:]
    private var refreshFailures = 0
    private var lastRefreshStartedAt: Date?
    private let defaults = UserDefaults.standard
    private let pendingKey = "relay.watch.pending.v1"

    override init() {
        super.init()
        if let data = defaults.data(forKey: pendingKey) {
            pendingCommand = try? JSONDecoder().decode(RelayWatchCommand.self, from: data)
        }
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    var automaticRefreshInterval: TimeInterval? {
        RelayWatchRefreshPolicy.interval(
            isActive: isSceneActive, isComposing: isComposing,
            watchedJobID: watchedJobID, snapshot: snapshot, failures: refreshFailures
        )
    }

    func refresh(automatically: Bool = false) async {
        guard isSceneActive, !isBusy, !Task.isCancelled,
              WCSession.default.activationState == .activated else { return }
        if automatically {
            guard !isComposing else { return }
            if let lastRefreshStartedAt,
               Date().timeIntervalSince(lastRefreshStartedAt) < RelayWatchRefreshPolicy.minimumAutomaticSpacing { return }
        }
        lastRefreshStartedAt = Date()
        isBusy = true
        defer { isBusy = false }
        do {
            var command = RelayWatchCommand(kind: .refresh)
            command.jobID = watchedJobID
            let reply = try await request(command)
            refreshFailures = reply.outcome == .ok ? 0 : min(refreshFailures + 1, 5)
            if let snapshot = reply.snapshot { apply(snapshot) }
            if pendingCommand == nil || reply.error != nil { errorMessage = reply.error }
        } catch {
            refreshFailures = min(refreshFailures + 1, 5)
            errorMessage = "iPhone could not refresh Relay. Open Relay on your connected iPhone, then try again."
        }
    }

    /// An unconfirmed mutation retains the SAME request ID, even after relaunch.
    /// Check delivery queries the phone's durable receipt; it does not invent a retry.
    func perform(_ command: RelayWatchCommand, lookupOnly: Bool = false) async -> Bool {
        guard !isBusy, pendingCommand == nil || pendingCommand?.id == command.id else { return false }
        isBusy = true
        errorMessage = nil
        notice = nil
        pendingCommand = command
        defaults.set(try? JSONEncoder().encode(command), forKey: pendingKey)
        defer { isBusy = false }
        do {
            var lookup = RelayWatchCommand(kind: .delivery, sourceID: command.sourceID)
            lookup.originalRequestID = command.id
            let reply = try await request(lookupOnly ? lookup : command)
            if reply.outcome != .uncertain {
                pendingCommand = nil
                defaults.removeObject(forKey: pendingKey)
            }
            if let snapshot = reply.snapshot { apply(snapshot) }
            errorMessage = reply.error
            guard reply.outcome == .ok else { return false }
            if command.kind == .send {
                defaults.removeObject(forKey: command.draftKey)
                lastSentCommand = command
            }
            notice = command.kind == .send ? "Sent. Your run appears in Threads." : "Action received. Refreshing…"
            WKInterfaceDevice.current().play(.success)
            return true
        } catch {
            errorMessage = "Delivery unconfirmed. Check delivery before sending again. Your draft is saved."
            return false
        }
    }

    func checkDelivery() async {
        guard let command = pendingCommand else { return }
        if await perform(command, lookupOnly: true) { await refresh() }
    }

    /// Only offered after the person explicitly checks the run on their phone.
    func acknowledgeUnconfirmedDelivery() {
        pendingCommand = nil
        defaults.removeObject(forKey: pendingKey)
        errorMessage = nil
        notice = "Review Threads before starting another run."
    }

    private func request(_ command: RelayWatchCommand) async throws -> RelayWatchReply {
        let reply = try await exchange(try RelayWatchWire.encode(command), id: command.id, timeout: 30)
        return try RelayWatchWire.decode(RelayWatchReply.self, from: reply)
    }

    func dictate(_ request: RelayWatchDictationRequest) async throws -> RelayWatchDictationReply {
        let reply = try await exchange(try RelayWatchDictationWire.encode(request), id: UUID().uuidString, timeout: 8)
        let decoded = try RelayWatchDictationWire.decode(RelayWatchDictationReply.self, from: reply)
        guard decoded.sessionID == request.sessionID else { throw RelayWatchError("Dictation connection changed. Please try again.") }
        return decoded
    }

    private func exchange(_ message: [String: Any], id: String, timeout: UInt64) async throws -> [String: Any] {
        let session = WCSession.default
        guard session.activationState == .activated else { throw RelayWatchError("Connecting to iPhone…") }
        // An active watch may wake a reachable, suspended phone. Don't gate on
        // a stale isReachable value; sendMessage reports actual delivery failure.
        return try await withCheckedThrowingContinuation { continuation in
            requests[id] = continuation
            session.sendMessage(message, replyHandler: { reply in
                Task { @MainActor in
                    self.finish(id, result: .success(reply))
                }
            }, errorHandler: { error in
                Task { @MainActor in self.finish(id, result: .failure(error)) }
            })
            requestTimeouts[id] = Task { @MainActor [weak self] in
                do { try await Task.sleep(nanoseconds: timeout * 1_000_000_000) }
                catch { return }
                self?.finish(id, result: .failure(RelayWatchError("iPhone did not answer in time.")))
            }
        }
    }

    private func finish(_ id: String, result: Result<[String: Any], Error>) {
        requestTimeouts.removeValue(forKey: id)?.cancel()
        requests.removeValue(forKey: id)?.resume(with: result)
    }

    private func apply(_ incoming: RelayWatchSnapshot) {
        guard incoming.version == RelayWatchWire.version else {
            errorMessage = "Update Relay on both devices."
            return
        }
        if let previous = snapshot, previous.sourceID == incoming.sourceID {
            guard incoming.updatedAt >= previous.updatedAt else { return }
            let oldApprovals = Set(previous.approvals.map(\.id))
            if isSceneActive, incoming.approvals.contains(where: { !oldApprovals.contains($0.id) }) {
                WKInterfaceDevice.current().play(.notification)
            } else if isSceneActive, incoming.threads.contains(where: { row in
                !row.isActive && previous.threads.contains(where: { $0.id == row.id && $0.isActive })
            }) { WKInterfaceDevice.current().play(.success) }
        }
        snapshot = incoming
    }

    private func receiveContext(_ context: [String: Any]) {
        if context["relay.watch.reset"] as? Bool == true {
            snapshot = nil
            notice = nil
            errorMessage = "Your iPhone connection changed. Refresh Relay."
        } else if let value = try? RelayWatchWire.decode(RelayWatchSnapshot.self, from: context) { apply(value) }
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
        let context = session.receivedApplicationContext
        Task { @MainActor in
            self.receiveContext(context)
            // Activation can also happen during a background delivery. Receiving
            // cached state must not start another round trip to the phone.
            if self.isSceneActive, !self.isComposing { await self.refresh(automatically: true) }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.receiveContext(applicationContext) }
    }
}
