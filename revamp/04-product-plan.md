# Relay Product Plan — From Personal Install to Multi-Tenant Product

> Status: proposal, 2026-08-09. Follows the 00–03 revamp series. All hostnames,
> IPs, and account identifiers are genericized per repo policy. Nothing in this
> document changes the live personal install; the personal deployment described
> in 00-OVERVIEW.md remains the reference environment and becomes "node #1" of
> the product during dogfooding.

---

## 1. Thesis

**Relay becomes mission control for coding agents that run on YOUR machine.**

Every major vendor is converging on the same shape: agents running in *their*
cloud sandbox, controlled from *their* app — Codex cloud inside ChatGPT, Claude
Code sessions on claude.ai, Cursor background agents. Nobody serves the person
who wants:

1. Agents running on **their own VM / dev box / homelab** — with their real
   environment, dotfiles, databases, and network position.
2. **All three major harnesses in one place** — Codex, Claude Code, Cursor
   Agent — one inbox, one files view, one notification stream.
3. Their existing **flat-rate subscriptions** (ChatGPT Pro, Claude Max, Cursor
   Ultra) doing the work — not a middleman remetering API tokens.
4. **Actual privacy**: a control plane that structurally *cannot* read their
   code or their prompts.
5. A **native iPhone experience**: real push notifications, lock-screen
   approvals, Live Activities — not a mobile web wrapper.
6. **Continuity with the desk.** Work started from the phone is already
   waiting on the laptop — a pushed branch, ready to review — and work in
   flight survives shutting the laptop, because the session lives on the
   backing VM, not the laptop.

That is exactly what this repo already is for one person. The product is the
same system with the personal assumptions removed: identity that strangers can
enroll in, connectivity that works without hand-run cert scripts and public
IPs, a managed-VM path for people with no infrastructure, and a notification
pipeline so long-running tasks reach the lock screen.

**Category:** agent operations console ("mission control for coding agents").

**One-line pitch:** *Run Claude Code, Codex, and Cursor on your own server,
from your pocket. Your keys, your repos, your machine — get pinged the moment
an agent finishes or needs you, and find the branch already waiting when you
open your laptop.*

---

## 2. The offering, sharpened

### 2.1 Personas

- **Primary — the agent operator.** Senior/staff engineer or serious indie
  hacker. Pays for 1–3 agent subscriptions. Fires several long-running tasks a
  day. Away from the desk for real chunks of time and hates that agents idle
  or block while they're out. Comfortable pasting one install command on a VM.
