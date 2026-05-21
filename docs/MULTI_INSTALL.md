# Multi-Install Setup

POC Vault can be installed by another owner against their own AWS account, EC2
instance, domain, certificates, iOS bundle id, and Codex runner. The key is to
keep all owner-specific values in a local config file outside git:

```text
~/.poc-vault/secrets/config.env
```

The tracked repository stays generic; rendered server config lives either under
`build/` locally or under `/etc` on the EC2 host.

## Install Model

Each installation owns these values:

| Area | Owner-specific values |
| --- | --- |
| AWS | `AWS_REGION`, `INSTANCE_NAME`, `INSTANCE_TYPE`, `KEY_NAME`, `HOSTED_ZONE_ID`, `ADMIN_CIDR` |
| DNS | `VAULT_DOMAIN`, `POC_WILDCARD_DOMAIN`, `CODEX_DOMAIN` |
| Server | `DEPLOY_HOST`, `DEPLOY_USER`, `SERVER_ROOT`, `TLS_DIR` |
| iOS | `BUNDLE_ID`, `DEVELOPMENT_TEAM`, manifest/signature/Codex URLs |
| Security | client CA, client certs, manifest signing key, Codex allowed certificate subjects |
| Optional speech | Azure Speech endpoint/key/model/locale |

Do not commit real config, certs, keys, `.p12` files, Codex auth JSON, or Azure
Speech secrets.

## 1. Create Owner Config

From a fresh checkout:

```bash
ops/init-install-config \
  --domain-root example.com \
  --aws-region ap-south-1 \
  --instance-name poc-vault \
  --bundle-id com.example.pocvault
```

This creates:

```text
~/.poc-vault/secrets/config.env
~/.poc-vault/secrets/ssh/poc-vault.pem
~/.poc-vault/secrets/ssh/poc-vault.pem.pub
~/.poc-vault/secrets/signing/manifest-ed25519.key
```

Edit the generated config and fill:

```bash
CLIENT_P12_PASSWORD=...
IPHONE_P12_PASSWORD=...
LE_EMAIL=you@example.com
ADMIN_CIDR=<your-ip>/32
HOSTED_ZONE_ID=<route53-zone-id>   # optional if DNS is managed elsewhere
DEVELOPMENT_TEAM=<apple-team-id>   # needed for physical iPhone builds
```

If you already have an EC2 instance, set:

```bash
DEPLOY_HOST=<ec2-public-ip-or-dns>
```

If you want the provisioning script to create EC2 and Route53 records, leave
`DEPLOY_HOST` empty and fill the AWS/DNS values.

## 2. Provision Or Point At EC2

To create/check AWS resources:

```bash
ops/provision-ec2.sh
```

The script imports the configured public key if the EC2 key pair is missing,
creates a security group, launches or starts the named instance, optionally
allocates an Elastic IP, and optionally writes Route53 records.

If you brought your own EC2, make sure it is Ubuntu-like, reachable by SSH, and
has inbound 443 open. Set `DEPLOY_HOST` in the local config.

## 3. Install Static Vault On The Server

Copy or clone this repo on the EC2 host, copy the owner config to the same path
on the host, then run:

```bash
sudo POC_VAULT_CONFIG=~/.poc-vault/secrets/config.env ops/install-server.sh
```

This installs nginx, creates the `deploy` user if needed, prepares
`/srv/poc-vault`, and renders the static vault nginx config from the owner
domains.

The script creates bootstrap TLS material only so nginx can start. Replace it
with real server certificates before treating the install as production.

## 4. Generate Client Certificates

On the operator machine:

```bash
CLIENT_P12_PASSWORD=... ops/generate-client-certs.sh operator
IPHONE_P12_PASSWORD=... ops/generate-client-certs.sh iphone
```

Copy these public CA/CRL files to the EC2 host:

```text
~/.poc-vault/secrets/client-ca.crt
~/.poc-vault/secrets/client-crl.pem
```

Install them on the host at:

```text
/etc/poc-vault/tls/client-ca.crt
/etc/poc-vault/tls/client-crl.pem
```

The Codex API installer will copy them into `/etc/codex-api/mtls` for the Codex
virtual host.

## 5. Issue Server TLS

If DNS is in Route53 and the server has AWS permissions for DNS validation:

```bash
sudo POC_VAULT_CONFIG=~/.poc-vault/secrets/config.env ops/issue-server-cert.sh
```

This issues a certificate for:

```text
VAULT_DOMAIN
POC_WILDCARD_DOMAIN
```

If DNS is managed elsewhere, install your own certificate and key at:

```text
/etc/poc-vault/tls/server.crt
/etc/poc-vault/tls/server.key
```

