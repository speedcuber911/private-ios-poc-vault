import XCTest
@testable import POCVault

/// Decode fixtures are the shapes relayd actually serves:
/// `GET /v1/handoffs` → `{handoffs: [...]}`, `GET /v1/handoffs/:id` →
/// `{handoff: {...manifest}}`, `GET /v1/mac-sessions` → `{index: ...|null}`.
/// They are decoded through `CodexClient.makeDecoder()`, the same decoder the
/// client uses, so a fixture that passes here cannot fail on the wire.
final class HandoffTests: XCTestCase {

    // MARK: - Model decoding

    func testHandoffCardDecodesTheNodeShape() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay",
          "branch": "relay/handoff-a1b2c3d4e5f6", "title": "Fix the auth redirect",
          "provider": "claude", "workspaceId": "dir-handoff-abc123",
          "canResumeNatively": true, "lastJobId": null, "error": null,
          "createdAt": "2026-08-11T10:00:00.000Z", "updatedAt": "2026-08-11T10:00:05.000Z" }
        """)

        XCTAssertEqual(card.state, .ready)
        XCTAssertEqual(card.provider, .claude)
        XCTAssertEqual(card.workspaceID, "dir-handoff-abc123")
        XCTAssertTrue(card.canResumeNatively)
        XCTAssertTrue(card.isActionable)
        XCTAssertEqual(card.statusLabel, "Ready to continue")
        XCTAssertEqual(card.subtitle, "me/relay")
        XCTAssertNotNil(card.createdAt)
        XCTAssertNil(card.failureSummary, "a healthy handoff has nothing to apologise for")
    }

    /// The title comes from the sealed manifest, never from the branch: branch
    /// names are opaque (`relay/handoff-<12 hex>`) and carry no words.
    func testTitleIsNeverDerivedFromTheOpaqueBranchName() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay",
          "branch": "relay/handoff-0011aabb2233", "title": "Trace the redirect loop",
          "provider": "codex", "workspaceId": "dir-handoff-abc123",
          "canResumeNatively": true, "lastJobId": null, "error": null,
          "createdAt": null, "updatedAt": null }
        """)

        XCTAssertEqual(card.title, "Trace the redirect loop")
        XCTAssertFalse(card.title.contains("handoff-"))
    }

    func testFailedHandoffSurfacesItsReasonAndARemedy() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "failed", "repo": "me/relay",
          "branch": "relay/handoff-0011aabb2233", "title": "Fix auth", "provider": null,
          "workspaceId": null, "canResumeNatively": false, "lastJobId": null,
          "error": "clone_failed", "createdAt": "2026-08-11T10:00:00.000Z",
          "updatedAt": "2026-08-11T10:00:00.000Z" }
        """)

        XCTAssertEqual(card.state, .failed)
        XCTAssertEqual(card.statusLabel, "Needs attention")
        XCTAssertEqual(card.error, "clone_failed")
        XCTAssertFalse(card.isActionable)
        XCTAssertNil(card.provider)
        XCTAssertNotNil(card.failureSummary, "a failure must never be silent")
        XCTAssertEqual(card.failureAdvice, "Run relay sync-auth on your Mac, then relay handoff again.")
    }

    /// relayd's reason vocabulary is closed but can grow; an unmapped token must
    /// still produce a visible failure with a usable next step.
    func testUnmappedFailureReasonStillSaysSomethingAndWhatToDo() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "failed", "repo": "me/relay", "branch": "b",
          "title": "T", "provider": null, "workspaceId": null, "canResumeNatively": false,
          "lastJobId": null, "error": "store_write_failed", "createdAt": null, "updatedAt": null }
        """)

        XCTAssertEqual(card.failureSummary, "The handoff failed on this machine.")
        XCTAssertEqual(card.failureAdvice, "Run relay handoff again on your Mac.")
    }

    func testUnknownStateDegradesInsteadOfFailingToDecode() throws {
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "quarantined", "repo": "me/relay", "branch": "b",
          "title": "T", "provider": null, "workspaceId": null, "canResumeNatively": false,
          "lastJobId": null, "error": null, "createdAt": null, "updatedAt": null }
        """)

        XCTAssertEqual(card.state, .unknown("quarantined"))
        XCTAssertEqual(card.statusLabel, "Status unavailable")
        XCTAssertFalse(card.isActionable)
    }

    func testHandoffListEnvelopeDecodesTheHandoffsKey() throws {
        let cards = try decoder.decode(RelayHandoffListFixture.self, from: Data("""
        { "handoffs": [
            { "id": "aaaa1111bbbb2222", "state": "ready", "repo": "me/relay", "branch": "b1",
              "title": "One", "provider": "codex", "workspaceId": "dir-handoff-1",
              "canResumeNatively": true, "lastJobId": null, "error": null,
              "createdAt": null, "updatedAt": null },
            { "id": "cccc3333dddd4444", "state": "failed", "repo": "me/relay", "branch": "b2",
              "title": "Two", "provider": null, "workspaceId": null,
              "canResumeNatively": false, "lastJobId": null, "error": "clone_failed",
              "createdAt": null, "updatedAt": null }
          ] }
        """.utf8))

        XCTAssertEqual(cards.handoffs.map(\.id), ["aaaa1111bbbb2222", "cccc3333dddd4444"])
    }

    func testHandoffDetailCarriesTheManifest() throws {
        let detail = try decoder.decode(RelayHandoffDetail.self, from: Data("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay",
          "branch": "relay/handoff-0011aabb2233", "title": "Fix auth", "provider": "claude",
          "workspaceId": "dir-handoff-x", "canResumeNatively": true, "lastJobId": null,
          "error": null, "createdAt": null, "updatedAt": null,
          "manifest": { "v": 1, "id": "abc123def4567890", "harness": "claude",
                        "machine": "Work-Laptop", "excerpt": "Tracing the loop.",
                        "baseBranch": "main", "createdAt": 1754700000123,
                        "wip": { "files": 2, "insertions": 30, "deletions": 4,
                                 "summary": "2 files changed, +30/-4" } } }
        """.utf8))

        XCTAssertEqual(detail.card.title, "Fix auth")
        XCTAssertEqual(detail.manifest?.machine, "Work-Laptop")
        XCTAssertEqual(detail.manifest?.harness, "claude")
        XCTAssertEqual(detail.manifest?.baseBranch, "main")
        XCTAssertEqual(detail.manifest?.excerpt, "Tracing the loop.")
        XCTAssertEqual(detail.manifest?.diffstat, "2 files changed, +30/-4")
    }

    /// relayd allow-lists manifest fields and any of them may be absent, so the
    /// detail must decode from a partial manifest — and compose the diffstat
    /// itself when the CLI sent counts but no summary.
    func testPartialManifestDecodesAndComposesItsOwnDiffstat() throws {
        let detail = try decoder.decode(RelayHandoffDetail.self, from: Data("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay", "branch": "b",
          "title": "Fix auth", "provider": "codex", "workspaceId": "w",
          "canResumeNatively": false, "lastJobId": null, "error": null,
          "createdAt": null, "updatedAt": null,
          "manifest": { "v": 1, "id": "abc123def4567890", "harness": "codex",
                        "wip": { "files": 1, "insertions": 9, "deletions": 0, "summary": null } } }
        """.utf8))

        XCTAssertNil(detail.manifest?.machine)
        XCTAssertNil(detail.manifest?.excerpt)
        XCTAssertEqual(detail.manifest?.diffstat, "1 file · +9/-0")
    }

    func testHandoffWithNoWorkInProgressHasNoDiffstat() throws {
        let detail = try decoder.decode(RelayHandoffDetail.self, from: Data("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay", "branch": "b",
          "title": "T", "provider": null, "workspaceId": null, "canResumeNatively": false,
          "lastJobId": null, "error": null, "createdAt": null, "updatedAt": null,
          "manifest": { "v": 1, "id": "abc123def4567890",
                        "wip": { "files": 0, "insertions": 0, "deletions": 0, "summary": null } } }
        """.utf8))

        XCTAssertNil(detail.manifest?.diffstat)
    }

    func testMacSessionIndexDecodes() throws {
        let index = try decoder.decode(RelayMacSessionIndex.self, from: Data("""
        { "machine": "Work-Laptop", "updatedAt": "2026-08-11T10:00:00.000Z",
          "sessions": [ { "id": "s1", "harness": "claude", "title": "Fix auth",
                          "repo": "me/relay", "lastActive": "2026-08-11T09:00:00.000Z" } ] }
        """.utf8))

        XCTAssertEqual(index.machine, "Work-Laptop")
        XCTAssertEqual(index.sectionTitle, "On Work-Laptop")
        XCTAssertNotNil(index.updatedAtDate)
        XCTAssertEqual(index.sessions.count, 1)
        XCTAssertEqual(index.sessions[0].displayTitle, "Fix auth")
        XCTAssertNotNil(index.sessions[0].lastActiveDate)
    }

    /// `saveMacSessions` coerces every field with `String(x || "")`, so an empty
    /// title or timestamp is a legal payload and must not fail the decode.
    func testMacSessionToleratesEmptyMetadataAndAbsentMachine() throws {
        let index = try decoder.decode(RelayMacSessionIndex.self, from: Data("""
        { "machine": null, "updatedAt": null,
          "sessions": [ { "id": "s1", "harness": "codex", "title": "",
                          "repo": "me/relay", "lastActive": "" } ] }
        """.utf8))

        XCTAssertEqual(index.sectionTitle, "On your Mac")
        XCTAssertNil(index.updatedAtDate)
        XCTAssertEqual(index.sessions[0].displayTitle, "me/relay")
        XCTAssertNil(index.sessions[0].lastActiveDate)
    }

    /// The node answers `{index: null}` when no Mac has ever published one.
    func testMacSessionEnvelopeAcceptsANullIndex() throws {
        struct Envelope: Decodable { let index: RelayMacSessionIndex? }
        let envelope = try decoder.decode(Envelope.self, from: Data(#"{ "index": null }"#.utf8))
        XCTAssertNil(envelope.index)
    }

    /// `POST /v1/handoffs/:id/continue` answers 202 `{job: {...}}` — the same
    /// envelope `createJob` already understands, so Continue is an ordinary job.
    func testContinueResponseDecodesAsAnOrdinaryJob() throws {
        let created = try decoder.decode(CodexCreateJobResponse.self, from: Data("""
        { "job": { "id": "job-7", "status": "queued", "provider": "claude",
                   "workspaceId": "dir-handoff-abc123", "prompt": "Continue",
                   "createdAt": "2026-08-11T10:00:00.000Z", "timedOut": false,
                   "attachments": [], "artifacts": [] } }
        """.utf8))

        XCTAssertEqual(created.id, "job-7")
        XCTAssertEqual(created.job?.workspaceId, "dir-handoff-abc123")
        XCTAssertEqual(created.job?.provider, .claude)
    }

    // MARK: - View model

    @MainActor
    func testViewModelStartsWithNoHandoffsAndNoMacSessions() {
        let viewModel = RelayChatViewModel(client: makeOfflineCodexClient(), workspaceID: nil, workspacePath: nil)
        XCTAssertTrue(viewModel.handoffs.isEmpty)
        XCTAssertNil(viewModel.macSessions)
        XCTAssertTrue(viewModel.continuingHandoffIDs.isEmpty)
        XCTAssertTrue(viewModel.handoffManifests.isEmpty)
    }

    @MainActor
    func testRefreshHandoffsAgainstAClosedPortLeavesStateEmptyAndDoesNotThrow() async {
        let viewModel = RelayChatViewModel(client: makeOfflineCodexClient(), workspaceID: nil, workspacePath: nil)
        await viewModel.refreshHandoffs()
        XCTAssertTrue(viewModel.handoffs.isEmpty, "a failed refresh must not fabricate rows")
        XCTAssertNil(viewModel.macSessions, "a failed refresh must not fabricate an index")
    }

    /// Continue is only offered for a ready handoff; an importing or failed one
    /// must not be sent to a node that would answer 409.
    @MainActor
    func testContinueIsRefusedLocallyForAHandoffThatIsNotReady() async throws {
        let viewModel = RelayChatViewModel(client: makeOfflineCodexClient(), workspaceID: nil, workspacePath: nil)
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "importing", "repo": "me/relay", "branch": "b",
          "title": "T", "provider": null, "workspaceId": null, "canResumeNatively": false,
          "lastJobId": null, "error": null, "createdAt": null, "updatedAt": null }
        """)

        await viewModel.continueHandoff(card)

        XCTAssertTrue(viewModel.continuingHandoffIDs.isEmpty)
        XCTAssertNil(viewModel.errorMessage, "refusing locally is not an error to show the user")
        XCTAssertTrue(viewModel.messages.isEmpty)
    }

    /// A ready handoff against an unreachable node must report the failure, not
    /// silently do nothing.
    @MainActor
    func testContinueAgainstAClosedPortReportsTheFailure() async throws {
        let viewModel = RelayChatViewModel(client: makeOfflineCodexClient(), workspaceID: nil, workspacePath: nil)
        let card = try decodeCard("""
        { "id": "abc123def4567890", "state": "ready", "repo": "me/relay", "branch": "b",
          "title": "T", "provider": "codex", "workspaceId": "dir-handoff-abc123",
          "canResumeNatively": true, "lastJobId": null, "error": null,
          "createdAt": null, "updatedAt": null }
        """)

        await viewModel.continueHandoff(card)

        XCTAssertNotNil(viewModel.errorMessage, "a continue that failed must say so")
        XCTAssertTrue(viewModel.continuingHandoffIDs.isEmpty, "the in-flight marker is always released")
    }

    // MARK: - Push routing

    func testHandoffPushRoutesToTheHandoffSection() {
        let route = RelayPushService.route(from: [
            "aps": ["alert": ["loc-key": "RELAY_EVENT"], "category": "RELAY_HANDOFF_READY"],
            "relay": ["nodeId": "node-1", "jobId": NSNull(), "type": "handoff.ready", "ts": 1, "seq": 1]
        ])
        XCTAssertEqual(route, .handoff(nodeID: "node-1"))
    }

    func testFailedHandoffPushAlsoRoutesToTheHandoffSection() {
        let route = RelayPushService.route(from: [
            "relay": ["nodeId": "node-1", "type": "handoff.failed", "ts": 1, "seq": 2]
        ])
        XCTAssertEqual(route, .handoff(nodeID: "node-1"))
    }

    func testJobPushStillRoutesToItsJob() {
        let route = RelayPushService.route(from: [
            "relay": ["nodeId": "node-1", "jobId": "job-7", "type": "job.completed", "ts": 1, "seq": 3]
        ])
        XCTAssertEqual(route, .job(nodeID: "node-1", jobID: "job-7"))
    }

    func testUnrecognisedOrMalformedPushRoutesNowhere() {
        XCTAssertEqual(RelayPushService.route(from: [:]), RelayPushRoute.none)
        XCTAssertEqual(RelayPushService.route(from: ["relay": ["type": "handoff.ready"]]), RelayPushRoute.none)
        XCTAssertEqual(
            RelayPushService.route(from: ["relay": ["nodeId": "node-1", "type": "node.health"]]),
            RelayPushRoute.none
        )
        XCTAssertEqual(
            RelayPushService.route(from: ["relay": ["nodeId": "node-1", "type": "job.completed"]]),
            RelayPushRoute.none,
            "a job push with no job id has nowhere to go"
        )
    }

    func testDeviceTokenIsEncodedAsLowercaseHex() {
        XCTAssertEqual(RelayPushService.hexToken(from: Data([0x0a, 0xff, 0x10])), "0aff10")
    }

    // MARK: - Design rules (Editorial Ember)

    func testCardViewSourceUsesTheEditorialEmberIdiom() throws {
        let source = try AppSourceFixture.load("POCVault/Views/RelayHandoffCardView.swift")
        XCTAssertTrue(source.contains("RelayCapsLabel"), "status and badges use the caps-label primitive")
        XCTAssertTrue(source.contains("AppTheme.monoFont"), "the branch renders in the mono face")
        XCTAssertTrue(source.contains("AppTheme.textSecondary"), "a ready state uses cream, not a success color")
        XCTAssertTrue(source.contains("RelayPrimaryButtonStyle"), "Continue is the screen's one ember action")
    }

    func testHandoffCardNeverRendersADotOrGlyphForStatus() throws {
        let source = try AppSourceFixture.load("POCVault/Views/RelayHandoffCardView.swift")
        XCTAssertFalse(source.contains("Circle().fill(AppTheme.status"), "handoff card renders a colored status dot")
        XCTAssertFalse(source.contains("checkmark.circle.fill"), "handoff card renders a status glyph")
        XCTAssertFalse(source.contains("statusOK"))
        XCTAssertFalse(source.contains("statusInfo"))
        XCTAssertFalse(source.contains("statusNeutral"))
    }

    // MARK: - Helpers

    private struct RelayHandoffListFixture: Decodable {
        let handoffs: [RelayHandoffCard]
    }

    private var decoder: JSONDecoder { CodexClient.makeDecoder() }

    private func decodeCard(_ json: String) throws -> RelayHandoffCard {
        try decoder.decode(RelayHandoffCard.self, from: Data(json.utf8))
    }

    /// Port 9 (discard) is closed on the loopback interface, so every request
    /// fails fast — the offline path, without a stub server.
    private func makeOfflineCodexClient() -> CodexClient {
        CodexClient(baseURL: URL(string: "http://127.0.0.1:9")!, identityStore: ClientIdentityStore())
    }
}
