# Relay Node API v1 — Contract Freeze (W0)

> Status: contract freeze, derived verbatim from
> `relay-server/codex-api-deploy/server.mjs` (6,642 lines) and validated
> against `relay-server/codex-api-deploy/server.test.mjs` (59 tests).
> All line numbers cite `server.mjs` unless noted. Domains and hosts are
> genericized (`<domain>`, `<node-id>`); no live endpoints appear here.
>
> Part 1 documents the EXISTING surface exactly as implemented. Part 2
> ("v1 ADDITIONS") specifies new endpoints/semantics that are designed but
> **not yet implemented**. Part 3 lists ambiguities found during the freeze.

---

## Part 1 — Existing contract

### 1.1 Transport, encoding, general conventions

- HTTP/1.1 JSON API plus Server-Sent Events (SSE) for chat and job streams.
  Server bootstrap: `http.createServer` at 6633–6642; single async router
  `routeRequest` at 1394–1578.
- All JSON responses are sent with `content-type: application/json`,
  `cache-control: no-store`, and explicit `content-length` (`sendJson`,
  1263–1271). HTML responses (`sendHtml`, 1273–1280) and raw bytes
  (`sendBytes`, 1282–1289) also carry `no-store`.
- SSE responses are opened with `content-type: text/event-stream`,
  `cache-control: no-cache, no-transform`, `connection: keep-alive`,
  `x-accel-buffering: no` (`initSse`, 1295–1302). Every event is exactly
  `event: <name>\n` + `data: <one-line JSON>\n\n` (`sendSse`, 1304–1307).
  No `id:` lines are emitted today (see Part 2 §2.1).
- Request JSON bodies are read whole and capped at `CODEX_MAX_BODY_BYTES`
  (default 30 MiB) — over-limit rejects 413 `request body too large`, invalid
  JSON rejects 400 `invalid JSON body` (`readBody`, 1309–1340). An empty body
  parses as `{}`.
- All text emitted in API payloads is scrubbed of ANSI escapes and C0
  control characters (`cleanApiText`/`stripAnsi`, 5106–5113).
- Trailing behavior: unmatched routes and **method mismatches** both return
  404 `not found` (1577). There is no 405 anywhere in the contract.
- Route params: job/thread/session ids must match `/^[a-f0-9-]{36}$/`
  (`isSafeJobId`, 1598–1600); artifact ids must match
  `/^artifact-[0-9]{3}$/` (`isSafeArtifactId`, 1602–1604). Non-matching ids
  return 404 before any lookup.

### 1.2 Auth model (mTLS with forwarded-subject re-check)

`authorize` (1370–1387), applied to every route except `GET /healthz`
(gate at 1401–1404):

- The node sits behind a TLS-terminating gateway (Caddy in the personal
  install) that REQUIRES a client certificate and forwards two headers:
  - `X-SSL-Client-Verify` — must be exactly `SUCCESS`
  - `X-SSL-Client-S-DN` — the client-cert subject DN
- The server **re-checks** the forwarded subject against the allowlist
  (`RELAYD_ALLOWED_CERT_SUBJECTS`, falling back to
  `CODEX_ALLOWED_CERT_SUBJECTS` — see the format below).
  - Missing/failed verify → **401** `client certificate is required`
  - Verified but unlisted subject → **403**
    `client certificate subject is not allowed`
- `CODEX_REQUIRE_MTLS=false` (default `true`, line 11) disables the check
  entirely; the subject header, if present, is still propagated.
- The authorized subject is threaded through as `certSubject` into job
  records, chat threads, audit log lines, and echoed in job responses.
- There are **no bearer tokens, API keys, cookies, or sessions** anywhere on
  the node API. mTLS (via the gateway re-check) is the only data-path auth.
- `POST /v1/pair` is **never routable on this listener** — it is refused with
  a 404 before `authorize` runs, so the data port does not even reveal that it
  exists. Pairing has its own listener (§2.3).

#### Allowlist format (multi-RDN safe)

An RFC 2253 DN **contains commas** — `CN=device,OU=Devices,O=Relay` — so the
historical comma-split could only ever express *single-RDN* subjects. Any
realistic device DN was shredded into fragments and 403'd forever, in both
direct mode (the gateway forwards the full DN) and tunneled mode (the node
derives the same form from the peer certificate). Three input forms are now
accepted, disambiguated by the first character and by the presence of a
newline — neither can appear unescaped inside a DN:

| Form | Example | Multi-RDN? |
|---|---|---|
| **JSON array** (preferred) | `["CN=device,OU=Devices,O=Relay","CN=laptop,O=Relay"]` | yes |
| newline-separated | one complete DN per line | yes |
| legacy comma-separated | `CN=allowed,CN=other` | **no**, by construction |

The JSON form is the only one that survives a single-line systemd
`EnvironmentFile`, so it is the recommended one. The legacy comma form keeps
working unchanged for the single-RDN values already deployed; it cannot be
made to express a comma-bearing DN unambiguously, and no attempt is made to.
A value starting with `[` that is not valid JSON is a **startup error**, never
a silent fallback.

`RELAYD_ALLOWED_CERT_SUBJECTS` takes precedence when non-empty;
`CODEX_ALLOWED_CERT_SUBJECTS` remains supported so existing installs need no
change.

#### Auto-allowlisting a freshly paired device

`RELAYD_PAIRING_AUTOALLOW` (default **`true`**) adds the subject of the
certificate the node itself just minted during a **successfully authenticated**
pairing (§2.3) to the allowlist. Without it, a freshly paired phone receives a
valid certificate and is then 403'd forever until an operator edits the env
file and restarts — an onboarding dead end.

It is deliberately not silent:

- it is a named knob, and `relayd doctor` reports its state;
- it only ever admits a subject from a certificate **this node issued in this
  exchange** — it never widens to anything else, and never on tag-verification
  failure (no certificate exists to allowlist in that case);
- every addition is appended to `<dataDir>/allowed-cert-subjects.json`
  (mode 0600) as `{subject, reason:"paired", deviceId, addedAt}`, which is
  read back at startup and is reviewable/editable;
- every addition emits the audit event `cert_subject_allowlisted`.

Set `RELAYD_PAIRING_AUTOALLOW=false` for a frozen, operator-managed allowlist.
Revocation (§2.4) is unaffected: a revoked serial is rejected at the TLS layer
regardless of the subject allowlist.

### 1.3 Configuration knobs that shape the contract

All from env, parsed at 9–124. Contract-relevant defaults:

| Env var | Default | Effect |
|---|---|---|
| `CODEX_REQUIRE_MTLS` | `true` | forwarded-subject auth on/off |
| `RELAYD_ALLOWED_CERT_SUBJECTS` | (empty) | allowed client-cert DNs; JSON array / newline / legacy comma (§1.2) |
| `CODEX_ALLOWED_CERT_SUBJECTS` | (empty) | same, legacy name; used when the above is empty |
| `RELAYD_PAIRING_AUTOALLOW` | `true` | allowlist the subject of a freshly paired device (§1.2) |
| `RELAYD_PAIRING_ENABLED` | `true` | daemon serves the pairing listener (§2.3) |
| `RELAYD_PAIRING_HOST` | `CODEX_API_HOST` | pairing listener bind address |
| `RELAYD_PAIRING_PORT` | `CODEX_API_PORT + 1` | pairing listener port; must differ from the data port |
| `RELAYD_PAIRING_ADVERTISE` | unset | public base URL `relayd pair` prints for the phone |
| `CODEX_MAX_BODY_BYTES` | 30 MiB | JSON body cap (413) |
| `CODEX_MAX_CONCURRENT` | 1 | job slots; excess jobs queue FIFO |
| `CODEX_MAX_JOB_STREAMS` | 8 | concurrent job SSE cap (503) |
| `CODEX_JOB_STREAM_HEARTBEAT_MS` | 15000 | SSE heartbeat comment interval |
| `CODEX_MAX_OUTPUT_BYTES` | 5 MiB | log capture + stream replay bound |
| `CODEX_RESPONSE_OUTPUT_BYTES` | 64 KiB | per-field text in detail responses |
| `CODEX_LIST_OUTPUT_BYTES` | 4 KiB | per-field text in list responses |
| `CODEX_DEFAULT_TIMEOUT_MS` / `CODEX_MAX_TIMEOUT_MS` | 10 min / 30 min | job timeout default/clamp |
| `CODEX_MAX_JOB_ATTACHMENTS` / `_BYTES` / `_TOTAL_BYTES` | 6 / 8 MiB / 18 MiB | attachment caps (413) |
| `CODEX_MAX_JOB_ARTIFACTS` / `CODEX_MAX_ARTIFACT_BYTES` / `_TOTAL_BYTES` | 12 / 1 MiB / 5 MiB | artifact extraction caps |
| `CODEX_MAX_JOB_SKILLS` / `CODEX_MAX_SKILL_PROMPT_BYTES` | 6 / 20 KiB | skill selection/injection caps |
| `CODEX_WORKSPACE_BROWSE_ROOT` | `/srv/codex-workspaces` | the jail root (realpath-resolved at boot, 67–69) |
| `CODEX_MAX_WORKSPACE_DIR_ENTRIES` | 100 | workspace-dirs listing cap |
| `CODEX_FS_MAX_LIST_ENTRIES` | 500 | fs/list page-size cap |
| `CODEX_FS_MAX_READ_BYTES` | 1 MiB | fs/file read window |
| `CODEX_FS_MAX_FILE_BYTES` | 25 MiB | fs/file absolute size cap (413) |
| `CODEX_FS_READ_DENYLIST` | see below | secret-file read denylist |
| `CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES` | 25 MiB | transcription body cap |
| `CODEX_THREAD_SUMMARY_CHARACTERS` | 240 | summary text truncation |
| `CODEX_WORKSPACES` | 3 seeded entries | static workspace registry (JSON array of `{id,name,path}`, 169–205) |
| `CODEX_MODEL_CATALOG` | built-in | model catalog (227–235) |
| `CODEX_DANGEROUS_MODE` | `true` | harness sandbox bypass flags |
| `CODEX_PROXY_BASE_URL` (+ client cert/key paths) | unset | dev proxy mode (§1.20) |

