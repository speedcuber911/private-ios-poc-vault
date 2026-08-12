# Relay Trial Sandbox — Instant First Machine at Signup

> Drafted 2026-08-11. Extends [04-product-plan.md](04-product-plan.md) §5 and
> [05-onboarding-plan.md](05-onboarding-plan.md) §6. Replaces the waitlist
> dead-end with an instantly provisioned trial machine backed by a
> self-hosted Cube sandbox. Placeholders are genericized per repo policy;
> live endpoints and credentials stay in the operator's secrets manager.

## Implementation status (added 2026-08-11, audited against `product/`)

Built, tested (see `product/STATUS.md` "Trial sandbox" section for the full
item-by-item table and current test counts):

- relay-cloud: provisioner (`src/provisioner.js`), config (`src/config.js`),
  `trial_nodes` table + registry API (`src/db.js`, `src/registry.js`), routes
  `POST /v1/trial-nodes`, `GET/DELETE /v1/trial-nodes/current`,
  `POST /v1/trial-nodes/enroll`, and the pause/destroy reaper (`sweepTrials`
  in `src/server.js`, folded into the existing sweep timer).
- relay-broker: dynamic node registry (`internal/registry`), wired in as an
  opt-in fallback lookup behind `-registry-url`/`-registry-token-file`
  (closes §Dependencies item 1 below, as an opt-in rather than the default).
- relayd: `enroll` CLI/module (`src/enroll.mjs`) for identity bootstrap +
  single-use-token registration, and trial pairing (`src/trialpair.mjs`, see
  delta below). `product/trial/` holds the Cube/E2B template (Dockerfile,
  `start.sh` init without systemd, `e2b.toml`, `build.sh`).
- iOS (`ios/POCVault`, 96/96 tests green): the "Try instantly" fork flow end
  to end. `RelayTrialNode` DTO + `State` enum + countdown copy
  (`Models/RelayTrialNode.swift`); pairing derivations byte-matched to
  `product/relayd/src/pairing.mjs` (`Security/RelayTrialPairing.swift`,
  cross-checked by fixtures in `POCVaultTests/TrialPairingTests.swift`); the
  trial + pairing-rendezvous client (`Networking/RelayTrialClient.swift`);
  the runtime-mutable active-node pointer (`Models/RelayNodeStore.swift`,
  so the app can be pointed at a freshly provisioned trial node without a
  relaunch); the flow model driving create → device-blob → poll-ready →
  poll-node-blob → verify → PKCS#12 import (`Views/RelayTrialFlowModel.swift`)
  and its Creating/Booting/Pairing/Ready progress sheet
  (`Views/TrialProvisioningView.swift`); the trial badge/countdown and the
  expiry banner with export + upsell actions (`Views/TrialStatusBanner.swift`);
  and the "Trial machine" status/delete section in `AccountSettingsView`.

Already satisfied by pre-existing code (§Dependencies item 2 needs no work):

- **Node reconnect with backoff** — `relayd/src/tunnel.mjs` already ships a
  supervisor that reconnects with decorrelated exponential backoff and jitter
  (`computeBackoffDelay`, `scheduleReconnect` at :462, states
  `connecting → registered | reconnecting → stopped`), wired from
  `src/index.mjs` via `RELAYD_TUNNEL_BACKOFF_MS`/`_MAX_MS`. A broker restart
  therefore does not strand a trial node.
- **Workspace export** — `GET /v1/export.tar` is implemented
  (`relayd/src/fsapi.mjs:392`, routed in `src/additions.mjs`): mTLS-authed,
  jail-contained, denylist-filtered, 512 MiB cap → 413 `export_too_large`.
  Consumed end to end: `CodexClient.downloadExport()` streams it to a temp
  file, and the "Export my files" / "Share my files" action in
  `Views/TrialStatusBanner.swift`'s expiry banner drives it via `ShareLink`.

Pending:

- Live Cube-host verification: template build/boot/egress-preset
  verification against a real Cube host (§Testing), load testing the Cube
  host capacity (§Open questions 1), and the reconciliation sweep comparing
  Cube's sandbox list to `trial_nodes` (§Failure handling) — none of these
  have been run.
