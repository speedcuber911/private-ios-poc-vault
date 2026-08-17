import Foundation

struct CodexWorkspace: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let path: String?
    let summary: String?
    let isDefault: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case workspaceId
        case slug
        case name
        case title
        case path
        case rootPath
        case summary
        case description
        case isDefault
        case defaultWorkspace = "default"
    }

    init(
        id: String,
        name: String,
        path: String? = nil,
        summary: String? = nil,
        isDefault: Bool = false
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.summary = summary
        self.isDefault = isDefault
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let path = try container.decodeLooseStringIfPresent(forKey: .path)
        let rootPath = try container.decodeLooseStringIfPresent(forKey: .rootPath)
        let name = try container.decodeLooseStringIfPresent(forKey: .name)
        let title = try container.decodeLooseStringIfPresent(forKey: .title)
        let workspaceID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateWorkspaceID = try container.decodeLooseStringIfPresent(forKey: .workspaceId)
        let slug = try container.decodeLooseStringIfPresent(forKey: .slug)
        let decodedPath = path ?? rootPath
        let decodedName = name ?? title
        let decodedID = workspaceID
            ?? alternateWorkspaceID
            ?? slug
            ?? decodedPath
            ?? decodedName

        guard let id = decodedID?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Workspace is missing an id.")
            )
        }

        self.id = id
        self.path = decodedPath?.trimmedNonEmpty
        self.name = decodedName?.trimmedNonEmpty
            ?? decodedPath.map { URL(fileURLWithPath: $0).lastPathComponent }
            ?? id
        let summary = try container.decodeLooseStringIfPresent(forKey: .summary)
        let description = try container.decodeLooseStringIfPresent(forKey: .description)
        let isDefault = try container.decodeIfPresent(Bool.self, forKey: .isDefault)
        let defaultWorkspace = try container.decodeIfPresent(Bool.self, forKey: .defaultWorkspace)
        self.summary = summary ?? description
        self.isDefault = isDefault ?? defaultWorkspace ?? false
    }

    var detailText: String {
        if let path, !path.isEmpty {
            return path
        }
        if let summary, !summary.isEmpty {
            return summary
        }
        return id
    }
}

struct CodexWorkspaceDirectoryListing: Decodable, Hashable {
    let rootPath: String
    let currentPath: String
    let relativePath: String?
    let parentPath: String?
    let selectedWorkspace: CodexWorkspace?
    let entries: [CodexWorkspaceDirectoryEntry]
    /// True when the server bounded this listing (`/v1/codex/fs/list` pagination).
    let truncated: Bool
    let total: Int?
    let offset: Int?
    let limit: Int?

    enum CodingKeys: String, CodingKey {
        case rootPath
        case currentPath
        case relativePath
        case parentPath
        case selectedWorkspace
        case entries
        case truncated
        case total
        case offset
        case limit
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.rootPath = try container.decodeLooseStringIfPresent(forKey: .rootPath) ?? ""
        self.currentPath = try container.decodeLooseStringIfPresent(forKey: .currentPath) ?? rootPath
        self.relativePath = try container.decodeLooseStringIfPresent(forKey: .relativePath)
        self.parentPath = try container.decodeLooseStringIfPresent(forKey: .parentPath)
        self.selectedWorkspace = try container.decodeIfPresent(CodexWorkspace.self, forKey: .selectedWorkspace)
        self.entries = (try? container.decodeIfPresent([CodexWorkspaceDirectoryEntry].self, forKey: .entries)) ?? []
        self.truncated = (try? container.decodeIfPresent(Bool.self, forKey: .truncated)) ?? false
        self.total = try? container.decodeIntegerIfPresent(forKey: .total)
        self.offset = try? container.decodeIntegerIfPresent(forKey: .offset)
        self.limit = try? container.decodeIntegerIfPresent(forKey: .limit)
    }

    var displayPath: String {
        relativePath?.trimmedNonEmpty ?? currentPath
    }

    var upNavigationPath: String? {
        if let parentPath {
            return parentPath
        }

        let trimmedCurrentPath = currentPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedRootPath = rootPath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedCurrentPath.isEmpty,
              !trimmedRootPath.isEmpty,
              trimmedCurrentPath != trimmedRootPath else {
            return nil
        }

        let parentPath = URL(fileURLWithPath: trimmedCurrentPath).deletingLastPathComponent().path
        guard parentPath == trimmedRootPath || parentPath.hasPrefix("\(trimmedRootPath)/") else {
            return nil
        }
        return parentPath
    }
}

/// Coarse viewer routing for file entries, inferred from the server MIME hint plus the
/// filename extension. Drives the per-type glyph and (later) the read-only file viewer.
enum CodexFileCategory: String, Hashable {
    case code
    case text
    case markdown
    case image
    case pdf
    case binary
}

struct CodexWorkspaceDirectoryEntry: Decodable, Hashable, Identifiable {
    enum Kind: String, Codable, Hashable {
        case dir
        case file
    }

    let name: String
    /// Legacy `workspace-dirs` responses omit `kind`; every entry there is a directory.
    let kind: Kind
    let path: String
    let relativePath: String?
    let workspaceId: String?
    let workspaceName: String?
    let hasGit: Bool
    let isRegistered: Bool
    let size: Int64?
    let mtime: Date?
    let mime: String?
    let isText: Bool?
    let readDenied: Bool

    enum CodingKeys: String, CodingKey {
        case name
        case kind
        case path
        case relativePath
        case workspaceId
        case workspaceName
        case hasGit
        case isRegistered
        case size
        case mtime
        case mime
        case isText
        case readDenied
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let path = try container.decodeLooseStringIfPresent(forKey: .path) ?? ""
        self.path = path
        self.name = try container.decodeLooseStringIfPresent(forKey: .name)
            ?? URL(fileURLWithPath: path).lastPathComponent
        let rawKind = try container.decodeLooseStringIfPresent(forKey: .kind)?.lowercased()
        self.kind = rawKind.flatMap(Kind.init(rawValue:)) ?? .dir
        self.relativePath = try container.decodeLooseStringIfPresent(forKey: .relativePath)
        self.workspaceId = try container.decodeLooseStringIfPresent(forKey: .workspaceId)
        self.workspaceName = try container.decodeLooseStringIfPresent(forKey: .workspaceName)
        self.hasGit = (try container.decodeIfPresent(Bool.self, forKey: .hasGit)) ?? false
        self.isRegistered = (try container.decodeIfPresent(Bool.self, forKey: .isRegistered)) ?? false
        self.size = (try? container.decodeIntegerIfPresent(forKey: .size)).flatMap { $0.map(Int64.init) }
        self.mtime = try? container.decodeLossyDateIfPresent(forKey: .mtime)
        self.mime = try container.decodeLooseStringIfPresent(forKey: .mime)
        self.isText = try? container.decodeIfPresent(Bool.self, forKey: .isText)
        self.readDenied = (try? container.decodeIfPresent(Bool.self, forKey: .readDenied)) ?? false
    }

    var id: String {
        path
    }

    var displayName: String {
        name.trimmedNonEmpty ?? URL(fileURLWithPath: path).lastPathComponent
    }

    var detailText: String {
        workspaceName?.trimmedNonEmpty
            ?? relativePath?.trimmedNonEmpty
            ?? path
    }

    var isDirectory: Bool {
        kind == .dir
    }

    /// Human-readable size for file rows ("1.2 MB"); nil for directories or unsized entries.
    var sizeLabel: String? {
        guard kind == .file, let size else { return nil }
        return ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
    }

    /// Human-readable modification time; nil when the server sent none.
    var mtimeLabel: String? {
        guard let mtime else { return nil }
        return Self.mtimeFormatter.string(from: mtime)
    }

