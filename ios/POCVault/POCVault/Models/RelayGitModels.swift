import Foundation

// MARK: - Git Status & PR

struct RelayGitFileStatus: Codable, Hashable, Identifiable, Sendable {
    let path: String
    let oldPath: String?
    /// One of `"modified"`, `"added"`, `"deleted"`, `"renamed"`, `"untracked"`.
    let status: String
    let staged: Bool
    let unstaged: Bool
    let added: Int
    let deleted: Int
    let binary: Bool

    var id: String { path }

    var fileName: String {
        URL(fileURLWithPath: path).lastPathComponent
    }

    var directoryPath: String? {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty || dir == "." ? nil : dir
    }

    var isDeleted: Bool {
        status.lowercased() == "deleted"
    }

    var shortStatusBadge: String {
        switch status.lowercased() {
        case "added": return "A"
        case "deleted": return "D"
        case "renamed": return "R"
        case "untracked": return "U"
        default: return "M"
        }
    }

    init(
        path: String,
        oldPath: String? = nil,
        status: String = "modified",
        staged: Bool = false,
        unstaged: Bool = true,
        added: Int = 0,
        deleted: Int = 0,
        binary: Bool = false
    ) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.staged = staged
        self.unstaged = unstaged
        self.added = added
        self.deleted = deleted
        self.binary = binary
    }

    enum CodingKeys: String, CodingKey {
        case path, oldPath, status, staged, unstaged, added, deleted, binary
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        oldPath = try container.decodeIfPresent(String.self, forKey: .oldPath)?.trimmedNonEmpty
        status = try container.decodeIfPresent(String.self, forKey: .status)?.trimmedNonEmpty ?? "modified"
        staged = try container.decodeIfPresent(Bool.self, forKey: .staged) ?? false
        unstaged = try container.decodeIfPresent(Bool.self, forKey: .unstaged) ?? false
        added = try container.decodeIfPresent(Int.self, forKey: .added) ?? 0
        deleted = try container.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
        binary = try container.decodeIfPresent(Bool.self, forKey: .binary) ?? false
    }
}

struct RelayGitPRInfo: Codable, Hashable, Identifiable, Sendable {
    let number: Int
    let title: String
    let state: String
    let url: String
    let headBranch: String?
    let checksStatus: String?

    var id: Int { number }

    var resolvedURL: URL? {
        guard let candidate = URL(string: url),
              let scheme = candidate.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            return nil
        }
        return candidate
    }

    var shortLabel: String { "PR #\(number)" }

    init(
        number: Int,
        title: String,
        state: String,
        url: String,
        headBranch: String? = nil,
        checksStatus: String? = nil
    ) {
        self.number = number
        self.title = title
        self.state = state
        self.url = url
        self.headBranch = headBranch
        self.checksStatus = checksStatus
    }

    enum CodingKeys: String, CodingKey {
        case number, title, state, url, headBranch, checksStatus
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        number = try container.decode(Int.self, forKey: .number)
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? "Pull Request #\(number)"
        state = try container.decodeIfPresent(String.self, forKey: .state)?.trimmedNonEmpty ?? "open"
        url = try container.decodeIfPresent(String.self, forKey: .url) ?? ""
        headBranch = try container.decodeIfPresent(String.self, forKey: .headBranch)?.trimmedNonEmpty
        checksStatus = try container.decodeIfPresent(String.self, forKey: .checksStatus)?.trimmedNonEmpty
    }
}

struct RelayGitStatusResponse: Codable, Hashable, Sendable {
    let isGitRepo: Bool
    let repoRoot: String?
    let branch: String?
    let baseBranch: String?
    let ahead: Int
    let behind: Int
    let dirty: Bool
    let added: Int
    let deleted: Int
    let files: [RelayGitFileStatus]
    let pr: RelayGitPRInfo?

    init(
        isGitRepo: Bool,
        repoRoot: String? = nil,
        branch: String? = nil,
        baseBranch: String? = nil,
        ahead: Int = 0,
        behind: Int = 0,
        dirty: Bool = false,
        added: Int = 0,
        deleted: Int = 0,
        files: [RelayGitFileStatus] = [],
        pr: RelayGitPRInfo? = nil
    ) {
        self.isGitRepo = isGitRepo
        self.repoRoot = repoRoot
        self.branch = branch
        self.baseBranch = baseBranch
        self.ahead = ahead
        self.behind = behind
        self.dirty = dirty
        self.added = added
        self.deleted = deleted
        self.files = files
        self.pr = pr
    }

