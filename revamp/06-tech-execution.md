# Relay Tech Execution — Complete Work Breakdown to Launch

> Status: build backlog, 2026-08-09. Companion to
> [04-product-plan.md](04-product-plan.md) (architecture + milestones) and
> [05-onboarding-plan.md](05-onboarding-plan.md) (first-run UX). This is the
> engineering-task level: work packages W0–W10, dependency order, and the
> known-unknowns register. Domains genericized. Estimates assume full-time,
> agent-assisted, solo.

**Honesty header:** ~90% of this is extraction and packaging of code that is
already written and live-proven in this repo (the 6,642-line
`relay-server/codex-api-deploy/server.mjs`, the 21-file SwiftUI app, the ops
scripts). The remaining ~10% is genuinely new engineering, concentrated in
W1 (tunnel), the Secure Enclave identity path in W4, and the per-harness
approval contracts in W5 — each has a spike and a fallback (§ Unknowns).

---

## W0 — Node API v1 contract freeze (M0, ~3 days)

The existing HTTP+SSE surface becomes a versioned contract so the iOS app,
the Node relayd, and the later Go port all build against one spec.

- [ ] Write `API.md` documenting the current contract verbatim from
      `server.mjs`: `/healthz`, `/v1/codex/{health,ui,models,chat,skills,
      workspaces,workspace-dirs,fs/list,fs/file,workspaces/select,
      workspaces/create,sessions,threads,threads/:id,transcriptions,jobs
      (GET/POST),jobs/:id,jobs/:id/cancel,jobs/:id/stream,
      jobs/:id/artifacts/:name/(raw|preview)}` — request/response shapes,
      SSE event grammar, error taxonomy, pagination/truncation flags, auth
      expectations (forwarded-subject header in gateway mode).
- [ ] Specify v1 additions: resumable SSE (`Last-Event-ID`), `/v1/events?since=`
      feed, pairing endpoints, device list/revoke, harness-manager endpoints
      (detect/install/login/smoke), `needs_input` job state + respond
      endpoint, `/v1/meta` capability negotiation.
- [ ] Promote `server.test.mjs` (59 tests) into an implementation-agnostic
      conformance suite (hits a base URL; fake harness binaries stay).

## W1 — Tunnel spike → broker (M0 spike, M2 hardening)

The only novel systems piece. Goal: phone → broker → relayd with end-to-end
mTLS and an unbuffered SSE stream.

- [ ] Broker (Go, ~1–2k LOC): TLS-passthrough front — accept :443, parse the
      ClientHello for SNI `<node-id>.tun.<domain>`, pipe raw bytes into that
      node's tunnel stream. No TLS termination for data traffic.
- [ ] Reverse tunnel: relayd dials out `wss://broker/tunnel`, authenticates
      by signing a challenge with the node key; multiplex streams (yamux or
      HTTP/2 streams — spike decides), heartbeats, reconnect with backoff.
- [ ] relayd tunnel client (Node) presenting its TLS server context
      (node-CA-issued cert, client cert required) on tunneled streams.
- [ ] Wildcard DNS `*.tun.<domain>` → broker; Let's Encrypt only for the
      broker's own WS endpoint (data path needs no public certs — the app
      pins node CAs).
- [ ] Measure: SSE latency/buffering through the full path, stream survival
      across mobile network transitions, idle-timeout semantics.
- **Exit gate:** fresh VM behind NAT, phone on LTE, live job SSE streaming
  end-to-end with client-cert auth. **Fallback if the spike overruns 1
  week:** embed rathole/frp/chisel as the tunnel core, keep the SNI front.

## W2 — relayd extraction (M1, ~2.5 weeks)

New repo (public at M4). Split `server.mjs` into modules with **zero contract
change** (W0 suite must pass before/after):

- [ ] `config` — TOML config + one-shot migration from `/etc/codex-api.env`
      (absorbs `ops/render-codex-api-config`).
- [ ] `jobs` — job engine: spawn, timeout, cancel, persistence, queue with
      visible position, **per-workspace mutex**.
- [ ] `adapters/{codex,claude,cursor}` — provider invocation/parsing seams,
      capability flags (`supportsApprovals/Resume/Chat`).
- [ ] `fsapi` — list/file with realpath containment, secret denylist, byte
      caps, no-store (port the existing security tests intact).