    var fileCategory: CodexFileCategory {
        // Servers send parameterized MIME values ("text/markdown; charset=utf-8"); strip
        // the parameters so the exact-match checks below see the bare type.
        let rawMime = mime?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let mimeValue = rawMime
            .split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
        let fileExtension = URL(fileURLWithPath: displayName).pathExtension.lowercased()

        if mimeValue.hasPrefix("image/") || Self.imageExtensions.contains(fileExtension) {
            return .image
        }
        if mimeValue == "application/pdf" || fileExtension == "pdf" {
            return .pdf
        }
        if mimeValue == "text/markdown" || Self.markdownExtensions.contains(fileExtension) {
            return .markdown
        }
        if Self.codeMimeTypes.contains(mimeValue) || Self.codeExtensions.contains(fileExtension) {
            return .code
        }
        if mimeValue.hasPrefix("text/") || Self.textExtensions.contains(fileExtension) || isText == true {
            return .text
        }
        return .binary
    }

    private static let imageExtensions: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff", "svg", "ico"
    ]

    private static let markdownExtensions: Set<String> = ["md", "markdown", "mdown"]

    private static let codeExtensions: Set<String> = [
        "swift", "m", "mm", "h", "c", "cc", "cpp", "hpp", "js", "jsx", "mjs", "cjs", "ts", "tsx",
        "py", "rb", "go", "rs", "java", "kt", "kts", "sh", "bash", "zsh", "pl", "php", "sql",
        "json", "yaml", "yml", "toml", "xml", "html", "htm", "css", "scss", "less", "pbxproj"
    ]

    private static let codeMimeTypes: Set<String> = [
        "application/json", "application/javascript", "application/xml", "application/x-sh",
        "application/x-yaml", "application/yaml", "application/toml", "text/javascript",
        "text/html", "text/css", "text/x-python", "text/x-swift", "text/x-c"
    ]

    private static let textExtensions: Set<String> = [
        "txt", "text", "log", "csv", "tsv", "env", "cfg", "conf", "ini", "plist", "lock",
        "gitignore", "gitattributes", "editorconfig"
    ]

    private static let mtimeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()
}

enum CodexProvider: String, CaseIterable, Identifiable, Codable {
    case codex
    case claude
    case cursor
    case kimi
    case bedrock
    case azure

    var id: String { rawValue }

    static let defaultProvider = CodexProvider.codex

    init(rawProvider: String?) {
        let normalized = rawProvider?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch normalized {
        case "bedrock":
            self = .bedrock
        case "azure", "azure-openai":
            self = .azure
        case "claude", "anthropic":
            self = .claude
        case "cursor", "cursor-agent":
            self = .cursor
        case "kimi", "kimi-code", "moonshot":
            self = .kimi
        case "codex", "openai", .none:
            self = .codex
        default:
            self = .codex
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawProvider: try? container.decode(String.self))
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var displayName: String {
        switch self {
        case .codex:
            return "Codex"
        case .claude:
            return "Claude Code"
        case .cursor:
            return "Cursor"
        case .kimi:
            return "Kimi K3"
        case .bedrock:
            return "Bedrock"
        case .azure:
            return "Azure"
        }
    }

    var defaultModel: String {
        ""
    }

    var modelOptions: [String] {
        []
    }

    var defaultReasoningEffort: CodexReasoningEffort {
        switch self {
        case .codex:
            return .xhigh
        case .claude, .cursor, .kimi, .bedrock, .azure:
            return .high
        }
    }

    var reasoningEffortOptions: [CodexReasoningEffort] {
        CodexReasoningEffort.allCases
    }
}

/// Provider readiness measured by relayd under the exact isolated account that
/// executes tasks. A linked computer and an installed CLI are not enough: the
/// selected provider must also have usable credentials in that runner home.
struct RelayHarnessStatus: Decodable, Hashable, Identifiable {
    let provider: CodexProvider
    let installed: Bool
    let version: String?
    let loggedIn: Bool?
    let authKind: String
    let taskControls: RelayHarnessTaskControls?

    var id: CodexProvider { provider }

    private enum CodingKeys: String, CodingKey {
        case provider
        case installed
        case version
        case loggedIn
        case authKind
        case taskControls
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(CodexProvider.self, forKey: .provider)
        installed = (try? container.decodeIfPresent(Bool.self, forKey: .installed)) ?? false
        version = try container.decodeIfPresent(String.self, forKey: .version)?.trimmedNonEmpty
        loggedIn = try container.decodeIfPresent(Bool.self, forKey: .loggedIn)
        authKind = (try container.decodeIfPresent(String.self, forKey: .authKind))?.trimmedNonEmpty ?? "unknown"
        taskControls = try container.decodeIfPresent(RelayHarnessTaskControls.self, forKey: .taskControls)
    }

    var isConfirmedUnavailable: Bool {
        !installed || loggedIn == false
    }

    var shortStatus: String {
        if !installed { return "Not installed" }
        if loggedIn == false { return "Needs connection" }
        if loggedIn == true { return "Connected" }
        return "Status unknown"
    }

    var actionMessage: String? {
        if !installed {
            return "\(provider.displayName) is not installed on this computer."
        }
        guard loggedIn == false else { return nil }
        if provider == .cursor {
            return "Run cursor-agent login on the computer, then try again."
        }
        if provider == .kimi {
            return "Run kimi login on the computer, then try again."
        }
        return "Run relay sync-auth on your Mac to connect \(provider.displayName), then try again."
    }
}

struct RelayHarnessTaskControls: Decodable, Hashable {
    let model: Bool
    let reasoningEffort: Bool
    let permissionModes: [String]
    let approvalPolicies: [String]

    private enum CodingKeys: String, CodingKey {
        case model
        case reasoningEffort
        case permissionModes
        case approvalPolicies
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        model = (try container.decodeIfPresent(Bool.self, forKey: .model)) ?? false
        reasoningEffort = (try container.decodeIfPresent(Bool.self, forKey: .reasoningEffort)) ?? false
        permissionModes = (try container.decodeIfPresent([String].self, forKey: .permissionModes)) ?? []
        approvalPolicies = (try container.decodeIfPresent([String].self, forKey: .approvalPolicies)) ?? []
    }
}

/// Public metadata returned by Relay's provider-scoped skill discovery endpoint.
/// File paths and skill bodies deliberately stay on the runner; the phone only needs
/// enough information to search and select a real installed skill.
struct CodexSkillDescriptor: Decodable, Hashable, Identifiable {
    let id: String
    let name: String
    let title: String
    let provider: CodexProvider
    let group: String
    let kind: String?
    let description: String

    var isCommand: Bool { kind == "command" }
}

/// Claude Code's non-destructive permission modes supported by the current Relay job
/// contract. `bypassPermissions` remains server/operator-only and is never offered by
/// the phone as an ordinary convenience setting.
enum RelayClaudePermissionMode: String, CaseIterable, Identifiable, Codable {
    case manual
    case plan
    case acceptEdits
    case dontAsk
    case auto

    var id: String { rawValue }

    /// Older Relay runners called Claude's interactive default mode `default`,
    /// while current Claude Code calls it `manual`. Keep the legacy wire value so
    /// a freshly updated phone can still submit work to a runner that has not yet
    /// upgraded; current runners normalize it back to `manual` before execution.
    var apiValue: String {
        switch self {
        case .manual:
            return "default"
        case .plan, .acceptEdits, .dontAsk, .auto:
            return rawValue
        }
    }

