# QR-Based CLI Auth Handoff — Design

> Status: approved by owner 2026-08-12 (brainstorming session).
> Scope: closes the approval gap in the device-code flow shipped with the
> CLI (`docs/superpowers/specs/2026-08-11-relay-cli-handoff-design.md` §4),
> plus the CLI refresh fix. Extends `revamp/05-onboarding-plan.md` §4.2.
> All hostnames genericized per repo convention.

## 1. What this is

`relay login` today mints a device code, prints `ABCD-EFGH`, opens a dead
URL, and polls — but nothing can approve it: there is no app UI and no web
page behind `DEVICE_LOGIN_URL`. This design closes that loop with a QR
code: the CLI renders its user code as a QR in the terminal, the signed-in
iOS app scans it, shows a confirm sheet naming the machine, and approves.
The CLI's poll then returns an account session, it pins the trial node as
it already does, and `relay handoff` works from that machine.

Also in scope: the CLI never uses its stored refresh token, so its session
dies after `SESSION_TTL_SEC` (15 min). This effort adds auto-refresh so a
linked machine stays linked.

## 2. Decisions fixed during brainstorming

| Question | Decision |
|---|---|
| Scan UX | **In-app scanner** (AVFoundation). No associated domains, no web page, no new infra. QR payload is URL-shaped so system-camera/universal-link scanning can be added later with zero CLI changes. |
| Mechanism | **QR as a skin over the existing device-code flow.** Reuse `/v1/auth/device/start\|token\|approve` and all their hardening (hashed codes, per-IP caps, atomic one-shot approve, uniform 404s). Rejected: a new pairing-rendezvous channel (rebuilds existing machinery, blinding buys nothing since the cloud mints the session) and credential-in-QR (bearer token on screen). |
| Token lifetime | **Fix refresh now.** CLI proactively refreshes near expiry and retries once on 401, rotating the stored pair atomically. Rejected: longer-TTL CLI sessions (weakens the revocation design). |
| Machine identity | Self-reported `machineName`/`platform` sent on `device/start`, stored server-side, shown on the confirm sheet. Advisory, not authenticated; the confirm copy carries the weight. |

## 3. End-to-end flow

```
 CLI (machine)                 relay-cloud                  iOS app
──────────────                ─────────────                ─────────
POST /v1/auth/device/start ──▶ mint userCode+deviceCode,
  {machineName, platform}      store machine metadata
◀── {userCode, deviceCode,
     verificationUriComplete}
render QR + code, poll ─────▶  /token → authorization_pending …
                                             ◀───────────  scan QR (in-app scanner)
                               inspect row  ◀───────────  POST /v1/auth/device/inspect
                               ───────────────────────▶   {machineName, platform, createdAt}
                                                          confirm sheet names the machine
                               atomic 1-shot ◀──────────  POST /v1/auth/device/approve
poll returns session ◀──────── issueSession(account)
GET /v1/trial-nodes/current ─▶ pin nodeId + enc pubkey    success screen
"Linked. Try: relay handoff"
```

QR payload: `${DEVICE_LOGIN_URL}#code=ABCD-EFGH` — the code rides in the
hash fragment so it never reaches server logs if opened as a real URL. The
`deviceCode` (the redeeming secret) never leaves the CLI; the QR carries
only the approval handle.

## 4. Component changes

### 4.1 Cloud (`product/cloud`)

- `device_codes`: add nullable `machine_name`, `platform` columns
  (migration in `db.js`).
- `POST /v1/auth/device/start`: accept optional `machineName` (control
  chars stripped, ≤64 chars) and `platform` (normalized to
  `macos|linux|windows|other`); return `verificationUriComplete`.
- **New** `POST /v1/auth/device/inspect {userCode}` — session-authed,
  read-only. Returns `{machineName, platform, createdAt, expiresAt}` for a
  pending, unexpired code; unknown/expired/already-approved all return the
  identical 404 `unknown_user_code` (matches approve's anti-enumeration
  stance). Per-account rate cap ~30/min.
- Deployment: set `DEVICE_LOGIN_URL` in the control-plane env (payload
  string only; no page needs to exist yet).

### 4.2 CLI (`product/cli`) — zero-external-deps invariant holds

- New `src/qr.mjs`: vendored pure-JS QR encoder (byte mode, ECC M) +
  ANSI half-block terminal renderer, MIT-attributed — same pattern as the
  vendored `seal.mjs`. Payload ≈60 chars → QR version 3–4.
