# Codex API Deploy Files

This directory contains the deployable files for the async Codex job service.

## Files

- `server.mjs`: Node HTTP service with mTLS header auth, workspace registry,
  resumable-session metadata, persistent jobs, stdout/stderr logs, audit JSONL,
  timeout, cancel, and FIFO worker execution.
- `server.test.mjs`: local tests that use a fake `codex` binary.
- `codex-api.env.example`: non-secret environment file template for
  `/etc/codex-api.env`.
- `codex-api.nginx.conf`: nginx virtual host for `codex.pocs.conformal.live`.
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
CODEX_ALLOWED_CERT_SUBJECTS=CN=iphone,CN=parikshit-mac
CODEX_DANGEROUS_MODE=true
CODEX_MAX_CONCURRENT=1
CODEX_DEFAULT_TIMEOUT_MS=600000
CODEX_MAX_TIMEOUT_MS=1800000
CODEX_THREAD_SUMMARY_CHARACTERS=240
```

`CODEX_DANGEROUS_MODE=true` intentionally matches the user's v1 preference for
a powerful runner. Keep that fact explicit in handoffs.

## Workspaces

Only workspaces listed in `CODEX_WORKSPACES` can be selected by the API. The
current live values are:

```text
/srv/codex-workspaces/scratch
/srv/codex-workspaces/poc-vault
```

Do not accept arbitrary paths from the phone.

## Resumable Sessions

`GET /v1/codex/sessions` returns metadata only for sessions whose saved `cwd`
is inside a registered workspace. It does not return transcript content.

`GET /v1/codex/threads` returns safe EC2-native thread summaries by merging
those sessions with persisted job metadata. It includes latest prompt/result
summary fields and job counts, but not raw stdout/stderr transcript streams.
If no persisted job summary exists yet, it uses bounded first-prompt and
latest-answer previews from the saved Codex session file.

`POST /v1/codex/jobs` accepts optional `resumeSessionId`. The backend rejects
unknown session ids and sessions outside the requested workspace before running
`codex exec resume`.

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
