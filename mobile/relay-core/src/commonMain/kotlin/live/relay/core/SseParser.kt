package live.relay.core

import kotlinx.serialization.Serializable

class SseParser<T>(private val decode: (event: String, data: String) -> T?) {
    private var event = ""
    private var data = ""

    fun ingest(line: String): List<T> {
        if (line.isEmpty()) return flush()

        if (line.startsWith("event:")) {
            val pending = flush()
            event = line.removePrefix("event:").trim()
            return pending
        }

        if (line.startsWith("data:")) {
            val payload = line.removePrefix("data:").trim()
            data = if (data.isEmpty()) payload else "$data\n$payload"
        }
        return emptyList()
    }

    fun finish(): List<T> = flush()

    private fun flush(): List<T> {
        if (event.isEmpty()) {
            data = ""
            return emptyList()
        }
        val decoded = decode(event, data)
        event = ""
        data = ""
        return decoded?.let(::listOf) ?: emptyList()
    }
}

sealed interface JobStreamEvent {
    data class Status(val job: Job) : JobStreamEvent
    data class Stdout(val offset: Long, val text: String) : JobStreamEvent
    data class Stderr(val offset: Long, val text: String) : JobStreamEvent
    data class Done(val job: Job) : JobStreamEvent
}

@Serializable
private data class StreamChunk(val offset: Long = 0, val text: String = "")

object JobStreamEventDecoder {
    fun decode(event: String, data: String): JobStreamEvent? = when (event.trim().lowercase()) {
        "status" -> runCatching {
            JobStreamEvent.Status(RelayJson.decode(Job.serializer(), data))
        }.getOrNull()
        "stdout" -> runCatching {
            RelayJson.decode(StreamChunk.serializer(), data).let { JobStreamEvent.Stdout(it.offset, it.text) }
        }.getOrNull()
        "stderr" -> runCatching {
            RelayJson.decode(StreamChunk.serializer(), data).let { JobStreamEvent.Stderr(it.offset, it.text) }
        }.getOrNull()
        "done" -> runCatching {
            JobStreamEvent.Done(RelayJson.decode(Job.serializer(), data))
        }.getOrNull()
        else -> null
    }
}

data class JobStreamState(
    val job: Job? = null,
    val stdout: String = "",
    val stderr: String = "",
    val stdoutOffset: Long = 0,
    val stderrOffset: Long = 0,
) {
    fun reduce(event: JobStreamEvent): JobStreamState = when (event) {
        is JobStreamEvent.Status -> copy(job = event.job)
        is JobStreamEvent.Done -> copy(job = event.job)
        is JobStreamEvent.Stdout -> appendStdout(event)
        is JobStreamEvent.Stderr -> appendStderr(event)
    }

    private fun appendStdout(event: JobStreamEvent.Stdout): JobStreamState {
        if (event.offset < stdoutOffset) return this
        return copy(stdout = stdout + event.text, stdoutOffset = event.offset + event.text.encodeToByteArray().size)
    }

    private fun appendStderr(event: JobStreamEvent.Stderr): JobStreamState {
        if (event.offset < stderrOffset) return this
        return copy(stderr = stderr + event.text, stderrOffset = event.offset + event.text.encodeToByteArray().size)
    }
}