- **Second — the aspiring agent-runner.** Capable dev, fully on the agent
  wave, but will not wire up a safe always-on machine themselves — the
  know-how and the patience aren't there, and they know it. This is the
  **larger** market. They enter through the managed tier ("we provision and
  secure it for you"), and user interviews suggest a $20/mo ask is an instant
  yes when the pitch is "your agents keep working after you close the
  laptop."
- **Secondary — the self-hoster.** r/selfhosted crowd. Cares about the
  zero-knowledge story and the open-source daemon. Evangelizes.
- **Later — the small team.** 2–10 engineers sharing a beefy agent box, with
  per-member device identities and an audit trail.

### 2.2 Jobs to be done

1. *Fire and forget:* start a long refactor/build/research task, lock the
   phone, get pushed when it finishes, fails, or goes quiet.
2. *Seamless handoff:* every task runs in its own worktree and pushes a
   branch; open the laptop and the work is sitting there, fetchable and
   reviewable. In the other direction, shut the laptop mid-flow — the backing
   VM carries the session and the phone picks it up. An interviewee called
   the handoff "the only unlock" — treat it as first-class, not a nicety.
3. *Needs-you moments:* approve a risky command, answer an agent's question,
   or unblock a permission gate from the lock screen.
4. *Triage:* multiple tasks across machines in one inbox — read the diff,
   browse the workspace, download the artifact, fire the follow-up.
5. *One surface over all subscriptions:* Codex vs Claude vs Cursor per task,
   chosen at send time, threads grouped by folder — already Relay's model.
6. *No infra, no problem:* one tap provisions a ready machine.

### 2.3 Positioning map

Two axes: **whose infrastructure** (their cloud ↔ your machine) and **harness
coverage** (single ↔ multi). Relay is alone in the *your-machine ×
multi-harness* quadrant:

| | Their cloud | Your machine |
|---|---|---|
| **Single harness** | Codex cloud (ChatGPT app), Claude Code web/mobile, Cursor background agents, Terragon | Happy Coder (Mac mirror, Claude-only), VibeTunnel-style terminal mirrors |
| **Multi harness** | — (structurally off-strategy for vendors) | **Relay** |

The first-party surfaces will keep improving — that's the biggest competitive
risk — but multi-harness neutrality, BYO infrastructure, and a
cannot-read-your-code control plane are things OpenAI, Anthropic, and Cursor
are all structurally disincentivized to build. That's the moat, so the product
must be uncompromising on all three.

Adjacent but distinct: **OpenClaw-class always-on assistants** and their
hosted derivatives (including the Kimi-hosted variant that comes up in user
interviews). Those are *a harness that needs a perpetual machine*; Relay is
*how you own machines that run any harness*. Two consequences. First, hosted
versions validate the demand while ceding the trust axis — "nice interface,
but it's someone else's infrastructure and God knows what they do with it" is
verbatim the objection our zero-knowledge, your-box architecture answers.
Second, that ecosystem is capturable rather than competitive: an OpenClaw
adapter on relayd (D9) makes Relay the easiest *safe* way to run one,
inheriting that community's "I need an always-on box" demand instead of
fighting its harness.

### 2.4 What Relay is NOT

Not an IDE. Not a terminal emulator. Not a CI system. Not an agent framework
or marketplace. Not a token reseller — Relay never sits in the billing path of
model usage, ever. These refusals keep the surface small enough for a tiny
team to polish.

### 2.5 Naming

**Decided (D1): the brand is Relay.** The name is crowded (Relay FM, multiple
App Store apps), so a trademark / App Store collision check remains an M4
launch gate — if a hard conflict surfaces, the fallback is a qualified form
("Relay Agents"), not a rebrand. Everything else in this plan is
name-independent.

### 2.6 Objections to beat (verbatim from user interviews)

- **"Will you give me $20 of tokens for my $20?"** Wrong frame — answer it
  head-on in marketing. Relay sells zero tokens: the subscriptions the user
  already pays for do the inference. Relay sells the always-on machine, the
  safe wiring, the native surface, and the handoff. "We are just providing
  the VM and the surface" is the honest unit-economics story — infrastructure
  margins, never token-resale losses.
- **"Why not just build on OpenClaw — the ecosystem is huge."** Backend
  aside, the sellable thing is the surface and the continuity, and harnesses
  are adapters by design — OpenClaw can *become* one (§2.3, D9). Relay
  refuses to bet the product on any single harness; that neutrality is the
  moat.
- **"You're in the same segment as the hosted agent-box providers."** Only at
  first glance. They run agents on their infrastructure with their models;
  Relay's entire architecture is the opposite — your box, your
  subscriptions, a control plane that provably can't read the traffic.
  Market the difference, never blur it.

---

## 3. v1 scope — keep / change / cut

### Keep (generalize as-is)

- **Files-first shape**: browser at the workspace jail root, per-folder
  conversations, read-only viewer. This is the product's signature.
- **The job engine and API contract**: async jobs, SSE stream + polling
  reconcile, threads, artifacts with raw/preview, cancel/timeout, sessions.
  The current `/v1/codex/*` contract freezes as **Relay Node API v1**.
- **Three harness adapters** (Codex, Claude Code, Cursor Agent) behind the
  provider seam, with **catalog honesty**: a provider/model appears only after
  an on-box smoke test passes. This invariant generalizes verbatim.
- **The jail**: phone never sends a path outside the workspace root; server
  realpath-contains everything; secret-file denylist on the fs API.
- **mTLS as the only data-path auth** — productized, not replaced (see §4.3).
- Provider credentials never leave the node; subscription state lives in the
  isolated runner home. This is now a *selling point*, not just hygiene.

### Change (personal → product)

| Today (personal) | Product |
|---|---|
| Exactly two allowed cert subjects, hand-issued via `ops/generate-client-certs.sh` | Per-node CA; devices enroll via a pairing ceremony (§4.3) |
| p12 dropped into the app container + passphrase ritual | Secure Enclave keypair; CSR issued during pairing; auto-renewal |
| One VM, public IP + DNS + hand-configured Caddy | Outbound-only tunnel to a rendezvous broker; zero inbound ports; direct mode still supported |
| `/etc/codex-api.env` hand-rendered by `ops/render-codex-api-config` | `relayd` config + enrollment; harness manager detects/installs CLIs |
| Job state as JSON files in the jobs dir | SQLite for jobs/threads/events; logs and artifacts stay on disk |
| No notifications; app polls while foregrounded | APNs pipeline: silent/mutable pushes, NSE content fetch, Live Activities, actionable approvals |
| One node hardcoded in support config | Multi-node model in the app; cross-node task inbox |

### Cut from product v1 (remain personal/legacy features)

- **POC Vault static hosting, signed manifest, Library tab.** It's a personal
  workflow. Its spiritual successor — "share a preview link for an artifact or
  workspace build" — returns later as a product feature built on the artifacts
  system, not on the manifest contract.
- **Azure/Bedrock BYO-key chat.** Later "bring your own API key" feature.
  Codex-subscription chat covers the synchronous surface for v1.
- **Server-side Azure Speech transcription.** Replace with on-device
  transcription (iOS 26 SpeechAnalyzer / dictation). Removes a server
  credential and a whole API surface from the product path.
- CarPlay port stays parked.

### Golden flows (design targets; each is a demo)

> F1/F2 first-run details — walkthrough screens, the fork, pairing ceremony
> UX, waitlist mechanics — are specced in
> [05-onboarding-plan.md](05-onboarding-plan.md).

- **F1 — BYO onboarding:** `curl -fsSL https://<get-domain>/install.sh | sh`
  on any Ubuntu/Debian VM → daemon prints a QR → scan in app → subscription
  connect (device-code logins surfaced on the phone) → first task. Target:
  **under 10 minutes**, zero manual cert or config file steps.
- **F2 — Managed onboarding:** sign in → "Create a machine" → size/region →
  push when ready (**target <90 s**) → connect subscriptions → first task.
- **F3 — Fire and forget:** folder → agent/model/effort → prompt (voice OK) →
  lock phone → Live Activity on lock screen → completion push → review
  diff/artifact → follow-up.
- **F4 — Needs-you:** agent hits a permission gate or asks a question →
  actionable push (Approve / Deny / Open) → resume without unlocking the app.
- **F5 — Triage:** three tasks across two nodes in one inbox.
- **F6 — The handoff:** the task ran in its own worktree and pushed a branch;
  the completion push says "branch `relay/<task>` pushed." Open the laptop,
  `relay pull` (or plain `git fetch`) and the diff is up for review. Reverse
  direction: `relay send` beams the current repo state plus a prompt to the
  node as you shut the lid, and the phone shows it running.

---

## 4. Architecture

Three components. The guiding rule: **the cloud is a rendezvous, not a
platform.** All content — code, prompts, transcripts, artifacts — flows
phone↔node inside end-to-end mTLS the cloud cannot open.

```text
┌─────────────┐   E2E mTLS (TLS passthrough)    ┌──────────────────┐
│  Relay app   │═══════════════════════════════▶│  relayd (node)    │
│  (iPhone)    │        ┌──────────────┐        │  BYO VM / managed │
│              │───────▶│ Relay Cloud   │◀───────│  VM / Mac / box   │
└─────────────┘  acct,  │ rendezvous +  │ enroll,└──────────────────┘
        ▲        pairing│ APNs + provi- │ minimal   harnesses run here:
        └── APNs ───────│ sioning + $$  │ events    codex / claude / cursor
                        └──────────────┘           under runner user, jailed
```

### 4.1 relayd — the node daemon (productized `server.mjs`)

`relay-server/codex-api-deploy/server.mjs` (6,642 lines, single file) *is*
relayd v0. It already has the hard parts: the job engine, three harness
adapters, SSE streaming, the fs API with realpath containment and a
secret-file denylist, thread persistence, artifacts, audit logging, and a
catalog with honesty rules. Productization is extraction and packaging, not a
rewrite of the ideas:

- **Modules:** routes / job engine / harness adapters / fs API / thread store
  / catalog+smoke / audit / identity / tunnel. Contract-freeze the HTTP+SSE
  surface as Node API v1 first so the iOS app is untouched by the refactor.
- **Worktree-per-task (handoff v0):** for git workspaces, the job engine runs
  each task in its own worktree on a `relay/<task>` branch and pushes on
  completion when a remote is configured — finished work is fetchable from
  the laptop before the phone is even unlocked. This productizes the exact
  worktree-and-push-branches pattern this repo already uses for its own agent
  work, and it doubles as the isolation mechanism behind the per-workspace
  concurrency rule below.
- **State:** SQLite (`jobs`, `threads`, `events`, `devices`) replacing
  per-job JSON files — the inbox and history queries need it. stdout/stderr
  logs and artifacts stay as files. `audit.jsonl` stays.
- **Two listen modes:** *direct* (today's behavior — bind behind a local
  gateway or its own TLS listener; keeps the personal install and the
  self-hosted purist path first-class) and *tunneled* (outbound connection to
  the broker; zero inbound ports — the default for the product).
- **Identity:** node keypair + **node CA** generated at install; device cert
  issuance and revocation (§4.3); mTLS required on every data-path request in
  both modes (replaces the Caddy-forwarded-subject re-check with native TLS
  termination in tunneled mode; direct mode keeps the gateway pattern).
- **Harness manager:** detect installed CLIs and versions; install on
  request; run the smoke matrix; orchestrate subscription logins by proxying
  each CLI's device-code/URL flow to the phone (the app displays the link/QR
  and confirmation — credentials still never transit Relay).