    enum CodingKeys: String, CodingKey {
        case isGitRepo, repoRoot, branch, baseBranch, ahead, behind, dirty, added, deleted, files, pr
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        isGitRepo = try container.decodeIfPresent(Bool.self, forKey: .isGitRepo) ?? false
        repoRoot = try container.decodeIfPresent(String.self, forKey: .repoRoot)?.trimmedNonEmpty
        branch = try container.decodeIfPresent(String.self, forKey: .branch)?.trimmedNonEmpty
        baseBranch = try container.decodeIfPresent(String.self, forKey: .baseBranch)?.trimmedNonEmpty
        ahead = try container.decodeIfPresent(Int.self, forKey: .ahead) ?? 0
        behind = try container.decodeIfPresent(Int.self, forKey: .behind) ?? 0
        dirty = try container.decodeIfPresent(Bool.self, forKey: .dirty) ?? false
        added = try container.decodeIfPresent(Int.self, forKey: .added) ?? 0
        deleted = try container.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
        files = try container.decodeIfPresent([RelayGitFileStatus].self, forKey: .files) ?? []
        pr = try container.decodeIfPresent(RelayGitPRInfo.self, forKey: .pr)
    }
}

// MARK: - Unified Diffs

enum RelayGitDiffMode: String, CaseIterable, Identifiable, Codable, Hashable, Sendable {
    case uncommitted
    case committed
    case all

    var id: String { rawValue }

    var title: String {
        switch self {
        case .uncommitted: return "Uncommitted"
        case .committed: return "Committed"
        case .all: return "All"
        }
    }

    var subtitle: String {
        switch self {
        case .uncommitted: return "Working tree changes"
        case .committed: return "Committed on branch"
        case .all: return "All branch changes"
        }
    }
}

struct RelayGitDiffLine: Codable, Hashable, Sendable {
    /// One of `"context"`, `"add"`, `"del"`.
    let kind: String
    let oldLine: Int?
    let newLine: Int?
    let text: String

    var isAddition: Bool { kind == "add" }
    var isDeletion: Bool { kind == "del" || kind == "delete" }

    var displayLineNumber: Int? {
        isDeletion ? oldLine : (newLine ?? oldLine)
    }

    init(
        kind: String,
        oldLine: Int? = nil,
        newLine: Int? = nil,
        text: String
    ) {
        self.kind = kind
        self.oldLine = oldLine
        self.newLine = newLine
        self.text = text
    }

    enum CodingKeys: String, CodingKey {
        case kind, oldLine, newLine, text
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decodeIfPresent(String.self, forKey: .kind) ?? "context"
        oldLine = try container.decodeIfPresent(Int.self, forKey: .oldLine)
        newLine = try container.decodeIfPresent(Int.self, forKey: .newLine)
        text = try container.decodeIfPresent(String.self, forKey: .text) ?? ""
    }
}

struct RelayGitDiffHunk: Codable, Hashable, Sendable {
    let header: String
    let oldStart: Int
    let oldCount: Int
    let newStart: Int
    let newCount: Int
    let lines: [RelayGitDiffLine]

    init(
        header: String,
        oldStart: Int,
        oldCount: Int,
        newStart: Int,
        newCount: Int,
        lines: [RelayGitDiffLine]
    ) {
        self.header = header
        self.oldStart = oldStart
        self.oldCount = oldCount
        self.newStart = newStart
        self.newCount = newCount
        self.lines = lines
    }

    enum CodingKeys: String, CodingKey {
        case header, oldStart, oldCount, newStart, newCount, lines
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        oldStart = try container.decodeIfPresent(Int.self, forKey: .oldStart) ?? 0
        oldCount = try container.decodeIfPresent(Int.self, forKey: .oldCount) ?? 0
        newStart = try container.decodeIfPresent(Int.self, forKey: .newStart) ?? 0
        newCount = try container.decodeIfPresent(Int.self, forKey: .newCount) ?? 0
        header = try container.decodeIfPresent(String.self, forKey: .header)?.trimmedNonEmpty
            ?? "@@ -\(oldStart),\(oldCount) +\(newStart),\(newCount) @@"
        lines = try container.decodeIfPresent([RelayGitDiffLine].self, forKey: .lines) ?? []
    }
}

