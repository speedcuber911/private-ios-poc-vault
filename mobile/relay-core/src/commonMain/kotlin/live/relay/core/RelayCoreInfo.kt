package live.relay.core

/** A deliberately small, Swift-friendly entry point while iOS migrates feature slices. */
class RelayCoreInfo {
    val schemaVersion: Int = 2
    val supportedProviders: List<String> = RelayProvider.entries.map { it.wireValue }

    fun normalizedProvider(value: String?): String = RelayProvider.fromWireValue(value).wireValue
    fun normalizedJobStatus(value: String?): String = JobStatus.fromWireValue(value).wireValue

    /**
     * Older Relay services answer unknown routes with a bare `not found`. Resource
     * failures are more specific (`job not found`, `preview not found`) and must not
     * be mistaken for a missing capability.
     */
    fun isGenericRouteNotFound(statusCode: Int, message: String?): Boolean =
        statusCode == 404 && normalizeRouteError(message) == "not found"
}

internal fun normalizeRouteError(message: String?): String? = message
    ?.trim()
    ?.lowercase()
    ?.replace('_', ' ')