- **Event bus:** job state changes, approval requests, long-silence, disk
  pressure → local SSE subscribers + minimal signed events to the cloud for
  push fanout (§4.4).
- **Ops absorbed:** `generate-client-certs.sh` / `issue-server-cert.sh` /
  `revoke-client-cert.sh` → node CA; `install-codex-api.sh` +
  `render-codex-api-config` → installer + enrollment; `verify-server.sh` →
  `relayd doctor`.
- **Packaging:** install script + systemd unit; Linux x86/arm64 first; macOS
  (launchd) soon after — a spare Mac mini is a hugely popular agent box.
  Language: alpha stays Node (fastest path from the current file); port to Go
  for a single static binary before public beta (decision D2). The API v1
  freeze makes the port mechanical and separately testable against the same
  contract suite (`server.test.mjs` becomes the conformance suite).

**Concurrency, hardened for a product:** per-node queue with visible queue
position, and a **per-workspace mutex** — two agents mutating one folder is
corruption, and today's `CODEX_MAX_CONCURRENT=1` generalizes to
"concurrency defaults set by VM size, raised only on evidence."

### 4.2 Relay Cloud — the control plane (deliberately tiny)

Five services, one Postgres, no content storage:

1. **Accounts:** Sign in with Apple + email magic link. Rows: `accounts`,
   `devices` (APNs token, cert serial, platform), `nodes` (kind: byo|managed,
   pubkey, version, last_seen), `entitlements`.
