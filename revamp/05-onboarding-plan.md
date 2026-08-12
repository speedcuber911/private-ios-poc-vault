# Relay Onboarding Plan — First Run, Walkthrough, and Node Enrollment

> Status: proposal, 2026-08-09. Companion to
> [04-product-plan.md](04-product-plan.md) (flows F1/F2, app work item A3).
> All domains and identifiers are genericized. Screens are specs, not final
> visual design.

Onboarding is the highest-risk surface of the whole product: a BYO-first app
opens onto an empty aquarium — no node, nothing to browse, nothing to run.
This plan turns the first ten minutes into a funnel with no dead ends: every
user either connects a machine, joins the managed-VM waitlist, or plays with a
demo. Nobody hits a blank screen.

---

## 1. Principles

1. **Show the product before asking for anything.** Walkthrough first, account
   only when it's needed, permissions only in context.
2. **Three screens, one idea each, always skippable.** Our audience is
   engineers; they skim. Every walkthrough screen is a real UI visual plus one
   sentence, not marketing prose.
3. **No dead ends.** "I don't have a VM" resolves to the waitlist or the demo,
   never to a wall.
4. **The empty state is the tutorial.** A freshly enrolled node seeds a
   `welcome` workspace whose README teaches the model in-place; suggested
   first prompts replace a tutorial overlay.
5. **The first push notification is the product demo.** Onboarding is not
   done when a node connects — it's done when the user has locked their phone
   and felt a completed-task push arrive.
6. **Resumable at every step.** Install, pairing, subscription connect, and
   first task can each happen hours apart; the app holds state and shows one
   "Finish setting up" card, never a nag.

---

## 2. Flow map

```text
App launch (first run)
  ├─ W1  What it is        (skippable ────────────┐)
  ├─ W2  Fire & forget                            │
  ├─ W3  Private by design                        │
  └─ FORK  "Where will your agents run?" ◀────────┘
       ├─ [A] Connect your machine  ── Sign in ──▶ BYO flow (§4)
       ├─ [B] Create a machine      ── Sign in ──▶ v1: waitlist (§6.1)
       │                                           post-M3: provisioning (§6.2)
       └─ [C] Explore the demo      ── no sign-in ▶ demo mode (§5)

BYO flow: install command ▶ pairing ▶ name machine ▶ harness connect ▶
          first task + notification priming ▶ DONE (push received)
```

The fork screen is also the permanent "+ Add machine" screen after first run.

---

## 3. Walkthrough (W1–W3) and the fork

### W1 — What it is

Visual: the real file browser + a folder conversation, in a device frame.

> **All your coding agents. One app. Your machine.**
> Codex, Claude Code, and Cursor run on your own server, under your own
> subscriptions. Browse the workspace like Files; every folder is a
> conversation.

### W2 — Fire and forget

Visual: lock screen with a Live Activity ("Refactoring auth · 12 min") and a
completed-task push banner.

> **Start long tasks. Walk away.**
> Relay pings you the moment an agent finishes, fails, or needs your
> approval. Approve risky steps right from the lock screen.

### W3 — Private by design

Visual: simple phone→node diagram with the cloud drawn as an opaque pipe.

> **We can't read your code. By architecture.**
> End-to-end encryption from your phone to your machine. Your keys and
> subscriptions never leave your server. The agent daemon is open source.

Chrome: progress dots, `Skip` top-right on all three, final CTA `Get started`.
No sign-in yet. (Post-launch A/B candidate: collapse W1–W3 into compact value
rows on the fork screen for returning-intent users.)

### FORK — "Where will your agents run?"

```text
┌──────────────────────────────────────────┐
│  Where will your agents run?             │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ ▸ Connect your machine     ~5 min  │  │   primary card
│  │   Any Linux server or VM.          │  │
│  │   One command, outbound-only.      │  │
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ ▸ Create a machine for me          │  │   v1: badge "Coming soon"
│  │   We provision a ready agent box.  │  │   → waitlist (§6.1)
│  │   From $15/mo.                     │  │   post-M3: live (§6.2)
│  └────────────────────────────────────┘  │
│  ┌────────────────────────────────────┐  │
│  │ ▸ Explore the demo        instant  │  │   no account needed
│  └────────────────────────────────────┘  │
└──────────────────────────────────────────┘
```

- Cards A and B present a **Sign in with Apple** sheet first (email magic link
  as secondary). Card C never requires sign-in — lowest-friction taste of the
  product.
- The managed card is **present from day one even though it ships in M3**:
  it teaches the roadmap, and its waitlist count is the demand evidence the
  M2→M3 gate in 04-product-plan.md asks for.
- Account timing rationale: the broker, push routing, and entitlements need
  an account, but demo browsing doesn't — so auth is deferred to the moment
  it's structurally required, never earlier.

---

