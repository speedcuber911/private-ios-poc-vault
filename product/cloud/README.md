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
| `POST /v1/trial-nodes` | session | body `{pairingId, pairingSecret}`; provisions a trial sandbox for the account; 404 `trial_unavailable` when no provisioner is configured, 409 `trial_already_used` (unless the account's existing trial is `failed`, in which case it's retried in place), 503 `trial_capacity`, 502 `provision_failed` |
| `GET/DELETE /v1/trial-nodes/current` | session | poll trial state, or tear it down early (kills the sandbox, deletes the node) |
| `POST /v1/trial-nodes/enroll` | single-use enroll token (`{token}` in body) | the sandbox's own bootstrap call — registers its node identity, burns the token, returns `{ok, sni}` |
| `POST /v1/pairing/sessions` | session | → `{pairingId, secret, expiresAt}`; only the sha256 of the secret is stored |
| `POST/GET /v1/pairing/sessions/:id/device-blob` | `X-Pairing-Auth` | opaque bytes (CSR direction); ≤64 KiB |
| `POST/GET /v1/pairing/sessions/:id/node-blob` | `X-Pairing-Auth` | opaque bytes (issued-cert direction); ≤64 KiB |
| `POST/GET /v1/repos` | session | register a `owner/name` GitHub repo for handoffs, or list the account's |
| `POST /v1/handoffs` | session | `{handoffId, repo, branch, nodeId}`; records the row the node will collect. 404 `unknown_repo` if the repo was never registered, `unknown_node` if the node is not the account's |
| `GET /v1/handoffs?repo=` | session | the account's handoffs for one repo — this is what `relay status` reads |
| `GET /v1/node/handoffs` | ed25519 request signature | node long-poll; leases pending rows to the caller |
| `POST /v1/node/handoffs/ack` | ed25519 request signature | confirms a leased batch → `delivered` |
| `POST /v1/node/handoffs/:id/ready` | ed25519 request signature | terminal success, set after the import completes |
| `POST /v1/node/handoffs/:id/fail` | ed25519 request signature | terminal failure; `reason` must be one of a closed vocabulary |
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

- `job.needs_input`, `job.completed`, `job.failed`, `handoff.ready`,
  `handoff.failed`, `credentials.failed` → **mutable** alert push
  (`apns-push-type: alert`, `mutable-content: 1`, categories
  `RELAY_NEEDS_INPUT` / `RELAY_JOB_DONE` / `RELAY_JOB_FAILED` /
  `RELAY_HANDOFF_READY` / `RELAY_HANDOFF_FAILED` /
  `RELAY_CREDENTIALS_FAILED`).
- `job.state`, `job.silence`, `node.health`, `credentials.installed` →
  **silent** background push (`apns-push-type: background`,
  `content-available: 1`).

Events are retained 7 days (`EVENT_RETENTION_DAYS`), swept every minute.

#### Banner text

`notify.js` `bannerFor` is the single place that decides what a user reads, and
therefore the single place that decides what Apple can read. It builds the
banner from **this server's own tables**, never from the event — the event
carries no text at all (see the content-free ingest schema above), so a node
cannot influence a banner even by sending fields nobody asked for.

- `handoff.ready` → *"Session ready" / "acme/widgets ·
  relay/handoff-da52e722"*
- `handoff.failed` → *"Handoff failed" / "acme/widgets ·
  relay/handoff-da52e722 — couldn't clone the branch"*, where the explanation
  comes from the five-code `HANDOFF_FAILURE_REASONS` vocabulary and never from
  free text.
- everything else → a fixed string per event type, disclosing nothing beyond
  the fact that a push happened.