struct RelayGitDiffFile: Codable, Hashable, Identifiable, Sendable {
    let path: String
    let oldPath: String?
    let status: String
    let added: Int
    let deleted: Int
    let binary: Bool
    let hunks: [RelayGitDiffHunk]

    var id: String { path }

    var fileName: String {
        URL(fileURLWithPath: path).lastPathComponent
    }

    var directoryPath: String? {
        let dir = (path as NSString).deletingLastPathComponent
        return dir.isEmpty || dir == "." ? nil : dir
    }

    var isDeleted: Bool {
        status.lowercased() == "deleted"
    }

    var shortStatusBadge: String {
        switch status.lowercased() {
        case "added": return "A"
        case "deleted": return "D"
        case "renamed": return "R"
        case "untracked": return "U"
        default: return "M"
        }
    }

    init(
        path: String,
        oldPath: String? = nil,
        status: String = "modified",
        added: Int = 0,
        deleted: Int = 0,
        binary: Bool = false,
        hunks: [RelayGitDiffHunk] = []
    ) {
        self.path = path
        self.oldPath = oldPath
        self.status = status
        self.added = added
        self.deleted = deleted
        self.binary = binary
        self.hunks = hunks
    }

    enum CodingKeys: String, CodingKey {
        case path, oldPath, status, added, deleted, binary, hunks
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        oldPath = try container.decodeIfPresent(String.self, forKey: .oldPath)?.trimmedNonEmpty
        status = try container.decodeIfPresent(String.self, forKey: .status)?.trimmedNonEmpty ?? "modified"
        added = try container.decodeIfPresent(Int.self, forKey: .added) ?? 0
        deleted = try container.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
        binary = try container.decodeIfPresent(Bool.self, forKey: .binary) ?? false
        hunks = try container.decodeIfPresent([RelayGitDiffHunk].self, forKey: .hunks) ?? []
    }
}

struct RelayGitDiffResponse: Codable, Hashable, Sendable {
    let mode: String
    let branch: String?
    let baseBranch: String?
    let totalAdded: Int
    let totalDeleted: Int
    let truncated: Bool
    let files: [RelayGitDiffFile]

    init(
        mode: String = RelayGitDiffMode.uncommitted.rawValue,
        branch: String? = nil,
        baseBranch: String? = nil,
        totalAdded: Int = 0,
        totalDeleted: Int = 0,
        truncated: Bool = false,
        files: [RelayGitDiffFile] = []
    ) {
        self.mode = mode
        self.branch = branch
        self.baseBranch = baseBranch
        self.totalAdded = totalAdded
        self.totalDeleted = totalDeleted
        self.truncated = truncated
        self.files = files
    }

    enum CodingKeys: String, CodingKey {
        case mode, branch, baseBranch, totalAdded, totalDeleted, truncated, files
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mode = try container.decodeIfPresent(String.self, forKey: .mode) ?? RelayGitDiffMode.uncommitted.rawValue
        branch = try container.decodeIfPresent(String.self, forKey: .branch)?.trimmedNonEmpty
        baseBranch = try container.decodeIfPresent(String.self, forKey: .baseBranch)?.trimmedNonEmpty
        files = try container.decodeIfPresent([RelayGitDiffFile].self, forKey: .files) ?? []
        totalAdded = try container.decodeIfPresent(Int.self, forKey: .totalAdded)
            ?? files.reduce(0) { $0 + $1.added }
        totalDeleted = try container.decodeIfPresent(Int.self, forKey: .totalDeleted)
            ?? files.reduce(0) { $0 + $1.deleted }
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
    }
}

// MARK: - Commits & Branches

struct RelayGitCommit: Codable, Hashable, Identifiable, Sendable {
    let sha: String
    let shortSha: String
    let subject: String
    let author: String
    let relativeDate: String
    let committedAt: String?