The Codex virtual host reuses that same server certificate.

## 6. Install Codex API

On the EC2 host, from the repo checkout:

```bash
sudo POC_VAULT_CONFIG=~/.poc-vault/secrets/config.env ops/install-codex-api.sh
```

This renders and installs:

```text
/etc/codex-api.env
/etc/nginx/conf.d/codex-api.conf
/etc/systemd/system/codex-api.service
/opt/codex-api/server.mjs
```

It also prepares:

```text
/var/lib/codex-api
/srv/codex-workspaces/scratch
/srv/codex-workspaces/poc-vault
/etc/codex-api/mtls
```

Before using jobs from the phone, install and log in the Codex CLI for the
`codex-runner` runtime. The service expects usable auth at:

```text
/var/lib/codex-api/run-home/.codex/auth.json
```

Allowed Codex subjects are configured with:

```bash
CODEX_ALLOWED_CERT_SUBJECTS=CN=iphone,CN=operator
```

Use certificate common names that match the client certificates you generated.

## 7. Deploy A Smoke POC

From the operator machine:

```bash
ops/deploy-poc \
  --slug smoke-test \
  --title "Smoke Test" \
  --description "Install verification page" \
  --source pocs/smoke-test/public \
  --force
```

Expected URL:

```text
https://smoke-test.<POC_DOMAIN_SUFFIX>/
```

Unauthenticated access should be blocked. Access with an allowlisted client
certificate should return `200`.

## 8. Configure The iPhone App

The physical app needs:

- app bundle installed with the owner `BUNDLE_ID`
- `Documents/support/client.p12`
- `Documents/support/vault-config.json`

Build/install the app with the owner bundle/team values from local config. One
manual CLI shape is:

```bash
source ~/.poc-vault/secrets/config.env
xcodebuild build \
  -project ios/POCVault/POCVault.xcodeproj \
  -target POCVault \
  -configuration Debug \
  -destination 'id=<device-id>' \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" \
  DEVELOPMENT_TEAM="$DEVELOPMENT_TEAM" \
  POC_VAULT_MANIFEST_URL="$POC_VAULT_MANIFEST_URL" \
  POC_VAULT_SIGNATURE_URL="$POC_VAULT_SIGNATURE_URL" \
  POC_VAULT_CODEX_BASE_URL="$POC_VAULT_CODEX_BASE_URL" \
  POC_VAULT_MANIFEST_PUBLIC_KEY="$POC_VAULT_MANIFEST_PUBLIC_KEY" \
  -allowProvisioningUpdates
```

Provision support files:

```bash
DEVICE=<device-id>
ops/provision-ios-support.sh --device "$DEVICE"
```

The generated support config includes:

```json
{
  "codexBaseURL": "https://codex.pocs.example.com",
  "manifestPublicKey": "<base64url-ed25519-public-key>",
  "manifestURL": "https://vault.pocs.example.com/manifest.json",
  "signatureURL": "https://vault.pocs.example.com/manifest.sig.json"
}
```

Open Diagnostics, import the certificate using `IPHONE_P12_PASSWORD`, and
confirm the keychain identity is green.

## 9. Verify

Local checks:

```bash
python3 -m py_compile ops/render-manifest.py ops/sign-manifest.py ops/deploy-poc ops/serve-simulator-poc-vault ops/render-codex-api-config
bash -n ops/init-install-config ops/install-server.sh ops/install-codex-api.sh ops/provision-ec2.sh ops/issue-server-cert.sh ops/generate-client-certs.sh ops/provision-ios-support.sh ios/launch-simulator.sh
python3 ops/render-manifest.py --pocs-dir pocs -o build/manifest.json
python3 ops/sign-manifest.py build/manifest.json --allow-missing-key
cd codex-server/codex-api-deploy && node --check server.mjs && node --test server.test.mjs
```

Live perimeter check:

```bash
ops/verify-server.sh
```

Codex config render check:

```bash
ops/render-codex-api-config
```

Expected live behavior:

- `/healthz` is public.
- `/manifest.json` is blocked without a client cert.
- `/manifest.json` returns `200` with a valid client cert.
- `https://<slug>.<POC_DOMAIN_SUFFIX>/` is blocked without a client cert.
- `https://<slug>.<POC_DOMAIN_SUFFIX>/` returns `200` with a valid client cert.
- `https://<CODEX_DOMAIN>/v1/codex/*` requires an allowlisted client subject.

## What Is Still Per-Owner

These are intentionally not shared across installs:

- AWS account and EC2 instance
- domain and DNS zone
- server TLS private key
- client CA private key
- client certificate packages
- manifest signing private key
- Apple team/bundle id
- Codex login state
- Azure Speech credentials