- The T-24h expiry warning push — blocked on live APNs, which `cloud/main.js`
  still wires to a no-op transport.
- The post-M3 live-migration path (Lifecycle table: "Keep this machine",
  post-M3 row) — not built; pre-M3 "keep this machine" is the export path
  above, which is built.

**Delta from this plan: the trial pairing credential mechanism.** §Components
says "server-mediated pairing" without specifying how the device gets its
certificate. The implementation (`relayd/src/trialpair.mjs`) cannot reuse the
BYO flow's zero-knowledge CSR exchange (`relayd/API.md` §2.3) because iOS has
no CSR stack today. Instead: the phone posts a small JSON blob
(`{deviceName, platform}`, no CSR) as the cloud-rendezvous device-blob; the
**node** mints the EC keypair, issues the certificate from its own CA, and
packages key+cert+CA as a passphrase-protected PKCS#12, delivered back
through the same cloud rendezvous as the node-blob. The passphrase is
`hex(hmac-sha256(secret, "relay-trial-p12-v1"))`, derived the same way
`authToken`/`macKey` are derived in the BYO flow. Both blobs are still
MAC-tagged and verified exactly as in BYO pairing.

**Unlike BYO, the cloud is not zero-knowledge of this secret on the trial
tier.** The pairing-*session* endpoint (`POST /v1/pairing/sessions`) is told
only `authToken`, same as BYO. But `POST /v1/trial-nodes` is a second,
trial-only call that takes the raw pairing `secret` directly in its body as
`pairingSecret` (`cloud/src/server.js`) precisely so the cloud can hand that
same secret to the sandbox as `RELAYD_ENROLL_PAIRING_SECRET` — the sandbox's
`relayd enroll` needs the secret itself, not just `authToken`, to derive
`macKey` and mint the p12 passphrase. So the cloud *can* compute both
`macKey` and the passphrase for a trial node; nothing about this delta is
zero-knowledge. This is an explicit, scoped trust delta, not a weakening of
the general model: on the trial tier the cloud *already* mediates sandbox
creation and transports the pairing secret itself into the sandbox it just
created — the operator-hosted trust this plan's own §Security section states
plainly to the user ("Trial machines run on Relay infrastructure"). BYO
(`relayd/src/pairing.mjs`) must never receive a secret from the cloud this
way — the cloud there is told only `authToken` and has no path to the raw
secret at all; `trialpair.mjs` is therefore a module separate from the BYO
`pairing.mjs`, reachable only through `relayd enroll` when trial pairing env
vars are present.

## Decision summary (owner-resolved 2026-08-11)

1. **Scope:** every new signup instantly gets a sandbox as their starter
   machine. This replaces the waitlist dead-end at the fork screen. Dedicated
   per-user EC2 VMs remain the paid upgrade tier (M3). The waitlist survives
   only as a secondary "notify me about paid machines" link.
2. **Lifetime:** time-boxed trial. 7-day TTL from creation (tunable), warning
   push at T-24h, 72-hour paused grace period after expiry with data export,
   then destruction. Persistence is the paid upsell.
3. **Backend:** self-hosted **Cube Sandbox** (Tencent, Apache-2.0,
   E2B-API-compatible microVMs) on the operator's existing EC2 host. Because
   Cube speaks the E2B protocol, the provisioner stays backend-agnostic and
   e2b-hosted remains an endpoint-swap fallback.
4. **Agent auth:** the user's own subscription. The trial user logs into
   Codex / Claude Code / Cursor CLIs inside the sandbox via device-code flow
   surfaced in the app. No Relay-funded LLM keys exist anywhere in the
   sandbox.
5. **Integration:** the sandbox is a **normal relayd node** that happens to be
   auto-created — same broker tunnel, same mTLS, same jail. App code sees an
   ordinary node with a `trial` flag and a TTL.

## Why

The onboarding plan's v1 answer to "I don't have a VM" was a waitlist — a
dead-end that converts curiosity into a bookmark. A trial sandbox converts it
into the real product experience within seconds, exercises the actual
tunnel/pairing/SSE stack end to end, and produces the same demand evidence
the waitlist was meant to collect, but with activated users instead of email
addresses. Marginal cost is near zero because the Cube host already exists.

