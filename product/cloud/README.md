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
  provisioner.js  E2B-protocol sandbox provisioner (trial machines) — backend
                  agnostic: self-hosted Cube today, hosted e2b via endpoint swap
test/
  helpers.mjs  in-memory app, fake Apple IdP, recording mail/APNs transports
  auth.test.mjs  notify.test.mjs  pairing.test.mjs  registry.test.mjs
```

Run tests: `npm test` (or `node --test 'test/*.test.mjs'`). The SQLite
ExperimentalWarning on Node 22 is expected.

In the complete Relay checkout, also run `npm test --prefix product/integration`
from the repository root before release. That suite exercises encrypted hosted
device pairing across the actual cloud and daemon implementations; it lives
outside this standalone cloud package because it requires both source trees.

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
| `POST/GET /v1/nodes`, `GET/DELETE /v1/nodes/:id` | session | create is entitlement-gated (`nodes.max`) and validates the ed25519 pubkey |
| `POST /v1/nodes/:id/browser-grants` | session | `{ grant, expiresIn: 900, gatewayUrl }`; Ed25519 (`alg: EdDSA`); 503 if grant keys or `GRANT_GATEWAY_URL` unset |
| `POST /v1/trial-nodes` | session | body `{pairingId, pairingSecret}`; provisions a trial sandbox for the account; 404 `trial_unavailable` when no provisioner is configured, 409 `trial_already_used` (unless the account's existing trial is `failed` or `destroyed`, in which case it's retried in place), 503 `trial_capacity`, 502 `provision_failed` |
| `GET/DELETE /v1/trial-nodes/current` | session | poll trial state, or tear it down early (kills the sandbox, deletes the node); `DELETE` 409 `trial_not_deletable` when state is `upgraded` |
| `POST /v1/trial-nodes/enroll` | single-use enroll token (`{token}` in body) | the sandbox's own bootstrap call — registers its node identity, burns the token, returns `{ok, sni}` |
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
| `GET /v1/admin/accounts` | Better Auth admin session | paginated `{ accounts }` with trial, nodes, entitlements; newest first; `limit` default 50 max 100 |
| `POST /v1/admin/accounts/:id/upgrade` | Better Auth admin session | extend/resume the hosted sandbox, then grant operator hosted access, set trial `upgraded`, and raise `nodes.max` to at least 2 |
| `DELETE /v1/admin/accounts/:id/machine` | Better Auth admin session | kill the hosted sandbox, delete the node, set trial `destroyed`; 409 `nothing_to_unlink` if none |

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
  Browsers always send `Origin` on these methods; iOS, the CLI, relayd and
  the trial sandbox send none and are unaffected.
- A body arriving as `text/plain`, `application/x-www-form-urlencoded`, or
  `multipart/form-data` is `415 { "error": "unsupported_media_type" }`.
  Those three are exactly the content types a cross-origin POST can use
  *without* a preflight, so they must never reach a JSON parser.

`/api/auth/*` is deliberately excluded from both: Better Auth enforces its
own `trustedOrigins` there, and Apple's `form_post` OAuth callback is a
legitimate `x-www-form-urlencoded` POST. Regression: `test/csrf.test.mjs`,
which replays a cross-site approve of an attacker's `client=web` device
code and asserts no session is ever minted.

### Reconnect another device to an existing hosted machine

This is ordinary hosted-account functionality, not an App Review exception.
BYO pairing and the generic credential-sync notice allowlist are unchanged.

1. An authenticated owner discovers the current `ready`/`upgraded` machine
   through `GET /v1/trial-nodes/current` and its X25519 `encPubkey` through
   `GET /v1/nodes/:id`.
2. The device generates a fresh secret and creates a rendezvous using
   `POST /v1/pairing/sessions` with `{authToken, kind: "hosted-device"}`.
   It posts the normal MAC-tagged device blob first.
3. It seals `{v:1,nodeId,pairingId,secret,expiresAt}` to the node key using
   `RLYSEAL1` (`product/relayd/src/seal.mjs`, AES-256-GCM with no extra AAD).
   `expiresAt` is the returned session expiry in epoch milliseconds.
4. `POST /v1/nodes/:id/device-pairings` accepts only
   `{pairingId,sealedSecret}` (canonical base64 ciphertext), checks account,
   hosted-machine ownership, access entitlement, session kind/ownership/TTL,
   and current worker capability. It returns `202 {ok,pairingId,expiresAt}`.
   Retrying identical ciphertext is idempotent; changing it is a conflict.
5. The node requests `hostedPairing=1` on its signed handoff poll, receives the
   dedicated `devicePairings` array, decrypts and verifies all bindings, then
   completes the ordinary MAC-tagged encrypted PKCS#12 response. This queue
   never contains raw pairing secrets and is not a generic BYO pairing route.
6. The node activates an independent bearer and signs
   `POST /v1/node/device-pairings/:pairingId/ready`. Until then, the phone's
   node-blob read returns `404 not_posted_yet`. The phone verifies the blob MAC,
   pins the node CA to the expected host and stores its own bearer.

Bounds: 15-minute maximum rendezvous TTL, five pending requests per node,
twenty requests per account per hour, 4 KiB base64 envelope. Old daemons never
consume the new queue. No capability/key returns `409
hosted_pairing_upgrade_required`; a stale capability returns `503
hosted_pairing_unavailable`. Cross-account/non-hosted nodes return the same
404. Inactive hosted access is 403. Ciphertext is scrubbed on completion/expiry;
fingerprints remain at most an hour for the rate limit. Account/node deletion
cascades immediately. The cloud is still the hosted account authority: this
does not promise security against a compromised operator substituting the
node key or impersonating the owner.

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
`grants_unavailable` and trial `enroll.json` omits `grantPublicKey`
(existing phones keep working). When present, enroll.json includes
`grantPublicKey`; trial `start.sh` writes `RELAYD_GRANT_PUBLIC_KEY` and
`RELAYD_NODE_ID` into mode-0600 `runtime.env`.

The grant gateway (`product/grant-gateway`) listens on `127.0.0.1:8791`.
TLS and nginx live on the **broker host**, as a sibling
`gateway.<api-zone>`. Do not terminate on poc-ec2. Do not put the raw
broker on 80/443. Set `RELAY_WEB_ORIGINS` on the gateway the same way as
cloud (comma-separated exact origins) so `OPTIONS /activity/{jobs,threads,events}`
is 204 with `authorization` allowed; a foreign origin gets no ACAO.

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

**Retry after a failed provision or a deleted machine.** `trial_nodes.account_id`
is `UNIQUE`, so in the ordinary case a second `POST /v1/trial-nodes` for an
account that already has a row 409s `trial_already_used` — the cap is one
*live* trial, not raw call attempts. Two states are retried in place instead
of 409ing: `failed` (provision never produced a machine) and `destroyed`
(the user deleted the machine, or the reaper tore it down after grace).
A subsequent `POST /v1/trial-nodes` reuses the same row — resetting it to
`state: "creating"` with a fresh `enrollTokenHash` and `expiresAt`, and
clearing `nodeId`/`sandboxId`. `creating` and `ready` still 409 (already
live). `expired` still 409 (the TTL was spent; the paused sandbox is still
there during grace). This exists so a transient provisioner failure or an
in-app Delete cannot permanently burn the account.

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

### Relay Hosted App Store subscriptions

The seven-day hosted-machine trial is controlled by Relay's server clock; it
is not an App Store introductory offer. After the trial expires, hosted access
stays paused unless the account has either a current Apple subscription or the
operator-only `hosted.auto_upgrade=1` entitlement used by App Review. Provider
accounts and usage (Codex, Claude, Cursor, and similar services) are not part
of Relay Hosted.

The iOS app sells two auto-renewable products in one subscription group:

- `com.parikshit.pocvault.hosted.monthly` — one month
- `com.parikshit.pocvault.hosted.yearly` — one year

`POST /v1/subscriptions/apple/verify` accepts an authenticated StoreKit
transaction JWS. The service validates Apple's certificate chain, bundle id,
product id, expiration, and a deterministic `appAccountToken` bound to the
Relay account before activating the machine. `POST
/v1/subscriptions/apple/notifications` is public for App Store Server
Notifications V2; the signed outer payload and its transaction JWS are both
verified before a renewal, expiration, refund, or revocation changes access.
Configure that App Store Connect notification URL as:

```text
https://relay.ai-rocket-experiments.com/v1/subscriptions/apple/notifications
```

Apple's public root certificates are checked in as DER `.cer` files under
`certs/`. Never replace them with a private key or signing credential. Product
ids and the numeric App Store app id can be overridden with
`APP_STORE_HOSTED_MONTHLY_PRODUCT_ID`,
`APP_STORE_HOSTED_YEARLY_PRODUCT_ID`, and `APP_STORE_APP_APPLE_ID`.
`APP_STORE_ONLINE_CHECKS=0` is for isolated tests only. A paid renewal extends
Cube's platform timeout using `HOSTED_SANDBOX_TIMEOUT_SEC` (default 370 days),
while Relay still enforces the signed subscription expiration itself.

Operator/App Review upgrades also extend the platform timeout **before**
committing `upgraded`. An expired machine is resumed first; an unavailable or
missing sandbox returns a retryable failure or conflict instead of claiming
success. A successful admin upgrade grants the independent
`hosted.auto_upgrade=1` entitlement. Repeating an upgrade preserves existing
node names and reduced `nodes.max` values. That operator grant is not revoked
when a separate sandbox StoreKit transaction expires.

The platform timeout is finite, even for an upgraded account. The existing
60-second lifecycle sweep renews eligible upgraded machines at most once per
day, using the same `HOSTED_SANDBOX_TIMEOUT_SEC` backstop; failures retry after
five minutes and do not downgrade or delete an active record. On a control-plane
restart the first sweep renews eligible machines again. Renewal requires an
active Apple subscription or operator grant and a current `upgraded` node;
expired, failed, destroyed, and unentitled rows are not revived. Background
renewal only extends a running sandbox: explicit recovery/upgrade owns resume.
The service must remain operational within the platform backstop; no infinite
platform lifetime is claimed.

If the platform is unavailable when the phone collects its pairing credential,
Relay still delivers the opaque credential blob and records a
`hosted.activation_pending_trial` marker tied to that exact trial. A later sweep
retries the operator activation, including after a control-plane restart. It
does not promote a newly enrolled node before credential collection. Lifecycle
operations are serialized per account so an old expiry pass cannot pause a
machine after its upgrade has completed; shutdown stops further maintenance.

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

### Web console (operator env)

`product/web` is a Vite+React app (login, phone QR, `/cli-login`,
provisioning, machines, activity). Do **not** deploy it via CodeCommit
`relay-cloud` or `ops/deploy-poc`.

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
- **Billing**: out of W3 scope. The authenticated web console lives in
  `product/web` (login, machines, waitlist, activity) and is **not**
  shipped through this service's CodeCommit `relay-cloud` path or
  `ops/deploy-poc`. (The trial sandbox provisioner itself is now real —
  see "Real, tested" above; that is provisioning, not billing.)
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
