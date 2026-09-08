# Relay — bring-your-own-VM simplification

> Spec date 2026-09-08. Removes machine allocation from Relay. A person brings
> their own VM, runs `relayd`, scans a QR code with the phone, and gets the
> existing file-navigation + agent-chat interface. The `relay` CLI stays,
> because moving credentials to the VM is its reason to exist.

## The one-paragraph version

Relay stops being a thing that hands out machines. `relayd` runs on hardware the
user already owns. `relayd pair` prints a QR code; the phone scans it and talks
to the node directly, authenticated by a bearer token derived from the pairing
secret. The control plane keeps accounts, handoff and push, but it is no longer
on the path to *using* the product — and it can no longer create a machine at
all.

## What goes, what stays

| Goes | Stays |
| --- | --- |
| E2B/Cube provisioning (`provisioner.js`, `product/trial/`) | `relayd`, its jail, jobs, workspaces, harnesses |
| `trial_nodes`, `sandbox_orphans` tables and reapers | accounts, devices, nodes, entitlements |
| `/v1/trial-nodes*`, admin upgrade/unlink-machine | pairing rendezvous (`kind: pair`, `sync-auth`, `session-index`) |
| hosted device re-pairing through the cloud | handoff state machine, APNs fanout |
| web `Provisioning` / `Machines` pages | web login, `/cli-login`, activity |
| iOS trial flow, provisioning sheet, expiry banner | iOS files, chat, tasks, settings, diagnostics |
| the "Try instantly" fork | broker/tunnel (a BYO VM behind NAT still needs it) |

Two decisions taken by the owner on 2026-09-08:

- **StoreKit stays as dead code.** `app-store.js`, `apple_subscriptions`,
  `/v1/subscriptions/apple/*` and `RelaySubscriptionStore.swift` are kept and
  left unreferenced by UI, so the App Store Connect items stay valid. Only the
  *coupling to sandbox lifetime* is removed.
- **Sign-in becomes optional.** Pair first; sign in only for handoff, push and
  `relay login`.

## The pairing contract (normative — both sides implement exactly this)

### Why a bearer token, not mTLS

iOS will not send a client certificate on a connection it did not itself
anchor, and fails silently when it declines. This is recorded empirically at
`product/relayd/src/server.mjs:80-92`. The device bearer token already works in
production for hosted machines; QR pairing adopts it. `hosted-device-store.mjs`
is therefore **renamed to `device-tokens.mjs`**, not deleted — there is nothing
hosted-specific about a table of paired devices.

### Derivations (unchanged labels — do not rename, cross-language wire values)

```
secret     = pairing token, 24 random bytes base64url
authToken  = base64url( sha256( "relay-pair-auth-v1" || 0x00 || secret ) )
macKey     =           hmac-sha256( key = secret, msg = "relay-pair-mac-v1" )
tag        = base64( hmac-sha256( macKey, slot || 0x00 || blob ) )
             slot in { "device-blob", "node-blob" }
p12pass    = hex( hmac-sha256( key = secret, msg = "relay-trial-p12-v1" ) )
deviceTok  = hex( hmac-sha256( key = secret, msg = "relay-device-token-v1" ) )
```

Swift already implements every one of these in
`ios/POCVault/POCVault/Security/RelayTrialPairing.swift`; the file is renamed to
`RelayPairing.swift` and the type to `RelayPairing`, with label constants
untouched.

### QR payload

`relayd pair` renders this URL as an ANSI QR block:

```
https://get.openrelay.sh/pair#v=1&n=<nodeId>&m=<nodeName>&t=<token>
                              &p=<base64url(pairEndpointUrl)>
                              &a=<base64url(apiBaseUrl)>
                              &f=<base64url(sha256(node CA SubjectPublicKeyInfo))>
```

The credential rides in the **fragment**, which never reaches a server or an
access log. A generic camera app shows a tappable universal link; the in-app
scanner parses the same string directly and never opens a browser.

`apiBaseUrl` is what the phone talks to after pairing — new, and required:
without it the phone knows how to pair but not where to work.
`RELAYD_PAIR_LINK_BASE` overrides the origin; `RELAYD_PAIR_API_ADVERTISE`
overrides the advertised data URL.

### The bootstrap problem, and why `f=` exists

