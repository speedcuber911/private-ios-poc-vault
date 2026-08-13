# Web Auth Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an authenticated `product/web` app where signup starts a trial machine, the user sees live jobs/threads, the phone can sign the browser in via the existing QR scanner, and `relay login` is approved on `/cli-login` after web sign-in.

**Architecture:** Better Auth cookies on the app origin; device codes split `cli`/`web` so web login cannot steal the one computer slot; Ed25519 browser grants (cloud private key, node public key only) accepted inside relayd's existing trial bearer branch; a loopback grant gateway on the broker host, TLS-terminated there, never on the control-plane box.

**Tech Stack:** Node 22 ESM (`node:test`, `node:sqlite`, `node:crypto`), Better Auth (already in cloud), Vite + React for `product/web`, nginx + Let's Encrypt for gateway ingress. Cloud, relayd, and the gateway stay zero new npm dependencies.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-13-web-auth-console-design.md` (review-corrected).
- **Zero new npm dependencies** in `product/cloud`, `product/relayd`, `product/grant-gateway`. `product/web` may use React, Vite, and `better-auth/client` only.
- Test runner: `node --test` with `node:assert/strict`. Cloud: `cd product/cloud && node --test test/*.test.mjs`. relayd: `cd product/relayd && node --test test/*.test.mjs`.
- Cloud env knobs go through `loadConfig` in `product/cloud/src/config.js`. relayd knobs use the `RELAYD_` prefix in `src/config.mjs`.
- Secrets never in argv, logs, responses, repo, or CI variables. Host files 0600.
- Copy says **machine**, not sandbox. Editorial Ember: status is a word, never a dot. Serif titles, sans controls.
- Cloud stays content-free. No prompt/file/transcript rows. Grant JWT carries ids and scopes only.
- **No `BROWSER_GRANT_SECRET`.** Signing is Ed25519. Nodes hold only `grantPublicKey`.
- Trial `authorize()` is the device-token bearer branch. Grant acceptance lives there with JWT-vs-token precedence. Do not add a third top-level branch trial traffic never reaches.
- Do not put `product/web` or the gateway into CodeCommit `relay-cloud`. Do not `ops/deploy-poc` the app. Do not terminate gateway TLS on poc-ec2. Do not put the raw broker on 80/443.
- Grants are unrevocable until `exp` (~15 min). Do not lengthen TTL. No `jti` denylist in this plan.
- iOS is untouched unless a scanner regression appears.
- Commit after every task. Conventional subjects (`feat:`, `test:`, `docs:`).
- AWS mutations (if any later deploy task runs) use `--profile default --region ap-south-1` only. Never print `/etc/relay-cloud/env`.

---

## File Structure

### Modified — `product/cloud/`

| File | Change |
|---|---|
| `src/db.js` | `device_codes.client` via `addColumnIfMissing` |
| `src/registry.js` | Persist/map `client`; `approveDeviceCodeForWebSession`; createDeviceCode accepts `client` |
| `src/config.js` | `browserGrantPrivateKey`, `browserGrantPublicKey`, `grantGatewayUrl`, `trustedWebOrigins` |
| `src/jwt.js` | `signEd25519` / `verifyEd25519` (totality: never throw) |
| `src/better-auth.js` | `trustedOrigins` includes app origin; cookie settings for cross-origin SPA |
| `src/server.js` | `client` on start; inspect/approve lookup-first; token `web` branch; `POST /v1/nodes/:id/browser-grants`; `grantPublicKey` in enroll.json; `web` in `normalizeDevicePlatform` |
| `test/device-code.test.mjs` | `cli`/`web` isolation + inspect/approve with existing CLI link |
| `test/browser-grant.test.mjs` | **New.** Mint, foreign node, expiry, Ed25519-not-HMAC |
| `test/jwt.test.mjs` | Ed25519 sign/verify totality (extend if file exists, else new) |

### Modified — `product/relayd/`

| File | Change |
|---|---|
| `src/grant.mjs` | **New.** Verify Ed25519 grant JWT; scope check. Public key only. |
| `src/server.mjs` | `authorize()` first-branch precedence; pass pathname into authorize or a wrapper |
| `src/config.mjs` | `RELAYD_GRANT_PUBLIC_KEY` (base64url 32 bytes) |
| `test/grant-auth.test.mjs` | **New.** Trial-shaped authorize: grant vs device token vs wrong node |

### New — `product/grant-gateway/`

| File | Responsibility |
|---|---|
| `package.json` | `"type": "module"`, `"test": "node --test"` |
| `src/server.js` | Loopback HTTP reverse proxy; verify grant; allowlist paths |
| `src/log.js` | Logger that drops bodies |
| `deploy/relay-grant-gateway.service` | systemd, loopback `:8791` |
| `deploy/nginx.conf.template` | TLS vhost → loopback, rate limit |
| `test/gateway.test.mjs` | Proxy allowlist, 403, no body logs |

