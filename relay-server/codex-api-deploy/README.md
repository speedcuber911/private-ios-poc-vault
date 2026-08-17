# Codex API Deploy Files

## Relay native controls

The production job path defaults to `RELAYD_CODEX_TRANSPORT=app-server`. Codex jobs use
`codex app-server --stdio` for streamed items and real command/file approvals. Claude
Code remains on the user's direct CLI subscription and uses Relay's local MCP permission
prompt tool; this feature does not route Claude through Bedrock.

`ops/install-codex-api.sh` installs the runtime helpers under
`/opt/codex-api/helpers` and prepares `/var/lib/codex-api/approvals` with private
permissions. The phone receives only sanitized approval metadata; auth state stays in
the isolated runner home.

`RELAYD_CODEX_TRANSPORT=exec` is retained as a compatibility escape hatch and for legacy
fixtures. That transport cannot provide interactive phone approvals.

This directory contains the deployable files for the async Codex/Claude/Cursor/Kimi job
service.

## Files

- `server.mjs`: Node HTTP service with mTLS header auth, workspace registry,
  provider-locked resumable-session metadata, persistent jobs, stdout/stderr
  logs, audit JSONL, timeout, cancel, and FIFO worker execution.
- `server.test.mjs`: local tests that use fake provider binaries.
- `codex-api.env.example`: non-secret environment file template for
  `/etc/codex-api.env`.
- `codex-api.nginx.conf.template`: owner-specific nginx virtual host template.
- `codex-api.nginx.conf`: example rendered nginx virtual host.
- `codex-api.service`: systemd unit for `codex-runner`.

## Local Check

```bash
node --check server.mjs
node --test server.test.mjs
```

## Runtime Defaults

The current template uses:

```text
CODEX_REQUIRE_MTLS=true
CODEX_ALLOWED_CERT_SUBJECTS=CN=iphone,CN=operator
CODEX_BIN=/usr/bin/codex
CLAUDE_BIN=/usr/bin/claude
CURSOR_BIN=/var/lib/codex-api/run-home/.local/bin/cursor-agent
KIMI_BIN=/var/lib/codex-api/run-home/.local/bin/kimi
KIMI_CODE_HOME=/var/lib/codex-api/run-home/.kimi-code
CLAUDE_CODE_USE_BEDROCK=
CLAUDE_AWS_PROFILE=
BEDROCK_REGION=us-east-1
AWS_REGION=
AWS_DEFAULT_REGION=
CODEX_MODEL_CATALOG='[...]'
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2025-01-01-preview
CODEX_DANGEROUS_MODE=true
CODEX_MAX_CONCURRENT=1
CODEX_MAX_JOB_STREAMS=8
CODEX_JOB_STREAM_HEARTBEAT_MS=15000
CODEX_MAX_BODY_BYTES=31457280
CODEX_MAX_JOB_ATTACHMENTS=6
CODEX_MAX_JOB_ATTACHMENT_BYTES=8388608
CODEX_MAX_JOB_ATTACHMENT_TOTAL_BYTES=18874368
CODEX_DEFAULT_TIMEOUT_MS=600000
CODEX_MAX_TIMEOUT_MS=1800000
CODEX_THREAD_SUMMARY_CHARACTERS=240
CODEX_FS_MAX_LIST_ENTRIES=500
CODEX_FS_MAX_READ_BYTES=1048576
CODEX_FS_MAX_FILE_BYTES=26214400
CODEX_FS_READ_DENYLIST=.env*,*.pem,*.key,*.p12,...
```

`CODEX_DANGEROUS_MODE=true` intentionally matches the user's v1 preference for
a powerful runner. Keep that fact explicit in handoffs.

`CODEX_MAX_BODY_BYTES` is intentionally aligned with the nginx `30m` upload
limit so phone attachments can survive base64 JSON overhead. Tighten the
attachment-specific limits first if an install wants smaller uploads.

## Workspaces

`CODEX_WORKSPACES` seeds the known workspace roots. The current live values are:

```text
/srv/codex-workspaces/scratch
/srv/codex-workspaces/poc-vault
/srv/codex-workspaces/sigiq
```

Directory-derived workspaces can also be selected under the configured browse
root through the directory workspace endpoints below. Do not accept arbitrary
paths from the phone.

## Rendering For An Install

From the repo root, render owner-specific env and nginx files with:

```bash
ops/render-codex-api-config
```

The renderer reads `~/.poc-vault/secrets/config.env` by default and writes to:

