# Relay Chat-First Redesign

This document describes the chat-first redesign of the Relay iOS surface and the
supporting server/ops changes: model-catalog de-duplication, the split Chat/Task
tabs, streaming chat, task-model and effort controls, live task progress, workspace-
grouped threads, and the reimagined workspace picker. It is the authoritative
reference for what the redesign added and how to exercise it.

Legacy naming still applies: the repo is `poc-vault`/`POCVault` with bundle id
`com.parikshit.pocvault`; the user-facing product is **Relay**.

---

## 1. Overview

Relay's operator surface is now **chat-first** with two distinct modes living on
**separate bottom tabs** instead of one screen with a mode toggle:

- **Chat** — synchronous, streaming replies from Bedrock/Azure models over
  `POST /v1/codex/chat` (Server-Sent Events).
- **Task** — the asynchronous Codex/Claude Code job runner (`POST /v1/codex/jobs`),
  with model and reasoning-effort selection plus live status polling.

The four bottom tabs are: **Library · Chat · Task · Status**.

Each of Chat and Task owns its own conversation history, model selection, and (for
Task) workspace selection, via two mode-locked instances of the same view model.

---

## 2. Model catalog de-duplication

### Problem

The catalog is rendered from the user's OpenCode config
(`~/.config/opencode/opencode.jsonc`). Azure exposes the *same* model id (e.g.
`gpt-4o`) across many deployments (GRE Dev, GRE Prod, O-Series Prod, Padhai*, …), so
the picker previously listed one row per `deployment × model` — `gpt-4o` appeared six
times, `o1` five times, etc.

### Fix

Both catalog renderers now collapse Azure entries to **one visible entry per model
id**, keeping the highest-priority deployment and hiding the rest. The winning
deployment's full id (`<provider_id>/<model_id>`) is retained so the server still
routes to the correct `baseURL`/key; the label is normalized to `"<model> (Azure)"`.

- **VM renderer:** `ops/render-codex-api-config` → `catalog_from_opencode()`. Output
  goes into `CODEX_MODEL_CATALOG` in `/etc/codex-api.env` (requires a redeploy via
  `ops/install-codex-api.sh` to take effect on the EC2 host).
- **Local simulator:** `ops/serve-simulator-poc-vault` → `opencode_fixture_models()`,
  mirrors the same logic for the iOS Simulator preview server.

**Deployment priority** (`azure_deployment_rank`): a provider id containing `prod`
beats a neutral one, which beats one containing `dev`; ties fall back to the order the
provider appears in `opencode.jsonc`. Examples from the current config:

| Model id | Winning deployment |
|---|---|
| `gpt-4o` | `azure-gre-prod` |
| `gpt-5`  | `azure-gre-prod` |
| `o1`     | `azure-o-series-prod` |

**Label cleanup** (`azure_model_label`): a trailing `(...)` alias embedded in the
OpenCode model name is stripped before appending `(Azure)`, so
`o1-mini (o4-mini)` renders as `o1-mini (Azure)` rather than double-parens.

Bedrock model ids are globally unique, so they are not de-duplicated. The result for
the current config is **31 unique Azure models + 6 Bedrock models** (was ~70 Azure
rows before).

### App-side picker

`RelayModelDiscovery` (`RelayChatViewModel.swift`) drives the picker sheet:

- **Chat / All** — groups by provider and lists the (now de-duplicated) catalog.
- **Chat / Latest** — de-dupes by `familyKey`, which now keys on the model's own
  identity (only folding away dated/version-pinned build suffixes like
  `-20251101-v1:0`), so genuinely distinct models (`gpt-5` vs `gpt-5-chat`, or two
  Opus minor versions) each survive instead of collapsing to one family row.
- **Task** — skips the Chat-only Latest/All toggle and shows the complete, compact
  provider-grouped task catalog.

### Task catalog entries

`task_catalog_entries()` adds selectable Codex CLI and Claude Code models to both
the rendered VM catalog and simulator fixtures. A task entry can expose `taskModel`,
the model id or alias Relay sends in `POST /v1/codex/jobs`; the server sanitizes and
returns this public field from `GET /v1/codex/models`. Entries without `taskModel`
continue to use the runner default.