2. **Rendezvous/broker:** the only clever piece. relayd holds a persistent
   outbound WSS (later QUIC) connection, multiplexed (yamux-style). The phone
   dials `<node-id>.tun.<domain>`; the broker sniffs the SNI and pipes raw
   bytes into the node's tunnel. **TLS terminates on the node**, which
   requires a client cert from its own CA. The broker moves ciphertext only.
   Small, well-trodden (~frp/inlets-class, a few kLOC of Go). Build spike in
   M0; embedding an existing OSS tunnel core is the fallback (D3).
3. **Notify:** ingests minimal signed node events — `{node, job, state, ts}`,
   no titles, no prompts, no content — maps to devices, sends APNs
   (token-based auth): silent pushes for state sync, mutable pushes whose
   **Notification Service Extension fetches the real content from the node
   over the tunnel** and rewrites the banner, Live Activity updates via their
   push tokens. Content never rests in the cloud; event retention is days,
   not months.
4. **Provisioner:** managed-VM lifecycle (§5).
5. **Billing:** Stripe on the web dashboard; the app reads entitlements
   (§6). Plus a minimal web dashboard: account, nodes, billing, docs.

Hosting (owner decision): self-hosted on a single EC2 instance in ap-south-1
with colocated Postgres — no PaaS. A solo-maintainer control plane must be
boring, so: systemd/compose deploys, IaC'd from day one, automated DB backups
to S3, external uptime monitoring. The zero-knowledge design keeps this box
low-value even if breached — ciphertext relay plus metadata, no content, no
CA keys. Graduate Postgres to RDS when revenue justifies it.

### 4.3 Trust model: per-node CA, cloud holds no keys

- At install, relayd generates its own CA. **Pairing:** the app creates a
  P-256 key in the Secure Enclave, and sends a CSR through the pairing channel
  (the QR the daemon prints encodes the node's rendezvous id + a single-use
  pairing secret; the CSR/cert exchange runs E2E through the broker). The node
  issues the device cert; the app **pins that node's CA** for its hostname.
- Consequences: no public PKI needed for node hostnames; device loss is handled
  by per-node revocation lists managed from another enrolled device or the CLI.
