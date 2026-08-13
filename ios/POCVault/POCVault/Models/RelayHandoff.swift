import Foundation

/// A session handed over from a Mac by `relay handoff`, waiting on the sandbox.
///
/// Handoffs are their own resource rather than a thread kind: relayd derives
/// threads from jobs, so a handoff only becomes a thread once **Continue**
/// enqueues one. The node serves the list as `{ "handoffs": [...] }` from
/// `GET /v1/handoffs`; the detail route adds the sealed manifest it decrypted
/// on the node.
struct RelayHandoffCard: Decodable, Identifiable, Hashable {

    /// The states relayd persists. `unknown` keeps an unrecognised state
    /// renderable instead of failing the whole list decode.
    enum State: Hashable {
        case importing
        case ready
        case failed
        case unknown(String)

        init(rawState: String) {
            switch rawState.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "importing": self = .importing
            case "ready": self = .ready
            case "failed": self = .failed
            default: self = .unknown(rawState)
            }
        }

        var rawValue: String {
            switch self {
            case .importing: return "importing"
            case .ready: return "ready"
            case .failed: return "failed"
            case .unknown(let value): return value
            }
        }
    }

    let id: String
    let state: State
    let repo: String
    let branch: String
    /// Human-readable, taken from the sealed manifest on the node. The branch
    /// name is opaque (`relay/handoff-<12 hex>`) and is never parsed for it.
    let title: String
    /// The runner that will execute the resume, not necessarily the harness the
    /// laptop session came from — that lives in the manifest.
    let provider: CodexProvider?
    let workspaceID: String?
    let canResumeNatively: Bool
    let lastJobID: String?
    /// A reason token from relayd's closed vocabulary (`clone_failed`,
    /// `seal_decrypt_failed`, …). Never a sentence, never attacker text.
    let error: String?
    let createdAt: Date?
    let updatedAt: Date?

    private enum CodingKeys: String, CodingKey {
        case id, state, repo, branch, title, provider, error
        case workspaceId, canResumeNatively, lastJobId, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        state = State(rawState: try container.decodeIfPresent(String.self, forKey: .state) ?? "unknown")
        repo = try container.decodeIfPresent(String.self, forKey: .repo) ?? ""
        branch = try container.decodeIfPresent(String.self, forKey: .branch) ?? ""
        title = try container.decodeIfPresent(String.self, forKey: .title)?.trimmedNonEmpty ?? "Handoff"
        provider = try container.decodeIfPresent(String.self, forKey: .provider).map { CodexProvider(rawProvider: $0) }
        workspaceID = try container.decodeIfPresent(String.self, forKey: .workspaceId)?.trimmedNonEmpty
        canResumeNatively = try container.decodeIfPresent(Bool.self, forKey: .canResumeNatively) ?? false
        lastJobID = try container.decodeIfPresent(String.self, forKey: .lastJobId)?.trimmedNonEmpty
        error = try container.decodeIfPresent(String.self, forKey: .error)?.trimmedNonEmpty
        createdAt = try container.decodeIfPresent(Date.self, forKey: .createdAt)
        updatedAt = try container.decodeIfPresent(Date.self, forKey: .updatedAt)
    }

    /// Human copy for the phone. Backend state names remain available through
    /// `state.rawValue`, but users should not have to translate them.
    var statusLabel: String {
        switch state {
        case .importing: return "Preparing"
        case .ready: return "Ready to continue"
        case .failed: return "Needs attention"
        case .unknown: return "Status unavailable"
        }
    }

    /// The handoff branch is an internal transport identifier
    /// (`relay/handoff-<opaque id>`), not useful context for the user.
    var subtitle: String { repo.trimmedNonEmpty ?? "Repository unavailable" }

    var isActionable: Bool { state == .ready }

    var isFailed: Bool { state == .failed }

    /// What went wrong, in a sentence. relayd serves a coarse machine token on
    /// purpose (a detailed clone error would be a private-repo existence
    /// oracle), so the phone translates rather than printing the token alone.
    var failureSummary: String? {
        guard isFailed || error != nil else { return nil }
        switch error {
        case "clone_failed":
            return "The sandbox could not fetch that branch from GitHub."
        case "no_encryption_key":
            return "This machine has no encryption key, so the session stayed sealed."
        case "manifest_missing", "manifest_unreadable", "manifest_invalid",
             "manifest_id_mismatch", "manifest_too_large", "unsupported_manifest_version":
            return "The handoff description did not survive the trip."
        case "seal_bad_magic", "seal_truncated", "seal_decrypt_failed":
            return "The sealed session could not be opened on this machine."
        case "blob_outside_checkout", "blob_too_large", "blob_unreadable":
            return "The handed-off session file could not be read."
        case "session_staging_failed":
            return "The session arrived but could not be staged for resume."
        case "invalid_repo", "invalid_branch", "invalid_handoff_id":
            return "The handoff named something this machine will not accept."
        case .none:
            return "This handoff failed."
        default:
            return "The handoff failed on this machine."
        }
    }

    /// The honest next step. Never asks for a credential — the phone never
    /// holds one; every remedy happens at the laptop.
    var failureAdvice: String? {
        guard isFailed else { return nil }
        switch error {
        case "clone_failed":
            return "Run relay sync-auth on your Mac, then relay handoff again."
        case "no_encryption_key":
            return "Re-pair this machine, then run relay handoff again."
        default:
            return "Run relay handoff again on your Mac."
        }
    }
}

