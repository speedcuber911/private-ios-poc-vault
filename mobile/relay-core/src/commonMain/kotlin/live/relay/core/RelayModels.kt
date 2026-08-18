package live.relay.core

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder

@Serializable(with = RelayProviderSerializer::class)
enum class RelayProvider(val wireValue: String, val displayName: String) {
    CODEX("codex", "Codex"),
    CLAUDE("claude", "Claude Code"),
    CURSOR("cursor", "Cursor"),
    KIMI("kimi", "Kimi K3"),
    BEDROCK("bedrock", "Bedrock"),
    AZURE("azure", "Azure");

    companion object {
        fun fromWireValue(value: String?): RelayProvider = when (value?.trim()?.lowercase()) {
            "claude", "anthropic" -> CLAUDE
            "cursor", "cursor-agent" -> CURSOR
            "kimi", "kimi-code", "moonshot" -> KIMI
            "bedrock" -> BEDROCK
            "azure", "azure-openai" -> AZURE
            else -> CODEX
        }
    }
}

object RelayProviderSerializer : KSerializer<RelayProvider> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("RelayProvider", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): RelayProvider =
        RelayProvider.fromWireValue(decoder.decodeString())

    override fun serialize(encoder: Encoder, value: RelayProvider) {
        encoder.encodeString(value.wireValue)
    }
}

@Serializable(with = JobStatusSerializer::class)
data class JobStatus(val wireValue: String) {
    val label: String
        get() = when (wireValue) {
            QUEUED.wireValue -> "Queued"
            RUNNING.wireValue -> "Running"
            WAITING_FOR_APPROVAL.wireValue -> "Needs approval"
            SUCCEEDED.wireValue -> "Succeeded"
            FAILED.wireValue -> "Failed"
            CANCELING.wireValue -> "Canceling"
            CANCELED.wireValue -> "Canceled"
            TIMEOUT.wireValue -> "Timed out"
            else -> wireValue.replace('_', ' ').replaceFirstChar { it.uppercase() }
        }

    val isActive: Boolean
        get() = this == QUEUED || this == RUNNING || this == WAITING_FOR_APPROVAL || this == CANCELING

    val needsAttention: Boolean
        get() = this == WAITING_FOR_APPROVAL || this == FAILED || this == TIMEOUT

    companion object {
        val QUEUED = JobStatus("queued")
        val RUNNING = JobStatus("running")
        val WAITING_FOR_APPROVAL = JobStatus("waiting_for_approval")
        val SUCCEEDED = JobStatus("succeeded")
        val FAILED = JobStatus("failed")
        val CANCELING = JobStatus("canceling")
        val CANCELED = JobStatus("canceled")
        val TIMEOUT = JobStatus("timeout")
        val UNKNOWN = JobStatus("unknown")

        fun fromWireValue(value: String?): JobStatus = when (value?.trim()?.lowercase()) {
            "queued", "queue", "pending", "created", "submitted" -> QUEUED
            "running", "active", "in_progress", "in-progress", "processing" -> RUNNING
            "waiting_for_approval", "waiting-for-approval", "needs_input" -> WAITING_FOR_APPROVAL
            "succeeded", "success", "completed", "complete", "done", "passed" -> SUCCEEDED
            "failed", "failure", "errored", "error" -> FAILED
            "canceling", "cancelling" -> CANCELING
            "canceled", "cancelled" -> CANCELED
            "timeout", "timed_out", "timed-out" -> TIMEOUT
            null, "" -> UNKNOWN
            else -> JobStatus(value.trim().lowercase())
        }
    }
}

object JobStatusSerializer : KSerializer<JobStatus> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("JobStatus", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): JobStatus =
        JobStatus.fromWireValue(decoder.decodeString())

    override fun serialize(encoder: Encoder, value: JobStatus) {
        encoder.encodeString(value.wireValue)
    }
}

@Serializable
data class Workspace(
    val id: String? = null,
    val workspaceId: String? = null,
    val slug: String? = null,
    val name: String? = null,
    val title: String? = null,
    val path: String? = null,
    val rootPath: String? = null,
    val summary: String? = null,
    val description: String? = null,
    val isDefault: Boolean = false,
    @SerialName("default") val defaultWorkspace: Boolean = false,
) {
    val resolvedId: String
        get() = firstNonBlank(id, workspaceId, slug, path, rootPath, name, title) ?: "unknown"
    val displayName: String
        get() = firstNonBlank(name, title, path?.substringAfterLast('/'), resolvedId) ?: resolvedId
    val resolvedPath: String?
        get() = firstNonBlank(path, rootPath)
    val detail: String
        get() = firstNonBlank(resolvedPath, summary, description, resolvedId) ?: resolvedId
}

