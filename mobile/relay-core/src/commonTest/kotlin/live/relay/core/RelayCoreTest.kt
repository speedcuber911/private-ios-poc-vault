package live.relay.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest

class RelayCoreTest {
    @Test
    fun providerAliasesMatchTheExistingRelayContract() {
        assertEquals(RelayProvider.CLAUDE, RelayProvider.fromWireValue("anthropic"))
        assertEquals(RelayProvider.CURSOR, RelayProvider.fromWireValue("cursor-agent"))
        assertEquals(RelayProvider.KIMI, RelayProvider.fromWireValue("moonshot"))
        assertEquals(RelayProvider.CODEX, RelayProvider.fromWireValue("future-provider"))
    }

    @Test
    fun aiDataDisclosureNamesTheRecipientAndDataBeforeSharing() {
        val contract = RelayCoreInfo()
        assertEquals("OpenAI (Codex)", contract.aiDataRecipient("codex"))
        assertEquals("Anthropic (Claude)", contract.aiDataRecipient("anthropic"))
        assertTrue(contract.aiDataDisclosure("cursor").contains("prompt and conversation history"))
        assertTrue(contract.aiDataDisclosure("cursor").contains("workspace files, attachments, and command output"))
        assertTrue(contract.aiDataDisclosure("cursor").contains("can include personal data"))
        assertTrue(contract.aiDataDisclosure("cursor").contains("Cursor"))
    }

    @Test
    fun jobStatusAliasesPreserveAttentionAndActivityRules() {
        assertEquals(JobStatus.RUNNING, JobStatus.fromWireValue("in_progress"))
        assertEquals(JobStatus.WAITING_FOR_APPROVAL, JobStatus.fromWireValue("needs_input"))
        assertTrue(JobStatus.WAITING_FOR_APPROVAL.isActive)
        assertTrue(JobStatus.WAITING_FOR_APPROVAL.needsAttention)
        assertFalse(JobStatus.SUCCEEDED.isActive)
    }

    @Test
    fun onlyGeneric404MeansAnOlderRelayRouteIsMissing() {
        val contract = RelayCoreInfo()
        assertTrue(contract.isGenericRouteNotFound(404, "not found"))
        assertTrue(contract.isGenericRouteNotFound(404, "not_found"))
        assertFalse(contract.isGenericRouteNotFound(404, "job not found"))
        assertFalse(contract.isGenericRouteNotFound(404, "preview not found"))
        assertFalse(contract.isGenericRouteNotFound(500, "not found"))
        assertTrue(RelayHttpException(404, "{\"error\":\"not found\"}").isGenericRouteNotFound)
    }

    @Test
    fun localhostPreviewUrlsAreExtractedAndValidated() {
        assertEquals(
            listOf("http://localhost:4317/demo", "https://127.0.0.1:8080/health"),
            RelayLocalPreviewUrls.extract(
                "Open http://localhost:4317/demo, then https://127.0.0.1:8080/health.",
            ),
        )
        assertTrue(RelayLocalPreviewUrls.isSupported("http://[::1]:3000/"))
        assertFalse(RelayLocalPreviewUrls.isSupported("https://example.com"))
        assertFalse(RelayLocalPreviewUrls.isSupported("http://localhost:99999"))
        assertEquals(
            "The app is at the app preview. Open the app preview now.",
            RelayLocalPreviewUrls.hidingEndpoints(
                "The app is at http://localhost:4317/lab. Open http://localhost:4317/lab now.",
            ),
        )
    }

    @Test
    fun naturalPresentationLanguageRequestsAnAutomaticPreview() {
        assertTrue(RelayPresentationIntent.requestsAutomaticPreview("Build the dashboard and show me"))
        assertTrue(RelayPresentationIntent.requestsAutomaticPreview("Open it when you are done."))
        assertTrue(RelayPresentationIntent.requestsAutomaticPreview("Let me see the working app"))
        assertFalse(RelayPresentationIntent.requestsAutomaticPreview("Build the dashboard and report the test results"))
        assertFalse(RelayPresentationIntent.requestsAutomaticPreview("Explain how localhost works"))
    }

