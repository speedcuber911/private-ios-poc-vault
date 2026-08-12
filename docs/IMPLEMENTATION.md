# Relay Implementation Notes

This document summarizes the current shipped shape of Relay across the iOS app,
static POC hosting, and the EC2 Codex/Claude runner. It is meant to help a new
reviewer understand what has been built without reading every Swift, Node, and
ops file first.

For a chronological account of how the repo reached this shape, read
[docs/PROJECT_HISTORY.md](PROJECT_HISTORY.md). For the in-flight files-first
redesign that supersedes parts of these notes, read
[docs/FILES_REDESIGN.md](FILES_REDESIGN.md).

## System Summary

Relay is a private iPhone-first system for controlling remote Codex/Claude
agent runs, reviewing bounded thread output, transcribing spoken prompts, and
browsing authenticated static POCs.

The platform has three connected layers:

1. The Relay iOS app presents the agent console, POC library, diagnostics, and
   authenticated WebViews.
2. Static POCs are stored under `pocs/<slug>/public/`, discovered through a
   generated manifest, and served through nginx behind mTLS.
3. The EC2 Relay server accepts authenticated job requests from the phone,
   persists job state, runs Codex or Claude in registered workspaces, exposes
   thread summaries, and supports phone-recorded prompt transcription through
   Azure Speech.

The important architectural boundary is still intact: ordinary POC creation is
backend-driven and does not require changes in `ios/POCVault/`.

## Static POC Vault

Each POC is self-contained static web content:

```text
pocs/<slug>/
├── poc.json
└── public/
    └── index.html
```

`ops/deploy-poc` is the normal deployment interface. It validates slug and
source shape, stages assets into `pocs/<slug>/public/`, renders
`build/manifest.json`, signs `build/manifest.sig.json` when the local Ed25519
key exists, logs deployment metadata locally, and promotes files to the VM when
`DEPLOY_HOST` is configured.

The iOS app only needs the manifest and signature URLs. New POCs should appear
after a manifest refresh; the app should not learn individual POC slugs at
compile time.

## Relay iOS App

The iOS app is a SwiftUI app with four user-facing jobs:

- let the user create, monitor, continue, cancel, and review remote Codex/Claude jobs
- record short voice prompts and upload them for authenticated transcription
- load and verify the signed POC manifest
- open protected POC URLs in a full-screen authenticated `WKWebView`

The root tab layout is Library, Codex, Claude, and Status. Codex and Claude use
separate `CodexConsoleViewModel` instances so provider defaults, selected model,
reasoning/effort, selected thread, active jobs, and completion notifications do
not bleed between providers. Status merges recent provider activity and embeds
Diagnostics for certificate, manifest, and health checks.

Production flows require a client certificate imported through Diagnostics.
The physical app expects `Documents/support/client.p12` and can also consume a
non-secret `Documents/support/vault-config.json` with manifest, signature, and
Codex base URLs.

Simulator builds intentionally bypass production mTLS and use the local preview
server from `ios/launch-simulator.sh`.

## Agent Console UX

> **Update:** the operator surface has been reworked twice since these notes.
> First into a chat-first design with separate **Chat** and **Task** bottom tabs,
> streaming replies, and a reimagined workspace picker
> ([CHAT_REDESIGN.md](CHAT_REDESIGN.md)). That tab layout is now itself being
> superseded by the current **files-first** design — a file-browser root with
> per-folder conversations and explicit chat/task model choices — specified in
> [FILES_REDESIGN.md](FILES_REDESIGN.md) and implemented as of 2026-08-11. Read
> FILES_REDESIGN.md for the current navigation and chat
> surface, CHAT_REDESIGN.md for the catalog de-duplication and streaming-chat
> details that carry forward, and the notes below for the prior single-console
> thread model, which the redesign removes.

The Relay agent console has moved from a job-list surface to a files-first,
folder-scoped conversation console:

- The compose panel starts a new thread or continues a selected thread.
- A visible `Threads` row below the chat header opens the current folder's
  newest-first history.
- The history merges EC2-native sessions with persisted job metadata and keeps
  standalone invocations visible even when no resumable session was produced.
- Jobs already represented by a thread are de-duplicated, and exact workspace
  filtering prevents one folder's history from leaking into another.
- Smoke-test threads are hidden from the main feed by default.
- Jobs that are still starting appear as pending feed rows until a session file
  is discovered.
- The history sheet stays secondary to the main conversation and composer.
- Thread titles are derived from prompt/result/error content, with special
  handling for GitHub pull request URLs.
- Raw job activity previews now favor the latest log tail so active failures
  show the newest useful lines first.
- Opening a history row restores its bounded conversation or invocation result.
  `View full log` opens a stable sheet first, displays a loading state, and then
  renders explicitly requested raw activity without dismissing itself.