Default secret denylist (77–80), matched case-insensitively against entry
**basenames**, `*` is the only wildcard (`compileDenyPattern`, 657–663):

```
.env*,*.pem,*.key,*.p12,*.pfx,*.crt,*.csr,*.der,*.jks,*.keystore,
*.mobileconfig,.netrc,.npmrc,credentials,credentials.json,
id_rsa,id_dsa,id_ecdsa,id_ed25519
```

### 1.4 Error taxonomy

Every error body is `{"error": "<message>"}` (`sendError`, 1291–1293).
Handlers throw `Error` objects with a `status` property; the top-level
catch maps unknown errors to 500 (6633–6638).

| Status | Used for (representative messages) |
|---|---|
| 400 | validation: `request body must be a JSON object`, `prompt is required and must be a non-empty string`, `workspaceId is not registered`, `workspace path must stay inside the workspace root`, `path must stay inside the workspace root`, `offset must be a non-negative integer`, `stream offset must be a non-negative integer`, `invalid JSON body`, `provider must be codex, claude, or cursor`, `reasoningEffort must be low, medium, high, or xhigh`, `session not found in runner CODEX_HOME`, `session provider does not match requested provider`, `session does not belong to workspace`, `chat thread workspace does not match requested workspaceId`, `preview is only available for HTML and SVG files` |
| 401 | `client certificate is required` |
| 403 | `client certificate subject is not allowed`, `file matches the read denylist` |
| 404 | `not found`, `job not found`, `thread not found`, `artifact not found`, `artifact preview not available`, `workspace directory was not found`, `file was not found` |
| 409 | `workspace folder already exists`, `job is already finished`, `job is not active`, `thread has active jobs` |
| 413 | `request body too large`, `prompt is too large`, `attachment is too large`, `attachments are too large`, `audio body too large`, `file exceeds the maximum readable size`, `file exceeds the preview size limit`, `messages may include at most 80 entries`, `message content is too large` |
| 416 | fs/file unsatisfiable `Range` (empty body + `content-range: bytes */<size>`, 942–948) |
| 500 | unexpected errors; `directory could not be read`; `workspace folder could not be created` |
| 502 | Azure Speech upstream failure / empty transcript |
| 503 | `Azure Speech is not configured for transcription`, `too many concurrent job streams` |

Note: chat-provider configuration failures (`Azure OpenAI is not
configured`, `Bedrock chat is disabled because the SigiQ profile is not
configured`, `Codex chat requires a registered workspace`) are raised
**after** the SSE stream has opened, so they arrive as SSE `error` events
on an HTTP 200 stream, never as HTTP 503 (1717–1758; see §1.9).

### 1.5 `GET /healthz` — public liveness (1397–1399)

The only unauthenticated route. 200 with `healthPayload(false)`
(1580–1590):

```json
{
  "ok": true,
  "authenticated": false,
  "requireMtls": true,
  "queueLength": 0,
  "activeJobs": 0,
  "maxConcurrent": 1,
  "workspaceCount": 3
}
```

`workspaceCount` counts only statically registered workspaces, not dynamic
ones (1588; see ambiguity A1).

### 1.6 `GET /v1/codex/health` (1406–1408)

Same payload with `"authenticated": true`. Requires auth (i.e. doubles as
an mTLS probe).

### 1.7 `GET /v1/codex/ui` (1410–1412)

Serves an embedded single-file HTML thread browser
(`codexThreadUiHtml`, 5136–6631). Authenticated; `text/html`; not part of
the machine contract but frozen as an existing route.

### 1.8 `GET /v1/codex/models` (1414–1416)

200 `{"models": [ModelDescriptor…]}` — the server-side catalog
(`publicModelCatalog`, 352–363). Public descriptor fields (from
`cleanModelDescriptor`, 275–319):

```json
{
  "id": "gpt-4o",
  "label": "GPT-4o (Azure)",
  "provider": "azure",            // codex|claude|cursor|azure|bedrock
  "modes": ["chat"],              // subset of ["chat","task"]
  "azureDeployment": "gpt-4o",    // optional
  "taskModel": "opus",            // optional: model id the app passes to POST /jobs
  "defaultOptions": {"temperature": 0.7, "maxTokens": 4096},  // optional
  "effortLevels": ["low","medium","high"]                      // optional
}
```

**Credential-bearing catalog fields are stripped** before serialization:
`azureBaseURL`, `azureApiKeyFile`, `azureApiKeyEnv`, `bedrockRegion`
(352–363). Verified by test `keeps OpenCode routing secrets out of the
public model catalog` (server.test.mjs:724).

### 1.9 `POST /v1/codex/chat` — SSE chat (1418–1421, 1717–1758)

Request body (`cleanChatRequest`, 1760–1782):

```json
{
  "provider": "codex",           // required: codex|azure|bedrock (1817–1826)
  "model": "codex-cli",          // required; must resolve in catalog with mode "chat"
  "threadId": "<uuid>",           // optional; server mints crypto.randomUUID() if absent
  "workspaceId": "scratch",      // optional; see continuation rules below
  "messages": [                    // required, 1..80 entries (1828–1852)
    {"role": "user", "content": "…"}   // role: user|assistant|system; content non-empty
  ],
  "options": {"temperature": 0.7, "maxTokens": 4096}  // optional; 0≤t≤2, 1≤maxTokens≤200000 (1854–1873)
}
```

Continuation rules (`resolveChatWorkspace`, 1788–1815): a `threadId` that
matches a stored chat thread must keep the same provider (400 on mismatch);
`workspaceId` is inherited from the stored thread when omitted and rejected
with 400 when it conflicts; a stored workspace that no longer resolves keeps
its identity with `path: null` (Codex chat then falls back to `scratch`).

Response: SSE stream. Event grammar (in order):

| event | data | notes |
|---|---|---|
| `meta` | `{"threadId","model","provider","workspaceId"}` | always first (1727–1732); `workspaceId` may be null |
| `delta` | `{"text": "…"}` | 0..n; Azure/Bedrock stream token deltas; **Codex sends the entire answer as one delta** (1962–1967) |
| `usage` | `{"inputTokens","outputTokens"}` | Bedrock only (2160–2166) |
| `done` | `{"stopReason": "stop"}` | Bedrock uses upstream `stopReason` or `end_turn` (2167–2169) |
| `error` | `{"code": "upstream", "message": "…"}` | on failure, **instead of** `done`; the stream then ends (1751–1756) |

Only request-validation failures from `cleanChatRequest` (400/413) are
plain JSON HTTP errors; once validation passes the server opens the SSE
stream (HTTP 200) and every later failure — including provider-not-
configured conditions — arrives as an SSE `error` event (1717–1758).
After a successful stream, the thread (messages + assistant reply + usage
+ `certSubject`) is persisted server-side under the data dir
(`persistChatThread`, 3708–3742) and appears in `/v1/codex/threads`.