## 4. BYO flow (F1) — the critical path

### 4.1 Install screen

```text
┌──────────────────────────────────────────┐
│  Connect your machine                    │
│                                          │
│  Run this on your server:                │
│  ┌────────────────────────────────────┐  │
│  │ curl -fsSL https://get.<domain>/   │  │
│  │   relayd | sh              [Copy]  │  │
│  └────────────────────────────────────┘  │
│                                          │
│  Requires: Ubuntu 22+/Debian 12+,        │
│  x86/arm64, sudo, outbound 443 only.     │
│  No inbound ports. macOS coming soon.    │
│                                          │
│  Prefer to inspect first?                │
│  View the script · Source on GitHub ·    │
│  .deb download                           │
│                                          │
│  [ I ran it — continue ]                 │
└──────────────────────────────────────────┘
```

- Engineers side-eye `curl | sh`; the inspect/GitHub/.deb links are trust
  signals for exactly this audience, not clutter. Keep them.
- Secondary action: "Email me the command" for users at their phone but not
  their terminal.

### 4.2 Installer UX (server side — this is part of onboarding)

The script is short, readable, and idempotent. Human-readable progress:

```text
✔ Detected Ubuntu 24.04 (arm64)
✔ Installed relayd 1.0.3 + systemd unit
✔ Generated node identity and certificate authority
✔ Seeded workspace jail (/srv/relay-workspaces/welcome)
✔ Checked outbound connectivity (port 443) … connected to rendezvous
✔ Detected agent CLIs: claude ✓ (logged in) · codex ✓ (login needed) · cursor ✗

  Pair your phone (expires in 15 min):

  █▀▀▀▀▀█ ▀▄█ █▀▀▀▀▀█     Code:  WXYZ-1234
  █ ███ █ ▄▀▄ █ ███ █
  █ ▀▀▀ █ █▄  █ ▀▀▀ █     Or open on this phone:
  ▀▀▀▀▀▀▀ ▀ ▀ ▀▀▀▀▀▀▀     https://<domain>/pair#<token>

  Re-show anytime:  relayd pair
```

Load-bearing details:

- **Three pairing inputs from one printout:** QR (scan from a desktop
  terminal), short code (type it), and a **universal link** — because a real
  minority will run the installer over SSH *from the phone itself* (Termius/
  Blink) and cannot scan their own screen; they tap the printed link and the
  app opens with pairing prefilled. The token rides in the URL fragment so it
  never reaches server logs.
- The outbound-443 check runs *before* printing the QR, with a specific error
  for egress-blocked networks — the single most confusing failure otherwise.
- Unsupported distro fails fast with the supported list, not a stack trace.
- The seeded `welcome` workspace contains a README explaining the jail and
  suggesting first tasks — the file browser's first-open state is the
  tutorial (principle 4).
- Re-running the script is safe; `relayd pair` regenerates an expired code.
- **The printed code must be redeemable by the running daemon, not by the CLI
  process that printed it.** The first implementation minted the session in an
  in-memory map inside the `relayd pair` process, which then exited — so on a
  real systemd install the code was already dead by the time the user read it,
  and the daemon served no pairing endpoint at all. Caught the first time the
  installer was executed on a fresh VM. Sessions are persisted in the node's
  store and the daemon owns the pairing listener; the CLI only mints and
  prints. Any change here needs a test that redeems a CLI-minted code against a
  *separate* daemon process.
- **The installer must not report success when pairing could not be printed.**
  It exited 0 while the pairing step crashed, and the recovery command it
  suggested was itself broken. "Installed but not paired" is a distinct outcome
  and must read as one — this is the step where a new user is most likely to
  give up.

### 4.3 Pairing screen (app)

- Opens the camera scanner (permission requested only now, with a pre-line
  "Relay uses the camera to scan your server's pairing code") with a
  persistent **"Enter code instead"** field — first-class, not a fallback
  buried in a menu.
- Under the hood (per 04-product-plan §4.3): the app mints a Secure Enclave
  P-256 key, sends the CSR through the broker E2E using the pairing secret,
  the node's own CA issues the device cert, the app pins that node's CA.
  The user sees none of this — just a progress spinner resolving to:

> **Connected to `my-hetzner-box`** ✓
> Name this machine: [ my-hetzner-box ] (prefilled with hostname) → Continue