A BYO node signs its own certificate, so the phone's very first request — the
pairing POST — reaches a certificate it has no reason to trust. The two obvious
answers are both wrong:

- **Plain HTTP for pairing.** The pairing token travels *in that request*. A
  passive listener on the same network captures it, and an active one redeems it
  first. Single-use protects the honest party from replay, not from a race.
- **Blanket-disable TLS validation for the first call.** Ships an app that will
  talk to anything, and the habit outlives the excuse.

The QR is itself an out-of-band authenticated channel — it came off the user's
own terminal — so it carries the pin. `f=` is `sha256` over the node CA's
SubjectPublicKeyInfo. The phone requires the pairing connection's chain to
terminate in a CA whose SPKI hash equals `f`, and after pairing it checks that
the delivered `caPem` hashes to the same value. The CA is pinned rather than the
leaf so `ensureServerCert` can rotate the server certificate without
invalidating printed codes.

This is the SSH host-key-in-the-QR pattern: trust is established once, out of
band, by a human who can see both screens.

### Direct pair exchange — `POST /v1/pair` on the node's pairing listener

Request (unchanged envelope, new blob variant):

```json
{ "v": 2, "code": "<token|CODE>", "blob": "<base64 device blob>", "tag": "<base64>" }
```

Device blob, **mint variant** (the phone has no CSR stack):

```json
{ "mint": "p12", "deviceName": "Parikshit's iPhone", "platform": "ios" }
```

The existing `{ "csrPem": ... }` variant stays for CLI/desktop callers. A blob
with neither is `400`.

Node blob for the mint variant:

```json
{ "deviceId": "...", "p12": "<base64 PKCS#12, encrypted with p12pass>",
  "caPem": "...", "nodeId": "...", "nodeName": "...", "certSerial": "...",
  "notAfter": "...", "apiBaseUrl": "https://..." }
```

The node stores only `sha256(deviceTok)` in `device-tokens.mjs`. No private key
ever crosses in cleartext; no secret crosses that both sides cannot derive.

### Node-side auth after pairing

`authorize()` in `product/relayd/src/server.mjs` changes from *"token mode is
on iff `RELAYD_DEVICE_TOKEN_HASH_FILE` is set"* to:

1. If a bearer is present and is JWT-shaped with a grant key configured →
   browser-grant path (unchanged).
2. Else if a bearer is present and matches a device in `device-tokens.mjs` →
   authorized as that device.
3. Else if `RELAYD_DEVICE_TOKEN_HASH_FILE` is set → legacy single-hash compare.
4. Else → the existing mTLS path.

Both modes coexist, so QR pairing does not break an existing cert-based
install. `computeraccess.mjs` (control-plane authorization for *managed* nodes)
is deleted and its gate removed — a machine the user owns does not ask a
control plane for permission to serve its owner.

## Registering a machine for handoff (the `encPubkey` path)

Deleting trial enrolment removed the **only writer of `nodes.enc_pubkey`**.
`POST /v1/nodes` never accepted one. The CLI seals a handoff *to* that X25519
key (`relay handoff` → `RLYSEAL1`), so without it handoff is broken for every
BYO node — silently, because the seal step simply has no recipient.

The fix keeps the core loop cloud-free and makes registration a later, optional
step:

