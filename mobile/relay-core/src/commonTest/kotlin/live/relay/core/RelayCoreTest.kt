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
    fun jobStatusAliasesPreserveAttentionAndActivityRules() {
        assertEquals(JobStatus.RUNNING, JobStatus.fromWireValue("in_progress"))
        assertEquals(JobStatus.WAITING_FOR_APPROVAL, JobStatus.fromWireValue("needs_input"))
        assertTrue(JobStatus.WAITING_FOR_APPROVAL.isActive)
        assertTrue(JobStatus.WAITING_FOR_APPROVAL.needsAttention)
        assertFalse(JobStatus.SUCCEEDED.isActive)
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
}