Codex task entries advertise `low`, `medium`, `high`, and `xhigh` effort levels.
Claude task entries keep their provider-specific model aliases (`sonnet`, `opus`,
and `haiku`) in the same server-driven catalog, so the app does not compile them into
its native picker.

---

## 3. Tabs: split Chat and Task

`POCVaultApp.swift` now builds **four** tabs (`RelayRootTab`: `library`, `chat`,
`task`, `status`). Two `RelayChatViewModel` instances back the chat surfaces:

```swift
RelayChatViewModel(client: codexClient, lockedMode: .chat)   // Chat tab
RelayChatViewModel(client: codexClient, lockedMode: .task)   // Task tab
```

`lockedMode` (`RelayChatViewModel`) fixes a view model to one mode:

- `mode` is set at init and never changes (`openThread` no longer reassigns it).
- `visibleThreads` filters the thread drawer to that mode (the Chat tab hides Task
  threads and vice versa).
- `openThread` refuses to open a thread of the other mode.
- The composer's Chat/Task segmented toggle is hidden (`showsModeToggle == false`).
- The header title shows "Chat" or "Task" instead of "Relay".

The old `CodexConsoleView`/`CodexConsoleViewModel` remain only behind the **Status**
tab for monitoring; they are not part of the chat surface.

---

## 4. Streaming chat experience

`RelayChatView.swift` + `RelayChatViewModel.swift`.

### Streaming state

`RelayConversationItem` gained `isStreaming`, `usage` (`RelayUsage`), and
`elapsedSeconds`. `RelayChatViewModel` exposes:

- `streamingMessageID` — the assistant message currently streaming (nil when idle).
- `isStreaming` — convenience flag.
- `stopStreaming()` — cancels the in-flight SSE task and finalizes the message.

`sendChat()` runs the SSE loop inside a tracked `streamTask` so it can be cancelled.
It captures the server's `usage` event (input/output tokens) and stamps wall-clock
`elapsedSeconds` when the stream completes (both previously discarded).

### UI behavior

- **Typing dots** (`RelayTypingDots`) animate in the assistant bubble before the first
  token arrives.
- **Blinking caret** (`RelayStreamingContent`) trails the text while it streams.
- **Auto-follow scroll** — the message list scrolls to a bottom anchor as the
  streaming text grows (keyed on `streamingTextLength`, not just message count, which
  fixed the prior "scroll doesn't follow during stream" bug).
- **Stop button** — the composer's send button becomes a stop button while streaming;
  tapping it calls `stopStreaming()`.
- **Scroll-to-bottom button** — a floating glass button appears while streaming if you
  scroll up.
- **Usage/timing footer** — `"<in> in · <out> out  ·  <secs>s"` under finished
  assistant replies.
- **Long-press copy** — context menu on any bubble copies its text (with a "Copied"
  flash + success haptic).
- **Haptics** — medium impact on send, rigid on stop, selection on workspace pick.

### Visual pass

New `AppTheme` tokens (`POCVaultApp.swift`): `accentBright`, `accentDeep`,
`accentGradient`, `canvasGradient`, `userBubbleGradient`, `glassTint`, `glassStroke`,
`shadowColor`. Applied across: canvas gradient background, gradient brand/assistant
avatars, gradient user bubbles with shadow, glassy composer (`.ultraThinMaterial`),
gradient send/stop buttons, and a centered gradient-icon empty state.

---

## 5. Task execution experience

`RelayChatView.swift` + `RelayChatViewModel.swift` add a Task-specific control and
progress layer without changing the asynchronous job API:

- The composer shows a bounded second row for workspace and reasoning effort, avoiding
  an unbounded horizontal scroller inside the bottom safe-area inset.
- Changing models resets an invalid prior effort choice. Relay sends the selected
  catalog-backed `taskModel` and effective effort when creating a job.
- Active job cards refresh full job detail about every two seconds while the Task tab
  is visible. Empty queued/running cards show progress; growing logs use compact
  monospaced text; completed answers use the same structured Markdown renderer as Chat.
- The thread drawer groups visible threads by workspace, orders groups by recent
  activity, and marks workspaces containing active jobs.
- A task session is resumed only when both provider and workspace match the current
  composer selection. Switching workspace starts a new session instead of sending an
  invalid cross-workspace `resumeSessionId`.
- The prompt keeps interactive scroll dismissal, keyboard dismissal on Run, and the
  keyboard-accessory dismiss action required for iPhone use.

