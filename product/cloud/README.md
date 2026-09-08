# relay-cloud — Relay account and control-plane service (W3)

Node 22 ESM with Better Auth. Storage is `node:sqlite` behind a
thin DAL (`src/db.js` + `src/registry.js`) written in portable SQL — TEXT ids
generated in code, INTEGER epoch-ms timestamps, base64 TEXT for binary — so a
Postgres client can replace it without touching the API layer.

The guiding rule from the product plan holds everywhere: **the cloud is a
rendezvous, not a platform.** No content storage and no CA keys. Cloud sessions
never read files or submit jobs, and node data never transits this server.
Managed/token-authenticated nodes do renew one short account-access lease on
their existing signed long-poll: this lets an owner disconnect a computer and
revoke the node data path without making the cloud a proxy for that path.

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
  app-store.js Apple subscription verification — retained, but nothing in the
               product calls it any more (see "App Store subscriptions" below)
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
| `GET/DELETE /v1/auth/device/link` | session | read or disconnect the account's linked computer; DELETE durably revokes managed-node access until a replacement is approved |
| `POST /v1/auth/magic-link/request` | none | always 202/400 — no enumeration |
| `POST /v1/auth/magic-link/confirm` | none | `{token}` → session |
| `POST /v1/auth/device/start` | none | `{client: "cli"\|"web"}` (default `cli`) → device code; `verificationUri` from `DEVICE_LOGIN_URL` |
| `POST /v1/auth/device/token` | none | `cli`: session JWT + computer slot. `web`: Better Auth cookie, no CLI slot |
| `POST /v1/auth/device/inspect` | session | lookup-first; returns `client`; `computer_already_linked` only for `cli` |
| `POST /v1/auth/device/approve` | session | lookup-first; web may approve while a CLI computer is already linked |
| `GET /v1/auth/places` | session | `{ computer, browsers }` — one CLI computer plus cookie browsers |
| `DELETE /v1/auth/places/browsers/:id` | session | revoke that browser cookie; 404 `unknown_browser` if missing or foreign |
| `POST /v1/waitlist` | none | `{email}`; idempotent |
| `GET /v1/account` | session | account + entitlements |
| `POST/GET /v1/devices`, `PATCH/DELETE /v1/devices/:id` | session | `apnsToken`, `platform`, `name`, `certSerials` |
| `POST/GET /v1/nodes`, `GET/DELETE /v1/nodes/:id` | session | create is entitlement-gated (`nodes.max`) and validates the ed25519 pubkey; `DELETE` removes the account's node record and nothing else — the machine itself belongs to the user |
| `POST /v1/nodes/:id/browser-grants` | session | `{ grant, expiresIn: 900, gatewayUrl }`; Ed25519 (`alg: EdDSA`); 503 if grant keys or `GRANT_GATEWAY_URL` unset |
| `POST /v1/pairing/sessions` | session | → `{pairingId, secret, expiresAt}`; only the sha256 of the secret is stored |
| `POST/GET /v1/pairing/sessions/:id/device-blob` | `X-Pairing-Auth` | opaque bytes (CSR direction); ≤64 KiB |
| `POST/GET /v1/pairing/sessions/:id/node-blob` | `X-Pairing-Auth` | opaque bytes (issued-cert direction); ≤64 KiB |
| `POST/GET /v1/repos` | session | register a `owner/name` GitHub repo for handoffs, or list the account's |
| `POST /v1/handoffs` | session | `{handoffId, repo, branch, nodeId}`; records the row the node will collect. 404 `unknown_repo` if the repo was never registered, `unknown_node` if the node is not the account's |
| `GET /v1/handoffs?repo=` | session | the account's handoffs for one repo — this is what `relay status` reads |
| `GET /v1/node/handoffs` | ed25519 request signature | node long-poll; leases pending rows and renews the short account-access decision consumed locally by relayd |
| `POST /v1/node/handoffs/ack` | ed25519 request signature | confirms a leased batch → `delivered` |
| `POST /v1/node/handoffs/:id/ready` | ed25519 request signature | terminal success, set after the import completes |
| `POST /v1/node/handoffs/:id/fail` | ed25519 request signature | terminal failure; `reason` must be one of a closed vocabulary |
| `POST /v1/node-events` | ed25519 body signature | see below |
| `GET /v1/tunnel/nodes/:nodeId` | `Bearer $BROKER_TOKEN` | broker authorization hook, see contract |
| `GET /v1/admin/nodes` | `Bearer $ADMIN_TOKEN` | ops-only; response omits pubkeys |
| `GET /v1/admin/accounts` | Better Auth admin session | paginated `{ accounts }` with nodes and entitlements; newest first; `limit` default 50 max 100 |

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

A handoff moves a stopped local coding session onto one of the account's
registered machines. The
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

This is no longer the primary way a phone pairs. A phone that can reach the
node directly scans the QR code the node prints and POSTs to the node's own
`/v1/pair`; the cloud is not involved and never sees the exchange. The
rendezvous remains for `sync-auth`, `session-index` and the case where the two
sides cannot talk to each other directly.

### Device-code login (`cli` | `web`)

