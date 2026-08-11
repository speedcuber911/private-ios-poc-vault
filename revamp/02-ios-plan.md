# Track I — iOS Plan

> **Status (2026-08-11): implemented.** This document retains the original
> baseline and milestone plan for traceability. The resulting current behavior
> is summarized in [../docs/FILES_REDESIGN.md](../docs/FILES_REDESIGN.md),
> including the visible Threads row, stable full-log sheet, and outside-tap
> keyboard dismissal without a custom accessory.

All work in `ios/POCVault`. **Mechanical constraint:** classic pbxproj (objectVersion 56, not folder-synced) — every added/removed file needs 4 hand edits (PBXBuildFile, PBXFileReference, group child, Sources phase), continuing the existing `1000…/2000…` ID convention. Build after every registration. Net change across milestones: +8 files, −2 files.

Updated 2026-08-09 for the live `pariksj-dev` backend at
`https://relay.65-2-161-233.sslip.io`. The app must keep using its imported mTLS
identity; it must not gain Tailscale routing or receive Codex, Claude, Cursor, or
Azure credentials. Provider auth and Azure bearer-key files remain server-side.

The live catalog now has exactly seven entries: Codex GPT-5.6 Sol/Terra/Luna in
both chat and task modes, Cursor Auto in task mode, and Claude
Sonnet/Opus/Haiku in task mode. Cursor Auto has already completed through the
live API and as a physical-iPhone Relay Task with its result displayed. Direct
Claude CLI and Relay API jobs have succeeded for all three Claude aliases.
Azure support is coded but contributes no rows until the exposed keys are
rotated and their replacements are installed server-side.

The Library baseline is also live on the same host: the support config points
to the signed five-item `/manifest.json`, contains its matching manifest public
key, and opens POCs from `/pocs/<slug>/`. Both manifest and POC pages require the
same imported identity. The revamp must not synthesize wildcard POC hosts.

**Verified baseline:**

- `POCVaultApp.swift:73` — TabView with 4 tabs (`RelayRootTab` enum :138, private). App struct constructs two `RelayChatViewModel`s (lockedMode `.chat`/`.task`) and two dead `CodexConsoleViewModel`s; the Status tab + `monitorActiveWorkWhileAppIsOpen()` loops are the console VMs' only live consumers. `AppTheme` tokens :435-485; `Color(hex:)` private to this file; `AppConfiguration` :497.
- `RelayChatView.swift` (1589 ln) uses exactly three console-defined symbol groups: `CodexMarkdownParser`/`CodexInlineMarkdown` (+ `CodexMarkdownSegment`/`CodexMarkdownProseBlock`) and `CodexPromptAudioRecordingConfiguration`. `CodexControlStripLayout` is dead-only. `CodexModels.swift:641` also calls `CodexMarkdownParser.plainText(from:)`.
- `CodexLocalNotificationService`, `CodexAgentMonitorPolicy` (inside `CodexConsoleViewModel.swift`) are used by the App struct; `RelayChatViewModel.swift:445` calls `CodexConsoleViewModel.isCancellation(...)`. All must be extracted before deletion.
- `CodexWorkspaceDirectoryEntry` (CodexModels.swift:137) has lenient custom decoding with defaults — the pattern to extend for back-compat.
- `CodexClient.fetchWorkspaceDirectories(path:query:)` already supports the recursive-search `q` param; only the dead `CodexWorkspacePickerSheet` (CodexConsoleView.swift:1659) uses it — harvest the search UX.
- Tests: `ManifestTests.swift` (2562 ln, 93 tests); ~12 read view SOURCE TEXT via `#filePath` and assert literal substrings — they break on redesign and each milestone rewrites its own casualties so CI never sits red between PRs.

## Architecture decisions

**Navigation.** Replace the TabView with a single `NavigationStack(path:)` rooted in a new `FileBrowserView` at the workspace root. A `BrowserRoute` enum (`.folder(path: String)`, `.file(entry: CodexWorkspaceDirectoryEntry)`) drives `navigationDestination`. Library and Status/Diagnostics move to a root-only toolbar ellipsis `Menu` — Library as `fullScreenCover` (it embeds its own NavigationStack; nesting stacks is illegal) and keeps using the live signed same-host manifest/POC URLs; Status/Diagnostics as a `sheet`. **Chat presents as `fullScreenCover`** from a terminal toolbar icon available on every folder screen — keeps the chat's self-drawn top bar, isolates keyboard/composer layout from the nav stack, preserves back-swipe on the browser.