    var label: String {
        switch self {
        case .manual:
            return "Ask every time"
        case .plan:
            return "Plan only"
        case .acceptEdits:
            return "Accept edits"
        case .dontAsk:
            return "Deny prompts"
        case .auto:
            return "Auto"
        }
    }

    var detail: String {
        switch self {
        case .manual:
            return "Pause Claude Code and ask this phone when a tool needs approval."
        case .plan:
            return "Inspect and plan without changing files."
        case .acceptEdits:
            return "Allow file edits; other tools keep Claude's normal rules."
        case .dontAsk:
            return "Reject tools that would need an interactive approval."
        case .auto:
            return "Let the installed Claude Code choose its automatic policy."
        }
    }
}

enum RelayCodexApprovalPolicy: String, CaseIterable, Identifiable, Codable {
    case onRequest = "on-request"
    case untrusted
    case never

    var id: String { rawValue }
    var label: String {
        switch self {
        case .onRequest: return "Ask when needed"
        case .untrusted: return "Ask for untrusted commands"
        case .never: return "Never ask"
        }
    }
    var detail: String {
        switch self {
        case .onRequest: return "Codex decides when an exact command or file change needs your approval."
        case .untrusted: return "Known-safe reads can run; other commands pause for approval."
        case .never: return "Codex cannot ask. Operations outside the workspace sandbox are rejected."
        }
    }
}

/// The slash fragment touching the current caret. A command starts at the beginning of
/// the draft or after whitespace, so `/` discovery works in a later paragraph without
/// treating URL and file-path slashes as commands.
struct RelaySlashContext: Equatable {
    let range: NSRange
    let query: String

    static func find(in text: String, selection: NSRange) -> RelaySlashContext? {
        let value = text as NSString
        guard selection.length == 0, selection.location >= 0, selection.location <= value.length else {
            return nil
        }

        let whitespace = CharacterSet.whitespacesAndNewlines
        var start = selection.location
        while start > 0 {
            let scalar = value.character(at: start - 1)
            guard let unicode = UnicodeScalar(scalar), !whitespace.contains(unicode) else { break }
            start -= 1
        }
        guard start < value.length, value.substring(with: NSRange(location: start, length: 1)) == "/" else {
            return nil
        }
        if start > 0 {
            let previous = value.character(at: start - 1)
            guard let scalar = UnicodeScalar(previous), whitespace.contains(scalar) else { return nil }
        }

        var end = selection.location
        while end < value.length {
            let scalar = value.character(at: end)
            guard let unicode = UnicodeScalar(scalar), !whitespace.contains(unicode) else { break }
            end += 1
        }

        let typedRange = NSRange(location: start, length: selection.location - start)
        let typed = value.substring(with: typedRange)
        guard !typed.dropFirst().contains("/") else { return nil }
        return RelaySlashContext(
            range: NSRange(location: start, length: end - start),
            query: String(typed.dropFirst()).lowercased()
        )
    }
}

enum RelayInteractionMode: String, CaseIterable, Codable, Identifiable {
    case chat
    case task

    var id: String { rawValue }

    var label: String {
        switch self {
        case .chat:
            return "Chat"
        case .task:
            return "Task"
        }
    }
}

struct CodexModelOptions: Codable, Hashable {
    let temperature: Double?
    let maxTokens: Int?
}

struct CodexModelDescriptor: Decodable, Hashable, Identifiable {
    let id: String
    let label: String
    let provider: CodexProvider
    let modes: [RelayInteractionMode]
    let azureDeployment: String?
    /// The model id/alias to send to createJob for task entries (e.g. "opus", "gpt-5-codex").
    /// nil means "let the runner use its default".
    let taskModel: String?
    let defaultOptions: CodexModelOptions?
    let effortLevels: [String]

    enum CodingKeys: String, CodingKey {
        case id
        case label
        case provider
        case modes
        case azureDeployment
        case taskModel
        case defaultOptions
        case effortLevels
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decode(String.self, forKey: .id)
        self.label = (try container.decodeIfPresent(String.self, forKey: .label)) ?? id
        self.provider = try container.decode(CodexProvider.self, forKey: .provider)
        self.modes = (try container.decodeIfPresent([RelayInteractionMode].self, forKey: .modes)) ?? []
        self.azureDeployment = try container.decodeIfPresent(String.self, forKey: .azureDeployment)
        self.taskModel = try container.decodeIfPresent(String.self, forKey: .taskModel)
        self.defaultOptions = try container.decodeIfPresent(CodexModelOptions.self, forKey: .defaultOptions)
        self.effortLevels = (try container.decodeIfPresent([String].self, forKey: .effortLevels)) ?? []
    }

    var providerBadge: String {
        provider.displayName
    }

    func supports(_ mode: RelayInteractionMode) -> Bool {
        modes.contains(mode)
    }
}

enum CodexJobStatus: Hashable, Codable {
    case queued
    case running
    case waitingForApproval
    case succeeded
    case failed
    case canceling
    case canceled
    case timeout
    case unknown(String)

