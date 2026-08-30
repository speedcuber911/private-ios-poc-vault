package com.parikshit.relay.ui

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.parikshit.relay.data.RelayConfiguration
import com.parikshit.relay.data.RelaySettings
import com.parikshit.relay.network.AndroidManifestClient
import com.parikshit.relay.network.OkHttpRelayTransport
import com.parikshit.relay.network.RelayHttpClientFactory
import com.parikshit.relay.security.AndroidClientIdentityStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import live.relay.core.Approval
import live.relay.core.CreateJobRequest
import live.relay.core.JobStreamEvent
import live.relay.core.JobStreamState
import live.relay.core.ModelDescriptor
import live.relay.core.PocEntry
import live.relay.core.RelayProvider
import live.relay.core.RelayLocalPreviewUrls
import live.relay.core.RelayPresentationIntent
import live.relay.core.RelayHttpException
import live.relay.core.RelayRepository
import live.relay.core.ThreadDetail
import live.relay.core.ThreadSummary
import live.relay.core.WorkspaceEntry
import live.relay.core.WorkspaceListing
import live.relay.core.Job as RelayJob

data class RelayUiState(
    val configuration: RelayConfiguration,
    val connectionRevision: Int = 0,
    val certificateSubject: String? = null,
    val listing: WorkspaceListing? = null,
    val currentPath: String? = null,
    val jobs: List<RelayJob> = emptyList(),
    val threads: List<ThreadSummary> = emptyList(),
    val models: List<ModelDescriptor> = emptyList(),
    val selectedWorkspace: WorkspaceEntry? = null,
    val selectedThread: ThreadDetail? = null,
    val selectedJob: RelayJob? = null,
    val streamState: JobStreamState = JobStreamState(),
    val approvals: List<Approval> = emptyList(),
    val pocs: List<PocEntry> = emptyList(),
    val pocsCatalogVerified: Boolean = false,
    val pocsCatalogGeneratedAt: String? = null,
    val pocsLoading: Boolean = false,
    val pocsError: String? = null,
    val previewJobs: List<RelayJob> = emptyList(),
    val previewJobsLoaded: Boolean = false,
    val previewJobsLoading: Boolean = false,
    val previewJobsError: String? = null,
    val previewUrl: String? = null,
    val loading: Boolean = false,
    val streaming: Boolean = false,
    val error: String? = null,
    val notice: String? = null,
    val aiDataConsentProviders: Set<RelayProvider> = emptySet(),
) {
    val isReadyForMachineRequests: Boolean
        get() = configuration.hasConfiguredMachine && certificateSubject != null
}

class RelayViewModel(application: Application) : AndroidViewModel(application) {
    private val settings = RelaySettings(application)
    val identityStore = AndroidClientIdentityStore(application)
    private val _uiState = MutableStateFlow(
        RelayUiState(
            configuration = settings.load(),
            certificateSubject = identityStore.subjectOrNull(),
            aiDataConsentProviders = settings.loadAIDataConsents(),
        ),
    )
    val uiState: StateFlow<RelayUiState> = _uiState.asStateFlow()
    private var streamCollection: Job? = null
    private var pocCollection: Job? = null
    private var previewJobCollection: Job? = null
    private val automaticallyOpenedPreviews = mutableSetOf<String>()
    private val artifactOpener = AndroidArtifactOpener(application, identityStore)

    fun clearMessage() = _uiState.update { it.copy(error = null, notice = null) }

    fun grantAIDataConsent(provider: RelayProvider) {
        settings.grantAIDataConsent(provider)
        _uiState.update { it.copy(aiDataConsentProviders = it.aiDataConsentProviders + provider) }
    }

    fun saveConfiguration(codexBaseUrl: String, manifestUrl: String, signatureUrl: String) {
        val requested = RelayConfiguration(codexBaseUrl, manifestUrl, signatureUrl)
        settings.save(requested)
        val saved = settings.load()
        val requestedUrls = listOf(codexBaseUrl, manifestUrl, signatureUrl)
            .map { it.trim().trimEnd('/') }
        val savedUrls = listOf(saved.codexBaseUrl, saved.manifestUrl, saved.signatureUrl)
        val connectionChanged = saved != _uiState.value.configuration
        if (connectionChanged) {
            invalidatePreviewCatalog()
            invalidatePreviewResults()
        }
        _uiState.update {
            it.copy(
                configuration = saved,
                connectionRevision = it.connectionRevision + if (connectionChanged) 1 else 0,
                notice = "Relay configuration saved.",
                error = if (savedUrls != requestedUrls) {
                    "Machine and manifest URLs must use HTTPS."
                } else null,
            )
        }
    }

