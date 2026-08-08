# Codex Server Workspace

This workspace owns the EC2-side Codex/Claude job API used by the Relay iPhone
app. It lives inside `/Users/pariksj/Desktop/poc-vault/codex-server` so the iOS
app and server runner can be changed together when their contract moves.

Configured endpoint shape:

```text
https://<CODEX_DOMAIN>
```

Remote host:

```text
owner AWS account / configured region / POC Vault EC2
```

## What It Provides

The server exposes an async job API for Codex and Claude providers:

- `GET /healthz`: public process health for uptime checks.
- `GET /v1/codex/health`: authenticated health.
- `GET /v1/codex/models`: authenticated model catalog for Relay Chat and
  Task mode. The catalog is rendered from server-side config, not compiled into
  the iOS app.
- `POST /v1/codex/chat`: authenticated SSE chat route for synchronous
  Bedrock/Azure model conversations.
- `GET /v1/codex/workspaces`: configured and selected workspace registry.
- `GET /v1/codex/workspace-dirs?path=sigiq&q=tutor`: browse/search safe
  EC2 directories under the configured workspace root.
- `POST /v1/codex/workspaces/select`: validate a browsed directory and return
  a deterministic workspace id for running jobs there.
- `GET /v1/codex/ui`: authenticated browser UI for reviewing Codex threads.
- `GET /v1/codex/sessions?workspaceId=scratch&provider=codex&limit=50`:
  resumable Codex session metadata for sessions whose saved `cwd` is inside a
  registered workspace.
- `GET /v1/codex/threads?workspaceId=scratch&provider=codex&limit=50`:
  EC2-native thread summaries, merging resumable sessions with latest persisted
  job metadata and bounded prompt/result previews.
- `GET /v1/codex/threads/<sessionId>?provider=codex`: one thread with bounded
  transcript messages plus compact job previews.
- `GET /v1/codex/jobs?provider=codex&limit=50`: persistent job history.
- `POST /v1/codex/jobs`: enqueue a provider job. `provider` is optional and
  defaults to `codex`; `claude` is also supported.
- `GET /v1/codex/jobs/<id>`: job detail with stdout, stderr, result, and status.
- `POST /v1/codex/jobs/<id>/cancel`: cancel queued or running jobs.
- `POST /v1/codex/transcriptions`: transcribe phone-recorded prompt audio
  through the configured Azure Speech endpoint.

All `/v1/codex/*` routes sit behind nginx mTLS. There is no bearer-token auth in
the current live design.

## Current Auth Contract

nginx and the backend both treat the client certificate subject as the operator
identity. The allowlist is strict and configured with
`CODEX_ALLOWED_CERT_SUBJECTS`.

The current live POC Vault install should stay limited to:

```text
CN=iphone
CN=parikshit-mac
```

A fresh generic install usually starts with its own subjects, for example:

```text
CN=iphone
CN=operator
```

Requests without a verified client certificate are rejected before they reach
the backend. Requests with other certificate subjects are rejected by the nginx
subject map.

The iOS app reuses the same `ClientIdentityStore` as the signed manifest and
WebView flow, so the Relay agent console works with the imported `client.p12`.

## Remote Runtime

The live service is installed as:

```text
/opt/codex-api/server.mjs
/etc/codex-api.env
/etc/nginx/conf.d/codex-api.conf
/etc/systemd/system/codex-api.service
```

Runtime data lives under:

```text
/var/lib/codex-api/jobs
/var/lib/codex-api/logs
/var/lib/codex-api/audit.jsonl
/var/lib/codex-api/run-home/.codex/auth.json
```

The service runs as `codex-runner`. It is not root and has no sudo.

Provider binaries are configured with:

```text
CODEX_BIN=/usr/bin/codex
CLAUDE_BIN=/usr/bin/claude
CLAUDE_CODE_USE_BEDROCK=1
CLAUDE_AWS_PROFILE=sigiq
BEDROCK_REGION=us-east-1
AWS_REGION=ap-south-1
AWS_DEFAULT_REGION=ap-south-1
AZURE_OPENAI_ENDPOINT=
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_API_VERSION=2025-01-01-preview
OPENCODE_CONFIG_PATH=~/.config/opencode/opencode.jsonc
CODEX_MODEL_CATALOG='[...]'
```

When `OPENCODE_CONFIG_PATH` exists, `ops/render-codex-api-config` renders the
Relay model catalog from that OpenCode config. Duplicate Azure deployments collapse
to one visible entry per model id while the winning `provider/model` id preserves
server-side routing. The renderer also appends Codex CLI and Claude Code Task entries;
their optional public `taskModel` value is the model id or alias Relay submits with a
job. Internal routing fields and key-file paths stay server-side and are not returned
by `/v1/codex/models`.

