import Foundation

// The timeline of one agent job: the prose it wrote and the steps it took, in
// order. relayd sends it as events; this file decodes them and reduces them to
// the blocks the transcript draws.
//
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 1.
// Everything here is tolerant on purpose: an unknown event type, kind or field
// from a newer machine is skipped, never a decoding failure.

// MARK: - Wire

enum RelayStepKind: String, Equatable, CaseIterable {
    case command, read, edit, write, search, fetch, tool, agent, reasoning, todo

    /// A kind this build does not know renders as a generic tool call.
    init(wire: String?) {
        self = wire.flatMap(RelayStepKind.init(rawValue:)) ?? .tool
    }
}

enum RelayStepStatus: String, Equatable {
    case running, done, failed, cancelled

    init(wire: String?) {
        self = wire.flatMap(RelayStepStatus.init(rawValue:)) ?? .done
    }

    var isRunning: Bool { self == .running }
}

struct RelayTodoItem: Decodable, Hashable {
    let text: String
    let status: String?

    private enum CodingKeys: String, CodingKey { case text, status }

    init(text: String, status: String? = nil) {
        self.text = text
        self.status = status
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        text = container.lenient(String.self, .text) ?? ""
        status = container.lenient(String.self, .status)
    }
}

/// What a step was asked to do. Which fields are present depends on the kind.
struct RelayStepInput: Decodable, Hashable {
    var command: String?
    var description: String?
    var cwd: String?
    var background: Bool?
    var path: String?
    var range: String?
    var diff: String?
    var pattern: String?
    var url: String?
    var query: String?
    var name: String?
    var server: String?
    var json: String?
    var prompt: String?
    var agentType: String?
    var items: [RelayTodoItem]?

    private enum CodingKeys: String, CodingKey {
        case command, description, cwd, background, path, range, diff, pattern, url, query
        case name, server, json, prompt, agentType, items
    }

    init() {}

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        command = container.lenient(String.self, .command)
        description = container.lenient(String.self, .description)
        cwd = container.lenient(String.self, .cwd)
        background = container.lenient(Bool.self, .background)
        path = container.lenient(String.self, .path)
        range = container.lenient(String.self, .range)
        diff = container.lenient(String.self, .diff)
        pattern = container.lenient(String.self, .pattern)
        url = container.lenient(String.self, .url)
        query = container.lenient(String.self, .query)
        name = container.lenient(String.self, .name)
        server = container.lenient(String.self, .server)
        json = container.lenient(String.self, .json)
        prompt = container.lenient(String.self, .prompt)
        agentType = container.lenient(String.self, .agentType)
        items = container.lenient([RelayTodoItem].self, .items)
    }

    /// Field-by-field merge: a later event only overrides what it carries.
    func merging(_ newer: RelayStepInput) -> RelayStepInput {
        var merged = self
        merged.command = newer.command ?? command
        merged.description = newer.description ?? description
        merged.cwd = newer.cwd ?? cwd
        merged.background = newer.background ?? background
        merged.path = newer.path ?? path
        merged.range = newer.range ?? range
        merged.diff = newer.diff ?? diff
        merged.pattern = newer.pattern ?? pattern
        merged.url = newer.url ?? url
        merged.query = newer.query ?? query
        merged.name = newer.name ?? name
        merged.server = newer.server ?? server
        merged.json = newer.json ?? json
        merged.prompt = newer.prompt ?? prompt
        merged.agentType = newer.agentType ?? agentType
        merged.items = newer.items ?? items
        return merged
    }
}

/// A `step` event: the first one for an id creates the step, later ones carry
/// only the fields that changed. Thread history sends complete ones.
struct RelayStepPatch: Decodable, Hashable {
    let id: String
    var kind: RelayStepKind?
    var title: String?
    var summary: String?
    var status: RelayStepStatus?
    var parent: String?
    var startedAt: Date?
    var endedAt: Date?
    var input: RelayStepInput?
    var output: String?
    var outputTruncated: Bool?
    var exitCode: Int?
    var error: String?

