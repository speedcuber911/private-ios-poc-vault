import Foundation

/// Display data, explicit commands and bounded microphone batches cross Watch Connectivity. Node URLs,
/// certificates, bearer tokens, provider credentials and raw logs stay on iPhone.
enum RelayWatchWire {
    static let version = 1
    static let key = "relay.watch.v1"
    static let maximumBytes = 60_000

    static func encode<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard data.count <= maximumBytes else { throw RelayWatchError("This update is too large. Open Relay on iPhone.") }
        return [key: data]
    }

    static func decode<T: Decodable>(_ type: T.Type, from message: [String: Any]) throws -> T {
        guard let data = message[key] as? Data, data.count <= maximumBytes else {
            throw RelayWatchError("Update Relay on both your iPhone and watch.")
        }
        return try JSONDecoder().decode(type, from: data)
    }
}

enum RelayWatchDictationWire {
    static let key = "relay.watch.dictation.v1"
    static let bytesPerSecond = 32_000 // 16 kHz, mono, signed 16-bit PCM.
    static let chunkBytes = 16_000 // Half a second, comfortably below WCSession's message limit.
    static let maximumSeconds = 60
    static let maximumBufferedBytes = bytesPerSecond * 4

    static func encode<T: Encodable>(_ value: T) throws -> [String: Any] {
        let data = try JSONEncoder().encode(value)
        guard data.count <= RelayWatchWire.maximumBytes else { throw RelayWatchError("Dictation update is too large.") }
        return [key: data]
    }

    static func decode<T: Decodable>(_ type: T.Type, from message: [String: Any]) throws -> T {
        guard let data = message[key] as? Data, data.count <= RelayWatchWire.maximumBytes else {
            throw RelayWatchError("Update Relay on your iPhone to use watch dictation.")
        }
        return try JSONDecoder().decode(type, from: data)
    }
}

struct RelayWatchDictationRequest: Codable {
    enum Kind: String, Codable { case begin, audio, finish, cancel }
    var version = 1
    let sessionID: String
    let sourceID: String
    let kind: Kind
    var sequence = 0
    var audio: Data? = nil
}

struct RelayWatchDictationReply: Codable {
    let sessionID: String
    var nextSequence = 0
    var transcript = ""
    var finished = false
    var error: String? = nil
}

/// Reject gaps, replayed batches and oversized input before forwarding any audio.
struct RelayWatchAudioLedger {
    private(set) var nextSequence = 0
    private(set) var audioBytes = 0

    mutating func accept(_ audio: Data, sequence: Int) throws {
        guard sequence == nextSequence else { throw RelayWatchError("Dictation lost its place. Please record again.") }
        guard !audio.isEmpty, audio.count.isMultiple(of: 2), audio.count <= RelayWatchDictationWire.chunkBytes else {
            throw RelayWatchError("The watch sent an invalid audio batch.")
        }
        guard audioBytes + audio.count <= RelayWatchDictationWire.bytesPerSecond * RelayWatchDictationWire.maximumSeconds else {
            throw RelayWatchError("Dictation is limited to one minute. Review your text, then add more.")
        }
        nextSequence += 1
        audioBytes += audio.count
    }
}

struct RelayWatchError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

struct RelayWatchModel: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    let provider: String
    let efforts: [String]
}

struct RelayWatchFolder: Codable, Identifiable, Equatable {
    let id: String
    let name: String
}

struct RelayWatchThread: Codable, Identifiable, Equatable {
    let id: String
    let sessionID: String?
    let jobID: String?
    let workspaceID: String?
    let provider: String
    let title: String
    let status: String
    let isActive: Bool
    var excerpt: String
    var progress: String? = nil
}

struct RelayWatchApproval: Codable, Identifiable, Equatable {
    let id: String
    let jobID: String
    let title: String
    let detail: String
    let decisions: [String]
    /// Oversized requests can be read as a preview but never approved unseen.
    let requiresPhone: Bool
}

struct RelayWatchSnapshot: Codable, Equatable {
    var version = RelayWatchWire.version
    let sourceID: String
    let updatedAt: Date
    let models: [RelayWatchModel]
    let folders: [RelayWatchFolder]
    var threads: [RelayWatchThread]
    let approvals: [RelayWatchApproval]

