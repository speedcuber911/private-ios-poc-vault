# Relay product/ — Completeness Status vs revamp/06-tech-execution.md (W0–W3)

> Audit date: 2026-08-11. Item-by-item comparison of `product/` against the
> W0–W3 checklists. Evidence paths are relative to `product/`. All hostnames
> genericized (`<domain>`, `<node-id>`). Test results below are from actual
> runs on this date (commands in §Test evidence).

Legend: **done** — implemented and tested; **partial** — exists but a named
piece of the checklist item is absent; **missing** — no implementation in
`product/` (docs may exist).

---

## W0 — Node API v1 contract freeze

| Item | Status | Evidence | Note |
|---|---|---|---|
| `API.md` documenting the current contract verbatim from `server.mjs` (all routes, SSE grammar, error taxonomy, pagination/truncation, forwarded-subject auth) | done | `relayd/API.md` Part 1 (§1.1–1.20) | Every listed endpoint covered incl. artifacts raw/preview, job SSE grammar, error taxonomy (§1.4), config knobs (§1.3), dev proxy mode (§1.20); line-number citations into the 6,642-line source; Part 3 records ambiguities found during the freeze |
| Specify v1 additions: resumable SSE, `/v1/events?since=`, pairing, device list/revoke, harness manager, `needs_input` + respond, `/v1/meta` | done | `relayd/API.md` Part 2 (§2.1–2.8) | All seven specified, plus §2.8 queue-position extension. Spec-only for `needs_input` (§2.6, impl is W5) and `/v1/meta` (§2.7, not yet implemented anywhere) |
| Promote `server.test.mjs` (59 tests) into an implementation-agnostic conformance suite (hits a base URL; fake harnesses stay) | partial | `relayd/test/conformance.test.mjs` (3,952 lines, the 59 tests) | Black-box over HTTP with fake harness binaries retained, and green against the extracted server. BUT it spawns the Node `src/index.mjs` entry itself — there is no `BASE_URL`-style parameterization, so a Go port or a remote node cannot run it unmodified yet |

## W1 — Tunnel spike → broker

| Item | Status | Evidence | Note |
|---|---|---|---|
| Broker (Go): TLS-passthrough front, SNI `<node-id>.tun.<domain>` parse, pipe raw bytes, no data-path TLS termination | done | `broker/cmd/broker`, `broker/internal/sni`, `broker/internal/broker` | Go stdlib only; multi-record ClientHello handled; unroutable SNI ⇒ connection closed; adversarial tests in `broker/verify/adversarial_test.go` |
| Reverse tunnel: relayd dials out, challenge-signature auth, multiplexed streams, heartbeats, reconnect with backoff | partial | `broker/internal/tunnelauth`, `broker/internal/mux`, `broker/cmd/fake-relayd` | ed25519 domain-separated challenge auth + custom SYN/DATA/FIN/RST/PING mux + heartbeats all work. Deviations (documented in `broker/README.md` §Production deltas): transport is plain TCP, not `wss://`; no reconnect/backoff; no per-stream flow control |
| relayd tunnel client (Node) presenting node TLS server context, client cert required | done | `relayd/src/tunnel.mjs`, `relayd/test/tunnel.test.mjs` | Speaks the exact broker protocol; terminates TLS on-node with `requestCert` + device-CA verify + revoked-serial hook; integration tests build and run the REAL Go broker (skip if Go toolchain absent — it was present in this run and they executed) |
| Wildcard DNS `*.tun.<domain>` → broker; LE only for broker WS endpoint | missing | docs only: `broker/README.md`, `cloud/README.md` §Deploy | Live DNS/infra intentionally out of scope this run |
| Measure: SSE latency/buffering, mobile-network transitions, idle-timeout semantics | partial | `broker/README.md` §Measured results, `broker/e2e/e2e_test.go` | Localhost measured with real numbers (SSE incrementality 15/15 events, ~2 ms pipe latency, no buffering; concurrent streams over one tunnel conn). LTE↔Wi-Fi transitions and idle-timeout semantics need a real phone + NATed VM — deferred to M2 hardening |
| **Exit gate**: fresh VM behind NAT, phone on LTE, live job SSE end-to-end with client-cert auth | partial | `broker/e2e/e2e_test.go` | Full-path localhost equivalent proven (mTLS + SSE through broker+mux). The physical LTE/NAT run has not happened. Fallback (rathole/frp/chisel) not needed so far |

