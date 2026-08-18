package live.relay.core

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.decodeFromJsonElement

enum class HttpMethod { GET, POST, DELETE }

data class RelayRequest(
    val method: HttpMethod = HttpMethod.GET,
    val path: String,
    val query: List<Pair<String, String>> = emptyList(),
    val body: String? = null,
    val accept: String = "application/json",
)

data class RelayResponse(
    val status: Int,
    val body: String,
    val headers: Map<String, String> = emptyMap(),
)

class RelayHttpException(val status: Int, val responseBody: String) :
    Exception("Relay request failed with HTTP $status${responseBody.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}")

interface RelayTransport {
    suspend fun execute(request: RelayRequest): RelayResponse
    fun stream(request: RelayRequest): Flow<String>
}

class RelayRepository(private val transport: RelayTransport) {
    suspend fun listWorkspaceDirectories(path: String? = null, query: String? = null): WorkspaceListing {
        val parameters = buildList {
            path?.trim()?.takeIf { it.isNotEmpty() }?.let { add("path" to it) }
            query?.trim()?.takeIf { it.isNotEmpty() }?.let { add("q" to it) }
        }
        return decode(WorkspaceListing.serializer(), request(RelayRequest(path = "/v1/codex/workspace-dirs", query = parameters)))
    }

    suspend fun listDirectory(path: String? = null, offset: Int? = null, limit: Int? = null): WorkspaceListing {
        val parameters = buildList {
            path?.trim()?.takeIf { it.isNotEmpty() }?.let { add("path" to it) }
            offset?.let { add("offset" to it.toString()) }
            limit?.let { add("limit" to it.toString()) }
        }
        return decode(WorkspaceListing.serializer(), request(RelayRequest(path = "/v1/codex/fs/list", query = parameters)))
    }

    suspend fun selectWorkspace(path: String): Workspace =
        decode(
            Workspace.serializer(),
            request(
                RelayRequest(
                    method = HttpMethod.POST,
                    path = "/v1/codex/workspaces/select",
                    body = "{\"path\":\"${escapeJson(path)}\"}",
                ),
            ),
        )

    suspend fun listJobs(workspaceId: String? = null, provider: RelayProvider? = null, limit: Int = 50): List<Job> {
        val parameters = scopedQuery(workspaceId, provider, limit)
        return RelayJson.decodeList(Job.serializer(), request(RelayRequest(path = "/v1/codex/jobs", query = parameters)))
    }

    suspend fun job(id: String, includeFullLogs: Boolean = false): Job =
        decode(
            Job.serializer(),
            request(
                RelayRequest(
                    path = "/v1/codex/jobs/${encodePathComponent(id)}",
                    query = if (includeFullLogs) listOf("include" to "fullLogs") else emptyList(),
                ),
            ),
        )

    suspend fun listThreads(workspaceId: String? = null, provider: RelayProvider? = null, limit: Int = 50): List<ThreadSummary> {
        val parameters = scopedQuery(workspaceId, provider, limit)
        return RelayJson.decodeList(ThreadSummary.serializer(), request(RelayRequest(path = "/v1/codex/threads", query = parameters)))
    }

    suspend fun threadDetail(sessionId: String, workspaceId: String?, provider: RelayProvider): ThreadDetail =
        decode(
            ThreadDetail.serializer(),
            request(
                RelayRequest(
                    path = "/v1/codex/threads/${encodePathComponent(sessionId)}",
                    query = buildList {
                        workspaceId?.takeIf { it.isNotBlank() }?.let { add("workspaceId" to it) }
                        add("provider" to provider.wireValue)
                    },
                ),
            ),
        )

    suspend fun deleteThread(sessionId: String, workspaceId: String?, provider: RelayProvider) {
        request(
            RelayRequest(
                method = HttpMethod.DELETE,
                path = "/v1/codex/threads/${encodePathComponent(sessionId)}",
                query = buildList {
                    workspaceId?.takeIf { it.isNotBlank() }?.let { add("workspaceId" to it) }
                    add("provider" to provider.wireValue)
                },
            ),
        )
    }

