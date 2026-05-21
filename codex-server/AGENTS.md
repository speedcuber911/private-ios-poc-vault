# Codex Server Agent Contract

This workspace owns the personal EC2 Codex job API. It now lives inside
`/Users/pariksj/Desktop/poc-vault/codex-server` because the iOS shell and remote
runner are tightly coupled.

## Working Rules

- Work from `/Users/pariksj/Desktop/poc-vault/codex-server`.
- Keep server files under `codex-server/`; do not mix them into POC static
  deploy directories.
- Do not commit or print secrets from `~/.poc-vault/secrets`.
- Keep `/v1/codex/*` mTLS-only.
- Keep the allowlist strict: `CN=iphone` and `CN=parikshit-mac`.
- Preserve `/healthz` as the only public route.
- Keep workspaces predefined in `CODEX_WORKSPACES`.
- Do not widen `codex-runner` access to POC Vault secrets, TLS private keys, or
  manifest signing keys.
- If temporary AWS security-group ingress is opened, remove it before handoff.

## Implementation Surface

Server files live in:

```text
codex-api-deploy/
```

Remote install paths:

```text
/opt/codex-api/server.mjs
/etc/codex-api.env
/etc/nginx/conf.d/codex-api.conf
/etc/systemd/system/codex-api.service
```

Runtime data:

```text
/var/lib/codex-api/jobs
/var/lib/codex-api/logs
/var/lib/codex-api/audit.jsonl
```

## Verification

Before saying the server work is complete, run local verification:

```bash
cd /Users/pariksj/Desktop/poc-vault/codex-server/codex-api-deploy
node --check server.mjs
node --test server.test.mjs
```

For live verification, prove:

- `/healthz` returns `200` without a cert.
- `/v1/codex/health` rejects no-cert calls.
- `/v1/codex/health` accepts the Mac cert.
- a small `scratch` job reaches a terminal status.
- cancel and timeout behavior still work if the worker lifecycle changed.
- `codex-runner` cannot read TLS private keys.