## Signup flow

```text
Fork screen (§2 of 05-onboarding-plan.md)
  |- [A] Connect your machine  (BYO, unchanged)
  |- [B] Try instantly         (NEW — this plan)
  |- [C] Watch the demo        (unchanged)
  `- small print: waitlist link for paid managed machines

[B] after Sign in with Apple:
  1. App -> relay-cloud POST /trial-nodes
  2. relay-cloud enforces caps:
       - one trial per account (lifetime, not concurrent)
       - global concurrency cap (sized by load test, see Open questions)
  3. relay-cloud registers a fresh node identity with the broker
     (REQUIRES dynamic node registry — see Dependencies)
     and mints a single-use provisioning token
  4. relay-cloud -> Cube host (E2B protocol): create sandbox from the
     Relay trial template; bootstrap env carries token + broker suffix
  5. relayd starts inside the sandbox, generates its keypair IN the
     sandbox, enrolls with the broker, receives its SNI hostname
  6. Server-mediated pairing: relay-cloud completes pairing for the
     signed-in account (no QR — the cloud created this node for this
     account). Phone receives its client certificate exactly as today.
  7. App shows Creating -> Booting -> Enrolling -> Ready
     (same states as 05-onboarding-plan.md §6.2). Target: Ready < 10 s.
```

First-run inside the app is the existing funnel: file browser opens on
starter folders plus a README, the harness-connect step surfaces device-code
login for the user's own subscriptions, and the first-task push remains the
finish line.

## Lifecycle

| Event | Behavior |
|---|---|
| Creation | TTL clock starts (7 days, config value) |
| T-24h | Warning push: "Your trial machine expires tomorrow — keep it or export" |
| Expiry | Sandbox paused; node shows as expired in app; data intact |
| Expiry + 72h | Sandbox destroyed; row retained for the one-trial-per-account cap |
| "Keep this machine" (pre-M3) | Workspace tarball export via the app + paid-tier waitlist |
| "Keep this machine" (post-M3) | Live migration to a managed VM (F2 provisioning) |
| Upgrade to BYO | Export seeds the user's own box; account keeps its threads |

Idle trial sandboxes stay running in v1 (Cube per-instance overhead is small);
pause-on-idle is a later cost optimization, not a launch requirement.

## Components

### relay-cloud (most of the new code)

- **Provisioner module** speaking the E2B protocol. Works against the Cube
  host today; e2b hosted later by changing endpoint + key. This is the
  adapter seam promised in 04-product-plan.md §5.
- **`trial_nodes` table** (existing sqlite): account id, node id, sandbox id,
  created_at, expires_at, state (creating | ready | expired | destroyed).
- **Reaper job:** pause at expiry, destroy after grace. Idempotent; safe to
  re-run after crashes.
- **`POST /trial-nodes`** with the caps above; **server-mediated pairing**
  endpoint binding the new node to the calling account.
- **Feature flag:** if the Cube host is unreachable, the fork screen simply
  omits "Try instantly" and degrades to demo + waitlist.

### relay-broker

- **Dynamic node registration** replaces the flag-based registry. Already
  needed for any multi-tenant launch; trial nodes make it a hard dependency.
- **Node reconnect with backoff** (the proven broker-restart-kills-node gap)
  is likewise promoted to hard dependency: a trial user whose machine
  silently dies on a broker deploy is a churned user.

### Sandbox template

- Build script producing the Cube template: relayd binary, pinned harness
  CLIs (codex, claude, cursor-agent), git/node/python and common tools,
  starter workspace folders under the jail path, README.
- **No systemd inside the microVM:** relayd runs as a supervised foreground
  process under the sandbox init. relayd itself is indifferent; only the
  BYO installer assumed systemd. The template gets its own minimal
  supervisor/restart wrapper.
- Template version is recorded on the trial node row so stale sandboxes can
  be identified.

### iOS

- Fork-screen option, provisioning progress states, trial badge + countdown
  on the node row, expiry / export / upsell screens.
- Browser, chat, jobs, threads: untouched — a trial node is an ordinary node.

### Ops / secrets

- Cube endpoint + admin token and the broker enroll secret live in the
  operator's secrets manager. Nothing is committed to the repo; docs keep
  genericized placeholders.

## Security, abuse, trust

**Trust tiering, stated honestly.** BYO remains the maximum-trust tier:
per-node CA born on the user's box, no operator access. A trial sandbox runs
on operator infrastructure, so the operator *can* technically access its
contents. The app says so plainly ("Trial machines run on Relay
infrastructure — connect your own machine for full privacy"). Node keys are
still generated inside the sandbox and the zero-knowledge broker never sees
plaintext; the difference is host-level trust, and it is not blurred.

**Isolation & abuse controls.**

- One microVM per trial (Cube/RustVMM); CPU, RAM, and disk quotas; no
  inbound connectivity at all.
- eBPF egress preset: allow LLM provider endpoints, git hosts, package
  registries; deny SMTP; default-deny the rest. Preset is config, reviewed
  before launch.
- Sign in with Apple gates account farming; one trial per account
  (lifetime); global concurrency cap; sustained-CPU alarm for miners; TTL
  bounds any abuse blast radius.
- **No Relay-owned LLM or cloud credentials inside the sandbox** — nothing
  to exfiltrate, no inference bill to run up. This is what makes a live
  (non-simulated) trial safe where a funded demo was not.

**Invariants preserved** (see relay security invariants):

- mTLS remains the only client authentication; no bearer tokens to nodes.
- Provider credentials never transit the phone or relay-cloud; device-code
  login lands the token inside the sandbox only.
- Jail semantics identical to every node; realpath containment unchanged.
- No Tailscale anywhere.
- Catalog honesty: harness rows appear only after the user's login succeeds
  inside the sandbox.

## Failure handling

| Failure | Behavior |
|---|---|
| Cube host unreachable | Feature flag hides "Try instantly"; demo + waitlist remain |
| Sandbox create timeout | One retry, then apology screen + demo/waitlist |
| relayd enroll failure | Sandbox destroyed, token invalidated, user sees retry |
| Broker restart | Node reconnect with backoff (dependency); tunnel resumes |
| Reaper crash mid-pass | Idempotent re-run; states re-derived from expires_at |
| Trial row vs sandbox drift | Reconciliation sweep compares Cube list to trial_nodes |

## Testing

- **Template CI:** build template → boot sandbox → relayd enrolls against a
  staging broker → run a fake-harness task end to end → assert SSE output.
- **Provisioner:** unit tests against an E2B-protocol mock; one live
  integration test against the Cube host.
- **Abuse:** egress preset verified from *inside* a sandbox (allowed hosts
  reachable, denied hosts blocked); quota enforcement observed.
- **Lifecycle:** reaper unit tests over synthetic clock; expiry → grace →
  destroy transitions; one-trial-per-account enforcement.
- **Live smoke (physical iPhone):** signup → Ready < 10 s → device-code
  login for one harness → first task completes → trial badge and countdown
  render.

## Dependencies (hard, in order)

1. Broker dynamic node registration.
2. Node reconnect with backoff.
3. Trial template build (relayd without systemd).
4. relay-cloud provisioner + lifecycle + pairing.
5. iOS fork screen + progress + trial states.

## Milestone fit

Lands with **M2** (it replaces the waitlist-only fork), behind the feature
flag, as soon as dependencies 1–2 exist. It does not gate on M3; instead it
front-loads the provisioner adapter that M3's paid VMs will reuse with an
EC2 backend. The M2→M3 validation gate in 04-product-plan.md changes from
"waitlist demand" to "trial activation and conversion evidence" — a strictly
stronger signal.

## Open questions

1. **Cube host capacity:** instance size determines the global trial cap;
   one load test (N idle sandboxes + M concurrent tasks) sizes it before
   launch.
2. **Secrets manager wiring:** exact name/interface of the operator's
   secrets manager to be confirmed when ops are scripted.
3. **Trial length experiment:** 7 days is the starting value; funnel data
   may argue for hours-of-use instead of wall-clock days.
4. **Export format:** plain tarball vs git bundle for workspace export;
   decide during implementation of the expiry flow.
