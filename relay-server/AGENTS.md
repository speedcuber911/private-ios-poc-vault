# Relay Server Agent Contract

This workspace owns the personal Relay backend for EC2 agent jobs. It lives
inside `/Users/pariksj/Desktop/poc-vault/relay-server` because the Relay iOS app
and remote runner are tightly coupled. The `/v1/codex/*` route name is retained
as a compatibility contract for existing clients.

## Working Rules

- Work from `/Users/pariksj/Desktop/poc-vault/relay-server`.
- Keep server files under `relay-server/`; do not mix them into POC static
  deploy directories.
- Do not commit or print secrets from `~/.poc-vault/secrets`.
- Keep `/v1/codex/*` mTLS-only.
- Keep the allowlist strict: `CN=iphone` and `CN=parikshit-mac`.
- Preserve `/healthz` as the only public route.
- Keep workspaces predefined in `CODEX_WORKSPACES`.
- Do not widen `codex-runner` access to POC Vault secrets, TLS private keys, or
  manifest signing keys.
- If temporary AWS security-group ingress is opened, remove it before handoff.

## Non-Negotiable Claude/Bedrock Boundary

Claude provider jobs may use Bedrock only through the SigiQ AWS profile.

- `CLAUDE_AWS_PROFILE` must be `sigiq` for live Claude jobs.
- Do not fall back to `AWS_PROFILE`, `AWS_DEFAULT_PROFILE`, EC2 instance-role
  credentials, or personal/Relay/POC Vault AWS credentials for Claude.
- Do not request or enable Anthropic/Claude Bedrock model access in the
  personal/Relay/POC Vault AWS account.
- Do not submit Bedrock use-case forms, model-access requests, IAM policy
  changes, marketplace subscriptions, or AWS console changes for Claude unless
  the user explicitly confirms the exact AWS account/profile first.
- Personal AWS may be valid for Relay EC2/static POC infrastructure. It is not
  valid for Claude/Bedrock model access.
- If a model is unavailable and the active account/profile is not clearly
  SigiQ, stop. Report the mismatch and do not try to enable the model.

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
cd /Users/pariksj/Desktop/poc-vault/relay-server/codex-api-deploy
node --check server.mjs
node --test server.test.mjs
```

For live verification, prove:

- `/healthz` returns `200` without a cert.
- `/v1/codex/health` rejects no-cert calls.
- `/v1/codex/health` accepts the Mac cert.
- a small `scratch` job reaches a terminal status.
- Claude/Bedrock code does not inherit `AWS_PROFILE`; keep or add a regression
  test proving a process-wide personal AWS profile still results in
  `CLAUDE_AWS_PROFILE=sigiq`.
- cancel and timeout behavior still work if the worker lifecycle changed.
- `codex-runner` cannot read TLS private keys.