**This discloses repo and branch names to Apple.** Both are already stored here
(`POST /v1/handoffs` accepts exactly those two names), but a push payload is
readable in a way the database is not, so it is a deliberate widening — made
because a banner that cannot say *which* session is ready is not worth the
interruption. Nothing follows it: no transcript, prompt, manifest, or session
title. The handoff a banner names is found by looking up the newest row for
that node in the matching terminal state, within a 5-minute window; outside the
window, or with no matching row, the banner degrades to generic wording rather
than naming a stale handoff.

`mutable-content: 1` is still set on every alert push. A Notification Service
Extension does not exist in the app today (an unresolvable `loc-key` is why
every banner used to read literally `RELAY_EVENT`); if one is added it can
rewrite this text from the node over mTLS, and the names can come back out of
the payload.

`apns.send()` never throws and never reports a rejected push as success: it
returns a classified outcome (`delivered`, `unregistered`, `auth_failed`,
`rejected`, `unavailable`, `timeout`, `error`, `skipped`). A fanout that read
"the promise resolved" as "Apple accepted it" is how a rotated-out signing key
becomes invisible while every push 403s. With APNs unconfigured, sends
short-circuit to `skipped` **before** any provider JWT is minted — the token is
built while assembling the request headers, so without that guard an unset
signing key throws out of `send()` entirely and the noop transport never gets a
say.

### Handoffs

A handoff moves a stopped local coding session onto the account's sandbox. The
sealed session blob travels through **GitHub**, on a `relay/handoff-*` branch —
never through this service. The cloud only ever learns names: a repo full name,
a branch name, a handoff id, and a state.

```text
pending ──lease──> leased ──ack──> delivered ──┬──> ready    (import succeeded)
                                               └──> failed   (import did not)
```

- **`pending`** — the row exists and nothing has collected it. From the desk a
  `pending` row and a powered-off machine are indistinguishable, so `pending`
  must never be reported as success.
- **`leased`** — a node's long-poll took the row. Leases expire, so a node that
  dies mid-collection does not strand the handoff.
- **`delivered`** — the node acked the lease. This means only *"the node took
  it"*: the ack fires **before** the import runs, so `delivered` says nothing
  about whether the handoff actually worked.
- **`ready`** — the node cloned, decrypted, staged and imported successfully.
  This is the only state that means success.
- **`failed`** — terminal, and it wins: a node that already reported a failure
  cannot walk the row back to `ready`, so a crash-loop cannot flap the state
  the user is reading.

`failed` reasons are validated against a closed vocabulary — `clone_failed`,
`decrypt_failed`, `manifest_invalid`, `workspace_failed`, `internal_error` —
rather than stored verbatim. A free-text reason from a node is exactly the
shape a content leak takes, and this service is content-free by design.

Both node routes answer an unknown id and another node's id with an identical
404 `unknown_handoff`, so a node cannot probe for the existence of rows it does
not own.

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

`POST /v1/trial-nodes` (session-authed) takes `{pairingId, pairingSecret}` in
the body — the caller (iOS) creates the pairing session first via
`POST /v1/pairing/sessions` and passes its id plus the raw pairing secret
through so the sandbox can be handed the same secret via env vars (below);
a missing/malformed pair is `400 pairing_required`. The route is gated by
one-trial-per-account (409 `trial_already_used`) and a global concurrency
cap (`TRIAL_MAX_ACTIVE`, 503 `trial_capacity`), then calls the provisioner
(`src/provisioner.js`) to create a sandbox and hands it a single-use enroll
token plus tunnel coordinates via env vars
(`RELAYD_ENROLL_URL/TOKEN/PAIRING_ID/PAIRING_SECRET`,
`RELAYD_TUNNEL_HOST/PORT/SUFFIX`) — none of which are ever returned to the
caller. If `E2B_API_URL` is unset the provisioner is `null` and the route
404s `trial_unavailable`, which is how the fork screen's "Try instantly"
option feature-flags itself off.

