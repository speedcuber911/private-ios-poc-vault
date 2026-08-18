package live.relay.core

import kotlinx.serialization.Serializable

@Serializable
data class PocManifest(
    val schemaVersion: Int,
    val generatedAt: String? = null,
    val pocs: List<PocEntry> = emptyList(),
) {
    init {
        require(schemaVersion == 1) { "Unsupported manifest schemaVersion $schemaVersion" }
    }
}

@Serializable
data class PocEntry(
    val id: String? = null,
    val slug: String? = null,
    val title: String,
    val summary: String? = null,
    val description: String? = null,
    val url: String,
    val updatedAt: String? = null,
    val tags: List<String> = emptyList(),
    val requiresClientCertificate: Boolean = true,
) {
    val resolvedId: String get() = firstNonBlank(id, slug) ?: url
    val detail: String get() = firstNonBlank(summary, description, url) ?: url
}

@Serializable
data class ManifestSignatureEnvelope(
    val algorithm: String? = null,
    val keyId: String? = null,
    val manifestSha256: String? = null,
    val publicKey: String? = null,
    val signature: String,
)