    private enum CodingKeys: String, CodingKey {
        case id, kind, title, summary, status, parent, startedAt, endedAt
        case input, output, outputTruncated, exitCode, error
    }

    init(
        id: String,
        kind: RelayStepKind? = nil,
        title: String? = nil,
        summary: String? = nil,
        status: RelayStepStatus? = nil,
        parent: String? = nil,
        startedAt: Date? = nil,
        endedAt: Date? = nil,
        input: RelayStepInput? = nil,
        output: String? = nil,
        outputTruncated: Bool? = nil,
        exitCode: Int? = nil,
        error: String? = nil
    ) {
        self.id = id
        self.kind = kind
        self.title = title
        self.summary = summary
        self.status = status
        self.parent = parent
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.input = input
        self.output = output
        self.outputTruncated = outputTruncated
        self.exitCode = exitCode
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        kind = container.lenient(String.self, .kind).map { RelayStepKind(wire: $0) }
        title = container.lenient(String.self, .title)
        summary = container.lenient(String.self, .summary)
        status = container.lenient(String.self, .status).map { RelayStepStatus(wire: $0) }
        parent = container.lenient(String.self, .parent).flatMap { $0.isEmpty ? nil : $0 }
        startedAt = container.lenient(String.self, .startedAt).flatMap(RelayTimelineDate.parse)
        endedAt = container.lenient(String.self, .endedAt).flatMap(RelayTimelineDate.parse)
        input = container.lenient(RelayStepInput.self, .input)
        output = container.lenient(String.self, .output)
        outputTruncated = container.lenient(Bool.self, .outputTruncated)
        exitCode = container.lenient(Int.self, .exitCode)
        error = container.lenient(String.self, .error)
    }
}

struct RelayTimelineUsage: Decodable, Hashable {
    var inputTokens: Int?
    var outputTokens: Int?

    private enum CodingKeys: String, CodingKey { case inputTokens, outputTokens }

    init(inputTokens: Int? = nil, outputTokens: Int? = nil) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        inputTokens = container.lenient(Int.self, .inputTokens)
        outputTokens = container.lenient(Int.self, .outputTokens)
    }
}

enum RelayTimelineEvent: Decodable, Hashable {
    case text(id: String, delta: String)
    case step(RelayStepPatch)
    case stepDelta(id: String, output: String)
    case usage(RelayTimelineUsage)
    /// A type this build does not know. It still counts toward the cursor.
    case unknown

    private enum CodingKeys: String, CodingKey { case type, id, delta, output }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch container.lenient(String.self, .type) ?? "" {
        case "text":
            guard let id = container.lenient(String.self, .id),
                  let delta = container.lenient(String.self, .delta) else {
                self = .unknown
                return
            }
            self = .text(id: id, delta: delta)
        case "step":
            self = (try? RelayStepPatch(from: decoder)).map(RelayTimelineEvent.step) ?? .unknown
        case "step.delta":
            guard let id = container.lenient(String.self, .id),
                  let output = container.lenient(String.self, .output) else {
                self = .unknown
                return
            }
            self = .stepDelta(id: id, output: output)
        case "usage":
            self = (try? RelayTimelineUsage(from: decoder)).map(RelayTimelineEvent.usage) ?? .unknown
        default:
            self = .unknown
        }
    }
}

/// One timeline event with its sequence number, as the job stream and the
/// timeline route both deliver it.
struct RelayTimelineEnvelope: Decodable, Hashable {
    let seq: Int
    let event: RelayTimelineEvent
}

/// `GET /v1/codex/jobs/:id/timeline?since=<n>`.
struct RelayTimelinePage: Decodable, Hashable {
    let events: [RelayTimelineEnvelope]
    let next: Int
    let complete: Bool