    @Test
    fun artifactsRouteToPortableViewerKinds() {
        assertEquals(ArtifactPresentationKind.DOCUMENT, RelayArtifactPresentation.kind("report.pdf", "application/pdf"))
        assertEquals(ArtifactPresentationKind.TABLE, RelayArtifactPresentation.kind("orders.csv", "text/csv"))
        assertEquals(ArtifactPresentationKind.DOCUMENT, RelayArtifactPresentation.kind("forecast.xlsx"))
        assertEquals(ArtifactPresentationKind.DOCUMENT, RelayArtifactPresentation.kind("brief.docx"))
        assertEquals(ArtifactPresentationKind.WEB, RelayArtifactPresentation.kind("preview.html", artifactKind = "staticPreview", hasPreview = true))
        assertEquals(ArtifactPresentationKind.MARKDOWN, RelayArtifactPresentation.kind("README.md", artifactKind = "document"))
        assertEquals(ArtifactPresentationKind.BINARY, RelayArtifactPresentation.kind("weights.bin"))
    }

    @Test
    fun listEnvelopeAcceptsServerKeysAndUnknownFields() {
        val jobs = RelayJson.decodeList(
            Job.serializer(),
            """{"jobs":[{"id":"job-9","status":"running","future":true}]}""",
        )
        assertEquals(1, jobs.size)
        assertEquals("job-9", jobs.single().resolvedId)
        assertEquals(JobStatus.RUNNING, jobs.single().resolvedStatus)
    }

    @Test
    fun sseParserDropsHeartbeatsAndDecodesJobEvents() {
        val parser = SseParser(JobStreamEventDecoder::decode)
        val events = buildList {
            addAll(parser.ingest("event: status"))
            addAll(parser.ingest("data: {\"id\":\"job-9\",\"status\":\"running\"}"))
            addAll(parser.ingest(""))
            addAll(parser.ingest("event: heartbeat"))
            addAll(parser.ingest("data: {}"))
            addAll(parser.ingest(""))
            addAll(parser.ingest("event: stdout"))
            addAll(parser.ingest("data: {\"offset\":0,\"text\":\"building\\n\"}"))
            addAll(parser.finish())
        }

        assertEquals(2, events.size)
        assertIs<JobStreamEvent.Status>(events[0])
        assertEquals(JobStreamEvent.Stdout(0, "building\n"), events[1])
    }

    @Test
    fun streamReducerDoesNotDuplicateRetriedChunks() {
        val initial = JobStreamState()
        val first = initial.reduce(JobStreamEvent.Stdout(0, "hello"))
        val duplicate = first.reduce(JobStreamEvent.Stdout(0, "hello"))
        val next = duplicate.reduce(JobStreamEvent.Stdout(5, " world"))
        assertEquals("hello world", next.stdout)
        assertEquals(11, next.stdoutOffset)
    }

    @Test
    fun repositoryParsesARealisticStream() = runTest {
        val transport = object : RelayTransport {
            override suspend fun execute(request: RelayRequest) = RelayResponse(200, "{}")
            override fun stream(request: RelayRequest) = flowOf(
                "event: stdout",
                "data: {\"offset\":0,\"text\":\"ok\"}",
                "",
                "event: done",
                "data: {\"id\":\"job-1\",\"status\":\"succeeded\",\"result\":\"Done\"}",
                "",
            )
        }

        val events = RelayRepository(transport).streamJob("job-1").toList()
        assertEquals(2, events.size)
        assertEquals(JobStreamEvent.Stdout(0, "ok"), events[0])
        assertIs<JobStreamEvent.Done>(events[1])
    }

    @Test
    fun approvalFallbackAndPreviewCreationShareTheWireContract() = runTest {
        val requests = mutableListOf<RelayRequest>()
        val transport = object : RelayTransport {
            override suspend fun execute(request: RelayRequest): RelayResponse {
                requests += request
                return when (request.path) {
                    "/v1/codex/approvals" -> RelayResponse(404, "{\"error\":\"not found\"}")
                    "/v1/codex/previews" -> RelayResponse(
                        200,
                        """{"id":"lease_1","url":"/v1/codex/previews/abcdefghijklmnopqrstuvwxyzABCDEFGH123456789","expiresAt":"2026-08-18T10:00:00Z"}""",
                    )
                    else -> RelayResponse(500, "unexpected")
                }
            }

            override fun stream(request: RelayRequest) = flowOf<String>()
        }
        val repository = RelayRepository(transport)

        assertTrue(repository.listPendingApprovalsIfSupported("job-1").isEmpty())
        val preview = repository.createPreview("job-1", "http://localhost:4317/demo")

        assertEquals("lease_1", preview.id)
        assertEquals("/v1/codex/previews", requests.last().path)
        assertTrue(requests.last().body.orEmpty().contains("\"jobId\":\"job-1\""))
        assertTrue(requests.last().body.orEmpty().contains("\"url\":\"http://localhost:4317/demo\""))
    }
}