Codex jobs use the existing `codex exec` / `codex exec resume` commands. Claude
jobs run in the selected workspace, read prompts from stdin, use non-interactive
`--print` mode, pass `--model` / `--effort` when supplied, and use
`--session-id <uuid>` for fresh jobs or `--resume <session-id>` for follow-ups.
With Bedrock enabled, the launcher preserves the configured AWS region for
Claude Code; set `CLAUDE_AWS_REGION` only when it should differ from
`AWS_REGION` / `AWS_DEFAULT_REGION`. Claude jobs must use
`CLAUDE_AWS_PROFILE=sigiq`; the launcher does not inherit a process-wide
`AWS_PROFILE` for Claude.
Claude job results are captured from stdout.

## Relay Chat

Relay discovers available models at runtime with:

```text
GET /v1/codex/models
```

Each entry declares `id`, `label`, `provider`, and supported `modes`. A Task entry
can also declare `taskModel` and `effortLevels`. Chat mode uses providers `bedrock`
and `azure`; Task mode uses the async job providers `codex` and `claude`.

Synchronous chat streams from:

```text
POST /v1/codex/chat
```

Request bodies include `provider`, `model`, optional `threadId`, `messages`,
and `options`. Responses are `text/event-stream` with `meta`, `delta`, `usage`,
`done`, and `error` events. Chat threads are saved under the Codex API data
directory and appear in `GET /v1/codex/threads` with `mode: "chat"`.

Bedrock chat refuses to start unless `CLAUDE_AWS_PROFILE=sigiq` is configured,
loads that profile explicitly, and strips ambient AWS credentials from the
credential export path. Azure chat uses only server-side `AZURE_OPENAI_*`
values from `/etc/codex-api.env`.

## Workspaces

Jobs can target configured workspaces in `/etc/codex-api.env` and
directory-derived workspaces selected under the safe browse root:

```text
scratch    -> /srv/codex-workspaces/scratch
poc-vault  -> /srv/codex-workspaces/poc-vault
sigiq      -> /srv/codex-workspaces/sigiq
```

The remote `poc-vault` workspace is a separate copy of the local POC Vault repo.
It is not the live nginx static root and it is not the local Mac checkout.
The remote `sigiq` workspace is a folder-level project containing the SigiQ
repository checkouts used by Relay agent runs.

Relay can browse below the workspace root, select a child directory such as
`/srv/codex-workspaces/sigiq/ai-tutor`, and run Codex or Claude from that exact
directory. The API resolves real paths, rejects traversal and symlink escapes,
skips hidden directories in listings, and derives stable `dir-*` workspace ids
from the selected relative path. It does not accept arbitrary EC2 paths.

## Thread Summaries

`GET /v1/codex/sessions` stays metadata-only. It includes Codex session files
and provider sessions discovered from persisted job metadata, but it should not
return transcript content.

`GET /v1/codex/jobs`, `/sessions`, `/threads`, and `/threads/<sessionId>` accept
optional `provider=codex|claude` filters. Thread summaries include `provider`.
Threads are provider-locked: a Claude thread cannot be resumed by a Codex job,
and a Codex thread cannot be resumed by a Claude job.

`GET /v1/codex/threads` can return bounded `lastPrompt` and `lastResult`
previews so the phone UI can show readable thread history without raw
stdout/stderr streams. Tune the preview length with
`CODEX_THREAD_SUMMARY_CHARACTERS`.

The browser review surface lives at `/v1/codex/ui`. It uses the same mTLS
boundary as the API, lists recent threads, filters by workspace/search text,
shows bounded transcript messages, and can open full job logs intentionally.

## Job Artifacts

When a successful Codex or Claude answer contains fenced code blocks, the API
extracts them into job-scoped artifacts under the runner data directory. Job
responses include artifact metadata and mTLS-protected `rawURL` / `previewURL`
routes. Raw routes download files with attachment headers; preview routes render
HTML, SVG, and Markdown through a sandboxed iframe wrapper. Multi-block
HTML/CSS/JS answers also get an assembled `preview.html` artifact. These are
run artifacts only and are not added to the signed POC Library manifest.

For local browser review from a tool that cannot present a client certificate,
run the Node service with `CODEX_PROXY_BASE_URL`, `CODEX_PROXY_CLIENT_CERT`, and
`CODEX_PROXY_CLIENT_KEY`. The browser still talks to localhost, while the Node
process uses the client certificate for live `/v1/codex/*` GET requests.

When a thread has no persisted job summary yet, the server reads bounded
previews from the saved Codex session JSONL file. It skips injected
AGENTS/environment context messages and strips skill-instruction prefixes before
choosing the prompt preview.