- **The cloud must not be able to induce enrollment (learned the hard way).**
  An adversarial audit of the first implementation ran the attack: the cloud
  generated the pairing secret, saw it in plaintext, and stored the relayed
  blobs with no integrity tag and no put-once — so a compromised control plane
  could replace the device's CSR with its own before the node read it. The node
  would then sign the attacker's key and hand back a valid client certificate.
  The cloud never mints a cert itself, which is why "there is no key to steal"
  reads as true; it induces the node's CA to mint one, which is just as bad.
  State the property precisely: *the cloud cannot obtain data-path access, by
  minting or by inducement.*
- **How that property is enforced (pairing v2).** The **node** originates the
  pairing secret; the phone receives it out of band from the QR. Both peers
  derive `macKey = HMAC(secret, "relay-pair-mac-v1")`, and the cloud is told
  only `authToken = sha256("relay-pair-auth-v1" ‖ secret)`, of which it stores
  only a hash — so it never holds the secret and can never derive `macKey`.
  Every relayed blob carries `HMAC(macKey, slot ‖ blob)`, verified by the
  receiving **peer**, never by the cloud. A node that cannot verify the tag
  refuses to issue any certificate and audits the attempt. Slots are put-once
  and the session is destroyed once both are consumed, so a leaked QR cannot be
  used to rewrite a blob after the exchange. The cloud stays a dumb relay of
  opaque bytes — which is the only role it can be trusted with.
- Managed VMs get the same treatment — CA generated on first boot inside the
  tenant's VM. Be honest in the security docs: the operator has hypervisor
  root on managed VMs; BYO is the maximum-trust tier. (Attested/confidential
  images are a someday-tier, not v1.)
- **Invariant continuity:** "mTLS is the ONLY auth" survives as *the only
  data-path auth*. The cloud account session authorizes rendezvous, pairing,
  push routing, and billing — never file reads, never job submission. No
  Tailscale dependency appears anywhere; BYO users with their own overlay
  networks simply use direct mode across it.

### 4.4 Tenant isolation

- **BYO:** isolation is inherent — their box. Multi-tenancy exists only in
  control-plane rows and broker routing.
- **Managed:** **one VM per tenant. Full stop.** No shared-kernel container
  multi-tenancy in v1/v2 — the security story must be explainable in one
  sentence. Firecracker-class density is a cost optimization for much later.
- **Within a node**, today's invariants carry verbatim: workspace jail with
  realpath containment, secret denylist on fs reads, isolated runner user,
  provider credentials in root-protected/runner-home locations only, bounded
  list/read endpoints, no-store headers.

### 4.5 Approvals and steering (the killer native feature)

Long-running agents block on permissions and questions; today those moments
are invisible until you foreground the app. Product v1.x surfaces them:

- relayd runs harnesses in interactive-capable modes where supported (Claude
  Code's permission-prompt/stream-json seam and hooks; Codex approval modes;
  Cursor as capabilities allow) and emits `needs_input` events.
- The app maps them to **actionable notifications** (Approve / Deny / Open)
  and, later, Watch actions. Default per task remains full-auto-in-the-jail;
  approval mode is an opt-in toggle at send time.
- Capability flags per harness in the catalog (`supportsApprovals`,
  `supportsResume`, `supportsChat`) — the honesty invariant extended.

### 4.6 Relay CLI — the desk end of the handoff

