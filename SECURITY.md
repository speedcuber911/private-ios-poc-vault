# Security Notes

POC Vault is designed to keep private prototypes behind mutual TLS, but the repo
must stay free of credentials.

## Never Commit

- `.p12`, `.pem`, `.key`, `.crt`, `.csr`, `.mobileconfig`
- AWS credentials
- Route53 hosted-zone credentials or IAM secrets
- client CA private keys
- client certificate private keys
- manifest signing private keys
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