## 6. Workspace selection — unified folder browser (Task tab)

The Task tab needs you to pick which workspace folder a job runs in.

### Why it was redesigned

The first cut had two problems that made it confusing: it split "registered
workspaces" (a card list) from "browse" (a separate toolbar-toggled mode), and tapping
a workspace card both **selected and dismissed** the sheet — so there was no way to
drill into a workspace's subfolders. Selecting and navigating were conflated.

### The model now

One unified folder browser (`RelayWorkspaceSheet` + `RelayFolderRow`). You are always
navigating a folder tree rooted at the workspace root; **navigating and confirming are
separate, unambiguous actions**:

- **Tap a folder row → drills in.** The whole row opens that folder
  (`loadWorkspaceDirectories(path:)`). It never dismisses the sheet.
- **Breadcrumb + back chevron** at the top show the current location and navigate up
  one level (`upNavigationPath`).
- **Persistent confirm button** at the bottom — "Use "<folder>" as workspace" —
  selects whichever folder you are currently in (`selectBrowsedDirectory(path:)`) and
  closes. It is disabled at the synthetic root ("All workspaces"), since the root
  itself can't be a workspace.
- **Per-row quick-pick.** Registered workspaces (shown as the root entries, tagged
  **Workspace**) carry a trailing quick-pick circle so you can select one instantly
  without navigating into it. The currently selected workspace shows a filled checkmark
  and an accent border instead.
- **Inline create.** "New folder here" reveals a name field and creates a folder under
  the current path (`createWorkspace(parentPath:name:)`), then selects it.
- Git repositories get a branch icon and a "Git repository" subtitle; plain folders get
  a folder icon and "Folder".

The active workspace is still surfaced as a **chip in the Task composer**
(`📁 <name> ⇕`) next to the model chip; tapping it opens this browser.

All selection — registered, browsed-into, or newly created — funnels through
`POST /v1/codex/workspaces/select`, which returns the canonical workspace and sets
`selectedWorkspaceID`, so there is a single selection path.

View model support (`RelayChatViewModel`): `directoryListing`,
`isBrowsingDirectories`, `workspaceActionError`, `loadWorkspaceDirectories(path:)`,
`selectBrowsedDirectory(path:)`, `createWorkspace(parentPath:name:)`, `upsertWorkspace`.

> A `RELAY_UITEST_WS_PATH=<dir>` DEBUG env var deep-links the browser to a starting
> folder for headless screenshots (see §8).

### What folders are shown (EC2)

The server's directory browse (`server.mjs`, `workspaceDirectoryEntries`) only walks
**inside the workspace root `/srv/codex-workspaces`** — the mutual-TLS security
perimeter. Folders elsewhere on the instance are intentionally not exposed. Within the
root it shows **all non-hidden directories**, with two filters:

- **Dotfiles are skipped** (`.git`, `.config`, …) by design.
- **A cap of `CODEX_MAX_WORKSPACE_DIR_ENTRIES` (default 100)** bounds the listing; if a
  directory has more than that many subfolders, the overflow is currently dropped
  silently. Raise the env var (and redeploy) if a workspace can exceed it.

---

## 7. Server contract

The redesign consumes the existing frozen endpoints:

- `GET  /v1/codex/models` — public catalog, including optional `taskModel`; private
  fields like `azureBaseURL`, `azureApiKeyFile`, and `bedrockRegion` are stripped
  server-side.
- `POST /v1/codex/chat` — SSE stream of `meta` → `delta`* → `usage` → `done`
  (or `error`). Cancels when the client closes the connection.
- `GET/POST /v1/codex/workspaces`, `POST /v1/codex/workspaces/select`,
  `POST /v1/codex/workspaces/create`, `GET /v1/codex/workspace-dirs`.
- `POST /v1/codex/jobs` and friends for Task mode (poll-only status). Relay submits
  the catalog's task model and effective effort and only resumes a thread when its
  provider and workspace still match.

mTLS is terminated at nginx (not in-process); chat inherits it like every other
`/v1/codex/*` route. The SigiQ Bedrock guardrail is unchanged: the server refuses to
start unless `CLAUDE_AWS_PROFILE=sigiq` and strips ambient `AWS_*` for Claude/Bedrock.

---

## 8. Headless visual testing