**Retry after a failed provision.** `trial_nodes.account_id` is `UNIQUE`, so
in the ordinary case a second `POST /v1/trial-nodes` for an account that
already has a row 409s `trial_already_used` — the one-trial-per-account cap
is enforced over *provisioned machines*, not raw call attempts. The one
exception: if `provisioner.createSandbox()` throws, the existing row is
updated to `state: "failed"` (`enrollTokenHash` cleared) and the call
returns `502 provision_failed` instead of inserting a second row. Because
`existingTrial.state !== "failed"` is the only condition that still 409s, a
subsequent `POST /v1/trial-nodes` from that account is treated as a retry:
it reuses the same row in place — resetting it to `state: "creating"` with a
fresh `enrollTokenHash` and `expiresAt`, and clearing `nodeId`/`sandboxId` —
rather than being rejected or minting a second lifetime trial. Every other
state (`creating`, `ready`, `expired`, `destroyed`) is legitimately spent and
still 409s. This exists because a transient provisioner failure (the Cube
host briefly unreachable, a template pull failure, etc.) must not
permanently burn the account's one lifetime trial.

The sandbox calls back to `POST /v1/trial-nodes/enroll` with its freshly
generated node identity pubkey; the cloud verifies the token against
`trial_nodes.enroll_token_hash` (the trial must still be in the `creating`
state), registers the node (`kind: "trial"`), and burns the token. From there
the trial node is indistinguishable from any other node to the rest of this
API.

A trial node does **not** consume the account's `nodes.max` entitlement: the
enroll route creates it bypassing the gate, and `POST /v1/nodes` counts only
non-trial nodes (`registry.countNodes(id, { includeTrial: false })`). Counting
it would 403 `entitlement_limit` for any trial user who tries to register their
own box — which is exactly the "Upgrade to BYO" path the trial exists to lead
into.

A reaper (`sweepTrials`, folded into the existing 60 s `runSweeps()` timer)
pauses the sandbox at `expires_at` (`TRIAL_TTL_SEC`, default 7 days) and
destroys it `TRIAL_GRACE_SEC` (default 3 days) after that, deleting the node
row. Both steps are idempotent and state-driven off `expires_at`, so a
crashed reaper pass is safe to re-run. Each row is isolated in its own
try/catch, so one trial's failure cannot abort the pass and strand every trial
behind it, and the sweep holds an in-flight flag so a slow pass cannot be
re-entered by the next 60 s tick.

**Lifecycle enforcement is not gated on the feature flag.** `E2B_API_URL`
switches off *creating* trials; the reaper keeps running without it, because a
kill switch that also froze every existing trial would leave users with
indefinite access. Expiring access (state, enroll token, node row) is pure
control-plane work and always happens. Only the sandbox-destroying half needs
the provisioner — see "Orphaned sandboxes" below for what happens when it is
absent or unreachable.

**Account deletion destroys the sandbox.** `deleteAccount` drops the
`trial_nodes` row, after which nothing can map the account back to a live
microVM, so the Better Auth `deleteUser.afterDelete` hook releases the sandbox
first (`beforeAccountDelete` in `server.js`). A failure there is recorded as an
orphan rather than aborting the deletion: an unreachable Cube host must never
make an account undeletable.

### Orphaned sandboxes

A sandbox Relay still believes is running but can no longer reach through
`trial_nodes` is recorded in `sandbox_orphans` (sandbox id, trial id, account
id, reason) instead of being silently forgotten. Two ways in: account deletion
with the provisioner unreachable, and the reaper reaching its destroy point
while the trial feature is switched off. Every sweep retries the backlog and
clears each row as soon as the destroy succeeds.

One window this does not cover: `createSandbox` returning after the machine
exists but before the row learns its id. A response with no usable `sandboxID`
is now a hard failure (the row lands in `failed` and the account can retry)
rather than being silently recorded as nothing, but a crash between the create
returning and the `updateTrial` write still leaves a machine with no id
anywhere. `metadata.trialId` is set on every sandbox, so the backstop for that
window is a Cube-list-vs-`trial_nodes` reconciliation sweep — **not yet built**.