    init(rawStatus: String?) {
        let normalized = rawStatus?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        switch normalized {
        case "queued", "queue", "pending", "created", "submitted":
            self = .queued
        case "running", "active", "in_progress", "in-progress", "processing":
            self = .running
        case "waiting_for_approval", "waiting-for-approval", "needs_input":
            self = .waitingForApproval
        case "succeeded", "success", "completed", "complete", "done", "passed":
            self = .succeeded
        case "failed", "failure", "errored", "error":
            self = .failed
        case "canceling", "cancelling":
            self = .canceling
        case "canceled", "cancelled":
            self = .canceled
        case "timeout", "timed_out", "timed-out":
            self = .timeout
        case .some(let value) where !value.isEmpty:
            self = .unknown(value)
        default:
            self = .unknown("unknown")
        }
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) {
            self.init(rawStatus: value)
        } else {
            self = .unknown("unknown")
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    var rawValue: String {
        switch self {
        case .queued:
            return "queued"
        case .running:
            return "running"
        case .waitingForApproval:
            return "waiting_for_approval"
        case .succeeded:
            return "succeeded"
        case .failed:
            return "failed"
        case .canceling:
            return "canceling"
        case .canceled:
            return "canceled"
        case .timeout:
            return "timeout"
        case .unknown(let value):
            return value
        }
    }

    var label: String {
        switch self {
        case .queued:
            return "Queued"
        case .running:
            return "Running"
        case .waitingForApproval:
            return "Needs approval"
        case .succeeded:
            return "Succeeded"
        case .failed:
            return "Failed"
        case .canceling:
            return "Canceling"
        case .canceled:
            return "Canceled"
        case .timeout:
            return "Timed out"
        case .unknown(let value):
            return value.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    var isActive: Bool {
        switch self {
        case .queued, .running, .waitingForApproval, .canceling:
            return true
        case .succeeded, .failed, .canceled, .timeout, .unknown:
            return false
        }
    }

    var needsAttention: Bool {
        switch self {
        case .waitingForApproval, .failed, .timeout:
            return true
        case .queued, .running, .succeeded, .canceling, .canceled, .unknown:
            return false
        }
    }
}

struct CodexApprovalResolution: Decodable, Hashable {
    let decision: String
    let decidedAt: Date?
    let message: String?
}

struct CodexApproval: Decodable, Hashable, Identifiable {
    let id: String
    let jobId: String
    let provider: CodexProvider
    let kind: String
    let title: String
    let reason: String?
    let command: String?
    let cwd: String?
    let toolName: String?
    let createdAt: Date?
    let status: String
    let availableDecisions: [String]
    let resolution: CodexApprovalResolution?

    var isPending: Bool { status == "pending" }
}

enum CodexApprovalDecision: String, Encodable {
    case accept
    case acceptForSession
    case decline
    case cancel
}

struct CodexTerminal: Decodable, Hashable, Identifiable {
    let id: String
    let workspaceId: String
    let workspaceName: String
    let status: String
    let createdAt: Date?
    let updatedAt: Date?
    let finishedAt: Date?
    let exitCode: Int?
    let cols: Int
    let rows: Int

    var isRunning: Bool { status == "running" || status == "starting" }
}

enum CodexTerminalStreamEvent: Hashable {
    case snapshot(terminal: CodexTerminal, output: String)
    case output(String)
    case done(CodexTerminal)
}

struct CodexThread: Decodable, Hashable, Identifiable {
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
    let lastJobId: String?
    let lastJobStatus: CodexJobStatus?
    let lastPrompt: String?
    let lastResult: String?
    let lastError: String?
    let hasSessionFile: Bool
    let isSmokeTest: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case mode
        case provider
        case sessionId
        case workspaceId
        case workspaceName
        case cwd
        case path
        case timestamp
        case createdAt
        case updatedAt
        case lastUsedAt
        case model
        case jobCount
        case activeJobCount
        case lastJobId
        case lastJobStatus
        case lastPrompt
        case lastResult
        case lastError
        case hasSessionFile
        case isSmokeTest
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let sessionID = try container.decodeLooseStringIfPresent(forKey: .sessionId)
        guard let id = (primaryID ?? sessionID)?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Thread is missing an id.")
            )
        }

        let cwd = try container.decodeLooseStringIfPresent(forKey: .cwd)
        let path = try container.decodeLooseStringIfPresent(forKey: .path)
        let timestamp = try container.decodeLossyDateIfPresent(forKey: .timestamp)
        let createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        let updatedAt = try container.decodeLossyDateIfPresent(forKey: .updatedAt)
        let lastUsedAt = try container.decodeLossyDateIfPresent(forKey: .lastUsedAt)

        self.id = id
        self.mode = (try container.decodeIfPresent(RelayInteractionMode.self, forKey: .mode)) ?? .task
        self.provider = (try container.decodeIfPresent(CodexProvider.self, forKey: .provider)) ?? .defaultProvider
        self.sessionId = sessionID?.trimmedNonEmpty ?? id
        self.workspaceId = try container.decodeLooseStringIfPresent(forKey: .workspaceId)
        self.workspaceName = try container.decodeLooseStringIfPresent(forKey: .workspaceName)
        self.cwd = cwd ?? path
        self.timestamp = timestamp ?? createdAt
        self.updatedAt = updatedAt ?? lastUsedAt ?? timestamp ?? createdAt
        self.model = try container.decodeLooseStringIfPresent(forKey: .model)
        self.jobCount = (try container.decodeIntegerIfPresent(forKey: .jobCount)) ?? 0
        self.activeJobCount = (try container.decodeIntegerIfPresent(forKey: .activeJobCount)) ?? 0
        self.lastJobId = try container.decodeLooseStringIfPresent(forKey: .lastJobId)
        self.lastJobStatus = try container.decodeIfPresent(CodexJobStatus.self, forKey: .lastJobStatus)
        self.lastPrompt = try container.decodeLooseStringIfPresent(forKey: .lastPrompt)
        self.lastResult = try container.decodeLooseStringIfPresent(forKey: .lastResult)
        self.lastError = try container.decodeLooseStringIfPresent(forKey: .lastError)
        self.hasSessionFile = (try container.decodeIfPresent(Bool.self, forKey: .hasSessionFile)) ?? true
        self.isSmokeTest = (try container.decodeIfPresent(Bool.self, forKey: .isSmokeTest)) ?? false
    }

    var displayTitle: String {
        Self.threadTitle(from: lastPrompt)
            ?? Self.threadTitle(from: lastResult)
            ?? Self.threadTitle(from: lastError)
            ?? workspaceLabel
    }

    var workspaceLabel: String {
        workspaceName?.trimmedNonEmpty ?? workspaceId?.trimmedNonEmpty ?? provider.displayName
    }

    var shortID: String {
        String(sessionId.prefix(12))
    }

    var previewText: String {
        lastPrompt?.trimmedNonEmpty
            ?? lastResult?.trimmedNonEmpty
            ?? lastError?.trimmedNonEmpty
            ?? cwd?.trimmedNonEmpty
            ?? sessionId
    }

    var feedPreview: String {
        Self.previewSummary(
            lastResult?.trimmedNonEmpty
                ?? lastError?.trimmedNonEmpty
                ?? lastPrompt?.trimmedNonEmpty
                ?? cwd?.trimmedNonEmpty
                ?? sessionId
        )
    }

    var hasActiveJobs: Bool {
        activeJobCount > 0 || lastJobStatus?.isActive == true
    }

    static func threadTitle(from value: String?) -> String? {
        guard var text = normalizedThreadText(value) else { return nil }
        if let pullRequestTitle = githubPullRequestTitle(in: text) {
            return pullRequestTitle
        }
        text = stripPromptLeadIns(text)

        let lowered = text.lowercased()
        if lowered.hasPrefix("read-only security audit") {
            return "Read-only security audit"
        }
        if lowered.contains("loading spinner"), lowered.contains("2 pr") {
            return "Review loading-spinner PRs"
        }
        if lowered.contains("shlok"), lowered.contains("2 pr") {
            return "Review Shlok's PRs"
        }

        return compactTitle(text)
    }

    static func previewSummary(_ value: String?) -> String {
        guard let value = value?.trimmedNonEmpty else { return "" }
        return CodexMarkdownParser.plainText(from: value)
    }

    private static func githubPullRequestTitle(in value: String) -> String? {
        let pattern = #"https?://github\.com/[^/\s]+/([^/\s]+)/pull/([0-9]+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else { return nil }
        let nsRange = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, range: nsRange),
              match.numberOfRanges >= 3,
              let repoRange = Range(match.range(at: 1), in: value),
              let numberRange = Range(match.range(at: 2), in: value) else {
            return nil
        }
        return "\(value[repoRange]) PR #\(value[numberRange])"
    }

    private static func stripPromptLeadIns(_ value: String) -> String {
        var text = value
        replacePrefix("Review and merge Hey parikshit, I was adding these ", in: &text, with: "Review and merge ")
        replacePrefix("Hey parikshit can you ", in: &text)
        replacePrefix("Hey parikshit, can you ", in: &text)
        replacePrefix("Hey parikshit, ", in: &text)
        replacePrefix("Hey parikshit ", in: &text)
        return text
    }

    private static func replacePrefix(_ prefix: String, in text: inout String, with replacement: String = "") {
        guard let range = text.range(of: prefix, options: [.caseInsensitive, .anchored]) else { return }
        text.replaceSubrange(range, with: replacement)
    }

    private static func compactTitle(_ value: String) -> String? {
        var text = value.replacingOccurrences(
            of: #"https?://\S+"#,
            with: "",
            options: .regularExpression
        )
        text = normalizedThreadText(text) ?? text
        guard !text.isEmpty else { return nil }

        let limit = 76
        guard text.count > limit else { return text }
        return "\(text.prefix(limit).trimmingCharacters(in: .whitespacesAndNewlines))..."
    }

    private static func normalizedThreadText(_ value: String?) -> String? {
        value?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
            .trimmedNonEmpty
    }
}

struct CodexThreadDetail: Decodable, Hashable {
    let thread: CodexThread
    let messages: [CodexThreadMessage]
    let jobs: [CodexJob]