- [ ] `threads`, `chat`, `artifacts`, `catalog`(+smoke), `audit` — extract.
- [ ] `store` — SQLite (better-sqlite3): `jobs, threads, chats, events,
      devices, revocations`; migration from the JSON jobs dir; logs and
      artifacts stay on disk.
- [ ] `identity` — node keypair + node CA generation, device-cert issuance,
      revocation list, TLS server context (absorbs
      `ops/{generate-client-certs,issue-server-cert,revoke-client-cert}.sh`).
- [ ] `pairing` — pairing codes (15-min TTL), CSR⇄cert exchange over the
      rendezvous channel.
- [ ] `events` — bus emitting `job.state`, `job.needs_input`, `job.silence`,
      `node.health` → local SSE subscribers + signed minimal posts to cloud.
- [ ] `worktree` — **handoff v0**: `git worktree add` on `relay/<task>`,
      run job inside, push on success when a remote is configured, prune
      policy.
- [ ] `harness` — CLI detect/versions, install, device-code login
      orchestration (spawn CLI login, capture verification URL/code, expose
      via API, confirm, smoke-test), catalog assembly.
- [ ] `server` — thin router; **two listen modes**: direct (today's
      Caddy/forwarded-subject mode — personal install unchanged) and
      tunneled (native TLS, client cert required).
- [ ] CLI entrypoints: `relayd run|pair|doctor|status|devices list/revoke`
      (`doctor` absorbs `ops/verify-server.sh` logic).
- [ ] Installer `install.sh`: distro/arch detect, runtime install (bundled
      Node tarball or bun-compiled single file — checkpoint decision),
      systemd unit, runner user + jail, seeded `welcome` workspace, outbound
      check, QR/code/universal-link printout (per 05 §4.2).
- [ ] Enroll the personal box as node #1 (direct mode) — dogfood begins.

## W3 — Control plane (M2, ~2.5 weeks)

One EC2 in ap-south-1, colocated Postgres, systemd/compose, IaC
(Terraform/CDK: VPC/SG, EC2, Route53, S3 backup bucket, SSM secrets).

- [ ] Auth: Sign in with Apple (server-side identity-token verification),
      email magic link (SES), short-lived session JWT + refresh.
- [ ] Registry: `accounts, devices (APNs token, platform, cert serials),
      nodes (kind, pubkey, last_seen, version), entitlements, waitlist`.
- [ ] Broker from W1 productionized: registry-backed route table,
      node-connect auth, metrics, connection draining on deploy.
- [ ] Pairing rendezvous: short-lived sessions relaying opaque CSR/cert
      blobs (cloud never parses them).
- [ ] Notify: ingest signed node events `{node, job, state, ts}` (no
      content), fan out via APNs HTTP/2 token auth — silent, mutable, and
      Live Activity channels; 7-day retention purge.
- [ ] Domains + DNS: product domain, `api.`, `get.`, `*.tun.`, `www.`.
- [ ] Web v0: landing, docs, account page (login, node list, waitlist).
- [ ] Ops: S3 pg_dump nightly, external uptime checks, Sentry, structured
      logs.

## W4 — iOS product app (M1–M2, ~3 weeks alongside W2/W3)

New target + bundle id in the existing Xcode project; POCVault personal
target keeps compiling untouched (Library/manifest stay personal-only).

- [ ] `NodeStore`: multi-node model (name, tunnel host or direct URL, pinned
      CA, identity ref), Keychain-backed.
- [ ] Identity: Secure Enclave P-256 keygen, CSR construction
      (swift-certificates), pairing client (QR via VisionKit + manual code +
      universal link), cert → Keychain; extend `ClientIdentityStore` beyond
      p12 import; **per-node CA pinning** via custom server-trust evaluation
      in `CodexClient`. ← early prototype; see Unknowns U2.
- [ ] Multi-node plumbing: `CodexClient` per node, browser roots per node,
      cross-node inbox (poll first, SSE upgrade after).
- [ ] Onboarding screens per 05: walkthrough pager, fork, install screen,
      scanner, naming, harness checklist (drives W2 `harness` API),
      first-task card, permission priming.
- [ ] Push: registration + token upload; **NSE target** (shared Keychain
      access group, fetch detail over tunnel within the ~30 s budget,
      rewrite banner); actionable categories (Approve/Deny/Open); ActivityKit
      Live Activities with push-token updates.