A small companion for the laptop, not a second product. It enrolls exactly
like a phone (device cert from the node's CA — no new auth concepts):

- `relay status` — tasks across nodes, in the terminal.
- `relay pull` — fetch and check out the branch a finished task pushed; the
  completion push's "Open on your Mac" action deep-links here.
- `relay send` — beam the current repo state plus a prompt to a node and
  keep going from the phone: the shut-the-laptop moment, made deliberate.
- `relay sync-auth` — opt-in mirror of existing local CLI logins
  (codex/claude/cursor) to a node, over the E2E channel only, never via the
  cloud. Kills the log-in-three-times-again friction of onboarding (D10).
- Desktop notifications later; the CLI is also the natural seam for future
  editor integrations.

Sequencing: v0 (`status`/`pull`) lands at M4; `send`/`sync-auth` fast-follow.
The handoff itself does not wait for the CLI — branch-push works with plain
`git fetch` from M1 onward.

---

## 5. Managed VMs ("no VM? one tap")

- **Provider (decided, D5):** AWS ap-south-1 — the account, the operational
  muscle, and `ops/provision-ec2.sh` heritage already exist. Graviton
  burstable instances (t4g class) match the agent workload shape: mostly
  idle, CPU bursts during runs. Two AWS-specific consequences: the managed
  tier floors at ~$15/mo (compute + EBS leave no margin below that), and
  egress caps are a real cost control, not just an abuse control. The
  provisioner stays an adapter seam — same lesson as the harness seam — so a
  Hetzner adapter can drop in later purely as cost optimization.
- **Image:** snapshot with relayd + harness CLIs preinstalled, runner user
  and jail prepared, unattended upgrades on. Boot with a single-use enroll
  token in user-data → node auto-enrolls to the purchasing account → "your
  machine is ready" push. Target under 90 seconds.
- **Zero inbound:** managed nodes only ever dial out to the broker. No SSH
  exposed by default (break-glass via provider console).
- **Lifecycle:** disk quotas, log rotation, optional auto-archive of idle
  machines to snapshot on the cheaper tiers, restart-from-app.
- **Abuse controls** (this is the riskiest surface of the whole product):
  payment method required for managed tier; AUP; egress firewall presets
  (package registries, git hosts, model-provider APIs open; broad egress a
  visible toggle); lightweight CPU-pattern monitoring for miners; rate limits
  on provisioning.
- **Subscriptions remain the user's own,** connected by them, stored in their
  VM's runner home. Relay never proxies, stores, or remeters model access —
  even on managed VMs. This keeps unit economics clean (we sell compute +
  software, not tokens) and keeps us out of providers' billing blast radius.

---

## 6. Business shape

- **Open-core (decided, D4):** open-source relayd. It runs adjacent to
  users' subscription credentials — auditability *is* the privacy pitch — and
  community harness adapters are the cheapest way to stay harness-complete.
  Monetize the cloud (rendezvous, push, provisioning, teams) and the app.
- **Packaging sketch** (validate in beta):
  - **Free:** 1 BYO node, 1 device, full core features, push included (push
    is the hook — never paywall the hook).
  - **Pro (~$15–20/mo):** unlimited nodes + devices, Live Activities,
    actionable approvals, extended inbox history, priority rendezvous. The
    $20 point surfaced unprompted in user interviews as an instant yes for
    the target persona; anchor there, discount annually.
  - **Managed machine (+$15–25/mo per VM by size):** compute + lifecycle
    (AWS ap-south-1 economics; see §5).
  - **Team (later):** shared nodes, per-member device certs, audit export.
- **Billing on the web**, app reads entitlements. Avoids 30% IAP on compute
  passthrough; standard for dev tools. Rails run through the Indian entity
  (§9 resolved): Stripe India if onboarding allows, else Razorpay
  international or a merchant-of-record contracted by the entity — verify
  which during M2, not at M3 crunch. Revisit IAP for Pro-only if App Store
  friction demands it.
- **App Store risk is manageable:** remote-execution dev tools have deep
  precedent (SSH clients, Working Copy, Happy). Provide reviewers a sandbox
  node minted by the provisioner. Sign in with Apple satisfies account rules.

---

## 7. iOS app: personal app → product app

New product target + new bundle id in App Store Connect; the existing
`com.parikshit.pocvault` app and module names stay untouched (per the
branding/stability rule) and keep working against node #1. The product target
reuses the Swift sources.

- **A1 NodeStore:** multi-node model — name, rendezvous host or direct URL,
  pinned CA, identity ref. Replaces the single support-config. Browser roots
  become per-node.
- **A2 Identity:** Secure Enclave keypair + pairing flow (scan QR → CSR →
  cert → pinned CA). Deletes the p12-in-Documents ritual from the product
  path. Auto-renewal ahead of expiry.
- **A3 Onboarding:** walkthrough → fork (connect your machine / create a
  managed machine — waitlist until M3 / demo) → pairing → harness connect →
  first task with notification priming. Full screen-by-screen spec in
  [05-onboarding-plan.md](05-onboarding-plan.md).
- **A4 Notifications:** APNs registration; NSE target that fetches content
  E2E and rewrites banners; notification categories with Approve/Deny/Open;
  ActivityKit Live Activities for running jobs (status, elapsed, current
  step from the SSE title stream).
- **A5 Inbox:** cross-node list of running/queued/finished tasks above the
  files browser. This plus F3/F4 is the daily-driver loop.
- **A6 On-device transcription** replacing the server Azure Speech path.
- **A7 Account/paywall/settings**, App Store assets, onboarding polish.
- **Keep:** FileBrowserView/FileViewerView, RelayChat thread UI, CodexClient
  (contract is frozen), Markdown rendering, interactive/outside-tap keyboard
  dismissal without a custom accessory, and artifacts preview via
  AuthenticatedWebView.

---

## 8. Execution roadmap

Solo-with-agents pace; Relay builds Relay (the dogfooding loop is also the
marketing content). Each milestone has a demoable exit gate.

| # | Milestone | ~Weeks | Contents | Exit gate |
|---|---|---|---|---|
| **M0** | Decide + freeze | 1–2 | Decisions D1–D8; Node API v1 freeze doc; **tunnel spike** (SNI-passthrough broker PoC) | Phone → broker → relayd mTLS SSE stream works on a fresh VM |
| **M1** | relayd alpha + pairing | 3–4 | Extraction to modules + SQLite; node CA + enrollment; installer; worktree-per-task + branch push (handoff v0); app NodeStore + Secure Enclave pairing; personal box enrolled as node #1 | Fresh Ubuntu VM → first task from phone in <10 min, no manual certs |
| **M2** | Cloud + push beta | 3–4 | Accounts, registries, broker prod-ready, APNs + NSE + Live Activities, inbox; TestFlight with the five committed design partners (Rohan, Vishal, Tanish, Minal, Shlok); **ops track:** incorporate Indian entity, billing-rails verification (Apple org enrollment deferred to ~launch; TestFlight ships from the personal team) | F3 end-to-end: lock-screen completion push on a real task; partners retained week-over-week |
| **M3** | Managed VMs + billing | 3–4 | Provisioner + image + lifecycle + abuse controls; Stripe + entitlements; web dashboard; ToS/AUP/privacy | F2: paid machine ready <90 s; first paying users |
| **M4** | Approvals + launch | 4–6 | Actionable approvals per harness; `relay` CLI v0 (status/pull + push deep link); artifact/diff review polish; onboarding polish; open-source relayd release; App Store submission; landing + docs | App Store live; F4 + F6 demos; launch post |

**Validation gate between M2 and M3:** don't build provisioning until BYO
design partners demonstrate weekly retention — the wedge is cheaper to
validate than the platform. North-star metric: **agent tasks completed via
Relay per weekly-active operator**; guardrails: time-to-first-task,
push→action latency.

---

## 9. Decisions needed (with recommendations)

**Resolved 2026-08-09 (owner):**

- **Ambition — venture-scale company.** The roadmap runs at the written
  4–5 month pace; entity, billing, and App Store work are committed. The M2
  retention gate remains as a scope check on managed VMs, not a go/no-go on
  the company.
- **Team — solo, with agents.** Single-owner roadmap; Relay dogfoods itself.
- **D4 — open-source relayd: YES**, open from the first public beta. Cloud,
  app, and provisioning stay proprietary.
- **Entity & billing — Indian entity.** Incorporate during M2 as a parallel
  ops track so rails are live before M3. Verify payment rails early: Stripe
  India onboarding for new accounts has been restrictive; fallbacks are
  Razorpay with international payments enabled, or a merchant-of-record
  contracted by the entity. Apple Developer org enrollment under the entity
  needs a D-U-N-S number — weeks of lead time; per the App Store decision
  below it is deferred to around public launch. Export-of-services
  compliance (GST, FIRC/SOFTEX) goes on the M2 ops checklist.
- **D1 — name: Relay.** Brand confirmed; the trademark / App Store collision
  check stays as an M4 launch gate ("Relay Agents" is the fallback form).
- **D5 — managed provider: AWS ap-south-1.** Owner already operates there and
  `ops/provision-ec2.sh` heritage carries over. Graviton burstable instances
  fit the bursty agent workload; egress caps matter more than they would on
  Hetzner. Realistic managed-tier floor on AWS is ~$15/mo. Hetzner stays on
  the books as a later cost-optimization adapter, not a launch dependency.
- **Pace — full-time.** The 4–5 month roadmap stands as written.
- **App Store — personal developer account for now.** TestFlight and initial
  release ship from the existing personal team; enroll the entity org and
  transfer the app around public launch or after.
- **Control plane — self-hosted on one EC2 in ap-south-1** (not a PaaS).
  Postgres colocated to start, RDS when revenue justifies it. Solo-ops
  tradeoff accepted: backups, monitoring, and patching are ours — keep the
  deploy boring (systemd/compose + IaC) and remember the box is low-value by
  design (ciphertext relay + metadata, no content).
- **Design partners (M2):** Rohan, Vishal, Tanish, Minal, Shlok — five
  committed 2026-08-09. The M2 gate measures their week-over-week retention.

| # | Decision | Recommendation |
|---|---|---|
| D1 | Product name / trademark / App Store availability | **Resolved: Relay.** Collision check stays an M4 launch gate; "Relay Agents" is the fallback |
| D2 | relayd language | Node for M1 alpha; Go port against the frozen contract before public beta |
| D3 | Tunnel: build vs embed | Spike a minimal Go SNI-passthrough broker in M0; embed an OSS tunnel core only if the spike overruns |
| D4 | Open-source relayd | **Resolved: yes** — open from first public beta; cloud and app stay proprietary |
| D5 | Managed provider | **Resolved: AWS ap-south-1** for launch; Hetzner adapter later as cost optimization |
| D6 | Pricing | Free / Pro ~$12 / VM $10–25; treat as hypothesis until M3 |
| D7 | Personal install migration | Personal box enrolls as node #1 in M1; personal-only features (POC Library, manifest) stay on the personal app target |
| D8 | Android / web client | Not v1; iPhone-native depth is the differentiator. Revisit post-launch |
| D9 | OpenClaw-class harness adapter | Post-launch, community-first once relayd is open source; managed images may preload it earlier as a distribution wedge |
| D10 | Subscription connect default | Device-code login on the node for v1; `relay sync-auth` laptop mirror as the CLI fast-follow (opt-in, E2E only, never via cloud) |

---

## 10. Risks

1. **First-party gravity.** Vendor mobile surfaces improve monthly. Counter:
   live only in the quadrant they won't enter (multi-harness × your-infra ×
   zero-knowledge); ship approvals/Live Activities depth they don't
   prioritize.