/// The part of the sealed manifest the node decrypted and is willing to serve.
/// Everything here is optional: the manifest is attacker-supplied and relayd
/// allow-lists what it keeps, so a field can legitimately be absent.
struct RelayHandoffManifest: Decodable, Hashable {
    /// The harness the laptop session belonged to ("claude", "codex", "cursor").
    let harness: String?
    let machine: String?
    let excerpt: String?
    let baseBranch: String?
    let wipSummary: String?
    let wipFiles: Int?
    let wipInsertions: Int?
    let wipDeletions: Int?

    private enum CodingKeys: String, CodingKey { case harness, machine, excerpt, baseBranch, wip }

    private struct Wip: Decodable {
        let summary: String?
        let files: Int?
        let insertions: Int?
        let deletions: Int?
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        harness = try container.decodeIfPresent(String.self, forKey: .harness)?.trimmedNonEmpty
        machine = try container.decodeIfPresent(String.self, forKey: .machine)?.trimmedNonEmpty
        excerpt = try container.decodeIfPresent(String.self, forKey: .excerpt)?.trimmedNonEmpty
        baseBranch = try container.decodeIfPresent(String.self, forKey: .baseBranch)?.trimmedNonEmpty
        let wip = try container.decodeIfPresent(Wip.self, forKey: .wip)
        wipSummary = wip?.summary?.trimmedNonEmpty
        wipFiles = wip?.files
        wipInsertions = wip?.insertions
        wipDeletions = wip?.deletions
    }

    /// The diffstat line for the card: the CLI's own summary when it sent one,
    /// otherwise composed from the counts. Nil when there was no WIP at all.
    var diffstat: String? {
        if let wipSummary { return wipSummary }
        var parts: [String] = []
        if let files = wipFiles, files > 0 {
            parts.append(files == 1 ? "1 file" : "\(files) files")
        }
        let insertions = wipInsertions ?? 0
        let deletions = wipDeletions ?? 0
        if insertions > 0 || deletions > 0 {
            parts.append("+\(insertions)/-\(deletions)")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// `GET /v1/handoffs/:id` — the card fields plus the manifest, flat in one object.
struct RelayHandoffDetail: Decodable {
    let card: RelayHandoffCard
    let manifest: RelayHandoffManifest?

    private enum CodingKeys: String, CodingKey { case manifest }

    init(from decoder: Decoder) throws {
        card = try RelayHandoffCard(from: decoder)
        manifest = try decoder.container(keyedBy: CodingKeys.self)
            .decodeIfPresent(RelayHandoffManifest.self, forKey: .manifest)
    }
}

/// One session still living on the user's Mac. Metadata only — the index is
/// sealed to the node by `relay sync-auth` and carries no transcript and no
/// credential, so there is nothing here to resume from directly.
struct RelayMacSession: Decodable, Identifiable, Hashable {
    let id: String
    let harness: String
    let title: String
    let repo: String
    /// ISO-8601 as written by the CLI; kept as text because an empty string is
    /// a legal value and must not fail the decode.
    let lastActive: String

    private enum CodingKeys: String, CodingKey { case id, harness, title, repo, lastActive }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        harness = try container.decodeIfPresent(String.self, forKey: .harness)?.trimmedNonEmpty ?? "session"
        title = try container.decodeIfPresent(String.self, forKey: .title) ?? ""
        repo = try container.decodeIfPresent(String.self, forKey: .repo) ?? ""
        lastActive = try container.decodeIfPresent(String.self, forKey: .lastActive) ?? ""
    }

    var displayTitle: String {
        title.trimmedNonEmpty ?? repo.trimmedNonEmpty ?? "Untitled session"
    }

    var lastActiveDate: Date? { CodexDateParser.parse(lastActive) }
}

/// `GET /v1/mac-sessions` → `{ "index": {...} }` or `{ "index": null }` when the
/// Mac has never run a relay command.
struct RelayMacSessionIndex: Decodable, Hashable {
    let machine: String?
    let updatedAt: String?
    let sessions: [RelayMacSession]

    private enum CodingKeys: String, CodingKey { case machine, updatedAt, sessions }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        machine = try container.decodeIfPresent(String.self, forKey: .machine)?.trimmedNonEmpty
        updatedAt = try container.decodeIfPresent(String.self, forKey: .updatedAt)
        sessions = try container.decodeIfPresent([RelayMacSession].self, forKey: .sessions) ?? []
    }

    var updatedAtDate: Date? { CodexDateParser.parse(updatedAt ?? "") }

    /// Section title: the machine name when the Mac reported one.
    var sectionTitle: String {
        guard let machine else { return "On your Mac" }
        return "On \(machine)"
    }
}