@Serializable
data class WorkspaceEntry(
    val name: String = "",
    val kind: String = "dir",
    val path: String = "",
    val relativePath: String? = null,
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val hasGit: Boolean = false,
    val isRegistered: Boolean = false,
    val size: Long? = null,
    val mtime: String? = null,
    val mime: String? = null,
    val isText: Boolean? = null,
    val readDenied: Boolean = false,
) {
    val isDirectory: Boolean get() = kind != "file"
    val displayName: String get() = firstNonBlank(workspaceName, name) ?: path.substringAfterLast('/')
    val detail: String get() = firstNonBlank(relativePath, path) ?: displayName
}

@Serializable
data class WorkspaceListing(
    val rootPath: String = "",
    val currentPath: String = "",
    val relativePath: String? = null,
    val parentPath: String? = null,
    val selectedWorkspace: Workspace? = null,
    val entries: List<WorkspaceEntry> = emptyList(),
    val truncated: Boolean = false,
    val total: Int? = null,
    val offset: Int? = null,
    val limit: Int? = null,
) {
    val displayPath: String get() = firstNonBlank(relativePath, currentPath) ?: rootPath
    val upNavigationPath: String?
        get() {
            firstNonBlank(parentPath)?.let { return it }
            val current = currentPath.trim().trimEnd('/')
            val root = rootPath.trim().trimEnd('/')
            if (current.isEmpty() || root.isEmpty() || current == root || !current.startsWith("$root/")) return null
            val parent = current.substringBeforeLast('/', root)
            return parent.takeIf { it == root || it.startsWith("$root/") }
        }
}

@Serializable
data class ThreadSummary(
    val id: String? = null,
    val sessionId: String? = null,
    val mode: String = "task",
    val provider: RelayProvider = RelayProvider.CODEX,
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val cwd: String? = null,
    val path: String? = null,
    val timestamp: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val lastUsedAt: String? = null,
    val model: String? = null,
    val jobCount: Int = 0,
    val activeJobCount: Int = 0,
    val lastJobId: String? = null,
    val lastJobStatus: JobStatus? = null,
    val lastPrompt: String? = null,
    val lastResult: String? = null,
    val lastError: String? = null,
    val hasSessionFile: Boolean = true,
    val isSmokeTest: Boolean = false,
) {
    val resolvedId: String get() = firstNonBlank(id, sessionId) ?: "unknown"
    val resolvedSessionId: String get() = firstNonBlank(sessionId, id) ?: "unknown"
    val workspaceLabel: String get() = firstNonBlank(workspaceName, workspaceId, provider.displayName) ?: provider.displayName
    val displayTitle: String get() = compactTitle(firstNonBlank(lastPrompt, lastResult, lastError, workspaceLabel) ?: workspaceLabel)
    val preview: String get() = firstNonBlank(lastPrompt, lastResult, lastError, cwd, path, resolvedSessionId) ?: resolvedSessionId
    val hasActiveJobs: Boolean get() = activeJobCount > 0 || lastJobStatus?.isActive == true
}

@Serializable
data class ThreadMessage(
    val role: String = "status",
    val timestamp: String? = null,
    val createdAt: String? = null,
    val text: String? = null,
    val content: String? = null,
    val message: String? = null,
) {
    val displayText: String get() = firstNonBlank(text, content, message) ?: ""
    val normalizedRole: String
        get() = when (role.trim().lowercase()) {
            "user" -> "user"
            "assistant", "codex", "claude" -> "assistant"
            else -> "status"
        }
}

@Serializable
data class ThreadDetail(
    val thread: ThreadSummary,
    val messages: List<ThreadMessage> = emptyList(),
    val jobs: List<Job> = emptyList(),
)

@Serializable
data class JobArtifact(
    val id: String = "",
    val kind: String = "unknown",
    val filename: String = "artifact.txt",
    val title: String? = null,
    val language: String? = null,
    val contentType: String? = null,
    val bytes: Int? = null,
    val rawURL: String? = null,
    val previewURL: String? = null,
)

/**
 * Natural-language intent for results that should be presented, rather than merely
 * described in the transcript. The URL remains server-authored and loopback-only;
 * this classifier only decides whether Relay should open that safe preview once the
 * job succeeds.
 */
object RelayPresentationIntent {
    private val presentationPhrases = listOf(
        "show me",
        "show it",
        "open it",
        "open this",
        "open the app",
        "open the site",
        "launch it",
        "launch the app",
        "preview it",
        "preview the app",
        "let me see",
    )