- The composer uses the keyboard safe area, interactive scroll dismissal,
  dismissal on Send/Run, and outside taps on non-editor content. It has no
  custom keyboard-accessory or floating dismissal button.

The compose controls support provider, model, effort/reasoning, attachments,
voice transcription, Claude permission modes, and a searchable skill picker.
Selected skills are applied client-side by prefixing the outgoing prompt; this
does not change the server API contract.

The workspace picker is a safe directory browser backed by the Codex API. It can
select a configured workspace such as `sigiq` or a child directory such as
`sigiq/ai-tutor`, but the server derives the runnable workspace id only after
realpath and browse-root checks.

Successful jobs can show job-scoped artifacts when the server extracts fenced
code blocks from an answer. The phone can open mTLS-protected previews or fetch
raw artifact bytes for sharing; artifacts remain run output, not signed POC
catalog entries.

## Phone Voice Prompts

The iOS app can record short spoken prompts from the main compose panel and
from the thread reply composer.

Recording behavior:

- The app requests microphone permission through `NSMicrophoneUsageDescription`.
- Audio is recorded as temporary WAV files using 16 kHz, mono, 16-bit linear
  PCM.
- The UI disables send actions while recording or transcribing.
- Temporary recording files are deleted after transcription.
- A transcript replaces an empty prompt or appends below existing text.

Network behavior:

- `CodexClient` uploads audio bytes to `POST /v1/codex/transcriptions`.
- The request uses the same mTLS identity as the rest of the Codex API.
- The server forwards the audio to Azure Speech using multipart form data.
- The server returns normalized transcript text plus provider/model metadata.

## Codex API

Deployable server files live in `relay-server/codex-api-deploy/`.

Current authenticated API surface:

```text
GET  /v1/codex/health
GET  /v1/codex/workspaces
GET  /v1/codex/workspace-dirs?path=<path>&q=<query>
GET  /v1/codex/ui
GET  /v1/codex/sessions?workspaceId=<id>&provider=<provider>&limit=<n>
GET  /v1/codex/threads?workspaceId=<id>&provider=<provider>&limit=<n>
GET  /v1/codex/threads/<sessionId>?provider=<provider>
GET  /v1/codex/jobs?provider=<provider>&limit=<n>
POST /v1/codex/workspaces/select
POST /v1/codex/jobs
GET  /v1/codex/jobs/<id>
POST /v1/codex/jobs/<id>/cancel
POST /v1/codex/transcriptions
```

`GET /healthz` stays public for diagnostics. Everything under `/v1/codex/*`
requires mTLS.

Job execution behavior:

- Jobs are persisted under `/var/lib/codex-api/jobs`.
- stdout, stderr, and result files are persisted under
  `/var/lib/codex-api/logs`.
- Running jobs are marked failed on service restart so they do not stay stuck.
- Jobs run only in configured workspaces from `CODEX_WORKSPACES` or safe
  directory-derived workspaces under the configured workspace browse root.
- The directory browser is rooted at `/srv/codex-workspaces` by default, skips
  hidden directories, resolves real paths, and rejects traversal or symlink
  escapes before returning a selectable workspace id.
- Jobs support `provider=codex` and `provider=claude`; omitted provider
  defaults to `codex`.
- `resumeSessionId` is accepted only when the session exists in `CODEX_HOME`
  or persisted provider metadata, matches the selected provider, and belongs to
  the selected workspace.
- The server records the discovered session id when a new Codex session appears
  after job completion. Fresh Claude jobs receive a generated session id before
  execution.

Thread summary behavior:

- `/v1/codex/sessions` remains metadata-only.
- `/v1/codex/threads` combines session files and persisted job metadata.
- `/v1/codex/threads/<sessionId>` returns one bounded thread transcript plus
  compact job previews.
- Threads are provider-locked. A Claude thread cannot be resumed by a Codex job,
  and a Codex thread cannot be resumed by a Claude job.
- When no job summary exists, the server reads bounded prompt/answer previews
  from the Codex session JSONL file.
- Injected context messages, such as AGENTS/environment preambles, are skipped
  before selecting a human-readable prompt summary.
- Skill instruction prefixes are stripped from thread summaries.

Browser review behavior:

- `/v1/codex/ui` serves an authenticated no-dependency browser UI for reviewing
  recent threads and intentionally opening full logs.
- Local browser tooling that cannot present a client certificate can use the
  Node proxy settings `CODEX_PROXY_BASE_URL`, `CODEX_PROXY_CLIENT_CERT`, and
  `CODEX_PROXY_CLIENT_KEY`.

Artifact behavior:

- Successful job answers are scanned for fenced code blocks.
- Safe, bounded blocks are written under `/var/lib/codex-api/artifacts/<jobId>/`.
- `raw` routes download artifacts with attachment headers.
- `preview` routes sandbox previewable HTML, SVG, and Markdown.
- HTML/CSS/JS answer sets also get a generated `preview.html` artifact.
- Artifact routes stay under `/v1/codex/*` and require the same mTLS boundary.