    enum CodingKeys: String, CodingKey {
        case thread
        case messages
        case jobs
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.thread = try container.decode(CodexThread.self, forKey: .thread)
        self.messages = (try? container.decodeIfPresent([CodexThreadMessage].self, forKey: .messages)) ?? []
        self.jobs = (try? container.decodeIfPresent([CodexJob].self, forKey: .jobs)) ?? []
    }
}

enum CodexThreadMessageRole: String, Decodable, Hashable {
    case user
    case assistant
    case status

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let rawValue = (try? container.decode(String.self))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        switch rawValue {
        case "user":
            self = .user
        case "assistant", "codex", "claude":
            self = .assistant
        default:
            self = .status
        }
    }
}

struct CodexThreadMessage: Decodable, Hashable, Identifiable {
    let role: CodexThreadMessageRole
    let timestamp: Date?
    let text: String

    enum CodingKeys: String, CodingKey {
        case role
        case timestamp
        case createdAt
        case text
        case content
        case message
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.role = (try? container.decodeIfPresent(CodexThreadMessageRole.self, forKey: .role)) ?? .status
        let timestamp = try container.decodeLossyDateIfPresent(forKey: .timestamp)
        let createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        let text = try container.decodeLooseStringIfPresent(forKey: .text)
        let content = try container.decodeLooseStringIfPresent(forKey: .content)
        let message = try container.decodeLooseStringIfPresent(forKey: .message)
        self.timestamp = timestamp ?? createdAt
        let resolvedText = text ?? content ?? message ?? ""
        self.text = resolvedText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var id: String {
        let timestampValue = timestamp?.timeIntervalSince1970.description ?? "undated"
        return "\(role.rawValue)-\(timestampValue)-\(text)"
    }
}

struct CodexTranscriptionResponse: Decodable, Hashable {
    let text: String
    let provider: String?
    let model: String?
    let audioBytes: Int?
    let durationMilliseconds: Int?
}

struct CodexThreadFeedItem: Hashable, Identifiable {
    enum Source: Hashable {
        case thread(CodexThread)
        case pendingJob(CodexJob)
    }

    let source: Source

    var id: String {
        switch source {
        case .thread(let thread):
            return "thread-\(thread.sessionId)"
        case .pendingJob(let job):
            return "job-\(job.id)"
        }
    }

    var title: String {
        switch source {
        case .thread(let thread):
            return thread.displayTitle
        case .pendingJob(let job):
            return CodexThread.threadTitle(from: job.displayPrompt) ?? job.displayPrompt
        }
    }

    var preview: String {
        switch source {
        case .thread(let thread):
            return thread.feedPreview
        case .pendingJob(let job):
            if let output = job.displayOutput?.trimmedNonEmpty {
                return CodexThread.previewSummary(output)
            }
            if job.status.isActive {
                return "Starting on EC2. The thread will attach as soon as \(job.provider.displayName) opens a session."
            }
            return CodexThread.previewSummary(job.errorMessage?.trimmedNonEmpty)
                .trimmedNonEmpty
                ?? "No thread session was captured for this run."
        }
    }

    var workspaceLabel: String {
        switch source {
        case .thread(let thread):
            return thread.workspaceLabel
        case .pendingJob(let job):
            return job.workspaceName?.trimmedNonEmpty ?? job.workspaceId?.trimmedNonEmpty ?? job.provider.displayName
        }
    }

    var workspaceID: String? {
        switch source {
        case .thread(let thread):
            return thread.workspaceId
        case .pendingJob(let job):
            return job.workspaceId
        }
    }

    var updatedAt: Date? {
        switch source {
        case .thread(let thread):
            return thread.updatedAt ?? thread.timestamp
        case .pendingJob(let job):
            return job.updatedAt ?? job.createdAt
        }
    }

    var status: CodexJobStatus? {
        switch source {
        case .thread(let thread):
            return thread.lastJobStatus
        case .pendingJob(let job):
            return job.status
        }
    }

    var jobID: String? {
        switch source {
        case .thread(let thread):
            return thread.lastJobId
        case .pendingJob(let job):
            return job.id
        }
    }

    var sessionID: String? {
        switch source {
        case .thread(let thread):
            return thread.sessionId
        case .pendingJob:
            return nil
        }
    }

    var isPendingSession: Bool {
        if case .pendingJob = source {
            return true
        }
        return false
    }

    var isSmokeTest: Bool {
        if case .thread(let thread) = source {
            return thread.isSmokeTest
        }
        return false
    }

    var shortID: String {
        switch source {
        case .thread(let thread):
            return thread.shortID
        case .pendingJob(let job):
            return String(job.id.prefix(12))
        }
    }

    var isActive: Bool {
        switch source {
        case .thread(let thread):
            return thread.hasActiveJobs
        case .pendingJob(let job):
            return job.status.isActive
        }
    }

    static func makeFeed(threads: [CodexThread], jobs: [CodexJob], workspaceID: String? = nil) -> [CodexThreadFeedItem] {
        let visibleThreads = threads.filter {
            !$0.isSmokeTest && matchesWorkspace($0.workspaceId, selectedWorkspaceID: workspaceID)
        }
        // De-duplicate against every loaded thread, including hidden smoke-test rows. A
        // job with no discovered thread is still real history and must remain visible
        // after it succeeds or is cancelled, not only while active/failed.
        let threadSessionIDs = Set(threads.map(\.sessionId))
        let threadJobIDs = Set(threads.compactMap(\.lastJobId))
        let threadItems = visibleThreads.map { CodexThreadFeedItem(source: .thread($0)) }
        let standaloneJobItems = jobs
            .filter { job in
                guard matchesWorkspace(job.workspaceId, selectedWorkspaceID: workspaceID) else { return false }
                if threadJobIDs.contains(job.id) { return false }
                if let sessionID = job.threadSessionId,
                   threadSessionIDs.contains(sessionID) {
                    return false
                }
                return true
            }
            .map { CodexThreadFeedItem(source: .pendingJob($0)) }

        return (standaloneJobItems + threadItems).sorted {
            ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast)
        }
    }

    static func composeStatusItem(
        selectedSessionID: String?,
        threads: [CodexThread],
        jobs: [CodexJob],
        workspaceID: String? = nil
    ) -> CodexThreadFeedItem? {
        let feed = makeFeed(threads: threads, jobs: jobs, workspaceID: workspaceID)
        if let selectedSessionID,
           let selectedItem = feed.first(where: { $0.sessionID == selectedSessionID }) {
            return selectedItem
        }
        return feed.first { $0.isActive }
    }

    private static func matchesWorkspace(_ itemWorkspaceID: String?, selectedWorkspaceID: String?) -> Bool {
        guard let selectedWorkspaceID = selectedWorkspaceID?.trimmedNonEmpty else {
            return true
        }
        return itemWorkspaceID == selectedWorkspaceID
    }
}

enum CodexReasoningEffort: String, CaseIterable, Identifiable, Codable {
    case low
    case medium
    case high
    case xhigh

    var id: String { rawValue }

    var label: String {
        switch self {
        case .low:
            return "Low"
        case .medium:
            return "Medium"
        case .high:
            return "High"
        case .xhigh:
            return "XHigh"
        }
    }
}

enum CodexDisplayLimits {
    static let answerCharacters = 24_000
    static let promptCharacters = 12_000
    static let rawActivityCharacters = 8_000
}

struct CodexTextPreview: Equatable {
    let text: String
    let originalCharacterCount: Int
    let isTruncated: Bool

