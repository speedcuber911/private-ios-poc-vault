# Security Notes

POC Vault is designed to keep private prototypes behind mutual TLS, but the repo
must stay free of credentials.

The same iOS app can also control a configured Codex job API at
`https://<CODEX_DOMAIN>`. Treat that endpoint as agent-runner infrastructure,
not just static demo hosting.

## Never Commit

- `.p12`, `.pem`, `.key`, `.crt`, `.csr`, `.mobileconfig`
- AWS credentials
- Route53 hosted-zone credentials or IAM secrets
- client CA private keys
- client certificate private keys
- manifest signing private keys
- copied Codex auth JSON, OpenAI API keys, or Azure Speech API keys
- passphrases
- local config files copied from `~/.poc-vault/secrets`

## Expected Secret Locations

Secrets should live outside the repo, normally under:

```text
~/.poc-vault/secrets/
```

The checked-in `ops/config.example.env` is only a template. Copy it to:

```text
~/.poc-vault/secrets/config.env
```

and fill in local values there.

Local iOS signing, bundle id, and real vault endpoint values also belong in that
ignored config file, not in the Xcode project or docs.

## Before Pushing

Run:

```bash
git status --short
git ls-files | rg '\.(p12|pem|key|crt|csr|mobileconfig)$' || true
git grep -n -I -E 'AKIA|BEGIN .*PRIVATE KEY|PRIVATE KEY|AWS_SECRET|IPHONE_P12_PASSWORD=|password=' || true
```

Review any matches manually. References to secret *paths* are okay; secret
values are not.

## Access Model

The live service blocks ordinary public clients, but access is certificate
based. Any client with a valid client certificate can access the vault.

For stronger device binding, generate the private key on the iPhone and avoid
exporting it to the Mac or repo tooling.

## Codex API Security

The Codex API is not part of the static POC manifest contract. Its local
workspace lives inside this repo at:

```text
/Users/pariksj/Desktop/poc-vault/codex-server
```

Live `/v1/codex/*` routes require:

- nginx mTLS verification success
- exact subject allowlist configured by `CODEX_ALLOWED_CERT_SUBJECTS`
- backend re-check of the forwarded certificate subject
- session/thread listing should expose metadata only, not raw transcript content
- transcription requests should require the same mTLS boundary and must keep
  Azure Speech credentials only in server-side environment files

The Codex runner must not be able to read POC Vault private material:

```text
/etc/poc-vault/tls/client-ca.key
/etc/poc-vault/tls/server.key
~/.poc-vault/secrets/signing/manifest-ed25519.key
```

On the VM, Codex jobs run as `codex-runner`, with runtime data under
`/var/lib/codex-api` and predefined workspaces under `/srv/codex-workspaces`.
Do not change the app or API to accept arbitrary workspace paths from the phone.