## W2 — relayd extraction

| Item | Status | Evidence | Note |
|---|---|---|---|
| `config` — TOML config + one-shot migration from `/etc/codex-api.env` | partial | `relayd/src/config.mjs` | Env config extracted verbatim (behavior-preserving). TOML file support and the env-file migration (absorbing `ops/render-codex-api-config`) are NOT implemented |
| `jobs` — spawn, timeout, cancel, persistence, queue with visible position, **per-workspace mutex** | partial | `relayd/src/jobs.mjs` (1,330 lines) | Engine + FIFO queue + `queuePosition` in event payloads all present. Per-workspace mutex NOT implemented — serialization is still the global `CODEX_MAX_CONCURRENT` (default 1), matching legacy behavior |
| `adapters/{codex,claude,cursor}` with capability flags | done | `relayd/src/adapters/*.mjs`; flags in `relayd/src/harness.mjs` (`supportsApprovals/Resume/Chat`) | Flags live in harness.mjs rather than per-adapter files — cosmetic deviation |
| `fsapi` — realpath containment, secret denylist, byte caps, security tests intact | done | `relayd/src/fsapi.mjs`; ported tests in `relayd/test/conformance.test.mjs` | Jail containment / denylist / bounded-read tests ran green in this audit |
| `threads`, `chat`, `artifacts`, `catalog`(+smoke), `audit` | done | `relayd/src/{threads,chat,artifacts,catalog,audit}.mjs` | Extracted; conformance suite covers them |
| `store` — SQLite, 6 tables, migration from JSON jobs dir | done (deviation) | `relayd/src/store.mjs`, `relayd/test/store.test.mjs` | Uses built-in `node:sqlite` instead of `better-sqlite3` (zero-external-deps rule). All six tables (`jobs, threads, chats, events, devices, revocations`) + `migrateJsonToSqlite`. Default backend is still JSON; SQLite is opt-in via `RELAYD_STORE=sqlite` |
| `identity` — node keypair + CA, device-cert issuance, revocation list, TLS server context | done | `relayd/src/identity.mjs`, `relayd/test/identity.test.mjs` | Absorbs the ops cert scripts (openssl-driven); revocation refuses to strand the last device unless `--force` |
| `pairing` — codes (15-min TTL), CSR⇄cert exchange over rendezvous | partial | `relayd/src/pairing.mjs`, `relayd/test/pairing.test.mjs` | Single-use 15-min codes + CSR⇄cert over local `POST /v1/pair` on a dedicated listener (never the data listener). The CLOUD rendezvous transport (relayd pushing/pulling blobs via `cloud` pairing sessions) is not wired; daemon startup does not auto-start the pairing listener |
| `events` — bus emitting job/node events → local SSE + signed posts to cloud | partial | `relayd/src/events.mjs`, `relayd/test/events.test.mjs` | Bus + `GET /v1/events?since=` + `Last-Event-ID` + SQLite-persisted cursors done. Signed event POSTs to the cloud (`POST /v1/node-events` client side) NOT implemented — cloud-side ingest exists and is tested, nothing calls it |
| `worktree` — handoff v0: worktree add, run inside, push on success, prune | done | `relayd/src/worktree.mjs`, `relayd/test/worktree.test.mjs` | `relay/<task>` branch, never force-push, prune on cleanup keeping the branch; integration test runs a real job in a worktree |
| `harness` — CLI detect/versions, install, login orchestration, smoke, catalog | partial | `relayd/src/harness.mjs`, `relayd/test/harness.test.mjs`, routes in `relayd/src/additions.mjs` | detect/versions/login-as-operation (URL+code capture)/smoke done. The `install` action (`POST /v1/harness/:provider/install`, API.md §2.5) is specified but NOT implemented/routed |
| `server` — thin router; **two listen modes** (direct + tunneled) | partial | `relayd/src/server.mjs`, `relayd/src/index.mjs`, `relayd/src/tunnel.mjs` | Direct (Caddy/forwarded-subject) mode fully preserved. Tunneled mode exists as a tested library (`tunnel.mjs`: native TLS, client cert required, revocation hook) but is NOT wired into `relayd run`/`index.mjs` as a selectable listen mode |
| CLI: `relayd run|pair|doctor|status|devices list/revoke` | done | `relayd/bin/relayd` | All six subcommands; `doctor` absorbs verify-server-style checks (runtime, jail, identity, openssl, providers); never prints secret material |
| Installer `install.sh` | done (never live-run) | `relayd/dist/install.sh`, `relayd/dist/relayd.service`, `relayd/dist/relayd.config.example.json` | Arch detect, bundled Node 22 fallback, `relay` runner user + jail `/srv/relay-workspaces`, seeded `welcome` workspace, systemd unit, pairing-code printout. Runtime decision went bundled-Node (not bun single-file). Has not been executed on a fresh VM |
| Enroll the personal box as node #1 (direct mode) — dogfood begins | missing | — | Live deploy intentionally out of scope this run |

