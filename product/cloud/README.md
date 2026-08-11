# relay-cloud — Relay account and control-plane service (W3)

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
  provisioner.js  E2B-protocol sandbox provisioner (trial machines) — backend
                  agnostic: self-hosted Cube today, hosted e2b via endpoint swap
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
| `POST /v1/trial-nodes` | session | provisions a trial sandbox for the account; 404 `trial_unavailable` when no provisioner is configured, 409 `trial_already_used`, 503 `trial_capacity` |
| `GET/DELETE /v1/trial-nodes/current` | session | poll trial state, or tear it down early (kills the sandbox, deletes the node) |
| `POST /v1/trial-nodes/enroll` | single-use enroll token (`{token}` in body) | the sandbox's own bootstrap call — registers its node identity, burns the token, returns `{ok, sni}` |
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

### Trial sandboxes

Every signup can get one instantly-provisioned trial machine
(`revamp/07-trial-sandbox-plan.md`). It is an ordinary node with
`kind: "trial"` — same broker tunnel, same mTLS, same jail — that happens to
have been created by the cloud instead of a user's own box.

`POST /v1/trial-nodes` (session-authed) is gated by one-trial-per-account
(409 `trial_already_used`) and a global concurrency cap (`TRIAL_MAX_ACTIVE`,
503 `trial_capacity`), then calls the provisioner (`src/provisioner.js`) to
create a sandbox and hands it a single-use enroll token plus tunnel
coordinates via env vars (`RELAYD_ENROLL_URL/TOKEN/PAIRING_ID/PAIRING_SECRET`,
`RELAYD_TUNNEL_HOST/PORT/SUFFIX`) — none of which are ever returned to the
caller. If `E2B_API_URL` is unset the provisioner is `null` and the route
404s `trial_unavailable`, which is how the fork screen's "Try instantly"
option feature-flags itself off.

The sandbox calls back to `POST /v1/trial-nodes/enroll` with its freshly
generated node identity pubkey; the cloud verifies the token against
`trial_nodes.enroll_token_hash` (the trial must still be in the `creating`
state), registers the node (`kind: "trial"`), and burns the token. From there
the trial node is indistinguishable from any other node to the rest of this
API.

A reaper (`sweepTrials`, folded into the existing 60 s `runSweeps()` timer)
pauses the sandbox at `expires_at` (`TRIAL_TTL_SEC`, default 7 days) and
destroys it `TRIAL_GRACE_SEC` (default 3 days) after that, deleting the node
row. Both steps are idempotent and state-driven off `expires_at`, so a
crashed reaper pass is safe to re-run.

The provisioner itself speaks the E2B REST protocol (`POST /sandboxes`,
`DELETE /sandboxes/:id`, `POST /sandboxes/:id/pause`, `x-api-key` auth)
against whatever `E2B_API_URL` points at — a self-hosted Cube host today,
hosted e2b later, with no code change.

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

## Deployment

The control plane is live at
`https://relay.ai-rocket-experiments.com` on the shared `poc-ec2` host in
`ap-south-1`. nginx terminates TLS and proxies to the loopback-only service at
`127.0.0.1:8790`. The raw tunnel broker and the agent runner are separate trust
boundaries and were not moved as part of this deployment.

The full deployment record, current release, AWS resources, verification, and
rollback instructions are in
[`docs/RELAY_POC_EC2_DEPLOYMENT.md`](../../docs/RELAY_POC_EC2_DEPLOYMENT.md).

### Host installer and systemd

`deploy/install.sh` installs a dedicated, checksum-verified Node 22 runtime,
creates immutable `/opt/relay-cloud/releases/<release-id>` directories,
generates first-install secrets on the host, installs the hardened
`deploy/relay-cloud.service`, and rolls back the release symlink if health does
not recover. The service runs as `relaycloud`, uses `UMask=0077`, writes only to
`/var/lib/relay-cloud`, and reads `/etc/relay-cloud/env`.

Example direct invocation on a target host:

```bash
sudo env \
  RELAY_PUBLIC_BASE_URL=https://api.example.com \
  RELAY_CLOUD_BIND_HOST=127.0.0.1 \
  RELAY_CLOUD_PORT=8790 \
  RELAY_BACKUP_S3_URI=s3://example-private-bucket/relay-cloud \
  RELAY_RELEASE_ID=<git-sha> \
  bash deploy/install.sh /path/to/release-source
```

