# Relay Files-First Redesign

> **Status: implemented in the repo as of 2026-08-09.** Both tracks landed —
> server (files API, workspace-scoped chat, Cursor test hardening, job SSE
> streaming; `node --test` green) and iOS (file-browser root, per-folder chat
> with a harness-first model picker, file viewer, dead console removed; full
> suite + simulator verification green). One addition beyond this spec: the
> model picker groups Agents **by harness** (Codex / Claude Code / Cursor),
> each revealing its own models, instead of a flat task-capable list. As of
> 2026-08-11 the checked-in server matches the live EC2 install and its files
> API is responding behind the existing mTLS perimeter. A physical-device app
> build/install still requires the macOS/Xcode workflow and is tracked
> separately from the server rollout.

This is the successor to [CHAT_REDESIGN.md](CHAT_REDESIGN.md). It replaces the
four-tab, chat-first navigation model with a **files-first** design: the app
opens into a file browser over the server workspace jail, and every folder can
host its own conversation with an agent or chat model. The catalog
de-duplication and server contract basics from the chat redesign carry forward
unchanged.

Legacy naming still applies: the repo is `poc-vault`/`POCVault` with bundle id
`com.parikshit.pocvault`; the user-facing product is **Relay**.

---

## 1. Target mental model

Relay is the private iPhone interface to the isolated agent workspace on the
EC2 host. You browse the workspace jail (`/srv/codex-workspaces`) like the
iPhone Files app, and from any folder you open a conversation scoped to that
folder — either an asynchronous agent task or a synchronous chat.

```text
App launch
  `- File browser at /srv/codex-workspaces
      |- tap folder -> drill in
      |- tap file   -> read-only viewer
      |- create     -> safe folder creation only
      |- toolbar ... -> Library | Status | Diagnostics
      `- toolbar terminal -> conversation for THIS folder
           |- Agents: Codex | Claude Code | Cursor Agent
           |- Chat models: Codex GPT-5.6 Sol/Terra/Luna | configured Azure
           |- agent -> async job, live output, cancel, continue
           |- chat  -> saved workspace-scoped conversation
           `- history -> both kinds for this folder
