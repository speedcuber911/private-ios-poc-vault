# Relay CLI + Session Handoff — Design

> Status: approved by owner 2026-08-11 (brainstorming session).
> Scope: trial-sandbox tier (e2b node) v0. Extends `revamp/04-product-plan.md`
> §4.6 (Relay CLI) and `revamp/07-trial-sandbox-plan.md`; supersedes neither.
> All hostnames genericized per repo convention.

## 1. What this is

A `relay` CLI for the laptop that turns a stopped local coding-agent session
into a continuing session on the user's e2b sandbox, visible and steerable
from the iOS app.

The core moment: the user stops a Claude Code (or Codex/Cursor) session,
runs `relay handoff`, closes the laptop. Seconds later their phone shows a
push; the Relay app's threads list has a new **handoff card** — harness,
title, repo + branch, WIP summary, transcript excerpt, source machine — with
one primary action, **Continue**, which resumes the *same* session natively
on the sandbox in a worktree on a separate branch, output streaming as a
normal job.

## 2. Decisions fixed during brainstorming

| Question | Decision |
|---|---|
| Laptop role | **Handoff source only.** No daemon, no laptop node. The CLI reads local session stores and publishes; execution happens on the sandbox. (Enrollment is not designed for later promotion to a laptop node — that would be a new feature.) |
| Handoff depth | **Native resume where possible.** Claude Code session JSONL and Codex rollout files are transferred and resumed with the harness's own resume mechanism. Cursor (no portable session file) falls back to a summary-primed fresh session. |
| CLI auth | **Browser login + auto-discovery.** Device-code flow against relay-cloud (same SIWA/magic-link accounts as the app); the cloud identifies the account's trial node. No mTLS device cert for the CLI in v0 (see §4). |
| Repo transport | **Push to GitHub, sandbox fetches.** The CLI only works inside a git repo with a github.com `origin`. |
| Flow | **Hardened C — GitHub-as-content-transport.** Session state rides the handoff branch as ciphertext sealed to the node's key; a content-free cloud ping makes pickup and the push notification instant. Chosen over direct-to-node (A) and cloud-orchestrated (B). |

## 3. Actors and trust

- **relay CLI** (laptop) — Node ≥ 20 ESM, zero external deps, lives at
  `product/cli/`, shares crypto/derivation helpers with relayd. Distributed
  as an npm package exposing the `relay` bin (curl installer later).