**Per-folder chat state.** New `RelayChatSessionStore: ObservableObject` owned by the App struct: dictionary of `RelayChatViewModel` keyed by canonical folder path/workspaceId. Opening a terminal returns the cached VM or creates one (lazy `POST /workspaces/select` on first send for unregistered folders). Eviction: LRU cap ~6, VMs with `isStreaming` or an active job pinned. Dismissing the cover does NOT cancel streams — streams are VM-owned. The store also runs the **single app-wide job monitor loop** (2 s across all cached VMs), replacing the Task-tab-visibility-tied monitor and both console monitors, and feeds `CodexLocalNotificationService` — **completion notifications must move here or they silently disappear with the console VMs.**

**Mode removal.** `lockedMode` and the composer-wide mode toggle die, but the
interaction mode must remain explicit in the selected picker row. Introduce a
`RelayModelChoice` containing a server model plus `.chat` or `.task`:

- **Agents** rows choose task mode: Codex GPT-5.6 Sol/Terra/Luna, Claude Code,
  and live-verified Cursor Agent entries.
- **Chat models** rows choose chat mode: Codex GPT-5.6 Sol/Terra/Luna and any
  future live-verified Azure entries (none currently).

A dual-mode Codex descriptor appears in both sections with a different choice
mode; this avoids the stale `supports(.task) → job` rule that made Codex chat
unreachable. Bedrock is absent while SigiQ is unconfigured. Missing or failed
providers produce no rows instead of disabled credential prompts.

---

## I0 — Extraction refactor (pure code motion, no behavior change)

1. `Rendering/CodexMarkdown.swift` ← `CodexMarkdownParser` (CodexConsoleView.swift:4996), `CodexInlineMarkdown` (:5283), `CodexMarkdownSegment` (:4986), `CodexMarkdownProseBlock` (:4973), verbatim.
2. `Services/CodexAppServices.swift` ← `CodexLocalNotificationService`, `CodexCompletionNotifying`, `CodexAgentMonitorPolicy`, freestanding `isCancellation(_:)` (retarget RelayChatViewModel.swift:445).
3. `Audio/CodexPromptAudioRecordingConfiguration.swift` ← struct from CodexConsoleView.swift:1019.
4. pbxproj: 3 registrations. Existing tests still pass (console file still present).

## I1 — Models + client (develops against S1 fixtures immediately)

1. `CodexModels.swift`:
   - `CodexWorkspaceDirectoryEntry` += `kind: Kind` (`enum Kind: String { case dir, file }`, decode-default `.dir`), `size: Int64?`, `mtime: Date?`, `mime: String?`, `isText: Bool?`, `readDenied: Bool` (default false). Helpers: `isDirectory`, `sizeLabel` (ByteCountFormatter), `mtimeLabel`, `fileCategory` (code/text/markdown/image/pdf/binary from mime+extension).
   - Listing += `truncated: Bool` (default false), `total: Int?`, `offset/limit`.
   - Keep the already-added `.cursor` provider decoding (`"cursor"` and
     `"cursor-agent"`) and add only any missing dedicated icon/tint treatment.
   - Add `RelayModelChoice(model:mode:)` and make its identity include both the
     model id and mode so dual-mode Codex rows do not collide.
   - `CodexChatRequest` (CodexClient.swift:35) += `workspaceId: String?`.
2. `CodexClient.swift`:
   - `fetchDirectory(path:offset:limit:)` → `GET /v1/codex/fs/list`.
   - `fetchFile(path:range:)` → `GET /v1/codex/fs/file`, returning `(data, contentType, truncated)` — needs a `perform` variant that returns `(Data, HTTPURLResponse)`; truncation read from the 206/`Content-Range` response, not inferred from byte counts.
   - `streamJobEvents(id:stdoutOffset:)` → jobs SSE as `AsyncThrowingStream<CodexJobStreamEvent>` (`.status`, `.stdout(offset,text)`, `.stderr`, `.done(job)`) — generalize `CodexSSELineParser` by injecting the decode step instead of hardcoding `decodeSSE`; `onTermination` cancels (same pattern as `streamChat`).
3. Fixture server: file entries in listings, fs/file bytes (text/markdown/image/>1 MiB), job-stream SSE, cursor model, `workspaceId` filter on `/threads`.
4. Unit tests: entry decoding with/without new fields, truncation flag, existing
   Cursor provider round-trip, dual-mode model choices, job stream event decode,
   and file-category inference. Assert that no provider credential field is
   decoded from or expected in `/models`.

## I2 — File browser becomes the app root

