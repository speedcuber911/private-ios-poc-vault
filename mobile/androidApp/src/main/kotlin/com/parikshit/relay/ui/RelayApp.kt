package com.parikshit.relay.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.ClientCertRequest
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Apps
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.net.toUri
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.parikshit.relay.data.RelaySettings
import live.relay.core.Approval
import live.relay.core.JobArtifact
import live.relay.core.ModelDescriptor
import live.relay.core.PocEntry
import live.relay.core.RelayLocalPreviewUrls
import live.relay.core.RelayProvider
import live.relay.core.RelayAIDataSharing
import live.relay.core.RelayArtifactPresentation
import live.relay.core.RelayWorkspacePreviews
import live.relay.core.ThreadSummary
import live.relay.core.WorkspaceEntry
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import live.relay.core.Job as RelayJob

private val RelayRed = Color(0xFFFF5D3A)
private val RelayColors = darkColorScheme(
    primary = RelayRed,
    onPrimary = Color(0xFF1A0B07),
    secondary = Color(0xFFB9C7FF),
    background = Color(0xFF101010),
    surface = Color(0xFF171717),
    surfaceVariant = Color(0xFF242424),
    onSurface = Color(0xFFF3F3F3),
    onSurfaceVariant = Color(0xFFB9B9B9),
    error = Color(0xFFFFB4AB),
)

private enum class RootTab(val label: String) {
    WORKSPACES("Workspaces"), ACTIVE("Active"), LIBRARY("Previews"), SETTINGS("Settings")
}

private enum class PreviewSource(val label: String) {
    WORKSPACE_RESULTS("Workspace results"), PUBLISHED_CATALOG("Published catalog")
}

@Composable
fun RelayApp(viewModel: RelayViewModel = viewModel()) {
    val state by viewModel.uiState.collectAsStateWithLifecycle()
    val snackbar = remember { SnackbarHostState() }
    var tab by rememberSaveable { mutableStateOf(RootTab.WORKSPACES) }
    var previewSource by rememberSaveable(state.connectionRevision) { mutableStateOf(PreviewSource.WORKSPACE_RESULTS) }
    var pocUrl by rememberSaveable(state.connectionRevision) { mutableStateOf<String?>(null) }
    var selectedPocId by rememberSaveable(state.connectionRevision) { mutableStateOf<String?>(null) }
    val selectedPoc = state.pocs.firstOrNull { it.resolvedId == selectedPocId }

    LaunchedEffect(state.error, state.notice) {
        val message = state.error ?: state.notice ?: return@LaunchedEffect
        snackbar.showSnackbar(message)
        viewModel.clearMessage()
    }

    MaterialTheme(colorScheme = RelayColors) {
        Surface(modifier = Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxSize()) {
                when {
                    state.previewUrl != null -> RelayWebView(
                        url = state.previewUrl!!,
                        title = "App preview",
                        errorTitle = "Could not open the app preview",
                        identityStore = viewModel.identityStore,
                        onBack = viewModel::closeRemotePreview,
                    )
                    pocUrl != null -> RelayWebView(
                        url = pocUrl!!,
                        title = "Relay preview",
                        errorTitle = "Could not open this preview",
                        identityStore = viewModel.identityStore,
                        onBack = { pocUrl = null },
                    )
                    selectedPoc != null -> PocPreviewDetailsScreen(
                        poc = selectedPoc,
                        catalogGeneratedAt = state.pocsCatalogGeneratedAt,
                        onBack = { selectedPocId = null },
                        onOpen = { pocUrl = selectedPoc.url },
                    )
                    state.selectedThread != null -> ConversationScreen(
                        state = state,
                        onBack = viewModel::closeThread,
                        onSubmit = viewModel::submitTask,
                        onGrantAIDataConsent = viewModel::grantAIDataConsent,
                        onCancel = viewModel::cancelSelectedJob,
                        onDecision = viewModel::decideApproval,
                        onOpenArtifact = { artifact ->
                            if (artifact.previewURL != null) {
                                artifactUrl(artifact, state.configuration.codexBaseUrl)?.let { pocUrl = it }
                            } else {
                                viewModel.openArtifact(artifact)
                            }
                        },
                        onOpenPreview = viewModel::openRemotePreview,
                    )
                    state.selectedWorkspace != null -> WorkspaceSessionScreen(
                        state = state,
                        onBack = viewModel::closeWorkspace,
                        onOpenThread = viewModel::openThread,
                        onSubmit = viewModel::submitTask,
                        onGrantAIDataConsent = viewModel::grantAIDataConsent,
                        onCancel = viewModel::cancelSelectedJob,
                        onDecision = viewModel::decideApproval,
                        onOpenArtifact = { artifact ->
                            if (artifact.previewURL != null) {
                                artifactUrl(artifact, state.configuration.codexBaseUrl)?.let { pocUrl = it }
                            } else {
                                viewModel.openArtifact(artifact)
                            }
                        },
                        onOpenPreview = viewModel::openRemotePreview,
                    )
                    state.selectedJob != null -> JobDetailScreen(
                        state = state,
                        onBack = viewModel::closeJob,
                        onCancel = viewModel::cancelSelectedJob,
                        onDecision = viewModel::decideApproval,
                        onOpenArtifact = { artifact ->
                            if (artifact.previewURL != null) {
                                artifactUrl(artifact, state.configuration.codexBaseUrl)?.let { pocUrl = it }
                            } else {
                                viewModel.openArtifact(artifact)
                            }
                        },
                        onOpenPreview = viewModel::openRemotePreview,
                    )
                    else -> RootScreen(
                        state = state,
                        tab = tab,
                        previewSource = previewSource,
                        onPreviewSource = { previewSource = it },
                        snackbar = snackbar,
                        onTab = { selected ->
                            tab = selected
                            when (selected) {
                                RootTab.WORKSPACES -> viewModel.loadWorkspaces()
                                RootTab.ACTIVE -> viewModel.loadActiveJobs()
                                RootTab.LIBRARY -> Unit
                                RootTab.SETTINGS -> Unit
                            }
                        },
                        viewModel = viewModel,
                        onOpenPoc = { selectedPocId = it.resolvedId },
                    )
                }

                if (state.loading) {
                    Box(
                        Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.2f)),
                        contentAlignment = Alignment.Center,
                    ) {
                        CircularProgressIndicator()
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RootScreen(
    state: RelayUiState,
    tab: RootTab,
    previewSource: PreviewSource,
    onPreviewSource: (PreviewSource) -> Unit,
    snackbar: SnackbarHostState,
    onTab: (RootTab) -> Unit,
    viewModel: RelayViewModel,
    onOpenPoc: (PocEntry) -> Unit,
) {
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        RelayMark()
                        Spacer(Modifier.width(10.dp))
                        Text("Relay", fontWeight = FontWeight.SemiBold)
                    }
                },
                actions = {
                    if (tab != RootTab.SETTINGS) {
                        IconButton(
                            onClick = {
                                when (tab) {
                                    RootTab.WORKSPACES -> viewModel.loadWorkspaces()
                                    RootTab.ACTIVE -> viewModel.loadActiveJobs()
                                    RootTab.LIBRARY -> when (previewSource) {
                                        PreviewSource.WORKSPACE_RESULTS -> viewModel.loadPreviewResults()
                                        PreviewSource.PUBLISHED_CATALOG -> viewModel.loadPocs()
                                    }
                                    RootTab.SETTINGS -> Unit
                                }
                            },
                        ) { Icon(Icons.Default.Refresh, contentDescription = "Refresh") }
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
                RootTab.entries.forEach { item ->
                    NavigationBarItem(
                        selected = item == tab,
                        onClick = { onTab(item) },
                        label = { Text(item.label) },
                        icon = {
                            Icon(
                                when (item) {
                                    RootTab.WORKSPACES -> Icons.Default.FolderOpen
                                    RootTab.ACTIVE -> Icons.Default.Bolt
                                    RootTab.LIBRARY -> Icons.Default.Apps
                                    RootTab.SETTINGS -> Icons.Default.Settings
                                },
                                contentDescription = null,
                            )
                        },
                    )
                }
            }
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                RootTab.WORKSPACES -> WorkspacesScreen(state, viewModel)
                RootTab.ACTIVE -> ActiveJobsScreen(state.jobs, viewModel::openActiveJob)
                RootTab.LIBRARY -> Column(Modifier.fillMaxSize().testTag("relay-previews")) {
                    Row(Modifier.padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        PreviewSource.entries.forEach { source ->
                            FilterChip(
                                selected = previewSource == source,
                                onClick = { onPreviewSource(source) },
                                label = { Text(source.label) },
                            )
                        }
                    }
                    when (previewSource) {
                        PreviewSource.WORKSPACE_RESULTS -> WorkspacePreviewsScreen(
                            state = state,
                            onRefresh = viewModel::loadPreviewResults,
                            onSettings = { onTab(RootTab.SETTINGS) },
                            onWorkspaces = { onTab(RootTab.WORKSPACES) },
                            onOpenJob = viewModel::openPreviewSourceJob,
                            onOpenArtifact = viewModel::openPreviewArtifact,
                            onOpenPreview = viewModel::openRemotePreview,
                        )
                        PreviewSource.PUBLISHED_CATALOG -> PocLibraryScreen(
                            state = state,
                            onOpen = onOpenPoc,
                            onRefresh = viewModel::loadPocs,
                            onSettings = { onTab(RootTab.SETTINGS) },
                        )
                    }
                }
                RootTab.SETTINGS -> SettingsScreen(state, viewModel)
            }
        }
    }
}