    var hasText: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func bounded(_ value: String?, limit: Int, emptyText: String) -> CodexTextPreview {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !trimmed.isEmpty else {
            return CodexTextPreview(text: emptyText, originalCharacterCount: 0, isTruncated: false)
        }

        let originalCount = trimmed.count
        guard originalCount > limit else {
            return CodexTextPreview(text: trimmed, originalCharacterCount: originalCount, isTruncated: false)
        }

        let suffix = "\n\n[Preview truncated. Open the full activity log only when needed.]"
        return CodexTextPreview(
            text: String(trimmed.prefix(limit)) + suffix,
            originalCharacterCount: originalCount,
            isTruncated: true
        )
    }
}

struct CodexJob: Decodable, Hashable, Identifiable {
    let id: String
    let provider: CodexProvider
    let workspaceId: String?
    let workspaceName: String?
    let status: CodexJobStatus
    let prompt: String?
    let createdAt: Date?
    let updatedAt: Date?
    let startedAt: Date?
    let completedAt: Date?
    let timeoutMs: Int?
    let exitCode: Int?
    let stdout: String?
    let stderr: String?
    let result: String?
    let errorMessage: String?
    let durationMs: Int?
    let timedOut: Bool
    let certSubject: String?
    let model: String?
    let reasoningEffort: String?
    let permissionMode: String?
    let approvalPolicy: String?
    let skills: [String]
    let execution: CodexExecutionReceipt?
    let logsIncluded: String?
    let sessionId: String?
    let resumeSessionId: String?
    let stdoutBytes: Int?
    let stderrBytes: Int?
    let resultBytes: Int?
    let stdoutTruncated: Bool
    let stderrTruncated: Bool
    let resultTruncated: Bool
    let attachments: [CodexJobAttachmentReference]
    let artifacts: [CodexJobArtifact]

    enum CodingKeys: String, CodingKey {
        case id
        case jobId
        case provider
        case workspace
        case workspaceId
        case workspaceName
        case status
        case state
        case prompt
        case createdAt
        case updatedAt
        case startedAt
        case completedAt
        case finishedAt
        case timeoutMs
        case timeout
        case exitCode
        case stdout
        case stderr
        case result
        case output
        case error
        case errorMessage
        case message
        case durationMs
        case timedOut
        case certSubject
        case model
        case reasoningEffort
        case permissionMode
        case approvalPolicy
        case skills
        case execution
        case logsIncluded
        case sessionId
        case resumeSessionId
        case stdoutBytes
        case stderrBytes
        case resultBytes
        case stdoutTruncated
        case stderrTruncated
        case resultTruncated
        case attachments
        case artifacts
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateID = try container.decodeLooseStringIfPresent(forKey: .jobId)
        let decodedID = primaryID ?? alternateID
        guard let id = decodedID?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Job is missing an id.")
            )
        }

        let workspace = try? container.decodeIfPresent(CodexWorkspace.self, forKey: .workspace)
        let status = try container.decodeIfPresent(CodexJobStatus.self, forKey: .status)
        let state = try container.decodeIfPresent(CodexJobStatus.self, forKey: .state)
        let completedAt = try container.decodeLossyDateIfPresent(forKey: .completedAt)
        let finishedAt = try container.decodeLossyDateIfPresent(forKey: .finishedAt)
        let timeoutMs = try container.decodeIfPresent(Int.self, forKey: .timeoutMs)
        let timeout = try container.decodeIntegerIfPresent(forKey: .timeout)
        let result = try container.decodeLooseStringIfPresent(forKey: .result)
        let output = try container.decodeLooseStringIfPresent(forKey: .output)
        let errorMessage = try container.decodeLooseStringIfPresent(forKey: .errorMessage)
        let error = try container.decodeLooseStringIfPresent(forKey: .error)
        let message = try container.decodeLooseStringIfPresent(forKey: .message)

        self.id = id
        self.provider = (try container.decodeIfPresent(CodexProvider.self, forKey: .provider)) ?? .defaultProvider
        self.workspaceId = (try container.decodeLooseStringIfPresent(forKey: .workspaceId))
            ?? workspace?.id
        self.workspaceName = (try container.decodeLooseStringIfPresent(forKey: .workspaceName))
            ?? workspace?.name
        self.status = status ?? state ?? .unknown("unknown")
        self.prompt = try container.decodeLooseStringIfPresent(forKey: .prompt)
        self.createdAt = try container.decodeLossyDateIfPresent(forKey: .createdAt)
        self.updatedAt = try container.decodeLossyDateIfPresent(forKey: .updatedAt)
        self.startedAt = try container.decodeLossyDateIfPresent(forKey: .startedAt)
        self.completedAt = completedAt ?? finishedAt
        self.timeoutMs = timeoutMs ?? timeout
        self.exitCode = try container.decodeIntegerIfPresent(forKey: .exitCode)
        self.stdout = try container.decodeLooseStringIfPresent(forKey: .stdout)
        self.stderr = try container.decodeLooseStringIfPresent(forKey: .stderr)
        self.result = result ?? output
        self.errorMessage = errorMessage ?? error ?? message
        self.durationMs = try container.decodeIntegerIfPresent(forKey: .durationMs)
        self.timedOut = (try container.decodeIfPresent(Bool.self, forKey: .timedOut)) ?? false
        self.certSubject = try container.decodeLooseStringIfPresent(forKey: .certSubject)
        self.model = try container.decodeLooseStringIfPresent(forKey: .model)
        self.reasoningEffort = try container.decodeLooseStringIfPresent(forKey: .reasoningEffort)
        self.permissionMode = try container.decodeLooseStringIfPresent(forKey: .permissionMode)
        self.approvalPolicy = try container.decodeLooseStringIfPresent(forKey: .approvalPolicy)
        self.skills = (try? container.decodeIfPresent([String].self, forKey: .skills)) ?? []
        self.execution = try container.decodeIfPresent(CodexExecutionReceipt.self, forKey: .execution)
        self.logsIncluded = try container.decodeLooseStringIfPresent(forKey: .logsIncluded)
        self.sessionId = try container.decodeLooseStringIfPresent(forKey: .sessionId)
        let resumeSessionID = try container.decodeLooseStringIfPresent(forKey: .resumeSessionId)
        self.resumeSessionId = resumeSessionID
        self.stdoutBytes = try container.decodeIntegerIfPresent(forKey: .stdoutBytes)
        self.stderrBytes = try container.decodeIntegerIfPresent(forKey: .stderrBytes)
        self.resultBytes = try container.decodeIntegerIfPresent(forKey: .resultBytes)
        self.stdoutTruncated = (try container.decodeIfPresent(Bool.self, forKey: .stdoutTruncated)) ?? false
        self.stderrTruncated = (try container.decodeIfPresent(Bool.self, forKey: .stderrTruncated)) ?? false
        self.resultTruncated = (try container.decodeIfPresent(Bool.self, forKey: .resultTruncated)) ?? false
        self.attachments = (try? container.decodeIfPresent([CodexJobAttachmentReference].self, forKey: .attachments)) ?? []
        self.artifacts = (try? container.decodeIfPresent([CodexJobArtifact].self, forKey: .artifacts)) ?? []
    }

    var displayPrompt: String {
        prompt?.trimmedNonEmpty ?? "Untitled \(provider.displayName) job"
    }

    var displayOutput: String? {
        if let result = result?.trimmedNonEmpty,
           let cleaned = CodexOutputCleaner.cleanAnswer(result).trimmedNonEmpty {
            return cleaned
        }
        if case .succeeded = status {
            return nil
        }
        return errorMessage?.trimmedNonEmpty
    }

    var displayOutputPreview: CodexTextPreview {
        CodexTextPreview.bounded(
            displayOutput,
            limit: CodexDisplayLimits.answerCharacters,
            emptyText: ""
        )
    }

    var promptPreview: CodexTextPreview {
        CodexTextPreview.bounded(
            prompt,
            limit: CodexDisplayLimits.promptCharacters,
            emptyText: "No prompt captured."
        )
    }

    var threadSessionId: String? {
        sessionId?.trimmedNonEmpty ?? resumeSessionId?.trimmedNonEmpty
    }

    var hasTruncatedServerOutput: Bool {
        stdoutTruncated || stderrTruncated || resultTruncated
    }

    var rawActivityPreview: CodexTextPreview {
        let sections = [
            ("Saved answer", result),
            ("Stdout", stdout),
            ("Stderr", stderr),
            ("Error", errorMessage)
        ]
        return Self.activityPreview(
            sections: sections,
            limit: CodexDisplayLimits.rawActivityCharacters,
            serverTruncated: hasTruncatedServerOutput
        )
    }

    var rawActivityOutput: String? {
        let parts = [
            result.map { ("Saved answer", $0) },
            stdout.map { ("Stdout", $0) },
            stderr.map { ("Stderr", $0) },
            errorMessage.map { ("Error", $0) }
        ]
        .compactMap { item -> String? in
            guard let (label, value) = item, let trimmed = value.trimmedNonEmpty else { return nil }
            return "## \(label)\n\n\(trimmed)"
        }
        return parts.joined(separator: "\n\n---\n\n").trimmedNonEmpty
    }

    var hasOperationalFields: Bool {
        workspaceId != nil
            || prompt != nil
            || createdAt != nil
            || updatedAt != nil
            || stdout != nil
            || stderr != nil
            || result != nil
            || errorMessage != nil
            || durationMs != nil
            || certSubject != nil
            || logsIncluded != nil
            || sessionId != nil
            || resumeSessionId != nil
            || !attachments.isEmpty
            || !artifacts.isEmpty
            || hasTruncatedServerOutput
            || status != .unknown("unknown")
    }

    private static func activityPreview(
        sections: [(String, String?)],
        limit: Int,
        serverTruncated: Bool
    ) -> CodexTextPreview {
        var rendered = ""

        for (label, value) in sections {
            guard let trimmed = value?.trimmedNonEmpty else { continue }
            let separator = rendered.isEmpty ? "" : "\n\n---\n\n"
            let header = "\(separator)## \(label)\n\n"
            rendered += header + trimmed
        }

        if rendered.trimmedNonEmpty == nil {
            rendered = "No raw activity captured."
        }

        let originalCount = rendered.count
        var didTruncate = serverTruncated

        if originalCount > limit {
            rendered = """
            [Showing latest activity. Older log output is hidden in this preview.]

            \(String(rendered.suffix(limit)))
            """
            didTruncate = true
        } else if serverTruncated {
            rendered = """
            [Showing latest activity from the server preview.]

            \(rendered)
            """
        }

        return CodexTextPreview(
            text: rendered,
            originalCharacterCount: originalCount,
            isTruncated: didTruncate
        )
    }
}

