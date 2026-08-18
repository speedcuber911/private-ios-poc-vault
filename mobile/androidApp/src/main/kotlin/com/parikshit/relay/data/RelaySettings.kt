package com.parikshit.relay.data

import android.content.Context
import androidx.core.content.edit

data class RelayConfiguration(
    val codexBaseUrl: String,
    val manifestUrl: String,
    val signatureUrl: String,
) {
    val hasConfiguredMachine: Boolean
        get() = codexBaseUrl.isNotBlank() && codexBaseUrl != RelaySettings.UNCONFIGURED_CODEX_URL
}

class RelaySettings(context: Context) {
    private val preferences = context.getSharedPreferences("relay.settings", Context.MODE_PRIVATE)

    fun load(): RelayConfiguration = RelayConfiguration(
        codexBaseUrl = preferences.getString(KEY_CODEX_BASE_URL, null) ?: UNCONFIGURED_CODEX_URL,
        manifestUrl = preferences.getString(KEY_MANIFEST_URL, null) ?: DEFAULT_MANIFEST_URL,
        signatureUrl = preferences.getString(KEY_SIGNATURE_URL, null) ?: DEFAULT_SIGNATURE_URL,
    )

    fun save(configuration: RelayConfiguration) {
        preferences.edit {
            putString(KEY_CODEX_BASE_URL, normalizeUrl(configuration.codexBaseUrl, UNCONFIGURED_CODEX_URL))
            putString(KEY_MANIFEST_URL, normalizeUrl(configuration.manifestUrl, DEFAULT_MANIFEST_URL))
            putString(KEY_SIGNATURE_URL, normalizeUrl(configuration.signatureUrl, DEFAULT_SIGNATURE_URL))
        }
    }

    private fun normalizeUrl(value: String, fallback: String): String =
        value.trim().trimEnd('/').takeIf { it.startsWith("https://") } ?: fallback

    companion object {
        const val UNCONFIGURED_CODEX_URL = "https://unconfigured.invalid"
        const val DEFAULT_MANIFEST_URL = "https://vault.pocs.conformal.live/manifest.json"
        const val DEFAULT_SIGNATURE_URL = "https://vault.pocs.conformal.live/manifest.sig.json"

        private const val KEY_CODEX_BASE_URL = "codex_base_url"
        private const val KEY_MANIFEST_URL = "manifest_url"
        private const val KEY_SIGNATURE_URL = "signature_url"
    }
}