    private enum CodingKeys: String, CodingKey { case events, next, complete }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        events = container.lenient([RelayTimelineEnvelope].self, .events) ?? []
        next = container.lenient(Int.self, .next) ?? 0
        complete = container.lenient(Bool.self, .complete) ?? false
    }
}

enum RelayTimelineDate {
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let whole: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parse(_ text: String) -> Date? {
        fractional.date(from: text) ?? whole.date(from: text)
    }
}

private extension KeyedDecodingContainer {
    /// Absent, null and wrong-typed all read as nil.
    func lenient<T: Decodable>(_ type: T.Type, _ key: Key) -> T? {
        (try? decodeIfPresent(type, forKey: key)) ?? nil
    }
}

// MARK: - Reduced model

struct RelayStep: Identifiable, Hashable {
    let id: String
    var kind: RelayStepKind
    var title: String
    var summary: String?
    var status: RelayStepStatus
    var parentID: String?
    var startedAt: Date?
    var endedAt: Date?
    var input: RelayStepInput
    var output: String
    var outputTruncated: Bool
    var exitCode: Int?
    var error: String?
}

struct RelayTimelineBlock: Identifiable, Hashable {
    enum Content: Hashable {
        /// Markdown the agent wrote.
        case prose(String)
        /// A run of consecutive top-level steps, by id.
        case activity([String])
    }

    let id: String
    var content: Content
}

/// The reduced timeline of one job, or of one stretch of thread history.
struct RelayTimeline: Hashable {
    private(set) var blocks: [RelayTimelineBlock] = []
    private(set) var usage: RelayTimelineUsage?
    /// How many events have been applied: the `timeline=<n>` and `since=<n>` cursor.
    private(set) var cursor = 0

    private var steps: [String: RelayStep] = [:]
    /// Step ids in the order they first appeared, top-level and nested alike.
    private var order: [String] = []

    init() {}

    /// Thread history: complete steps with no prose between them.
    init(historySteps: [RelayStepPatch]) {
        for patch in historySteps {
            merge(patch)
        }
    }

    var isEmpty: Bool { blocks.isEmpty && order.isEmpty }

    /// Applies one event. A sequence number at or below the cursor is a replay
    /// (a reconnect, a poll that overlaps the stream) and is ignored.
    @discardableResult
    mutating func apply(_ event: RelayTimelineEvent, seq: Int? = nil) -> Bool {
        if let seq {
            guard seq > cursor else { return false }
            cursor = seq
        } else {
            cursor += 1
        }
        switch event {
        case .text(let id, let delta):
            appendProse(id: id, delta: delta)
        case .step(let patch):
            merge(patch)
        case .stepDelta(let id, let output):
            steps[id]?.output += output
        case .usage(let newer):
            usage = RelayTimelineUsage(
                inputTokens: newer.inputTokens ?? usage?.inputTokens,
                outputTokens: newer.outputTokens ?? usage?.outputTokens
            )
        case .unknown:
            break
        }
        return true
    }

    @discardableResult
    mutating func apply(_ envelope: RelayTimelineEnvelope) -> Bool {
        apply(envelope.event, seq: envelope.seq)
    }

    /// The job is over, so nothing is running any more: a step the writer never
    /// closed takes the job's outcome instead of ticking forever.
    mutating func settle(as outcome: RelayStepStatus, at date: Date? = nil) {
        for id in order where steps[id]?.status == .running {
            steps[id]?.status = outcome
            if steps[id]?.endedAt == nil { steps[id]?.endedAt = date }
        }
    }

    func step(_ id: String) -> RelayStep? { steps[id] }

    func steps(in block: RelayTimelineBlock) -> [RelayStep] {
        guard case .activity(let ids) = block.content else { return [] }
        return ids.compactMap { steps[$0] }
    }

    func children(of id: String) -> [RelayStep] {
        order.compactMap { steps[$0] }.filter { $0.parentID == id }
    }

