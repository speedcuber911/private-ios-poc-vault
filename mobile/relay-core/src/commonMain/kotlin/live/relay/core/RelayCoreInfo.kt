package live.relay.core

/** A deliberately small, Swift-friendly entry point while iOS migrates feature slices. */
class RelayCoreInfo {
    val schemaVersion: Int = 1
    val supportedProviders: List<String> = RelayProvider.entries.map { it.wireValue }

    fun normalizedProvider(value: String?): String = RelayProvider.fromWireValue(value).wireValue
    fun normalizedJobStatus(value: String?): String = JobStatus.fromWireValue(value).wireValue
}