Provider behavior: `codex` runs `codex exec` read-only (`-s read-only
--ephemeral --ignore-user-config --ignore-rules`) in the selected
workspace, or `scratch` when unscoped (1875–1973), with a 5-minute cap;
`azure` and `bedrock` call their upstream APIs server-side — API keys/AWS
credentials are read from server-side config/files and **never appear in
any response** (2077–2093, 2195–2276).

### 1.10 `GET /v1/codex/skills` (1427–1430)

Query: `provider` — optional, `codex|claude|cursor` (400 otherwise; default
`codex`). 200:

```json
{"provider": "codex", "skills": [
  {"id": "superpowers:brainstorming", "name": "brainstorming",
   "title": "Brainstorming", "provider": "codex",
   "group": "Superpowers", "description": "…"}
]}
```

Skills are discovered by scanning provider-specific roots for `SKILL.md`
files (depth ≤ 10, ≤ `CODEX_MAX_SKILL_DISCOVERY_FILES`; 2475–2558);
frontmatter `name`/`description` parsed with a minimal YAML reader
(2586–2607). The on-disk `file` path is internal and stripped by
`publicSkill` (2646–2655).

### 1.11 Workspace registry & directory browser

**`GET /v1/codex/workspaces`** (1432–1440) — 200
`{"workspaces": [{"id","name","path"}…]}`, name-sorted union of the static
registry and dynamic (browsed/selected) workspaces (207–213).

**`GET /v1/codex/workspace-dirs`** (1442–1451,
`workspaceDirectoryResponse` 534–550) — legacy directory browser.
Query: `path` (absolute or root-relative; must realpath inside the browse
root), `q` (case-insensitive name search; searching recurses to depth 8).
Response (golden-tested byte-identical, server.test.mjs:2996):

```json
{
  "rootPath": "/srv/codex-workspaces",
  "currentPath": "/srv/codex-workspaces/sigiq",
  "relativePath": "sigiq",
  "parentPath": "/srv/codex-workspaces",   // null at root
  "selectedWorkspace": {"id","name","path"},// null at root / unknown
  "entries": [
    {"name": "ai-tutor", "path": "/srv/codex-workspaces/sigiq/ai-tutor",
     "relativePath": "sigiq/ai-tutor", "workspaceId": "dir-sigiq-ai-tutor",
     "workspaceName": "SigiQ / ai-tutor", "hasGit": true,
     "isRegistered": false}
  ]
}
```

Directories only; dotfiles skipped; symlinks resolved and rejected if they
escape the root (601–608). Capped at `CODEX_MAX_WORKSPACE_DIR_ENTRIES`
(100) with **no truncation flag** (see ambiguity A3). Errors: 404
`workspace directory was not found`, 400 escape.

**`POST /v1/codex/workspaces/select`** (1461–1464, 1028–1041) — body
`{"path": "…"}` (root itself not selectable → 400). Materializes a dynamic
workspace (`id` = `dir-<slug>`, 432–446) and returns 200
`{"id","name","path"}`.

**`POST /v1/codex/workspaces/create`** (1466–1469, 1043–1088) — body
`{"parentPath": "…", "name": "…"}` (`path` accepted as alias for
`parentPath`). Name rules: 1–80 chars, `^[A-Za-z0-9][A-Za-z0-9._ -]*$`, no
leading dot, no separators. Creates the directory (mode 0755,
non-recursive) and returns **201** `{"id","name","path"}`. Errors: 400
invalid name/escape, 409 `workspace folder already exists`, 500.

### 1.12 Files API (read-only, jailed)

**`GET /v1/codex/fs/list`** (1453–1455, `fsListResponse` 792–815) — one
directory level. Query: `path` (default root), `offset` ≥ 0, `limit`
1..`CODEX_FS_MAX_LIST_ENTRIES` (default page = max = 500). Response:

```json
{
  "rootPath": "/srv/codex-workspaces",
  "path": "sigiq",                    // relative ("" at root)
  "absolutePath": "/srv/codex-workspaces/sigiq",
  "parentPath": "/srv/codex-workspaces",  // null at root
  "workspace": {"id","name","path"},      // null at root / unknown
  "offset": 0, "limit": 500, "total": 42,
  "truncated": false,                  // offset+returned < total (812)
  "entries": [
    {"name": "src", "kind": "dir", "path": "sigiq/src",
     "absolutePath": "…", "modifiedAt": "2026-…Z",
     "workspaceId": "dir-sigiq-src", "workspaceName": "SigiQ / src",
     "hasGit": false, "isRegistered": false},
    {"name": "notes.md", "kind": "file", "path": "sigiq/notes.md",
     "absolutePath": "…", "size": 1234, "modifiedAt": "2026-…Z",
     "mime": "text/markdown; charset=utf-8", "isText": true,
     "readDenied": false}
  ]
}
```

Ordering: directories first, then files, each name-sorted (817–837).
Dotfiles ARE listed. Secret-pattern files stay listed with
`readDenied: true` (889) so clients can render but not fetch them. Symlinks
are realpath-resolved and dropped if they escape the jail (843–850). MIME
is a conservative extension-based hint, never content-sniffed (756–772).

**`GET|HEAD /v1/codex/fs/file`** (1457–1459, `serveFsFile` 919–998) —
bounded raw read. Query: `path` (required), `download=1` forces attachment,
`preview=1` requests the sandboxed HTML/SVG preview.

Guard order (jail → type → denylist → size):
1. Realpath containment via `resolveBrowsePath(kind:"file")` (1103–1147):
   escapes → 400 `path must stay inside the workspace root` — including
   **missing paths that are lexically outside**, so probing can't
   distinguish existing outside files (1126–1133); missing inside path →
   404; non-regular file → 400.
2. Denylist basename match → 403 `file matches the read denylist`
   (922–924). Applies to reads only, never listings.
3. `size > CODEX_FS_MAX_FILE_BYTES` → 413 (925–927).

Serving semantics (935–998):
- Responses always carry `cache-control: no-store`,
  `x-content-type-options: nosniff`, `accept-ranges: bytes`, and a
  `content-disposition` (inline only for non-active text and png/jpeg/gif/
  webp; everything else, including HTML/SVG, downloads as attachment).
- Single `Range: bytes=…` supported → 206 with `content-range`; malformed/
  unsatisfiable → 416. Range windows are additionally capped to
  `CODEX_FS_MAX_READ_BYTES` per response.
- A file larger than the read window served without `Range` returns **206
  with the first window** so clients know to continue with ranges (953–957).
- `HEAD` returns headers only.
- `preview=1` (1002–1026): HTML/SVG only (else 400); size ≤ read window
  (else 413); returns the same sandboxed `srcdoc`+CSP wrapper as artifact
  previews (§1.17).

### 1.13 Sessions & threads

**`GET /v1/codex/sessions`** (1471–1476, `listWorkspaceSessions`
3401–3459) — provider CLI sessions found under the runner's
`CODEX_HOME/sessions` (`*.jsonl` with a `session_meta` line, 3365–3395)
merged with in-memory job sessions. Query: `workspaceId` (400 if not
registered), `provider` (any of `codex|claude|cursor|azure|bedrock`),
`limit` (default 50, clamp 1–200; `clampLimit` 1592–1596). Sessions whose
cwd lies outside every workspace are excluded. 200:

```json
{"sessions": [{"id": "<uuid>", "provider": "codex",
  "workspaceId": "scratch", "workspaceName": "Scratch",
  "cwd": "/srv/codex-workspaces/scratch",   // null for job-only sessions
  "timestamp": "…", "updatedAt": "…"}]}
```

**`GET /v1/codex/threads`** (1478–1483, `listWorkspaceThreads`
3461–3512) — the inbox: task threads (sessions ∪ jobs grouped by session
id) plus persisted chat threads, merged and sorted by `updatedAt` desc,
sliced to `limit`. Same query params as sessions. Thread summary shape
(task: `threadSummary` 3852–3879; chat: `chatThreadSummary` 3786–3811):

```json
{
  "id": "<session-uuid>", "sessionId": "<session-uuid>",
  "mode": "task",                    // "task" | "chat"
  "provider": "codex",
  "model": null,                     // chat threads only
  "workspaceId": "scratch", "workspaceName": "Scratch",
  "cwd": "/…",                        // null when no session file
  "timestamp": "…", "updatedAt": "…",
  "jobCount": 3, "activeJobCount": 0,
  "lastJobId": "<uuid>", "lastJobStatus": "succeeded",
  "lastPrompt": "…",                  // ≤ CODEX_THREAD_SUMMARY_CHARACTERS, "…"-suffixed
  "lastResult": "…", "lastError": null,
  "hasSessionFile": true,
  "isSmokeTest": false                // smoke-prompt heuristic (4006–4014)
}
```