    fun requestsAutomaticPreview(prompt: String?): Boolean {
        val normalized = prompt
            ?.lowercase()
            ?.replace(Regex("[^a-z0-9]+"), " ")
            ?.trim()
            ?: return false
        if (normalized.isEmpty()) return false
        val padded = " $normalized "
        return presentationPhrases.any { phrase -> padded.contains(" $phrase ") }
    }
}

enum class ArtifactPresentationKind(val wireValue: String) {
    IMAGE("image"),
    WEB("web"),
    MARKDOWN("markdown"),
    TABLE("table"),
    TEXT("text"),
    DOCUMENT("document"),
    ARCHIVE("archive"),
    MEDIA("media"),
    BINARY("binary"),
}

/** Shared artifact routing so iOS and Android agree about the same file. */
object RelayArtifactPresentation {
    private val imageExtensions = setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff")
    private val markdownExtensions = setOf("md", "markdown")
    private val tableExtensions = setOf("csv", "tsv")
    private val webExtensions = setOf("html", "htm", "svg")
    private val documentExtensions = setOf("pdf", "xlsx", "xls", "ods", "docx", "doc", "odt", "pptx", "ppt", "rtf", "pages", "numbers", "key")
    private val archiveExtensions = setOf("zip", "tar", "gz", "tgz", "bz2", "7z", "rar")
    private val mediaExtensions = setOf("mp3", "wav", "m4a", "aac", "flac", "mp4", "mov", "m4v", "webm")

    fun kind(
        filename: String,
        contentType: String? = null,
        artifactKind: String? = null,
        hasPreview: Boolean = false,
    ): ArtifactPresentationKind {
        val extension = filename.substringAfterLast('.', "").lowercase()
        val mime = contentType.orEmpty().substringBefore(';').trim().lowercase()
        val normalizedKind = artifactKind.orEmpty().trim().lowercase()

        if (mime.startsWith("image/") && mime != "image/svg+xml" || extension in imageExtensions) return ArtifactPresentationKind.IMAGE
        if (mime == "text/markdown" || extension in markdownExtensions) return ArtifactPresentationKind.MARKDOWN
        if (mime == "text/csv" || mime == "text/tab-separated-values" || extension in tableExtensions) return ArtifactPresentationKind.TABLE
        if (normalizedKind == "staticpreview" || mime == "text/html" || mime == "application/xhtml+xml" || mime == "image/svg+xml" || extension in webExtensions) {
            return ArtifactPresentationKind.WEB
        }
        if (mime == "application/pdf" || extension in documentExtensions || mime.contains("spreadsheet") || mime.contains("wordprocessing") || mime.contains("presentation")) {
            return ArtifactPresentationKind.DOCUMENT
        }
        if (mime.startsWith("audio/") || mime.startsWith("video/") || extension in mediaExtensions) return ArtifactPresentationKind.MEDIA
        if (mime.contains("zip") || mime.contains("archive") || mime.contains("compressed") || extension in archiveExtensions) return ArtifactPresentationKind.ARCHIVE
        if (normalizedKind == "code" || mime.startsWith("text/") || mime in setOf("application/json", "application/xml", "application/javascript")) {
            return ArtifactPresentationKind.TEXT
        }
        if (hasPreview) return ArtifactPresentationKind.WEB
        return ArtifactPresentationKind.BINARY
    }
}

@Serializable
data class Job(
    val id: String? = null,
    val jobId: String? = null,
    val provider: RelayProvider = RelayProvider.CODEX,
    val workspaceId: String? = null,
    val workspaceName: String? = null,
    val status: JobStatus = JobStatus.UNKNOWN,
    val state: JobStatus? = null,
    val prompt: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val startedAt: String? = null,
    val completedAt: String? = null,
    val finishedAt: String? = null,
    val timeoutMs: Int? = null,
    val exitCode: Int? = null,
    val stdout: String? = null,
    val stderr: String? = null,
    val result: String? = null,
    val output: String? = null,
    val error: String? = null,
    val errorMessage: String? = null,
    val message: String? = null,
    val durationMs: Int? = null,
    val timedOut: Boolean = false,
    val model: String? = null,
    val reasoningEffort: String? = null,
    val permissionMode: String? = null,
    val approvalPolicy: String? = null,
    val skills: List<String> = emptyList(),
    val sessionId: String? = null,
    val resumeSessionId: String? = null,
    val stdoutBytes: Long? = null,
    val stderrBytes: Long? = null,
    val resultBytes: Long? = null,
    val stdoutTruncated: Boolean = false,
    val stderrTruncated: Boolean = false,
    val resultTruncated: Boolean = false,
    val artifacts: List<JobArtifact> = emptyList(),
) {
    val resolvedId: String get() = firstNonBlank(id, jobId) ?: "unknown"
    val resolvedStatus: JobStatus get() = if (status != JobStatus.UNKNOWN) status else state ?: JobStatus.UNKNOWN
    val displayPrompt: String get() = firstNonBlank(prompt) ?: "Untitled ${provider.displayName} job"
    val displayOutput: String?
        get() {
            val answer = firstNonBlank(result, output)
            if (answer != null && !RelayOutputCleaner.looksLikeRawTranscript(answer)) return RelayOutputCleaner.clean(answer)
            return firstNonBlank(errorMessage, error, message)
        }
}