The provisioner itself speaks the E2B REST protocol (`POST /sandboxes`,
`DELETE /sandboxes/:id`, `POST /sandboxes/:id/pause`, `x-api-key` auth)
against whatever `E2B_API_URL` points at — a self-hosted Cube host today,
hosted e2b later, with no code change. Every call carries an
`AbortSignal.timeout` (`TRIAL_PROVISIONER_TIMEOUT_MS`, default 30 s): Node's
fetch has no default timeout, and an unbounded call inside the reaper would
stall the whole pass indefinitely with nothing to detect it.

The sandbox-level `timeout` sent on create is in **seconds** — the unit the
E2B/Cube protocol defines, forwarded unconverted into
`context.WithTimeout(ctx, timeout * time.Second)`. It is derived from the trial
lifecycle (`ttl + grace + 1 h`, overridable with `TRIAL_SANDBOX_TIMEOUT_SEC`)
rather than being an independent constant, so the platform-level auto-kill
expires just *after* Relay's own destroy point and acts as the backstop for
orphans instead of killing live trials. Two traps this deliberately avoids:
sending milliseconds asks for ~41 days (the auto-kill never fires), and a naive
divide-by-1000 of the old 1-hour constant would destroy every trial machine an
hour after signup. Cube treats an absent or zero `timeout` as its own 60-second
default, so the value is validated at the call site and an unusable one fails
the create outright.

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
# APNs — all FOUR are required together. If any one is missing the service
# starts normally, logs "APNs credentials unset — pushes will be skipped,
# ingest still works", and every send returns the SKIPPED outcome. Events are
# still ingested and stored; only the push is dropped. Partial configuration
# is treated as unconfigured, not as an error.
APNS_KEY_ID=<key-id>
APNS_TEAM_ID=<team-id>
APNS_BUNDLE_ID=<app-bundle-id>
APNS_SIGNING_KEY_P8=<contents of the .p8, PEM>
# Defaults to api.push.apple.com. A sandbox (development-build) device token
# sent to the production host is rejected with BadDeviceToken, and vice versa —
# this host must match the build the token came from.
APNS_HOST=api.sandbox.push.apple.com

# Trial sandboxes — optional; unset E2B_API_URL disables CREATING trials (the
# fork screen hides "Try instantly" and POST /v1/trial-nodes 404s). The reaper
# keeps enforcing expiry on existing trials either way.
#
# All-or-nothing: if E2B_API_URL is set, the service REFUSES TO START unless
# E2B_API_KEY, TRIAL_TEMPLATE_ID, ENROLL_BASE_URL, TUNNEL_HOST and
# TUNNEL_SUFFIX are all present. A half-configured trial feature fails
# silently and plausibly otherwise — without ENROLL_BASE_URL the sandbox
# enrols against loopback (itself), and without TUNNEL_SUFFIX the phone gets a
# null SNI and quietly talks to the wrong machine.
E2B_API_URL=<cube-or-e2b-api-url>
E2B_API_KEY=<api-key>
TRIAL_TEMPLATE_ID=relay-trial
TUNNEL_HOST=<broker-host>
TUNNEL_PORT=<broker-tunnel-port>
TUNNEL_SUFFIX=.tun.<domain>
ENROLL_BASE_URL=https://api.<domain>
# TRIAL_TTL_SEC / TRIAL_GRACE_SEC / TRIAL_MAX_ACTIVE / TRIAL_PROVISIONER_TIMEOUT_MS
# all have sane defaults (7d / 3d / 20 / 30s) and need not be set explicitly.
# TRIAL_SANDBOX_TIMEOUT_SEC (SECONDS — the E2B/Cube protocol's unit) defaults to
# ttl + grace + 1h so the platform auto-kill backstops orphans rather than
# killing live trials; override only with that relationship in mind.
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