    /// A new fetch time alone does not justify another background transfer.
    func hasSameContent(as other: RelayWatchSnapshot) -> Bool {
        version == other.version && sourceID == other.sourceID
            && models == other.models && folders == other.folders
            && threads == other.threads && approvals == other.approvals
    }
}

enum RelayWatchRefreshPolicy {
    static let minimumAutomaticSpacing: TimeInterval = 5

    /// Foreground reads only. Keep an open running thread reasonably current,
    /// but let an idle watch and an unavailable phone sleep between attempts.
    static func interval(
        isActive: Bool, isComposing: Bool, watchedJobID: String?,
        snapshot: RelayWatchSnapshot?, failures: Int
    ) -> TimeInterval? {
        guard isActive, !isComposing else { return nil }
        if failures > 0 {
            return min(300, 30 * pow(2, Double(min(failures - 1, 4))))
        }
        if let watchedJobID, snapshot?.threads.contains(where: {
            $0.jobID == watchedJobID && $0.isActive
        }) == true { return 15 }
        if snapshot?.threads.contains(where: { $0.isActive }) == true { return 30 }
        return 120
    }
}

struct RelayWatchCommand: Codable, Equatable {
    enum Kind: String, Codable { case refresh, delivery, send, decide, cancel }
    var version = RelayWatchWire.version
    var id = UUID().uuidString
    let kind: Kind
    var sourceID: String = ""
    var workspaceID: String?
    var modelID: String?
    var effort: String?
    var prompt: String?
    var sessionID: String?
    var jobID: String?
    var approvalID: String?
    var decision: String?
    var originalRequestID: String?

    var isMutation: Bool { [.send, .decide, .cancel].contains(kind) }
    var draftKey: String { "relay.watch.draft.\(sourceID).\(sessionID ?? "new")" }

    func validate(against snapshot: RelayWatchSnapshot) throws {
        guard version == RelayWatchWire.version else { throw RelayWatchError("Update Relay on both devices.") }
        guard sourceID == snapshot.sourceID else { throw RelayWatchError("The linked machine changed. Refresh before sending.") }
        if kind == .send {
            let text = (prompt ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty, text.count <= 8_000 else { throw RelayWatchError("Enter a prompt of up to 8,000 characters.") }
            guard snapshot.folders.contains(where: { $0.id == workspaceID }) else {
                throw RelayWatchError("Choose a folder registered in Relay on iPhone.")
            }
            guard let model = snapshot.models.first(where: { $0.id == modelID }) else {
                throw RelayWatchError("Choose an available model.")
            }
            if let effort, !model.efforts.contains(effort) { throw RelayWatchError("Choose an effort supported by this model.") }
            if let sessionID {
                guard let thread = snapshot.threads.first(where: {
                    $0.sessionID == sessionID && $0.provider == model.provider && $0.workspaceID == workspaceID
                }), !thread.isActive else {
                    throw RelayWatchError("Refresh this thread on iPhone before replying.")
                }
            }
        }
        if kind == .decide {
            guard let approval = snapshot.approvals.first(where: { $0.id == approvalID }),
                  approval.jobID == jobID, !approval.requiresPhone,
                  let decision, approval.decisions.contains(decision),
                  ["accept", "decline"].contains(decision) else {
                throw RelayWatchError("This request changed or needs review on iPhone.")
            }
        }
        if kind == .cancel {
            guard snapshot.threads.contains(where: { $0.jobID == jobID && $0.isActive }) else {
                throw RelayWatchError("That run is no longer active. Refresh its status.")
            }
        }
    }
}

struct RelayWatchReply: Codable {
    enum Outcome: String, Codable { case ok, rejected, uncertain }
    var outcome: Outcome = .ok
    var snapshot: RelayWatchSnapshot?
    var jobID: String?
    var error: String?
}

enum RelayWatchText {
    /// An extract, never an invented semantic summary. Keep the end as well so
    /// a concluding question is not lost to a long opening paragraph.
    static func excerpt(_ text: String, limit: Int = 700) -> String {
        let plain = text.replacingOccurrences(of: "(?s)```.*?```", with: "[Code on iPhone]", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard plain.count > limit else { return plain }
        let marker = "\n…\n"
        let tail = max(0, (limit - marker.count) / 3)
        let head = max(0, limit - marker.count - tail)
        return String(plain.prefix(head)) + marker + String(plain.suffix(tail))
    }
}