    var id: String { sha }

    init(
        sha: String,
        shortSha: String,
        subject: String,
        author: String,
        relativeDate: String,
        committedAt: String? = nil
    ) {
        self.sha = sha
        self.shortSha = shortSha
        self.subject = subject
        self.author = author
        self.relativeDate = relativeDate
        self.committedAt = committedAt
    }

    enum CodingKeys: String, CodingKey {
        case sha, shortSha, subject, author, relativeDate, committedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        sha = try container.decode(String.self, forKey: .sha)
        shortSha = try container.decodeIfPresent(String.self, forKey: .shortSha)?.trimmedNonEmpty
            ?? String(sha.prefix(7))
        subject = try container.decodeIfPresent(String.self, forKey: .subject) ?? ""
        author = try container.decodeIfPresent(String.self, forKey: .author) ?? ""
        relativeDate = try container.decodeIfPresent(String.self, forKey: .relativeDate) ?? ""
        committedAt = try container.decodeIfPresent(String.self, forKey: .committedAt)?.trimmedNonEmpty
    }
}

struct RelayGitCommitsResponse: Codable, Hashable, Sendable {
    let branch: String?
    let commits: [RelayGitCommit]

    init(branch: String? = nil, commits: [RelayGitCommit] = []) {
        self.branch = branch
        self.commits = commits
    }

    enum CodingKeys: String, CodingKey {
        case branch, commits
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        branch = try container.decodeIfPresent(String.self, forKey: .branch)?.trimmedNonEmpty
        commits = try container.decodeIfPresent([RelayGitCommit].self, forKey: .commits) ?? []
    }
}

struct RelayGitBranch: Codable, Hashable, Identifiable, Sendable {
    let name: String
    let isCurrent: Bool
    let isRemote: Bool
    let upstream: String?

    var id: String { "\(isRemote ? "remote:" : "local:")\(name)" }

    init(
        name: String,
        isCurrent: Bool = false,
        isRemote: Bool = false,
        upstream: String? = nil
    ) {
        self.name = name
        self.isCurrent = isCurrent
        self.isRemote = isRemote
        self.upstream = upstream
    }

    enum CodingKeys: String, CodingKey {
        case name, isCurrent, isRemote, upstream
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        isCurrent = try container.decodeIfPresent(Bool.self, forKey: .isCurrent) ?? false
        isRemote = try container.decodeIfPresent(Bool.self, forKey: .isRemote) ?? false
        upstream = try container.decodeIfPresent(String.self, forKey: .upstream)?.trimmedNonEmpty
    }
}

struct RelayGitBranchesResponse: Codable, Hashable, Sendable {
    let current: String?
    let baseBranch: String?
    let branches: [RelayGitBranch]

    init(
        current: String? = nil,
        baseBranch: String? = nil,
        branches: [RelayGitBranch] = []
    ) {
        self.current = current
        self.baseBranch = baseBranch
        self.branches = branches
    }

    enum CodingKeys: String, CodingKey {
        case current, baseBranch, branches
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        current = try container.decodeIfPresent(String.self, forKey: .current)?.trimmedNonEmpty
        baseBranch = try container.decodeIfPresent(String.self, forKey: .baseBranch)?.trimmedNonEmpty
        branches = try container.decodeIfPresent([RelayGitBranch].self, forKey: .branches) ?? []
    }
}

struct RelayGitCommitResult: Codable, Hashable, Sendable {
    let ok: Bool
    let sha: String?
    let shortSha: String?
    let branch: String?
    let pushed: Bool?

    init(
        ok: Bool,
        sha: String? = nil,
        shortSha: String? = nil,
        branch: String? = nil,
        pushed: Bool? = nil
    ) {
        self.ok = ok
        self.sha = sha
        self.shortSha = shortSha
        self.branch = branch
        self.pushed = pushed
    }

    enum CodingKeys: String, CodingKey {
        case ok, sha, shortSha, branch, pushed
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ok = try container.decodeIfPresent(Bool.self, forKey: .ok) ?? true
        sha = try container.decodeIfPresent(String.self, forKey: .sha)?.trimmedNonEmpty
        shortSha = try container.decodeIfPresent(String.self, forKey: .shortSha)?.trimmedNonEmpty
            ?? sha.map { String($0.prefix(7)) }
        branch = try container.decodeIfPresent(String.self, forKey: .branch)?.trimmedNonEmpty
        pushed = try container.decodeIfPresent(Bool.self, forKey: .pushed)
    }
}

