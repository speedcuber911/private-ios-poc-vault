# Web Auth, CLI/Phone QR, and Live Activity Console — Design

> Status: approved by owner 2026-08-13 (brainstorming session).
> Scope: authenticated website for Relay accounts, trial machines, and
> live job/thread activity; Better Auth cookies; device-code `cli`/`web`
> split; the missing `DEVICE_LOGIN_URL` page; short-lived browser grants
> through a grant gateway. Extends
> `docs/superpowers/specs/2026-08-12-qr-cli-auth-handoff-design.md` (that
> spec's non-goal "a web approval page" is closed here) and the Web v0
> row in `product/STATUS.md`. Visual language:
> `docs/superpowers/specs/2026-08-11-editorial-ember-design.md`.
> Hosting and trust constraints from `docs/RELAY_ARCHITECTURE.md` and
> `docs/RELAY_POC_EC2_AGENT_HANDOFF.md`. Hostnames genericized.

## 1. What this is

Relay's marketing site has no login. The control plane already has Better
Auth (username/password + Apple bearer for iOS) and a device-code flow
the phone can approve, but `DEVICE_LOGIN_URL` is still the placeholder
`https://relay.example/cli-login`. Web v0 — login, machine list, waitlist
— is missing.

This design adds a real web app: sign up or sign in, start a trial
machine, see that machine's live jobs and threads, and join the paid
waitlist when another machine is not entitled. The same app is the CLI
approval page. A signed-in phone can sign the browser in by scanning a
QR. A signed-in browser can approve `relay login` after signing in on
that page.

The cloud remains a rendezvous. Prompts, files, transcripts, and
decryption keys never land in the account database. The iPhone keeps
mTLS to the node. The website reaches activity through a short-lived
grant and a separate grant gateway that pipes bytes and must not store
them.

## 2. Decisions fixed during brainstorming

| Question | Decision |
|---|---|
| First product | **Live console**, not account-only: machines list + one machine's jobs/threads. No file browser, no composer. |
| Browser → node | **Short-lived browser grant** + grant gateway. Rejected: cloud proxy (breaks content-free cloud) and client certificates in the browser. |
| After signup | **Start a trial machine**, same idea as iPhone "Try instantly." Existing accounts sign in and see what they already have. |
| Extra machines | **Waitlist upsell** at `nodes.max` / "New machine." No checkout. |
| Password on the web | **Username + password only.** Apple stays on iPhone. No magic link on this surface. |
| Where it lives | **`product/web` on an `app.` origin.** Marketing site stays a landing page with a Sign in link. Rejected: stuffing auth into `pocs/relay/site`, and serving HTML from relay-cloud. |
| CLI + phone + web | **One device-code mechanism, two clients.** Phone already approves CLI. Web hosts `DEVICE_LOGIN_URL` and can be a device-code *client* (`web`) or *approver* (`cli`). |
| Unauthenticated CLI landing | **Sign in, then auto-approve.** Keep `#code=`. Password or Sign in with iPhone, then approve the pending CLI code in the same sitting. |
| Visual language | **Editorial Ember.** Serif titles, sans controls, status as a word, never a dot. Copy says **machine**, not sandbox. |

## 3. Architecture

Four product pieces plus the existing broker. Cloud stays a rendezvous.
The grant gateway is a fifth trust party: it may see job/thread bytes in
flight and must not persist or log bodies, and it must not run inside
the relay-cloud process.

```
 iPhone (signed in)          product/web (app.)           relay-cloud
        │                         │                            │
        │  scan QR / approve      │  Better Auth cookie        │
        │─────────────────────────┼───────────────────────────▶│
        │                         │  device-code start/poll    │
        │                         │  trial create / waitlist   │
        │                         │  mint browser grant        │
        │                         ▼                            │
        │                    grant gateway  ── pipe jobs/threads ──▶  relayd
        │                    (sees bytes,                        (trial / BYO)
        │                     never stores)
        │
        └── mTLS via broker ──────────────────────────────────────▶  relayd
```

| Party | Learns | Never learns |
|---|---|---|
| Control plane | account, entitlements, device-code metadata, trial/node names, grant claims (account, node, scope, expiry) | prompts, files, transcripts, provider credentials, node CA keys, handoff plaintext |
| Grant gateway | HTTP bytes for allowed activity routes, for the life of the request | nothing persisted; no body logs |
| GitHub / APNs / handoff | unchanged from `RELAY_ARCHITECTURE.md` | unchanged |
| Node | everything on that machine | — |
| Browser | whatever the gateway returns for that grant | other accounts' machines |

Handoff sealing is untouched. The CLI still seals to the node's X25519
public key. The decryption key never reaches the control plane.

### 3.1 `product/web`

Editorial Ember SPA on the app origin. Routes in §5. Talks to the live
control plane with `credentials: include`. Talks to the grant gateway
only with a grant minted for the selected node.

### 3.2 relay-cloud

Better Auth username/password gains **cookie sessions** for the app
origin. `trustedOrigins` includes that origin. iOS and the CLI keep
bearer / `issueSession` JWTs. `authenticate()` already accepts either.

Device codes gain a `client` column: `cli` (default) or `web`.

- `cli` — today's path. Approve occupies the one computer slot
  (`cli_computer_links`). Token redemption stays `connectCliComputer` +
  `issueSession(..., { cliLinkId })`.
- `web` — session cookie only. Does **not** insert or collide with
  `cli_computer_links`. Required: today's `/v1/auth/device/token` always
  calls `connectCliComputer`. Reusing that for phone→web QR would steal
  or 409 the laptop link.

### 3.3 Grant gateway

Separate process from relay-cloud. Lives on the data-path machine (the
broker host), not on the control-plane process and not in the
CodeCommit `relay-cloud` overlay. After login, cloud mints a short-lived
grant bound to `account + node + read-activity`. The gateway verifies
the grant and reverse-proxies only jobs, threads, and events from that
node. Out-of-scope paths return 403.

The node remains mTLS-only for the phone. The gateway is the only new
caller: it presents the grant; the node accepts a verified grant for
the listed read routes (implementation: cloud-signed JWT, dedicated
`BROWSER_GRANT_SECRET` in host env, node learns the verify key at
enroll or via the existing enroll/config channel). Gateway TLS to the
node does not replace phone mTLS.

### 3.4 Trial from the website

After signup the site creates a pairing session (current
`POST /v1/trial-nodes` requires `pairingId` + `pairingSecret`) and
creates the trial, then polls `GET /v1/trial-nodes/current` until
`ready`. The website never imports the PKCS#12. The phone can still
claim that pairing later. This does **not** add a re-pair path for a
device that later loses its cert (known gap, inherited).

Activity uses the grant once the node is `ready`. Pairing is not a web
gate.

## 4. End-to-end flows

### 4.1 Signup → trial → activity

```
 browser                      relay-cloud                 provisioner / node
────────                      ───────────                 ─────────────────
POST /api/auth/sign-up/email ─▶ Better Auth cookie
POST /v1/pairing/sessions ───▶ {pairingId, secret}
POST /v1/trial-nodes ────────▶ create sandbox + enroll
GET  /v1/trial-nodes/current ─▶ creating → ready
POST /v1/nodes/:id/browser-grants
◀── {grant, expiresIn, gatewayUrl}
GET  gateway /activity/…  ──────────────────────────────────▶ jobs/threads
```

### 4.2 Phone signs the browser in

```
 browser                         relay-cloud                    iOS
────────                         ───────────                    ───
POST /v1/auth/device/start
  {client:"web", machineName, platform:"web"}
◀── {deviceCode, userCode, verificationUriComplete}
show QR of …/cli-login#code=ABCD
poll /device/token ─────────────▶ authorization_pending
                                              scan (existing parser)
                               inspect ◀──── POST /v1/auth/device/inspect
                               ───────────▶ {machineName, platform, client}
                               approve ◀──── POST /v1/auth/device/approve
                                             (server sees client=web:
                                              no cli_computer_links row)
poll returns Better Auth Set-Cookie
→ /machines
```

QR shape is unchanged (`${DEVICE_LOGIN_URL}#code=ABCD-EFGH`). The phone
scanner does not need a new parser. Approve branches on the stored
`client`; iOS keeps calling the same endpoint.

### 4.3 CLI → web, sign in then auto-approve

```
 CLI                         browser (/cli-login#code=)           relay-cloud
────                         ──────────────────────────           ───────────
POST /device/start
  {client:"cli" or omitted}
open verificationUriComplete
                             inspect code
                             no session → /login, keep hash
                             password or client=web QR
                             session exists
                             auto-approve CLI userCode ─────────▶ cli link
poll /device/token ◀──────────────────────────────────────────── issueSession
                                                                  + cliLinkId
```

If inspect says `client: "web"`, `/cli-login` must not treat the code as
a CLI link. Copy: approve this from the iPhone.

Confirm copy for `client: "cli"`: machine name, and “Only continue if
you just ran `relay login` on this computer.”

## 5. Screens

Warm dark canvas. Serif for titles and the wordmark, sans for fields and
actions, DM Mono for codes and durations. Ember only on the primary
action of the screen and live-status words. Status is typographic
(`READY`, `RUNNING`, `EXPIRED`, `TRIAL · 6 DAYS LEFT`). No cards inside
cards, no colored dots.

| Route | Purpose |
|---|---|
| `/login` | Sign in / Create account. Username, email on signup, password. Ember CTA. Mode switch. Text action: **Sign in with iPhone** (starts `client: "web"`, shows QR + human code). After signup → `/provisioning`. After sign-in → `/machines`. Preserve `#code=` and auto-approve if present. |
| `/cli-login` | `DEVICE_LOGIN_URL` page. Behavior in §4.3. |
| `/provisioning` | Creating → Booting → Ready. Pairing is not shown as a required web step. Failure: terracotta error + Retry. |
| `/machines` | Hairline list: name, kind (`TRIAL` / `YOUR MACHINE`), status word, trial countdown. Ember “New machine” if entitled. At `nodes.max`, that action is the waitlist upsell; joined state is the small-caps word “On the waitlist.” |
| `/machines/:id` | Running and recent jobs/threads: status, duration, last event. Empty: “No runs yet.” Silent grant refresh. No files, no composer. |

Marketing site (`pocs/relay/site`): add a Sign in link to the app origin
only. No session code in that bundle.

## 6. API changes

Password: existing `POST /api/auth/sign-up/email` and
`POST /api/auth/sign-in/username`, plus cookie session for the app
origin (`SameSite=None; Secure` when the SPA and API are different
origins; `credentials: include`).

`platform` closed set becomes `macos|linux|windows|web|other`.
`web` is what the site sends. Unrecognized values still collapse to
`other`.

| Path | Change |
|---|---|
| `POST /v1/auth/device/start` | Optional `client`: `cli` \| `web`, default `cli`. Persist on `device_codes`. `web` does not reserve the computer slot. |
| `POST /v1/auth/device/inspect` | Response also includes `client`. Unknown/expired/consumed stay identical 404 `unknown_user_code`. |
| `POST /v1/auth/device/approve` | `cli` → existing `approveDeviceCodeForCliLink` (409 `computer_already_linked` if the slot is taken). `web` → bind `account_id` only; never insert `cli_computer_links`. |
| `POST /v1/auth/device/token` | `cli` → today's JWT + `cliLinkId`. `web` → create Better Auth session and `Set-Cookie`. A `web` code must not call `connectCliComputer`. |
| `POST /v1/nodes/:id/browser-grants` | Session required. 404 if the node is not this account's. Returns `{ grant, expiresIn, gatewayUrl }`. JWT claims: `sub` (account), `node`, `scope` (`jobs.read`, `threads.read`, `events.read`), `exp` (~15 minutes). Signed with dedicated `BROWSER_GRANT_SECRET` (host env, never in repo or CI variables). |
| `GET /v1/account`, `GET /v1/nodes`, `GET/POST/DELETE /v1/trial-nodes/*`, `POST /v1/pairing/sessions`, `POST /v1/waitlist` | Unchanged contracts. Web is a new caller. |

`DEVICE_LOGIN_URL` on the control-plane host is set to
`https://<app-origin>/cli-login`. That is a non-secret URL; still do not
dump `/etc/relay-cloud/env`.

Grant gateway (separate service):

| Path | Auth | Proxies |
|---|---|---|
| `GET /activity/jobs` | grant | node jobs list |
| `GET /activity/threads` | grant | node threads list |
| `GET /activity/events?since=` | grant | node events |
| anything else | — | 403 |

Expired grant → 401. The SPA remints with the cookie and retries once.
Wrong `node` in the grant → 403. Gateway must not write response bodies
to logs.

## 7. Error handling

- **Stale / foreign / reused device code** — uniform 404. Web copy: “That
  code isn't valid anymore.” CLI copy unchanged.
- **CLI slot taken** — 409 `computer_already_linked`. Web tells the user
  to disconnect the linked computer on the phone. A `web` login never
  produces this error.
- **QRLjacking** — confirm names the machine before approve; one-shot
  codes; 15-minute TTL; approval requires a signed-in session (phone or
  web). Residual risk equals the existing CLI device flow — accepted.
- **Auto-approve after login fails** — show the CLI confirm again. Do
  not loop approve.
- **Trial** — `trial_unavailable`, `trial_capacity`, `trial_already_used`,
  and `failed` (retry in place) keep today's meanings. Do not offer a
  casual destroy: `DELETE` sets `destroyed` and burns the one trial
  (known gap, inherited).
- **Grant / gateway / node down** — “Can't reach this machine.” No
  placeholder activity that looks live.
- **Waitlist** — failure is shown; success is “On the waitlist.”
- **Password** — non-enumerating; same Better Auth behavior as iOS.

## 8. Hosting and deploy

Live control plane stays on the existing shared host and public API
(`docs/RELAY_POC_EC2_AGENT_HANDOFF.md`). AWS profile `default`, region
`ap-south-1`. Listener `127.0.0.1:8790` only. nginx already owns public
80/443 on that box.

Hard rules:

- Do not put `product/web` or the grant gateway into the CodeCommit
  `relay-cloud` repository. That overlay is `product/cloud/` only.
- Do not ship the authenticated app through `ops/deploy-poc`.
- Do not move the raw broker onto the control-plane host's 80/443.
- Do not print or commit `/etc/relay-cloud/env` or
  `~/.poc-vault/secrets`.
- Schema-changing cloud releases take an online SQLite backup first.
- After any control-plane deploy: `/healthz` 200, unauthenticated
  `/v1/account` 401, existing shared-host apps (jisha, miq, Flux) still
  healthy.
- Product-domain `app.` DNS may come later (zone is not in the compute
  account). This pass may use a sibling vhost on the existing API zone.
  Do not treat a product-domain cutover as in scope.
- Grant gateway deploys to the data-path / broker host, not into the
  relay-cloud systemd unit.

`BROWSER_GRANT_SECRET` and any gateway credentials are generated on the
host, same pattern as existing control-plane secrets.

## 9. Testing

- **Cloud.** `client: "web"` vs `"cli"` isolation: web approve does not
  create `cli_computer_links`; web token does not call
  `connectCliComputer`; CLI approve still 409s when the slot is taken;
  inspect returns `client`; anti-enumeration 404s remain byte-identical
  across client kinds; grant mint for own node, 404 for foreign node,
  expiry, scope claims; SQLite after a mocked activity session still
  has no prompt or file rows.
- **Gateway.** Allowed routes proxy; other paths 403; expired/wrong-node
  grants fail; test logger receives no response bodies.
- **Web.** Password signup → provisioning → machines → activity;
  Sign in with iPhone poll → cookie → machines; `/cli-login#code=` with
  no session → login → CLI approved; waitlist join and joined state;
  grant 401 → silent remint.
- **iOS.** Existing scanner still parses `#code=`. No required UI
  change. Optional later: confirm copy could mention `client` if
  inspect is shown; not required for this pass.
- **CLI.** `relay login` still polls the same token endpoint. Opening
  `verificationUriComplete` hits a real page once `DEVICE_LOGIN_URL` is
  set.
- **Deploy.** Control-plane health and shared-host regression as in the
  EC2 handoff completion standard. App origin serves `/login` and
  `/cli-login`. `DEVICE_LOGIN_URL` matches that origin.

## 10. Component changes

### 10.1 `product/cloud`

- `device_codes.client` (`cli` \| `web`, default `cli`).
- Approve / token / inspect branches in §6.
- Better Auth `trustedOrigins` + cookie config for the app origin.
- `POST /v1/nodes/:id/browser-grants`.
- `normalizeDevicePlatform` accepts `web`.
- Host env: `DEVICE_LOGIN_URL`, `BROWSER_GRANT_SECRET`, gateway URL
  used in grant responses.

### 10.2 `product/web` (new)

- Vite + React SPA, Editorial Ember tokens ported from `AppTheme`.
- Routes in §5. Better Auth client with credentials. Device-code
  start/poll for `client: "web"`. CLI-login inspect/approve. Trial +
  waitlist + grant + activity views.

### 10.3 Grant gateway (new)

- Small Node (or Go) reverse proxy on the broker host. Verify grant,
  scope-check, proxy, no body logs.

### 10.4 `product/cli`

- No protocol change. Benefits once `DEVICE_LOGIN_URL` is a real page.
- Keep opening `verificationUriComplete` (today's dead URL becomes live).

### 10.5 iOS

- Untouched unless a scanner bug appears. Same QR payload, same approve
  path; server interprets `client`.

### 10.6 Marketing site

- Sign in link to the app origin. No auth implementation.

### 10.7 `product/relayd`

- Accept a cloud-signed browser grant on the activity read routes the
  gateway proxies (`jobs`, `threads`, `events`). Phone mTLS is unchanged.
- Learn the grant verify key through the existing enroll/config channel.
  Do not accept Better Auth cookies on the node.
- Job engine, workspaces, handoff import, and harness adapters are
  otherwise untouched.

### 10.8 Untouched

Handoff sealing, APNs banner rules, Cube provisioner contracts, broker
raw transport, PostgreSQL, Apple on the web, billing, re-pair, trial
destroy recovery.

## 11. Security posture

- Cloud stays content-free by construction: grant JWT carries ids and
  scopes, not activity text.
- Grant gateway is an explicit content-seeing pipe, isolated from the
  rendezvous process and from SQLite.
- Device-code hardening from the QR spec remains: hashed device codes,
  per-IP and global live-code caps, one-shot approve, uniform 404s,
  code in the URL hash fragment only.
- Cookies: `Secure`; `SameSite=None` only because the SPA and API are
  different origins; `trustedOrigins` is an allowlist, not `*`.
- `BROWSER_GRANT_SECRET` is host-only, ≥32 bytes, distinct from
  `BETTER_AUTH_SECRET` / `SESSION_SECRET`.
- No new node route accepts a browser cookie. The node verifies a grant
  or continues to require mTLS for the phone.

## 12. Non-goals

- File browser, chat composer, or full iPhone parity.
- Sign in with Apple or magic link on the website.
- Checkout, Stripe, or raising `nodes.max` automatically.
- Re-pair for a lost phone cert; casual trial destroy/recreate.
- Cloud proxy of jobs/files/prompts.
- Client certificates in the browser.
- Universal links / system-camera login (payload remains URL-shaped).
- Moving the broker onto the control-plane nginx 80/443.
- Product-domain DNS cutover (`app.` on the product zone).
- Deploying the SPA via `ops/deploy-poc` or into CodeCommit `relay-cloud`.
- PostgreSQL cutover.
- iOS UI rewrite for `client: "web"` confirm copy.