## W3 — Control plane

| Item | Status | Evidence | Note |
|---|---|---|---|
| Auth: Sign in with Apple (server-side token verify), email magic link (SES), session JWT + refresh | partial | `cloud/src/{auth,jwt}.js`, `cloud/test/auth.test.mjs` | SIWA JWKS/RS256 verify (iss/aud/exp), magic-link issue/confirm (hashed single-use tokens), HS256 session + rotating single-use refresh — all tested. SES/SMTP mail transport is an interface only; `main.js` drops mail silently |
| Registry: accounts, devices (APNs token, platform, cert serials), nodes (kind, pubkey, last_seen, version), entitlements, waitlist | done | `cloud/src/registry.js`, `cloud/test/registry.test.mjs` | Cross-account isolation tested; node create is entitlement-gated (`nodes.max`) and validates ed25519 pubkeys |
| Broker from W1 productionized: registry-backed routes, node-connect auth, metrics, connection draining | partial | cloud side: `GET /v1/tunnel/nodes/:nodeId` hook (`cloud/src/server.js`, README §Broker contract); broker side: `broker/internal/registry`, `-registry-url`/`-registry-token-file` in `broker/cmd/broker/main.go` | The registry hook now has a caller — `broker/internal/registry.Resolver` (60 s positive / 10 s negative TTL cache), wired in via `Broker.SetFallbackLookup`, opt-in with `-registry-url -registry-token-file`. Still no metrics, no connection draining, and the static `-node` flag map remains the broker's primary/default registry — dynamic lookup only fires on a miss |
| Pairing rendezvous: short-lived sessions relaying opaque CSR/cert blobs | done | `cloud/src/pairing.js`, `cloud/test/pairing.test.mjs` | Hashed secrets, both blob directions, 64 KiB bounds, 15-min TTL + sweep; cloud never parses blobs. Client sides (relayd + iOS) not yet consuming it |
| Notify: signed node-event ingest (no content), APNs fanout (silent/mutable/Live Activity), 7-day retention | partial | `cloud/src/{notify,apns}.js`, `cloud/test/notify.test.mjs` | ed25519 raw-body verify, tamper/wrong-key rejection, silent-vs-mutable classification per event type, ES256 provider JWT, 7-day sweep — tested against a mock transport. Live APNs HTTP/2 never exercised; no `410 Unregistered` cleanup; Live Activity channel not implemented |
| Live control-plane deployment + CI/CD | done | `cloud/deploy/{relay-cloud-cicd.yml,buildspec.deploy.yml,cicd-deploy.sh,install.sh,relay-cloud.service}`, `../docs/RELAY_POC_EC2_DEPLOYMENT.md` | Public HTTPS control plane on shared `poc-ec2`; loopback-only 8790, immutable SHA releases, CodeCommit/EventBridge/CodePipeline/CodeBuild/SSM delivery, public health gate, and rollback. The successful 2026-08-11 pipeline deployed the exact tested SHA |
| Domains + DNS: product domain, `api.`, `get.`, `*.tun.`, `www.` | partial | `relay.ai-rocket-experiments.com`, `cloud/deploy/relay-cloud.nginx.conf.template`, `../docs/RELAY_POC_EC2_DEPLOYMENT.md` | Control-plane Route 53 record, nginx TLS vhost, Let's Encrypt certificate, and public health are live. Product `get`, `www`, and tunnel wildcard/broker ingress are not deployed |
| Web v0: landing, docs, account page (login, node list, waitlist) | missing | — | Nothing in `product/` |
| Ops: database backups, release automation, external uptime checks, Sentry, structured logs | partial | `cloud/deploy/{backup-sqlite.sh,verify-backup.sh,relay-cloud-backup.service,relay-cloud-backup.timer,relay-cloud-cicd.yml}`, `../docs/RELAY_POC_EC2_DEPLOYMENT.md` | Nightly integrity-checked SQLite backup to private versioned/encrypted S3 and AWS-native CI/CD are live. The database remains SQLite by design; external uptime alerting, Sentry, and structured logging are still open |

