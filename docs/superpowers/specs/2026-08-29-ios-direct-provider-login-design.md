# Direct Provider Login from the Phone — Design

> Status: implemented 2026-08-29 (same change as this doc).
> Scope: closes the "no laptop in front of me" gap for connecting Claude
> Code / Codex (and the other harnesses) on a machine assigned from the
> iOS app. Extends relayd API.md §2.5 (harness manager) and the iOS
> machine surfaces. All hostnames genericized per repo convention.

## 1. What this is

A machine provisioned from the phone ships its harness CLIs installed but
unauthenticated. Until now the only shipped way to connect them was
`relay sync-auth` — which requires a signed-in Mac. relayd already knew
how to *start* a provider's own login on the node
(`POST /v1/harness/:provider/login` spawns the CLI, scrapes the public
verification URL / user code out of stdout), but nothing could *finish*
one from the phone, and the iOS app never called it: a signed-out
provider showed "Run relay sync-auth on your Mac".

This design completes the loop so the whole login runs from the iPhone:

- **Paste-back flows** (Claude Code-style): the provider's site shows a
  code after browser sign-in and the CLI waits for it on stdin. The app
  opens the URL in `SFSafariViewController`, the user pastes the code
  into the app, and relayd types it into the CLI
  (`POST /v1/harness/ops/:id/input`).
- **Localhost-callback flows** (Codex-style): `codex login` runs an OAuth
  callback server on `localhost:1455` and the browser is redirected there
  with the authorization code. On the phone nothing listens on that port,
  so the app opens the URL in an in-app `WKWebView`, intercepts the
  redirect to `localhost`, and hands the URL to relayd, which replays it
  against the CLI's server on the node
  (`POST /v1/harness/ops/:id/callback`).
- **Device-code flows** (URL + short code): already covered by the op's
  `verificationUrl`/`userCode` scrape; the app now actually renders them.

`relay sync-auth` remains supported and unchanged.

## 2. Decisions

| Question | Decision |
|---|---|
| Mechanism | **Extend the existing harness login op**, not a new subsystem. The op model (states, 409 one-active-per-provider, `harness.changed` events, logTail redaction) already exists; the phone only needed an input channel, a callback relay, and cancel. |
| Where the OAuth happens | **In the phone's browser**, against the provider's real site — Relay never proxies the provider's login pages and never sees the user's provider password. |
| Codex callback | **Capture-and-replay.** The in-app browser cancels any navigation to `http://localhost`/`127.0.0.1` and posts the URL to relayd, which GETs it against `127.0.0.1:<allowlisted port>` (per-provider allowlist, default `{"codex": 1455}`, override `RELAYD_HARNESS_CALLBACK_PORTS`), following ≤ 3 same-origin redirects so the CLI's callback → success chain runs as it would locally. Rejected: SSH/port-forward UX (no laptop is the whole premise) and copying `auth.json` through the phone (credentials must never transit the app). |
| Browser choice | `SFSafariViewController` wherever interception isn't needed (real browser context, SSO-friendly); a bare `WKWebView` **only** for the localhost-callback flow, where interception is the hard requirement Safari can't meet. |
| Paste-back input | One trimmed single line, ≤ 4 KiB, no control characters, written to the login child's stdin (spawned `pipe` instead of `ignore`). CLIs that never read stdin are unaffected. |
| Credential handling | The pasted text and the callback query string carry authorization codes. relayd forwards them to the child / loopback and **nowhere else** — not `op.log`, not audit records (op id + provider + path only), not responses beyond the op's public shape. |
| Login command | Unchanged default `<bin> login`; per-install override `RELAYD_HARNESS_LOGIN_ARGS` already existed and is how an operator points a provider at its headless/device-code variant if its default flow needs a TTY. |

## 3. End-to-end flow

```
 iOS app                        relayd (machine)              provider
─────────                      ─────────────────             ──────────
POST /v1/harness/:p/login ───▶ spawn `<bin> login` (stdin piped)
◀── 202 {op}                   scrape URL/code → waiting_for_user
poll GET /v1/harness/ops/:id
open verificationUrl in browser ────────────────────────────▶ user signs in
  Codex path: browser redirect to localhost:1455 intercepted
POST ops/:id/callback {url} ─▶ GET 127.0.0.1:1455/auth/callback?code=…
                               CLI exchanges code, writes auth, exits 0
  Paste path: provider page shows a code ◀───────────────────
user pastes code in app
POST ops/:id/input {text} ───▶ write line to CLI stdin, CLI exits 0
poll shows succeeded ◀──────── op → succeeded, harness.changed
"<Provider> is connected"      GET /v1/harness now loggedIn: true
```

## 4. Component changes

### 4.1 relayd (`product/relayd`)

- `harness.mjs`: login children spawn with `stdio: ["pipe","pipe","pipe"]`;
  new `sendLoginInput`, `forwardLoginCallback` (+ loopback GET helper with
  same-origin redirect follow, unpooled, 15 s timeout), `cancelOp`;
  `RELAYD_HARNESS_CALLBACK_PORTS` (default `{"codex": 1455}`).
  `assertProviderReady` copy now offers the phone path first.
- `additions.mjs`: routes `POST /v1/harness/ops/:id/{input|callback|cancel}`
  behind the same authorize() gate as the rest of the data path.
- Untouched: op shape, redaction, `RELAYD_HARNESS_LOGIN_ARGS`, smoke ops,
  sync-auth, all node auth.

### 4.2 iOS (`ios/POCVault`)