1. The pairing node blob gains `pubkey` (the node's ed25519 identity, SPKI PEM)
   and `encPubkey` (X25519, base64) alongside the fields it already returns.
   The phone learns them at pairing time without an account.
2. `POST /v1/nodes` accepts and validates `encPubkey` (32 raw bytes, base64) and
   stores it via the `createNode` parameter that already exists.
3. When the user is signed in, the app registers the paired machine. When they
   are not, pairing still completes and Settings offers **"Connect this machine
   to your account"** later. Handoff and push are what registration buys; files
   and chat never needed it.

A machine that is paired but unregistered is a normal, supported state. The app
must say so plainly rather than presenting it as an error.

### Browser grants

`enroll.json`, written by the provisioner, was how a node received
`BROWSER_GRANT_PUBLIC_KEY`. Nothing delivers it now. For BYO the node reads it
from `RELAYD_GRANT_PUBLIC_KEY` in its own environment; the web activity page
works when the operator sets it and is simply unavailable when they do not.

## Work packages

Each is independently landable and owns disjoint paths.

### WP1 — cloud (`product/cloud/`)

Delete `provisioner.js`, `hosted-pairing.js`. In `server.js` remove the hosted
lifecycle block (`141-440`), the sweeps (`539-645`, keeping `runSweeps` itself),
`/v1/trial-nodes*` (`1080-1129`, `1825-1965`), admin upgrade/unlink
(`1414-1470`), device-pairings routes (`1149-1158`, `1710-1717`), the
`hosted-device` branch inside `GET /v1/pairing/sessions/:id/:slot`
(`1017-1052`), and the `hostedPairing=1` additions to `GET /v1/node/handoffs`.
Rewrite `DELETE /v1/nodes/:id` to plain node deletion. In `registry.js` drop the
trial section (`722-842`), sandbox orphans (`965-1002`), and the hosted
activate/expire helpers (`930-963`). In `db.js` drop `trial_nodes` and
`sandbox_orphans`. In `config.js` drop `e2b`, `trial`, `enrollBaseUrl`,
`nodeTls`; keep `tunnel` (the broker uses it). Drop the `main.js` boot guard.
Keep every App Store route and table; strip only their sandbox calls.

Delete the nine trial/hosted test files; do surgery on `enroll-enc`,
`admin-console`, `browser-grant`, `sync-auth-e2e.impl`, `pairing`.

### WP2 — node + CLI (`product/relayd/`, `product/cli/`)

Port `qr.mjs` into relayd and render the QR at `bin/relayd:76`, closing the
`TODO(W2-followup)`. Extend `pairingPresentation` with `pair`/`api` fields.
Move p12 minting out of `trialpair.mjs` into `pairing.mjs` as the mint variant.
Rename `hosted-device-store.mjs` → `device-tokens.mjs`. Rewrite `authorize()`
per the contract above. Delete `trialpair.mjs`, `hosted-pairing.mjs`,
`enroll.mjs`, `computeraccess.mjs`, the `relayd enroll` subcommand, and their
tests. In the CLI, re-point `login.mjs:142-195` from `currentTrial()` to
`GET /v1/nodes` and drop `cloud.mjs:124`.

### WP3 — iOS (`ios/POCVault/`)

Delete the trial flow, provisioning sheet, expiry banner, hosted recovery view
and the two trial test files; strip trial/subscription sections from settings.
Rename `RelayTrialPairing` → `RelayPairing`. Add **`NodePairingView`** —
reusing the `AVCaptureSession` scanner factored out of `CLILinkScannerView` —
which parses the QR fragment, POSTs the mint blob to the node's pair endpoint,
verifies the node tag, imports the p12, pins the CA and host, stores the bearer
token, and writes the node into `RelayNodeStore`. Manual entry stays: a typed
`XXXX-XXXX` code plus a node URL field. Make sign-in optional in the phase
router: unpaired → pairing screen; paired → the app. Every deletion needs
matching `project.pbxproj` surgery.

### WP4 — web + docs (`product/web/`, `docs/`, `revamp/`)

Delete `api/trial.js`, `pages/Provisioning.tsx`, `pages/Machines.tsx` and their
tests; strip the trial columns and upgrade/unlink actions from `Admin.tsx` and
`api/admin.js`; remove the Machines nav entry. Rewrite the trial/sandbox copy in
`Legal.tsx`. Update `product/cloud/README.md`, `product/cli/README.md`,
`product/relayd/API.md`, `docs/RELAY_ARCHITECTURE.md`, `product/STATUS.md`,
`AGENTS.md`. Delete `revamp/07-trial-sandbox-plan.md` and
`docs/superpowers/plans/2026-08-11-trial-sandbox.md`.

## Consequences to accept

- **App Review access** becomes an owner-operated demo VM whose pairing code
  goes in the review notes. This retires the expired-sandbox blocker recorded at
  `docs/app-store/review-remediation-4.3.md:24` rather than fixing it.
- **The waitlist loses its purpose** (`POST /v1/waitlist` stays; nothing gates
  on it).
- **`ENROLL_BASE_URL`, `E2B_*`, `TRIAL_*`, `NODE_TLS_*` must be removed from the
  control-plane host env** or the service will start ignoring them silently.
- The Cube host `rocketizer-cubesandbox` and its template registry become
  unused infrastructure. Terminating it is an owner decision, out of scope here.
