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