One mechanism, two clients. `POST /v1/auth/device/start` accepts
`client: "cli"` (default) or `"web"`. The CLI occupies the account's single
computer slot. The web client mints a Better Auth session cookie and does
not take that slot.

`POST /v1/auth/device/inspect` and `/approve` look up the code first.
Unknown, expired, consumed, and already-approved codes all return the same
404. `computer_already_linked` (409) is only for `cli` — a web code can be
inspected and approved while a CLI computer is already linked.

`verificationUri` / `verificationUriComplete` are built from
`DEVICE_LOGIN_URL`. If that env is unset, `config.js` falls back to
`https://relay.example/cli-login` and `relay login` QR-encodes the same
dead domain. The `/cli-login` page now exists in `product/web`; pointing
the host at `https://<app-origin>/cli-login` is still an operator step.
The user code rides in the URL hash so it never hits access logs.

Web token redemption (`POST /v1/auth/device/token` with `client: "web"`)
sets a Better Auth cookie (`SameSite=None` only when `RELAY_WEB_ORIGINS`
is set, otherwise `Lax`; `Secure` only when
`BETTER_AUTH_URL` is https). `RELAY_WEB_ORIGINS` (comma-separated exact
origins) is appended to Better Auth `trustedOrigins` and is the CORS
allowlist for credentialed JSON (`Access-Control-Allow-Credentials: true`,
echoed `Origin`, `Vary: Origin`; never `*`). A non-allowlisted origin gets
no `Access-Control-Allow-Origin`. Apple-only accounts (phone Sign in with
Apple, no Better Auth `user` row yet) get a Better Auth user created with
the same id as the Relay account on first web-token redemption, then the
cookie. `400 { "error": "web_session_unavailable" }` is only if that link
cannot be minted (no email, or the email is already a different Better Auth
user); the device code is not consumed.

If `RELAY_WEB_ORIGINS` is set, `main.js` refuses to start unless
`BETTER_AUTH_URL` is https — SameSite=None cookies are otherwise unusable
from the app origin.

#### CSRF on the cookie path

`SameSite=None` is what lets the SPA send its cookie cross-origin, and it
is also the browser CSRF protection the bearer-only API used to get for
free. Two guards replace it on `/v1/*` state-changing methods (`POST`,
`PUT`, `PATCH`, `DELETE`):

- An `Origin` header that is present and is neither in `RELAY_WEB_ORIGINS`
  nor equal to `BETTER_AUTH_URL` is `403 { "error": "forbidden_origin" }`.
  Browsers always send `Origin` on these methods; iOS, the CLI and relayd
  send none and are unaffected.
- A body arriving as `text/plain`, `application/x-www-form-urlencoded`, or
  `multipart/form-data` is `415 { "error": "unsupported_media_type" }`.
  Those three are exactly the content types a cross-origin POST can use
  *without* a preflight, so they must never reach a JSON parser.

`/api/auth/*` is deliberately excluded from both: Better Auth enforces its
own `trustedOrigins` there, and Apple's `form_post` OAuth callback is a
legitimate `x-www-form-urlencoded` POST. Regression: `test/csrf.test.mjs`,
which replays a cross-site approve of an attacker's `client=web` device
code and asserts no session is ever minted.

### Browser activity grants

The cloud signs short-lived Ed25519 JWTs (`alg: EdDSA`) that authorize
read-only activity through the grant gateway. Signing is public-key only:
`BROWSER_GRANT_PRIVATE_KEY` (PKCS8 PEM) stays on the control-plane host;
`BROWSER_GRANT_PUBLIC_KEY` (raw 32-byte base64url) is what nodes verify
against.

`POST /v1/nodes/:id/browser-grants` (session) returns
`{ grant, expiresIn: 900, gatewayUrl }` for a node owned by the account,
or an identical 404 for unknown and cross-account ids. Claims: `sub`,
`node`, `scope` (`jobs.read`, `threads.read`, `events.read`), `iat`,
`exp`, `jti`. Grants are unrevocable until `exp`.

`BROWSER_GRANT_PRIVATE_KEY`, `BROWSER_GRANT_PUBLIC_KEY`, and
`GRANT_GATEWAY_URL` must be set together or the route 503s
`grants_unavailable`. There is no enrollment channel that distributes the
public key any more: an operator who wants browser grants against a
user-owned node sets `RELAYD_GRANT_PUBLIC_KEY` on that node themselves.

The grant gateway (`product/grant-gateway`) listens on `127.0.0.1:8791`.
TLS and nginx live on the **broker host**, as a sibling
`gateway.<api-zone>`. Do not terminate on poc-ec2. Do not put the raw
broker on 80/443. Set `RELAY_WEB_ORIGINS` on the gateway the same way as
cloud (comma-separated exact origins) so `OPTIONS /activity/{jobs,threads,events}`
is 204 with `authorization` allowed; a foreign origin gets no ACAO.

### App Store subscriptions (retained, not wired to anything)

