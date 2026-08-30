package com.parikshit.relay.ui

import android.app.Application
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import com.parikshit.relay.network.RelayHttpClientFactory
import com.parikshit.relay.security.AndroidClientIdentityStore
import java.io.File
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import live.relay.core.JobArtifact
import okhttp3.Request

/** Downloads an mTLS-protected artifact, then hands the local file to Android's viewer. */
class AndroidArtifactOpener(
    private val application: Application,
    private val identityStore: AndroidClientIdentityStore,
) {
    suspend fun open(artifact: JobArtifact, baseUrl: String, isCurrentConnection: () -> Boolean) {
        val remoteUrl = resolvedArtifactUrl(artifact.rawURL, baseUrl)
            ?: error("Relay returned an invalid output URL.")
        val opened = withContext(Dispatchers.IO) {
            val client = RelayHttpClientFactory(identityStore).create()
            val request = Request.Builder().url(remoteUrl).get().header("Accept", "*/*").build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) error("Output download failed with HTTP ${response.code}.")
                val body = response.body
                val declaredLength = body.contentLength()
                if (declaredLength > MAX_ARTIFACT_BYTES) error("This output is too large to open on the phone.")
                val bytes = body.bytes()
                if (bytes.size > MAX_ARTIFACT_BYTES) error("This output is too large to open on the phone.")
                val directory = File(application.cacheDir, "relay-artifacts").apply { mkdirs() }
                val safeName = safeFilename(artifact.filename)
                val file = File(directory, "${UUID.randomUUID()}-$safeName")
                file.writeBytes(bytes)
                file to (artifact.contentType?.substringBefore(';')?.trim()?.takeIf(String::isNotEmpty)
                    ?: response.header("Content-Type")?.substringBefore(';')?.trim()
                    ?: "application/octet-stream")
            }
        }

        if (!isCurrentConnection()) return
        val contentUri = FileProvider.getUriForFile(
            application,
            "${application.packageName}.files",
            opened.first,
        )
        val viewIntent = Intent(Intent.ACTION_VIEW)
            .setDataAndType(contentUri, opened.second)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        val chooser = Intent.createChooser(viewIntent, "Open ${artifact.title ?: artifact.filename}")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        application.startActivity(chooser)
    }

    private fun safeFilename(value: String): String {
        val last = value.substringAfterLast('/').substringAfterLast('\\')
        val cleaned = last.replace(Regex("[^A-Za-z0-9._-]"), "-").trim('.', '-').take(120)
        return cleaned.ifEmpty { "relay-output" }
    }

    private companion object {
        const val MAX_ARTIFACT_BYTES = 25 * 1024 * 1024
    }
}

internal fun resolvedArtifactUrl(value: String?, baseUrl: String): String? {
    val raw = value?.trim()?.takeIf(String::isNotEmpty) ?: return null
    val base = Uri.parse(baseUrl)
    val candidate = when {
        raw.startsWith("/") -> base.buildUpon().encodedPath(raw).clearQuery().fragment(null).build()
        else -> Uri.parse(raw)
    }
    if (!sameOrigin(candidate, base) || candidate.userInfo != null || candidate.query != null || candidate.fragment != null) return null
    if (!Regex("^/v1/codex/jobs/[^/]+/artifacts/[^/]+/(?:raw|preview)$").matches(candidate.path.orEmpty())) return null
    return candidate.toString()
}
