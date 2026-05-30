# Codex API Deploy Files

This directory contains the deployable files for the async Codex/Claude job
service.

## Files

- `server.mjs`: Node HTTP service with mTLS header auth, workspace registry,
  provider-locked resumable-session metadata, persistent jobs, stdout/stderr
  logs, audit JSONL, timeout, cancel, and FIFO worker execution.
- `server.test.mjs`: local tests that use fake `codex` and `claude` binaries.
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
CLAUDE_CODE_USE_BEDROCK=
CLAUDE_AWS_PROFILE=sigiq
BEDROCK_REGION=us-east-1
AWS_REGION=
AWS_DEFAULT_REGION=
CODEX_MODEL_CATALOG='[...]'
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2025-01-01-preview
CODEX_DANGEROUS_MODE=true
CODEX_MAX_CONCURRENT=1
CODEX_MAX_BODY_BYTES=31457280
CODEX_MAX_JOB_ATTACHMENTS=6
CODEX_MAX_JOB_ATTACHMENT_BYTES=8388608
CODEX_MAX_JOB_ATTACHMENT_TOTAL_BYTES=18874368
CODEX_DEFAULT_TIMEOUT_MS=600000
CODEX_MAX_TIMEOUT_MS=1800000
CODEX_THREAD_SUMMARY_CHARACTERS=240
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

`GET /v1/codex/models` returns the protected model catalog used by Relay. The
catalog comes from `CODEX_MODEL_CATALOG` in `/etc/codex-api.env`; keep it
server-side so the iOS app never ships model ids in the binary.

By default, `ops/render-codex-api-config` derives `CODEX_MODEL_CATALOG` from
`OPENCODE_CONFIG_PATH` (`~/.config/opencode/opencode.jsonc`) when that file is
available. Azure OpenCode model ids are exposed as `provider/model` so duplicate
deployment names from different Azure resources remain selectable in Relay. The
public catalog omits internal routing fields such as API key file paths, Azure
base URLs, and Bedrock regions.

`POST /v1/codex/chat` streams synchronous chat as SSE. It supports `bedrock`
and `azure` catalog entries whose `modes` include `chat`, and emits `meta`,
`delta`, `usage`, `done`, and `error` events. Chat threads are persisted under
the Codex API data directory and surface through `GET /v1/codex/threads` with
`mode: "chat"`.

`POST /v1/codex/jobs` accepts optional `provider`. Supported values are
`codex` and `claude`; omitted provider defaults to `codex`. All job responses
include the persisted provider.

Codex jobs keep the existing `codex exec` and `codex exec resume` path. Claude
jobs run `CLAUDE_BIN` in the selected workspace, read the prompt from stdin, use
`--print`, pass `--model` and `--effort` when requested, and pass either
`--session-id <uuid>` for a fresh Claude job or `--resume <session-id>` for a
follow-up. Claude results come from stdout.

When Claude Code is run through Bedrock, set `CLAUDE_CODE_USE_BEDROCK=1`,
`CLAUDE_AWS_PROFILE=sigiq`, and the AWS region values in `/etc/codex-api.env`.
Claude jobs must use the SigiQ AWS profile; the launcher does not inherit a
process-wide `AWS_PROFILE` for Claude.
`CLAUDE_AWS_REGION` can override the Claude runner region; otherwise the
launcher preserves `AWS_REGION` / `AWS_DEFAULT_REGION` for Claude Code.
Bedrock chat uses `BEDROCK_REGION` and explicitly loads the `sigiq` profile;
Azure chat uses only `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, and
`AZURE_OPENAI_API_VERSION` from server-side env.

`GET /v1/codex/jobs`, `GET /v1/codex/sessions`,
`GET /v1/codex/threads`, and `GET /v1/codex/threads/<sessionId>` accept optional
provider filters. Jobs remain `provider=codex|claude`; thread filters also
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
provider-locked; a Claude thread cannot accept a Codex follow-up and vice versa.

## Job Artifacts

Successful jobs parse fenced code blocks from the saved answer and expose them
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