- Failure states: expired code ("Run `relayd pair` on your server for a fresh
  code"), clock skew, broker unreachable — each with one specific sentence
  and one action, never a generic error.
- One failure state is **not** a user error and must never be worded as one:
  if the node reports that the relayed CSR failed its integrity check
  (04-product-plan §4.3, pairing v2), something tampered with the exchange.
  Say so plainly — "Pairing was interrupted and could not be verified. No
  access was granted. Try again on a trusted network." — and do not offer a
  retry that silently reuses the same session.

### 4.4 Harness connect (subscription checklist)

The installer already probed CLI/auth state, so this screen opens truthful:

```text
┌──────────────────────────────────────────┐
│  Connect your agents                     │
│  Agents run under YOUR subscriptions,    │
│  on your machine. Relay never sees them. │
│                                          │
│  ● Claude Code          Ready ✓          │
│  ◐ Codex        [Sign in] login needed   │
│  ○ Cursor Agent [Install]  not installed │
│                                          │
│  [ Continue with 1 agent ]     Skip      │
└──────────────────────────────────────────┘
```

- **Sign in** runs the CLI's device-code flow proxied to the phone: relayd
  starts the CLI login headlessly, forwards the verification URL/code, the
  app shows "Open this link, then come back", relayd confirms with a smoke
  test, row turns Ready. Credentials never transit Relay — worth literally
  saying on-screen; it's the differentiator at the exact moment of maximum
  user suspicion.
- **Install** triggers the harness manager, then flows into Sign in.
- Fast-follow, once the `relay` desktop CLI exists (04-product-plan §4.6): an
  "Already signed in on your laptop?" row — `relay sync-auth` mirrors
  existing CLI logins to the node over the E2E channel, opt-in, never via the
  cloud. Collapses this screen's biggest friction for multi-provider users.
- Rows reflect the catalog-honesty rule: a harness shows Ready only after its
  smoke test passes.
- All-skipped is allowed but lands on an empty-state card ("Connect at least
  one agent to run tasks") — resumable, principle 6.
- Zero-subscription users (off-persona but they'll arrive): each row links to
  the provider's plan page. No fake "free tier" pretense.

### 4.5 First task + notification priming (the aha)

Land in the file browser at the `welcome` workspace with one card:

```text
┌──────────────────────────────────────────┐
│  Run your first task                     │
│  ▸ "Clone <a repo I name> and give me    │
│     a tour of the codebase"              │
│  ▸ "Create a small demo site in this     │
│     folder and describe it"              │
│  ▸ Write my own…                         │
└──────────────────────────────────────────┘
```

- Suggestions adapt to which harness is Ready and are phrased to produce
  browsable output (files appear in the browser → reinforces the files-first
  model).
- On first **Run**, pre-prompt then request notification permission:
  > "Want a ping when it finishes? Tasks keep running with the app closed."
  This is the highest-conversion moment to ask — value is one tap away and
  self-evident. If denied: small in-app banner explains foreground-only
  status and links to Settings; the app still works via polling.
- After the task starts, one gentle line: **"You can close the app now."**
  The completed-task push — arriving on a locked phone — is the walkthrough's
  W2 promise kept, and the true end of onboarding.
- Instrument this as the funnel's finish line: `first_task_push_received`.

---

## 5. Demo mode (no account, no VM, instant)

v1 implementation: **simulated, fully client-side.** A bundled sample
workspace (small real repo snapshot) browsable in the actual file browser,
plus 2–3 recorded task transcripts that replay through the real streaming UI
with live pacing — it *feels* like a running agent. A persistent banner:
"Demo — connect your own machine to run real tasks" links to the fork.

- Why simulated over a live shared sandbox: zero abuse surface, zero cost,
  works offline, nothing to moderate, and App Review always sees a working
  flow. A live single-user ephemeral sandbox (provisioner-minted, 30-min TTL)
  is the M3+ upgrade once provisioning exists — it also becomes the reviewer
  demo environment.
- Demo mode is reachable pre-auth forever (not just first run) — it's the
  shareable "kick the tires" surface.

---

## 6. Managed machines on the fork

### 6.1 v1 (M1–M2): waitlist

Tapping "Create a machine for me" → sign-in → one screen: what you'll get
(ready agent box, zero setup, from ~$15/mo), one tap **Join the waitlist**
(account email captured), optional region chip (EU/US/APAC — feeds region
planning). Confirmation sets expectation honestly: "We'll notify you when
it's ready. Meanwhile, the demo works now and any Linux VM connects in ~5
minutes." — funneling back to A and C, never dead-ending.

Launch mechanics: when M3 ships, waitlist members get the "Your machine is
ready to create" push — a built-in reactivation campaign.

### 6.2 Post-M3: live provisioning (F2)

1. **Size:** plain-language tiers, not vCPU trivia — "Starter · runs 1 agent
   at a time · $15/mo", "Pro · 2–3 agents in parallel · $25/mo".
2. **Region**, **name** (prefilled).
3. **Billing:** handled on the web dashboard (Stripe) per 04-product-plan §6;
   the app opens the checkout link and resumes on return. If entitlement
   already exists, this step is invisible.
4. **Provisioning progress:** live states (Creating → Booting → Enrolling →
   Ready), target <90 s. Managed nodes **skip the QR ceremony** — the
   provisioning token binds the node to the account, and the device-cert
   issuance runs the same CSR ceremony silently on first connect.
5. Land on the same harness-connect checklist (§4.4) — the flows converge,
   so everything downstream is built once.

---

## 7. Second device, re-pairing, multi-node

- **New phone, existing account:** nodes list appears from the registry, but
  each node still requires a device cert from *that node's* CA (the
  zero-knowledge model has no cloud shortcut — by design). Two paths:
  1. **Approve from an enrolled device** — the old phone gets an actionable
     push: "New iPhone wants access to `my-hetzner-box` — Approve / Deny."
     Reuses the F4 approvals machinery. Primary path.
  2. **Re-run `relayd pair`** on the box. Fallback when the old device is
     gone.
- **Lost device:** revoke from any enrolled device (Settings → Machine →
  Devices) or `relayd devices revoke <name>` on the box.
- **Add machine:** the fork screen (§3) reappears via "+ Add machine"; all
  three options remain valid forever.
- Walkthrough is revisitable: Settings → "How Relay works".

---

## 8. Permissions strategy (iOS)

| Permission | When asked | Priming |
|---|---|---|
| Notifications | First task Run (§4.5) | One-line pre-prompt; value one tap away |
| Camera | Pairing scanner opened (§4.3) | One-line pre-prompt; manual entry always visible |
| Microphone / speech | First tap of the voice-prompt button, never earlier | On-device transcription — say so in the pre-prompt |
| Sign in with Apple | Fork cards A/B only | Demo never asks |

Never ask for anything on app launch. Every denial has a working degraded
path and a Settings deep link.

---

## 9. Edge cases and error states

| Case | Handling |
|---|---|
| Installer on unsupported OS | Fail fast, supported list, no stack trace |
| Egress-blocked VM (no 443 out) | Installer detects pre-QR; names the firewall problem specifically |
| Pairing code expired | App explains + `relayd pair` instruction inline |
| App killed mid-flow | Every step persists; "Finish setting up" card resumes at the right step |
| Install now, pair tomorrow | `relayd pair` re-shows; install screen's Continue is stateless |
| SSH-from-phone (can't scan own screen) | Universal link + manual code entry (§4.2) — first-class |
| Node offline during harness connect | Row states go stale-marked; checklist resumable |
| Notification permission denied | Foreground polling still works; non-blocking banner |
| All harnesses skipped | Browser works read-only; empty-state card to connect an agent |
| No agent subscription at all | Honest provider links; no fake trial |
| App Review | Demo mode is always reviewable; post-M3, a reviewer sandbox node |

---

## 10. Instrumentation and targets

Screen-level funnel events, content-free (no prompts, no paths, no code —
consistent with the zero-knowledge posture; the installer beacon is an
anonymous counter and is disclosed in the script header).

```text
walkthrough_viewed → fork_viewed → {byo_started | waitlist_joined | demo_opened}
→ install_command_copied → node_paired → harness_ready(n)
→ first_task_submitted → first_task_push_received   ← finish line
```

Targets (F1 total <10 min):

- Walkthrough + fork + sign-in: <60 s
- Install script runtime: <3 min
- Pairing: <30 s
- First harness Ready: <3 min
- Run → "close the app now": <1 min
- **Watch metric:** drop-off between `install_command_copied` and
  `node_paired` — that gap is the product's riskiest minutes and the first
  thing to iterate on with design partners.

---

## 11. Build sequencing (maps to 04-product-plan roadmap)

| Milestone | Onboarding deliverables |
|---|---|
| **M1** | Installer UX incl. QR/code/universal-link printout, seeded `welcome` workspace, pairing screens, name-machine, harness-connect checklist v0 (detect + device-code login) |
| **M2** | Walkthrough W1–W3, fork screen, Sign in with Apple, demo mode (simulated), waitlist, first-task card, notification priming + completion push, funnel instrumentation, second-device approve flow |
| **M3** | Live provisioning flow (§6.2), web-checkout handoff, waitlist launch push, ephemeral live sandbox (upgrade of demo + reviewer environment) |
| **M4** | Copy/visual polish pass on all of the above, localized screenshots for the store listing (the walkthrough visuals double as App Store screenshots) |

---

## 12. Open questions

1. Direct-mode-without-account (self-hoster trust signal) — expose in v1
   settings or keep for the personal/dev build only? Leaning: post-launch.
2. Demo content — which sample repo (needs to be small, legible, permissively
   licensed, and fun to "tour")?
3. Waitlist scope — collect intended VM size/budget, or keep to one tap +
   region? Leaning: one tap; every extra field costs signups.
4. Walkthrough A/B — three screens vs. compact value rows on the fork; decide
   with M2 funnel data, not taste.
5. macOS node support timing — the install screen promises "coming soon";
   that promise should have a date before App Store launch.