struct CodexExecutionReceipt: Decodable, Hashable {
    let provider: CodexProvider
    let transport: String
    let binary: String?
    let binaryVersion: String?
    let model: String?
    let reasoningEffort: String?
    let permissionMode: String?
    let approvalPolicy: String?
    let sandbox: String?
    let skills: [String]
    let launchedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case provider
        case transport
        case binary
        case binaryVersion
        case model
        case reasoningEffort
        case permissionMode
        case approvalPolicy
        case sandbox
        case skills
        case launchedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = (try container.decodeIfPresent(CodexProvider.self, forKey: .provider)) ?? .defaultProvider
        transport = (try container.decodeIfPresent(String.self, forKey: .transport))?.trimmedNonEmpty ?? "unknown"
        binary = try container.decodeLooseStringIfPresent(forKey: .binary)
        binaryVersion = try container.decodeLooseStringIfPresent(forKey: .binaryVersion)
        model = try container.decodeLooseStringIfPresent(forKey: .model)
        reasoningEffort = try container.decodeLooseStringIfPresent(forKey: .reasoningEffort)
        permissionMode = try container.decodeLooseStringIfPresent(forKey: .permissionMode)
        approvalPolicy = try container.decodeLooseStringIfPresent(forKey: .approvalPolicy)
        sandbox = try container.decodeLooseStringIfPresent(forKey: .sandbox)
        skills = (try? container.decodeIfPresent([String].self, forKey: .skills)) ?? []
        launchedAt = try container.decodeLossyDateIfPresent(forKey: .launchedAt)
    }

    var summaryLines: [String] {
        var lines = ["Provider: \(provider.displayName)", "Transport: \(transport)"]
        if let binary { lines.append("Binary: \(binary)") }
        if let binaryVersion { lines.append("Version: \(binaryVersion)") }
        if let model { lines.append("Model: \(model)") }
        if let reasoningEffort { lines.append("Effort: \(reasoningEffort)") }
        if let permissionMode { lines.append("Claude permission: \(permissionMode)") }
        if let approvalPolicy { lines.append("Codex approvals: \(approvalPolicy)") }
        if let sandbox { lines.append("Sandbox: \(sandbox)") }
        if !skills.isEmpty { lines.append("Skills: \(skills.joined(separator: ", "))") }
        return lines
    }
}

struct CodexJobAttachmentReference: Decodable, Hashable, Identifiable {
    let filename: String
    let contentType: String?
    let bytes: Int?
    let path: String?

    var id: String {
        path?.trimmedNonEmpty ?? filename
    }
}

enum CodexJobArtifactKind: String, Decodable, Hashable {
    case code
    case staticPreview
    case document
    case unknown

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let value = (try? container.decode(String.self)) ?? ""
        self = CodexJobArtifactKind(rawValue: value) ?? .unknown
    }
}

struct CodexJobArtifact: Decodable, Hashable, Identifiable {
    let id: String
    let kind: CodexJobArtifactKind
    let filename: String
    let title: String?
    let language: String?
    let contentType: String?
    let bytes: Int?
    let rawURL: String?
    let previewURL: String?

    enum CodingKeys: String, CodingKey {
        case id
        case kind
        case filename
        case title
        case language
        case contentType
        case bytes
        case rawURL
        case previewURL
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.id = try container.decodeLooseStringIfPresent(forKey: .id) ?? UUID().uuidString
        self.kind = (try? container.decode(CodexJobArtifactKind.self, forKey: .kind)) ?? .unknown
        self.filename = try container.decodeLooseStringIfPresent(forKey: .filename) ?? "artifact.txt"
        self.title = try container.decodeLooseStringIfPresent(forKey: .title)
        self.language = try container.decodeLooseStringIfPresent(forKey: .language)
        self.contentType = try container.decodeLooseStringIfPresent(forKey: .contentType)
        self.bytes = try container.decodeIntegerIfPresent(forKey: .bytes)
        self.rawURL = try container.decodeLooseStringIfPresent(forKey: .rawURL)
        self.previewURL = try container.decodeLooseStringIfPresent(forKey: .previewURL)
    }
}

struct CodexJobAttachment: Encodable, Hashable, Identifiable {
    let id: UUID
    let filename: String
    let contentType: String
    let dataBase64: String
    let byteCount: Int

    init(
        id: UUID = UUID(),
        filename: String,
        contentType: String,
        data: Data
    ) {
        self.id = id
        self.filename = Self.cleanFilename(filename)
        self.contentType = contentType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "application/octet-stream" : contentType
        self.dataBase64 = data.base64EncodedString()
        self.byteCount = data.count
    }

    enum CodingKeys: String, CodingKey {
        case filename
        case contentType
        case dataBase64
    }