- `login.mjs`: send `machineName` (`os.hostname()`) + platform; render QR
  above the human code; keep code + URL as text fallback (`--no-qr` flag,
  auto-fallback on narrow terminals). Drop the dead browser-open.
- Refresh in `cloud.mjs` + `creds.mjs`: request wrapper that (a)
  proactively refreshes when the JWT `exp` is within 60 s (local decode,
  no verify), (b) on 401 calls `POST /v1/auth/refresh`, rotates the stored
  pair atomically (temp file + rename, 0600), retries the original request
  exactly once. Refresh failure prints "Session expired — run `relay
  login`" and leaves the creds file in place.

### 4.3 iOS (`ios/POCVault`)

- `CLILinkScannerView`: `AVCaptureMetadataOutput` QR scanner (iOS 13+),
  `NSCameraUsageDescription` added to Info.plist. Manual code entry on the
  same screen — the camera-denied fallback and the simulator dev path.
- `CLILinkFlowModel`: `scanning → inspecting → confirm(machine) →
  approving → linked | failed(reason)`. Parser accepts the URL form and a
  bare typed code, normalizing case/dashes like the server.
- `RelayAuthClient`: `deviceInspect` + `deviceApprove`, existing Better
  Auth bearer.
- Entry point: "Link a computer" row on the account/sandbox surface,
  styled per Editorial Ember (explicit status copy, never a dot).

### 4.4 Untouched

relayd, broker, trial provisioning, pairing rendezvous, all node auth.
Sessions remain control-plane-only; the data path stays mTLS-only.

## 5. Error handling

- **Stale/foreign/reused QR** — uniform 404 → app copy: "That code isn't
  valid anymore. Run `relay login` on your computer to get a fresh one."
  One message for every failure class; the app cannot distinguish them.
- **Approve race** — approve is an atomic conditional UPDATE (one-shot,
  never rebinds); a lost race lands in the same "not valid anymore" state.
- **Camera denied** — degrade to manual entry with a Settings hint.
- **CLI polling** — unchanged: `authorization_pending`, `interval`
  respected, clean exit on `expired_token`. No sandbox yet → login
  succeeds, prints that handoffs need a sandbox (existing
  `/v1/trial-nodes/current` 404 path).
- **Refresh failure** — friendly re-login message, never a stack trace;
  next command retries and gets the same answer.
- **Network loss** — every app state has a retry affordance; the CLI polls
  until its `expiresIn` deadline.

## 6. Security posture

- **QRLjacking** (attacker phishes a victim into scanning the attacker's
  QR): mandatory confirm sheet naming the machine, copy "Only continue if
  you just ran `relay login` on this computer", one-shot codes, 15-min
  code TTL, approval requires a signed-in app session. Residual risk
  equals GitHub/Google device flow — accepted.
- `inspect` is read-only and equal to approve in anti-enumeration:
  identical 404 for unknown/expired/consumed, plus the per-account cap.
- Machine name is advisory (self-reported); stored server-side, not in the
  QR, keeping the QR small and the record auditable.
- No node-auth changes of any kind.

## 7. Testing

- **Cloud** (`device-code.test.mjs` extensions): machineName sanitization;
  inspect happy path; three anti-enumeration cases byte-identical; inspect
  rate cap; approve one-shot regression.
- **CLI**: golden-vector tests for `qr.mjs` against a reference encoder
  (seal.mjs drift-test pattern); login sends machineName; refresh wrapper
  — 401→refresh→retry-once, atomic rotation, proactive refresh near
  `exp`, friendly failure on family revocation.
- **iOS**: payload-parser unit tests (URL form, bare code, garbage);
  `CLILinkFlowModel` state tests with a stubbed client; simulator QA via
  manual entry.
- **Acceptance**: fresh machine → `relay login` → scan on a real phone →
  approve → `relay init` + `relay handoff` → handoff card on the phone —
  and still working past 15 minutes with `SESSION_TTL_SEC` cranked down
  locally to prove refresh.

## 8. Non-goals

- Universal links / system-camera scanning (payload is already shaped for
  it; separate effort).
- A web approval page behind `DEVICE_LOGIN_URL`.
- BYO-node CLI pairing or CLI mTLS certs.
- Any change to handoff content flow, sealing, or node identity.