1. New `Browser/FileBrowserView.swift` + `Browser/FileBrowserViewModel.swift` (plain ObservableObject, one per pushed screen via `@StateObject`): holds one listing; load/refresh/search/createFolder/error state.
   - UI: nav title = folder name; rows = icon tile (folder / git-branch / per-type file glyph), name, subtitle `size · mtime` for files, workspace badge for registered dirs — harvest `RelayFolderRow` styling flattened into full-width rows with hairline dividers on `AppTheme.canvasGradient` for the Files-app feel.
   - `.searchable` with debounced server-backed `q` (harvest from dead `CodexWorkspacePickerSheet`), pull-to-refresh, truncation banner row (+ "load more" paging), empty state, "New folder" (reuse `RelayWorkspaceSheet` createRow pattern) in a toolbar menu.
   - Context menus: folder → Open chat here / Copy path; file → View / Copy path. `readDenied` files greyed.
   - Toolbar: terminal icon (chat cover for this folder); root-only ellipsis (Library / Status / Diagnostics).
2. `POCVaultApp.swift`: swap TabView → `NavigationStack(path:)` + `BrowserRoute`; delete `RelayRootTab`; keep `AppTheme`/`AppConfiguration`; make `Color(hex:)` internal. Replace 4 VM instances with `RelayChatSessionStore` + a lightweight `StatusFeedViewModel` (fetches threads/jobs app-wide for the Activity list, replacing the console VMs' `threadFeedItems`); rewire `CodexStatusView`; `DiagnosticsView`/`LibraryView` unchanged apart from presentation. Job monitoring starts from a root `.task` via the store, still guarded by `CodexAgentMonitorPolicy`.
3. New `Views/RelayChatSessionStore.swift` (cache, pinning, monitor loop, notification wiring).
4. Chat opens via `fullScreenCover(item:)` with minimal `RelayChatView` adaptation this milestone (construct/lookup VM, pre-set workspace, add dismiss chevron); full rework in I4.
5. DEBUG hooks: delete `RELAY_UITEST_TAB`; add `RELAY_UITEST_PATH` (push to folder), `RELAY_UITEST_FILE`, `RELAY_UITEST_CHAT=1` (open cover, then existing MODEL/PROMPT/TASK_PROMPT auto-drive), `RELAY_UITEST_OPEN=library|status`.
6. pbxproj: 3 registrations. Tests: rewrite the tab-structure source-text assertions; add store-eviction unit tests.

## I3 — File viewer

New `Browser/FileViewerView.swift` (+ small VM), switching on `fileCategory`:
- **Text/code**: mono `Text` in ScrollView (pattern from `RelayFullLogSheet` :1506), toolbar wrap toggle (wrap = vertical scroll; no-wrap = horizontal ScrollView), byte-cap truncation banner with "load more" via Range requests.
- **Markdown**: promote `RelayMarkdownText`/`RelayMarkdownProse`/`RelayCodeBlock`/`RelayMarkdownTable` out of `private` in RelayChatView.swift into `Rendering/RelayMarkdownViews.swift` (shared with chat; pbxproj entry); Raw/Rendered toggle.
- **Images**: `Image(uiImage:)` fit-width (pinch-zoom later).
- **PDF/HTML**: `AuthenticatedWebView` pointed at the file URL (mTLS already handled).
- **Binary fallback**: file-icon placeholder + ShareLink (bytes via temp file).
Toolbar: Copy path, Share, toggles. Add `.file` handling to `BrowserRoute`. Tests: type-routing units; fixture files in the simulator flow.

## I4 — Per-folder chat rework

1. `RelayChatViewModel.swift`:
   - `init(client:workspaceID:workspacePath:)`; delete `lockedMode`, published `mode`, the `"poc-vault"` fallback (`composeWorkspaceID` :371, `ensureSelectedWorkspace` :842), and the VM's workspace browse/create section (:502-547 — browser owns it).
   - `sendCurrentPrompt()` branches on `selectedChoice.mode`; `sendChat()` passes
     `workspaceId`, while `runTask()` keeps the provider+workspace resume guard
     (workspace now constant). After task creation, attach
     `client.streamJobEvents(id:)`, append stdout/stderr live, and retain 2 s
     polling as fallback when the stream errors.
   - Threads: fetch up to 200 workspace-scoped threads and jobs; a visible row
     below the header opens this folder's combined, flat recency list with mode
     badges. Include standalone invocations, de-duplicate jobs represented by a
     thread, and keep DELETE for resumable threads.
   - Keep the already-added `.cursor → .cursor` task mapping. Effort remains
     model-driven via `effortLevels` and is hidden when empty.
   - `RelayModelDiscovery.sections` returns Agents/Chat models choices. Codex
     Sol/Terra/Luna appear in both; Claude/Cursor only in Agents; Azure only in
     Chat models; Bedrock appears only if the server actually advertises it.
2. `RelayChatView.swift`:
   - Top bar: folder name + model label and dismiss chevron; place the large,
     labelled Threads row immediately below it so history is discoverable.
   - `RelayComposer`: remove mode toggle + workspace chip; effort menu moves beside the model chip, shown only when `availableEfforts` non-empty; send icon `arrow.up` always.
   - Delete `RelayWorkspaceSheet` + `RelayFolderRow` + `showingOptions` sheet + `RELAY_UITEST_OPEN=workspace` (superseded by browser + `RELAY_UITEST_PATH`).
   - `RelayJobCard`: live autoscrolling mono tail while active (SSE-fed); keep cancel/full-log.
   - Preserve `.scrollDismissesKeyboard(.interactively)`, Send/Run dismissal,
     and outside-tap dismissal on non-editor content. Do not add a custom
     keyboard accessory or let the outside-tap gesture intercept composer taps.
   - Present `View full log` from a request object with stable identity; load
     inside the sheet so asynchronous fetching cannot immediately dismiss it.
3. First send in an unregistered folder: lazy `selectWorkspace(path:)`; failure → composer error banner, prompt text preserved.
4. Tests: rewrite the two RelayChatView source-text tests (markdown one repoints to `Rendering/RelayMarkdownViews.swift`); delete workspace-sheet assertions; add units proving a dual-mode Codex model can select either chat or task, plus Cursor task and Azure chat routing.

## I5 — Dismantle dead code

1. Delete `CodexConsoleView.swift` (5326 ln) + `CodexConsoleViewModel.swift` (I0 rescued live symbols; I2 removed last instantiations). Optional pre-deletion harvest (deferred, tracked as follow-up): artifact preview rows (`CodexArtifactsBlock`/`CodexArtifactRow` :4408-4570), attachments pickers.
2. `CodexModels.swift`: grep-verify then delete console-only types (`CodexThreadChatItem`, `CodexThreadDetailLayout`, `CodexPendingFollowUp`, `CodexRunMode`, skills types…); `CodexJobAttachment`/`CodexJobArtifact` stay (jobs API round-trips them).
3. pbxproj removals for both files.
4. Tests: delete ~10 console source-text tests + ~24 console-type references; port any that assert model decoding.

## I6 — Verification & tooling

1. `ios/launch-simulator.sh`: no structural change (SIMCTL_CHILD_* passthrough works); document the new hook matrix. Screenshot recipes: root browser, folder with files, viewer (text/markdown/image), chat cover streaming, job card streaming, Library/Status menu.
2. Full simulator pass against fixtures; device pass against `pariksj-dev` once
   Track S lands. Preserve the existing physical-iPhone Cursor Auto success as a
   regression case. The device matrix must show the seven live entries, show
   Sol/Terra/Luna in both picker sections, and complete a Codex chat/task plus
   direct Claude and Cursor tasks. Add Azure chat to this matrix only after key
   rotation, server-side installation, and live route verification.
   Graceful degradation if server lags: `kind` defaults `.dir`, fs endpoints 404
   produce an error banner, and unavailable providers simply disappear.
3. On the physical device, verify the signed five-item Library manifest and a
   representative same-host `/pocs/<slug>/` page load with the imported
   identity. Verify the matching public key remains in support config and never
   construct a wildcard POC URL.

## Risks & edge cases

- **SSE lifecycle**: cover dismissal keeps VM-owned streams alive; backgrounding kills URLSession streams → reconcile job state via polling on foreground; chat streams detect termination and finalize via existing `stopStreaming` path.
- **VM cache memory**: LRU + pinning; cap retained message history on eviction candidates; evicted chats reload from `threads?workspaceId=`.
- **Thread identity**: subfolder chats have distinct histories from parent folders (by design — note in drawer empty state).
- **pbxproj hand-editing**: top mechanical risk; build after every registration.
- **Test sequencing**: each milestone rewrites its own source-text-test casualties; CI never red between PRs.
- **iPad later**: single NavigationStack ports to NavigationSplitView; avoid hardcoded iPhone widths in browser rows.
- **State restoration**: v1 restores nothing; optional `@SceneStorage("browserPath")` re-push as a cheap I6 add.
- **Dual-mode ambiguity**: never infer chat versus task from a descriptor merely
  supporting task; preserve the explicit `RelayModelChoice.mode` through
  selection, thread continuation, and UI tests.
- **Provider honesty**: the app consumes the server catalog as capability truth.
  It must not synthesize Bedrock, Cursor, Claude, or Azure entries locally.