- `Models/CodexModels.swift`: `RelayHarnessOp` (+ envelope);
  `RelayHarnessStatus.supportsDirectLogin`; readiness copy no longer
  demands a Mac.
- `Networking/CodexClient.swift`: `startHarnessLogin`, `fetchHarnessOp(s)`,
  `sendHarnessLoginInput`, `forwardHarnessLoginCallback`, `cancelHarnessOp`.
- `Views/ProviderLoginFlowModel.swift`: `idle → starting →
  waitingForSignIn(op) → completing → succeeded | failed(reason)`;
  adopts an already-running login on 409; 1 s op polling; cancel frees
  the machine's slot.
- **Legacy-machine fallback** (added same day, then rebuilt once more after
  field testing): the flow model carries a second engine that needs only
  `POST /v1/exec` and `GET /v1/harness`. The first fallback rode Relay's
  terminals — and field testing exposed why it can't: terminals run through
  the Codex app-server, i.e. through the codex CLI itself, which hangs on a
  machine where codex has never signed in. The exact chicken-and-egg this
  feature exists to break. The exec engine has no such dependency: it
  launches the CLI's login via one bounded exec under util-linux `script`
  (a real PTY, which also cures CLIs that stay silent without one; plain
  redirection when `script` is absent), detached with `setsid`, output
  flushed to a log file, stdin fed from a FIFO held open by a writer fd.
  The phone resolves the CLI's absolute path first (headless PATH misses
  npm-global bins — the /opt/node/bin incident), polls the log through
  exec, scrapes the URL/user code (ANSI-stripped, relayd-pattern parity),
  quotes the machine's own error line on failure and shows the live output
  tail on the sheet, writes the pasted code into the FIFO, replays a
  captured localhost callback with one bounded `node -e 'fetch(…)'` exec
  against `127.0.0.1`, and takes the harness list's `loggedIn: true` as the
  machine's confirmation. It engages automatically: op routes 404, the op
  dies before producing a link, no link within 8 s, or input/callback
  answer 404 at completion time. The modern op engine remains the path on
  updated machines.
- `Views/ProviderLoginView.swift`: the sheet (Editorial Ember: explicit
  status copy, never a dot), Safari and intercepting-WKWebView browsers,
  code display with tap-to-copy, paste field.
- Entry points: **Account & Settings → Coding agents** (per-agent status +
  "Sign in", shown whenever the account has a machine) and a **Connect**
  affordance on the composer's provider-readiness notice.

### 4.3 Untouched

`relay sync-auth`, cloud, broker, trial provisioning, pairing, node auth,
Android (recorded as `direct-provider-login` android-gap in
`mobile/parity-contract.json`).

## 5. Error handling

- **Start fails / machine unreachable** — explicit failure copy with
  retry; a 409 (login already running) is adopted, not surfaced.
- **Wrong pasted code** — the CLI decides: it exits non-zero → op
  `failed` → "The sign-in didn't complete. Try again."
- **Callback validation** — active login op only; `http:` +
  `localhost`/`127.0.0.1` + allowlisted per-provider port + path exactly
  `/auth/callback`; anything else 400. CLI's server not listening → 502.
- **Timeout** — the op's existing 10-minute ceiling → `expired` → "The
  sign-in timed out on the machine."
- **User bails out** — dismissing mid-flow cancels the op so the
  provider's one-active-login slot frees immediately.

## 6. Security posture

- Provider credentials never transit Relay's API in either direction: the
  browser talks to the provider directly; the CLI stores its own session
  in the machine's isolated runner home. What does transit — a paste-back
  authorization code, a callback URL carrying one — is forwarded to the
  CLI/loopback and never logged, audited, or echoed (relayd's logTail
  redaction remains the backstop for whatever the CLI itself prints).
- The callback relay is not an open proxy: op-scoped, provider-port
  allowlisted, loopback-only, single path, GET-only, bounded redirects —
  and gated by the same node auth as `/v1/exec`, which is strictly more
  powerful anyway.
- `input` writes to exactly one process: the login child relayd itself
  spawned; there is no attach-to-arbitrary-pid surface.
- The in-app WKWebView is used only where interception is required; the
  paste-back path keeps the real-browser context (`SFSafariViewController`).

## 7. Testing

- **relayd** (`test/harness-direct-login.test.mjs`, fake-CLI pattern):
  paste-back input delivered verbatim to stdin and absent from logTail;
  callback relayed to a real loopback login server (redirect chain
  followed, query delivered, code absent from logTail); the 400 taxonomy
  (path/host/port/no-callback-provider); cancel one-shot + slot freeing;
  input/callback conflicts on finished ops.
- **iOS** (`POCVaultTests/ProviderLoginTests.swift`): op decoding
  (waiting_for_user artifacts, unknown-status leniency, envelope extras);
  localhost-callback detection; flow-model transitions against a stubbed
  client (poll to succeeded, 409 adoption, trimmed paste delivery,
  callback forward, terminal failure, cancel).
- **Acceptance** (operator, real machine): assign a trial machine on the
  phone → Settings → Coding agents → sign in to Codex (browser →
  automatic finish) and Claude Code (browser → paste code) → composer
  notice clears → run a task with each provider — all with no laptop.

## 8. Non-goals

- Installing missing CLIs from the phone (`install` op remains spec-only).
- Provider credential storage on the phone or in the cloud.
- A generic HTTP proxy into the machine (the callback relay is
  deliberately not one).
- Android parity (tracked in `mobile/parity-contract.json`).
- Changing `relay sync-auth` or its copy on the CLI side.