    fun importIdentity(uri: Uri, password: String) {
        viewModelScope.launch {
            runLoading {
                val subject = withContext(Dispatchers.IO) { identityStore.import(uri, password) }
                invalidatePreviewCatalog()
                invalidatePreviewResults()
                _uiState.update {
                    it.copy(certificateSubject = subject, connectionRevision = it.connectionRevision + 1, notice = "Client certificate imported securely.")
                }
            }
        }
    }

    fun clearIdentity() {
        viewModelScope.launch {
            runLoading {
                withContext(Dispatchers.IO) { identityStore.clear() }
                invalidatePreviewCatalog()
                invalidatePreviewResults()
                _uiState.update {
                    it.copy(certificateSubject = null, connectionRevision = it.connectionRevision + 1, notice = "Client certificate removed from this app.")
                }
            }
        }
    }

    fun loadWorkspaces(path: String? = _uiState.value.currentPath) {
        if (!guardMachineReady()) return
        viewModelScope.launch {
            runLoading {
                val listing = repository().listWorkspaceDirectories(path)
                _uiState.update { it.copy(listing = listing, currentPath = listing.currentPath) }
            }
        }
    }

    fun navigateToDirectory(path: String) = loadWorkspaces(path)

    fun navigateUp() {
        _uiState.value.listing?.upNavigationPath?.let(::loadWorkspaces)
    }

    fun openWorkspace(entry: WorkspaceEntry) {
        if (!guardMachineReady()) return
        viewModelScope.launch {
            runLoading {
                val repository = repository()
                val workspace = repository.selectWorkspace(entry.path)
                val selected = entry.copy(
                    workspaceId = workspace.resolvedId,
                    workspaceName = workspace.displayName,
                    isRegistered = true,
                )
                val content = coroutineScope {
                    val threads = async { repository.listThreads(workspaceId = workspace.resolvedId, limit = 200) }
                    val jobs = async { repository.listJobs(workspaceId = workspace.resolvedId, limit = 100) }
                    val models = async { runCatching { repository.listModels() }.getOrDefault(emptyList()) }
                    Triple(threads.await(), jobs.await(), models.await())
                }
                _uiState.update {
                    it.copy(
                        selectedWorkspace = selected,
                        selectedThread = null,
                        selectedJob = null,
                        threads = content.first,
                        jobs = content.second,
                        models = content.third,
                        approvals = emptyList(),
                        streamState = JobStreamState(),
                    )
                }
            }
        }
    }

    fun closeWorkspace() {
        streamCollection?.cancel()
        _uiState.update {
            it.copy(
                selectedWorkspace = null,
                selectedThread = null,
                selectedJob = null,
                approvals = emptyList(),
                streamState = JobStreamState(),
                streaming = false,
            )
        }
    }

    fun loadActiveJobs() {
        if (!guardMachineReady()) return
        viewModelScope.launch {
            runLoading {
                val jobs = repository().listJobs(limit = 100)
                    .filter { it.resolvedStatus.isActive || it.resolvedStatus.needsAttention }
                _uiState.update { it.copy(jobs = jobs) }
            }
        }
    }

    fun openActiveJob(job: RelayJob) = openJob(job, automaticallyOpensPreviews = true)

    // Reading the source is a separate presentation; a historical "show app"
    // prompt must not replace it with a viewer when an active job completes.
    fun openPreviewSourceJob(job: RelayJob) = openJob(job, automaticallyOpensPreviews = false)

    private fun openJob(job: RelayJob, automaticallyOpensPreviews: Boolean) {
        streamCollection?.cancel()
        _uiState.update {
            it.copy(
                selectedWorkspace = null,
                selectedThread = null,
                selectedJob = job,
                streamState = JobStreamState(job = job, stdout = job.stdout.orEmpty(), stderr = job.stderr.orEmpty()),
                approvals = emptyList(),
                streaming = false,
            )
        }
        if (job.resolvedStatus.isActive) collectJob(job.resolvedId, automaticallyOpensPreviews)
        if (job.resolvedStatus.needsAttention) loadApprovals(job.resolvedId)
    }

    fun closeJob() {
        streamCollection?.cancel()
        _uiState.update { it.copy(selectedJob = null, streamState = JobStreamState(), approvals = emptyList(), streaming = false) }
    }