    /// Top-level steps still in flight, oldest first: what the live rows show.
    var runningSteps: [RelayStep] {
        order.compactMap { steps[$0] }.filter { $0.status == .running && $0.parentID == nil }
    }

    /// The agent's prose joined in order, for copy and for the legacy text paths.
    var proseText: String {
        blocks.compactMap { block -> String? in
            if case .prose(let text) = block.content { return text }
            return nil
        }.joined(separator: "\n\n")
    }

    private mutating func appendProse(id: String, delta: String) {
        guard !delta.isEmpty else { return }
        let blockID = "prose-\(id)"
        if let index = blocks.lastIndex(where: { $0.id == blockID }),
           case .prose(let text) = blocks[index].content {
            blocks[index].content = .prose(text + delta)
        } else {
            blocks.append(RelayTimelineBlock(id: blockID, content: .prose(delta)))
        }
    }

    private mutating func merge(_ patch: RelayStepPatch) {
        if var step = steps[patch.id] {
            if let kind = patch.kind { step.kind = kind }
            if let title = patch.title, !title.isEmpty { step.title = title }
            if let summary = patch.summary { step.summary = summary }
            if let status = patch.status { step.status = status }
            if let startedAt = patch.startedAt { step.startedAt = startedAt }
            if let endedAt = patch.endedAt { step.endedAt = endedAt }
            if let input = patch.input { step.input = step.input.merging(input) }
            if let output = patch.output { step.output = output }
            if let truncated = patch.outputTruncated { step.outputTruncated = truncated }
            if let exitCode = patch.exitCode { step.exitCode = exitCode }
            if let error = patch.error { step.error = error }
            steps[patch.id] = step
            return
        }

        let kind = patch.kind ?? .tool
        steps[patch.id] = RelayStep(
            id: patch.id,
            kind: kind,
            title: patch.title.flatMap { $0.isEmpty ? nil : $0 } ?? kind.defaultTitle,
            summary: patch.summary,
            status: patch.status ?? .running,
            parentID: patch.parent,
            startedAt: patch.startedAt,
            endedAt: patch.endedAt,
            input: patch.input ?? RelayStepInput(),
            output: patch.output ?? "",
            outputTruncated: patch.outputTruncated ?? false,
            exitCode: patch.exitCode,
            error: patch.error
        )
        order.append(patch.id)

        // A sub-agent's steps belong to the agent step, not to the transcript.
        guard patch.parent == nil else { return }
        if let last = blocks.indices.last, case .activity(let ids) = blocks[last].content {
            blocks[last].content = .activity(ids + [patch.id])
        } else {
            blocks.append(RelayTimelineBlock(id: "activity-\(patch.id)", content: .activity([patch.id])))
        }
    }
}

// MARK: - Wording

extension RelayStepKind {
    var defaultTitle: String {
        switch self {
        case .command: return "Command"
        case .read: return "Read"
        case .edit: return "Edit"
        case .write: return "Write"
        case .search: return "Search"
        case .fetch: return "Fetch"
        case .tool: return "Tool"
        case .agent: return "Agent"
        case .reasoning: return "Thinking"
        case .todo: return "Plan"
        }
    }

    /// The status word while a step of this kind is in flight.
    var liveWord: String {
        switch self {
        case .command: return "Running"
        case .read: return "Reading"
        case .edit: return "Editing"
        case .write: return "Writing"
        case .search: return "Searching"
        case .fetch: return "Fetching"
        case .tool: return "Working"
        case .agent: return "Agent"
        case .reasoning: return "Thinking"
        case .todo: return "Planning"
        }
    }

    /// The word for a finished step of this kind in a list of steps.
    var doneWord: String {
        switch self {
        case .command: return "Ran"
        case .read: return "Read"
        case .edit: return "Edited"
        case .write: return "Wrote"
        case .search: return "Searched"
        case .fetch: return "Fetched"
        case .tool: return "Used"
        case .agent: return "Agent"
        case .reasoning: return "Thought"
        case .todo: return "Plan"
        }
    }

