# relay-cloud — control-plane scaffold (W3)

Node 22 ESM with Better Auth. Storage is `node:sqlite` behind a
thin DAL (`src/db.js` + `src/registry.js`) written in portable SQL — TEXT ids
generated in code, INTEGER epoch-ms timestamps, base64 TEXT for binary — so a
Postgres client can replace it without touching the API layer.

The guiding rule from the product plan holds everywhere: **the cloud is a
rendezvous, not a platform.** No content storage, no CA keys, no data-path
auth. Cloud sessions authorize rendezvous, pairing, push routing and registry
CRUD — never file reads, never job submission. The node data path is mTLS-only
and does not transit this server.

## Layout

```
src/
  main.js      entrypoint: env config, sweeps timer, signal handling
  server.js    node:http router, auth tiers, bounded body reads
  config.js    env → config (no secrets ever echoed)
  db.js        node:sqlite open + portable schema
  registry.js  DAL: accounts, devices, nodes, entitlements, waitlist,
               refresh tokens, magic links, pairing sessions, node events
  auth.js      Sign in with Apple (JWKS via injectable fetcher), magic link
               (injectable mail transport), HS256 session JWT + rotating refresh
  better-auth.js  Better Auth username/password + Apple native-token sign-in,
                  bearer sessions, migrations, and hard account deletion
  jwt.js       HS256 sign/verify, RS256 verify vs JWK (node:crypto only)
  pairing.js   rendezvous sessions; opaque blob relay; TTL sweep
  notify.js    signed node-event ingest (ed25519), APNs fanout, 7-day sweep
  apns.js      APNs HTTP/2 token-auth client shape behind injectable transport
test/
  helpers.mjs  in-memory app, fake Apple IdP, recording mail/APNs transports
  auth.test.mjs  notify.test.mjs  pairing.test.mjs  registry.test.mjs
```

Run tests: `npm test` (or `node --test 'test/*.test.mjs'`). The SQLite
ExperimentalWarning on Node 22 is expected.

## HTTP surface

| Method/Path | Auth | Notes |
| --- | --- | --- |
| `GET /healthz` | none | liveness |
| `POST /api/auth/sign-up/email` | none | Better Auth email + username + password signup |
| `POST /api/auth/sign-in/username` | none | Better Auth username/password sign-in |
| `POST /api/auth/sign-in/social` | none | native Sign in with Apple identity token |
| `GET /api/auth/get-session` | Better Auth bearer | restore native session |
| `POST /api/auth/sign-out` | Better Auth bearer | revoke current session |
| `POST /api/auth/delete-user` | Better Auth bearer | hard-delete auth + Relay control-plane account data |
| `POST /v1/auth/apple` | none | `{identityToken}` → session + refresh |
| `POST /v1/auth/refresh` | none | rotating single-use refresh tokens |
| `POST /v1/auth/magic-link/request` | none | always 202/400 — no enumeration |
| `POST /v1/auth/magic-link/confirm` | none | `{token}` → session |
| `POST /v1/waitlist` | none | `{email}`; idempotent |
| `GET /v1/account` | session | account + entitlements |
| `POST/GET /v1/devices`, `PATCH/DELETE /v1/devices/:id` | session | `apnsToken`, `platform`, `name`, `certSerials` |
| `POST/GET /v1/nodes`, `GET/DELETE /v1/nodes/:id` | session | create is entitlement-gated (`nodes.max`) and validates the ed25519 pubkey |
| `POST /v1/pairing/sessions` | session | → `{pairingId, secret, expiresAt}`; only the sha256 of the secret is stored |
| `POST/GET /v1/pairing/sessions/:id/device-blob` | `X-Pairing-Secret` | opaque bytes (CSR direction); ≤64 KiB |
| `POST/GET /v1/pairing/sessions/:id/node-blob` | `X-Pairing-Secret` | opaque bytes (issued-cert direction); ≤64 KiB |
| `POST /v1/node-events` | ed25519 body signature | see below |
| `GET /v1/tunnel/nodes/:nodeId` | `Bearer $BROKER_TOKEN` | broker authorization hook, see contract |
| `GET /v1/admin/nodes` | `Bearer $ADMIN_TOKEN` | ops-only; response omits pubkeys |

All responses carry `cache-control: no-store` and
`x-content-type-options: nosniff`. All body reads are bounded (JSON 32 KiB,
events 16 KiB, pairing blobs 64 KiB) and oversize uploads get a clean 413.