    fun openThread(thread: ThreadSummary) {
        if (!guardMachineReady()) return
        viewModelScope.launch {
            runLoading {
                val detail = repository().threadDetail(thread.resolvedSessionId, thread.workspaceId, thread.provider)
                // Relay returns thread jobs newest-first, matching the thread summary.
                val latestJob = detail.jobs.firstOrNull()
                _uiState.update {
                    it.copy(
                        selectedThread = detail,
                        selectedJob = latestJob,
                        streamState = JobStreamState(
                            job = latestJob,
                            stdout = latestJob?.stdout.orEmpty(),
                            stderr = latestJob?.stderr.orEmpty(),
                        ),
                        approvals = emptyList(),
                    )
                }
                if (latestJob?.resolvedStatus?.isActive == true) collectJob(latestJob.resolvedId)
                if (latestJob?.resolvedStatus?.needsAttention == true) loadApprovals(latestJob.resolvedId)
            }
        }
    }

    fun closeThread() {
        streamCollection?.cancel()
        _uiState.update {
            it.copy(selectedThread = null, selectedJob = null, streamState = JobStreamState(), approvals = emptyList(), streaming = false)
        }
    }

    fun submitTask(prompt: String, provider: RelayProvider, model: String?) {
        val workspace = _uiState.value.selectedWorkspace
        val workspaceId = workspace?.workspaceId
        if (workspaceId.isNullOrBlank()) {
            _uiState.update { it.copy(error = "Choose a workspace before starting a task.") }
            return
        }
        if (prompt.isBlank()) return

        viewModelScope.launch {
            runLoading {
                val currentThread = _uiState.value.selectedThread?.thread
                val created = repository().createJob(
                    CreateJobRequest(
                        workspaceId = workspaceId,
                        prompt = prompt.trim(),
                        model = model?.takeIf { it.isNotBlank() },
                        reasoningEffort = if (provider == RelayProvider.CODEX) "xhigh" else null,
                        provider = provider,
                        permissionMode = if (provider == RelayProvider.CLAUDE) "default" else null,
                        approvalPolicy = if (provider == RelayProvider.CODEX) "on-request" else null,
                        resumeSessionId = currentThread?.resolvedSessionId,
                    ),
                )
                val job = created.job ?: RelayJob(
                    id = created.id,
                    provider = provider,
                    workspaceId = workspaceId,
                    workspaceName = workspace.workspaceName,
                    status = live.relay.core.JobStatus.QUEUED,
                    prompt = prompt.trim(),
                    resumeSessionId = currentThread?.resolvedSessionId,
                )
                _uiState.update {
                    it.copy(selectedJob = job, streamState = JobStreamState(job = job), approvals = emptyList())
                }
                collectJob(created.id)
            }
        }
    }

    fun cancelSelectedJob() {
        val id = _uiState.value.selectedJob?.resolvedId ?: return
        viewModelScope.launch {
            runLoading {
                repository().cancelJob(id)
                _uiState.update { it.copy(notice = "Cancel requested.") }
            }
        }
    }

    fun openRemotePreview(jobId: String, sourceUrl: String) {
        if (!guardMachineReady()) return
        val connection = _uiState.value
        val repository = repository()
        viewModelScope.launch {
            runLoading {
                val lease = repository.createPreview(jobId, sourceUrl)
                if (_uiState.value.connectionRevision != connection.connectionRevision) return@runLoading
                val previewUrl = trustedPreviewUrl(lease.url, connection.configuration.codexBaseUrl)
                    ?: error("Relay returned an invalid localhost preview URL.")
                _uiState.update { it.copy(previewUrl = previewUrl) }
            }
        }
    }

    fun closeRemotePreview() {
        _uiState.update { it.copy(previewUrl = null) }
    }

    fun openArtifact(artifact: live.relay.core.JobArtifact) {
        if (!guardMachineReady()) return
        val connection = _uiState.value
        viewModelScope.launch {
            runLoading {
                artifactOpener.open(artifact, connection.configuration.codexBaseUrl) {
                    _uiState.value.connectionRevision == connection.connectionRevision
                }
            }
        }
    }

    fun decideApproval(approval: Approval, decision: String) {
        viewModelScope.launch {
            runLoading {
                repository().decideApproval(approval.id, decision)
                loadApprovalsNow(approval.jobId)
            }
        }
    }