```text
build/codex-api/codex-api.env
build/codex-api/codex-api.nginx.conf
```

On the EC2 host, `ops/install-codex-api.sh` renders and installs those files to
`/etc/codex-api.env` and `/etc/nginx/conf.d/codex-api.conf`.

## Providers And Resumable Sessions

`GET /v1/codex/models` returns the protected model catalog used by Relay. When
the app-server transport is enabled, Relay asks the installed Codex CLI for its
current model list and replaces the configured Codex rows with that live list.
Other providers still come from `CODEX_MODEL_CATALOG` in `/etc/codex-api.env`;
keep the catalog server-side so the iOS app never ships model ids in the binary.

By default, `ops/render-codex-api-config` derives `CODEX_MODEL_CATALOG` from
`OPENCODE_CONFIG_PATH` (`~/.config/opencode/opencode.jsonc`) when that file is
available. Duplicate Azure deployments collapse to one visible entry per model id;
the retained `provider/model` id still selects the server-side route. The renderer
also appends fallback Codex CLI and Claude Code Task entries. Their optional public
`taskModel` value tells Relay which model id or alias to submit with a job, while an
entry without it uses the runner default. Live Codex discovery supersedes these
fallback Codex rows whenever the installed CLI responds. The public catalog omits internal routing
fields such as API key file paths, Azure base URLs, and Bedrock regions.

`POST /v1/codex/chat` streams synchronous chat as SSE. It supports `codex`,
`bedrock`, and `azure` catalog entries whose `modes` include `chat`, and emits `meta`,
`delta`, `usage`, `done`, and `error` events. Chat threads are persisted under
the Codex API data directory and surface through `GET /v1/codex/threads` with
`mode: "chat"`.

`POST /v1/codex/chat` also accepts an optional `workspaceId`, resolved through
the same registered/dynamic workspace registry as jobs. The resolved workspace
id and name persist with the thread; a continuation may omit `workspaceId` and
inherits the stored value, while a conflicting id fails with `400`.
Workspace-scoped chat threads merge with task threads in
`GET /v1/codex/threads?workspaceId=...` and honor workspace-scoped deletion.
Legacy chats without a workspace stay global-only. Codex-backed chat uses the
selected workspace as its ephemeral cwd (falling back to scratch). With
`CODEX_DANGEROUS_MODE=true`, Codex chat uses the same unrestricted
`--dangerously-bypass-approvals-and-sandbox` policy as Codex tasks; otherwise
it remains read-only. Azure chat remains context-only and never receives
filesystem access from the workspace selection.

`POST /v1/codex/jobs` accepts optional `provider`. Supported values are
`codex`, `claude`, `cursor`, and `kimi`; omitted provider defaults to `codex`. All job responses
include the persisted provider.

The server checks the selected CLI's login state under the isolated runner
home before creating the job. A missing CLI or a confirmed signed-out provider
returns `503` immediately, so a task cannot enter the queue and later fail with
an unauthenticated provider request. Codex and Claude recovery can use
`relay sync-auth`. Cursor and Kimi are signed in directly on the linked computer
(`cursor-agent login` / `kimi login`); the iPhone never handles provider credentials.

Codex jobs keep the existing `codex exec` and `codex exec resume` path. Cursor
jobs use the authenticated Cursor Agent CLI in print mode, capture its JSON result,
and resume with the saved Cursor session id. Kimi jobs use `kimi --prompt` with
stream-JSON output, default to `kimi-code/k3`, and resume with the saved Kimi
session id. Claude
jobs run `CLAUDE_BIN` in the selected workspace, read the prompt from stdin, use
`--print`, pass `--model` and `--effort` when requested, and pass either
`--session-id <uuid>` for a fresh Claude job or `--resume <session-id>` for a
follow-up. When `CODEX_DANGEROUS_MODE=true`, every Claude job uses
`--dangerously-skip-permissions` and the server ignores any more restrictive
permission mode requested by the client. Claude results come from stdout.