### Node events (`POST /v1/node-events`)

Body: `{nodeId, jobId, type, ts}` — ids and a type only; **no titles, no
prompts, no content**. Header `X-Relay-Signature`: base64url detached ed25519
signature over the exact raw body bytes, verified against the node's
registered pubkey (SPKI PEM or base64 raw 32 bytes accepted at registration).

Push mapping (asserted in tests):

- `job.needs_input`, `job.completed`, `job.failed` → **mutable** alert push
  (`apns-push-type: alert`, `mutable-content: 1`, categories
  `RELAY_NEEDS_INPUT` / `RELAY_JOB_DONE` / `RELAY_JOB_FAILED`). The
  Notification Service Extension fetches real content from the node over the
  tunnel (mTLS) and rewrites the banner — content never rests here.
- `job.state`, `job.silence`, `node.health` → **silent** background push
  (`apns-push-type: background`, `content-available: 1`).

Events are retained 7 days (`EVENT_RETENTION_DAYS`), swept every minute.

### Pairing rendezvous

The cloud never parses blob contents; they are stored as bytes and returned
verbatim. The CSR⇄cert exchange runs end-to-end between device and node —
compromise of this box cannot mint access to any node. Sessions expire after
15 minutes (`PAIRING_TTL_SEC`) and are physically deleted by the sweep.

## Broker contract (tunnel-registry hook)

The Go broker (product/broker, W1) authorizes each inbound node tunnel
connection against the registry:

```
GET /v1/tunnel/nodes/<node-id>
Authorization: Bearer <BROKER_TOKEN>

200 → {"nodeId": "...", "accountId": "...", "kind": "byo|managed", "pubkey": "<SPKI PEM>"}
404 → {"error": "unknown_node"}          (broker MUST refuse the connection)
401 → {"error": "unauthorized"}          (token mismatch/unset — hook disabled)
```

Production integration expectations:

1. On node connect, the broker reads the claimed `<node-id>`, calls this hook,
   and challenges the node to sign a fresh nonce with the key matching
   `pubkey` (ed25519). No signature, no tunnel. The broker never receives or
   holds any private key.
2. The broker routes `​<node-id>.tun.<domain>` by SNI and pipes **raw bytes**;
   TLS terminates on the node, which requires a client cert from its own CA.
   This hook authorizes attachment only — it plays no role in data-path auth.
3. Cache 200 responses briefly (≤60 s) if needed; never cache 404s across a
   registration, and drop the tunnel when a cached node is deleted (a
   revocation-push channel broker←cloud is a later work item).
4. `BROKER_TOKEN` is control-plane ops auth between two boxes we run; it is
   not exposed to users or nodes and never appears on the data path.

## Deploy (single EC2, ap-south-1, genericized)

One small instance (e.g. t4g.small), Ubuntu LTS, ports 443/80 only, Node ≥ 22
from NodeSource or tarball. No PaaS; boring on purpose.

### systemd

`/etc/systemd/system/relay-cloud.service`:

```ini
[Unit]
Description=Relay Cloud control plane
After=network-online.target
Wants=network-online.target

[Service]
User=relaycloud
Group=relaycloud
WorkingDirectory=/opt/relay-cloud
ExecStart=/usr/bin/node src/main.js
Restart=always
RestartSec=2
# Secrets via EnvironmentFile, root-owned 0600, or rendered from SSM at boot:
EnvironmentFile=/etc/relay-cloud/env
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/relay-cloud
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

`/etc/relay-cloud/env` (0600 root:root; values from SSM Parameter Store —
placeholders only, never commit real values):

```sh
HOST=127.0.0.1
PORT=8790
CLOUD_DB_PATH=/var/lib/relay-cloud/relay-cloud.sqlite
SESSION_SECRET=<32+ random bytes>
BETTER_AUTH_SECRET=<32+ random bytes; may initially match SESSION_SECRET>
BETTER_AUTH_URL=https://api.<domain>
APPLE_CLIENT_IDS=<app-bundle-id>,<services-id>
APPLE_CLIENT_SECRET=<Apple ES256 client-secret JWT>
MAGIC_LINK_BASE_URL=https://<domain>/auth/confirm
ADMIN_TOKEN=<random>
BROKER_TOKEN=<random>
APNS_KEY_ID=<key-id>
APNS_TEAM_ID=<team-id>
APNS_BUNDLE_ID=<app-bundle-id>
APNS_SIGNING_KEY_P8=<contents of the .p8, PEM>
```

Front with the existing reverse proxy (Caddy/nginx) terminating public TLS for
`api.<domain>` → `127.0.0.1:8790`. The broker's `*.tun.<domain>` listener is
TLS **passthrough** and entirely separate — never terminate tunnel TLS here.

### compose (alternative)

```yaml
services:
  relay-cloud:
    image: node:22-slim
    working_dir: /app
    command: node src/main.js
    volumes:
      - /opt/relay-cloud:/app:ro
      - relay-cloud-data:/var/lib/relay-cloud
    env_file: /etc/relay-cloud/env
    ports:
      - "127.0.0.1:8790:8790"
    restart: always