Output preview behavior:

- List responses use compact bounded log previews.
- Detail responses use larger previews.
- Full logs are returned only when requested through the supported full-log
  query shape.
- stdout and stderr previews use suffix slices so the phone sees recent log
  output first.

## Upload And Transcription Configuration

Azure Speech settings belong only in `/etc/codex-api.env` on the VM or in local
test environment variables. Do not commit real values.

| Variable | Purpose |
| --- | --- |
| `CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES` | Maximum uploaded audio size. The template uses 25 MiB. |
| `CODEX_MAX_BODY_BYTES` | Maximum JSON request body. The template uses 30 MiB so phone attachments fit under nginx. |
| `CODEX_MAX_JOB_ATTACHMENTS` | Maximum files attached to one job. The template uses 6. |
| `CODEX_MAX_JOB_ATTACHMENT_BYTES` | Maximum decoded size for one attachment. The template uses 8 MiB. |
| `CODEX_MAX_JOB_ATTACHMENT_TOTAL_BYTES` | Maximum decoded attachment total for one job. The template uses 18 MiB. |
| `AZURE_SPEECH_ENDPOINT` | Azure Speech endpoint base URL. |
| `AZURE_SPEECH_API_KEY` | Azure Speech subscription key. |
| `AZURE_SPEECH_API_VERSION` | API version, defaulting to `2025-10-15`. |
| `AZURE_SPEECH_TRANSCRIPTION_MODEL` | Transcription model, defaulting to `mai-transcribe-1`. |
| `AZURE_SPEECH_LOCALES` | Comma-separated locale list, defaulting to `en`. |

nginx `client_max_body_size` is set to `30m` for the Codex API virtual host so
phone audio uploads can reach the Node service.

If Azure Speech is not configured, `POST /v1/codex/transcriptions` returns a
service-unavailable response instead of silently accepting audio.

## Security Model

The live perimeter is certificate-based mTLS, not hardware-bound iPhone-only
access. The current live Codex API allowlist should stay exactly:

```text
CN=iphone
CN=parikshit-mac
```

New installs configure their own allowlist with `CODEX_ALLOWED_CERT_SUBJECTS`,
for example:

```text
CN=iphone
CN=operator
```

nginx verifies the client certificate and forwards certificate status/subject
headers to the backend. The backend re-checks those headers before handling
Codex API requests.

Secrets must stay outside git:

- client certs and keys
- client CA private keys
- manifest signing private keys
- copied Codex auth JSON
- OpenAI or Azure API keys
- local config from `~/.poc-vault/secrets`

## Documentation Updates

The root `README.md` now reads as a GitHub-facing project overview instead of
only an internal runbook. It explains the product story, architecture, security
model, POC deploy flow, iOS provisioning, simulator workflow, Codex console, and
verification steps.

`docs/MULTI_INSTALL.md` documents how a new owner can install the same stack on
their own EC2/domain using a local `~/.poc-vault/secrets/config.env`. The
portable install path is:

- `ops/init-install-config` creates owner-local config plus optional local SSH
  and manifest signing keys.
- `ops/provision-ec2.sh` creates or checks AWS resources.
- `ops/install-server.sh` renders the static vault nginx config on the host.
- `ops/render-codex-api-config` renders install-specific Codex env/nginx files.
- `ops/install-codex-api.sh` installs the Codex API service on the host.
- `ops/provision-ios-support.sh` writes URLs and the trusted manifest public
  key into the app support config for physical devices.

The Relay server docs now call out:

- authenticated endpoint inventory
- thread summary behavior
- phone transcription endpoint
- Azure Speech configuration
- mTLS subject allowlist
- local and live verification commands

## Verification Commands

Use these checks after touching the related surfaces:

```bash
python3 -m py_compile ops/render-manifest.py ops/sign-manifest.py ops/deploy-poc ops/serve-simulator-poc-vault
bash -n ios/launch-simulator.sh
python3 ops/render-manifest.py --pocs-dir pocs -o build/manifest.json
python3 ops/sign-manifest.py build/manifest.json --allow-missing-key
cd relay-server/codex-api-deploy && node --check server.mjs && node --test server.test.mjs
```

For the iOS test suite:

```bash
xcodebuild test \
  -project ios/POCVault/POCVault.xcodeproj \
  -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 16'
```

For live perimeter checks:

```bash
ops/verify-server.sh
```

Expected live behavior:

- `/healthz` is public.
- protected manifest and POC routes reject clients without a valid cert.
- protected manifest and POC routes return `200` with the configured client
  cert.
- `/v1/codex/*` rejects unauthenticated callers.
- Codex health, job, thread, and transcription checks pass only with a valid
  allowlisted client certificate and complete server configuration.