For direct Claude subscription auth, leave `CLAUDE_CODE_USE_BEDROCK` and
`CLAUDE_AWS_PROFILE` empty; ambient AWS credentials are stripped from Claude
jobs. Cursor and Kimi jobs get the same treatment: AWS access keys, profiles, regions,
and Bedrock variables are removed from the Cursor environment, which keeps
direct Cursor subscription state in the isolated runner home as the only auth
path. When Claude Code is intentionally run through Bedrock, set `CLAUDE_CODE_USE_BEDROCK=1`,
`CLAUDE_AWS_PROFILE=sigiq`, and the AWS region values in `/etc/codex-api.env`.
Claude jobs must use the SigiQ AWS profile; the launcher does not inherit a
process-wide `AWS_PROFILE` for Claude.
`CLAUDE_AWS_REGION` can override the Claude runner region; otherwise the
launcher preserves `AWS_REGION` / `AWS_DEFAULT_REGION` for Claude Code.
Bedrock chat uses `BEDROCK_REGION` and explicitly loads the `sigiq` profile.
OpenAI-compatible Azure catalog entries use server-side key files with
`Authorization: Bearer`; global Azure deployment config retains Azure's
`api-key` header contract.
Store replacement key files outside the repo under `/etc/codex-api/azure/`,
owned by `root:codex-runner` with mode `0640`, and expose a catalog row only
after its deployment passes a live request.

`GET /v1/codex/jobs`, `GET /v1/codex/sessions`,
`GET /v1/codex/threads`, and `GET /v1/codex/threads/<sessionId>` accept optional
provider filters. Jobs remain `provider=codex|claude|cursor|kimi`; thread filters also
accept `provider=bedrock|azure` for chat threads.

`GET /v1/codex/sessions` returns metadata only: Codex session files whose saved
`cwd` is inside a registered workspace, plus provider sessions discovered from
persisted job metadata. It does not return transcript content.

`GET /v1/codex/threads` returns safe EC2-native thread summaries by merging
those sessions with persisted job metadata. It includes latest prompt/result
summary fields and job counts, but not raw stdout/stderr transcript streams.
If no persisted job summary exists yet, it uses bounded first-prompt and
latest-answer previews from the saved Codex session file.

`GET /v1/codex/threads/<sessionId>` returns one thread with bounded transcript
messages and compact job previews.

`GET /v1/codex/ui` serves a no-dependency browser UI for listing threads,
filtering by workspace/search text, reading the bounded transcript view, and
opening full job logs only when requested.

For local review in a browser that cannot present the mTLS client certificate,
set `CODEX_PROXY_BASE_URL`, `CODEX_PROXY_CLIENT_CERT`, and
`CODEX_PROXY_CLIENT_KEY`. In that mode, the local UI stays on localhost and the
Node server forwards live `/v1/codex/*` GET requests with the configured cert.

`POST /v1/codex/jobs` accepts optional `resumeSessionId`. The backend rejects
unknown session ids, provider mismatches, and sessions outside the requested
workspace before running the provider-specific resume command. Threads are
provider-locked, so follow-ups must use the original provider.

## Job Artifacts

Successful jobs from all four task providers parse fenced code blocks from the saved answer and expose them
as job-scoped artifacts. Job responses include `artifacts`, each with `id`,
`kind`, `filename`, `title`, `language`, `contentType`, `bytes`, `rawURL`, and
`previewURL`.

Artifact routes stay under the mTLS-protected Codex namespace:

```text
GET /v1/codex/jobs/<jobId>/artifacts/<artifactId>/raw
GET /v1/codex/jobs/<jobId>/artifacts/<artifactId>/preview
```

Raw downloads use attachment headers and `nosniff`. Previewable HTML, SVG, and
Markdown render inside a sandboxed wrapper. HTML plus CSS/JS blocks are also
assembled into a job-only `preview.html` artifact. These artifacts are not POC
Library entries and do not use `ops/deploy-poc`.

## Live Local Previews

When a job result contains an HTTP URL on `localhost`, `127.0.0.1`, or `::1`,
Relay can open the app running on that same linked computer:

```text
POST /v1/codex/previews
GET  /v1/codex/previews/<capability>/
```

Lease creation requires the protected API credential, an existing job, and an
exact URL present in that job's output. Only unprivileged loopback ports are
accepted, the Relay API port is excluded, and leases expire after 30 minutes.
The returned wrapper runs proxied content in a sandboxed iframe without
same-origin privileges. Relay credentials and cookies are never forwarded to
the local development server.

## Directory Workspaces

Relay can browse safe EC2 workspace directories with:

```text
GET  /v1/codex/workspace-dirs?path=<relative-or-absolute-path>&q=<query>
POST /v1/codex/workspaces/select
```

The browse root defaults to `/srv/codex-workspaces` and can be overridden with
`CODEX_WORKSPACE_BROWSE_ROOT` or `CODEX_WORKSPACE_ROOT`. The server resolves
real paths, rejects files, traversal, and symlink escapes, and skips hidden
directories in listings. Selected child folders get deterministic `dir-*`
workspace ids and jobs, sessions, threads, and job responses resolve to the
deepest matching workspace path.