### New — `product/web/`

| File | Responsibility |
|---|---|
| `package.json` | Vite + React + `better-auth/client` |
| `src/theme.css` | Editorial Ember tokens from iOS `AppTheme` |
| `src/api/cloud.js` | Cookie-credential fetch to control plane |
| `src/api/device.js` | Device-code start/poll/inspect/approve |
| `src/api/grant.js` | Mint grant + activity fetch with remint-once |
| `src/pages/Login.tsx` | Sign in / create account / Sign in with iPhone |
| `src/pages/CliLogin.tsx` | `#code=` landing |
| `src/pages/Provisioning.tsx` | Creating → Booting → Ready |
| `src/pages/Machines.tsx` | List + waitlist upsell |
| `src/pages/Activity.tsx` | Jobs/threads |
| `src/main.tsx` / `src/App.tsx` | Routes |

### Modified — marketing

| File | Change |
|---|---|
| `pocs/relay/site/src/App.tsx` | Sign in link to app origin (env `VITE_RELAY_APP_ORIGIN`) |

---

### Task 1: `device_codes.client` column and registry

**Files:**
- Modify: `product/cloud/src/db.js`
- Modify: `product/cloud/src/registry.js` (`createDeviceCode`, `mapDeviceCode`, `ensureDeviceCodeMachineColumns` or a sibling `ensureDeviceCodeClientColumn`)
- Test: `product/cloud/test/device-code.test.mjs`

**Interfaces:**
- Consumes: existing `createDeviceCode({ deviceCodeHash, userCode, expiresAt, clientIp, machineName, platform })`
- Produces: `createDeviceCode({ ..., client })` where `client` is `"cli"` \| `"web"`, default `"cli"`. `mapDeviceCode` returns `client: row.client || "cli"`.

- [ ] **Step 1: Write the failing test**

Add to `product/cloud/test/device-code.test.mjs`:

```js
test("createDeviceCode persists client=web and defaults omitted client to cli", () => {
  const dir = mkdtempSync(join(tmpdir(), "relay-dc-"));
  const db = createDb(join(dir, "t.sqlite"));
  const registry = createRegistry(db);
  const web = registry.createDeviceCode({
    deviceCodeHash: "a".repeat(64),
    userCode: "ABCD-EFGH",
    expiresAt: Date.now() + 60_000,
    client: "web",
  });
  assert.equal(web.client, "web");
  const cli = registry.createDeviceCode({
    deviceCodeHash: "b".repeat(64),
    userCode: "IJKL-MNOP",
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(cli.client, "cli");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/cloud && node --test test/device-code.test.mjs`

Expected: FAIL — `client` undefined / SQLITE error unknown column.

- [ ] **Step 3: Minimal implementation**

In `db.js` `addColumnIfMissing` (same pattern as `cli_link_id`):

```js
addColumnIfMissing("device_codes", "client", "client TEXT NOT NULL DEFAULT 'cli'");
```

Also add `client TEXT NOT NULL DEFAULT 'cli'` to the `CREATE TABLE IF NOT EXISTS device_codes` body so fresh DBs match.

In `ensureDeviceCodeMachineColumns` (or a new `ensureDeviceCodeClientColumn` called from `createDb`):

```js
if (!names.has("client")) {
  db.exec("ALTER TABLE device_codes ADD COLUMN client TEXT NOT NULL DEFAULT 'cli'");
}
```

`createDeviceCode`: persist `client === "web" ? "web" : "cli"`.

`mapDeviceCode`: `client: row.client === "web" ? "web" : "cli"`.

- [ ] **Step 4: Run tests**

Run: `cd product/cloud && node --test test/device-code.test.mjs`

Expected: PASS (existing tests included).

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/db.js product/cloud/src/registry.js product/cloud/test/device-code.test.mjs
git commit -m "feat(cloud): persist device-code client cli|web"
```

---

### Task 2: start / inspect / approve / token honor `client`

**Files:**
- Modify: `product/cloud/src/server.js` (`/v1/auth/device/start`, `inspect`, `approve`, `token`, `normalizeDevicePlatform`)
- Modify: `product/cloud/src/registry.js` (add `approveDeviceCodeForWebSession`)
- Test: `product/cloud/test/device-code.test.mjs`

**Interfaces:**
- Consumes: Task 1 `client` column
- Produces: `approveDeviceCodeForWebSession(id, accountId)` → `{ status: "approved"|"invalid_code", record }` with `account_id` set and **no** `cli_computer_links` row. `normalizeDevicePlatform` accepts `"web"`.

Critical: today's inspect/approve **409 before lookup** if `getCliComputerLink(account)` is set. That must move to after the code is classified. Lookup first; 409 only for `client === "cli"`.

- [ ] **Step 1: Write the failing tests**

```js
test("web device code does not create a cli computer link", async () => {
  const t = await startTestApp();
  try {
    const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { client: "web", machineName: "This browser", platform: "web" },
    });
    assert.equal(started.status, 201);
    const session = await signIn(t);
    const inspected = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", {
      body: { userCode: started.json.userCode },
      ...authed(session.sessionToken),
    });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.json.client, "web");
    assert.equal((await approve(t, session.sessionToken, started.json.userCode)).status, 200);
    const link = await api(t.baseUrl, "GET", "/v1/auth/device/link", authed(session.sessionToken));
    assert.equal(link.json.computer, null); // or 404 — match today's empty-link shape
    const granted = await poll(t, started.json.deviceCode);
    assert.equal(granted.status, 200);
    assert.equal(granted.json.cliLinkId, undefined);
    assert.match(granted.headers.get("set-cookie") || "", /better-auth|session/i);
  } finally { await t.close(); }
});

