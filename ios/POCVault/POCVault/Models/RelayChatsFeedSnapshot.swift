import CryptoKit
import Foundation

/// The rows of the Chats list as a machine last answered them, in the form
/// they are written to disk so a cold launch can paint the list at once and
/// then revalidate quietly.
///
/// Only what a row and the first frame of an opened chat need is kept: thread
/// and job identity, folder, provider, status, timestamps, and the short
/// prompt/result text titles are made from. Nothing else from a job is written
/// — no stdout/stderr, attachments, artifacts, execution receipts or client
/// certificate subject — and approvals are never persisted at all: they are
/// decisions, and a stale Approve button is worse than none.
struct RelayChatsFeedSnapshot: Equatable {
    static let formatVersion = 1
    /// The newest rows kept per machine.
    static let itemLimit = 200
    /// Longest prompt/result/error kept per row. relayd already bounds thread
    /// summaries (240 characters by default); this is the phone's backstop.
    static let textLimit = 2_000

    let threadRows: [ThreadRow]
    let jobRows: [JobRow]

    /// Bounds `threads` and `jobs` to the rows Chats would show first — the
    /// same `makeFeed` order, cut at `itemLimit` — so re-making the feed from
    /// the snapshot reproduces exactly those rows.
    init(threads: [CodexThread], jobs: [CodexJob]) {
        var keptThreads: [ThreadRow] = []
        var keptJobs: [JobRow] = []
        for item in CodexThreadFeedItem.makeFeed(threads: threads, jobs: jobs).prefix(Self.itemLimit) {
            switch item.source {
            case .thread(let thread):
                keptThreads.append(ThreadRow(thread))
            case .pendingJob(let job):
                keptJobs.append(JobRow(job))
            }
        }
        threadRows = keptThreads
        jobRows = keptJobs
    }

    var isEmpty: Bool { threadRows.isEmpty && jobRows.isEmpty }

    /// What a load hands back: real model values, decoded by the same
    /// initializers a machine response goes through.
    struct Restored {
        let threads: [CodexThread]
        let jobs: [CodexJob]
        let savedAt: Date
    }

    func encoded(savedAt: Date) throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        return try encoder.encode(EncodedFile(
            version: Self.formatVersion,
            savedAt: savedAt,
            threads: threadRows,
            jobs: jobRows
        ))
    }

    /// Nil for anything unreadable or from another format version: a snapshot
    /// is only ever a head start, never worth an error.
    static func restore(from data: Data) -> Restored? {
        let decoder = CodexClient.makeDecoder()
        guard let header = try? decoder.decode(Header.self, from: data),
              header.version == formatVersion,
              let file = try? decoder.decode(DecodedFile.self, from: data)
        else { return nil }
        // A snapshot saved before Cursor was retired may still hold its rows.
        return Restored(
            threads: file.threads.filter { $0.provider != .unsupported },
            jobs: file.jobs.filter { $0.provider != .unsupported },
            savedAt: file.savedAt
        )
    }

    /// Cuts overlong text to exactly `textLimit` characters. Idempotent, so a
    /// restored row projects back to the same row and is not rewritten.
    static func bounded(_ text: String?) -> String? {
        guard let text, text.count > textLimit else { return text }
        return String(text.prefix(textLimit - 1)) + "…"
    }

    /// Keys match what `CodexThread.init(from:)` reads.
    struct ThreadRow: Encodable, Equatable {
        let id: String
        let mode: RelayInteractionMode
        let provider: CodexProvider
        let sessionId: String
        let workspaceId: String?
        let workspaceName: String?
        let cwd: String?
        let timestamp: Date?
        let updatedAt: Date?
        let model: String?
        let jobCount: Int
        let activeJobCount: Int
        let live: Bool
        let lastJobId: String?
        let lastJobStatus: CodexJobStatus?
        let lastPrompt: String?
        let lastResult: String?
        let lastError: String?
        let hasSessionFile: Bool
        let isSmokeTest: Bool

        init(_ thread: CodexThread) {
            id = thread.id
            mode = thread.mode
            provider = thread.provider
            sessionId = thread.sessionId
            workspaceId = thread.workspaceId
            workspaceName = thread.workspaceName
            cwd = thread.cwd
            timestamp = thread.timestamp
            updatedAt = thread.updatedAt
            model = thread.model
            jobCount = thread.jobCount
            activeJobCount = thread.activeJobCount
            live = thread.live
            lastJobId = thread.lastJobId
            lastJobStatus = thread.lastJobStatus
            lastPrompt = RelayChatsFeedSnapshot.bounded(thread.lastPrompt)
            lastResult = RelayChatsFeedSnapshot.bounded(thread.lastResult)
            lastError = RelayChatsFeedSnapshot.bounded(thread.lastError)
            hasSessionFile = thread.hasSessionFile
            isSmokeTest = thread.isSmokeTest
        }
    }

    /// Keys match what `CodexJob.init(from:)` reads. Deliberately a subset.
    struct JobRow: Encodable, Equatable {
        let id: String
        let provider: CodexProvider
        let workspaceId: String?
        let workspaceName: String?
        let workspacePath: String?
        let status: CodexJobStatus
        let prompt: String?
        let createdAt: Date?
        let updatedAt: Date?
        let startedAt: Date?
        let completedAt: Date?
        let exitCode: Int?
        let result: String?
        let errorMessage: String?
        let timedOut: Bool
        let model: String?
        let sessionId: String?
        let resumeSessionId: String?

        init(_ job: CodexJob) {
            id = job.id
            provider = job.provider
            workspaceId = job.workspaceId
            workspaceName = job.workspaceName
            workspacePath = job.workspacePath
            status = job.status
            prompt = RelayChatsFeedSnapshot.bounded(job.prompt)
            createdAt = job.createdAt
            updatedAt = job.updatedAt
            startedAt = job.startedAt
            completedAt = job.completedAt
            exitCode = job.exitCode
            result = RelayChatsFeedSnapshot.bounded(job.result)
            errorMessage = RelayChatsFeedSnapshot.bounded(job.errorMessage)
            timedOut = job.timedOut
            model = job.model
            sessionId = job.sessionId
            resumeSessionId = job.resumeSessionId
        }
    }

    private struct EncodedFile: Encodable {
        let version: Int
        let savedAt: Date
        let threads: [ThreadRow]
        let jobs: [JobRow]
    }

    private struct Header: Decodable {
        let version: Int
    }

    private struct DecodedFile: Decodable {
        let savedAt: Date
        let threads: [CodexThread]
        let jobs: [CodexJob]
    }
}