@Serializable
data class ApprovalResolution(
    val decision: String = "",
    val decidedAt: String? = null,
    val message: String? = null,
)

@Serializable
data class Approval(
    val id: String,
    val jobId: String,
    val provider: RelayProvider = RelayProvider.CODEX,
    val kind: String = "unknown",
    val title: String = "Approval required",
    val reason: String? = null,
    val command: String? = null,
    val cwd: String? = null,
    val toolName: String? = null,
    val createdAt: String? = null,
    val status: String = "pending",
    val availableDecisions: List<String> = emptyList(),
    val resolution: ApprovalResolution? = null,
) {
    val isPending: Boolean get() = status == "pending"
}

@Serializable
data class ModelDescriptor(
    val id: String,
    val label: String = id,
    val provider: RelayProvider = RelayProvider.CODEX,
    val modes: List<String> = emptyList(),
    val azureDeployment: String? = null,
    val taskModel: String? = null,
    val effortLevels: List<String> = emptyList(),
)

@Serializable
data class SkillDescriptor(
    val id: String,
    val name: String,
    val title: String = name,
    val provider: RelayProvider = RelayProvider.CODEX,
    val group: String = "Skills",
    val kind: String? = null,
    val description: String = "",
)

@Serializable
data class CreateJobRequest(
    val workspaceId: String,
    val prompt: String,
    val timeoutMs: Int? = null,
    val model: String? = null,
    val reasoningEffort: String? = null,
    val provider: RelayProvider = RelayProvider.CODEX,
    val permissionMode: String? = null,
    val approvalPolicy: String? = null,
    val skills: List<String>? = null,
    val resumeSessionId: String? = null,
)

data class CreateJobResponse(val id: String, val job: Job?)

@Serializable
data class CreatePreviewRequest(
    val jobId: String,
    val url: String,
)

@Serializable
data class PreviewLease(
    val id: String,
    val url: String,
    val expiresAt: String? = null,
)

internal fun firstNonBlank(vararg values: String?): String? =
    values.firstOrNull { !it.isNullOrBlank() }?.trim()

private fun compactTitle(value: String): String {
    val normalized = value.trim().split(Regex("\\s+")).joinToString(" ")
    val pullRequest = Regex("https?://github\\.com/[^/\\s]+/([^/\\s]+)/pull/([0-9]+)", RegexOption.IGNORE_CASE)
        .find(normalized)
    if (pullRequest != null) return "${pullRequest.groupValues[1]} PR #${pullRequest.groupValues[2]}"
    return if (normalized.length <= 76) normalized else normalized.take(76).trimEnd() + "..."
}

object RelayOutputCleaner {
    private val ansi = Regex("\\u001B\\[[0-?]*[ -/]*[@-~]")

    fun clean(value: String): String = value.replace(ansi, "").trim()

    fun looksLikeRawTranscript(value: String): Boolean {
        val text = clean(value)
        return text.startsWith("OpenAI Codex ") ||
            text.contains("\nworkdir: ") ||
            text.contains("\nreasoning effort: ") ||
            text.contains("\nexec\n") ||
            text.contains("\nsucceeded in ")
    }
}

object RelayLocalPreviewUrls {
    private val loopbackUrl = Regex(
        """https?://(?:localhost|127\.0\.0\.1|\[::1])(?::[0-9]{1,5})?(?:/[^\s<>'\"`]*)?""",
        RegexOption.IGNORE_CASE,
    )

    fun extract(value: String): List<String> = loopbackUrl
        .findAll(value)
        .map { it.value.trimEnd('.', ',', ';', ':', '!', '?', ')') }
        .filter(::isSupported)
        .distinct()
        .toList()

    fun isSupported(value: String): Boolean {
        val match = loopbackUrl.matchEntire(value.trim()) ?: return false
        val portText = Regex(""":([0-9]{1,5})(?:/|$)""").find(match.value)?.groupValues?.get(1)
        val port = portText?.toIntOrNull()
        return port == null || port in 1..65535
    }

    /** Keeps the transport endpoint in full logs while chat speaks in product language. */
    fun hidingEndpoints(value: String): String = extract(value).fold(value) { display, url ->
        display.replace(url, "the app preview")
    }
}