`/etc/relay-cloud/env` contains the following shape. Values are generated or
installed on the target and must never be committed or printed:

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

# Trial sandboxes — optional; unset E2B_API_URL disables the feature (the
# fork screen hides "Try instantly" and POST /v1/trial-nodes 404s):
E2B_API_URL=<cube-or-e2b-api-url>
E2B_API_KEY=<api-key>
TRIAL_TEMPLATE_ID=relay-trial
TUNNEL_HOST=<broker-host>
TUNNEL_PORT=<broker-tunnel-port>
TUNNEL_SUFFIX=.tun.<domain>
ENROLL_BASE_URL=https://api.<domain>
# TRIAL_TTL_SEC / TRIAL_GRACE_SEC / TRIAL_MAX_ACTIVE / TRIAL_SANDBOX_TIMEOUT_MS
# all have sane defaults (7d / 3d / 20 / 1h) and need not be set explicitly.
```

Front with nginx terminating public TLS for `api.<domain>` and proxy only to
`127.0.0.1:8790`. `deploy/configure-nginx.py` renders either the ACME bootstrap
vhost or the TLS vhost from the checked-in templates. The scoped rate-limit
zone is in `deploy/relay-cloud-rate-limit.conf`. The broker's
`*.tun.<domain>` listener is TLS **passthrough** and entirely separate — never
terminate tunnel TLS here.

### AWS-native CI/CD

`deploy/relay-cloud-cicd.yml` provisions a dedicated CodeCommit repository,
CodePipeline, CodeBuild project, EventBridge trigger, private versioned
artifact bucket, and least-privilege deployment roles. Each `main` update:

1. runs `npm ci`, the full test suite, shell syntax checks, and Python compile
   validation on Node 22;
2. publishes a release archive excluding dependencies, databases, and caches;
3. deploys the exact commit SHA to the target through SSM;
4. requires both target-local and public `/healthz` success.

The target downloads only the permitted `releases/` artifact prefix. The
pipeline does not use SSH and does not carry runtime secrets.

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

SQLite is the live database for now. `relay-cloud-backup.timer` invokes
`deploy/backup-sqlite.sh`, which uses SQLite's online backup command, runs an
integrity check, compresses and checksums the result, and uploads it to the
configured private S3 prefix. Verify a downloaded backup in a disposable path
with `deploy/verify-backup.sh`; never restore over the live database as a test.

When PostgreSQL lands this process must be replaced with a tested PostgreSQL
backup and restore path. External uptime alerting on `GET /healthz` is still a
separate operations item.

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
- Trial sandbox provisioning: E2B/Cube-protocol provisioner
  (`provisioner.js`), `trial_nodes` registry, the session-authed
  create/enroll/current routes, and the pause/destroy reaper — unit-tested
  against a mock provisioner; never exercised against a live Cube host.

Stubbed / deferred (production work items):

- **Mail transport**: interface only; SES (or SMTP) implementation not wired —
  `main.js` currently drops mail silently. W3 ops task.
- **APNs live transport**: `createHttp2Transport` is written but has never
  spoken to Apple; no connection pooling, no `410 Unregistered` token cleanup,
  no delivery receipts. Live Activity channel not implemented.
- **Broker integration**: the hook now has a caller — `broker/internal/registry`
  resolves it as an opt-in fallback (`-registry-url`/`-registry-token-file`)
  when a node id misses the broker's static flag registry, which remains the
  default. Connection draining, metrics, revocation push (early cache
  invalidation instead of waiting out the 60 s TTL) → broker work package.
- **Rate limiting / abuse controls**: the live nginx vhost has a scoped per-IP
  request limit and a bounded request body; route-specific and account-level
  application limits are still a fast follow.
- **Pairing session creation auth**: requires an account session today. The
  headless-installer flow (node creates the session via a short enroll code
  printed by `install.sh`) is not built; W2's enrollment work defines it.
- **Postgres DAL**: SQLite only; the registry API is the seam.
- **Billing / web dashboard**: out of W3 scope, not present. (The trial
  sandbox provisioner itself is now real — see "Real, tested" above; that is
  provisioning, not billing.)
- **Admin surface**: read-only node list only.
- **IaC**: the CodeCommit/CodeBuild/CodePipeline/SSM release path and its
  buckets/roles are CloudFormation-managed. The pre-existing VPC, EC2,
  security group, Route 53 zone/record, nginx, and certificate remain
  intentionally outside this stack.

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