- [ ] Sign in with Apple + session + entitlements read.
- [ ] On-device transcription (SpeechAnalyzer, SFSpeechRecognizer fallback)
      replacing the Azure route.
- [ ] Settings: nodes (rename/devices/revoke), account, about.
- [ ] Keep the 79 XCTests green; add NodeStore/pairing/pinning tests.

### W4 groundwork established 2026-08-09 (read before starting)

A structural survey of `ios/POCVault` plus the server work already landed
changes several assumptions above.

**The target split is genuinely cheap.** One project, two targets
(`POCVault` app, `POCVaultTests`), a 593-line hand-legible `project.pbxproj`,
no `.xcconfig`, no build-phase scripts, no third-party dependencies, and no
`static let shared` anywhere — dependencies are constructed once in
`POCVaultApp.init()` and injected. Adding a second target means adding the same
files to a second sources phase. Watch the three-way naming: target `POCVault`,
module `POCVault`, product/display name `Relay`, bundle id
`com.parikshit.pocvault`. The product target needs its own bundle id,
`PRODUCT_NAME`, and Info.plist, since the current one hardcodes four
`POCVault*URL` keys tied to single-node config.

**Server-trust pinning does not exist yet — it must be written, not wired up.**
`CodexClient` handles `NSURLAuthenticationMethodClientCertificate` but never
`NSURLAuthenticationMethodServerTrust`, so TLS server validation falls through
to system default handling against the public trust store (today's node uses a
Let's Encrypt cert, so it works). The product's per-node self-signed CA has no
public chain, so **every node connection will fail until custom trust
evaluation lands**. This is not a settings change; it is the load-bearing half
of U2 and belongs in the same week-1 prototype as the Secure Enclave key.

**Identity is a single slot in three places.** `ClientIdentityStore` caches one
`SecIdentity` behind one hardcoded `persistentRefKey`, and recovery only matches
a certificate whose CN is literally `"iphone"`. Three separate call sites
duplicate the client-cert challenge handler (`CodexClient`, `ManifestClient`,
and `AuthenticatedWebView`'s `WKWebView` coordinator). Multi-node needs one
identity *per node*, so fold those three into a shared delegate keyed by node
before adding the second and third.

**Two findings from the live server work that change client design:**

- **Hold a warm connection per node.** A cold request through the tunnel costs
  ~400 ms (TCP + full mTLS handshake); a reused one costs ~130 ms, about one
  round trip. Letting `URLSession` idle out between screens makes the app feel
  three times slower than it is.
- **Match the subject encoding exactly.** The node allowlists a device by the
  RFC 2253 form of its certificate subject (`O=Relay,OU=Devices,CN=device`).
  A CSR whose subject renders differently authenticates against nothing — this
  already cost one silent 403 on the server side.

**Pairing v2 constrains the UI.** The MAC key derives from the 32-character
token, so QR and universal-link entry work but the "type the short code
instead" path in 05-onboarding §4.3 **cannot** produce a valid blob tag — eight
characters is nowhere near enough entropy for a MAC key. Either lengthen the
typed code or drop it as a first-class option; do not ship a code field that
silently cannot pair. Decide this before building the scanner screen.

## W5 — Approvals (spikes early, implement M4, ~1.5 weeks)

- [ ] Spike per harness: Claude Code permission-prompt/hook seam; Codex
      approval-mode event stream; Cursor (likely `supportsApprovals: false`
      v1). Each spike = fake-free live run producing a `needs_input` event
      and a successful programmatic respond.
- [ ] relayd: `needs_input` job state + respond endpoint + event emission.
- [ ] App: blocked-job UI, actionable push wired to respond, timeout policy
      (unanswered approval → job pauses, not dies).

## W6 — Managed VMs (M3, ~2 weeks)

- [ ] AMI (Packer): Ubuntu 24.04 arm64 + relayd + harness CLIs + hardening;
      user-data enroll token → auto-enroll to purchasing account.
- [ ] Provisioner: RunInstances (t4g class), egress-only SG, no inbound at
      all (tunnel-out only); state machine creating→booting→enrolling→ready;
      stop/start from app; EBS quota; per-account limits.
- [ ] Abuse controls (launch-blocking): payment-method gate, egress firewall
      presets in relayd config, sustained-CPU pattern alarm, provisioning
      rate limits, AUP enforcement path.
- [ ] Idle lifecycle: relayd idle report → cloud stop after N hrs → app
      "wake" button.
- [ ] Reviewer/demo sandbox: same path, auto-expiring TTL.

## W7 — Billing (M3, ~1 week + rails verification earlier)

- [ ] **Rails verification (do in M2):** real signup attempts — Stripe India
      vs Razorpay international vs MoR under the Indian entity. Outcome
      picks the integration.
- [ ] Web checkout + webhooks → entitlements; dunning; invoices; GST/export
      compliance hooks. App reads entitlements; no IAP v1.

## W8 — Open-source release of relayd (M4, ~4 days)

- [ ] Fresh public repo (no history scrub risk), license decision
      (Apache-2.0 default), SECURITY.md carrying the invariants, adapter
      interface docs, CI running the W0 conformance suite, versioned
      release artifacts consumed by `install.sh`.

## W9 — Go port of relayd (pre-public-beta checkpoint, ~2–3 weeks if taken)

- [ ] Checkpoint after M1: if bun-compiled single-binary distribution proves
      clean, defer the port; otherwise port module-by-module against the W0
      conformance suite, ship static linux amd64/arm64 (+darwin) binaries.

## W10 — Launch (M4, ~1 week of eng-adjacent work)

- [ ] App Store: privacy policy, ToS/AUP, standard-TLS encryption-export
      declaration, review notes + sandbox node, screenshots (walkthrough
      assets double up), TestFlight → release from the personal team.
- [ ] Trademark/App Store collision check for "Relay" (gate, fallback name
      form ready).
- [ ] Landing + docs + install domain live; launch post; design-partner
      quotes.

---

## Dependency order

```text
W0 ──▶ W2 ──▶ W4(identity/pairing/nodes) ──▶ dogfood on node #1
W1 spike ──▶ W3(broker/notify) ──▶ W4(push/NSE/LiveActivity) ──▶ M2 beta
W5 spikes (anytime) ──▶ W5 impl (M4)
W3 ──▶ W6, W7 (M3)          W2 stable ──▶ W9 checkpoint ──▶ W8 (M4) ──▶ W10
```

Critical path: **W0 → W1 → W2 → W3 → W4-push → beta.** Everything else
parallelizes around it.

## Testing matrix (continuous)

- W0 conformance suite on every relayd change (Node now, Go later).
- Security tests ported intact: jail containment, denylist, no-credentials-
  in-responses — CI-blocking (invariant table, 04 §11).
- Tunnel integration test: docker-compose broker+relayd+client sim.
- iOS: existing 79 XCTests + new pairing/pinning/NodeStore tests.
- Weekly E2E: fresh VM → install → pair → task → push, timed against the
  <10-min F1 target.

## Known-unknowns register (the honest 10%)

| # | Unknown | Resolved by | Fallback |
|---|---|---|---|
| U1 | Tunnel mux + SSE behavior through passthrough | W1 spike (M0) | Embed rathole/frp/chisel core |
| U2 | Secure Enclave key as mTLS client identity in URLSession **and inside the NSE** (shared access group, 30 s budget) | W4 prototype in M1, first week | Keychain-software key (still device-bound enough for v1) |
| U3 | Per-harness approval contracts (Claude hooks / Codex approval events / Cursor) | W5 spikes | Capability flag off per harness; approvals ship harness-by-harness |
| U4 | Live Activity push-token update limits/frequency | W4 push work | Foreground-refresh-only Live Activity |
| U5 | `cursor-agent` CLI drift (known risk from revamp) | Pinned version + smoke honesty | Provider hidden until adapter updated |
| U6 | Stripe India availability for the new entity | W7 rails verification in M2 | Razorpay international / MoR |
| U7 | Node runtime distribution acceptability vs Go port | W9 checkpoint after M1 | Port (planned anyway per D2) |
| U8 | App Store review outcome for remote-agent app | W10 submission | Precedent strong (SSH clients, Happy); reviewer sandbox + appeal path |

None of these threaten the architecture; each degrades to a shippable
fallback.

**U1 is resolved (2026-08-09).** The broker was deployed to a real EC2 host and
exercised over the public internet with the node behind NAT on a laptop, ~87 ms
from the region. mTLS terminated on the node through the passthrough; SSE stayed
genuinely incremental (15 events spread across the full 2.76 s span, 49–87 ms
delivery each — nothing buffers); five concurrent streams multiplexed over one
tunnel; an idle tunnel survived a full 60 minutes on 15-second heartbeats with
zero reconnects. No fallback (rathole/frp/chisel) is needed.

Two numbers from that run change design decisions rather than merely confirming
them. **Connection reuse is worth ~270 ms per request** — a cold request pays
TCP plus a full mTLS handshake through the tunnel (~400 ms) while a reused one
costs ~130 ms, essentially one round trip — so the iOS client must hold a warm
connection per node instead of letting it idle out. And **a broker restart
killed the node outright** (`mux: read: EOF`, process exit, never came back),
which promotes node-side reconnect with backoff from a "production delta" to a
launch blocker: without it, any broker deploy silently takes every user offline.

## Verified against reality (running log)

Findings that only appeared once code met real infrastructure. Kept here
because each one contradicts something a plan or a comment asserted.

| What was assumed | What execution showed |
|---|---|
| The cloud cannot mint access to a node | It could *induce* the node's CA to mint one, by swapping the CSR in the unauthenticated relay. Fixed by peer-verified HMAC binding (04-product-plan §4.3) |
| `install.sh` works on a fresh VM | First-ever execution: pairing step crashed on an env-quoting bug, exited 0 anyway, and printed a recovery command that also failed |
| The printed pairing code pairs the phone | The session lived in the CLI process's memory and died when it exited; the daemon served no pairing endpoint at all |
| Job notifications reach the phone | `apns-collapse-id` was 73 bytes for UUID ids against Apple's 64-byte cap — every job push would be rejected, and rejections were counted as successes |
| The cert allowlist accepts device subjects | It splits on commas, and RFC 2253 DNs contain commas; any multi-RDN subject was permanently un-allowlistable |
| The test suite is green | It is — except conformance test 57, which fails under CPU saturation because a `sleep 3` harness lets the job end and free a stream slot before the cap is asserted |
| A device that pairs successfully can then connect | It could not. Pairing auto-allowlisted the subject in OpenSSL's *display* form (`CN = a, OU = b`) while every real caller presents RFC 2253 (`O=b,CN=a`), so every freshly paired device got 403 on its first request. Unit tests passed because each compared within one encoding; only a fresh-VM install → pair → authenticate run exposed it |
| A pairing code is single-use | Not with the default JSON store. The claim was `fs.unlinkSync`, with a comment asserting "the loser gets ENOENT" — but on darwin/APFS two processes racing `unlink` on one path **both** succeed. Two daemons sharing a data dir turned one code into two device certificates. The in-process test could not see it; only racing real processes could |
| A second listener is harmless | It bound `CODEX_API_PORT + 1`, a port nobody allocated, so two relayd instances on adjacent ports could not coexist (crash loop under systemd), and it inherited `CODEX_API_HOST` — putting an unauthenticated, plain-HTTP, certificate-minting endpoint on every interface in the documented gateway deployment |

A pattern worth naming, because it recurred: **every one of these survived a green
test suite by being consistent on both sides of a boundary the tests never
crossed.** Display format versus wire format. One process versus two. Loopback
versus every interface. Unloaded versus saturated. When a property is only true
within a single process, a single encoding, or a single machine, the test that
proves it must cross that line — otherwise it proves the code agrees with
itself, which was never in doubt.

The last row is the strongest argument for the fresh-VM gate. Six of the eight
rows above were invisible to a green test suite, and three of them were found
by executing the installer rather than by reading it. Keep a disposable
Ubuntu container (an LXD snapshot restores in seconds) in the loop for every
change that touches install, pairing, or identity — those three are where
"works on my machine" and "works for a new user" diverge most.

## First three PRs (start tomorrow)

1. `API.md` + conformance-suite promotion (W0) — pure writing against
   existing code, de-risks everything.
2. Broker spike repo (W1) — Go SNI-passthrough + WS tunnel + relayd-side
   client patch; exit gate is the LTE-to-NAT'd-VM SSE demo.
3. `config` + `identity` modules (W2 start) — first extraction slice, with
   the conformance suite proving zero contract drift.