/// One small file per machine under Application Support, keyed by a hash of
/// the machine's base URL, protected until first unlock and excluded from
/// backup. Writes go through one serial queue so a save never blocks the main
/// thread and a later remove or load always lands after it.
final class RelayChatsFeedSnapshotStore {
    static let standard = RelayChatsFeedSnapshotStore(directory: defaultDirectory())

    private let directory: URL?
    private let queue = DispatchQueue(label: "com.parikshit.pocvault.chats-feed-snapshot", qos: .utility)

    /// `directory` nil makes a store that remembers nothing.
    init(directory: URL?) {
        self.directory = directory
    }

    static func defaultDirectory() -> URL? {
        FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("ChatsFeed", isDirectory: true)
    }

    /// The same machine reached as `https://host:8890` and `https://host:8890/`
    /// is one machine.
    static func machineKey(for baseURL: URL) -> String {
        var value = baseURL.absoluteString
        while value.hasSuffix("/") { value.removeLast() }
        return value
    }

    func fileURL(for baseURL: URL) -> URL? {
        let digest = SHA256.hash(data: Data(Self.machineKey(for: baseURL).utf8))
        let name = digest.prefix(16).map { String(format: "%02x", $0) }.joined()
        return directory?.appendingPathComponent("feed-\(name).json", isDirectory: false)
    }

    /// Synchronous so launch can paint from it before the first frame. Waits
    /// behind any write still queued for the same file.
    func load(for baseURL: URL) -> RelayChatsFeedSnapshot.Restored? {
        guard let url = fileURL(for: baseURL) else { return nil }
        return queue.sync {
            guard let data = try? Data(contentsOf: url) else { return nil }
            guard let restored = RelayChatsFeedSnapshot.restore(from: data) else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return restored
        }
    }

    func save(_ snapshot: RelayChatsFeedSnapshot, savedAt: Date, for baseURL: URL) {
        guard let directory, let url = fileURL(for: baseURL),
              let data = try? snapshot.encoded(savedAt: savedAt) else { return }
        queue.async {
            // A snapshot that cannot be written only costs the next cold launch
            // its instant paint; there is nothing to tell the user.
            do {
                try Self.prepare(directory)
                try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            } catch {
                CodexDiagnostics.log("chats_feed_snapshot_write_failed", fields: [
                    "error": error.localizedDescription
                ])
            }
        }
    }

    func remove(for baseURL: URL) {
        guard let url = fileURL(for: baseURL) else { return }
        queue.async {
            try? FileManager.default.removeItem(at: url)
        }
    }

    /// Returns once every queued write and remove has finished.
    func waitForPendingWrites() {
        queue.sync {}
    }

    private static func prepare(_ directory: URL) throws {
        let fileManager = FileManager.default
        guard !fileManager.fileExists(atPath: directory.path) else { return }
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]
        )
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var excluded = directory
        try? excluded.setResourceValues(values)
    }
}