    private static func cleanFilename(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        let fallback = trimmed.isEmpty ? "attachment.bin" : trimmed
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-")
        let cleaned = fallback.unicodeScalars.map { scalar -> Character in
            allowed.contains(scalar) ? Character(scalar) : "-"
        }
        let result = String(cleaned).prefix(120)
        return result.isEmpty ? "attachment.bin" : String(result)
    }
}

struct CodexCreateJobRequest: Encodable {
    let workspaceId: String
    let prompt: String
    let timeoutMs: Int?
    let model: String?
    let reasoningEffort: String?
    let provider: CodexProvider
    let permissionMode: String?
    let approvalPolicy: String?
    let skills: [String]?
    let attachments: [CodexJobAttachment]?
    let resumeSessionId: String?

    init(
        workspaceId: String,
        prompt: String,
        timeoutMs: Int?,
        model: String? = nil,
        reasoningEffort: String? = nil,
        provider: CodexProvider = .defaultProvider,
        permissionMode: String? = nil,
        approvalPolicy: String? = nil,
        skills: [String] = [],
        attachments: [CodexJobAttachment] = [],
        resumeSessionId: String? = nil
    ) {
        self.workspaceId = workspaceId
        self.prompt = prompt
        self.timeoutMs = timeoutMs
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.provider = provider
        self.permissionMode = permissionMode
        self.approvalPolicy = approvalPolicy
        self.skills = skills.isEmpty ? nil : Array(skills.prefix(6))
        self.attachments = attachments.isEmpty ? nil : attachments
        self.resumeSessionId = resumeSessionId
    }
}

enum CodexOutputCleaner {
    static func cleanAnswer(_ text: String) -> String {
        let stripped = stripANSI(text).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !looksLikeRawTranscript(stripped) else { return "" }
        return stripped
    }

    private static func looksLikeRawTranscript(_ text: String) -> Bool {
        text.hasPrefix("OpenAI Codex ")
            || text.contains("\nworkdir: ")
            || text.contains("\nreasoning effort: ")
            || text.contains("\nexec\n")
            || text.contains("\nsucceeded in ")
    }

    private static func stripANSI(_ text: String) -> String {
        text.replacingOccurrences(
            of: #"\u001B\[[0-?]*[ -/]*[@-~]"#,
            with: "",
            options: .regularExpression
        )
    }
}

struct CodexCreateJobResponse: Decodable {
    let id: String
    let job: CodexJob?

    enum CodingKeys: String, CodingKey {
        case id
        case jobId
        case job
        case data
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let nestedJob = (try? container.decodeIfPresent(CodexJob.self, forKey: .job))
            ?? (try? container.decodeIfPresent(CodexJob.self, forKey: .data))
        let topLevelJob = try? CodexJob(from: decoder)
        let primaryID = try container.decodeLooseStringIfPresent(forKey: .id)
        let alternateID = try container.decodeLooseStringIfPresent(forKey: .jobId)
        let decodedID = primaryID
            ?? alternateID
            ?? nestedJob?.id
            ?? topLevelJob?.id

        guard let id = decodedID?.trimmedNonEmpty else {
            throw DecodingError.dataCorrupted(
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Create job response is missing an id.")
            )
        }

        self.id = id
        if let nestedJob {
            self.job = nestedJob
        } else if let topLevelJob, topLevelJob.hasOperationalFields {
            self.job = topLevelJob
        } else {
            self.job = nil
        }
    }
}

/// One server-sent event from `GET /v1/codex/jobs/<id>/stream`.
/// `status` carries a job status snapshot, `stdout`/`stderr` carry log chunks with their
/// byte offsets, and `done` carries the terminal full job response.
enum CodexJobStreamEvent: Hashable {
    case status(CodexJob)
    case stdout(offset: Int64, text: String)
    case stderr(offset: Int64, text: String)
    case done(CodexJob)

    /// Decode a single SSE event name + data payload. Returns nil for unknown events
    /// (heartbeats, future additions) and for undecodable payloads so a job stream stays
    /// tolerant of contract growth.
    static func decode(event: String, data: String) -> CodexJobStreamEvent? {
        let payload = Data(data.utf8)
        switch event.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "status":
            guard let job = try? JSONDecoder().decode(CodexJob.self, from: payload) else { return nil }
            return .status(job)
        case "stdout":
            guard let chunk = try? JSONDecoder().decode(CodexJobStreamChunk.self, from: payload) else { return nil }
            return .stdout(offset: chunk.offset ?? 0, text: chunk.text ?? "")
        case "stderr":
            guard let chunk = try? JSONDecoder().decode(CodexJobStreamChunk.self, from: payload) else { return nil }
            return .stderr(offset: chunk.offset ?? 0, text: chunk.text ?? "")
        case "done":
            guard let job = try? JSONDecoder().decode(CodexJob.self, from: payload) else { return nil }
            return .done(job)
        default:
            return nil
        }
    }
}

private struct CodexJobStreamChunk: Decodable {
    let offset: Int64?
    let text: String?
}

private struct CodexLooseString: Decodable {
    let value: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = ""
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let integer = try? container.decode(Int.self) {
            value = String(integer)
        } else if let double = try? container.decode(Double.self) {
            value = String(double)
        } else if let bool = try? container.decode(Bool.self) {
            value = bool ? "true" : "false"
        } else {
            let json = try CodexJSONValue(from: decoder)
            value = json.prettyPrinted
        }
    }
}

private enum CodexJSONValue: Decodable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: CodexJSONValue])
    case array([CodexJSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode([String: CodexJSONValue].self) {
            self = .object(value)
        } else {
            self = .array(try container.decode([CodexJSONValue].self))
        }
    }

    var foundationValue: Any {
        switch self {
        case .string(let value):
            return value
        case .number(let value):
            return value
        case .bool(let value):
            return value
        case .object(let values):
            return values.mapValues(\.foundationValue)
        case .array(let values):
            return values.map(\.foundationValue)
        case .null:
            return NSNull()
        }
    }

    var prettyPrinted: String {
        guard JSONSerialization.isValidJSONObject(foundationValue),
              let data = try? JSONSerialization.data(withJSONObject: foundationValue, options: [.prettyPrinted, .sortedKeys]),
              let string = String(data: data, encoding: .utf8) else {
            return String(describing: foundationValue)
        }
        return string
    }
}

private extension KeyedDecodingContainer {
    func decodeLooseStringIfPresent(forKey key: Key) throws -> String? {
        try decodeIfPresent(CodexLooseString.self, forKey: key)?.value.trimmedNonEmpty
    }

    func decodeIntegerIfPresent(forKey key: Key) throws -> Int? {
        if let integer = try decodeIfPresent(Int.self, forKey: key) {
            return integer
        }
        if let double = try decodeIfPresent(Double.self, forKey: key) {
            return Int(double)
        }
        if let string = try decodeIfPresent(CodexLooseString.self, forKey: key)?.value,
           let integer = Int(string) {
            return integer
        }
        return nil
    }

    func decodeLossyDateIfPresent(forKey key: Key) throws -> Date? {
        if let date = try? decodeIfPresent(Date.self, forKey: key) {
            return date
        }
        if let string = try decodeIfPresent(CodexLooseString.self, forKey: key)?.value {
            return CodexDateParser.parse(string)
        }
        return nil
    }
}

/// Lenient timestamp parsing shared by the model layer: ISO-8601 with or without
/// fractional seconds, or a bare epoch-seconds number.
enum CodexDateParser {
    static func parse(_ value: String) -> Date? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if let seconds = Double(trimmed) {
            return Date(timeIntervalSince1970: seconds)
        }
        if let date = fractional.date(from: trimmed) {
            return date
        }
        return standard.date(from: trimmed)
    }

    private static let standard: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

extension String {
    var trimmedNonEmpty: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