Simulator tap automation is unavailable in this environment (idb-companion is
deprecated in Homebrew; AppleScript taps need an accessibility grant). The app instead
ships **DEBUG-only launch hooks** (compiled out of release builds) that drive the UI on
launch so the streaming and workspace screens can be screenshotted with
`xcrun simctl io <udid> screenshot`:

| Env var | Effect |
|---|---|
| `RELAY_UITEST_MODEL` | Selects the first chat model whose id/label contains the value. |
| `RELAY_UITEST_PROMPT` | Fills the prompt and sends it on launch (Chat tab only). |
| `RELAY_UITEST_TASK_PROMPT` | Fills and submits a Task prompt so live job polling can be captured. |
| `RELAY_UITEST_TAB` | Selects a tab: `library`/`chat`/`task`/`status`. |
| `RELAY_UITEST_OPEN` | `workspace` opens the workspace folder browser on the Task tab. |
| `RELAY_UITEST_WS_PATH` | Deep-links the workspace browser to a starting folder (e.g. `/srv/codex-workspaces/sigiq`). |

Pass them through the simulator child environment, e.g.:

```bash
SIMCTL_CHILD_RELAY_UITEST_MODEL="gpt-5.5" \
SIMCTL_CHILD_RELAY_UITEST_PROMPT="Explain database connection pooling" \
xcrun simctl launch <udid> com.parikshit.pocvault
```

The simulator server (`ops/serve-simulator-poc-vault`) was enriched to support this:

- The chat fixture (`serve_codex_chat_fixture`) now streams a paced, markdown-rich
  reply (prose + list + code block) with a `usage` event. Pacing is tunable via
  `SIM_CHAT_DELTA_DELAY` (seconds per delta, default `0.28`) so the dots→caret
  transition is observable.
- Workspace fixtures (`codex_fixture_workspaces`, `codex_fixture_workspace_dirs`) now
  return three workspaces (Scratch, POC Vault [default], SigiQ) and a path-aware
  directory listing (root lists workspaces; `sigiq` exposes `ai-tutor`,
  `leap-workbench`, `data-readiness`) so the card and browse views are exercisable.
- Task fixtures expose the same model/effort catalog as the renderer and advance a
  submitted job through growing running logs to a completed Markdown result across
  successive detail polls.

---

## 9. Build / run

Simulator (no signing):

```bash
ios/launch-simulator.sh         # boots the fixture server + builds + installs + launches
```

Physical device (real signing + production EC2 over mTLS):

```bash
source ~/.poc-vault/secrets/config.env
xcodebuild build -project ios/POCVault/POCVault.xcodeproj -scheme POCVault \
  -configuration Debug -destination "platform=iOS,id=<device-udid>" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  POC_VAULT_MANIFEST_PUBLIC_KEY="$POC_VAULT_MANIFEST_PUBLIC_KEY" \
  -derivedDataPath /tmp/relay-device-dd
xcrun devicectl device install app --device <device-udid> \
  /tmp/relay-device-dd/Build/Products/Debug-iphoneos/Relay.app
xcrun devicectl device process launch --device <device-udid> com.parikshit.pocvault
```

The device build talks to the real EC2 host and authenticates with the client
certificate stored in the device keychain.

---

## 10. Files touched

| Area | Files |
|---|---|
| Catalog dedup | `ops/render-codex-api-config`, `ops/serve-simulator-poc-vault` |
| Task catalog | `ops/render-codex-api-config`, `ops/serve-simulator-poc-vault`, `codex-server/codex-api-deploy/server.mjs` |
| Sim fixtures | `ops/serve-simulator-poc-vault` (chat pacing, task polling, workspaces, dirs) |
| Tabs | `ios/POCVault/POCVault/POCVaultApp.swift` |
| Chat UX / views | `ios/POCVault/POCVault/Views/RelayChatView.swift`, `RelayChatViewModel.swift` |
| Task UX / views | `ios/POCVault/POCVault/Models/CodexModels.swift`, `RelayChatView.swift`, `RelayChatViewModel.swift` |
| Theme tokens | `ios/POCVault/POCVault/POCVaultApp.swift` (`AppTheme`) |
| Workspace picker | `RelayChatView.swift` (`RelayWorkspaceSheet`, `RelayFolderRow`), `RelayChatViewModel.swift` |