    fileprivate func phrase(count: Int) -> String {
        switch self {
        case .command: return count == 1 ? "ran a command" : "ran \(count) commands"
        case .read: return count == 1 ? "read a file" : "read \(count) files"
        case .edit: return count == 1 ? "edited a file" : "edited \(count) files"
        case .write: return count == 1 ? "wrote a file" : "wrote \(count) files"
        case .search: return count == 1 ? "ran a search" : "ran \(count) searches"
        case .fetch: return count == 1 ? "fetched a page" : "fetched \(count) pages"
        case .tool: return count == 1 ? "used a tool" : "used \(count) tools"
        case .agent: return count == 1 ? "ran an agent" : "ran \(count) agents"
        case .reasoning: return "thought"
        case .todo: return "updated the plan"
        }
    }
}

extension RelayStep {
    /// The status word a row shows: live while running, the kind's past tense
    /// once done, and the outcome when it did not succeed.
    var statusWord: String {
        switch status {
        case .running: return kind.liveWord
        case .done: return kind.doneWord
        case .failed: return "Failed"
        case .cancelled: return "Stopped"
        }
    }

    /// One line saying what this step is about, falling back through its input
    /// so a row is never blank.
    var displaySummary: String {
        if let summary, !summary.isEmpty { return summary }
        if let description = input.description, !description.isEmpty { return description }
        if let command = input.command, let firstLine = command.split(separator: "\n").first {
            return String(firstLine)
        }
        if let path = input.path, !path.isEmpty {
            return (path as NSString).lastPathComponent
        }
        if let pattern = input.pattern, !pattern.isEmpty { return pattern }
        if let query = input.query, !query.isEmpty { return query }
        if let url = input.url, !url.isEmpty { return URL(string: url)?.host ?? url }
        return title
    }

    func duration(now: Date) -> TimeInterval? {
        guard let startedAt else { return nil }
        let end = endedAt ?? (status == .running ? now : nil)
        guard let end else { return nil }
        return max(0, end.timeIntervalSince(startedAt))
    }
}

extension RelayTimeline {
    /// "Ran 5 commands, read 2 files": counts by kind in order of first
    /// appearance. A run that is only thinking says how long it took.
    static func summary(of steps: [RelayStep], now: Date = Date()) -> String {
        var kinds: [RelayStepKind] = []
        var counts: [RelayStepKind: Int] = [:]
        for step in steps {
            if counts[step.kind] == nil { kinds.append(step.kind) }
            counts[step.kind, default: 0] += 1
        }
        guard !kinds.isEmpty else { return "" }

        if kinds == [.reasoning] {
            let seconds = steps.compactMap { $0.duration(now: now) }.reduce(0, +)
            return seconds >= 1 ? "Thought for \(RelayStepClock.short(seconds))" : "Thought"
        }

        let sentence = kinds.map { $0.phrase(count: counts[$0] ?? 1) }.joined(separator: ", ")
        return sentence.prefix(1).uppercased() + sentence.dropFirst()
    }
}

enum RelayStepClock {
    /// A ticking clock for something in flight: `0:07`, `12:03`, `1:02:03`.
    static func clock(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 { return String(format: "%d:%02d:%02d", hours, minutes, secs) }
        return String(format: "%d:%02d", minutes, secs)
    }

    /// A finished duration in words: `4s`, `1m 12s`, `2h 3m`.
    static func short(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds.rounded()))
        if total < 60 { return "\(total)s" }
        let hours = total / 3600
        let minutes = (total % 3600) / 60
        let secs = total % 60
        if hours > 0 { return minutes > 0 ? "\(hours)h \(minutes)m" : "\(hours)h" }
        return secs > 0 ? "\(minutes)m \(secs)s" : "\(minutes)m"
    }
}