test("inspect and approve of a web code succeed when a CLI computer is already linked", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const cli = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: { machineName: "mbp" } });
    assert.equal((await approve(t, session.sessionToken, cli.json.userCode)).status, 200);
    assert.equal((await poll(t, cli.json.deviceCode)).status, 200);

    const web = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { client: "web", platform: "web" },
    });
    const inspected = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", {
      body: { userCode: web.json.userCode },
      ...authed(session.sessionToken),
    });
    assert.equal(inspected.status, 200);
    assert.equal(inspected.json.client, "web");
    assert.equal((await approve(t, session.sessionToken, web.json.userCode)).status, 200);
  } finally { await t.close(); }
});

test("cli inspect still 409s computer_already_linked when the slot is taken", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const first = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    assert.equal((await approve(t, session.sessionToken, first.json.userCode)).status, 200);
    const second = await api(t.baseUrl, "POST", "/v1/auth/device/start", { body: {} });
    const inspected = await api(t.baseUrl, "POST", "/v1/auth/device/inspect", {
      body: { userCode: second.json.userCode },
      ...authed(session.sessionToken),
    });
    assert.equal(inspected.status, 409);
    assert.equal(inspected.json.error, "computer_already_linked");
  } finally { await t.close(); }
});
```

Adjust the empty-link assertion to whatever `GET /v1/auth/device/link` already returns when no computer is linked (read that handler; do not invent a new envelope).

- [ ] **Step 2: Run tests — expect FAIL**

Run: `cd product/cloud && node --test test/device-code.test.mjs`

Expected: FAIL on `client` missing and/or 409 on the web-while-linked case.

- [ ] **Step 3: Implement**

`normalizeDevicePlatform`: add `web` to the closed set.

`/device/start`: read `body.client === "web" ? "web" : "cli"`; pass to `createDeviceCode`.

`approveDeviceCodeForWebSession` in registry.js: same one-shot `UPDATE device_codes SET account_id, approved_at` **without** inserting `cli_computer_links`. No `cli_link_id`.

Inspect: remove the pre-lookup `getCliComputerLink` 409. After a valid pending record is found, if `record.client !== "web" && getCliComputerLink(account.id)` → 409. Include `client` in the 200 body.

Approve: same lookup-first. If `record.client === "web"` → `approveDeviceCodeForWebSession`. Else existing `approveDeviceCodeForCliLink`.

Token: if `record.client === "web"` (after accountId is set): **do not** call `connectCliComputer`. Mark consumed, create a Better Auth session via `betterAuth.auth.api` (use the same user id as `registry.getAccount`), write `Set-Cookie` on `res`. Return JSON `{ accountId }` (no `cliLinkId`). If Better Auth has no user row for a legacy Apple-only account, `ensureRelayAccount` already ran on Apple sign-in — web password users exist in Better Auth. For Apple-signed-in test accounts, creating a Better Auth session may require `auth.api.createSession({ userId: account.id })` after ensuring the Better Auth user exists. If `createSession` cannot target a legacy Apple account in tests, sign up with `/api/auth/sign-up/email` in the web-token test instead of `signIn()` (Apple). Prefer that: the web path is password/Better Auth.

`connectCliComputer` stays the only redemption for `client === "cli"`.

- [ ] **Step 4: Run full cloud suite**

Run: `cd product/cloud && node --test test/*.test.mjs`

Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/server.js product/cloud/src/registry.js product/cloud/test/device-code.test.mjs
git commit -m "feat(cloud): device-code client=web session without the CLI slot"
```

---

### Task 3: Better Auth trustedOrigins for the app origin

**Files:**
- Modify: `product/cloud/src/config.js`
- Modify: `product/cloud/src/better-auth.js`
- Test: `product/cloud/test/auth.test.mjs` (or a small new `test/better-auth-origins.test.mjs`)

**Interfaces:**
- Consumes: `config.betterAuthBaseURL`
- Produces: `config.trustedWebOrigins: string[]` from `RELAY_WEB_ORIGINS` (comma-separated). `trustedOrigins: [baseURL, ...trustedWebOrigins]`.

- [ ] **Step 1: Failing test**

```js
test("trustedOrigins includes RELAY_WEB_ORIGINS", async () => {
  const t = await startTestApp({
    env: { RELAY_WEB_ORIGINS: "https://app.example.test" },
  });
  try {
    assert.ok(t.config.trustedWebOrigins.includes("https://app.example.test"));
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run — expect FAIL** (`trustedWebOrigins` undefined)

- [ ] **Step 3: Implement**

`config.js`:

```js
trustedWebOrigins: (env.RELAY_WEB_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean),
```

`better-auth.js`:

```js
trustedOrigins: [config.betterAuthBaseURL, ...(config.trustedWebOrigins || [])],
advanced: {
  defaultCookieAttributes: {
    sameSite: "none",
    secure: true,
    httpOnly: true,
  },
},
```

`SameSite=None; Secure` is required because the SPA and API are different origins. Local http tests: if cookie tests fail on `http://127.0.0.1`, set `secure: false` when `betterAuthBaseURL` is http. Do not ship `secure: false` for the live https API.

- [ ] **Step 4: Run** `cd product/cloud && node --test test/*.test.mjs` — PASS

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/config.js product/cloud/src/better-auth.js product/cloud/test
git commit -m "feat(cloud): trust the web app origin for Better Auth cookies"
```

---

### Task 4: Ed25519 grant JWT helpers

**Files:**
- Modify: `product/cloud/src/jwt.js`
- Test: `product/cloud/test/jwt-ed25519.test.mjs` (new)

**Interfaces:**
- Produces:
  - `signEd25519(payload, privateKey)` → JWT string. `privateKey` is a `crypto.KeyObject` or PKCS8 PEM.
  - `verifyEd25519(token, publicKey, nowMs = Date.now())` → payload object or `null`. Never throws.
  - Header `{ alg: "EdDSA", typ: "JWT" }`. Reject any other `alg`.

- [ ] **Step 1: Failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { signEd25519, verifyEd25519, signHS256 } from "../src/jwt.js";

function pair() {
  return generateKeyPairSync("ed25519");
}

test("signEd25519 / verifyEd25519 round-trip", () => {
  const { publicKey, privateKey } = pair();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const token = signEd25519({ sub: "acct", node: "n1", scope: ["jobs.read"], exp }, privateKey);
  const payload = verifyEd25519(token, publicKey);
  assert.equal(payload.sub, "acct");
  assert.equal(payload.node, "n1");
});

test("verifyEd25519 returns null for HMAC tokens, wrong key, expiry, and junk", () => {
  const { publicKey, privateKey } = pair();
  const other = pair();
  const exp = Math.floor(Date.now() / 1000) + 60;
  const good = signEd25519({ sub: "a", exp }, privateKey);
  assert.equal(verifyEd25519(good, other.publicKey), null);
  assert.equal(verifyEd25519(signHS256({ sub: "a", exp }, "secret-secret-secret-secret-0000"), publicKey), null);
  assert.equal(verifyEd25519(signEd25519({ sub: "a", exp: 1 }, privateKey), publicKey), null);
  assert.equal(verifyEd25519("not-a-jwt", publicKey), null);
  assert.equal(verifyEd25519("", publicKey), null);
});
```

- [ ] **Step 2: Run — expect FAIL** (`signEd25519` not exported)

- [ ] **Step 3: Implement in `jwt.js`**

Use `sign(null, data, privateKey)` / `verify(null, data, publicKey, sig)` (Ed25519). Reuse `b64urlJson`, `decodeJwtUnsafe`, `timingSafeEqual` is not used for Ed25519 (library verify). Still: never throw; `decodeJwtUnsafe` null → null; `header.alg !== "EdDSA"` → null; missing/non-numeric `exp` → null.

- [ ] **Step 4: Run** `cd product/cloud && node --test test/jwt-ed25519.test.mjs test/device-code.test.mjs` — PASS

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/jwt.js product/cloud/test/jwt-ed25519.test.mjs
git commit -m "feat(cloud): Ed25519 JWT sign and verify for browser grants"
```

---

### Task 5: `POST /v1/nodes/:id/browser-grants` + enroll public key

**Files:**
- Modify: `product/cloud/src/config.js`
- Modify: `product/cloud/src/server.js` (new route; `writeSandboxFile` enroll.json)
- Modify: `product/cloud/src/main.js` if startup must require the private key when grants are enabled
- Test: `product/cloud/test/browser-grant.test.mjs`

**Interfaces:**
- Consumes: `signEd25519`, registry `getNode` / list nodes for account
- Produces: `POST /v1/nodes/:id/browser-grants` → `{ grant, expiresIn, gatewayUrl }`
- Config: `BROWSER_GRANT_PRIVATE_KEY` (PKCS8 PEM), `BROWSER_GRANT_PUBLIC_KEY` (base64url 32-byte raw), `GRANT_GATEWAY_URL`
- `enroll.json` gains `grantPublicKey: config.browserGrantPublicKey` (omit if unset — existing phones still work)

- [ ] **Step 1: Failing tests**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";
import { verifyEd25519 } from "../src/jwt.js";

function grantKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
    publicRaw: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
  };
}

test("mints an Ed25519 grant for the account's own node", async () => {
  const keys = grantKeys();
  const t = await startTestApp({
    env: {
      BROWSER_GRANT_PRIVATE_KEY: keys.privatePem,
      BROWSER_GRANT_PUBLIC_KEY: keys.publicRaw,
      GRANT_GATEWAY_URL: "https://gateway.example.test",
    },
  });
  try {
    const session = await signIn(t);
    const node = t.app.registry.createNode(session.accountId, {
      kind: "trial",
      pubkey: makeNodeIdentity().pubkeyPem,
    });
    const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(session.sessionToken));
    assert.equal(res.status, 201);
    assert.equal(res.json.gatewayUrl, "https://gateway.example.test");
    assert.equal(res.json.expiresIn, 900);
    const payload = verifyEd25519(res.json.grant, keys.publicKey);
    assert.equal(payload.sub, session.accountId);
    assert.equal(payload.node, node.id);
    assert.deepEqual(payload.scope, ["jobs.read", "threads.read", "events.read"]);
    assert.equal(typeof payload.jti, "string");
  } finally { await t.close(); }
});

test("foreign node is 404 and does not leak existence", async () => {
  const keys = grantKeys();
  const t = await startTestApp({
    env: { BROWSER_GRANT_PRIVATE_KEY: keys.privatePem, GRANT_GATEWAY_URL: "https://gateway.example.test" },
  });
  try {
    const owner = await signIn(t, { sub: "owner", email: "o@example.com" });
    const other = await signIn(t, { sub: "other", email: "x@example.com" });
    const node = t.app.registry.createNode(owner.accountId, {
      kind: "trial",
      pubkey: makeNodeIdentity().pubkeyPem,
    });
    const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(other.sessionToken));
    assert.equal(res.status, 404);
  } finally { await t.close(); }
});
```

Match `createNode` argument shape to the existing registry (read `createNode` before writing the test — do not guess field names).

- [ ] **Step 2: Run — expect FAIL** (404 route missing)

- [ ] **Step 3: Implement**

Config loads PEM + public raw + gateway URL.

Route: session required (existing `authenticate`). Load node by id; if missing or `node.accountId !== account.id` → 404 `{ error: "not_found" }` (same body for both). If grant key or gateway URL unset → 503 `{ error: "grants_unavailable" }`. Sign payload with `exp = now/1000 + 900`.

enroll.json write: add `grantPublicKey` when configured.

- [ ] **Step 4: Run** `cd product/cloud && node --test test/*.test.mjs` — PASS

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/config.js product/cloud/src/server.js product/cloud/test/browser-grant.test.mjs
git commit -m "feat(cloud): mint Ed25519 browser grants and enroll the public key"
```

---

### Task 6: relayd grant verify + authorize() precedence

**Files:**
- Create: `product/relayd/src/grant.mjs`
- Modify: `product/relayd/src/server.mjs` (`authorize`)
- Modify: `product/relayd/src/config.mjs` (`RELAYD_GRANT_PUBLIC_KEY`)
- Test: `product/relayd/test/grant-auth.test.mjs`

**Interfaces:**
- Consumes: enroll-delivered public key (32-byte base64url or raw)
- Produces: `verifyBrowserGrant(token, { publicKey, nodeId, nowMs })` → `{ ok, payload }` or `{ ok: false }`. `authorize(req, { pathname } = {})` first branch per spec §3.3.

Precedence (copy this into the function comment):

1. Read bearer.
2. If JWT-shaped (exactly 3 base64url segments) AND grant public key configured: verify grant; `payload.node === thisNodeId`; `exp` valid; if pathname is an activity read, require matching scope. Fail → 401 `{ error: "device token is not valid" }` (identical public error).
3. Else if `deviceTokenHash()` set: existing hash compare.
4. Else: existing mTLS path.

Activity pathnames (gateway will call these on the node): `GET /v1/jobs`, `GET /v1/threads` (and the exact list/events paths relayd already exposes — read `routeRequest` / `additions.mjs` and use those strings, do not invent `/activity/*` on the node). Grants must **not** authorize `POST` job create, fs, export, or pair.

- [ ] **Step 1: Failing tests**

Write `product/relayd/test/grant-auth.test.mjs` using the same `execFileSync` import pattern as `pairing.test.mjs` if `authorize` reads env at import time. Prefer calling `authorize` in-process if env can be set before import; otherwise spawn like pairing tests.

```js
test("trial node: grant JWT on jobs list is authorized; device token still works", async () => {
  // Arrange: RELAYD_DEVICE_TOKEN_HASH_FILE with sha256(deviceToken)
  //          RELAYD_GRANT_PUBLIC_KEY = raw public
  //          RELAYD_NODE_ID = "node-a"
  // Assert authorize({ headers: { authorization: "Bearer " + grantJwt } }, { pathname: "/v1/jobs" }).ok
  // Assert authorize({ headers: { authorization: "Bearer " + deviceToken } }).ok
});

test("trial node: grant for another node is 401 with the device-token error string", async () => {
  // grant.node = "node-b", this node is node-a
  // error === "device token is not valid"
});

test("trial node: grant is rejected on POST /v1/jobs", async () => {
  // even with a valid signature
});
```

Mint the JWT in the test with `node:crypto` Ed25519 (do not import cloud `jwt.js` into relayd tests — duplicate the three-line sign or copy `grant.mjs`'s test helper).

- [ ] **Step 2: Run — expect FAIL**

Run: `cd product/relayd && node --test test/grant-auth.test.mjs`

- [ ] **Step 3: Implement `grant.mjs` + `authorize` change**

`grant.mjs` is verify-only. Totality: never throw. `RELAYD_GRANT_PUBLIC_KEY` is base64url 32 bytes → `createPublicKey` from raw Ed25519.

Do **not** hash a JWT and compare it to `deviceTokenHash`. That is the bug the spec calls out.

- [ ] **Step 4: Run** `cd product/relayd && node --test test/*.test.mjs` — PASS

- [ ] **Step 5: Commit**

```bash
git add product/relayd/src/grant.mjs product/relayd/src/server.mjs product/relayd/src/config.mjs product/relayd/test/grant-auth.test.mjs
git commit -m "feat(relayd): accept Ed25519 browser grants on the trial bearer path"
```

---

### Task 7: enroll.json → relayd public key on trial boot

**Files:**
- Modify: `product/trial/start.sh` (install `grantPublicKey` from enroll.json into env or a 0600 file)
- Modify: `product/cloud/src/server.js` if Task 5 did not already add the field (it should have)
- Test: extend `product/cloud/test/trial-api.test.mjs` or provisioner tests to assert `writeSandboxFile` JSON includes `grantPublicKey` when configured

- [ ] **Step 1: Failing test** on the cloud write path (enroll payload contains `grantPublicKey`)

- [ ] **Step 2: Run — expect FAIL** if Task 5 omitted the field

- [ ] **Step 3: `start.sh`** after enroll.json is read, if `.grantPublicKey` is present:

```bash
export RELAYD_GRANT_PUBLIC_KEY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["grantPublicKey"])' "$ENROLL_CONFIG")"
```

Prefer python3 already on the image, or `jq` if present — match how `start.sh` already reads enroll.json (read the file; do not invent a second parser). Do not echo the value.

- [ ] **Step 4: Run cloud trial tests** — PASS

- [ ] **Step 5: Commit**

```bash
git add product/trial/start.sh product/cloud
git commit -m "feat(trial): install grant public key from enroll.json"
```

---

### Task 8: Grant gateway process

**Files:**
- Create: `product/grant-gateway/package.json`
- Create: `product/grant-gateway/src/server.js`
- Create: `product/grant-gateway/src/log.js`
- Create: `product/grant-gateway/test/gateway.test.mjs`

**Interfaces:**
- Consumes: `GRANT_PUBLIC_KEY` (same raw public), `NODE_BASE_URL` template or a resolver — for tests, `NODE_PROXY_TARGET` is a single origin (the fake node). Production: gateway maps `grant.node` → `https://<node-id>.<tunnel-suffix>` or the broker-side URL already used for that node. Read broker/tunnel docs and pick the **existing** node HTTP URL shape; do not invent a new mesh.
- Produces: `GET /activity/jobs|threads|events` → proxy to the node's real list paths with `Authorization: Bearer <grant>`. Anything else → 403. Expired/wrong-node grant → 401/403. Logger never receives response bodies.

- [ ] **Step 1: Failing test** with a fake node `http.Server` that records the inbound path + authorization and returns `{"jobs":[]}`.

```js
test("GET /activity/jobs proxies to the node jobs list with the grant", async () => {
  // start fake node, start gateway pointed at it, mint a valid grant JWT,
  // GET /activity/jobs with Authorization: Bearer <grant>
  // assert 200 and fake node saw GET /v1/jobs (or the real list path)
});

test("GET /activity/files is 403 and the node is not contacted", async () => {});

test("logger is not given the response body", async () => {});
```

- [ ] **Step 2: Run — expect FAIL**

- [ ] **Step 3: Minimal proxy**

`node:http` only. Verify grant with a local copy of `verifyEd25519` (copy from cloud `jwt.js` with a one-line comment: canonical is `product/cloud/src/jwt.js` — same pattern as `seal.mjs`). Allowlist map:

```js
const ALLOW = {
  "/activity/jobs": "/v1/jobs",
  "/activity/threads": "/v1/threads",
  "/activity/events": "/v1/events",
};
```

Confirm the node paths against relayd before locking this map.

Listen `127.0.0.1` only. Default port 8791.

- [ ] **Step 4: Run** `cd product/grant-gateway && node --test test/*.test.mjs` — PASS

- [ ] **Step 5: Commit**

```bash
git add product/grant-gateway
git commit -m "feat(gateway): proxy allowlisted activity reads after Ed25519 grant verify"
```

---

### Task 9: Gateway ingress templates

**Files:**
- Create: `product/grant-gateway/deploy/relay-grant-gateway.service`
- Create: `product/grant-gateway/deploy/nginx.conf.template`
- Create: `product/grant-gateway/deploy/rate-limit.conf`

**Interfaces:**
- Unit: `ExecStart` the gateway, `Listen` implied by env `HOST=127.0.0.1` `PORT=8791`. `UMask=0077`. Dedicated user if one exists on that host; otherwise document creating `relaygateway`.
- nginx: server_name `gateway.<api-zone>`; `proxy_pass http://127.0.0.1:8791`; rate-limit zone; reject bodies on GET; do not proxy the broker TCP port.

- [ ] **Step 1: Write templates** (no live apply in this task)

Service binds loopback. nginx template comments: ACME on the **broker host**, not poc-ec2; do not enable this vhost on the control-plane box.

- [ ] **Step 2: Grep templates for `0.0.0.0:8791` and broker mux ports — must not appear**

- [ ] **Step 3: Commit**

```bash
git add product/grant-gateway/deploy
git commit -m "docs(gateway): loopback unit and broker-host TLS vhost templates"
```

Do not run AWS/SSM in this task.

---

### Task 10: `product/web` scaffold + Editorial Ember login

**Files:**
- Create: `product/web/*` (Vite React TS)
- Create: `product/web/src/theme.css` tokens from `docs/superpowers/specs/2026-08-11-editorial-ember-design.md` (`canvasTop` `#1E1B17`, `ink` `#EDE8DF`, `ember` `#D4804A`, …)
- Create: `product/web/src/pages/Login.tsx`
- Create: `product/web/src/api/cloud.js`

**Interfaces:**
- `VITE_RELAY_CLOUD_URL` — live default `https://relay.ai-rocket-experiments.com` is fine in env example, not hardcoded as the only origin.
- Fetch: `credentials: "include"`.
- Signup: `POST /api/auth/sign-up/email` `{ email, username, password }`.
- Sign-in: `POST /api/auth/sign-in/username` `{ username, password }`.

- [ ] **Step 1: Scaffold Vite app** (`npm create` only inside `product/web`)

- [ ] **Step 2: Login page** matching Swift `AuthenticationView`: wordmark, underline fields, ember primary, mode switch, no Apple. Error text in terracotta. "Sign in with iPhone" is a text button that routes to a QR panel (can be a stub until Task 11).

- [ ] **Step 3: Manual check** — `npm run dev`, fields and mode switch render. No cards-in-cards, no status dots.

- [ ] **Step 4: Commit**

```bash
git add product/web
git commit -m "feat(web): Editorial Ember login against Better Auth cookies"
```

---

### Task 11: Sign in with iPhone + `/cli-login`

**Files:**
- Create: `product/web/src/api/device.js`
- Create: `product/web/src/pages/CliLogin.tsx`
- Modify: `product/web/src/pages/Login.tsx` (QR panel)
- Modify: `product/web/src/App.tsx` routes

**Interfaces:**
- `startWebLogin()` → `POST /v1/auth/device/start` `{ client: "web", machineName, platform: "web" }`
- Poll `POST /v1/auth/device/token` `{ deviceCode }` until 200 + cookie
- QR payload: `${cloudDeviceLoginUrl}#code=${userCode}` — use `verificationUriComplete` from start. Do not put `deviceCode` in the QR.
- `/cli-login`: read `#code=`. Inspect. If `client === "web"`: do not auto-approve as CLI. If `client === "cli"` and no session: render Login with hash preserved; after session, `POST /v1/auth/device/approve`. Confirm copy: “Only continue if you just ran relay login on this computer.”

- [ ] **Step 1: Implement device.js + pages**

- [ ] **Step 2: Manual: start a device code with curl `client:web`, show QR, approve from the phone scanner (or curl inspect/approve), browser lands on `/machines` stub**

- [ ] **Step 3: Commit**

```bash
git add product/web
git commit -m "feat(web): phone QR sign-in and CLI auto-approve landing"
```

---

### Task 12: Provisioning, machines, waitlist, activity

**Files:**
- Create: `product/web/src/pages/Provisioning.tsx`
- Create: `product/web/src/pages/Machines.tsx`
- Create: `product/web/src/pages/Activity.tsx`
- Create: `product/web/src/api/grant.js`

**Interfaces:**
- After signup: `POST /v1/pairing/sessions` then `POST /v1/trial-nodes` with that pair; poll `GET /v1/trial-nodes/current` until `ready` or `failed`. Stages: Creating / Booting / Ready. No Pairing row. Retry on failed.
- Machines: `GET /v1/nodes` + current trial. Kind words `TRIAL` / `YOUR MACHINE`. Status words. At `nodes.max`, waitlist `POST /v1/waitlist` with the account email; joined → “On the waitlist.”
- Activity: `POST /v1/nodes/:id/browser-grants` then `GET ${gatewayUrl}/activity/jobs` and `/activity/threads` with the grant. On 401, remint once. Failure copy: “Can't reach this machine.” Empty: “No runs yet.” No composer, no files.
- Do not offer trial destroy.

- [ ] **Step 1: Implement pages**

- [ ] **Step 2: Manual against a local `startTestApp` or the live API with a throwaway account (delete after). Do not log passwords.**

- [ ] **Step 3: Commit**

```bash
git add product/web
git commit -m "feat(web): trial provisioning, machines, waitlist, and live activity"
```

---

### Task 13: Marketing Sign in link

**Files:**
- Modify: `pocs/relay/site/src/App.tsx` (topbar)
- Modify: `pocs/relay/site` env example if one exists

Replace “Private beta” (or add beside it) with `Sign in` → `import.meta.env.VITE_RELAY_APP_ORIGIN || "#"` + `/login`. No auth code in the marketing bundle.

- [ ] **Step 1: Add the link**

- [ ] **Step 2: Commit**

```bash
git add pocs/relay/site
git commit -m "feat(site): point Sign in at the Relay web app origin"
```

---

### Task 14: Docs + operator env (no secret values)

**Files:**
- Modify: `product/cloud/README.md` (device `client`, browser-grants, `RELAY_WEB_ORIGINS`, `DEVICE_LOGIN_URL`, grant key names)
- Modify: `product/STATUS.md` Web v0 row → partial/done as appropriate
- Modify: `docs/RELAY_ARCHITECTURE.md` known-gap `DEVICE_LOGIN_URL` — page now exists; still note it must be set on the host
- Do **not** write private keys or `/etc/relay-cloud/env` values

Operator checklist (document only):

1. Generate Ed25519 grant keypair on the control-plane host; set `BROWSER_GRANT_PRIVATE_KEY` / `BROWSER_GRANT_PUBLIC_KEY`.
2. Set `DEVICE_LOGIN_URL=https://<app-origin>/cli-login`.
3. Set `RELAY_WEB_ORIGINS=https://<app-origin>`.
4. Set `GRANT_GATEWAY_URL=https://gateway.<api-zone>`.
5. Deploy gateway unit + nginx on the broker host.
6. Do not deploy web via CodeCommit `relay-cloud` or `ops/deploy-poc`.

- [ ] **Step 1: Write the docs**

- [ ] **Step 2: Commit**

```bash
git add product/cloud/README.md product/STATUS.md docs/RELAY_ARCHITECTURE.md
git commit -m "docs: web console env, grants, and DEVICE_LOGIN_URL"
```

---

## Self-review (plan vs spec)

| Spec section | Task |
|---|---|
| §3.2 / §6 device `cli`\|`web` | 1, 2 |
| inspect/approve lookup-first + web-while-CLI-linked | 2 |
| Better Auth cookies + trustedOrigins | 3 |
| §3.4 Ed25519 (no HMAC secret) | 4, 5 |
| §3.3 authorize() first-branch precedence | 6 |
| enroll public key | 5, 7 |
| §3.5 gateway + ingress | 8, 9 |
| §5 screens | 10–12 |
| Marketing Sign in | 13 |
| §7 unrevocable grants accepted | 5 (`expiresIn` 900), 14 |
| §8 hosting hard rules | 9, 14 |
| iOS untouched | no iOS task |
| Trial destroy not offered | 12 |
| Content-free cloud | 5 claims only; 8 no body logs |

No `BROWSER_GRANT_SECRET` appears as an implementation step. No cloud proxy of activity. No product-domain cutover task.