// MARK: - Worktrees

struct RelayWorktreeDescriptor: Codable, Hashable, Identifiable, Sendable {
    let path: String
    let name: String
    let head: String?
    let branch: String?
    let isMain: Bool
    let isManaged: Bool
    let dirty: Bool
    let added: Int
    let deleted: Int

    var id: String { path }

    init(
        path: String,
        name: String,
        head: String? = nil,
        branch: String? = nil,
        isMain: Bool = false,
        isManaged: Bool = false,
        dirty: Bool = false,
        added: Int = 0,
        deleted: Int = 0
    ) {
        self.path = path
        self.name = name
        self.head = head
        self.branch = branch
        self.isMain = isMain
        self.isManaged = isManaged
        self.dirty = dirty
        self.added = added
        self.deleted = deleted
    }

    enum CodingKeys: String, CodingKey {
        case path, name, head, branch, isMain, isManaged, dirty, added, deleted
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        path = try container.decode(String.self, forKey: .path)
        name = try container.decodeIfPresent(String.self, forKey: .name)?.trimmedNonEmpty
            ?? URL(fileURLWithPath: path).lastPathComponent
        head = try container.decodeIfPresent(String.self, forKey: .head)?.trimmedNonEmpty
        branch = try container.decodeIfPresent(String.self, forKey: .branch)?.trimmedNonEmpty
        isMain = try container.decodeIfPresent(Bool.self, forKey: .isMain) ?? false
        isManaged = try container.decodeIfPresent(Bool.self, forKey: .isManaged) ?? false
        dirty = try container.decodeIfPresent(Bool.self, forKey: .dirty) ?? false
        added = try container.decodeIfPresent(Int.self, forKey: .added) ?? 0
        deleted = try container.decodeIfPresent(Int.self, forKey: .deleted) ?? 0
    }
}

struct RelayWorktreesResponse: Codable, Hashable, Sendable {
    let worktrees: [RelayWorktreeDescriptor]

    init(worktrees: [RelayWorktreeDescriptor] = []) {
        self.worktrees = worktrees
    }

    enum CodingKeys: String, CodingKey {
        case worktrees
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        worktrees = try container.decodeIfPresent([RelayWorktreeDescriptor].self, forKey: .worktrees) ?? []
    }
}

struct RelayWorktreeCreateResponse: Codable, Hashable, Sendable {
    let worktree: RelayWorktreeDescriptor

    init(worktree: RelayWorktreeDescriptor) {
        self.worktree = worktree
    }
}

// MARK: - Git API Protocol

/// Transport-agnostic contract for `relayd`'s git inspection and mutation endpoints.
/// `CodexClient` conforms in production; tests and SwiftUI previews can substitute stubs.
protocol RelayGitAPI: AnyObject {
    func fetchGitStatus(path: String) async throws -> RelayGitStatusResponse
    func fetchGitDiff(path: String, mode: RelayGitDiffMode, file: String?) async throws -> RelayGitDiffResponse
    func fetchGitCommits(path: String, limit: Int) async throws -> RelayGitCommitsResponse
    func fetchGitCommitDiff(path: String, sha: String) async throws -> RelayGitDiffResponse
    func fetchGitBranches(path: String) async throws -> RelayGitBranchesResponse
    func checkoutGitBranch(path: String, branch: String, create: Bool) async throws
    func discardGitFiles(path: String, files: [String]) async throws
    func commitGitChanges(path: String, message: String, stageAll: Bool, push: Bool) async throws -> RelayGitCommitResult
}

extension RelayGitAPI {
    func fetchGitDiff(path: String, mode: RelayGitDiffMode) async throws -> RelayGitDiffResponse {
        try await fetchGitDiff(path: path, mode: mode, file: nil)
    }

    func fetchGitCommits(path: String) async throws -> RelayGitCommitsResponse {
        try await fetchGitCommits(path: path, limit: 30)
    }
}
