import XCTest
@testable import POCVault

/// The job timeline: decoding relayd's events and reducing them to the blocks
/// the transcript draws. The fixture is the canonical example from
/// docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, section 1.2,
/// which relayd's own tests use verbatim too.
final class RelayTranscriptTests: XCTestCase {
    static let canonical = #"""
    {"type":"step","id":"r1","kind":"reasoning","title":"Thinking","status":"running","startedAt":"2026-10-06T07:00:00.000Z"}
    {"type":"step.delta","id":"r1","output":"The rounding bug is probably in the tax line."}
    {"type":"step","id":"r1","status":"done","endedAt":"2026-10-06T07:00:04.000Z"}
    {"type":"text","id":"t1","delta":"I'll look at the pricing module "}
    {"type":"text","id":"t1","delta":"and run its tests."}
    {"type":"step","id":"s1","kind":"read","title":"Read","summary":"pricing.ts","status":"running","startedAt":"2026-10-06T07:00:05.000Z","input":{"path":"/work/app/src/pricing.ts"}}
    {"type":"step","id":"s1","status":"done","endedAt":"2026-10-06T07:00:05.200Z"}
    {"type":"step","id":"s2","kind":"command","title":"Bash","summary":"Run the pricing tests","status":"running","startedAt":"2026-10-06T07:00:06.000Z","input":{"command":"npm test -- pricing","description":"Run the pricing tests","cwd":"/work/app"}}
    {"type":"step.delta","id":"s2","output":"FAIL rounds half up\n"}
    {"type":"step","id":"s2","status":"failed","endedAt":"2026-10-06T07:00:12.000Z","exitCode":1,"output":"FAIL rounds half up\n1 failing\n"}
    {"type":"text","id":"t2","delta":"One test fails. Fixing the rounding and asking a sub-agent to audit the other callers."}
    {"type":"step","id":"s3","kind":"edit","title":"Edit","summary":"pricing.ts","status":"done","startedAt":"2026-10-06T07:00:14.000Z","endedAt":"2026-10-06T07:00:14.100Z","input":{"path":"/work/app/src/pricing.ts","diff":"-  return Math.floor(total * 100) / 100\n+  return Math.round(total * 100) / 100"}}
    {"type":"step","id":"a1","kind":"agent","title":"Agent","summary":"Audit callers of roundPrice","status":"running","startedAt":"2026-10-06T07:00:15.000Z","input":{"description":"Audit callers of roundPrice","prompt":"Find every caller of roundPrice and report any that assume floor.","agentType":"Explore"}}
    {"type":"step","id":"s4","parent":"a1","kind":"search","title":"Grep","summary":"roundPrice","status":"done","startedAt":"2026-10-06T07:00:16.000Z","endedAt":"2026-10-06T07:00:16.300Z","input":{"pattern":"roundPrice","path":"/work/app/src"}}
    {"type":"step","id":"s5","parent":"a1","kind":"read","title":"Read","summary":"checkout.ts","status":"done","startedAt":"2026-10-06T07:00:17.000Z","endedAt":"2026-10-06T07:00:17.200Z","input":{"path":"/work/app/src/checkout.ts"}}
    {"type":"step","id":"a1","status":"done","endedAt":"2026-10-06T07:00:30.000Z","output":"Two callers. Neither assumes floor."}
    {"type":"step","id":"s6","kind":"tool","title":"Mark Chapter","status":"done","startedAt":"2026-10-06T07:00:31.000Z","endedAt":"2026-10-06T07:00:31.050Z","input":{"name":"mark_chapter","server":"session","json":"{\"title\":\"Verification\"}"}}
    {"type":"step","id":"s7","kind":"command","title":"Bash","summary":"Run the pricing tests","status":"done","startedAt":"2026-10-06T07:00:32.000Z","endedAt":"2026-10-06T07:00:39.000Z","exitCode":0,"input":{"command":"npm test -- pricing"},"output":"12 passing\n"}
    {"type":"text","id":"t3","delta":"Fixed. All 12 pricing tests pass and no caller depended on the old behaviour."}
    {"type":"usage","inputTokens":4210,"outputTokens":612}
    """#

    private func decode(_ ndjson: String) throws -> [RelayTimelineEvent] {
        try ndjson.split(separator: "\n").map { line in
            try JSONDecoder().decode(RelayTimelineEvent.self, from: Data(line.utf8))
        }
    }

    private func canonicalTimeline() throws -> RelayTimeline {
        var timeline = RelayTimeline()
        for (index, event) in try decode(Self.canonical).enumerated() {
            timeline.apply(event, seq: index + 1)
        }
        return timeline
    }

    private func stepIDs(_ block: RelayTimelineBlock) -> [String] {
        if case .activity(let ids) = block.content { return ids }
        return []
    }

    private func prose(_ block: RelayTimelineBlock) -> String? {
        if case .prose(let text) = block.content { return text }
        return nil
    }

    func testCanonicalExampleReducesToTheSpecBlockSequence() throws {
        let timeline = try canonicalTimeline()

        XCTAssertEqual(timeline.blocks.count, 6)
        XCTAssertEqual(stepIDs(timeline.blocks[0]), ["r1"])
        XCTAssertEqual(prose(timeline.blocks[1]), "I'll look at the pricing module and run its tests.")
        XCTAssertEqual(stepIDs(timeline.blocks[2]), ["s1", "s2"])
        XCTAssertEqual(
            prose(timeline.blocks[3]),
            "One test fails. Fixing the rounding and asking a sub-agent to audit the other callers."
        )
        // A sub-agent's own steps (s4, s5) belong to the agent step, not the transcript.
        XCTAssertEqual(stepIDs(timeline.blocks[4]), ["s3", "a1", "s6", "s7"])
        XCTAssertEqual(
            prose(timeline.blocks[5]),
            "Fixed. All 12 pricing tests pass and no caller depended on the old behaviour."
        )
        XCTAssertEqual(timeline.cursor, 20)
        XCTAssertEqual(timeline.usage, RelayTimelineUsage(inputTokens: 4210, outputTokens: 612))
        XCTAssertTrue(timeline.runningSteps.isEmpty)
    }

    func testActivityRowsSummariseByKindInOrderOfFirstAppearance() throws {
        let timeline = try canonicalTimeline()
        let now = Date()

        XCTAssertEqual(
            RelayTimeline.summary(of: timeline.steps(in: timeline.blocks[0]), now: now),
            "Thought for 4s"
        )
        XCTAssertEqual(
            RelayTimeline.summary(of: timeline.steps(in: timeline.blocks[2]), now: now),
            "Read a file, ran a command"
        )
        XCTAssertEqual(
            RelayTimeline.summary(of: timeline.steps(in: timeline.blocks[4]), now: now),
            "Edited a file, ran an agent, used a tool, ran a command"
        )
        XCTAssertEqual(RelayTimeline.summary(of: [], now: now), "")
    }

    func testPluralCountsReadNaturally() {
        func step(_ id: String, _ kind: RelayStepKind) -> RelayStepPatch {
            RelayStepPatch(id: id, kind: kind, status: .done)
        }
        let timeline = RelayTimeline(historySteps: [
            step("1", .command), step("2", .read), step("3", .command), step("4", .command),
            step("5", .read), step("6", .reasoning), step("7", .command), step("8", .command),
        ])
        XCTAssertEqual(
            RelayTimeline.summary(of: timeline.steps(in: timeline.blocks[0])),
            "Ran 5 commands, read 2 files, thought"
        )
    }

    func testAFinalStepOutputReplacesWhatTheDeltasAccumulated() throws {
        let timeline = try canonicalTimeline()
        let failed = try XCTUnwrap(timeline.step("s2"))

        XCTAssertEqual(failed.status, .failed)
        XCTAssertEqual(failed.exitCode, 1)
        XCTAssertEqual(failed.output, "FAIL rounds half up\n1 failing\n")
        XCTAssertEqual(failed.statusWord, "Failed")
        XCTAssertEqual(failed.input.command, "npm test -- pricing")
        XCTAssertEqual(failed.duration(now: Date()), 6)

        // Reasoning has no final output, so it keeps what streamed in.
        XCTAssertEqual(timeline.step("r1")?.output, "The rounding bug is probably in the tax line.")
    }

    func testSubAgentStepsNestUnderTheirAgent() throws {
        let timeline = try canonicalTimeline()
        let agent = try XCTUnwrap(timeline.step("a1"))

        XCTAssertEqual(agent.kind, .agent)
        XCTAssertEqual(agent.output, "Two callers. Neither assumes floor.")
        XCTAssertEqual(agent.input.agentType, "Explore")
        XCTAssertEqual(timeline.children(of: "a1").map(\.id), ["s4", "s5"])
        XCTAssertEqual(timeline.step("s4")?.parentID, "a1")
        XCTAssertTrue(timeline.children(of: "s7").isEmpty)
    }

    func testLaterStepEventsMergeFieldByField() {
        var timeline = RelayTimeline()
        var first = RelayStepInput()
        first.path = "/work/app/src/pricing.ts"
        var second = RelayStepInput()
        second.diff = "-old\n+new"
        timeline.apply(.step(RelayStepPatch(id: "e1", kind: .edit, title: "Edit", status: .running, input: first)))
        timeline.apply(.step(RelayStepPatch(id: "e1", status: .done, input: second)))

        let step = timeline.step("e1")
        XCTAssertEqual(step?.status, .done)
        XCTAssertEqual(step?.kind, .edit)
        XCTAssertEqual(step?.title, "Edit")
        XCTAssertEqual(step?.input.path, "/work/app/src/pricing.ts")
        XCTAssertEqual(step?.input.diff, "-old\n+new")
        XCTAssertEqual(timeline.blocks.count, 1, "an update must not open a second row")
    }

    func testAReplayedEventIsIgnored() throws {
        var timeline = RelayTimeline()
        let events = try decode(Self.canonical)
        for (index, event) in events.prefix(5).enumerated() {
            XCTAssertTrue(timeline.apply(event, seq: index + 1))
        }
        // A reconnect that overlaps what is already held.
        for (index, event) in events.prefix(5).enumerated() {
            XCTAssertFalse(timeline.apply(event, seq: index + 1))
        }
        XCTAssertEqual(timeline.cursor, 5)
        XCTAssertEqual(prose(timeline.blocks[1]), "I'll look at the pricing module and run its tests.")
        XCTAssertEqual(timeline.step("r1")?.output, "The rounding bug is probably in the tax line.")
    }

    func testANewerMachinesEventsAreSkippedNotFatal() throws {
        var timeline = RelayTimeline()
        let lines = [
            #"{"type":"hologram","id":"h1","payload":{"x":1}}"#,
            #"{"type":"step","id":"s1","kind":"teleport","status":"running","extra":true}"#,
            #"{"type":"step","id":"s1","status":"vaporised"}"#,
            #"{"type":"text","id":"t1"}"#,
            #"{"type":"step"}"#,
            #"{"type":"step.delta","id":"s1","output":42}"#,
        ]
        for (index, line) in lines.enumerated() {
            let event = try JSONDecoder().decode(RelayTimelineEvent.self, from: Data(line.utf8))
            timeline.apply(event, seq: index + 1)
        }

        XCTAssertEqual(timeline.cursor, 6, "unknown events still count toward the cursor")
        let step = try XCTUnwrap(timeline.step("s1"))
        XCTAssertEqual(step.kind, .tool, "an unknown kind renders as a generic tool")
        XCTAssertEqual(step.status, .done, "an unknown status is not treated as still running")
        XCTAssertEqual(step.title, "Tool")
        XCTAssertEqual(timeline.blocks.count, 1)
    }

    func testAStepStillRunningWhenTheJobEndsTakesTheJobsOutcome() {
        var timeline = RelayTimeline()
        timeline.apply(.step(RelayStepPatch(id: "s1", kind: .command, status: .running)))
        timeline.apply(.step(RelayStepPatch(id: "s2", kind: .read, status: .done)))
        XCTAssertEqual(timeline.runningSteps.map(\.id), ["s1"])

        timeline.settle(as: .cancelled)

        XCTAssertEqual(timeline.step("s1")?.status, .cancelled)
        XCTAssertEqual(timeline.step("s1")?.statusWord, "Stopped")
        XCTAssertEqual(timeline.step("s2")?.status, .done)
        XCTAssertTrue(timeline.runningSteps.isEmpty)
    }

    func testRunningStepsListsOnlyTopLevelWorkInFlight() {
        var timeline = RelayTimeline()
        timeline.apply(.step(RelayStepPatch(id: "a1", kind: .agent, status: .running)))
        timeline.apply(.step(RelayStepPatch(id: "a2", kind: .agent, status: .running)))
        timeline.apply(.step(RelayStepPatch(id: "c1", kind: .read, status: .running, parent: "a1")))

        XCTAssertEqual(timeline.runningSteps.map(\.id), ["a1", "a2"])
        XCTAssertEqual(timeline.step("a1")?.statusWord, "Agent")
    }

    func testProseBlocksStayStableOnceTheNextBlockStarts() {
        var timeline = RelayTimeline()
        timeline.apply(.text(id: "t1", delta: "First."))
        timeline.apply(.step(RelayStepPatch(id: "s1", kind: .command, status: .running)))
        let before = timeline.blocks[0]
        timeline.apply(.text(id: "t2", delta: "Second "))
        timeline.apply(.text(id: "t2", delta: "block."))

        XCTAssertEqual(timeline.blocks.count, 3)
        XCTAssertEqual(timeline.blocks[0], before)
        XCTAssertEqual(prose(timeline.blocks[2]), "Second block.")
        XCTAssertEqual(timeline.proseText, "First.\n\nSecond block.")
    }

    func testHistoryStepsBuildOneActivityRow() {
        let timeline = RelayTimeline(historySteps: [
            RelayStepPatch(id: "h1", kind: .command, title: "Bash", summary: "List files", status: .done),
            RelayStepPatch(id: "h2", kind: .agent, title: "Agent", summary: "Audit", status: .done),
            RelayStepPatch(id: "h3", kind: .read, status: .done, parent: "h2"),
        ])

        XCTAssertFalse(timeline.isEmpty)
        XCTAssertEqual(timeline.blocks.count, 1)
        XCTAssertEqual(stepIDs(timeline.blocks[0]), ["h1", "h2"])
        XCTAssertEqual(timeline.children(of: "h2").map(\.id), ["h3"])
        XCTAssertTrue(RelayTimeline().isEmpty)
    }

    func testARowIsNeverBlank() {
        func summary(_ configure: (inout RelayStepInput) -> Void, kind: RelayStepKind = .tool, summary: String? = nil) -> String {
            var input = RelayStepInput()
            configure(&input)
            var timeline = RelayTimeline()
            timeline.apply(.step(RelayStepPatch(id: "s", kind: kind, summary: summary, status: .done, input: input)))
            return timeline.step("s")?.displaySummary ?? ""
        }

        XCTAssertEqual(summary({ _ in }, summary: "Given"), "Given")
        XCTAssertEqual(summary({ $0.description = "Build the app"; $0.command = "npm run build" }), "Build the app")
        XCTAssertEqual(summary({ $0.command = "npm run build\nnpm test" }), "npm run build")
        XCTAssertEqual(summary({ $0.path = "/work/app/src/cart.ts" }), "cart.ts")
        XCTAssertEqual(summary({ $0.pattern = "roundPrice" }), "roundPrice")
        XCTAssertEqual(summary({ $0.url = "https://docs.example.com/pricing/rounding" }), "docs.example.com")
        XCTAssertEqual(summary({ _ in }, kind: .reasoning), "Thinking")
    }

    func testDurationsReadAsAClockWhileLiveAndInWordsOnceDone() {
        XCTAssertEqual(RelayStepClock.clock(7), "0:07")
        XCTAssertEqual(RelayStepClock.clock(723), "12:03")
        XCTAssertEqual(RelayStepClock.clock(3723), "1:02:03")
        XCTAssertEqual(RelayStepClock.short(4), "4s")
        XCTAssertEqual(RelayStepClock.short(72), "1m 12s")
        XCTAssertEqual(RelayStepClock.short(120), "2m")
        XCTAssertEqual(RelayStepClock.short(7380), "2h 3m")

        var timeline = RelayTimeline()
        let start = Date(timeIntervalSince1970: 1_000)
        timeline.apply(.step(RelayStepPatch(id: "s", kind: .command, status: .running, startedAt: start)))
        XCTAssertEqual(timeline.step("s")?.duration(now: start.addingTimeInterval(9)), 9)
        timeline.settle(as: .cancelled)
        XCTAssertNil(timeline.step("s")?.duration(now: start.addingTimeInterval(9)), "a stopped step with no end time has no honest duration")
    }

    func testTheJobStreamDecodesTimelineEventsAndStillIgnoresUnknownNames() throws {
        let data = #"{"seq":3,"event":{"type":"step","id":"s1","kind":"command","title":"Bash","status":"running","startedAt":"2026-10-06T07:00:06Z"}}"#
        guard case .timeline(let envelope)? = CodexJobStreamEvent.decode(event: "timeline", data: data) else {
            return XCTFail("a timeline event must decode")
        }
        XCTAssertEqual(envelope.seq, 3)
        guard case .step(let patch) = envelope.event else { return XCTFail("expected a step") }
        XCTAssertEqual(patch.kind, .command)
        XCTAssertEqual(patch.startedAt, Date(timeIntervalSince1970: 1_791_270_006))

        XCTAssertNil(CodexJobStreamEvent.decode(event: "hologram", data: "{}"))
        XCTAssertNil(CodexJobStreamEvent.decode(event: "timeline", data: "not json"))
    }

    func testTheTimelineRouteDecodesAPage() throws {
        let body = #"{"jobId":"j1","events":[{"seq":1,"event":{"type":"text","id":"t1","delta":"Hi"}},{"seq":2,"event":{"type":"usage","inputTokens":3}}],"next":2,"complete":true}"#
        let page = try JSONDecoder().decode(RelayTimelinePage.self, from: Data(body.utf8))

        XCTAssertEqual(page.events.map(\.seq), [1, 2])
        XCTAssertEqual(page.next, 2)
        XCTAssertTrue(page.complete)

        var timeline = RelayTimeline()
        page.events.forEach { timeline.apply($0) }
        XCTAssertEqual(timeline.proseText, "Hi")
        XCTAssertEqual(timeline.usage?.inputTokens, 3)
        XCTAssertNil(timeline.usage?.outputTokens)
    }
}

// MARK: - The live data layer

/// A machine the chat can be driven against without a network: job streams the
/// test feeds by hand, timeline pages it scripts, and a record of everything
/// the view model asked for.
@MainActor
private final class LiveScript {
    struct StreamCall: Equatable {
        let stdoutOffset: Int64?
        let stderrOffset: Int64?
        let timeline: Int
    }

    typealias JobContinuation = AsyncThrowingStream<CodexJobStreamEvent, Error>.Continuation

    private(set) var streamCalls: [StreamCall] = []
    private(set) var streams: [JobContinuation] = []
    private(set) var endedStreams = 0
    /// Called for each connection, with its index. The default leaves it open.
    var onStream: ((Int, JobContinuation) -> Void)?
    private(set) var timelineCalls: [Int] = []
    var timelinePage: (Int) throws -> RelayTimelinePage = { _ in try LiveScript.page(events: [], next: 0, complete: true) }
    var history: (threads: [CodexThread], jobs: [CodexJob]) = ([], [])
    var approvals: [CodexApproval] = []
    var chat: (CodexChatRequest) -> AsyncThrowingStream<CodexChatEvent, Error> = { _ in
        AsyncThrowingStream { $0.finish() }
    }
    private(set) var chatRequests: [CodexChatRequest] = []
    private(set) var pauses: [TimeInterval] = []

    func source() -> RelayChatLiveSource {
        RelayChatLiveSource(
            jobEvents: { [unowned self] _, stdoutOffset, stderrOffset, timeline in
                AsyncThrowingStream { continuation in
                    let index = self.streamCalls.count
                    self.streamCalls.append(StreamCall(stdoutOffset: stdoutOffset, stderrOffset: stderrOffset, timeline: timeline))
                    self.streams.append(continuation)
                    continuation.onTermination = { [weak self] _ in
                        Task { @MainActor in self?.endedStreams += 1 }
                    }
                    self.onStream?(index, continuation)
                }
            },
            timelinePage: { [unowned self] _, since in
                self.timelineCalls.append(since)
                return try self.timelinePage(since)
            },
            chatEvents: { [unowned self] request in
                self.chatRequests.append(request)
                return self.chat(request)
            },
            history: { [unowned self] _ in self.history },
            pendingApprovals: { [unowned self] in self.approvals },
            pause: { [unowned self] seconds in
                self.pauses.append(seconds)
                await Task.yield()
            }
        )
    }

    static func page(events: [String], next: Int, complete: Bool, firstSeq: Int = 1) throws -> RelayTimelinePage {
        let body = events.enumerated()
            .map { #"{"seq":\#(firstSeq + $0.offset),"event":\#($0.element)}"# }
            .joined(separator: ",")
        let json = #"{"jobId":"job-1","events":[\#(body)],"next":\#(next),"complete":\#(complete)}"#
        return try JSONDecoder().decode(RelayTimelinePage.self, from: Data(json.utf8))
    }

    static func timeline(_ seq: Int, _ event: String) -> CodexJobStreamEvent {
        CodexJobStreamEvent.decode(event: "timeline", data: #"{"seq":\#(seq),"event":\#(event)}"#)!
    }

    static func text(_ id: String, _ delta: String) -> String {
        #"{"type":"text","id":"\#(id)","delta":"\#(delta)"}"#
    }

    static func step(_ id: String, _ status: String, kind: String = "command") -> String {
        #"{"type":"step","id":"\#(id)","kind":"\#(kind)","title":"Bash","status":"\#(status)"}"#
    }
}

@MainActor
final class RelayChatLiveDataTests: XCTestCase {
    private func job(_ json: String) throws -> CodexJob {
        try JSONDecoder().decode(CodexJob.self, from: Data(json.utf8))
    }

    private func runningJob(_ extra: String = "") throws -> CodexJob {
        try job(#"{"id":"job-1","provider":"claude","status":"running","workspaceId":"ws","prompt":"Fix the bug","model":"opus","sessionId":"session-1","logsIncluded":"preview"\#(extra)}"#)
    }

    private func makeModel(
        _ script: LiveScript,
        detail: @escaping (String) async throws -> CodexJob,
        thread: ((String, String?, CodexProvider) async throws -> CodexThreadDetail)? = nil,
        workspaceID: String? = "ws",
        publishInterval: TimeInterval = 0
    ) -> RelayChatViewModel {
        RelayChatViewModel(
            client: CodexClient(baseURL: URL(string: "http://127.0.0.1:9")!, identityStore: ClientIdentityStore()),
            workspaceID: workspaceID,
            workspacePath: nil,
            fetchJobDetail: detail,
            fetchThreadDetail: thread,
            live: script.source(),
            publishInterval: publishInterval
        )
    }

    /// Opens a running job as the conversation and waits for its stream to connect.
    private func openRunningJob(_ script: LiveScript, model: RelayChatViewModel, job: CodexJob) async throws {
        await model.openHistoryItem(CodexThreadFeedItem(source: .pendingJob(job)))
        try await waitUntil("the job stream connects") { !script.streamCalls.isEmpty }
    }

    private func waitUntil(
        _ what: String,
        timeout: TimeInterval = 3,
        file: StaticString = #filePath,
        line: UInt = #line,
        _ condition: () -> Bool
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline {
                XCTFail("Timed out waiting until \(what)", file: file, line: line)
                throw CancellationError()
            }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    // MARK: Event dispatch

    func testAnEventIsDispatchedByTheBlankLineThatEndsItNotByTheNextEvent() {
        var decoder = CodexSSEDecoder<CodexJobStreamEvent> { CodexJobStreamEvent.decode(event: $0, data: $1) }

        let step = #"event: timeline\#ndata: {"seq":1,"event":{"type":"step","id":"s1","kind":"command","status":"running"}}\#n"#
        XCTAssertTrue(decoder.ingest(Array(step.utf8)).isEmpty, "the event is not complete until its blank line")

        let dispatched = decoder.ingest(Array("\n".utf8))
        guard case .timeline(let envelope)? = dispatched.first, dispatched.count == 1 else {
            return XCTFail("the blank line must dispatch the running step with nothing after it, got \(dispatched)")
        }
        XCTAssertEqual(envelope.seq, 1)

        // Heartbeat comments between events neither produce nor swallow anything.
        XCTAssertTrue(decoder.ingest(Array(": heartbeat\n\n: heartbeat\n\n".utf8)).isEmpty)

        // CRLF framing, and a multi-byte character split across reads.
        let chunk = Array("event: stdout\r\ndata: {\"offset\":0,\"text\":\"né\"}\r\n\r\n".utf8)
        let cut = chunk.count - 8
        XCTAssertTrue(decoder.ingest(chunk[..<cut]).isEmpty)
        XCTAssertEqual(decoder.ingest(chunk[cut...]), [.stdout(offset: 0, text: "né")])
        XCTAssertTrue(decoder.finish().isEmpty)
    }

    func testAResumingJobStreamNamesItsOffsetsTheWayTheDaemonPrefers() {
        XCTAssertNil(CodexClient.jobStreamLastEventID(stdoutOffset: nil, stderrOffset: nil, timeline: 0), "a first connection names nothing")
        XCTAssertEqual(CodexClient.jobStreamLastEventID(stdoutOffset: 1340, stderrOffset: 0, timeline: 143), "1340:0:143")
        XCTAssertEqual(CodexClient.jobStreamLastEventID(stdoutOffset: 7, stderrOffset: nil, timeline: nil), "7:0:0")
    }

    func testTheRealDaemonsTimelineShapesReduceCleanly() throws {
        // A step's first event is bare; summary and input follow, input whole
        // each time. Read and search steps can carry an exit code. Reasoning
        // has no text. Usage carries fields this build does not know.
        let lines = [
            #"{"type":"step","id":"r1","kind":"reasoning","status":"running","startedAt":"2026-10-06T07:00:00.000Z"}"#,
            #"{"type":"step","id":"r1","status":"done","endedAt":"2026-10-06T07:00:00.200Z"}"#,
            #"{"type":"step","id":"s1","kind":"read","status":"running"}"#,
            #"{"type":"step","id":"s1","summary":"pricing.ts","input":{"command":"sed -n 1,40p pricing.ts","path":"pricing.ts"}}"#,
            #"{"type":"step","id":"s1","status":"failed","exitCode":2,"output":"sed: no such file","input":{"command":"sed -n 1,40p pricing.ts","path":"pricing.ts"}}"#,
            #"{"type":"step","id":"s2","kind":"command","status":"done","exitCode":0}"#,
            #"{"type":"usage","inputTokens":10,"outputTokens":4,"cachedInputTokens":6,"reasoningOutputTokens":1,"totalTokens":14}"#
        ]
        var timeline = RelayTimeline()
        for line in lines {
            timeline.apply(try JSONDecoder().decode(RelayTimelineEvent.self, from: Data(line.utf8)))
        }
        XCTAssertEqual(timeline.cursor, 7)
        XCTAssertEqual(timeline.step("s1")?.displaySummary, "pricing.ts")
        XCTAssertEqual(timeline.step("s1")?.input.command, "sed -n 1,40p pricing.ts")
        XCTAssertEqual(timeline.step("s1")?.exitCode, 2)
        XCTAssertEqual(timeline.step("r1")?.output, "")
        XCTAssertEqual(timeline.usage?.outputTokens, 4)

        let block = try XCTUnwrap(timeline.blocks.first)
        let steps = timeline.steps(in: block)
        XCTAssertEqual(RelayTimeline.summary(of: steps), "Thought, read a file, ran a command", "a failed step still counts under its kind")
        XCTAssertEqual(RelayTimeline.failedCount(in: steps), 1)
        XCTAssertEqual(timeline.failedCount(in: block), 1)

        // Thinking that took no measurable time is "Thought", never "Thought for 0s".
        let thinking = steps.filter { $0.kind == .reasoning }
        XCTAssertEqual(RelayTimeline.summary(of: thinking), "Thought")
        var instant = RelayTimeline()
        let at = Date(timeIntervalSince1970: 1_000)
        instant.apply(.step(RelayStepPatch(id: "r", kind: .reasoning, status: .done, startedAt: at, endedAt: at)))
        instant.apply(.step(RelayStepPatch(id: "r2", kind: .reasoning, status: .done)))
        XCTAssertEqual(RelayTimeline.summary(of: instant.steps(in: instant.blocks[0])), "Thought")
    }

    func testTheLineSplitterKeepsBlankLinesWhichURLSessionLinesDrops() {
        var splitter = CodexSSELineSplitter()
        var lines: [String] = []
        for byte in Array("a\n\nb\r\n\r\nc".utf8) {
            if let line = splitter.ingest(byte) { lines.append(line) }
        }
        if let last = splitter.finish() { lines.append(last) }
        XCTAssertEqual(lines, ["a", "", "b", "", "c"])
    }

    func testStreamsAreNotBoundByTheRequestSessionsOneMinuteCap() {
        XCTAssertGreaterThanOrEqual(CodexClient.streamResourceTimeout, 4 * 60 * 60, "a stream must be able to outlast the longest run")
    }

    // MARK: Re-attach

    func testADroppedStreamReattachesFromTheOffsetsAndCursorHeldWithoutDuplicates() async throws {
        let script = LiveScript()
        let running = try runningJob()
        script.onStream = { index, stream in
            if index == 0 {
                stream.yield(.status(running))
                stream.yield(.stdout(offset: 0, text: "abc"))
                stream.yield(.stderr(offset: 0, text: "é"))
                stream.yield(LiveScript.timeline(1, LiveScript.text("t1", "Hello ")))
                stream.yield(LiveScript.timeline(2, LiveScript.step("s1", "running")))
                // Dropped: no `done`.
                stream.finish(throwing: URLError(.networkConnectionLost))
            } else {
                // The machine replays a little before the offset, and one event again.
                stream.yield(.stdout(offset: 1, text: "bcd"))
                stream.yield(LiveScript.timeline(2, LiveScript.step("s1", "running")))
                stream.yield(LiveScript.timeline(3, LiveScript.text("t1", "world")))
            }
        }
        let model = makeModel(script, detail: { _ in running })
        try await openRunningJob(script, model: model, job: running)
        try await waitUntil("the stream reconnects and catches up") { model.timelines["job-1"]?.cursor == 3 }

        XCTAssertEqual(script.streamCalls, [
            .init(stdoutOffset: nil, stderrOffset: nil, timeline: 0),
            .init(stdoutOffset: 3, stderrOffset: 2, timeline: 2)
        ], "the reconnect names the bytes of each log and the events already held (é is two bytes)")
        XCTAssertEqual(model.liveJobTails["job-1"], "abcéd", "replayed bytes are dropped, new ones kept")
        XCTAssertEqual(model.timeline(forJobID: "job-1")?.proseText, "Hello world")
        XCTAssertEqual(model.timeline(forJobID: "job-1")?.runningSteps.map(\.id), ["s1"])
        XCTAssertEqual(script.pauses, [RelayChatViewModel.streamRetryDelays[0]])

        // `done` ends it: no further reconnect.
        let finished = try job(#"{"id":"job-1","provider":"claude","status":"succeeded","result":"Done.","logsIncluded":"preview"}"#)
        script.streams[1].yield(.done(finished))
        try await waitUntil("the job finishes") { model.messages.last?.job?.status == .succeeded }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(script.streamCalls.count, 2)
    }

    func testAfterRepeatedFailuresThePollPagesTheTimelineAndTheStreamIsTriedAgainOnResume() async throws {
        let script = LiveScript()
        var polled = try runningJob()
        script.onStream = { index, stream in
            // Dead until the app comes back to the foreground.
            if index <= RelayChatViewModel.streamRetryDelays.count {
                stream.finish(throwing: URLError(.cannotConnectToHost))
            }
        }
        script.timelinePage = { since in
            since == 0
                ? try LiveScript.page(events: [LiveScript.text("t1", "Polled "), LiveScript.step("s1", "running")], next: 2, complete: false)
                : try LiveScript.page(events: [], next: since, complete: false)
        }
        let model = makeModel(script, detail: { _ in polled })
        try await openRunningJob(script, model: model, job: polled)

        let attempts = RelayChatViewModel.streamRetryDelays.count + 1
        try await waitUntil("the stream gives up") { script.endedStreams == attempts }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(script.streamCalls.count, attempts, "one connection and a bounded number of retries")
        XCTAssertEqual(script.pauses, RelayChatViewModel.streamRetryDelays, "each retry waits longer than the last")
        XCTAssertNil(model.timeline(forJobID: "job-1"))

        // The poll now carries the job: it learns there is a timeline and pages it.
        polled = try runningJob(#","timelineEvents":2"#)
        await model.refreshActiveWorkIfNeeded()
        XCTAssertEqual(script.timelineCalls, [0])
        XCTAssertEqual(model.timeline(forJobID: "job-1")?.proseText, "Polled ")
        XCTAssertEqual(script.streamCalls.count, attempts, "the stream is not hammered while the poll is carrying the job")

        // Nothing new: the next poll asks from the cursor and applies nothing twice.
        polled = try runningJob(#","timelineEvents":3"#)
        script.timelinePage = { since in
            try LiveScript.page(events: [LiveScript.text("t1", "again")], next: 3, complete: false, firstSeq: since + 1)
        }
        await model.refreshActiveWorkIfNeeded()
        XCTAssertEqual(script.timelineCalls, [0, 2])
        XCTAssertEqual(model.timeline(forJobID: "job-1")?.proseText, "Polled again")

        // Back in the foreground: reconnect at once, from the cursor held.
        model.resumeLiveWork()
        try await waitUntil("the stream is re-attached") { script.streamCalls.count == attempts + 1 }
        XCTAssertEqual(script.streamCalls.last?.timeline, 3)
    }

    func testReturningToTheForegroundRestartsTheStreamFromWhatIsHeld() async throws {
        let script = LiveScript()
        let running = try runningJob()
        script.onStream = { index, stream in
            guard index == 0 else { return }
            stream.yield(.stdout(offset: 0, text: "building\n"))
            stream.yield(LiveScript.timeline(1, LiveScript.step("s1", "running")))
        }
        let model = makeModel(script, detail: { _ in running })
        try await openRunningJob(script, model: model, job: running)
        try await waitUntil("the first events land") { model.timelines["job-1"]?.cursor == 1 }

        // The connection looks open, but the phone has been asleep.
        model.resumeLiveWork(restartingStreams: true)
        try await waitUntil("a second connection opens") { script.streamCalls.count == 2 }
        XCTAssertEqual(script.streamCalls[1], .init(stdoutOffset: 9, stderrOffset: 0, timeline: 1))
        try await waitUntil("the stale connection is closed") { script.endedStreams == 1 }
        XCTAssertEqual(model.liveJobTails["job-1"], "building\n", "what was already shown stays")

        // Becoming active without having been backgrounded leaves a live stream alone.
        model.resumeLiveWork()
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(script.streamCalls.count, 2)
    }

    func testAMachineWithoutTimelinesStaysOnTheLegacyPathQuietly() async throws {
        // A job that reports no `timelineEvents`: the route is never called.
        let script = LiveScript()
        let legacy = try job(#"{"id":"job-1","status":"succeeded","workspaceId":"ws","result":"Legacy answer"}"#)
        let model = makeModel(script, detail: { _ in legacy })
        await model.openHistoryItem(CodexThreadFeedItem(source: .pendingJob(legacy)))
        await model.syncTimelines()
        XCTAssertTrue(script.timelineCalls.isEmpty)
        XCTAssertNil(model.timeline(forJobID: "job-1"))
        XCTAssertNil(model.errorMessage)
        XCTAssertEqual(model.messages.last?.text, "Legacy answer")

        // A 404 from the route: asked once, never again, and nothing is shown for it.
        let missing = LiveScript()
        missing.timelinePage = { _ in throw CodexClientError.httpFailure(404, nil) }
        let claimed = try job(#"{"id":"job-1","status":"succeeded","workspaceId":"ws","result":"Answer","timelineEvents":4}"#)
        let second = makeModel(missing, detail: { _ in claimed })
        await second.openHistoryItem(CodexThreadFeedItem(source: .pendingJob(claimed)))
        await second.syncTimelines()
        await second.syncTimelines()
        XCTAssertEqual(missing.timelineCalls, [0])
        XCTAssertNil(second.timeline(forJobID: "job-1"))
        XCTAssertNil(second.errorMessage)

        // An empty timeline is no timeline.
        let empty = LiveScript()
        let third = makeModel(empty, detail: { _ in claimed })
        await third.openHistoryItem(CodexThreadFeedItem(source: .pendingJob(claimed)))
        await third.syncTimelines()
        XCTAssertNil(third.timeline(forJobID: "job-1"))
    }

    func testAFinishedJobOpenedFromHistoryFetchesItsTimelineOnceAndSettlesIt() async throws {
        let script = LiveScript()
        script.timelinePage = { since in
            since == 0
                ? try LiveScript.page(events: [LiveScript.text("t1", "Hi"), LiveScript.step("s1", "running")], next: 2, complete: false)
                : try LiveScript.page(events: [LiveScript.step("s2", "done")], next: 3, complete: true, firstSeq: 3)
        }
        let finished = try job(#"{"id":"job-1","status":"failed","workspaceId":"ws","prompt":"Go","timelineEvents":3}"#)
        let model = makeModel(script, detail: { _ in finished })
        await model.openHistoryItem(CodexThreadFeedItem(source: .pendingJob(finished)))
        await model.syncTimelines()
        try await waitUntil("the timeline is paged in") { model.timelines["job-1"]?.cursor == 3 }

        XCTAssertEqual(script.timelineCalls, [0, 2], "paged with `next` until complete")
        XCTAssertTrue(script.streamCalls.isEmpty, "a finished job has no stream")
        XCTAssertEqual(model.timeline(forJobID: "job-1")?.step("s1")?.status, .failed, "a step the writer never closed takes the job's outcome")
        XCTAssertEqual(model.timeline(forJobID: "job-1")?.step("s2")?.status, .done)

        await model.syncTimelines()
        XCTAssertEqual(script.timelineCalls, [0, 2], "fetched once, not on every pass")
    }

    // MARK: Coalescing and settling

    func testABurstOfEventsIsPublishedInBatches() async throws {
        let script = LiveScript()
        let running = try runningJob()
        let model = makeModel(script, detail: { _ in running }, publishInterval: 0.08)
        try await openRunningJob(script, model: model, job: running)

        var timelinePublishes = 0
        var tailPublishes = 0
        let watchTimelines = model.$timelines.dropFirst().sink { _ in timelinePublishes += 1 }
        let watchTails = model.$liveJobTails.dropFirst().sink { _ in tailPublishes += 1 }
        defer { watchTimelines.cancel(); watchTails.cancel() }

        var offset: Int64 = 0
        for seq in 1...120 {
            script.streams[0].yield(LiveScript.timeline(seq, LiveScript.text("t1", "w\(seq) ")))
            script.streams[0].yield(.stdout(offset: offset, text: "line\n"))
            offset += 5
        }
        try await waitUntil("every event is on screen") { model.timelines["job-1"]?.cursor == 120 }

        XCTAssertLessThanOrEqual(timelinePublishes, 4, "120 events must not be 120 redraws")
        XCTAssertLessThanOrEqual(tailPublishes, 4)
        XCTAssertEqual(model.liveJobTails["job-1"]?.count, 600)
        XCTAssertTrue(model.timeline(forJobID: "job-1")?.proseText.hasSuffix("w120 ") == true, "nothing is lost to batching")
    }

    func testATimelineIsSettledByWhicheverPathEndsTheJob() async throws {
        // The stream's `done`.
        do {
            let script = LiveScript()
            let running = try runningJob()
            let model = makeModel(script, detail: { _ in running })
            try await openRunningJob(script, model: model, job: running)
            script.streams[0].yield(LiveScript.timeline(1, LiveScript.step("s1", "running")))
            script.streams[0].yield(.done(try job(#"{"id":"job-1","status":"succeeded","result":"ok","logsIncluded":"preview"}"#)))
            try await waitUntil("done settles the step") { model.timeline(forJobID: "job-1")?.step("s1")?.status == .done }
            XCTAssertTrue(model.timeline(forJobID: "job-1")?.runningSteps.isEmpty == true)
            XCTAssertNil(model.liveJobTails["job-1"])
        }
        // A poll that finds the job failed while the stream says nothing.
        do {
            let script = LiveScript()
            var polled = try runningJob()
            let model = makeModel(script, detail: { _ in polled })
            try await openRunningJob(script, model: model, job: polled)
            script.streams[0].yield(LiveScript.timeline(1, LiveScript.step("s1", "running")))
            try await waitUntil("the step is running") { model.timeline(forJobID: "job-1")?.runningSteps.count == 1 }
            polled = try job(#"{"id":"job-1","provider":"claude","status":"failed","error":"boom","logsIncluded":"preview"}"#)
            await model.refreshActiveWorkIfNeeded()
            XCTAssertEqual(model.timeline(forJobID: "job-1")?.step("s1")?.status, .failed)
            try await waitUntil("the stream is closed once the job is over") { script.endedStreams == 1 }
        }
        // A cancel, seen here through the folder's list (the same merge a cancel response takes).
        do {
            let script = LiveScript()
            let running = try runningJob()
            let model = makeModel(script, detail: { _ in running })
            try await openRunningJob(script, model: model, job: running)
            script.streams[0].yield(LiveScript.timeline(1, LiveScript.step("s1", "running")))
            try await waitUntil("the step is running") { model.timeline(forJobID: "job-1")?.runningSteps.count == 1 }
            script.history = ([], [try job(#"{"id":"job-1","provider":"claude","status":"canceled","workspaceId":"ws","logsIncluded":"compact"}"#)])
            await model.refreshThreads()
            XCTAssertEqual(model.timeline(forJobID: "job-1")?.step("s1")?.status, .cancelled)
            XCTAssertEqual(model.messages.last?.job?.status, .canceled)
        }
    }

    // MARK: Job integrity

    func testAPartialStatusEventUpdatesTheJobWithoutErasingIt() async throws {
        let script = LiveScript()
        let running = try job(#"{"id":"job-1","provider":"claude","status":"queued","workspaceId":"ws","prompt":"Fix the bug","model":"opus","sessionId":"session-1","result":"So far","logsIncluded":"preview","artifacts":[{"id":"a1","kind":"file","filename":"out.txt"}]}"#)
        let model = makeModel(script, detail: { _ in running })
        try await openRunningJob(script, model: model, job: running)

        // Exactly what relayd's `jobStatusPayload` carries.
        let status = try XCTUnwrap(CodexJobStreamEvent.decode(event: "status", data: #"{"id":"job-1","status":"running","provider":"claude","workspaceId":"ws","createdAt":"2026-10-06T07:00:00Z","startedAt":"2026-10-06T07:00:01Z","finishedAt":null,"updatedAt":"2026-10-06T07:00:01Z","exitCode":null,"timedOut":false,"error":null}"#))
        script.streams[0].yield(status)
        try await waitUntil("the status lands") { model.messages.last?.job?.status == .running }

        let shown = try XCTUnwrap(model.messages.last?.job)
        XCTAssertEqual(shown.prompt, "Fix the bug")
        XCTAssertEqual(shown.model, "opus")
        XCTAssertEqual(shown.sessionId, "session-1")
        XCTAssertEqual(shown.result, "So far")
        XCTAssertEqual(shown.artifacts.count, 1)
        XCTAssertEqual(shown.logsIncluded, "preview")
        XCTAssertNotNil(shown.startedAt)
        XCTAssertEqual(model.messages.last?.text, "So far")
        XCTAssertEqual(model.liveJob(id: "job-1")?.prompt, "Fix the bug")
    }

    func testAPoorerCopyNeverOverwritesARicherOne() async throws {
        let long = String(repeating: "x", count: 20_000)
        let script = LiveScript()
        let rich = try job(#"{"id":"job-1","provider":"claude","status":"succeeded","workspaceId":"ws","prompt":"Go","result":"\#(long)","resultBytes":20000,"logsIncluded":"preview"}"#)
        let model = makeModel(script, detail: { _ in rich })
        await model.openHistoryItem(CodexThreadFeedItem(source: .pendingJob(rich)))
        XCTAssertEqual(model.messages.last?.job?.result?.count, 20_000)

        // The list poll: the first 4 KiB, with nothing to say it was cut.
        let compact = try job(#"{"id":"job-1","provider":"claude","status":"succeeded","workspaceId":"ws","prompt":"Go","result":"\#(String(long.prefix(4096)))","resultBytes":20000,"logsIncluded":"compact"}"#)
        script.history = ([], [compact])
        await model.refreshThreads()

        XCTAssertEqual(model.messages.last?.job?.result?.count, 20_000, "the answer on screen is not cut to the list's 4 KiB")
        XCTAssertEqual(model.messages.last?.job?.logsIncluded, "preview")
        XCTAssertEqual(model.liveJob(id: "job-1")?.result?.count, 20_000)
        XCTAssertEqual(model.jobs.first?.result?.count, 20_000, "the history list keeps the richer copy of an on-screen job too")
    }

    func testJobCopiesMergeByWhatEachKnowsBest() throws {
        let preview = try job(#"{"id":"j","provider":"claude","status":"running","prompt":"P","result":"partial answer","logsIncluded":"preview","timelineEvents":7}"#)

        // The run ends and a compact copy is the first to say so: its ending is
        // taken, because the held text is of a run that has moved on.
        let ended = preview.absorbing(try job(#"{"id":"j","status":"succeeded","result":"final","logsIncluded":"compact","timelineEvents":9}"#))
        XCTAssertEqual(ended.status, .succeeded)
        XCTAssertEqual(ended.result, "final")
        XCTAssertEqual(ended.logsIncluded, "compact")
        XCTAssertEqual(ended.prompt, "P")
        XCTAssertEqual(ended.provider, .claude, "a copy that omits the provider does not change it")
        XCTAssertEqual(ended.timelineEvents, 9)

        // Detail then lands and is kept against every later compact copy.
        let detailed = ended.absorbing(try job(#"{"id":"j","provider":"claude","status":"succeeded","result":"final, in full","logsIncluded":"preview"}"#))
        XCTAssertEqual(detailed.result, "final, in full")
        XCTAssertEqual(detailed.absorbing(try job(#"{"id":"j","provider":"claude","status":"succeeded","result":"final","logsIncluded":"compact"}"#)).result, "final, in full")
        XCTAssertEqual(detailed.timelineEvents, 9)

        // A stale poll that raced the ending cannot bring the job back to life.
        XCTAssertEqual(detailed.absorbing(preview).status, .succeeded)

        // While a job runs, a full log read a moment ago is not held against the next preview.
        let full = preview.absorbing(try job(#"{"id":"j","provider":"claude","status":"running","result":"older","logsIncluded":"full"}"#))
        XCTAssertEqual(full.absorbing(try job(#"{"id":"j","provider":"claude","status":"running","result":"newer","logsIncluded":"preview"}"#)).result, "newer")

        XCTAssertEqual(try job(#"{"id":"j","status":"running","timelineEvents":12}"#).timelineEvents, 12)
        XCTAssertNil(try job(#"{"id":"j","status":"running","timelineEvents":"many"}"#).timelineEvents, "a malformed count is no count, not a job that fails to decode")
        XCTAssertNil(try job(#"{"id":"j","status":"running"}"#).timelineEvents)
    }

    // MARK: Conversation isolation

    func testEventsAndApprovalsOfAConversationTheUserLeftDoNotReachTheNewOne() async throws {
        let script = LiveScript()
        let running = try runningJob()
        script.approvals = [try JSONDecoder().decode(CodexApproval.self, from: Data(#"{"id":"ap-1","jobId":"job-1","provider":"claude","kind":"command","title":"Run npm test","status":"pending","availableDecisions":["accept","decline"]}"#.utf8))]
        let model = makeModel(script, detail: { _ in running })
        try await openRunningJob(script, model: model, job: running)
        script.streams[0].yield(LiveScript.timeline(1, LiveScript.step("s1", "running")))
        try await waitUntil("the timeline shows") { model.timeline(forJobID: "job-1") != nil }
        await model.refreshActiveWorkIfNeeded()
        XCTAssertEqual(model.pendingApprovals.map(\.id), ["ap-1"])
        XCTAssertEqual(model.currentSessionProvider, .claude)

        model.startNewConversation()
        XCTAssertTrue(model.pendingApprovals.isEmpty, "an approval for a job that is not on screen is not offered")
        XCTAssertTrue(model.timelines.isEmpty, "timelines of jobs no longer on screen are dropped")
        XCTAssertTrue(model.liveJobTails.isEmpty)

        // The old job's stream ends late, naming its session.
        script.streams[0].yield(LiveScript.timeline(2, LiveScript.text("t1", "late")))
        script.streams[0].yield(.done(try job(#"{"id":"job-1","provider":"claude","status":"succeeded","sessionId":"session-1","workspaceId":"ws","result":"old answer"}"#)))
        try await waitUntil("the old stream is closed") { script.endedStreams == 1 }
        try await Task.sleep(nanoseconds: 50_000_000)

        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.currentSessionProvider, "the new conversation is not bound to the old job's session")
        XCTAssertTrue(model.timelines.isEmpty)
        XCTAssertEqual(script.streamCalls.count, 1, "the stream of a job the user left is not re-attached")

        // An approvals request that was out when the conversation changed.
        await model.refreshActiveWorkIfNeeded()
        XCTAssertTrue(model.pendingApprovals.isEmpty)
    }

    // MARK: Thread history

    private func threadDetail(_ json: String) throws -> CodexThreadDetail {
        try JSONDecoder().decode(CodexThreadDetail.self, from: Data(json.utf8))
    }

    private func thread(_ id: String = "th-1") throws -> CodexThread {
        try JSONDecoder().decode(CodexThread.self, from: Data(#"{"id":"\#(id)","sessionId":"\#(id)","workspaceId":"ws","provider":"claude"}"#.utf8))
    }

    func testHistoryStepsBecomeTheTimelineOfTheMessageTheyPrecede() async throws {
        let read = #"{"id":"h1","kind":"read","title":"Read","summary":"pricing.ts","status":"done","startedAt":"2026-10-06T07:00:05Z","endedAt":"2026-10-06T07:00:06Z","input":{"path":"/work/pricing.ts"}}"#
        let failed = #"{"id":"h2","kind":"command","title":"Bash","status":"failed","exitCode":1,"output":"1 failing"}"#
        let unclosed = #"{"id":"h3","kind":"command","title":"Bash","status":"running"}"#
        let unstated = #"{"id":"h4","kind":"edit","title":"Edit"}"#
        let detail = try threadDetail(#"""
        {"thread":{"id":"th-1","sessionId":"th-1","workspaceId":"ws","provider":"claude"},
         "messages":[
           {"role":"user","text":"Fix it","timestamp":"2026-10-06T07:00:00Z"},
           {"role":"assistant","text":"Reading first.","timestamp":"2026-10-06T07:00:10Z","steps":[\#(read),{"kind":"no id"},\#(failed)]},
           {"role":"assistant","text":"Done.","timestamp":"2026-10-06T07:00:20Z","steps":"not an array"}
         ],
         "trailingSteps":[\#(unclosed),\#(unstated)],
         "jobs":[]}
        """#)
        XCTAssertEqual(detail.messages[1].steps.map(\.id), ["h1", "h2"], "a step this build cannot read costs only itself")
        XCTAssertTrue(detail.messages[2].steps.isEmpty)
        XCTAssertEqual(detail.trailingSteps.map(\.id), ["h3", "h4"])

        let model = makeModel(LiveScript(), detail: { _ in throw CancellationError() }, thread: { _, _, _ in detail })
        await model.openThread(try thread())

        XCTAssertEqual(model.messages.map(\.role), [.user, .assistant, .assistant])
        XCTAssertNil(model.messages[0].historyTimeline)
        let first = try XCTUnwrap(model.messages[1].historyTimeline)
        XCTAssertEqual(first.blocks.count, 1)
        XCTAssertEqual(first.steps(in: first.blocks[0]).map(\.id), ["h1", "h2"])
        XCTAssertEqual(first.step("h1")?.displaySummary, "pricing.ts")
        XCTAssertEqual(first.step("h1")?.duration(now: Date()), 1)
        XCTAssertEqual(first.step("h2")?.status, .failed)

        // Trailing steps attach to the last assistant message. In a thread
        // that is no longer working, a step left running was interrupted and
        // one that names no status ran to completion.
        let last = try XCTUnwrap(model.messages[2].historyTimeline)
        XCTAssertEqual(last.step("h3")?.status, .cancelled)
        XCTAssertEqual(last.step("h4")?.status, .done)
        XCTAssertTrue(last.runningSteps.isEmpty)
    }

    func testTrailingStepsAfterTheUsersMessageStandAsTheAnswerSoFar() async throws {
        let detail = try threadDetail(#"""
        {"thread":{"id":"th-1","sessionId":"th-1","workspaceId":"ws","provider":"claude","activeJobCount":1},
         "messages":[
           {"role":"assistant","text":"Earlier answer.","timestamp":"2026-10-06T06:00:00Z"},
           {"role":"user","text":"Now fix it","timestamp":"2026-10-06T07:00:00Z"}
         ],
         "trailingSteps":[{"id":"h1","kind":"command","title":"Bash","status":"running"}],
         "jobs":[]}
        """#)
        let model = makeModel(LiveScript(), detail: { _ in throw CancellationError() }, thread: { _, _, _ in detail })
        await model.openThread(try thread())

        XCTAssertEqual(model.messages.map(\.role), [.assistant, .user, .assistant])
        XCTAssertNil(model.messages[0].historyTimeline, "steps that follow the user's prompt are not drawn above it")
        XCTAssertEqual(model.messages[2].text, "")
        XCTAssertEqual(model.messages[2].historyTimeline?.runningSteps.map(\.id), ["h1"], "the thread is still working, so the step is still running")
        XCTAssertTrue(RelayChatViewModel.chatHistory(from: model.messages).allSatisfy { !$0.content.isEmpty })
    }

    func testARestoredTurnShowsItsAnswerOnceWithItsJobAfterItsPrompt() async throws {
        // The job was created a moment before the session file recorded the prompt.
        let detail = try threadDetail(#"""
        {"thread":{"id":"th-1","sessionId":"th-1","workspaceId":"ws","provider":"claude"},
         "messages":[
           {"role":"user","text":"First question","timestamp":"2026-10-06T07:00:02Z"},
           {"role":"assistant","text":"First answer.","timestamp":"2026-10-06T07:00:30Z"},
           {"role":"user","text":"Second question","timestamp":"2026-10-06T07:05:02Z"},
           {"role":"assistant","text":"Second answer.","timestamp":"2026-10-06T07:05:30Z"}
         ],
         "jobs":[
           {"id":"job-2","provider":"claude","status":"succeeded","workspaceId":"ws","prompt":"Second question","result":"Second answer.","createdAt":"2026-10-06T07:05:00Z","completedAt":"2026-10-06T07:05:31Z"},
           {"id":"job-1","provider":"claude","status":"succeeded","workspaceId":"ws","prompt":"First question","result":"First answer.","createdAt":"2026-10-06T07:00:00Z","completedAt":"2026-10-06T07:00:31Z","artifacts":[{"id":"a1","kind":"file","filename":"out.txt"}]}
         ]}
        """#)
        let model = makeModel(LiveScript(), detail: { _ in throw CancellationError() }, thread: { _, _, _ in detail })
        await model.openThread(try thread())

        XCTAssertEqual(
            model.messages.map { $0.job?.id ?? $0.text },
            ["First question", "First answer.", "job-1", "Second question", "Second answer.", "job-2"],
            "each job follows its own prompt and answer"
        )
        XCTAssertEqual(model.messages.filter { $0.role == .job }.map(\.hidesJobAnswer), [true, true], "the transcript already shows each answer")
        XCTAssertEqual(model.messages[2].job?.artifacts.count, 1, "the job row still carries what the turn does not")
    }

    func testAJobTheTranscriptDoesNotAnswerKeepsItsAnswer() async throws {
        let detail = try threadDetail(#"""
        {"thread":{"id":"th-1","sessionId":"th-1","workspaceId":"ws","provider":"codex","activeJobCount":1},
         "messages":[
           {"role":"user","text":"Older question","timestamp":"2026-10-06T07:00:02Z"},
           {"role":"assistant","text":"Older answer.","timestamp":"2026-10-06T07:00:30Z"},
           {"role":"user","text":"Run the tests","timestamp":"2026-10-06T07:05:02Z"}
         ],
         "jobs":[
           {"id":"job-old","provider":"codex","status":"failed","workspaceId":"ws","prompt":"Something the transcript never recorded","error":"boom","createdAt":"2026-10-06T06:00:00Z","completedAt":"2026-10-06T06:00:05Z"},
           {"id":"job-live","provider":"codex","status":"running","workspaceId":"ws","prompt":"Run the tests","createdAt":"2026-10-06T07:05:00Z"}
         ]}
        """#)
        let script = LiveScript()
        let model = makeModel(script, detail: { _ in throw CancellationError() }, thread: { _, _, _ in detail })
        await model.openThread(try thread())

        XCTAssertEqual(
            model.messages.map { $0.job?.id ?? $0.text },
            ["job-old", "Older question", "Older answer.", "Run the tests", "job-live"]
        )
        XCTAssertEqual(model.messages.filter { $0.role == .job }.map(\.hidesJobAnswer), [false, false])
        try await waitUntil("the active job of an opened thread is attached") { script.streamCalls.count == 1 }
    }

    func testRestoredTurnIdsSurviveTheWindowSliding() async throws {
        func detail(dropping dropped: Int, adding extra: String = "") throws -> CodexThreadDetail {
            let turns = [
                #"{"role":"user","text":"One","timestamp":"2026-10-06T07:00:00Z"}"#,
                #"{"role":"assistant","text":"Answer one","timestamp":"2026-10-06T07:00:10Z"}"#,
                #"{"role":"user","text":"Two"}"#,
                #"{"role":"assistant","text":"Answer two"}"#,
                #"{"role":"user","text":"Two"}"#,
                #"{"role":"assistant","text":"Answer three"}"#
            ].dropFirst(dropped).joined(separator: ",")
            return try threadDetail(#"{"thread":{"id":"th-1","sessionId":"th-1","workspaceId":"ws","provider":"claude"},"messages":[\#(turns)\#(extra)],"jobs":[]}"#)
        }
        var current = try detail(dropping: 0)
        let model = makeModel(LiveScript(), detail: { _ in throw CancellationError() }, thread: { _, _, _ in current })
        await model.openThread(try thread())
        let before = Dictionary(uniqueKeysWithValues: model.messages.map { ($0.text + "@" + $0.id, $0.id) })
        XCTAssertEqual(Set(model.messages.map(\.id)).count, 6, "two identical undated turns still get distinct ids")

        // The window slides: the two oldest turns fall off and one arrives.
        current = try detail(dropping: 2, adding: #","# + #"{"role":"user","text":"Four","timestamp":"2026-10-06T08:00:00Z"}"#)
        await model.openThread(try thread())
        XCTAssertEqual(model.messages.count, 5)
        let kept = model.messages.filter { $0.text == "Answer two" || $0.text == "Answer three" }
        for item in kept {
            XCTAssertNotNil(before[item.text + "@" + item.id], "\(item.text) kept its id across the slide")
        }
        XCTAssertEqual(kept.count, 2)
    }

    // MARK: Tool-less chat

    private func chatModel() throws -> CodexModelDescriptor {
        try XCTUnwrap(try CodexClient.makeDecoder().decode(
            [CodexModelDescriptor].self,
            from: Data(#"[{"id":"gpt","label":"GPT","provider":"azure","modes":["chat"]}]"#.utf8)
        ).first)
    }

    func testADroppedChatStreamKeepsThePartialAnswerAndReportsTheErrorBesideIt() async throws {
        let script = LiveScript()
        script.chat = { _ in
            AsyncThrowingStream { stream in
                stream.yield(.meta(threadId: "chat-1", model: "gpt", provider: "azure"))
                stream.yield(.delta("Half an "))
                stream.yield(.delta("answer"))
                stream.finish(throwing: URLError(.networkConnectionLost))
            }
        }
        let model = makeModel(script, detail: { _ in throw CancellationError() }, workspaceID: nil)
        model.selectChoice(RelayModelChoice(model: try chatModel(), mode: .chat))
        model.prompt = "Explain pooling"
        await model.sendCurrentPrompt()

        XCTAssertEqual(model.messages.map(\.role), [.user, .assistant, .status])
        XCTAssertEqual(model.messages[1].text, "Half an answer", "what the model wrote is kept exactly")
        XCTAssertFalse(model.messages[1].isStreaming)
        XCTAssertEqual(model.messages[2].text, model.errorMessage)
        XCTAssertNotNil(model.errorMessage)
        XCTAssertFalse(model.isStreaming)
        XCTAssertFalse(model.isSending)

        // The next send carries the real turns and none of the app's own lines.
        script.chat = { _ in AsyncThrowingStream { $0.finish() } }
        model.prompt = "Go on"
        await model.sendCurrentPrompt()
        let sent = try XCTUnwrap(script.chatRequests.last)
        XCTAssertEqual(sent.messages.map(\.role), ["user", "assistant", "user"])
        XCTAssertEqual(sent.messages.map(\.content), ["Explain pooling", "Half an answer", "Go on"])

        // That second turn produced nothing: said as status, never as the model.
        XCTAssertEqual(model.messages.last?.role, .status)
        XCTAssertEqual(model.messages.last?.text, "No response received.")
        XCTAssertFalse(model.messages.contains { $0.role == .assistant && $0.text.isEmpty })
        XCTAssertFalse(RelayChatViewModel.chatHistory(from: model.messages).contains { $0.content == "No response received." })
    }

    func testAServerErrorEventIsNotAppendedToTheAnswer() async throws {
        let script = LiveScript()
        script.chat = { _ in
            AsyncThrowingStream { stream in
                stream.yield(.delta("Partial"))
                stream.yield(.error("rate limited"))
                stream.finish()
            }
        }
        let model = makeModel(script, detail: { _ in throw CancellationError() }, workspaceID: nil)
        model.selectChoice(RelayModelChoice(model: try chatModel(), mode: .chat))
        model.prompt = "Hi"
        await model.sendCurrentPrompt()

        XCTAssertEqual(model.messages.map(\.text), ["Hi", "Partial", "rate limited"])
        XCTAssertEqual(model.messages.map(\.role), [.user, .assistant, .status])
        XCTAssertEqual(model.errorMessage, "rate limited")
    }

    func testChatDeltasArePublishedInBatches() async throws {
        let script = LiveScript()
        script.chat = { _ in
            AsyncThrowingStream { stream in
                for index in 1...200 { stream.yield(.delta("t\(index) ")) }
                stream.yield(.usage(input: 3, output: 200))
                stream.yield(.done("stop"))
                stream.finish()
            }
        }
        let model = makeModel(script, detail: { _ in throw CancellationError() }, workspaceID: nil, publishInterval: 0.08)
        model.selectChoice(RelayModelChoice(model: try chatModel(), mode: .chat))
        var publishes = 0
        let watch = model.$messages.dropFirst().sink { _ in publishes += 1 }
        defer { watch.cancel() }
        model.prompt = "Count"
        await model.sendCurrentPrompt()

        let answer = try XCTUnwrap(model.messages.last)
        XCTAssertEqual(answer.role, .assistant)
        XCTAssertTrue(answer.text.hasPrefix("t1 t2 "))
        XCTAssertTrue(answer.text.hasSuffix("t200 "), "nothing is lost to batching")
        XCTAssertEqual(answer.usage?.outputTokens, 200)
        XCTAssertLessThanOrEqual(publishes, 12, "200 tokens must not be 200 redraws")
    }

    func testAChatAnswerStillStreamingDoesNotBindTheConversationThatReplacedIt() async throws {
        let script = LiveScript()
        var held: AsyncThrowingStream<CodexChatEvent, Error>.Continuation?
        script.chat = { _ in AsyncThrowingStream { held = $0 } }
        let model = makeModel(script, detail: { _ in throw CancellationError() }, workspaceID: nil)
        model.selectChoice(RelayModelChoice(model: try chatModel(), mode: .chat))
        model.prompt = "Hi"
        let sending = Task { await model.sendCurrentPrompt() }
        try await waitUntil("the chat stream opens") { held != nil }

        model.startNewConversation()
        held?.yield(.meta(threadId: "old-chat", model: "gpt", provider: "azure"))
        held?.yield(.delta("late words"))
        held?.finish()
        await sending.value

        XCTAssertTrue(model.messages.isEmpty)
        XCTAssertNil(model.currentSessionProvider)
        XCTAssertFalse(model.isStreaming)
        XCTAssertFalse(model.isSending)
    }

    func testStoppingAnEmptyChatTurnLeavesNoPlaceholderAnswer() async throws {
        let script = LiveScript()
        var held: AsyncThrowingStream<CodexChatEvent, Error>.Continuation?
        script.chat = { _ in AsyncThrowingStream { held = $0 } }
        let model = makeModel(script, detail: { _ in throw CancellationError() }, workspaceID: nil)
        model.selectChoice(RelayModelChoice(model: try chatModel(), mode: .chat))
        model.prompt = "Hi"
        let sending = Task { await model.sendCurrentPrompt() }
        try await waitUntil("the chat stream opens") { held != nil }
        XCTAssertTrue(model.isStreaming)

        model.stopStreaming()
        await sending.value
        XCTAssertEqual(model.messages.map(\.role), [.user, .status])
        XCTAssertEqual(model.messages.last?.text, "Stopped.")
        XCTAssertEqual(RelayChatViewModel.chatHistory(from: model.messages).map(\.content), ["Hi"])
        XCTAssertFalse(model.isStreaming)
    }
}