```

What this replaces from the chat-first design:

- the **Library · Chat · Task · Status** bottom tabs (`RelayRootTab`);
- the two mode-locked `RelayChatViewModel` instances (`lockedMode`);
- the composer workspace chip and `RelayWorkspaceSheet` folder picker;
- the dead `CodexConsoleView`/`CodexConsoleViewModel` pair (deleted after its
  live symbols — markdown rendering, notifications, monitor policy, audio
  config — are extracted into shared files).

File content is **read-only** in v1. Safe folder creation remains; file edits,
deletes, uploads, and moves happen through an agent unless separately designed.

---

## 2. iOS navigation architecture

All work is in `ios/POCVault`.

### Root: NavigationStack file browser

A single `NavigationStack(path:)` rooted in `FileBrowserView` at the workspace
root replaces the TabView. A `BrowserRoute` enum (`.folder(path:)`,
`.file(entry:)`) drives `navigationDestination`.

- **Rows** show a type glyph (folder / git-branch / per-type file icon), name,
  and `size · mtime` subtitle for files; registered workspaces carry a badge.
- **Search** is server-backed (debounced `q` param), with pull-to-refresh,
  paging via a truncation banner, and an empty state.
- **New folder** reuses the existing safe-creation endpoint; no other mutation
  is offered.
- `readDenied` files render greyed and are not fetchable.

### Secondary destinations

Library and Status/Diagnostics move behind a **root-only toolbar ellipsis
menu**: Library presents as a `fullScreenCover` (it embeds its own
NavigationStack), Status/Diagnostics as a `sheet`. They are destinations, not
peers of the browser.

### File viewer

`FileViewerView` switches on an inferred file category:

- **Text/code** — monospaced text with a wrap toggle and byte-cap truncation
  banner ("load more" via Range requests).
- **Markdown** — shared renderer with a Raw/Rendered toggle (the chat markdown
  views are promoted out of `RelayChatView` into a shared `Rendering/` file).
- **Images** — fit-width image view.
- **PDF/HTML** — the existing authenticated WebView (mTLS already handled).
- **Binary fallback** — placeholder icon plus share.

### Per-folder chat sessions

Chat presents as a `fullScreenCover` from a terminal toolbar icon available on
every folder screen. A new `RelayChatSessionStore` owned by the App struct:

- caches one `RelayChatViewModel` per canonical folder path/workspace id
  (LRU cap ~6; view models with an active stream or job are pinned);
- lazily registers unregistered folders via `POST /v1/codex/workspaces/select`
  on first send;
- keeps streams **view-model-owned**: dismissing the cover does not cancel an
  in-flight stream or job;
- runs the **single app-wide job monitor loop** (replacing the tab-visibility
  monitors) and feeds completion notifications.

The chat editor keeps its keyboard-accessory Done action, interactive scroll
dismissal, and dismissal on Run — these are hard requirements, not styling.

---

## 3. Model picker: explicit mode via `RelayModelChoice`

`lockedMode` and the composer mode toggle are removed, but the interaction mode
stays **explicit**: a `RelayModelChoice` pairs a server catalog model with
`.chat` or `.task`, and that mode — never an inference from the descriptor's
capabilities — is preserved through selection, thread continuation, and send.

The picker shows two sections:

| Section | Entries | Mode |
|---|---|---|
| **Agents** | Codex · GPT-5.6 Sol / Terra / Luna · Claude Code · Cursor Agent | `task` |
| **Chat models** | Codex · GPT-5.6 Sol / Terra / Luna · configured Azure profiles | `chat` |

Notes:

- **Codex is dual-mode.** The same GPT-5.6 Sol/Terra/Luna descriptors appear in
  both sections with different choice modes, so `RelayModelChoice` identity
  includes both model id and mode. This retires the old
  `supports(.task) → job` rule that made Codex chat unreachable.
- **Claude Code and Cursor Agent are task-only** providers, authenticated by
  their own direct-subscription state in the isolated runner home on the
  server.
- **Azure profiles are chat-only** and routed entirely server-side.
- **Provider honesty:** the app consumes the server catalog as capability
  truth. A provider is advertised only after its on-box CLI or upstream route
  passes a live smoke test as the runner user; missing or failed auth produces
  no row rather than a disabled credential prompt. Bedrock is absent unless
  the server explicitly advertises it (the existing SigiQ-only guard is
  unchanged, but it is not part of this rollout). The app never synthesizes
  Bedrock, Cursor, Claude, or Azure entries locally.
- Task effort remains model-driven via the catalog's effort levels and is
  hidden when a model advertises none.

### Threads

Sending in chat mode creates a **workspace-scoped chat thread**; sending in
task mode creates an async job as before. The thread drawer for a folder shows
both kinds in one flat recency list with mode badges. Subfolder conversations
are intentionally distinct from their parent folder's.

---

## 4. Server API additions

The server remains the zero-dependency Node service in
`codex-server/codex-api-deploy/server.mjs`. All additions are backward
compatible: the previously installed app keeps working at every milestone, and
the legacy `GET /v1/codex/workspace-dirs` response shape is preserved.

### 4.1 `GET /v1/codex/fs/list`

Bounded, read-only directory listing inside the jail.

- Parameters: `path`, `offset`, `limit`.
- Returns directories first, then files, sorted by name. Entries include
  `kind` (`dir`/`file`), relative path, size and modification time for files,
  conservative MIME/type hints, workspace/git metadata for directories, and
  `readDenied` for protected names.
- Responses always include `offset`, `limit`, `total`, and `truncated` — a
  listing is never silently capped.
- Dotfiles are **listed** but HTTP reads of high-value secret patterns
  (`.env*`, private keys/certificates, `.netrc`, credential files) are denied
  by default. This is defense-in-depth on top of mTLS and runner isolation,
  not a secret-classification system.

### 4.2 `GET|HEAD /v1/codex/fs/file`

Bounded, read-only file bytes.

- Rejects anything outside the jail, non-regular files, and denylisted names.
- Sends `cache-control: no-store`, `x-content-type-options: nosniff`, and a
  safe content disposition.
- Bounds a single response to **1 MiB** and supports byte `Range` requests
  (206/416 semantics) for larger permitted files, under an absolute maximum
  file size. The app reads truncation from the 206/`Content-Range` response,
  not from inferred byte counts.
- HTML/SVG are treated as downloads unless the existing sandboxed preview
  mechanism is explicitly requested.

### 4.3 Workspace-scoped chat threads

- `POST /v1/codex/chat` accepts an optional `workspaceId`, resolved through
  the same registered/dynamic workspace registry as jobs. Omitting it keeps
  the installed app's global-chat behavior.
- The resolved workspace id/name is persisted with the thread. A continuation
  may omit the id and inherit the stored value; a conflicting id fails.
- `GET /v1/codex/threads?workspaceId=...` merges chat and task threads for
  that folder. Legacy chats without a workspace remain only in the global
  list. Summaries, details, provider filters, and scoped deletion preserve the
  workspace fields.
- Codex chat uses the selected folder as a **read-only cwd** for an ephemeral
  run. Azure chat remains context-only: it does not automatically receive file
  content, and the UI must not imply otherwise.

### 4.4 `GET /v1/codex/jobs/<id>/stream`

Live job output over SSE:

```text
GET /v1/codex/jobs/<id>/stream?stdoutOffset=<n>&stderrOffset=<n>
```

Event vocabulary:

| Event | Payload |
|---|---|
| `status` | job status snapshot |
| `stdout` | byte offset plus text chunk |
| `stderr` | byte offset plus text chunk |
| `done` | terminal job response |

The stream replays bounded persisted logs from the requested offsets, then
follows live data; it emits heartbeats, unsubscribes on disconnect, and
preserves valid UTF-8 across chunk boundaries. Polling `GET /jobs/<id>` stays
authoritative for recovery — iOS backgrounding can kill an SSE connection, so
the app reconciles job state by polling on foreground and keeps the 2 s poll
as fallback when the stream errors.

Job concurrency stays at `CODEX_MAX_CONCURRENT=1` until live measurement shows
parallel Codex/Claude/Cursor runs are safe; it is raised to 2 first.

### Cursor Agent provider

Cursor joins Codex and Claude as a task provider (`provider=cursor`). Its
contract is pinned to the **installed, authenticated CLI** — argv, JSON output
shape, resume identifier, and cancellation behavior are verified on the box
before any catalog entry is advertised, rather than assumed from documentation.
If model enumeration is unsupported, a single `Cursor Agent · Auto` entry lets
the CLI choose. Ambient AWS credentials are scrubbed from Cursor jobs just as
for direct Claude jobs.

---

## 5. Security invariants

These hold at every milestone of the rollout:

- **mTLS is the only network authentication.** `/healthz` stays public; every
  `/v1/codex/*` route requires a client certificate from the exact allowlist
  (`CN=iphone`, `CN=parikshit-mac` on the live install). The gateway verifies
  the certificate and the backend re-checks the forwarded subject. No Relay
  account or bearer token is introduced. On the current deployment the gateway
  is Caddy on an `sslip.io`-style public hostname; the Node service listens
  only on the private instance address and is never exposed directly.
- **No Tailscale.** No Tailscale dependency, hostname, route, certificate, or
  provisioning is added anywhere — app config, gateway config, ops, or
  verification.
- **The jail holds.** The phone never sends a path outside
  `/srv/codex-workspaces`. Every server path is resolved and
  realpath-contained before use; traversal, absolute escapes, and symlink
  escapes are rejected.
- **Responses are bounded.** List and read endpoints paginate or truncate
  explicitly, cap byte sizes, and send no-store/nosniff headers on file bytes.
- **No provider credentials reach the phone.** Codex, Claude, and Cursor
  authenticate via direct-subscription state isolated in the runner user's
  home; Azure chat uses server-side bearer-key files (root-owned `0600`,
  referenced by path in the catalog, read only at request time). The model
  endpoint strips private fields; keys never appear in source, manifests, API
  responses, or logs.
- **Branding stays Relay**; bundle id, target names, and internal
  POCVault-legacy paths are unchanged.

---

## 6. DEBUG launch hooks (headless testing)

The DEBUG-only launch-hook matrix changes with the navigation. As before, the
hooks are compiled out of release builds and passed via the simulator child
environment (`SIMCTL_CHILD_RELAY_UITEST_*`).

| Env var | Effect |
|---|---|
| `RELAY_UITEST_PATH` | Pushes the file browser to a folder on launch. |
| `RELAY_UITEST_FILE` | Opens a file in the viewer. |
| `RELAY_UITEST_CHAT=1` | Opens the chat cover for the current folder; the existing `MODEL`/`PROMPT`/`TASK_PROMPT` hooks then auto-drive it. |
| `RELAY_UITEST_OPEN` | `library` or `status` opens that secondary destination. |
| `RELAY_UITEST_MODEL` | Unchanged — selects the first model whose id/label contains the value. |
| `RELAY_UITEST_PROMPT` | Unchanged — fills and sends a chat prompt. |
| `RELAY_UITEST_TASK_PROMPT` | Unchanged — fills and submits a task prompt. |

Removed: `RELAY_UITEST_TAB` (no tabs remain) and `RELAY_UITEST_OPEN=workspace`
with its `RELAY_UITEST_WS_PATH` deep link (the workspace sheet is deleted;
`RELAY_UITEST_PATH` supersedes both).

---

## 7. Rollout shape and verification

Two tracks land in parallel; every server milestone is additive and
independently deployable.

| Track | Milestones |
|---|---|
| **S — Server** | S1 files API · S2 workspace-scoped chat · S3 Cursor on-box validation · S4 job streaming + measured concurrency |
| **I — iOS** | I0 symbol extraction · I1 models/client · I2 browser root · I3 file viewer · I4 per-folder conversation · I5 delete dead console |

Verification follows the repo's existing discipline:

- `node --check` and `node --test` for the server after each milestone; fake
  Codex/Claude/Cursor binaries in tests never require real auth.
- `ops/serve-simulator-poc-vault` gains fixtures for file listings, file bytes
  (including a >1 MiB Range case), workspace-scoped threads, the Cursor model,
  and job-stream SSE **before** the matching iOS milestone.
- Simulator manifest signing is self-contained: when the operator key is not
  available, the fixture server creates a mode-`0600`, simulator-only seed under
  ignored `build/simulator/`, and `ios/launch-simulator.sh` injects its public key
  into the Debug build. `POC_VAULT_SIM_SIGNING_KEY` can override that key.
- S1 tests cover traversal, symlink escape, denylist, dotfiles, pagination,
  HEAD, Range, 206/416, MIME/disposition, byte limits, and the unchanged
  legacy `workspace-dirs` response.
- Live checks: public `/healthz` returns 200, unauthenticated `/v1/codex/*`
  is rejected, and the smoke matrix (both allowed client identities; Codex
  Sol/Terra/Luna in both modes; direct Claude, direct Cursor, and each enabled
  Azure route) passes before a provider row is advertised.
- Device pass: the model list must contain only providers that passed the live
  smoke matrix; unavailable providers simply disappear. Older servers degrade
  gracefully — `kind` decodes to `dir` by default, missing fs endpoints
  surface an error banner instead of crashing.

---

## 8. Relationship to other docs

- [CHAT_REDESIGN.md](CHAT_REDESIGN.md) — superseded for navigation and the
  chat-surface shell; still authoritative for model-catalog de-duplication,
  streaming chat internals, and the pre-existing server contract.
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — overall shipped-system notes; its
  console-era sections describe surfaces this redesign removes.
- [PROJECT_HISTORY.md](PROJECT_HISTORY.md) — chronological account of how the
  repo reached this shape.