2. **Harness CLI drift.** Already lived through the Cursor contract risk.
   Counter: adapter seam, pinned versions, smoke-test honesty (a broken
   provider disappears instead of breaking), open-source adapter community.
3. **Provider ToS on subscription use.** It's the user's own login on their
   own machine — the architecture keeps Relay out of the credential path
   entirely, which is also the ToS-defensible position. Monitor policy;
   BYO-API-key mode is the fallback lever.
4. **Broker reliability on mobile networks.** SSE dies in backgrounds; the
   app's existing poll-reconcile pattern already handles this. Add heartbeats
   and resumable streams in Node API v1.
5. **Managed-VM abuse.** Payment-method gate, egress presets, AUP,
   provisioning rate limits (§5). This is the surface that can hurt the
   company; treat controls as launch-blocking, not fast-follow.
6. **Security regression while generalizing.** Carry the invariants file
   into the product SECURITY.md and CI-check the load-bearing ones (jail
   containment, denylist, no-credentials-in-responses). The broker is the new
   pen-test surface; ciphertext-only design bounds the blast radius.
7. **Solo capacity.** Tiny control plane, managed hosting, open-source
   leverage, and hard milestone gates. Cut anything that isn't F1–F5.

---

## 11. Invariant continuity table

Every hard invariant from the personal install, and its product fate:

