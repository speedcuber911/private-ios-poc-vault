# Security Notes

This workspace controls a personal remote agent runner. Treat it as sensitive
infrastructure even though the repo itself should contain no secrets.

## Current Perimeter

The public endpoint is configured per install:

```text
https://<CODEX_DOMAIN>
```

The trusted routes are `/v1/codex/*`. They require:

1. nginx mTLS verification success
2. exact certificate-subject allowlist
3. backend re-check of the forwarded certificate subject

The allowed subjects come from `CODEX_ALLOWED_CERT_SUBJECTS`. The current live
POC Vault install should stay limited to:

```text
CN=iphone
CN=parikshit-mac
```

A fresh generic install usually starts with its own subjects, for example:

```text
CN=iphone
CN=operator
```

`/healthz` is public by design and must not expose secrets.

## Claude/Bedrock Boundary

Claude provider jobs may use AWS Bedrock only through the SigiQ AWS profile:

```text
CLAUDE_AWS_PROFILE=sigiq
```

Do not use personal/Relay/POC Vault AWS credentials, `AWS_PROFILE`,
`AWS_DEFAULT_PROFILE`, EC2 instance-role credentials, or inherited shell AWS
configuration for Claude model access.

Do not request, enable, approve, or troubleshoot Anthropic/Claude Bedrock model
access in the personal/Relay/POC Vault AWS account. Any Bedrock model-access
request, use-case form, IAM change, marketplace subscription, or console action
for Claude requires explicit user confirmation of the exact AWS account/profile
first.

## Never Commit

- `.p12`, `.pem`, `.key`, `.crt`, `.csr`, `.mobileconfig`
- OpenAI API keys, Azure OpenAI API keys, or copied Codex auth JSON
- AWS credentials
- SSH private keys
- client CA private keys
- server private keys
- manifest signing private keys
- local config copied from `~/.poc-vault/secrets`

References to secret paths are fine. Secret values are not.

## Remote Secret Boundaries

The Codex runner must not be able to read these files:

```text
/etc/poc-vault/tls/client-ca.key
/etc/poc-vault/tls/server.key
/home/ec2-user/.codex/auth.json
```

The service copy of Codex auth is intentionally readable only by `codex-runner`:

```text
/var/lib/codex-api/run-home/.codex/auth.json
```

The live CA certificate and CRL copied into `/etc/codex-api/mtls` are public
verification material, not private keys.

## Runner Constraints

The service should run as:

```text
User=codex-runner
Group=codex-runner
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
CapabilityBoundingSet=
```

The runner owns only:

```text
/var/lib/codex-api
/srv/codex-workspaces
```

## Before Handoff

Run these checks after any deployment or auth change:

```bash
curl -sS -w '\nHTTP:%{http_code}\n' https://<CODEX_DOMAIN>/healthz
curl -sS -w '\nHTTP:%{http_code}\n' https://<CODEX_DOMAIN>/v1/codex/health
curl -sS --cert ~/.poc-vault/secrets/clients/operator/operator.crt \
  --key ~/.poc-vault/secrets/clients/operator/operator.key \
  https://<CODEX_DOMAIN>/v1/codex/health
```

On the VM, check:

```bash
sudo nginx -t
sudo systemctl is-active codex-api
sudo -u codex-runner test ! -r /etc/poc-vault/tls/client-ca.key
sudo -u codex-runner test ! -r /etc/poc-vault/tls/server.key
```

If a temporary SSH ingress rule was opened for deployment, revoke it before
calling the work finished.