- **GitHub** — the only heavy content transport. Only ever holds ciphertext
  (plus the user's own repo content, which is theirs already).
- **relay-cloud** — accounts, repo registrations, handoff pings (names
  only), rendezvous blob slots, APNs. Never sees transcript or credential
  plaintext.
- **e2b sandbox node** — relayd in trial mode. The only place besides the
  laptop where transcript plaintext exists.
- **iOS app** — renders handoff cards and the "On your Mac" session index;
  fires resume/new jobs on the sandbox.

Trust delta (unchanged from the trial tier's accepted posture): the cloud
attests the node's encryption public key to the CLI. The CLI pins the key
fingerprint per repo on first use. BYO-tier zero-knowledge CLI pairing is a
later feature, not v0.

## 4. CLI identity and commands

In Hardened C the CLI needs **no mTLS device cert**: content travels via
GitHub as ciphertext; the ping travels via the cloud session. The CLI needs
only the node's **X25519 encryption public key** to seal blobs. relayd's
enroll (v2 delta) generates an X25519 keypair alongside the ed25519
identity and publishes the public half; the registry stores and serves it.

Commands v0 (every command except `login` refuses to run unless cwd is
inside a git repo whose `origin` remote points at github.com, with a clear
message):

- `relay login` — browser device-code flow against relay-cloud. Session
  stored in `~/.relay/credentials.json` (0600). Discovers the account's
  sandbox via `GET /v1/trial-nodes/current`; fetches node public keys.
- `relay init` — per-repo: registers the repo with the cloud (account ↔
  repo full name, so handoff pings validate), pins the node encryption-key
  fingerprint into `.git/relay/` (local state, never committed), prints
  what handoff will do.
- `relay sync-auth` — §5.
- `relay handoff` — §6.
- `relay status` — this repo's handoffs and states, from content-free cloud
  events plus a `git fetch` peek at handoff branches.

## 5. sync-auth: GitHub + subscriptions to the sandbox

The sandbox needs the user's GitHub credential (fetch/push the repo) and
harness logins (run sessions on the user's own subscriptions — Relay never
proxies or remeters model access).

Transport: the **existing pairing-rendezvous rails** (`cloud/src/pairing.js`
— put-once opaque blob slots, 15-min TTL, destroyed after consumption),
with a new session kind so quotas/sweeps stay separate from pairing. The
CLI seals a credential bundle to the node's X25519 key and drops it in a
slot; the node collects it over its own channel. Credentials never ride
GitHub (un-revocable history) and never transit the cloud in cleartext.

Bundle contents v0:

- **GitHub:** token from `gh auth token` when available; otherwise the CLI
  walks the user through minting a **fine-grained PAT scoped to this repo**
  (contents: read/write) — the recommended path.
- **Claude Code:** `~/.claude/.credentials.json`. **Codex:** `~/.codex/auth.json`.
- **Cursor:** not portable (on-box CLI login). v0 reports honestly: "log in
  on the sandbox later."

On the node, each credential lands in the runner home, 0600, never in logs
or API responses — existing rules verbatim.

## 6. `relay handoff`

### Laptop side

1. **Find the session.** Scan local stores for sessions belonging to this
   repo's path: Claude Code `~/.claude/projects/<cwd-slug>/*.jsonl`; Codex
   `~/.codex/sessions` rollouts filtered by cwd; Cursor best-effort
   metadata only. Default: most recently active. `--session <id>` or an
   interactive picker (title + last message + age) overrides.
2. **Build the manifest.** Harness, session id, derived title/goal, repo +
   base branch, WIP summary (`git status` + diffstat), short transcript
   excerpt for the card, machine name, timestamp.
3. **Git.** Create `relay/handoff-<slug>` from HEAD; commit all WIP
   (tracked + untracked, `.gitignore` respected); add
   `.relay/handoff/<id>/manifest.enc` and `session.enc`, both sealed to the
   node's X25519 key; push to origin. Blobs exist **only on handoff
   branches** — the CLI hard-refuses if such a path would land on any other
   branch (new invariant). The branch is scratch; it dies after merge.
4. **Ping.** `POST /v1/handoffs` — `{repo, branch, handoffId, nodeId}`,
   names only. Print the handoff id; exit. Laptop may sleep.

### Sandbox side

relayd (trial mode) holds a **long-poll** against the cloud for pending
handoffs — a held connection, so pickup is effectively instant with no
cloud→node inbound path. On receipt:

fetch branch (synced GitHub credential) → worktree via existing
`worktree.mjs` → decrypt manifest + session with the node private key →
**stage for native resume**:

- *Claude Code:* place the JSONL under the runner's
  `~/.claude/projects/<workspace-slug>/`, rewriting cwd paths from the
  laptop path to the sandbox worktree path.
- *Codex:* place the rollout file where `codex resume` finds it.

Then create a **handoff thread** (new thread kind carrying the manifest)
and emit `handoff.ready` through the existing signed node-events → cloud
notify → APNs pipeline.

### Phone side

APNs payload is generic ("A session is ready to continue" + thread ref) —
no content in the push; details load from the node. The thread renders the
handoff card; **Continue** fires the harness's resume (`claude --resume
<id>`, `codex resume`, …) as a normal job in that worktree, streaming over
existing job SSE. Later messages continue the session; commits stay on the
handoff branch via the existing push-on-success behavior, so the laptop
catches up with `git fetch`.

### Fallback ladder

- No local session found → **repo-state-only handoff**: card still appears
  with the WIP summary; Continue starts a fresh session primed with the
  manifest.
- Cursor → always the summary-primed path in v0.
- Session file over ~20 MB cap → summary-primed path, stated on the card.

## 7. Sessions visibility ("On your Mac")

No daemon means no live feed. Instead, every relay command run also seals a
lightweight **session index** (metadata only — harness, title, repo,
last-active; no transcripts) to the node via the same rendezvous rails. The
app shows an "On your Mac" section for the repo: browsable cards with a
freshness timestamp. A card that hasn't been handed off shows its info plus
the honest affordances: start a new sandbox session in that repo's
workspace, or "run `relay handoff` on your Mac to continue this exact
session." New work fired from the phone always targets the sandbox.

## 8. Server changes

### relay-cloud (thin, following existing `cloud/src/server.js` patterns)

- `handoffs` table; `POST /v1/handoffs` (session-authed; validates repo
  registration and node ownership); `GET /v1/handoffs?repo=` (session-authed,
  states only — backs `relay status`); `GET /v1/node/handoffs?wait=`
  (node-authed via the same ed25519 request signing as node-events; held
  long-poll).
- `repos` table for `relay init` registrations.
- Registry stores + serves the node X25519 encryption pubkey (enroll v2).
- Notify event types `handoff.ready` / `handoff.failed`, classified like
  existing events, generic APNs payload.
- Rendezvous session kinds for sync-auth and session-index blobs (same
  put-once/TTL semantics; separate quotas and sweeps).

### relayd

- Trial-mode long-poll loop with backoff.
- `handoff` module: fetch → worktree → decrypt → stage → thread → event,
  built on `worktree.mjs`.
- Per-harness session-import adapters: Claude path-rewrite, Codex rollout
  placement, summary-prime fallback.
- `resume` job type on the existing jobs engine.
- Credential-bundle installer for sync-auth (runner home, 0600, never
  logged).
- Enroll v2: X25519 keypair generation + publication.

### iOS

- Handoff thread kind + card (harness badge, title, repo + branch,
  diffstat, excerpt, source machine, Continue) in the Editorial Ember
  language.
- Push handling for the new event types.
- "On your Mac" index section.

## 9. Security posture

- GitHub and the cloud only ever see **ciphertext or names** (repo, branch,
  event types). Transcript plaintext exists in exactly two places: the
  laptop and inside the sandbox.
- Existing invariants carry verbatim: workspace jail + realpath
  containment, secret denylist, isolated runner user, provider credentials
  in runner-home/root-protected locations only, no provider creds to the
  phone, provider honesty in the catalog.
- New invariant: **handoff blobs (`.relay/handoff/**`) are committed only
  on `relay/handoff-*` branches**; the CLI enforces this.
- Trust delta (trial tier only, documented): cloud attests the node
  encryption key; CLI pins per repo on first use.

## 10. Failure modes — every failure ends visible, never silent

| Failure | Outcome |
|---|---|
| Push rejected | CLI error, no ping sent |
| Sandbox fetch fails (missing/expired GitHub cred) | `handoff.failed(reason)` → push + `relay status` says "needs `relay sync-auth`" |
| Decrypt failure | Audit entry + `handoff.failed` |
| Long-poll gap / node offline | Handoffs are rows, not messages; node catches up on reconnect |
| Branch name collision | Numeric suffix |
| Duplicate ping | Idempotent on `handoffId` |

## 11. Testing

- **CLI:** unit tests with fixture session stores; integration against a
  `file://` bare repo (`RELAY_ALLOW_LOCAL_REMOTE` test override for the
  github.com check) and a local relayd.
- **relayd:** handoff-module tests with fixture ciphertext; path-rewrite
  golden tests; conformance additions.
- **cloud:** handoff route + long-poll tests alongside the trial suites.
- **E2E:** one scripted run — CLI → bare repo → local relayd → thread →
  resume with a fake harness.
- **iOS:** XCTests for card decode + view model; existing 79 stay green.

## 12. Non-goals (v0)

Laptop-as-node; Cursor native resume; BYO zero-knowledge CLI pairing;
`relay pull` / `relay send` from 04-plan §4.6 (unchanged, later); desktop
notifications; multi-node; editor integrations.