| Personal invariant | Product fate |
|---|---|
| mTLS is the only auth; no bearer tokens | **Preserved for the data path.** Cloud session authorizes rendezvous/billing only — never file access or job submission |
| (new, forced by audit) The cloud cannot obtain data-path access | **Enforced, not assumed.** Pairing blobs carry a peer-verified HMAC derived from a secret the cloud never sees, so the cloud can neither mint a cert nor induce the node to mint one (§4.3) |
| Exactly `CN=iphone` + `CN=parikshit-mac` | Generalized: per-node CA, enrolled-device certs, revocation lists. Note the allowlist format had to change: an RFC 2253 DN contains commas, so comma-separated config could never express a multi-RDN subject |
| No Tailscale ever | Preserved — in-house broker, no overlay dependency; direct mode works over anything |
| `/srv/codex-workspaces` jail + realpath containment | Preserved verbatim in relayd |
| Provider credentials never reach the phone / never in JSON, logs, argv | Preserved verbatim; now a headline feature |
| Catalog honesty (advertise only smoke-tested providers) | Preserved and extended with capability flags |
| `CODEX_MAX_CONCURRENT=1` until evidence | Generalized: size-based defaults, evidence-based raises, per-workspace mutex |
| docs/ genericized hostnames | Preserved (this document included) |
| Branding "Relay", bundle ids unchanged | Personal app untouched; product ships as a **new** target/bundle id pending D1 |
| Interactive scroll / outside-tap / Send-Run keyboard dismissal; no custom accessory | Preserved — still in the product UI contract |