Job stdout and stderr previews use the latest log tail by default. The full log
payload is returned only when the caller explicitly requests full logs.

## Phone Transcription

The iOS app can record short spoken prompts and replies, then upload the audio
to:

```text
POST /v1/codex/transcriptions
```

The endpoint accepts binary audio, requires the same mTLS identity as every
other `/v1/codex/*` route, and forwards the clip to Azure Speech as multipart
form data. Audio is not written to the Codex job log store by the Node service.

Configure the following only in `/etc/codex-api.env` or a local test
environment:

```text
CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES=26214400
AZURE_SPEECH_ENDPOINT=
AZURE_SPEECH_API_KEY=
AZURE_SPEECH_API_VERSION=2025-10-15
AZURE_SPEECH_TRANSCRIPTION_MODEL=mai-transcribe-1
AZURE_SPEECH_LOCALES=en
```

If Azure Speech is not configured, the endpoint returns service unavailable
rather than accepting the upload.

## Codex Login State

The VM was already logged into Codex as `ec2-user` via:

```text
/home/ec2-user/.codex/auth.json
```

For the systemd service, that auth file was copied into the runner home:

```text
/var/lib/codex-api/run-home/.codex/auth.json
```

owned by `codex-runner` with `0600` permissions. This is how `codex exec` works
when jobs are triggered from the phone while the Mac is off. No new OpenAI API
key was created during the v1 rollout.

## Local Files

The deployable server files are under:

```text
codex-api-deploy/
```

Key files:

- `server.mjs`: async job API and worker.
- `server.test.mjs`: local fake-Codex tests.
- `codex-api.env.example`: non-secret systemd environment template.
- `codex-api.nginx.conf.template`: owner-specific nginx mTLS template.
- `codex-api.nginx.conf`: example rendered nginx mTLS virtual host.
- `codex-api.service`: systemd service unit.

Render owner-specific files from the repo root with:

```bash
ops/render-codex-api-config
```

Install the service on an EC2 host with:

```bash
sudo POC_VAULT_CONFIG=~/.poc-vault/secrets/config.env ops/install-codex-api.sh
```

## Deploy Shape

The deployment is intentionally small:

1. Upload files from `codex-api-deploy/`.
2. Install them into `/opt`, `/etc`, and nginx/systemd paths.
3. Ensure `codex-runner` owns only `/var/lib/codex-api` and
   `/srv/codex-workspaces`.
4. Copy the client CA certificate and CRL to `/etc/codex-api/mtls`.
5. Restart `codex-api` and reload nginx after `nginx -t`.
6. Sync the POC Vault source copy to `/srv/codex-workspaces/poc-vault`.
7. Sync SigiQ repository checkouts to `/srv/codex-workspaces/sigiq`.

Do not expose SSH broadly for deployment. If a temporary security-group ingress
rule is added, remove it before handoff.

## Local Verification

From this workspace:

```bash
cd /Users/pariksj/Desktop/poc-vault/codex-server/codex-api-deploy
node --check server.mjs
node --test server.test.mjs
```

Expected result: both tests pass.

## Live Verification

Set a helper URL first:

```bash
CODEX_URL=https://<configured-codex-domain>
CLIENT_CERT=~/.poc-vault/secrets/clients/operator/operator.crt
CLIENT_KEY=~/.poc-vault/secrets/clients/operator/operator.key
```

No cert should fail:

```bash
curl -sS -w '\nHTTP:%{http_code}\n' \
  "$CODEX_URL/v1/codex/health"
```

Allowlisted client cert should pass:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  "$CODEX_URL/v1/codex/health"
```

Submit a small job:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"scratch","prompt":"Reply with exactly codex-async-ok and nothing else.","timeoutMs":600000}' \
  "$CODEX_URL/v1/codex/jobs"
```

Submit a Claude job:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"scratch","provider":"claude","prompt":"Summarize this workspace.","timeoutMs":600000}' \
  "$CODEX_URL/v1/codex/jobs"
```

List resumable sessions without transcript content:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  "$CODEX_URL/v1/codex/sessions?workspaceId=scratch&provider=codex&limit=20"
```

List EC2-native threads:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  "$CODEX_URL/v1/codex/threads?workspaceId=scratch&provider=codex&limit=20"
```

Resume a server-side session by id:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"scratch","provider":"codex","resumeSessionId":"<session-id>","prompt":"Continue from here.","timeoutMs":600000}' \
  "$CODEX_URL/v1/codex/jobs"
```

Transcribe phone audio when Azure Speech is configured:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  -H 'Content-Type: audio/wav' \
  -H 'X-Audio-Filename: phone-prompt.wav' \
  --data-binary @phone-prompt.wav \
  "$CODEX_URL/v1/codex/transcriptions"
```