    suspend fun listModels(): List<ModelDescriptor> =
        RelayJson.decodeList(ModelDescriptor.serializer(), request(RelayRequest(path = "/v1/codex/models")))

    suspend fun listSkills(provider: RelayProvider, workspaceId: String?): List<SkillDescriptor> =
        RelayJson.decodeList(
            SkillDescriptor.serializer(),
            request(
                RelayRequest(
                    path = "/v1/codex/skills",
                    query = buildList {
                        add("provider" to provider.wireValue)
                        workspaceId?.takeIf { it.isNotBlank() }?.let { add("workspaceId" to it) }
                    },
                ),
            ),
        )

    suspend fun createJob(job: CreateJobRequest): CreateJobResponse {
        val payload = RelayJson.encode(CreateJobRequest.serializer(), job)
        return RelayJson.decodeCreateJobResponse(
            request(RelayRequest(method = HttpMethod.POST, path = "/v1/codex/jobs", body = payload)),
        )
    }

    suspend fun cancelJob(id: String) {
        request(RelayRequest(method = HttpMethod.POST, path = "/v1/codex/jobs/${encodePathComponent(id)}/cancel"))
    }

    suspend fun listApprovals(jobId: String? = null, pendingOnly: Boolean = false): List<Approval> {
        val query = buildList {
            jobId?.let { add("jobId" to it) }
            if (pendingOnly) add("status" to "pending")
        }
        return RelayJson.decodeList(Approval.serializer(), request(RelayRequest(path = "/v1/codex/approvals", query = query)))
    }

    suspend fun decideApproval(id: String, decision: String, message: String? = null): Approval {
        val body = buildString {
            append("{\"decision\":\"")
            append(escapeJson(decision))
            append('"')
            message?.let { append(",\"message\":\"").append(escapeJson(it)).append('"') }
            append('}')
        }
        val payload = request(
            RelayRequest(
                method = HttpMethod.POST,
                path = "/v1/codex/approvals/${encodePathComponent(id)}/decision",
                body = body,
            ),
        )
        val root = RelayJson.codec.parseToJsonElement(payload)
        val approvalElement = (root as? kotlinx.serialization.json.JsonObject)?.get("approval") ?: root
        return RelayJson.codec.decodeFromJsonElement(Approval.serializer(), approvalElement)
    }

    fun streamJob(id: String, stdoutOffset: Long = 0, stderrOffset: Long = 0): Flow<JobStreamEvent> = flow {
        val parser = SseParser(JobStreamEventDecoder::decode)
        transport.stream(
            RelayRequest(
                path = "/v1/codex/jobs/${encodePathComponent(id)}/stream",
                query = listOf("stdoutOffset" to stdoutOffset.toString(), "stderrOffset" to stderrOffset.toString()),
                accept = "text/event-stream",
            ),
        ).collect { line -> parser.ingest(line).forEach { emit(it) } }
        parser.finish().forEach { emit(it) }
    }

    private suspend fun request(request: RelayRequest): String {
        val response = transport.execute(request)
        if (response.status !in 200..299) throw RelayHttpException(response.status, response.body.take(2_048))
        return response.body
    }

    private fun <T> decode(serializer: kotlinx.serialization.DeserializationStrategy<T>, payload: String): T =
        RelayJson.decode(serializer, payload)

    private fun scopedQuery(workspaceId: String?, provider: RelayProvider?, limit: Int): List<Pair<String, String>> =
        buildList {
            add("limit" to limit.toString())
            workspaceId?.takeIf { it.isNotBlank() }?.let { add("workspaceId" to it) }
            provider?.let { add("provider" to it.wireValue) }
        }
}

private fun encodePathComponent(value: String): String = value.encodeToByteArray().joinToString("") { byte ->
    val number = byte.toInt() and 0xff
    val character = number.toChar()
    if (character.isLetterOrDigit() || character in "-._~") character.toString()
    else "%" + number.toString(16).uppercase().padStart(2, '0')
}

private fun escapeJson(value: String): String = buildString {
    value.forEach { character ->
        when (character) {
            '\\' -> append("\\\\")
            '"' -> append("\\\"")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> append(character)
        }
    }
}
