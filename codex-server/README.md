# Codex Server Workspace

This workspace owns the EC2-side Codex job API used by the POC Vault iPhone app.
It lives inside `/Users/pariksj/Desktop/poc-vault/codex-server` so the iOS vault
app and server runner can be changed together when their contract moves.

Live endpoint:

```text
https://codex.pocs.conformal.live
```

Remote host:

```text
personal AWS / ap-south-1 / poc-vault EC2
```

## What It Provides

The server exposes an async job API for Codex:

- `GET /healthz`: public process health for uptime checks.
- `GET /v1/codex/health`: authenticated health.
- `GET /v1/codex/workspaces`: predefined workspace registry.
- `GET /v1/codex/sessions?workspaceId=scratch&limit=50`: resumable session
  metadata for sessions whose saved `cwd` is inside a registered workspace.
- `GET /v1/codex/threads?workspaceId=scratch&limit=50`: EC2-native thread
  summaries, merging resumable sessions with the latest persisted job metadata.
- `GET /v1/codex/jobs?limit=50`: persistent job history.
- `POST /v1/codex/jobs`: enqueue a Codex job.
- `GET /v1/codex/jobs/<id>`: job detail with stdout, stderr, result, and status.
- `POST /v1/codex/jobs/<id>/cancel`: cancel queued or running jobs.

All `/v1/codex/*` routes sit behind nginx mTLS. There is no bearer-token auth in
the current live design.

## Current Auth Contract

nginx and the backend both treat the client certificate subject as the operator
identity. The intended allowlist is strict:

```text
CN=iphone
CN=parikshit-mac
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
- `codex-api.nginx.conf`: nginx mTLS virtual host.
- `codex-api.service`: systemd service unit.

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

No cert should fail:

```bash
curl -sS -w '\nHTTP:%{http_code}\n' \
  https://codex.pocs.conformal.live/v1/codex/health
```

Mac cert should pass:

```bash
curl -sS \
  --cert ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.crt \
  --key ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.key \
  https://codex.pocs.conformal.live/v1/codex/health
```

Submit a small job:

```bash
curl -sS \
  --cert ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.crt \
  --key ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.key \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"scratch","prompt":"Reply with exactly codex-async-ok and nothing else.","timeoutMs":600000}' \
  https://codex.pocs.conformal.live/v1/codex/jobs
```

List resumable sessions without transcript content:

```bash
curl -sS \
  --cert ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.crt \
  --key ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.key \
  'https://codex.pocs.conformal.live/v1/codex/sessions?workspaceId=scratch&limit=20'
```

List EC2-native threads:

```bash
curl -sS \
  --cert ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.crt \
  --key ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.key \
  'https://codex.pocs.conformal.live/v1/codex/threads?workspaceId=scratch&limit=20'
```

Resume a server-side session by id:

```bash
curl -sS \
  --cert ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.crt \
  --key ~/.poc-vault/secrets/clients/parikshit-mac/parikshit-mac.key \
  -H 'Content-Type: application/json' \
  -d '{"workspaceId":"scratch","resumeSessionId":"<session-id>","prompt":"Continue from here.","timeoutMs":600000}' \
  https://codex.pocs.conformal.live/v1/codex/jobs
```