## Read-Only Files API

The file browser surface stays inside the same jail:

```text
GET      /v1/codex/fs/list?path=<relative-or-absolute>&offset=<n>&limit=<n>
GET|HEAD /v1/codex/fs/file?path=<relative-or-absolute>[&preview=1][&download=1]
```

`fs/list` returns one directory page: directories first, then files, each
sorted by name, dotfiles included. Directory entries carry
`workspaceId`/`workspaceName`, `hasGit`, and `isRegistered`; file entries carry
`size`, `modifiedAt`, an extension-based `mime` hint, `isText`, and
`readDenied`. Responses always include `offset`, `limit`, `total`, and
`truncated`; `CODEX_FS_MAX_LIST_ENTRIES` bounds one page. The legacy
`/v1/codex/workspace-dirs` response is unchanged.

`fs/file` enforces, in order: jail containment (realpath-resolved, symlink
escapes rejected), a regular-file check, then the read denylist (`403`). Every
response sends `cache-control: no-store`, `x-content-type-options: nosniff`,
`accept-ranges: bytes`, and a safe `content-disposition`. Reads are bounded to
`CODEX_FS_MAX_READ_BYTES` per response; larger permitted files return `206`
with `Content-Range` and support single byte-range requests (`416` on
malformed or unsatisfiable ranges). Files above `CODEX_FS_MAX_FILE_BYTES` are
refused with `413`. HTML/SVG always download as attachments unless `preview=1`
requests the sandboxed srcdoc+CSP preview wrapper shared with job artifacts.

`CODEX_FS_READ_DENYLIST` is a comma-separated list of case-insensitive
basename patterns (`*` wildcard only). The default denies `.env*`, private-key
and certificate files (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.crt`, `*.csr`,
`*.der`, `*.jks`, `*.keystore`, `*.mobileconfig`), `.netrc`, `.npmrc`,
`credentials`, `credentials.json`, and `id_rsa`-style key names. Denied files
still appear in listings with `readDenied: true`. The new surface adds no
write, delete, move, or upload operation.

## Live Job Streaming

```text
GET /v1/codex/jobs/<id>/stream?stdoutOffset=<n>&stderrOffset=<n>
```

Server-sent events for one job:

```text
status  -> job status snapshot (immediately, and on every state transition)
stdout  -> { offset, text } — real log-file byte offsets
stderr  -> { offset, text }
done    -> terminal job response, then the server closes the stream
```

The stream replays bounded persisted logs from the requested offsets, then
follows live output fed from the running child's stdout/stderr. UTF-8 is kept
valid across chunk boundaries, heartbeat comments are emitted every
`CODEX_JOB_STREAM_HEARTBEAT_MS` (15s default), and disconnecting clients are
unsubscribed immediately. Connecting to a finished job replays and closes
right away, so the route is safe to call at any point.
`CODEX_MAX_JOB_STREAMS` caps concurrent stream connections (`503` beyond).
Polling `GET /v1/codex/jobs/<id>` remains the recovery path, and
`CODEX_MAX_CONCURRENT` stays at 1 until parallel provider runs are proven on
the live host. The dev proxy (`CODEX_PROXY_BASE_URL`) pipes
`text/event-stream` responses through instead of buffering them.

## Phone Transcription

`POST /v1/codex/transcriptions` accepts short phone-recorded audio clips and
forwards them to Azure Speech. Configure `AZURE_SPEECH_ENDPOINT` and
`AZURE_SPEECH_API_KEY` only in `/etc/codex-api.env`; keep those values out of
the repo. The default model is `mai-transcribe-1` with the `en` language code.

The endpoint reads a bounded binary body, sanitizes the uploaded content type
and filename, sends multipart form data to Azure, and returns normalized text
with provider/model metadata. `CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES` controls the
Node-side upload limit; nginx currently allows up to `30m` for the Codex API
virtual host.

If Azure Speech is not configured, the endpoint returns `503`. Azure failures
are surfaced as `502` responses with the provider error message when available.

## Auth Headers

nginx forwards:

```text
X-SSL-Client-Verify
X-SSL-Client-S-DN
```

The backend rejects `/v1/codex/*` unless verification is `SUCCESS` and the
subject is in `CODEX_ALLOWED_CERT_SUBJECTS`.