volumes:
  relay-cloud-data:
```

### Backups

SQLite for now (Postgres later — same DAL surface). Nightly snapshot to S3:

```cron
15 2 * * * root sqlite3 /var/lib/relay-cloud/relay-cloud.sqlite ".backup /tmp/relay-cloud-$(date +\%F).sqlite" && gzip -f /tmp/relay-cloud-$(date +\%F).sqlite && aws s3 cp /tmp/relay-cloud-$(date +\%F).sqlite.gz s3://<backup-bucket>/relay-cloud/ && rm -f /tmp/relay-cloud-$(date +\%F).sqlite.gz
```

(When Postgres lands this becomes the plan's `pg_dump | gzip | aws s3 cp`
line.) Add external uptime checks on `GET /healthz` and alert on non-200.

## What is real vs stubbed

Real, tested:

- Sign in with Apple identity-token verification (JWKS by kid, RS256, iss/aud/
  exp checks) — production JWKS fetcher included (5-min cache), tests inject a
  fake IdP and mint tokens with `node:crypto`.
- HS256 session JWT + single-use rotating refresh tokens (hashes at rest).
- Magic-link issue/confirm with hashed single-use tokens and TTL.
- Registry CRUD with cross-account isolation; `nodes.max` entitlement gate.
- Pairing rendezvous: hashed secret, opaque blob relay both directions,
  bounded sizes, TTL sweep.
- Signed event ingest: ed25519 verify over raw bytes, tamper/wrong-key/
  unknown-node rejection, APNs fanout with silent vs mutable classification,
  7-day retention sweep, last_seen updates.
- APNs provider-JWT construction (ES256, `ieee-p1363` JOSE signatures) — the
  full request shape is exercised against the mock transport.
- Broker hook + admin endpoint with timing-safe token compare, distinct
  tokens.

Stubbed / deferred (production work items):

- **Mail transport**: interface only; SES (or SMTP) implementation not wired —
  `main.js` currently drops mail silently. W3 ops task.
- **APNs live transport**: `createHttp2Transport` is written but has never
  spoken to Apple; no connection pooling, no `410 Unregistered` token cleanup,
  no delivery receipts. Live Activity channel not implemented.
- **Broker integration**: the hook exists; the Go broker does not call it yet.
  Connection draining, metrics, revocation push → broker work package.
- **Rate limiting / abuse controls**: none (magic-link request and waitlist
  are the exposed surfaces). Put basic per-IP limits in the fronting proxy at
  deploy time; app-level limits are a fast follow.
- **Pairing session creation auth**: requires an account session today. The
  headless-installer flow (node creates the session via a short enroll code
  printed by `install.sh`) is not built; W2's enrollment work defines it.
- **Postgres DAL**: SQLite only; the registry API is the seam.
- **Provisioner / billing / web dashboard**: out of W3 scope, not present.
- **Admin surface**: read-only node list only.
- **IaC** (VPC/SG/Route53/S3/SSM Terraform): not in this scaffold.

## Security invariants observed here

- No content storage: events are `{nodeId, jobId, type, ts}`; pairing blobs
  are opaque bytes with a TTL; push payloads carry ids only.
- Provider/API credentials never appear in responses or logs; secrets at rest
  are hashes (refresh tokens, magic links, pairing secrets); config comes
  from env only.
- Bearer tokens here are **control-plane only** (session, admin, broker) —
  node APIs remain mTLS-only; nothing this box holds can mint access to any
  node (no CA keys, ever).
- Every read is bounded; unset admin/broker tokens disable their endpoints
  rather than defaulting open; timing-safe comparisons for all token/secret
  checks.
