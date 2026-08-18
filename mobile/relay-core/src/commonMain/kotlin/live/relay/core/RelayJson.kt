package live.relay.core

import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.SerializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

object RelayJson {
    val codec = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = true
        coerceInputValues = true
        isLenient = true
    }

    private val envelopeKeys = listOf(
        "items", "data", "results", "models", "workspaces", "jobs", "sessions",
        "threads", "handoffs", "skills", "approvals", "terminals", "harnesses",
    )

    fun <T> decode(serializer: DeserializationStrategy<T>, payload: String): T =
        codec.decodeFromString(serializer, payload)

    fun <T> encode(serializer: SerializationStrategy<T>, value: T): String =
        codec.encodeToString(serializer, value)

    fun <T> decodeList(serializer: DeserializationStrategy<T>, payload: String): List<T> {
        val root = codec.parseToJsonElement(payload)
        val array = when (root) {
            is JsonArray -> root
            is JsonObject -> envelopeKeys.firstNotNullOfOrNull { root[it] as? JsonArray } ?: JsonArray(emptyList())
            else -> JsonArray(emptyList())
        }
        return array.mapNotNull { runCatching { codec.decodeFromJsonElement(serializer, it) }.getOrNull() }
    }

    fun decodeCreateJobResponse(payload: String): CreateJobResponse {
        val root = codec.parseToJsonElement(payload) as? JsonObject
            ?: error("Create job response is not a JSON object")
        val nested = listOf("job", "data")
            .firstNotNullOfOrNull { key -> root[key]?.let { decodeJobOrNull(it) } }
        val topLevel = decodeJobOrNull(root)
        val id = root.stringValue("id")
            ?: root.stringValue("jobId")
            ?: nested?.resolvedId
            ?: topLevel?.resolvedId
            ?: error("Create job response is missing an id")
        return CreateJobResponse(id, nested ?: topLevel?.takeIf { it.resolvedId != "unknown" })
    }

    private fun decodeJobOrNull(element: JsonElement): Job? =
        runCatching { codec.decodeFromJsonElement(Job.serializer(), element) }.getOrNull()

    private fun JsonObject.stringValue(key: String): String? =
        this[key]?.toString()?.trim('"')?.takeIf { it.isNotBlank() && it != "null" }
}