    fun loadPocs() {
        invalidatePreviewCatalog()
        if (_uiState.value.certificateSubject == null) {
            _uiState.update { it.copy(pocsError = "Import a Relay client certificate in Settings before loading your preview catalog.") }
            return
        }
        val configuration = _uiState.value.configuration
        _uiState.update { it.copy(pocsLoading = true) }
        pocCollection = viewModelScope.launch {
            try {
                val client = RelayHttpClientFactory(identityStore).create()
                val manifest = AndroidManifestClient(
                    client,
                    configuration.manifestUrl,
                    configuration.signatureUrl,
                ).fetch()
                ensureActive()
                _uiState.update {
                    it.copy(
                        pocs = manifest.pocs.sortedByDescending(PocEntry::updatedAt),
                        pocsCatalogVerified = true,
                        pocsCatalogGeneratedAt = manifest.generatedAt,
                        pocsLoading = false,
                    )
                }
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Throwable) {
                ensureActive()
                _uiState.update { it.copy(pocsLoading = false, pocsError = friendlyError(error)) }
            }
        }
    }

    fun loadPreviewResults() {
        invalidatePreviewResults()
        if (!_uiState.value.isReadyForMachineRequests) return
        _uiState.update { it.copy(previewJobsLoading = true) }
        previewJobCollection = viewModelScope.launch {
            try {
                val jobs = repository().listJobs(limit = 100)
                ensureActive()
                _uiState.update {
                    it.copy(previewJobs = jobs, previewJobsLoaded = true, previewJobsLoading = false)
                }
            } catch (error: kotlinx.coroutines.CancellationException) {
                throw error
            } catch (error: Throwable) {
                ensureActive()
                _uiState.update { it.copy(previewJobsLoading = false, previewJobsError = friendlyError(error)) }
            }
        }
    }

    fun openPreviewArtifact(artifact: live.relay.core.JobArtifact) {
        if (!guardMachineReady()) return
        if (artifact.previewURL == null) {
            openArtifact(artifact)
            return
        }
        val url = resolvedArtifactUrl(artifact.previewURL, _uiState.value.configuration.codexBaseUrl)
        _uiState.update {
            if (url == null) it.copy(error = "Relay returned an invalid preview URL.") else it.copy(previewUrl = url)
        }
    }

    private fun invalidatePreviewResults() {
        previewJobCollection?.cancel()
        previewJobCollection = null
        _uiState.update {
            it.copy(
                previewJobs = emptyList(),
                previewJobsLoaded = false,
                previewJobsLoading = false,
                previewJobsError = null,
                previewUrl = null,
            )
        }
    }

    private fun invalidatePreviewCatalog() {
        pocCollection?.cancel()
        pocCollection = null
        _uiState.update {
            it.copy(
                pocs = emptyList(),
                pocsCatalogVerified = false,
                pocsCatalogGeneratedAt = null,
                pocsLoading = false,
                pocsError = null,
            )
        }
    }

    private fun collectJob(id: String, automaticallyOpensPreviews: Boolean = true) {
        streamCollection?.cancel()
        streamCollection = viewModelScope.launch {
            _uiState.update { it.copy(streaming = true) }
            try {
                var state = _uiState.value.streamState
                repository().streamJob(id, state.stdoutOffset, state.stderrOffset).collect { event ->
                    state = state.reduce(event)
                    val job = when (event) {
                        is JobStreamEvent.Status -> event.job
                        is JobStreamEvent.Done -> event.job
                        else -> state.job
                    }
                    _uiState.update { it.copy(selectedJob = job ?: it.selectedJob, streamState = state) }
                    if (automaticallyOpensPreviews) job?.let { maybeOpenRequestedPreview(it, state.stdout) }
                    if (job?.resolvedStatus == live.relay.core.JobStatus.WAITING_FOR_APPROVAL) {
                        loadApprovalsNow(id)
                    }
                }
                refreshSelectedWorkspace()
            } catch (error: Throwable) {
                if (error !is kotlinx.coroutines.CancellationException) {
                    _uiState.update { it.copy(error = error.message ?: "The live job stream stopped.") }
                }
            } finally {
                _uiState.update { it.copy(streaming = false) }
            }
        }
    }

    private fun loadApprovals(jobId: String) {
        viewModelScope.launch { runCatching { loadApprovalsNow(jobId) } }
    }

    private suspend fun loadApprovalsNow(jobId: String) {
        val approvals = repository().listPendingApprovalsIfSupported(jobId)
        _uiState.update { it.copy(approvals = approvals) }
    }