@Composable
private fun RelayMark() {
    Box(
        Modifier.size(29.dp).background(RelayRed, RoundedCornerShape(9.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(Icons.Default.Terminal, contentDescription = null, tint = Color(0xFF1A0B07), modifier = Modifier.size(19.dp))
    }
}

@Composable
private fun ReadinessCard(state: RelayUiState) {
    Card(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Icon(Icons.Default.Lock, contentDescription = null, tint = RelayRed)
            Text("Finish setup", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            Text(
                when {
                    !state.configuration.hasConfiguredMachine -> "Add your linked Relay machine URL in Settings."
                    state.certificateSubject == null -> "Import the Relay client certificate in Settings."
                    else -> "Relay is ready."
                },
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun WorkspacesScreen(state: RelayUiState, viewModel: RelayViewModel) {
    LaunchedEffect(Unit) {
        if (state.listing == null && state.isReadyForMachineRequests) viewModel.loadWorkspaces()
    }
    if (!state.isReadyForMachineRequests) {
        ReadinessCard(state)
        return
    }
    val listing = state.listing
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(bottom = 24.dp),
    ) {
        item {
            Column(Modifier.padding(horizontal = 18.dp, vertical = 14.dp)) {
                Text("Workspaces", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    listing?.displayPath ?: "Loading linked folders…",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        listing?.upNavigationPath?.let {
            item {
                TextButton(onClick = viewModel::navigateUp, modifier = Modifier.padding(horizontal = 10.dp)) {
                    Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Parent folder")
                }
            }
        }
        items(listing?.entries.orEmpty(), key = WorkspaceEntry::path) { entry ->
            WorkspaceRow(
                entry = entry,
                onBrowse = { if (entry.isDirectory) viewModel.navigateToDirectory(entry.path) },
                onOpen = { viewModel.openWorkspace(entry) },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.surfaceVariant)
        }
        if (listing != null && listing.entries.isEmpty()) {
            item { EmptyState("No linked folders here", "Browse up or connect another folder from your computer.") }
        }
    }
}

@Composable
private fun WorkspaceRow(entry: WorkspaceEntry, onBrowse: () -> Unit, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onBrowse).padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (entry.isDirectory) Icons.Default.Folder else Icons.Default.Description, contentDescription = null, tint = RelayRed)
        Spacer(Modifier.width(13.dp))
        Column(Modifier.weight(1f)) {
            Text(entry.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                entry.detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (entry.isDirectory) {
            TextButton(onClick = onOpen) { Text("Open") }
            Icon(Icons.Default.ChevronRight, contentDescription = "Browse")
        }
    }
}

@Composable
private fun ActiveJobsScreen(jobs: List<RelayJob>, onOpen: (RelayJob) -> Unit) {
    if (jobs.isEmpty()) {
        EmptyState("Nothing needs attention", "Running jobs and approval requests will appear here.")
        return
    }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item { Text("Active sessions", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
        items(jobs, key = RelayJob::resolvedId) { job -> JobRow(job, onClick = { onOpen(job) }) }
    }
}

@Composable
private fun JobRow(job: RelayJob, onClick: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Row(Modifier.padding(15.dp), verticalAlignment = Alignment.CenterVertically) {
            StatusDot(job)
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                Text(job.displayPrompt, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(
                    "${job.provider.displayName} · ${job.resolvedStatus.label}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Icon(Icons.Default.ChevronRight, contentDescription = null)
        }
    }
}

@Composable
private fun StatusDot(job: RelayJob) {
    val color = when {
        job.resolvedStatus.needsAttention -> MaterialTheme.colorScheme.error
        job.resolvedStatus.isActive -> RelayRed
        else -> Color(0xFF62D79B)
    }
    Box(Modifier.size(10.dp).background(color, RoundedCornerShape(50)))
}

@Composable
private fun WorkspacePreviewsScreen(
    state: RelayUiState,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
    onWorkspaces: () -> Unit,
    onOpenJob: (RelayJob) -> Unit,
    onOpenArtifact: (JobArtifact) -> Unit,
    onOpenPreview: (String, String) -> Unit,
) {
    LaunchedEffect(Unit) {
        if (!state.previewJobsLoaded && !state.previewJobsLoading && state.previewJobsError == null) onRefresh()
    }
    val previewJobs = remember(state.previewJobs) {
        state.previewJobs.filter { job ->
            job.artifacts.isNotEmpty() || RelayWorkspacePreviews.sources(job.displayOutput, job.stdout).isNotEmpty()
        }
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("relay-preview-results"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Previews", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text("Open what your workspace produced.", color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(
                    "Files and running app previews reported by recent jobs on your linked machine. These results are separate from the published catalog.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        when {
            !state.isReadyForMachineRequests -> item {
                PreviewInformationSection("Connect a workspace") {
                    Text("Configure your linked Relay machine and import its client certificate in Settings. Workspace results do not require access to the separate published catalog.")
                    OutlinedButton(onClick = onSettings) { Text("Open Settings") }
                }
            }
            state.previewJobsLoading -> item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    Text("Loading workspace results…")
                }
            }
            state.previewJobsError != null -> item {
                PreviewInformationSection("Could not load workspace results") {
                    Text(state.previewJobsError, color = MaterialTheme.colorScheme.error)
                    Text("This is a connection or request failure, not an empty results list.")
                    OutlinedButton(onClick = onRefresh) { Text("Try again") }
                }
            }
            state.previewJobsLoaded && previewJobs.isEmpty() -> item {
                PreviewInformationSection("No preview results yet") {
                    Text("No files or app-preview addresses were reported by the latest 100 jobs. Open a workspace and ask your agent to produce a file or start an app, then return here.")
                    OutlinedButton(onClick = onWorkspaces) { Text("Open Workspaces") }
                }
            }
        }
        items(previewJobs, key = RelayJob::resolvedId) { job ->
            PreviewInformationSection(job.workspaceName ?: job.workspaceId ?: "Workspace result") {
                Text(job.displayPrompt, style = MaterialTheme.typography.titleSmall, maxLines = 3, overflow = TextOverflow.Ellipsis)
                Text(
                    "${job.provider.displayName} · ${job.resolvedStatus.label}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                job.artifacts.forEach { artifact ->
                    val kind = RelayArtifactPresentation.kind(
                        filename = artifact.filename,
                        contentType = artifact.contentType,
                        artifactKind = artifact.kind,
                        hasPreview = artifact.previewURL != null,
                    )
                    val hasAddress = !artifact.previewURL.isNullOrBlank() || !artifact.rawURL.isNullOrBlank()
                    OutlinedButton(
                        onClick = { onOpenArtifact(artifact) },
                        enabled = hasAddress,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(artifact.title ?: artifact.filename, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(if (hasAddress) "Open ${kind.wireValue}" else "No file address reported", style = MaterialTheme.typography.labelSmall)
                        }
                    }
                }
                val sources = RelayWorkspacePreviews.sources(job.displayOutput, job.stdout).take(4)
                sources.forEachIndexed { index, source ->
                    Button(onClick = { onOpenPreview(job.resolvedId, source) }, modifier = Modifier.fillMaxWidth()) {
                        Text(if (sources.size == 1) "Open running app" else "Open running app ${index + 1}")
                    }
                }
                if (sources.isNotEmpty()) {
                    Text("Running previews require the app's server to still be running on your linked machine.", style = MaterialTheme.typography.bodySmall)
                }
                TextButton(onClick = { onOpenJob(job) }) { Text("View source job") }
            }
        }
    }
}

@Composable
private fun PocLibraryScreen(
    state: RelayUiState,
    onOpen: (PocEntry) -> Unit,
    onRefresh: () -> Unit,
    onSettings: () -> Unit,
) {
    LaunchedEffect(Unit) {
        if (!state.pocsCatalogVerified && !state.pocsLoading && state.pocsError == null) onRefresh()
    }
    LazyColumn(
        modifier = Modifier.fillMaxSize().testTag("relay-preview-catalog"),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        item {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("Published catalog", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    "Published web previews from your signed catalog.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    "Inspect a published preview and its access requirements before opening it. Previews are separate from your linked workspaces.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        when {
            state.pocsLoading -> item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                    Text("Loading and verifying the catalog…", style = MaterialTheme.typography.bodyMedium)
                }
            }
            state.certificateSubject == null -> item {
                PreviewInformationSection("Connect your preview catalog") {
                    Text("Import a Relay client certificate in Settings to load your configured catalog. The certificate is separate from the catalog signature.")
                    OutlinedButton(onClick = onSettings) { Text("Open Settings") }
                }
            }
            state.pocsError != null -> item {
                PreviewInformationSection("Catalog unavailable") {
                    Text(state.pocsError, color = MaterialTheme.colorScheme.error)
                    Text("No previews are shown until Relay can load and verify the catalog. Check the catalog URLs and client certificate in Settings.")
                    OutlinedButton(onClick = onRefresh) { Text("Try again") }
                }
            }
            state.pocsCatalogVerified -> item {
                PreviewInformationSection("Catalog integrity") {
                    Text("Manifest signature verified.", fontWeight = FontWeight.Medium)
                    Text("This verifies the catalog, not the contents of downloaded web pages.")
                    state.pocsCatalogGeneratedAt?.let { Text("Catalog generated ${previewDate(it)}", style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
        if (state.pocsCatalogVerified && state.pocs.isEmpty()) {
            item {
                PreviewInformationSection("No published previews yet") {
                    Text("The verified catalog is empty. Publish a static preview through your Relay deployment workflow, then refresh here. A linked workspace does not automatically create a catalog entry.")
                    OutlinedButton(onClick = onRefresh) { Text("Refresh catalog") }
                }
            }
        }
        items(state.pocs, key = PocEntry::resolvedId) { poc ->
            Card(
                modifier = Modifier.fillMaxWidth().clickable { onOpen(poc) },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.Default.Apps, contentDescription = null, tint = RelayRed)
                    Spacer(Modifier.width(13.dp))
                    Column(Modifier.weight(1f)) {
                        Text(poc.title, fontWeight = FontWeight.Medium)
                        Text(
                            poc.detail,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Spacer(Modifier.height(6.dp))
                        Text(
                            if (poc.requiresClientCertificate) "Client certificate required" else "No client certificate required by catalog",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                    Icon(Icons.Default.ChevronRight, contentDescription = null)
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PocPreviewDetailsScreen(
    poc: PocEntry,
    catalogGeneratedAt: String?,
    onBack: () -> Unit,
    onOpen: () -> Unit,
) {
    BackHandler(onBack = onBack)
    Scaffold(
        modifier = Modifier.testTag("relay-previews-details"),
        topBar = {
            TopAppBar(
                title = { Text("Preview details") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back to previews")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        Column(
            Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).padding(18.dp),
            verticalArrangement = Arrangement.spacedBy(18.dp),
        ) {
            Text(poc.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text(poc.detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(onClick = onOpen, modifier = Modifier.fillMaxWidth().testTag("relay-previews-open")) {
                Text("Open preview")
            }
            PreviewInformationSection("Published preview") {
                PreviewMetadataRow("Host", poc.url.toUri().host ?: "Not provided")
                poc.updatedAt?.let { PreviewMetadataRow("Updated", previewDate(it)) }
                if (poc.tags.isNotEmpty()) PreviewMetadataRow("Tags", poc.tags.joinToString(" · "))
                PreviewMetadataRow("Address", poc.url)
            }
            PreviewInformationSection("Catalog integrity") {
                Text("Manifest signature verified.", fontWeight = FontWeight.Medium)
                Text("This verifies the catalog, not the contents of downloaded web pages.")
                catalogGeneratedAt?.let { PreviewMetadataRow("Catalog generated", previewDate(it)) }
            }
            PreviewInformationSection("Access") {
                Text(
                    if (poc.requiresClientCertificate) "Client certificate required" else "No client certificate required by catalog",
                    fontWeight = FontWeight.Medium,
                )
                Text(
                    if (poc.requiresClientCertificate) {
                        "The catalog marks this preview as requiring a valid client certificate. Relay uses the certificate imported on this device when the configured server requests it."
                    } else {
                        "The catalog does not mark this preview as requiring a client certificate. The website may still have its own sign-in or access rules."
                    },
                )
                Text("The catalog's access requirement is separate from its signature. It does not mean the preview is restricted to one device.")
            }
        }
    }
}

@Composable
private fun PreviewInformationSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@Composable
private fun PreviewMetadataRow(label: String, value: String) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        SelectionContainer { Text(value, style = MaterialTheme.typography.bodyMedium) }
    }
}

private fun previewDate(value: String): String = runCatching {
    DateTimeFormatter.ofLocalizedDateTime(FormatStyle.MEDIUM, FormatStyle.SHORT)
        .withZone(ZoneId.systemDefault())
        .format(Instant.parse(value))
}.getOrDefault(value)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(state: RelayUiState, viewModel: RelayViewModel) {
    val uriHandler = LocalUriHandler.current
    var codexUrl by remember(state.configuration.codexBaseUrl) {
        mutableStateOf(state.configuration.codexBaseUrl.takeUnless { it == RelaySettings.UNCONFIGURED_CODEX_URL }.orEmpty())
    }
    var manifestUrl by remember(state.configuration.manifestUrl) { mutableStateOf(state.configuration.manifestUrl) }
    var signatureUrl by remember(state.configuration.signatureUrl) { mutableStateOf(state.configuration.signatureUrl) }
    var password by remember { mutableStateOf("") }
    var certificateUri by remember { mutableStateOf<Uri?>(null) }
    var confirmingRemoval by remember { mutableStateOf(false) }
    val picker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri -> certificateUri = uri }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(18.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        item { Text("Settings", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
        item {
            SettingsCard("Linked machine") {
                OutlinedTextField(
                    value = codexUrl,
                    onValueChange = { codexUrl = it },
                    label = { Text("Relay machine URL") },
                    placeholder = { Text("https://your-relay-host.example") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = manifestUrl,
                    onValueChange = { manifestUrl = it },
                    label = { Text("Manifest URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = signatureUrl,
                    onValueChange = { signatureUrl = it },
                    label = { Text("Manifest signature URL") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                Button(
                    onClick = { viewModel.saveConfiguration(codexUrl, manifestUrl, signatureUrl) },
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("Save endpoints") }
            }
        }
        item {
            SettingsCard("Client certificate") {
                if (state.certificateSubject != null) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Default.CheckCircle, contentDescription = null, tint = Color(0xFF62D79B))
                        Spacer(Modifier.width(8.dp))
                        Column {
                            Text("Certificate available", fontWeight = FontWeight.Medium)
                            Text(
                                state.certificateSubject,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                    OutlinedButton(onClick = { confirmingRemoval = true }, modifier = Modifier.fillMaxWidth()) {
                        Text("Remove from this app")
                    }
                } else {
                    Text(
                        "Select the Relay PKCS#12 file. The file and passphrase are re-encrypted with an app-only Android Keystore key; the passphrase is never logged.",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = {
                            picker.launch(arrayOf("application/x-pkcs12", "application/pkcs12", "application/octet-stream"))
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text(if (certificateUri == null) "Choose .p12 file" else "Certificate selected") }
                    OutlinedTextField(
                        value = password,
                        onValueChange = { password = it },
                        label = { Text("Certificate passphrase") },
                        visualTransformation = PasswordVisualTransformation(),
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Button(
                        onClick = {
                            certificateUri?.let { viewModel.importIdentity(it, password) }
                            password = ""
                        },
                        enabled = certificateUri != null && password.isNotEmpty(),
                        modifier = Modifier.fillMaxWidth(),
                    ) { Text("Import certificate") }
                }
            }
        }
        item {
            Text(
                "Relay uses the valid client certificate as its private perimeter. Android does not claim that the certificate is hardware-bound to this phone.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        item {
            SettingsCard("About") {
                TextButton(onClick = { uriHandler.openUri("https://app.openrelay.sh/privacy") }) {
                    Text("Privacy Policy")
                }
                TextButton(onClick = { uriHandler.openUri("https://app.openrelay.sh/terms") }) {
                    Text("Terms of Use")
                }
                TextButton(onClick = { uriHandler.openUri("https://app.openrelay.sh/support") }) {
                    Text("Support")
                }
            }
        }
    }

    if (confirmingRemoval) {
        AlertDialog(
            onDismissRequest = { confirmingRemoval = false },
            title = { Text("Remove client certificate?") },
            text = { Text("Relay will stop accessing the private API and POCs until the certificate is imported again.") },
            confirmButton = {
                TextButton(onClick = { confirmingRemoval = false; viewModel.clearIdentity() }) { Text("Remove") }
            },
            dismissButton = { TextButton(onClick = { confirmingRemoval = false }) { Text("Keep") } },
        )
    }
}

@Composable
private fun SettingsCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
            content()
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WorkspaceSessionScreen(
    state: RelayUiState,
    onBack: () -> Unit,
    onOpenThread: (ThreadSummary) -> Unit,
    onSubmit: (String, RelayProvider, String?) -> Unit,
    onGrantAIDataConsent: (RelayProvider) -> Unit,
    onCancel: () -> Unit,
    onDecision: (Approval, String) -> Unit,
    onOpenArtifact: (JobArtifact) -> Unit,
    onOpenPreview: (String, String) -> Unit,
) {
    val workspace = requireNotNull(state.selectedWorkspace)
    var showingThreads by rememberSaveable { mutableStateOf(false) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var provider by rememberSaveable { mutableStateOf(RelayProvider.CODEX) }
    var pendingConsentPrompt by rememberSaveable { mutableStateOf<String?>(null) }
    var showingConsentReview by rememberSaveable { mutableStateOf(false) }
    var automaticallyPresentedConsentProviders by remember { mutableStateOf(emptySet<RelayProvider>()) }
    BackHandler(onBack = onBack)

    LaunchedEffect(provider, state.aiDataConsentProviders) {
        if (provider !in state.aiDataConsentProviders && provider !in automaticallyPresentedConsentProviders) {
            automaticallyPresentedConsentProviders = automaticallyPresentedConsentProviders + provider
            showingConsentReview = true
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(workspace.workspaceName ?: workspace.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("New session", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                actions = {
                    TextButton(onClick = { showingThreads = true }) {
                        Icon(Icons.Default.History, contentDescription = null)
                        Spacer(Modifier.width(5.dp))
                        Text("Threads")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            Composer(
                prompt = prompt,
                onPrompt = { prompt = it },
                provider = provider,
                availableProviders = availableProviders(state),
                providerLocked = false,
                onProvider = { provider = it },
                aiDataConsentGranted = provider in state.aiDataConsentProviders,
                onReviewAIDataSharing = { showingConsentReview = true },
                onSend = {
                    if (provider in state.aiDataConsentProviders) {
                        onSubmit(prompt, provider, defaultModel(state, provider))
                        prompt = ""
                    } else {
                        pendingConsentPrompt = prompt
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (state.selectedJob == null) {
                item {
                    EmptyConversation(
                        title = "What should Relay do?",
                        detail = "Start a task in ${workspace.workspaceName ?: workspace.displayName}. Progress and approvals stay visible here.",
                    )
                }
            } else {
                item { JobPanel(state, onCancel, onOpenArtifact, onOpenPreview) }
                items(state.approvals, key = Approval::id) { approval -> ApprovalCard(approval, onDecision) }
            }
        }
    }

    if (showingThreads) {
        ModalBottomSheet(onDismissRequest = { showingThreads = false }) {
            Column(Modifier.fillMaxWidth().padding(horizontal = 18.dp)) {
                Text("Threads", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                Text(
                    workspace.workspaceName ?: workspace.displayName,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Spacer(Modifier.height(12.dp))
            }
            LazyColumn(contentPadding = PaddingValues(bottom = 32.dp)) {
                items(state.threads, key = ThreadSummary::resolvedId) { thread ->
                    ThreadRow(thread) { showingThreads = false; onOpenThread(thread) }
                }
                if (state.threads.isEmpty()) item { EmptyState("No threads yet", "Start the first session below.") }
            }
        }
    }


    val pendingPrompt = pendingConsentPrompt
    if (pendingPrompt != null || showingConsentReview) {
        AIDataConsentDialog(
            provider = provider,
            isConsentGranted = provider in state.aiDataConsentProviders,
            sendsPromptAfterConsent = pendingPrompt != null,
            onAllow = {
                if (provider !in state.aiDataConsentProviders) onGrantAIDataConsent(provider)
                if (pendingPrompt != null) {
                    onSubmit(pendingPrompt, provider, defaultModel(state, provider))
                    prompt = ""
                }
                pendingConsentPrompt = null
                showingConsentReview = false
            },
            onCancel = {
                pendingConsentPrompt = null
                showingConsentReview = false
            },
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ConversationScreen(
    state: RelayUiState,
    onBack: () -> Unit,
    onSubmit: (String, RelayProvider, String?) -> Unit,
    onGrantAIDataConsent: (RelayProvider) -> Unit,
    onCancel: () -> Unit,
    onDecision: (Approval, String) -> Unit,
    onOpenArtifact: (JobArtifact) -> Unit,
    onOpenPreview: (String, String) -> Unit,
) {
    val detail = requireNotNull(state.selectedThread)
    val provider = detail.thread.provider
    var prompt by rememberSaveable(detail.thread.resolvedId) { mutableStateOf("") }
    var pendingConsentPrompt by rememberSaveable(detail.thread.resolvedId) { mutableStateOf<String?>(null) }
    var showingConsentReview by rememberSaveable(detail.thread.resolvedId) { mutableStateOf(false) }
    var automaticallyPresentedConsent by remember(detail.thread.resolvedId) { mutableStateOf(false) }
    BackHandler(onBack = onBack)

    LaunchedEffect(provider, state.aiDataConsentProviders) {
        if (provider !in state.aiDataConsentProviders && !automaticallyPresentedConsent) {
            automaticallyPresentedConsent = true
            showingConsentReview = true
        }
    }
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text(detail.thread.displayTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(
                            "${detail.thread.workspaceLabel} · ${provider.displayName}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
        bottomBar = {
            Composer(
                prompt = prompt,
                onPrompt = { prompt = it },
                provider = provider,
                availableProviders = listOf(provider),
                providerLocked = true,
                onProvider = {},
                aiDataConsentGranted = provider in state.aiDataConsentProviders,
                onReviewAIDataSharing = { showingConsentReview = true },
                onSend = {
                    if (provider in state.aiDataConsentProviders) {
                        onSubmit(prompt, provider, defaultModel(state, provider))
                        prompt = ""
                    } else {
                        pendingConsentPrompt = prompt
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            items(detail.messages, key = { "${it.normalizedRole}-${it.timestamp}-${it.displayText}" }) { message ->
                MessageBubble(message.normalizedRole, message.displayText)
            }
            state.selectedJob?.let {
                item { JobPanel(state, onCancel, onOpenArtifact, onOpenPreview) }
                items(state.approvals, key = Approval::id) { approval -> ApprovalCard(approval, onDecision) }
            }
        }
    }


    val pendingPrompt = pendingConsentPrompt
    if (pendingPrompt != null || showingConsentReview) {
        AIDataConsentDialog(
            provider = provider,
            isConsentGranted = provider in state.aiDataConsentProviders,
            sendsPromptAfterConsent = pendingPrompt != null,
            onAllow = {
                if (provider !in state.aiDataConsentProviders) onGrantAIDataConsent(provider)
                if (pendingPrompt != null) {
                    onSubmit(pendingPrompt, provider, defaultModel(state, provider))
                    prompt = ""
                }
                pendingConsentPrompt = null
                showingConsentReview = false
            },
            onCancel = {
                pendingConsentPrompt = null
                showingConsentReview = false
            },
        )
    }
}

@Composable
private fun AIDataConsentDialog(
    provider: RelayProvider,
    isConsentGranted: Boolean,
    sendsPromptAfterConsent: Boolean,
    onAllow: () -> Unit,
    onCancel: () -> Unit,
) {
    val uriHandler = LocalUriHandler.current
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("Share work content with ${RelayAIDataSharing.recipient(provider)}?") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(RelayAIDataSharing.disclosure(provider))
                Text(
                    "Relay does not share your Relay name, email, password, device identifiers, or payment and subscription details with this AI provider. You can decline and nothing will be sent.",
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (isConsentGranted) {
                    Text(
                        "Permission is currently allowed for this provider.",
                        color = MaterialTheme.colorScheme.primary,
                    )
                }
                TextButton(onClick = { uriHandler.openUri("https://app.openrelay.sh/privacy") }) {
                    Text("Read Privacy Policy")
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onAllow) {
                Text(
                    when {
                        isConsentGranted -> "Done"
                        sendsPromptAfterConsent -> "Allow & Send"
                        else -> "Allow"
                    },
                )
            }
        },
        dismissButton = {
            if (!isConsentGranted) TextButton(onClick = onCancel) { Text("Not Now") }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun JobDetailScreen(
    state: RelayUiState,
    onBack: () -> Unit,
    onCancel: () -> Unit,
    onDecision: (Approval, String) -> Unit,
    onOpenArtifact: (JobArtifact) -> Unit,
    onOpenPreview: (String, String) -> Unit,
) {
    val job = requireNotNull(state.selectedJob)
    BackHandler(onBack = onBack)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(job.displayPrompt, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
            )
        },
    ) { padding ->
        LazyColumn(
            Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { JobPanel(state, onCancel, onOpenArtifact, onOpenPreview) }
            items(state.approvals, key = Approval::id) { approval -> ApprovalCard(approval, onDecision) }
        }
    }
}

@Composable
private fun Composer(
    prompt: String,
    onPrompt: (String) -> Unit,
    provider: RelayProvider,
    availableProviders: List<RelayProvider>,
    providerLocked: Boolean,
    onProvider: (RelayProvider) -> Unit,
    aiDataConsentGranted: Boolean,
    onReviewAIDataSharing: () -> Unit,
    onSend: () -> Unit,
) {
    Surface(color = MaterialTheme.colorScheme.surface, tonalElevation = 4.dp) {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                availableProviders.forEach { option ->
                    FilterChip(
                        selected = option == provider,
                        onClick = { if (!providerLocked) onProvider(option) },
                        label = { Text(option.displayName) },
                        enabled = !providerLocked || option == provider,
                    )
                }
            }
            if (providerLocked) {
                Text(
                    "Provider is locked for this thread. Start a new session to switch.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(
                onClick = onReviewAIDataSharing,
                modifier = Modifier.fillMaxWidth(),
            ) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("AI data sharing", fontWeight = FontWeight.SemiBold)
                        Text(
                            "Work content to ${RelayAIDataSharing.recipient(provider)}",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Text(if (aiDataConsentGranted) "Allowed" else "Review")
                    Spacer(Modifier.width(4.dp))
                    Icon(Icons.Default.ChevronRight, contentDescription = null)
                }
            }
            Row(verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(
                    value = prompt,
                    onValueChange = onPrompt,
                    placeholder = { Text("Message ${provider.displayName}") },
                    modifier = Modifier.weight(1f),
                    minLines = 1,
                    maxLines = 5,
                )
                Spacer(Modifier.width(8.dp))
                IconButton(onClick = onSend, enabled = prompt.isNotBlank()) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "Run", tint = if (prompt.isNotBlank()) RelayRed else Color.Gray)
                }
            }
        }
    }
}

@Composable
private fun ThreadRow(thread: ThreadSummary, onOpen: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onOpen).padding(horizontal = 18.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Default.History, contentDescription = null, tint = if (thread.hasActiveJobs) RelayRed else MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(thread.displayTitle, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${thread.provider.displayName} · ${thread.preview}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Icon(Icons.Default.ChevronRight, contentDescription = null)
    }
}

@Composable
private fun JobPanel(
    state: RelayUiState,
    onCancel: () -> Unit,
    onOpenArtifact: (JobArtifact) -> Unit,
    onOpenPreview: (String, String) -> Unit,
) {
    val job = requireNotNull(state.selectedJob)
    val output = job.displayOutput ?: state.streamState.stdout.takeIf(String::isNotBlank)
    val previewSources = remember(job.resolvedId, output, state.streamState.stdout) {
        RelayLocalPreviewUrls.extract(listOfNotNull(output, state.streamState.stdout).joinToString("\n")).take(4)
    }
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StatusDot(job)
                Spacer(Modifier.width(9.dp))
                Text(job.resolvedStatus.label, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.weight(1f))
                Text(job.provider.displayName, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(job.displayPrompt, style = MaterialTheme.typography.titleMedium)
            if (output != null) {
                SelectionContainer {
                    Text(RelayLocalPreviewUrls.hidingEndpoints(output), style = MaterialTheme.typography.bodyMedium)
                }
            }
            if (state.streamState.stderr.isNotBlank()) {
                SelectionContainer {
                    Text(
                        state.streamState.stderr,
                        style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
            if (state.streaming) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Following live execution", style = MaterialTheme.typography.bodySmall)
                }
            }
            job.artifacts.forEach { artifact ->
                val viewerKind = RelayArtifactPresentation.kind(
                    filename = artifact.filename,
                    contentType = artifact.contentType,
                    artifactKind = artifact.kind,
                    hasPreview = artifact.previewURL != null,
                )
                AssistChip(
                    onClick = { onOpenArtifact(artifact) },
                    label = { Text("${artifact.title ?: artifact.filename} · ${viewerKind.wireValue}") },
                    leadingIcon = { Icon(Icons.Default.Description, contentDescription = null) },
                )
            }
            previewSources.forEach { sourceUrl ->
                AssistChip(
                    onClick = { onOpenPreview(job.resolvedId, sourceUrl) },
                    label = { Text("Show app") },
                    leadingIcon = { Icon(Icons.Default.Apps, contentDescription = null) },
                )
            }
            if (job.resolvedStatus.isActive) {
                OutlinedButton(onClick = onCancel, modifier = Modifier.fillMaxWidth()) {
                    Icon(Icons.Default.Cancel, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("Cancel task")
                }
            }
        }
    }
}

@Composable
private fun ApprovalCard(approval: Approval, onDecision: (Approval, String) -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = Color(0xFF33251F))) {
        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(9.dp)) {
            Text(approval.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            approval.reason?.let { Text(it) }
            approval.command?.let {
                SelectionContainer {
                    Text(
                        it,
                        modifier = Modifier.fillMaxWidth().background(Color.Black.copy(alpha = 0.35f), RoundedCornerShape(8.dp)).padding(10.dp),
                        fontFamily = FontFamily.Monospace,
                    )
                }
            }
            approval.cwd?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = { onDecision(approval, "accept") }, modifier = Modifier.weight(1f)) { Text("Allow") }
                OutlinedButton(onClick = { onDecision(approval, "decline") }, modifier = Modifier.weight(1f)) { Text("Decline") }
            }
            if ("acceptForSession" in approval.availableDecisions) {
                TextButton(onClick = { onDecision(approval, "acceptForSession") }, modifier = Modifier.fillMaxWidth()) {
                    Text("Allow for this session")
                }
            }
        }
    }
}

@Composable
private fun MessageBubble(role: String, text: String) {
    val user = role == "user"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Surface(
            color = if (user) RelayRed.copy(alpha = 0.22f) else MaterialTheme.colorScheme.surfaceVariant,
            shape = RoundedCornerShape(14.dp),
            modifier = Modifier.fillMaxWidth(0.9f),
        ) {
            SelectionContainer { Text(text, Modifier.padding(13.dp)) }
        }
    }
}

@Composable
private fun EmptyConversation(title: String, detail: String) {
    Column(
        Modifier.fillMaxWidth().padding(vertical = 72.dp, horizontal = 20.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        RelayMark()
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun EmptyState(title: String, detail: String) {
    Column(
        Modifier.fillMaxWidth().padding(32.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        Text(detail, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@SuppressLint("SetJavaScriptEnabled")
@Composable
private fun RelayWebView(
    url: String,
    title: String,
    errorTitle: String,
    identityStore: com.parikshit.relay.security.AndroidClientIdentityStore,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val expectedOrigin = remember(url) { url.toUri() }
    val expectedHost = expectedOrigin.host
    val identity = remember(url) { runCatching { identityStore.loadIdentity() }.getOrNull() }
    var loadError by remember { mutableStateOf<String?>(null) }
    var webView by remember { mutableStateOf<WebView?>(null) }
    BackHandler {
        if (webView?.canGoBack() == true) webView?.goBack() else onBack()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Close") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Black.copy(alpha = 0.72f)),
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { appContext ->
                    WebView(appContext).apply {
                        webView = this
                        // Hosted previews commonly require JavaScript. The catalog signature
                        // does not verify downloaded web content; file/content access and mixed
                        // content remain off, and client identity stays scoped to the origin.
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = true
                        settings.allowFileAccess = false
                        settings.allowContentAccess = false
                        settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
                        webViewClient = object : WebViewClient() {
                            override fun onReceivedClientCertRequest(view: WebView, request: ClientCertRequest) {
                                if (
                                    request.host.equals(expectedHost, ignoreCase = true) &&
                                    request.port == effectivePort(expectedOrigin) &&
                                    identity != null
                                ) {
                                    request.proceed(identity.privateKey, identity.certificates.toTypedArray())
                                } else {
                                    request.cancel()
                                }
                            }

                            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                val destination = request.url
                                if (sameOrigin(destination, expectedOrigin)) return false
                                context.startActivity(Intent(Intent.ACTION_VIEW, destination))
                                return true
                            }

                            override fun onReceivedError(
                                view: WebView,
                                request: WebResourceRequest,
                                error: android.webkit.WebResourceError,
                            ) {
                                if (request.isForMainFrame) loadError = error.description?.toString() ?: "The preview could not be loaded."
                            }
                        }
                        loadUrl(url)
                    }
                },
            )
            loadError?.let {
                Card(Modifier.align(Alignment.Center).padding(24.dp)) {
                    Column(Modifier.padding(18.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(errorTitle, fontWeight = FontWeight.Bold)
                        Text(it)
                    }
                }
            }
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            webView?.stopLoading()
            webView?.destroy()
        }
    }
}

private fun availableProviders(state: RelayUiState): List<RelayProvider> {
    val fromModels = state.models.filter { "task" in it.modes || it.modes.isEmpty() }.map(ModelDescriptor::provider).distinct()
    return fromModels.ifEmpty {
        listOf(RelayProvider.CODEX, RelayProvider.CLAUDE, RelayProvider.CURSOR, RelayProvider.KIMI)
    }
}

private fun defaultModel(state: RelayUiState, provider: RelayProvider): String? =
    state.models.firstOrNull { it.provider == provider && ("task" in it.modes || it.modes.isEmpty()) }?.taskModel

private fun artifactUrl(artifact: JobArtifact, baseUrl: String): String? {
    val value = artifact.previewURL ?: artifact.rawURL ?: return null
    return resolvedArtifactUrl(value, baseUrl)
}