**`GET /v1/codex/threads/:id`** (1485–1493, `threadDetailResponse`
3524–3593) — `:id` is URI-decoded then validated by `isSafeJobId`. Query:
`provider` filter. 200:

```json
{
  "thread": { …thread summary… },
  "messages": [{"role": "user|assistant", "timestamp": "…", "text": "…"}],
  "jobs": [ …compact job responses, newest first… ]
}
```

Messages come from the session transcript, bounded: last 1 MiB of the
`.jsonl` read, last 120 messages, each text summary-truncated (3906–3948);
injected context/skill-prefix messages are filtered from user prompts
(3969–3991). Chat threads return their stored messages with role
`user|assistant|status` and `"jobs": []` (3813–3826). Unknown id → 404
`thread not found`.

**`DELETE /v1/codex/threads/:id`** (1495–1503, `deleteThread` 3595–3658)
— query `workspaceId`, `provider` act as guards: the thread is only
deleted when it matches the filters (a mismatched filter yields 404 — see
test at server.test.mjs:1342). Deletes matched jobs (their JSON, logs,
attachments, artifacts — all rm'd only if inside the data dir, 3660–3697)
and the session transcript (only if inside `CODEX_HOME/sessions`). Chat
threads are handled by the same route (3828–3850); legacy null-workspace
chats are deletable only without a workspace filter. 200:

```json
{"deleted": true, "threadId": "<uuid>", "workspaceId": "scratch",
 "deletedJobs": 2, "deletedSessionFile": true,
 "deletedChatThread": true}   // present only for chat threads
```

Errors: 404 `thread not found`, 409 `thread has active jobs`.

### 1.14 `POST /v1/codex/transcriptions` (1505–1514, `transcribeAudio` 3159–3222)

Raw binary audio body (NOT multipart), capped at
`CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES` (413; empty → 400 `audio body is
required`, 1342–1368). Request headers: `content-type` (allowlisted audio
types, else coerced to `audio/wav`, 3250–3266) and optional
`x-audio-filename` (sanitized basename, default `phone-prompt.wav`,
3268–3272). The server forwards to the configured Azure Speech endpoint
server-side (key never exposed). 200:

```json
{"text": "…", "provider": "azure-speech", "model": "mai-transcribe-1",
 "audioBytes": 123456, "durationMilliseconds": 4200}
```

Errors: 503 `Azure Speech is not configured for transcription`, 502 for
upstream failure or empty transcript. Note: this is the ONLY `/v1/codex/*`
route excluded from dev-proxy forwarding (1627–1634).

### 1.15 Jobs

Job lifecycle statuses: `queued → running → succeeded | failed |
cancelled | timeout` (terminal set at 82). On boot, persisted `running`
jobs are marked `failed` with error `service restarted while job was
running` (1179–1215). Queue is FIFO by `createdAt` with
`CODEX_MAX_CONCURRENT` slots (4134–4141). Queue position is **not**
exposed (gap; see Part 2 §2.8).

**`GET /v1/codex/jobs`** (1516–1529) — query `workspaceId` (400 if
unknown), `provider` (`codex|claude|cursor`), `limit` (default 50, clamp
1–200). Newest-first, sliced; each entry is a **compact** job response
(4 KiB text fields). No offset/cursor (ambiguity A2).
200 `{"jobs": [ …job responses… ]}`.

**`POST /v1/codex/jobs`** (1531–1540, `createJob` 2329–2413) — request:

```json
{
  "workspaceId": "scratch",          // required, must resolve (static or dynamic)
  "prompt": "…",                      // required non-empty; ≤ body cap
  "provider": "codex",               // optional codex|claude|cursor (default codex)
  "model": "gpt-5-codex",            // optional; ^[A-Za-z0-9._:-]{1,100}$; claude aliases sonnet/opus/haiku resolve via env (99–104, 2431–2440)
  "reasoningEffort": "high",         // optional; codex only; low|medium|high|xhigh
  "permissionMode": "acceptEdits",   // optional; claude only; acceptEdits|auto|bypassPermissions|default|dontAsk|plan (87)
  "timeoutMs": 600000,                // optional; >0; clamped to [1000, CODEX_MAX_TIMEOUT_MS]
  "resumeSessionId": "<uuid>",        // optional; session must exist, match provider AND workspace (2349–2361)
  "skills": ["superpowers:tdd"],     // optional; ≤6; each must exist for provider (2681–2710)
  "attachments": [                    // optional; ≤6 files, ≤8 MiB each, ≤18 MiB total
    {"filename": "shot.png", "contentType": "image/png",
     "dataBase64": "…"}               // std or url-safe base64
  ]
}
```

Response: **202** with a preview-shaped job response (§1.16). Effects:
attachments are written under the data dir and their runner-local paths
appended to the prompt manifest (2781–2787); selected skill bodies are
inlined into the prompt (≤ 20 KiB each, 2789–2811); the job is persisted
and queued; audit `job_created`.

Provider invocation (contract-relevant): prompt is delivered on **stdin**
for codex/claude, as an argv for cursor (4229, 4344–4350); codex runs
`codex exec -C <workspace> --skip-git-repo-check --ignore-rules` (+
`--dangerously-bypass-approvals-and-sandbox` in dangerous mode, else
`--sandbox workspace-write -a never`) with `-o <resultPath>` (4303–4317);
claude runs `claude --print` (+ `--dangerously-skip-permissions`) with
`--session-id <uuid>` server-minted up front, result read from stdout
(4331–4342); cursor runs `cursor-agent -p --force --trust --workspace …
--output-format json`, result parsed from the JSON envelope incl.
`session_id` (4344–4350, 4695–4706). AWS/Bedrock credentials are scrubbed
from the child env for direct claude/cursor jobs (4244–4300).

Session-id semantics: claude = server-minted upfront; cursor = parsed from
result JSON; codex = discovered post-run by diffing the workspace's session
files (exactly one new file, 4769–4773); resume jobs keep the resumed id.

**`GET /v1/codex/jobs/:id`** (1560–1569) — 200 job response. Shape:
`preview` by default; `full` when `?full=1|true|yes|on` or
`?include=fullLogs` (1616–1625). 404 on unknown/unsafe id.

**`POST /v1/codex/jobs/:id/cancel`** (1571–1574, `cancelJob` 4100–4132)
— queued job: immediately `cancelled` (error `job cancelled before
start`, durationMs 0). Running job: sets error `cancellation requested`,
SIGTERM then SIGKILL after 5 s; terminal state becomes `cancelled` with
error `job cancelled`. Response **202** with the (possibly still
`running`) job response. Errors: 409 `job is already finished`, 409 `job
is not active`, 404.

### 1.16 Job response shape (`toJobResponse`, 4787–4855)

Returned by job GET/POST/cancel, job lists, thread details, and the SSE
`done` event. Text fields are shaped per response mode
(`responseShape`, 1606–1614): `full` = entire log (`byteLimit` for
preview fields), `preview` = 64 KiB, `compact` = 4 KiB. stdout/stderr are
**suffix** slices; result is a prefix slice (4793–4815).

```json
{
  "id": "<uuid>", "status": "succeeded",
  "provider": "codex",
  "workspaceId": "scratch", "workspaceName": "Scratch",
  "prompt": "…",                       // original prompt, unbounded (A5)
  "attachments": [{"filename","contentType","bytes","path"}],
  "artifacts": [ …public artifacts, §1.17… ],
  "createdAt": "…", "updatedAt": "…", "startedAt": "…", "finishedAt": "…",
  "durationMs": 5120,                  // live-computed while running (4830)
  "exitCode": 0, "timedOut": false,
  "logsIncluded": "preview",          // "full" | "preview" | "compact"
  "stdout": "…", "stdoutPreview": "…", "stdoutBytes": 123, "stdoutTruncated": false,
  "stderr": "…", "stderrPreview": "…", "stderrBytes": 0,  "stderrTruncated": false,
  "result": "…", "resultPreview": "…", "resultBytes": 456, "resultTruncated": false,
  "error": "",                         // cleaned; "" when none (A6)
  "certSubject": "CN=allowed",
  "model": null, "reasoningEffort": null, "permissionMode": null,
  "skills": [],
  "resumeSessionId": null,
  "sessionId": "<uuid>"                // null until discovered
}
```

Failure semantics (4626–4693): non-zero exit → `failed` with `error` =
stderr, else the provider's stdout, else `"<provider> exited with code
<n>[ and signal <sig>]"`; claude/cursor exiting 0 with empty output →
`failed` with `"<Provider> exited successfully without producing
output."`; timeout → `timeout` / `job timed out`; spawn failure → `failed`
with the spawn error message.

`attachments[].path` intentionally exposes the runner-local path (the
prompt references it); artifact paths are NOT exposed (A7).

### 1.17 Artifacts

On success, fenced code blocks in the result are extracted to files
(≤ 12 artifacts, ≤ 1 MiB each, ≤ 5 MiB total; 2813–2853). Filenames from
fence info are sanitized; path separators/`..`/dotfiles/secret-suffix
names (`.env,.pem,.key,.p12,.crt,.csr,.mobileconfig`) fall back to
`artifact-NNN.<ext>` (2940–2957). When HTML + CSS/JS blocks coexist, an
assembled `preview.html` artifact is appended (3102–3128).

Public artifact shape (in job responses; `publicArtifactResponses`,
4897–4909):

```json
{"id": "artifact-001", "kind": "code",          // code|staticPreview|document
 "filename": "index.html", "title": "index.html",
 "language": "html", "contentType": "text/html; charset=utf-8",
 "bytes": 2048,
 "rawURL": "/v1/codex/jobs/<jobId>/artifacts/artifact-001/raw",
 "previewURL": "/v1/codex/jobs/<jobId>/artifacts/artifact-001/preview"}  // null unless html/svg/markdown
```

**`GET /v1/codex/jobs/:id/artifacts/:artifactId/raw`** (1542–1549,
4918–4941) — bytes with the artifact contentType,
`content-disposition: attachment`, nosniff.

**`GET …/preview`** — sandboxed HTML wrapper: outer chrome +
`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc=…>`
with an injected CSP `default-src 'none'; img-src data: blob:; style-src
'unsafe-inline'; script-src 'unsafe-inline'; font-src data:` (4947–4990).
Markdown renders as escaped `<pre>`; non-previewable artifacts → 404
`artifact preview not available`.

Persisted artifact metadata is re-sanitized on every load, and any artifact
whose stored path is not inside that job's artifact directory is dropped
(4869–4916).

### 1.18 `GET /v1/codex/jobs/:id/stream` — job SSE (1551–1558, 4440–4493)

Query: `stdoutOffset`, `stderrOffset` — byte offsets into the persisted
log files (≥ 0, else 400). Concurrency cap: `CODEX_MAX_JOB_STREAMS`
simultaneous streams process-wide, else 503 `too many concurrent job
streams`.

Event grammar:

| event | data | notes |
|---|---|---|
| `status` | `jobStatusPayload` (below) | immediately on connect, and on every state transition (4487, 4613–4624) |
| `stdout` | `{"offset": 0, "text": "…"}` | replay from requested offset, then live follow; `offset` is the real byte offset of this chunk's first byte |
| `stderr` | `{"offset": 0, "text": "…"}` | same semantics |
| `done` | full **preview** job response | terminal; the server then closes the stream (4565–4582) |
| *(comment)* | `: heartbeat` | every `CODEX_JOB_STREAM_HEARTBEAT_MS` (4471–4483) |

`jobStatusPayload` (4406–4420):

```json
{"id","status","provider","workspaceId","createdAt","startedAt",
 "finishedAt","updatedAt","exitCode","timedOut","error"}
```

Guarantees:
- Chunks are ≤ 64 KiB and split on UTF-8 code-point boundaries
  (4372, 4386–4404); `offset + byteLength(text)` = next chunk's offset —
  clients resume with `?stdoutOffset=&stderrOffset=` and receive **no
  duplicate bytes** (tested at server.test.mjs:3779).
- Initial replay is bounded to the last `CODEX_MAX_OUTPUT_BYTES` per
  channel; skipped bytes are visible via the first event's offset
  (4498–4510).
- Connecting to an already-terminal job replays then closes with `done`.
- Events only fire after bytes are flushed to the persisted log
  (4188–4198), so offsets are always consistent with later replays.
- There are **no SSE `id:` lines and no `Last-Event-ID` support** today —
  resume is via query offsets only (extended in Part 2 §2.1).

### 1.19 Audit log (not an HTTP surface, frozen behavior)

Append-only `audit.jsonl` in the data dir (1236–1251): `{ts, event,
jobId, status, workspaceId, certSubject, …extra}`. Events include
`job_created/started/finished/cancelled/cancel_requested/timeout_requested`,
`stale_running_marked_failed`, `thread_deleted`, `chat_completed`,
`transcription_created`, `artifact_extraction_failed`,
`job_stdin_write_failed`, `load_job_failed`, `remove_path_failed`,
`runtime_cache_prune_failed`. No prompt/result content is logged.

### 1.20 Dev proxy mode (1627–1695)

When `CODEX_PROXY_BASE_URL` is set, GET/POST requests to `/v1/codex/*`
**except** `/v1/codex/transcriptions` are forwarded to the remote base URL
(with optional client cert/key from `CODEX_PROXY_CLIENT_CERT/KEY`), after
local auth. SSE responses are piped unbuffered. Routes matched before the
proxy check are still served locally: `health`, `ui`, `models`, `chat`
(1406–1421 vs 1423). DELETE (threads) is never proxied. This is a local
development convenience, not part of the product surface.

---

## Part 2 — v1 ADDITIONS (specified, NOT yet implemented)

Everything below is new surface designed for relayd v1. Conventions carried
over: camelCase JSON, `{"error": "…"}` failures, `sendSse` event grammar,
bounded lists with `limit` + `truncated`, ISO-8601 UTC timestamps,
UUID ids, mTLS-only data-path auth (client cert required in both listen
modes; no tokens). New route namespaces drop the legacy `/codex` segment;
existing `/v1/codex/*` routes remain frozen as-is.

### 2.1 Resumable SSE via `Last-Event-ID`

Applies to `GET /v1/codex/jobs/:id/stream`, `POST /v1/codex/chat`
responses, and the new `/v1/events` feed.

- Every SSE event gains an `id:` line before `event:`.
- **Job stream** event id encodes replay state:
  `"<stdoutOffset>:<stderrOffset>:<seq>"` where the offsets are the byte
  offsets *after* applying the event and `seq` is a per-connection
  monotonic counter (heartbeat comments carry no id). On reconnect the
  client sends header `Last-Event-ID: <id>`; the server parses the two
  offsets and treats them exactly like `?stdoutOffset=&stderrOffset=`.
  Precedence: `Last-Event-ID` > query offsets. A malformed header → 400
  `last-event-id is invalid`.
- **Events feed** ids are the integer event cursor (§2.2);
  `Last-Event-ID: <n>` is equivalent to `?since=<n>`.
- **Chat** streams get `id: <n>` sequence numbers but replay is NOT
  supported (chat is regenerative); a reconnect with `Last-Event-ID` on
  chat returns 409 `chat streams cannot be resumed`. Declared via
  capability `resumableSse: {"jobs": true, "events": true, "chat": false}`.

### 2.2 `GET /v1/events?since=<cursor>` — node event feed (SSE)

One stream for the whole node (the app's inbox/push-sync backbone; the
same bus feeds cloud push fanout with minimal payloads).

- Query: `since` — the last processed integer cursor (or
  `Last-Event-ID`). Omitted/0 = "now" (no replay). Retention is bounded
  (target: 7 days or 10,000 events, whichever is smaller); a `since` older
  than retention triggers an immediate `reset` event telling the client to
  resync via the list endpoints, then live follow.
- Events are strictly ordered by cursor; each carries `id: <cursor>`.

| event | data |
|---|---|
| `hello` | `{"cursor": 1234, "nodeTime": "…Z"}` — first event, current cursor |
| `reset` | `{"reason": "retention", "cursor": 1234}` |
| `job.state` | `jobStatusPayload` (§1.18) + `{"queuePosition": n\|null}` |
| `job.needs_input` | needs-input payload (§2.7) |
| `job.silence` | `{"id","workspaceId","silentForMs"}` — long-running job with no output (threshold server-configured) |
| `node.health` | `healthPayload` (§1.5) + `{"diskFreeBytes": n}` |
| `device.paired` / `device.revoked` | public device record (§2.4) |
| `pairing.rejected` | `{"sessionId","slot","reason"}` — a pairing blob failed its MAC check; no certificate was issued (§2.3) |
| `harness.changed` | harness status record (§2.5) |
| *(comment)* | `: heartbeat` every heartbeat interval |

Errors: 400 `since must be a non-negative integer`; 503 stream cap shared
with job streams.

### 2.3 Pairing — protocol v2

Trust model per product plan §4.3: the node owns a CA; the phone mints a
Secure Enclave P-256 key and sends a CSR through the pairing channel; the
node issues the device cert; **no private key ever transits any channel**.

#### Roles

The **node** originates the pairing secret — `relayd pair` prints a short
code and a long token, both of which redeem the same session. The **phone**
receives that secret out of band (QR scan or typed code). The **cloud**, when
the phone cannot reach the node directly, relays two opaque blobs and is told
only a derived `authToken` — never the secret.

#### Key derivation (both peers; the cloud cannot perform it)

```
secret     = the long pairing token (>= 24 random bytes, base64url)
authToken  = base64url( sha256( "relay-pair-auth-v1" || 0x00 || secret ) )
macKey     =           hmac-sha256( key = secret, msg = "relay-pair-mac-v1" )
```

The cloud is given only `authToken` and stores only `sha256(authToken)` at
rest, so it possesses neither `secret` nor `macKey`.

#### Blob integrity

Each relayed blob carries a tag computed by its **sender** and verified by the
receiving **peer**:

```
tag = base64( hmac-sha256( key = macKey, msg = slotName || 0x00 || blob ) )
slotName ∈ { "device-blob", "node-blob" }   // exact strings; binds the direction
```

Tags are compared with `crypto.timingSafeEqual` over the decoded 32 bytes.
The cloud stores `{blob, tag}` verbatim, treats both as opaque, and validates
neither — it cannot.

**Why this exists.** Before v2 the cloud generated the pairing secret and
handed out the plaintext, and blobs had no integrity tag, no put-once and no
binding. A compromised control plane could overwrite the stored device-blob
with **its own CSR** before the node read it; the node's CA signed it and
returned a valid mTLS client certificate — full read/write access to the
user's files and job submission. The cloud never minted the certificate
itself, it *induced the node to mint one*. An adversarial audit ran exactly
that attack. Opacity is a privacy property; the MAC is the integrity property,
and only the MAC makes the substitution detectable by the peers without
trusting the cloud.

**Failure behavior on the node (mandatory).** If the device-blob tag does not
verify — wrong tag, missing tag, flipped byte, blob substituted in transit —
then, *before the CSR is parsed and before anything is issued*:

- the pairing session is **consumed** (a failed exchange burns the code, so an
  attacker cannot retry against it),
- the audit event `pairing_blob_auth_failed` is written and
  `pairing.rejected` is emitted on the event feed,
- **no certificate is issued**, no device row is created, no subject is
  allowlisted, and no node-blob is produced,
- the caller gets **403** `pairing blob authentication failed`.

#### `POST /v1/pair`

The ONE endpoint not authenticated by a client certificate. It is served on
its **own listener** owned by the daemon (`RELAYD_PAIRING_*`) and is **never**
routable on the mTLS data listener — the data router refuses `/v1/pair` with a
404 before `authorize` runs. Authentication is the single-use pairing secret
plus the blob tag.

```json
// request
{"v": 2,
 "code": "WXYZ-1234",          // the short code, or the long token from the QR/link
 "blob": "<base64 device blob>",
 "tag":  "<base64 tag over "device-blob">"}

// device blob bytes = UTF-8 JSON
{"csrPem": "-----BEGIN CERTIFICATE REQUEST-----…",
 "deviceName": "<device-name>",
 "platform": "ios"}            // ios|macos|cli|other

// 201 response
{"v": 2,
 "blob": "<base64 node blob>",
 "tag":  "<base64 tag over "node-blob">"}

// node blob bytes = UTF-8 JSON (byte-for-byte the v1 201 body)
{"deviceId": "<uuid>",
 "certificatePem": "-----BEGIN CERTIFICATE-----…",
 "caPem": "-----BEGIN CERTIFICATE-----…",   // the node CA to pin
 "nodeId": "<node-id>", "nodeName": "<node-name>",
 "certSerial": "…", "notAfter": "…Z"}
```

The phone MUST verify the node-blob tag before parsing or trusting the
contents. The response carries no private key material of any kind — the
device private key never leaves the device.

Rules: the code is single-use and expiring, with a 15-minute TTL (403
`pairing code is invalid or expired`; **a used code is indistinguishable from
an expired one**); redemption is **atomic**, so two concurrent attempts on one
code cannot both succeed — exactly one gets 201, the other 403; CSR key type
must be P-256/Ed25519 (400 `csr is unsupported`); malformed input is 400
(`code is required`, `blob is required`, `tag is required`, `blob is
invalid`); issuance is rate-limited (429 `too many pairing attempts`, 10
attempts per 5-minute window). Audit: `pairing_session_created`,
`device_paired`, `pairing_blob_auth_failed`, `cert_subject_allowlisted`.

#### Session storage (why `relayd pair` works on a systemd install)

Pairing sessions are **persisted in the store**, not held in a process-local
map. `relayd pair` runs in a short-lived CLI process and exits; the daemon
that serves `POST /v1/pair` is a different process. Both backends implement an
atomic single-winner claim:

- `json` — one file per session under `<dataDir>/pairing/` (dir 0700, files
  0600); the claim is `unlink()`, and the loser of a race gets `ENOENT`
- `sqlite` — a `pairing_sessions` row; the claim is a single-row `DELETE`, and
  the loser sees `changes === 0`

Consumption deletes the record, so a used code cannot be replayed after a
daemon restart. Expired sessions are pruned at daemon start and on every
`createPairingSession`.

#### Cloud rendezvous (`product/cloud`, when the phone cannot reach the node)

`POST /v1/pairing/sessions` (control-plane session bearer) takes
`{"authToken"}` from the caller and returns `{"pairingId","expiresAt"}` — the
cloud never generates a secret and returns nothing secret. Blob slots are
addressed by `/v1/pairing/sessions/:id/{device-blob,node-blob}`, authenticated
with `X-Pairing-Auth: <authToken>`, with the tag in `X-Pairing-Tag`. Each slot
is **put-once** (409 `slot_already_written`; never an overwrite); once both
slots have been read the session is closed and the blobs are deleted rather
than lingering for the rest of the TTL; blobs are capped at 64 KiB (413) and a
per-account cap bounds live sessions (429 `too_many_pairing_sessions`).

#### Trial pairing (trial tier only — the node mints the certificate)

`relayd/src/trialpair.mjs` (`runTrialPairing`) is a **documented delta** from
the CSR flow above, used only for cloud-provisioned trial sandboxes (see
`revamp/07-trial-sandbox-plan.md` "Implementation status" for the full
rationale). iOS has no CSR stack yet, so instead of the phone generating a
keypair and sending a CSR:

1. The phone posts a small JSON device-blob — `{"deviceName", "platform"}`,
   **no CSR** — to `POST /v1/pairing/sessions/:id/device-blob`, MAC-tagged
   exactly as in the BYO flow above.
2. The node (inside `relayd enroll`, below) polls
   `GET /v1/pairing/sessions/:id/device-blob` until it appears, verifies the
   tag, then **mints the EC keypair itself**, issues the certificate against
   its own CA (`identity.mjs`'s `issueDeviceCert`), and packages
   key+cert+CA-pem into a **passphrase-protected PKCS#12** via `openssl
   pkcs12 -export`.
3. The passphrase is `hex(hmac-sha256(key = secret, msg =
   "relay-trial-p12-v1"))` — derived from the same pairing `secret` that
   derives `authToken`/`macKey` above. **Unlike BYO, the cloud on the trial
   tier is not blind to this secret.** The pairing-*session* endpoint
   (`POST /v1/pairing/sessions`) is told only `authToken`, exactly as in the
   BYO flow above — but the separate, trial-only `POST /v1/trial-nodes` call
   takes the raw `secret` directly in its body as `pairingSecret`
   (`product/cloud/src/server.js`), because the cloud needs it to hand to the
   sandbox in step 4 below. The cloud can therefore compute both `macKey` and
   this passphrase for a trial node; nothing in this delta is
   zero-knowledge.
4. The p12 bytes are posted as the node-blob (`POST .../node-blob`,
   MAC-tagged with the same `blobTag`/`NODE_SLOT` scheme as BYO), and the
   temporary key/CSR/cert/CA/p12 files are removed from `tmp/` whether
   pairing succeeds or fails.

The device private key still never transits any channel except embedded
inside the passphrase-protected p12 — but on this tier it is the **node**,
not the phone, that generated it, and the cloud transported the pairing
secret into the sandbox as part of provisioning
(`RELAYD_ENROLL_PAIRING_ID`/`RELAYD_ENROLL_PAIRING_SECRET` env vars, cleared
before the daemon starts — see `product/trial/start.sh`). This is acceptable
only because trial sandboxes already run on operator infrastructure and the
operator is already inside the trust boundary for trial nodes; **BYO
installs must never receive a secret from the cloud this way** — the BYO
cloud rendezvous is told only `authToken` and has no path to the raw secret
at all — which is why this lives in a module separate from `pairing.mjs` and
is reachable only through `relayd enroll`.

#### CLI contract

`relayd pair` prints, on stdout:

```
Pairing code (single use, expires in 15 minutes):

    WXYZ-1234

  Pair at: http://<node-address>:8788/v1/pair
  Link:    https://get.<domain>/pair#node=<node-id>&token=<token>
  otpauth: otpauth://relay-pair/<node-name>?secret=<token>&issuer=relayd&node=<node-id>
  Expires: <iso8601>
```

The code/token pair is the one deliberate secret the CLI prints — it *is* the
credential the user carries to the phone, single-use with a 15-minute TTL. No
key material is ever printed. The session is redeemable by the already-running
daemon, so the command does not need to stay open.

#### `relayd enroll` — trial node bootstrap

Non-interactive, env-driven (never argv, never printed): initializes the node
identity if missing (idempotent — repeat calls reuse the same node id), then
registers its public key with the control plane using a single-use enroll
token.

```
RELAYD_ENROLL_URL              required — cloud base URL
RELAYD_ENROLL_TOKEN            required — single-use token minted by
                                POST /v1/trial-nodes
RELAYD_ENROLL_PAIRING_ID       optional — triggers trial pairing (above)
                                after enrollment succeeds; must be set
                                together with RELAYD_ENROLL_PAIRING_SECRET
RELAYD_ENROLL_PAIRING_SECRET   optional — the pairing secret; both this and
                                the id are wiped from the environment by
                                product/trial/start.sh before the daemon
                                (`relayd run --mode tunneled`) execs
```

`relayd enroll` calls `POST /v1/trial-nodes/enroll` with
`{token, nodeId, pubkey, version}`; a 200 response carries `{ok, sni}`. The
cloud verifies the token against `trial_nodes.enroll_token_hash` (401
`invalid_enroll_token` if it does not match or the trial is not in the
`creating` state), validates the node id shape and pubkey (400), rejects a
duplicate node id (409 `node_exists`), then registers the node under the
`trial` kind and burns the token. The CLI prints only `enrolled <nodeId>
sni=<sni>` (and, if pairing ran, `trial device paired: <deviceId>`) — no
secret material is ever logged.

### 2.4 Device list / revoke

Data-path routes (mTLS, any enrolled device may manage devices — the
"handled from another enrolled device" recovery path).

**`GET /v1/devices`** → 200

```json
{"devices": [{"id": "<uuid>", "name": "<device-name>",
  "platform": "ios", "certSerial": "…",
  "createdAt": "…Z", "lastSeenAt": "…Z",
  "revoked": false, "revokedAt": null,
  "isCaller": true}]}                 // matches the requesting cert
```

**`POST /v1/devices/:id/revoke`** — body optional `{"force": true}`.
Adds the cert serial to the node CRL; the TLS layer rejects it from the
next handshake. 200 `{"id","revoked":true,"revokedAt"}`. Errors: 404;
409 `device is already revoked`; 409 `revoking the last device would lock
out this node` unless `force:true` (recovery then requires `relayd pair`
on the box). Audit: `device_revoked`. Emits `device.revoked` on the event
feed.

### 2.5 Harness manager

**`GET /v1/harness`** → detect installed CLIs, versions, login state,
capability flags (the catalog honesty rules extended):

```json
{"harnesses": [{
  "provider": "claude",              // codex|claude|cursor
  "installed": true, "version": "2.1.0",
  "loggedIn": true, "authKind": "subscription",   // subscription|api|unknown
  "supportsApprovals": true, "supportsResume": true, "supportsChat": false,
  "lastSmoke": {"status": "succeeded", "finishedAt": "…Z", "jobId": "<uuid>"}  // or null
}]}
```

Long-running harness actions are modeled as **operations**, not jobs
(jobs stay workspace-scoped agent tasks):

- **`POST /v1/harness/:provider/install`** → 202 `{op}`
- **`POST /v1/harness/:provider/login`** → 202 `{op}` — relayd spawns
  the CLI's device-code flow headlessly and parses the verification
  URL/code out of its output; credentials never transit the API — the
  URL/code are the provider's own public device-code artifacts.
- **`POST /v1/harness/:provider/smoke`** → 202 `{op}` — runs the smoke
  matrix entry and updates `lastSmoke`.
- **`GET /v1/harness/ops/:id`** → 200 `{op}`; **`GET /v1/harness/ops`**
  → recent ops, bounded (`limit` clamp 1–200).

Operation shape:

```json
{"id": "<uuid>", "provider": "codex",
 "action": "login",                  // install|login|smoke
 "status": "waiting_for_user",       // queued|running|waiting_for_user|succeeded|failed|expired|cancelled
 "verificationUrl": "https://…",     // login only, while waiting_for_user
 "userCode": "ABCD-EFGH",            // login only
 "expiresAt": "…Z",
 "createdAt": "…Z", "updatedAt": "…Z", "finishedAt": null,
 "error": null, "logTail": "…"}      // bounded like job logs
```

`logTail` is raw provider-CLI stdout/stderr, so it is passed through a
credential-redaction filter before it leaves the node: well-known secret
shapes (`sk-…`, `ghp_/gho_/github_pat_…`, `xox?-…`, `AKIA…`, `Bearer
<token>`, and PEM `PRIVATE KEY` blocks) are replaced with `[redacted]`.
The device-code artifacts (`verificationUrl`, `userCode`) are parsed
from the unredacted stream and are never affected.

Errors: 400 unknown provider; 409 `a <action> operation is already
running for <provider>`. Transitions emit `harness.changed` events.

### 2.6 `needs_input` job state + respond endpoint

New **non-terminal** job status `needs_input` (extends the §1.15 set;
only reachable when the provider adapter has `supportsApprovals` and the
job was created with `"interactive": true` — full-auto-in-the-jail stays
the default). While blocked, the job's `timeoutMs` clock is suspended;
a separate `inputTimeoutMs` (default: none — pause indefinitely) can
auto-deny.

Job responses and `jobStatusPayload` gain:

```json
"pendingInput": {                    // null unless status == "needs_input"
  "id": "<uuid>",                     // request id
  "kind": "approval",                // approval|question
  "prompt": "Claude wants to run: rm -rf node_modules",
  "toolName": "Bash",                // optional
  "options": [{"id": "allow", "label": "Allow"},
              {"id": "deny", "label": "Deny"}],   // empty for free-text questions
  "requestedAt": "…Z", "expiresAt": null
}
```

**`POST /v1/codex/jobs/:id/respond`**

```json
{"requestId": "<uuid>", "optionId": "allow"}   // or {"requestId": …, "text": "use pnpm instead"}
```

→ 202 with the job response (status returns to `running`). Errors:
404 job; 409 `job is not awaiting input`; 400 `requestId does not match
the pending request` (stale approvals must not apply to a newer prompt);
400 `optionId is not one of the offered options`; 400 `text is required
for question inputs`.

SSE: the job stream emits `needs_input` (payload above) and subsequent
`status` events; the events feed emits `job.needs_input` (drives the
actionable push). Cancel remains valid from `needs_input`.

### 2.7 `GET /v1/meta` — capability negotiation

Authenticated. The app's first call after connect; everything optional is
discoverable here so older/newer app+node pairs degrade gracefully.

```json
{
  "api": "relay-node",
  "apiVersion": 1,                   // contract major (this document)
  "version": "1.0.3",                // relayd build
  "nodeId": "<node-id>", "nodeName": "my-box",
  "listenMode": "tunneled",          // direct|tunneled
  "capabilities": {
    "chat": true, "jobs": true, "threads": true, "fs": true,
    "workspaces": true, "skills": true, "artifacts": true,
    "transcriptions": false,          // false when Azure Speech absent (replaced by on-device transcription in the product app)
    "events": true,
    "resumableSse": {"jobs": true, "events": true, "chat": false},
    "needsInput": true,
    "pairing": true, "devices": true, "harness": true,
    "worktreeHandoff": false
  },
  "providers": [ …same records as GET /v1/harness… ],
  "limits": {
    "maxBodyBytes": 31457280, "maxJobAttachments": 6,
    "maxJobAttachmentBytes": 8388608, "maxJobAttachmentTotalBytes": 18874368,
    "maxTimeoutMs": 1800000, "defaultTimeoutMs": 600000,
    "maxFsReadBytes": 1048576, "maxFsFileBytes": 26214400,
    "maxFsListEntries": 500, "maxJobStreams": 8,
    "responseOutputBytes": 65536, "listOutputBytes": 4096
  }
}
```

Unknown capability keys must be ignored by clients; absent keys mean
`false`. `GET /v1/meta` on a legacy node 404s — the app treats 404 as
"frozen v1 surface only, no additions".

### 2.8 Queue position (small compatible extension)

`jobStatusPayload`, job responses, and `job.state` events gain
`"queuePosition": n` (1-based) while `status == "queued"`, `null`
otherwise — the product plan's "queue with visible position" without a new
endpoint. Additive field; frozen clients ignore it.

### 2.9 `GET /v1/export.tar` — whole-jail workspace export

Implemented (`relayd/src/fsapi.mjs:392`, `serveExportTar`; routed in
`src/additions.mjs`). Streams every readable file under
`workspaceBrowseRoot` as a single tar archive — the mechanism behind the
trial-sandbox "export my files" flow (`revamp/07-trial-sandbox-plan.md`),
though the route itself is not trial-specific: any node exposes it.

Auth: same mTLS `authorize()` gate as the rest of the data path (applied
before `handleAdditionRoutes` dispatches to this route, `server.mjs:60`,
`:240`) — no separate credential.

Response: `200`, `content-type: application/x-tar`,
`cache-control: no-store`, `x-content-type-options: nosniff`,
`content-disposition: attachment; filename="relay-workspaces.tar"`. No
`Range` support — the whole archive streams as one response.

Entry selection mirrors `fs/list`'s jail-safe walk (`fsEntryForDirent`):
symlinks that escape `workspaceBrowseRoot` are dropped, and any file that
matches the secret read-denylist (§1.3) is excluded from the archive
**before** `tar` ever sees it — the export can never surface a file that
`fs/file` would 403 on. Only files are added (directories are walked, not
archived as entries).

Size bound: `maxExportBytes` = 512 MiB. The total is computed from `stat()`
sizes and checked **before any response header is written**, so an
oversized jail fails cleanly with `413 export_too_large` instead of dying
partway through an already-started stream.

**Security note — `--null` is load-bearing, not stylistic.** The archive is
built by spawning `tar -cf - -C <workspaceBrowseRoot> --null -T -` and
writing the entry list to the child's stdin (not argv — a large jail can
list more files than a platform's `ARG_MAX` allows). The list is
**NUL-separated**, never newline-separated: both bsdtar and GNU tar treat a
bare `-C` line inside a `-T` file list as a live "change directory"
directive, and workspace filenames are attacker-controlled (only `/` is
illegal in a POSIX filename, so a name can contain an embedded newline).
A newline-joined list lets a crafted filename inject a `-C\n..\n<target>`
directive and walk `tar` outside the jail. `--null` disables that directive
parsing entirely, closing the escape. `--null` alone is not sufficient,
though: a list field that is literally `..` still escapes `-C` on both tar
implementations. What actually makes this safe is that every field is
`entry.path`, derived from an already jail-realpath-contained path — if this
list ever accepts a less-trusted path source, restoring that containment,
not the `--null` flag, is the invariant to re-establish. Do not "simplify"
this to a plain newline-joined list.

Failure handling: a spawn failure or an empty jail can close the tar
child's stdin pipe before the list finishes writing; that surfaces as
`EPIPE`, which is swallowed rather than crashing the daemon (mirrors the
job-stdin guard in `jobs.mjs`). If the client disconnects mid-stream, the
still-running `tar` child is killed.

---

## Part 3 — Ambiguities & inconsistencies found during the freeze

- **A1 — `workspaceCount` undercounts.** `healthPayload` reports
  `workspaces.size` (static registry only, 1588), while
  `GET /v1/codex/workspaces` returns static ∪ dynamic. A client comparing
  the two sees a mismatch after any `workspaces/select`.
- **A2 — job list has no pagination.** `GET /v1/codex/jobs` supports only
  `limit` (max 200) with no offset/cursor and no `truncated` flag —
  history beyond the newest 200 jobs is unreachable via the API (contrast
  with `fs/list`, which has offset/limit/total/truncated).
- **A3 — `workspace-dirs` truncates silently.** The listing stops at
  `CODEX_MAX_WORKSPACE_DIR_ENTRIES` (100) and search recursion at depth 8
  with no indicator in the response (552–596). `fs/list` is the corrected
  design; `workspace-dirs` is frozen for the legacy client (golden test).
- **A4 — method mismatch = 404, never 405.** e.g. `DELETE
  /v1/codex/jobs/:id` or `GET …/cancel` fall through to `not found`
  (1560–1577). Frozen as-is; the conformance suite should assert 404.
- **A5 — `prompt` is unbounded in every job response shape,** including
  `compact` list entries (4823): a 30 MiB prompt echoes back in
  `GET /v1/codex/jobs`. Log fields are bounded; the prompt is not.
- **A6 — `error` field inconsistency.** `toJobResponse.error` is `""`
  when absent (4846) while `jobStatusPayload.error` is `null` (4418);
  thread summaries use `null`. Clients must accept both.
- **A7 — path exposure asymmetry.** `attachments[].path` exposes
  runner-local paths (deliberate — the prompt manifest references them,
  2781–2787) while `artifacts[]` strips `path` from public responses
  (4897–4909). Worth an explicit statement in v1 docs rather than an
  accident.
- **A8 — `isSafeJobId` is looser than UUID.** `/^[a-f0-9-]{36}$/`
  (1598) accepts any 36-char hex/hyphen arrangement. Harmless (ids are
  server-minted) but the conformance suite should not assert stricter.
- **A9 — chat error grammar.** On upstream failure mid-stream the server
  emits `error` and ends without `done` (1751–1757); on abort it emits
  nothing. Clients must treat stream close without `done` as failure.
- **A10 — codex chat is not incremental.** The whole answer arrives as
  one `delta` (1962–1967). Grammar-compatible with streaming clients but
  worth documenting so UX doesn't assume token streaming.
- **A11 — dev proxy split-brain.** In proxy mode `health/ui/models/chat`
  are served locally while the rest forwards (route order 1406–1425), and
  DELETE is never forwarded — thread deletion hits the local instance.
  Acceptable for a dev tool; must not survive into the relayd router.
- **A12 — `POST /v1/codex/jobs/:id` (no action) is unreachable** by the
  `jobMatch` regex path since only GET (detail) and POST+cancel are
  handled; a bare POST 404s. Fine, but the regex accepting `(?:\/(cancel))?`
  invites accidental widening in a port — the conformance suite pins it.
- **A13 — timeout clamp is silent.** `timeoutMs` below 1000 or above
  `CODEX_MAX_TIMEOUT_MS` is clamped, not rejected (2370); only
  non-positive/non-numeric values 400. Freeze as-is.
- **A14 — `GET /v1/codex/sessions` vs threads overlap.** Threads is a
  strict superset (sessions ∪ jobs ∪ chats). The iOS app uses threads;
  sessions survives for the legacy UI. Candidate for deprecation in v2,
  kept frozen in v1.

---

## Conformance notes

- Baseline suite: `relay-server/codex-api-deploy/server.test.mjs` —
  59 `node:test` tests spawning the real server on a loopback port with
  fake harness binaries. W0 promotes this file into an
  implementation-agnostic suite (parameterize the base URL; keep the fake
  binaries) so the Node relayd and the later Go port run identically
  against this document.
- Anything in Part 1 is frozen: a change that alters any documented shape,
  status code, header, ordering, bound, or SSE grammar is a breaking
  change and requires a v2 route, not an edit here.
- Part 2 additions are additive-only: new routes, new event names, new
  optional fields. Frozen clients must keep working against a node that
  implements all of Part 2.
