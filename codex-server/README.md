# Codex Server Workspace

This workspace owns the EC2-side Codex job API used by the POC Vault iPhone app.
It lives inside `/Users/pariksj/Desktop/poc-vault/codex-server` so the iOS vault
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

The server exposes an async job API for Codex:

- `GET /healthz`: public process health for uptime checks.
- `GET /v1/codex/health`: authenticated health.
- `GET /v1/codex/workspaces`: predefined workspace registry.
- `GET /v1/codex/sessions?workspaceId=scratch&limit=50`: resumable session
  metadata for sessions whose saved `cwd` is inside a registered workspace.
- `GET /v1/codex/threads?workspaceId=scratch&limit=50`: EC2-native thread
  summaries, merging resumable sessions with latest persisted job metadata and
  bounded prompt/result previews.
- `GET /v1/codex/jobs?limit=50`: persistent job history.
- `POST /v1/codex/jobs`: enqueue a Codex job.
- `GET /v1/codex/jobs/<id>`: job detail with stdout, stderr, result, and status.
- `POST /v1/codex/jobs/<id>/cancel`: cancel queued or running jobs.
- `POST /v1/codex/transcriptions`: transcribe phone-recorded prompt audio
  through the configured Azure Speech endpoint.

All `/v1/codex/*` routes sit behind nginx mTLS. There is no bearer-token auth in
the current live design.

## Current Auth Contract

nginx and the backend both treat the client certificate subject as the operator
identity. The intended allowlist is strict and configured with
`CODEX_ALLOWED_CERT_SUBJECTS`. A fresh install usually starts with:

```text
CN=iphone
CN=operator
```

Requests without a verified client certificate are rejected before they reach
the backend. Requests with other certificate subjects are rejected by the nginx
subject map.

The iOS app reuses the same `ClientIdentityStore` as the POC Vault manifest and
WebView flow, so the Codex tab works with the imported `client.p12`.

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

## Workspaces

Jobs can target only the predefined workspaces in `/etc/codex-api.env`:

```text
scratch    -> /srv/codex-workspaces/scratch
poc-vault  -> /srv/codex-workspaces/poc-vault
```

The remote `poc-vault` workspace is a separate copy of the local POC Vault repo.
It is not the live nginx static root and it is not the local Mac checkout.

## Thread Summaries

`GET /v1/codex/sessions` stays metadata-only. It should not return transcript
content.

`GET /v1/codex/threads` can return bounded `lastPrompt` and `lastResult`
previews so the phone UI can show readable thread history without raw
stdout/stderr streams. Tune the preview length with
`CODEX_THREAD_SUMMARY_CHARACTERS`.

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

List resumable sessions without transcript content:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  "$CODEX_URL/v1/codex/sessions?workspaceId=scratch&limit=20"
```

List EC2-native threads:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  "$CODEX_URL/v1/codex/threads?workspaceId=scratch&limit=20"
```

Resume a server-side session by id:

```bash
curl -sS \
  --cert "$CLIENT_CERT" \
  --key "$CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"scratch","resumeSessionId":"<session-id>","prompt":"Continue from here.","timeoutMs":600000}' \
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