---

## Trial sandbox — revamp/07-trial-sandbox-plan.md

> Added 2026-08-11. Land-status of the instant-trial-machine feature
> described in [`revamp/07-trial-sandbox-plan.md`](../revamp/07-trial-sandbox-plan.md),
> audited the same way as W0–W3 above; extends (does not replace) the W1/W3
> rows for the broker and control plane.

| Item | Status | Evidence | Note |
|---|---|---|---|
| relay-cloud provisioner (E2B/Cube-protocol client): `createSandbox`/`killSandbox`/`pauseSandbox` | done | `cloud/src/provisioner.js`, `cloud/test/provisioner.test.mjs` | Backend-agnostic — only `E2B_API_URL`/`E2B_API_KEY` change to point at hosted e2b later. `createProvisioner` returns `null` when `E2B_API_URL` is unset, which is how the whole trial surface feature-flags off (`POST /v1/trial-nodes` then 404s `trial_unavailable`) |
| Trial config (`e2b`, `trial`, `tunnel` groups) | done | `cloud/src/config.js` | `E2B_API_URL/KEY`, `TRIAL_TEMPLATE_ID`, `TRIAL_TTL_SEC` (default 7d), `TRIAL_GRACE_SEC` (default 3d), `TRIAL_MAX_ACTIVE` (default 20), `TRIAL_SANDBOX_TIMEOUT_MS` (default 1h), `TUNNEL_HOST/PORT/SUFFIX`, `ENROLL_BASE_URL` |
| `trial_nodes` table + registry API | done | `cloud/src/db.js`, `cloud/src/registry.js`, `cloud/test/trial-registry.test.mjs` | One row per account (`UNIQUE account_id`); states `creating\|ready\|expired\|destroyed\|failed`; 8 functions (`createTrialNode`, `getTrialById`, `getTrialByAccount`, `getTrialByTokenHash`, `updateTrial`, `listTrialsDue`, `listTrialsPastGrace`, `countActiveTrials`); `createNode` now takes an optional explicit `id` (used so the trial node's id matches what the sandbox minted) |
| Cloud HTTP routes: `POST /v1/trial-nodes`, `GET/DELETE /v1/trial-nodes/current`, `POST /v1/trial-nodes/enroll` | done | `cloud/src/server.js`, `cloud/test/trial-api.test.mjs`, `cloud/test/trial-enroll.test.mjs` | Create is session-authed, entitlement/cap-gated (409 `trial_already_used`, 503 `trial_capacity`), mints a single-use enroll token and calls the provisioner; enroll is token-authed (401 `invalid_enroll_token`), burns the token, and registers the node under a new `trial` node kind. A trial in state `failed` (a prior provision attempt that threw) is retried in place — same row, reset to `creating` with a fresh token — instead of permanently burning the account's one lifetime trial; every other state still 409s |
| `GET /v1/export.tar` — whole-jail workspace export | done | `relayd/src/fsapi.mjs:392` (`serveExportTar`), routed in `relayd/src/additions.mjs`, covered in `relayd/test/conformance.test.mjs` | mTLS-authed (same `authorize()` gate as the data path), jail-contained (reuses the `fs/list` walk, denylisted files excluded before `tar` sees them), 512 MiB cap checked before any header is written → 413 `export_too_large`. Entry list is passed to `tar` NUL-separated (`--null`) over stdin, not argv — required, not stylistic: a newline-joined list lets an attacker-controlled filename inject a `-C` directory-change directive and escape the jail. Consumed by iOS `CodexClient.downloadExport()` and the export/share action in `TrialStatusBanner` |
| Reaper (pause at TTL expiry, destroy after grace) | done | `cloud/src/server.js` (`sweepTrials`), `cloud/test/trial-reaper.test.mjs` | Wired into the existing 60 s `runSweeps()` timer alongside the pairing/notify sweeps; state-driven off `expires_at`, so a crash mid-pass is safe to re-run |
| Broker dynamic node registry (control-plane-backed fallback lookup) | done | `broker/internal/registry`, `broker/cmd/broker/main.go` (`-registry-url`, `-registry-token-file`), `broker/internal/broker/broker.go` (`SetFallbackLookup`) | HTTP resolver against the cloud's `GET /v1/tunnel/nodes/:id` hook; 60 s positive / 10 s negative TTL cache; consulted only when a node id misses the static `-node` flag registry, which remains primary. Closes the long-standing "the Go broker does NOT call the registry hook" gap **for nodes opted into it** — the broker still needs `-registry-url` passed at deploy time |
| relayd `enroll` (identity bootstrap + single-use token registration with the control plane) | done | `relayd/src/enroll.mjs`, `relayd/bin/relayd` (`enroll` subcommand), `relayd/test/enroll.test.mjs` | Idempotent — a second call with a fresh token reuses the same node identity/id. Wired into the CLI, env-driven (`RELAYD_ENROLL_URL`, `RELAYD_ENROLL_TOKEN`), no secrets on argv or in output |
| Trial pairing (server-mediated; node mints the device cert) | done | `relayd/src/trialpair.mjs`, invoked from `relayd enroll` when `RELAYD_ENROLL_PAIRING_ID`/`_SECRET` are set, `relayd/test/trialpair.test.mjs` | Documented protocol delta from the BYO zero-knowledge CSR flow (`relayd/API.md` §2.3) — see `revamp/07-trial-sandbox-plan.md` "Implementation status" for the rationale |
| Trial sandbox template (Cube/E2B) | done (never booted against a live Cube host in this audit) | `product/trial/{Dockerfile,start.sh,e2b.toml,build.sh,README.md}` | No systemd — `start.sh` runs `relayd enroll` once (marker file gates re-runs), scrubs the enroll/pairing env vars, then execs `relayd run --mode tunneled`. Template build/boot/egress-preset verification against a real Cube host is still open (plan §Testing) |
| iOS: fork-screen "Try instantly", provisioning progress states, trial badge/countdown, expiry/export | done | `ios/POCVault/POCVault/Models/{RelayTrialNode,RelayNodeStore}.swift`, `Security/RelayTrialPairing.swift`, `Networking/RelayTrialClient.swift`, `Views/{RelayTrialFlowModel,TrialProvisioningView,TrialStatusBanner}.swift`, `Views/AccountSettingsView.swift`, `POCVaultTests/TrialPairingTests.swift` | Full flow wired: `RelayTrialFlowModel` drives create → device-blob → poll-ready → poll-node-blob → tag-verify → PKCS#12 import → `RelayNodeStore.adoptTrial` (repoints the app at the new node without relaunch); `TrialProvisioningView` renders it as a Creating/Booting/Pairing/Ready checklist with retry; `TrialStatusBanner` shows the "Trial · N days left" badge and, once expired, an expiry banner with "Connect your own machine", "Join the paid waitlist", and an export action (`CodexClient.downloadExport()` → `ShareLink`); `AccountSettingsView` adds a "Trial machine" status/delete section. `RelayTrialPairing` derivations (authToken/macKey/blobTag/p12Passphrase) remain bit-for-bit matched to `relayd/src/trialpair.mjs`, cross-checked by fixtures in `TrialPairingTests.swift`. 96/96 iOS tests pass (`xcodebuild test`, verified against iPhone 17 simulator on this audit date — iPhone 16 unavailable on this machine) |

### Test evidence (trial sandbox, 2026-08-11)

| Suite | Command | Result |
|---|---|---|
| cloud (full suite, incl. trial test files + provisioner) | `cd product/cloud && node --test test/*.test.mjs` | **59 pass / 0 fail** locally and in CodeBuild before the 2026-08-11 deployment |
| relayd (full suite, incl. `enroll.test.mjs` + `trialpair.test.mjs` + export.tar coverage) | `cd product/relayd && node --test test/*.test.mjs` | **157 pass / 0 fail** (~75 s), of which `test/conformance.test.mjs` alone is **62 pass / 0 fail** (up from 59 — the export.tar route and its jail/`--null`-escape tests) |
| broker (incl. new `internal/registry` package) | `cd product/broker && go vet ./... && go build ./... && go test -count=1 ./...` | **all packages ok** |
| iOS (`ios/POCVault`) | `xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 16'` | **96 pass / 0 fail** (`ManifestTests` 83 + `AccountTests` 3 + `TrialPairingTests` 10) |

---

## Test evidence (actual runs, 2026-08-09)

| Suite | Command | Result |
|---|---|---|
| relayd (conformance 59 + module tests) | `cd product/relayd && node --test test/*.test.mjs` | **102 pass / 0 fail** (~73 s; Node v22.23.1, `node:sqlite` ExperimentalWarning expected) |
| cloud | `cd product/cloud && node --test test/*.test.mjs` | **16 pass / 0 fail** |
| broker | `cd product/broker && go vet ./... && go build ./... && go test -count=1 ./...` | **all packages ok** (e2e, mux, sni, verify; 18 test funcs; Go 1.26.4) |

## Next actions

### Remaining for M0 (contract freeze + tunnel spike closure)
1. Parameterize the conformance suite on a base URL (e.g. `RELAY_CONFORMANCE_BASE_URL`) with a spawn fallback, so a Go port or a tunneled node can run it unmodified — the last open W0 item.
2. Run the physical W1 exit gate: fresh VM behind NAT + phone on LTE, live job SSE end-to-end with client-cert auth; capture mobile-network-transition and idle-timeout behavior (needs real infra, out of scope this run).

### Remaining for M1 (relayd extraction complete + dogfood)
3. Wire `tunnel.mjs` into `relayd run` as the second listen mode (config-selected direct|tunneled) + reconnect/backoff on the node side; auto-start the pairing listener from the daemon.
4. Implement per-workspace job mutex (spec W2; today only global `CODEX_MAX_CONCURRENT`).
5. TOML config + one-shot `/etc/codex-api.env` migration in `config.mjs`.
6. relayd→cloud signed event client (`POST /v1/node-events` with the node identity key) — cloud ingest is ready and tested.
7. Harness `install` action (`POST /v1/harness/:provider/install` per API.md §2.5).
8. Cloud-rendezvous pairing path from relayd for **BYO** installs (headless enroll-code flow for `install.sh`, per cloud README "stubbed" list) — defines the pairing-session creation auth for installers. *(Partially addressed for the trial tier only: `relayd/src/trialpair.mjs` now consumes the same cloud rendezvous endpoints, but via a node-mints-the-certificate PKCS#12 delta that is deliberately trial-only — see `revamp/07-trial-sandbox-plan.md` "Implementation status". The general BYO headless enroll-code flow for `install.sh` is still not built.)*
9. Flip the store default to SQLite after a soak (JSON remains the migration source), or make `install.sh` set `RELAYD_STORE=sqlite` for fresh installs.
10. Execute `install.sh` on a fresh VM end-to-end; then enroll the personal box as node #1 (direct mode) — dogfood gate. *(live deploy; intentionally out of scope this run)*
11. **iOS W4** (intentionally out of scope this run): NodeStore, Secure-Enclave identity + CSR + pairing client + per-node CA pinning (U2 prototype in week 1), multi-node plumbing, onboarding screens, push/NSE/Live Activity, Sign in with Apple, on-device transcription, settings, keep 79 XCTests green.

### Remaining for M2 (hardening; noted for continuity)
12. Broker production deltas: `wss://` tunnel transport, flow control, per-node/per-IP limits, metrics, connection draining. *(Registry-hook integration with the cloud landed — `broker/internal/registry` + `-registry-url`/`-registry-token-file`, opt-in via flag as a fallback behind the still-default `-node` static registry.)*
13. Live credentials + transports: real APNs `.p8` over HTTP/2 (+`410` token cleanup, Live Activity channel), SES wiring for magic links, real SIWA service config. *(real keys intentionally out of scope this run)*
14. Complete the remaining infra surfaces: `get`, `*.tun`, and `www` DNS/ingress, web v0 (landing/docs/account), external uptime alerting, Sentry, and structured logs. The control-plane DNS/TLS plus CodeCommit/CodeBuild/CodePipeline/SSM delivery and S3 SQLite backups are live; VPC/EC2 remain pre-existing infrastructure. Keep the Postgres cutover behind the existing DAL seam until the adapter and migration are tested.