`app-store.js`, the `apple_subscriptions` table, the Apple root certificates
under `certs/`, and `POST /v1/subscriptions/apple/verify` /
`POST /v1/subscriptions/apple/notifications` are all still here and still
tested. Nothing in the product calls them. They used to gate hosted-machine
lifetime; there are no hosted machines, so they gate nothing.

They are kept so the App Store Connect subscription items stay valid, not
because they do any work. No iOS or web surface offers a purchase. If you are
looking for what turns a subscription into access, there is nothing to find —
that coupling was the part that was deleted.

The App Store Server Notifications V2 URL configured in App Store Connect is
still:

```text
https://relay.ai-rocket-experiments.com/v1/subscriptions/apple/notifications
```

Product ids and the numeric App Store app id can still be overridden with
`APP_STORE_HOSTED_MONTHLY_PRODUCT_ID`, `APP_STORE_HOSTED_YEARLY_PRODUCT_ID`,
and `APP_STORE_APP_APPLE_ID`. `APP_STORE_ONLINE_CHECKS=0` is for isolated tests
only. Never replace the checked-in `.cer` roots with a private key.

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
RELAY_WEB_ORIGINS=https://<app-origin>
APPLE_CLIENT_IDS=<app-bundle-id>,<services-id>
APPLE_CLIENT_SECRET=<Apple ES256 client-secret JWT>
MAGIC_LINK_BASE_URL=https://<domain>/auth/confirm
ADMIN_TOKEN=<random>
RELAY_ADMIN_EMAILS=<comma-separated operator emails>
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

# Broker tunnel coordinates, for nodes that reach the phone through the broker
# rather than being directly reachable. Not required otherwise.
TUNNEL_HOST=<broker-host>
TUNNEL_PORT=<broker-tunnel-port>
TUNNEL_SUFFIX=.tun.<domain>
```

`E2B_API_URL`, `E2B_API_KEY`, `TRIAL_TEMPLATE_ID`, every `TRIAL_*`,
`ENROLL_BASE_URL` and `NODE_TLS_*` are gone from `config.js`. **Remove them from
`/etc/relay-cloud/env` on the host**, or the service will start and silently
ignore them, which reads like configuration that works.

Front with nginx terminating public TLS for `api.<domain>` and proxy only to
`127.0.0.1:8790`. `deploy/configure-nginx.py` renders either the ACME bootstrap
vhost or the TLS vhost from the checked-in templates. The scoped rate-limit
zone is in `deploy/relay-cloud-rate-limit.conf`. The broker's
`*.tun.<domain>` listener is TLS **passthrough** and entirely separate — never
terminate tunnel TLS here.

### Web console (operator env)

`product/web` is a Vite+React app (login, phone QR, `/cli-login`, admin,
activity). It has no machine list and no provisioning page — the control plane
cannot create a machine. Do **not** deploy it via CodeCommit `relay-cloud` or
`ops/deploy-poc`.

Operator checklist (names and URL shapes only; generate values on the
host and never commit them):

1. Generate an Ed25519 grant keypair on the control-plane host; set
   `BROWSER_GRANT_PRIVATE_KEY` / `BROWSER_GRANT_PUBLIC_KEY`.
2. Set `DEVICE_LOGIN_URL=https://<app-origin>/cli-login`.
3. Set `BETTER_AUTH_URL=https://api.<domain>` (https required whenever
   `RELAY_WEB_ORIGINS` is set; otherwise `main.js` refuses to start).
4. Set `RELAY_WEB_ORIGINS=https://<app-origin>` on relay-cloud **and** on
   the grant gateway (`/etc/relay-grant-gateway/env`). Exact-origin CORS
   allowlist; never `*`.
5. Set `GRANT_GATEWAY_URL=https://gateway.<api-zone>`.
6. Deploy the gateway unit + nginx on the broker host.
7. Host the SPA so unknown paths rewrite to `index.html` (nginx
   `try_files $uri /index.html;`, or the equivalent on the static host).
   Without that rewrite, `/cli-login` 404s and `DEVICE_LOGIN_URL` is dead.
8. Do not deploy web via CodeCommit `relay-cloud` or `ops/deploy-poc`.

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
- **Billing**: nothing is sold. The Apple subscription verifier is retained
  and unwired (see above). The authenticated web console lives in
  `product/web` (login, `/cli-login`, admin, activity) and is **not** shipped
  through this service's CodeCommit `relay-cloud` path or `ops/deploy-poc`.
- **Machine provisioning**: removed, not deferred. The cloud has no way to
  create, pause, resume or destroy a machine, and `provisioner.js`,
  `trial_nodes` and `sandbox_orphans` are gone. Users bring their own.
- **Waitlist**: `POST /v1/waitlist` still records rows and nothing reads
  them. It gated trial capacity; there is no capacity to gate.
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
- Bearer tokens here are **control-plane only** (session, admin, broker).
  Node APIs authenticate against the node's own CA and its own device-token
  table; nothing this box holds can mint access to any node (no CA keys,
  ever). A device bearer token is derived from a pairing secret the node
  minted and the phone scanned — it never exists on this server.
- Every read is bounded; unset admin/broker tokens disable their endpoints
  rather than defaulting open; timing-safe comparisons for all token/secret
  checks.