    private suspend fun refreshSelectedWorkspace() {
        val workspaceId = _uiState.value.selectedWorkspace?.workspaceId ?: return
        val repository = repository()
        val threads = repository.listThreads(workspaceId = workspaceId, limit = 200)
        val jobs = repository.listJobs(workspaceId = workspaceId, limit = 100)
        _uiState.update { it.copy(threads = threads, jobs = jobs) }
    }

    private fun repository(): RelayRepository {
        val configuration = _uiState.value.configuration
        check(configuration.hasConfiguredMachine) { "Configure your Relay machine URL in Settings first." }
        val client = RelayHttpClientFactory(identityStore).create()
        return RelayRepository(OkHttpRelayTransport(configuration.codexBaseUrl, client))
    }

    private fun maybeOpenRequestedPreview(job: RelayJob, streamedOutput: String) {
        if (job.resolvedStatus != live.relay.core.JobStatus.SUCCEEDED) return
        if (!RelayPresentationIntent.requestsAutomaticPreview(job.prompt)) return
        val currentSource = RelayLocalPreviewUrls.extract(
            listOfNotNull(job.displayOutput, streamedOutput.takeIf(String::isNotBlank)).joinToString("\n"),
        ).firstOrNull()
        val source = if (currentSource != null) {
            job to currentSource
        } else {
            sequenceOf(
                _uiState.value.selectedThread?.jobs.orEmpty(),
                _uiState.value.jobs,
            )
                .flatten()
                .distinctBy(RelayJob::resolvedId)
                .firstNotNullOfOrNull { sourceJob ->
                    sourceJob.displayOutput
                        ?.let(RelayLocalPreviewUrls::extract)
                        ?.firstOrNull()
                        ?.let { sourceJob to it }
                }
                ?: return
        }
        val key = "${job.resolvedId}|${source.first.resolvedId}|${source.second}"
        if (!automaticallyOpenedPreviews.add(key)) return
        openRemotePreview(source.first.resolvedId, source.second)
    }

    private fun guardMachineReady(): Boolean {
        val state = _uiState.value
        val message = when {
            !state.configuration.hasConfiguredMachine -> "Configure your Relay machine URL in Settings first."
            state.certificateSubject == null -> "Import the Relay client certificate in Settings first."
            else -> null
        }
        if (message != null) _uiState.update { it.copy(error = message) }
        return message == null
    }

    private suspend fun runLoading(block: suspend () -> Unit) {
        _uiState.update { it.copy(loading = true, error = null, notice = null) }
        try {
            block()
        } catch (error: Throwable) {
            if (error !is kotlinx.coroutines.CancellationException) {
                _uiState.update { it.copy(error = friendlyError(error)) }
            }
        } finally {
            _uiState.update { it.copy(loading = false) }
        }
    }

    private fun friendlyError(error: Throwable): String {
        val message = error.message.orEmpty()
        return when {
            error is RelayHttpException && error.isGenericRouteNotFound ->
                "This linked computer is running an older Relay service that cannot open app previews. Update Relay on that computer, then try again."
            message.contains("CERTIFICATE_REQUIRED", ignoreCase = true) -> "The Relay server requires a valid client certificate."
            message.contains("PKIX", ignoreCase = true) -> "Relay could not verify the server certificate."
            message.contains("unconfigured.invalid", ignoreCase = true) -> "Configure your Relay machine URL in Settings first."
            message.isNotBlank() -> message
            else -> "Relay could not complete the request."
        }
    }
}

private fun trustedPreviewUrl(value: String, baseUrl: String): String? {
    val base = Uri.parse(baseUrl)
    val candidate = when {
        value.startsWith("/") -> base.buildUpon().encodedPath(value).clearQuery().fragment(null).build()
        else -> Uri.parse(value)
    }
    if (!sameOrigin(candidate, base) || candidate.userInfo != null || candidate.query != null || candidate.fragment != null) return null
    if (!Regex("^/v1/codex/previews/[A-Za-z0-9_-]{43}$").matches(candidate.path.orEmpty())) return null
    return candidate.toString()
}

internal fun sameOrigin(candidate: Uri, base: Uri): Boolean {
    return candidate.scheme.equals(base.scheme, ignoreCase = true) &&
        candidate.host.equals(base.host, ignoreCase = true) &&
        effectivePort(candidate) == effectivePort(base)
}

internal fun effectivePort(uri: Uri): Int = when {
    uri.port >= 0 -> uri.port
    uri.scheme.equals("https", ignoreCase = true) -> 443
    uri.scheme.equals("http", ignoreCase = true) -> 80
    else -> -1
}
