# Trial Sandbox at Signup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every new signup can tap "Try instantly" and get a working trial machine — a Cube (E2B-protocol) microVM running relayd as a normal broker-tunneled node — paired to their phone with no QR, expiring after 7 days.

**Architecture:** relay-cloud gains an E2B-protocol provisioner, a `trial_nodes` lifecycle table, and token-authed enroll; the Go broker resolves unknown node ids dynamically from the cloud's existing `/v1/tunnel/nodes/:id` hook; relayd gains a non-interactive `enroll` command plus a trial-only pairing transport that delivers a node-minted p12 through the already-tested cloud rendezvous; iOS gains a fork screen, provisioning progress, a runtime-mutable node store, and trial lifecycle UI. Spec: `revamp/07-trial-sandbox-plan.md`.

**Tech Stack:** Node 22 stdlib-only (cloud + relayd, `node:test`), Go stdlib-only (broker), SwiftUI + CryptoKit (iOS, XCTest), openssl CLI for X.509/p12, E2B REST protocol (Cube self-hosted).

## Global Constraints

- **NO git commits, checkouts, or stashes — ever.** The uncommitted working tree is the baseline; the owner commits after review. Every task ends at "tests pass", not "commit".
- Zero new npm/Go dependencies. Cloud + relayd use Node stdlib (`node:http(s)`, `node:crypto`, `node:sqlite`); broker uses Go stdlib; X.509/p12 work shells out to `openssl`.
- Secrets never appear in argv, logs, JSON responses, source, or docs. Broker registry token comes from a file (`-registry-token-file`), not a flag value.
- Docs use genericized placeholders — never live hostnames/IPs.
- DB conventions (cloud): TEXT/INTEGER columns only, UUID ids minted in JS, epoch-ms INTEGER timestamps, `?` placeholders, idempotent `CREATE TABLE IF NOT EXISTS` appended to `SCHEMA` in `db.js`.
- relayd env vars are `RELAYD_*`; cloud trial config is `TRIAL_*` / `E2B_*`; parse with the existing helpers (`parseIntegerEnv`, `cleanOptionalUrlBase`, …).
- New cloud routes resolving a node/trial by id MUST repeat the ownership check (`row.accountId !== account.id → 404`) — the registry does not scope reads.
- iOS: no new third-party code; bundle id, target names, branding unchanged; new copy says "machine", never "sandbox".
- Existing suites must stay green: cloud 16+, relayd 102+, broker `go test ./...`, iOS 79+ XCTests.

## Interface Contracts (canonical — later tasks must match these exactly)

- Trial states: `"creating" | "ready" | "expired" | "destroyed" | "failed"`.
- Trial API (cloud): `POST /v1/trial-nodes` body `{pairingId, pairingSecret}` → 201 `{trial}`; `GET /v1/trial-nodes/current` → 200 `{trial}` | 404; `DELETE /v1/trial-nodes/current` → 204; `POST /v1/trial-nodes/enroll` body `{token, nodeId, pubkey, version}` → 200 `{ok:true, sni}`.
  `trial` JSON shape: `{id, state, nodeId, sni, createdAt, expiresAt}` (`nodeId`/`sni` null until enrolled).
- Enroll token: 32 random bytes base64url; only `sha256Hex(token)` stored.
- Node id doubles as the SNI label: relayd's `node-<16 hex>` becomes the cloud node row id. SNI = `${nodeId}${TUNNEL_SUFFIX}`.
- Trial pairing (v1, trial tier only — documented delta from zero-knowledge BYO pairing): phone generates secret `S` (24 bytes base64url, same alphabet as relayd's session token); `authToken = base64url(sha256("relay-pair-auth-v1" || 0x00 || S))`; `macKey = HMAC-SHA256(key=S, msg="relay-pair-mac-v1")`; blob tag = `base64(HMAC-SHA256(macKey, slotName || 0x00 || blob))` with slot names `"device-blob"`/`"node-blob"` (identical to `product/relayd/src/pairing.mjs:147-193`). Node blob = raw PKCS#12 bytes; p12 passphrase = `hex(HMAC-SHA256(key=S, msg="relay-trial-p12-v1"))`. Device blob = UTF-8 JSON `{deviceName, platform}`.

---

## Phase 1 — Cloud: provisioner + trial lifecycle (`product/cloud`)

### Task 1: E2B-protocol provisioner client

**Files:**
- Create: `product/cloud/src/provisioner.js`
- Modify: `product/cloud/src/config.js` (add trial/e2b/tunnel keys)
- Test: `product/cloud/test/provisioner.test.mjs`

**Interfaces:**
- Produces: `createProvisioner(config)` → `null` when `config.e2b.apiUrl` is empty, else `{ async createSandbox({envVars, metadata}) → {sandboxId}, async killSandbox(sandboxId) → boolean, async pauseSandbox(sandboxId) → boolean }`. Throws `Error("provisioner_http_<status>")` on non-2xx (404 on kill/pause returns `false`, not throw).
- Produces (config): `config.e2b = {apiUrl, apiKey, templateId}`; `config.trial = {ttlSec (default 604800), graceSec (default 259200), maxActive (default 20), sandboxTimeoutMs (default 3600000)}`; `config.tunnel = {host, port (default 80), suffix}`.

- [ ] **Step 1: Write the failing test**

```js
// product/cloud/test/provisioner.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { loadConfig } from "../src/config.js";
import { createProvisioner } from "../src/provisioner.js";

function startFakeCube(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, apiKey: req.headers["x-api-key"], body: body ? JSON.parse(body) : null });
        handler(req, res, calls.at(-1));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        calls,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test("createProvisioner returns null when no endpoint is configured", () => {
  const config = loadConfig({});
  assert.equal(createProvisioner(config), null);
});

test("createSandbox posts the E2B create body and returns sandboxId", async () => {
  const fake = await startFakeCube((req, res, call) => {
    res.writeHead(201, { "content-type": "application/json" });
    res.end(JSON.stringify({ sandboxID: "sbx_123", clientID: "c1", templateID: call.body.templateID }));
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k-test", TRIAL_TEMPLATE_ID: "relay-trial" });
    const prov = createProvisioner(config);
    const out = await prov.createSandbox({ envVars: { RELAYD_ENROLL_TOKEN: "t" }, metadata: { trialId: "tr1" } });
    assert.equal(out.sandboxId, "sbx_123");
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(fake.calls[0].url, "/sandboxes");
    assert.equal(fake.calls[0].apiKey, "k-test");
    assert.equal(fake.calls[0].body.templateID, "relay-trial");
    assert.equal(fake.calls[0].body.envVars.RELAYD_ENROLL_TOKEN, "t");
    assert.equal(fake.calls[0].body.metadata.trialId, "tr1");
    assert.equal(typeof fake.calls[0].body.timeout, "number");
  } finally {
    await fake.close();
  }
});

test("killSandbox deletes; 404 is false, 500 throws", async () => {
  let status = 204;
  const fake = await startFakeCube((req, res) => {
    res.writeHead(status);
    res.end();
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "tpl" });
    const prov = createProvisioner(config);
    assert.equal(await prov.killSandbox("sbx_1"), true);
    assert.equal(fake.calls[0].method, "DELETE");
    assert.equal(fake.calls[0].url, "/sandboxes/sbx_1");
    status = 404;
    assert.equal(await prov.killSandbox("sbx_1"), false);
    status = 500;
    await assert.rejects(() => prov.killSandbox("sbx_1"), /provisioner_http_500/);
  } finally {
    await fake.close();
  }
});

test("pauseSandbox posts pause", async () => {
  const fake = await startFakeCube((req, res) => {
    res.writeHead(204);
    res.end();
  });
  try {
    const config = loadConfig({ E2B_API_URL: fake.url, E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "tpl" });
    const prov = createProvisioner(config);
    assert.equal(await prov.pauseSandbox("sbx_9"), true);
    assert.equal(fake.calls[0].method, "POST");
    assert.equal(fake.calls[0].url, "/sandboxes/sbx_9/pause");
  } finally {
    await fake.close();
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/cloud && node --test test/provisioner.test.mjs`
Expected: FAIL — `Cannot find module '../src/provisioner.js'`.

- [ ] **Step 3: Implement config keys + provisioner**

In `product/cloud/src/config.js`, inside the object returned by `loadConfig`, after the `defaultMaxNodes` entry add:

```js
    // Trial sandboxes (Cube / E2B protocol). An empty apiUrl disables the
    // whole trial feature — routes 404 and the fork screen hides the option.
    e2b: {
      apiUrl: (env.E2B_API_URL || "").replace(/\/+$/, ""),
      apiKey: env.E2B_API_KEY || "",
      templateId: env.TRIAL_TEMPLATE_ID || "",
    },
    trial: {
      ttlSec: intFrom(env.TRIAL_TTL_SEC, 7 * 24 * 3600),
      graceSec: intFrom(env.TRIAL_GRACE_SEC, 3 * 24 * 3600),
      maxActive: intFrom(env.TRIAL_MAX_ACTIVE, 20),
      sandboxTimeoutMs: intFrom(env.TRIAL_SANDBOX_TIMEOUT_MS, 3600 * 1000),
    },
    tunnel: {
      host: env.TUNNEL_HOST || "",
      port: intFrom(env.TUNNEL_PORT, 80),
      suffix: env.TUNNEL_SUFFIX || "",
    },
```

Create `product/cloud/src/provisioner.js`:

```js
// E2B-protocol sandbox provisioner. Works against a self-hosted Cube host
// today and hosted e2b later — only the endpoint and key change. The API
// key is a server-side secret: it never appears in logs or responses.

export function createProvisioner(config) {
  const { apiUrl, apiKey, templateId } = config.e2b;
  if (!apiUrl) return null;

  async function call(method, path, body) {
    const res = await fetch(`${apiUrl}${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }

  return {
    async createSandbox({ envVars = {}, metadata = {} } = {}) {
      const res = await call("POST", "/sandboxes", {
        templateID: templateId,
        timeout: config.trial.sandboxTimeoutMs,
        envVars,
        metadata,
      });
      if (!res.ok) throw new Error(`provisioner_http_${res.status}`);
      const json = await res.json();
      return { sandboxId: json.sandboxID };
    },

    async killSandbox(sandboxId) {
      const res = await call("DELETE", `/sandboxes/${encodeURIComponent(sandboxId)}`);
      if (res.status === 404) return false;
      if (!res.ok && res.status !== 204) throw new Error(`provisioner_http_${res.status}`);
      return true;
    },

    async pauseSandbox(sandboxId) {
      const res = await call("POST", `/sandboxes/${encodeURIComponent(sandboxId)}/pause`);
      if (res.status === 404) return false;
      if (!res.ok && res.status !== 204) throw new Error(`provisioner_http_${res.status}`);
      return true;
    },
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/cloud && node --test test/provisioner.test.mjs`
Expected: 4 pass / 0 fail.

- [ ] **Step 5: Full cloud suite still green**

Run: `cd product/cloud && node --test test/*.test.mjs`
Expected: previous 16+ tests plus the new 4, 0 fail. Do NOT commit.

### Task 2: `trial_nodes` table + registry functions + explicit-id `createNode`

**Files:**
- Modify: `product/cloud/src/db.js` (append to `SCHEMA`), `product/cloud/src/registry.js`
- Test: `product/cloud/test/trial-registry.test.mjs`

**Interfaces:**
- Produces (registry): `createTrialNode({accountId, enrollTokenHash, expiresAt})` → trial row (id = randomUUID, state `"creating"`); `getTrialByAccount(accountId)` → row | null (the single lifetime row); `getTrialByTokenHash(hash)` → row | null; `updateTrial(id, patch)` → row | null, patch keys from `{state, nodeId, sandboxId, enrollTokenHash, expiresAt}` (only keys `!== undefined` applied; `enrollTokenHash: null` clears it); `listTrialsDue(nowMs)` → rows with `state = "ready"|"creating"` and `expiresAt <= nowMs`; `listTrialsPastGrace(nowMs, graceMs)` → rows with `state = "expired"` and `expiresAt + graceMs <= nowMs`; `countActiveTrials()` → Number of rows in state `creating|ready`.
- Trial row shape: `{id, accountId, nodeId, sandboxId, enrollTokenHash, state, createdAt, expiresAt, updatedAt}` (camelCase, epoch-ms Numbers, nulls allowed for nodeId/sandboxId/enrollTokenHash).
- Produces (changed): `createNode(accountId, {id = randomUUID(), kind, name, pubkey, version})` — new optional `id`; all existing callers unaffected.
- Consumes: `sha256Hex` already exists in registry.js internals; reuse the same pattern (`createHash("sha256").update(v).digest("hex")`).

- [ ] **Step 1: Write the failing test**

```js
// product/cloud/test/trial-registry.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";

function freshRegistry(clock = { t: 1_000_000 }) {
  const db = createDb(":memory:");
  return { registry: createRegistry(db, { now: () => clock.t }), clock, db };
}

test("trial rows: create, one-per-account read, token lookup, patch", () => {
  const { registry, clock } = freshRegistry();
  const acct = registry.createAccount({ email: "t@example.com" });
  const row = registry.createTrialNode({ accountId: acct.id, enrollTokenHash: "h1", expiresAt: clock.t + 1000 });
  assert.equal(row.state, "creating");
  assert.equal(row.accountId, acct.id);
  assert.equal(row.nodeId, null);
  assert.equal(registry.getTrialByAccount(acct.id).id, row.id);
  assert.equal(registry.getTrialByTokenHash("h1").id, row.id);
  assert.equal(registry.getTrialByTokenHash("nope"), null);

  const patched = registry.updateTrial(row.id, { state: "ready", nodeId: "node-aabbccdd00112233", sandboxId: "sbx_1", enrollTokenHash: null });
  assert.equal(patched.state, "ready");
  assert.equal(patched.nodeId, "node-aabbccdd00112233");
  assert.equal(patched.enrollTokenHash, null);
  // Second trial for the same account must violate the UNIQUE(account_id).
  assert.throws(() => registry.createTrialNode({ accountId: acct.id, enrollTokenHash: "h2", expiresAt: clock.t + 1000 }));
});

test("due/grace scans and active count", () => {
  const { registry, clock } = freshRegistry();
  const a1 = registry.createAccount({ email: "a1@example.com" });
  const a2 = registry.createAccount({ email: "a2@example.com" });
  const r1 = registry.createTrialNode({ accountId: a1.id, enrollTokenHash: "h1", expiresAt: clock.t + 100 });
  const r2 = registry.createTrialNode({ accountId: a2.id, enrollTokenHash: "h2", expiresAt: clock.t + 5000 });
  registry.updateTrial(r1.id, { state: "ready" });
  assert.equal(registry.countActiveTrials(), 2);

  clock.t += 200; // r1 past expiry, r2 not
  const due = registry.listTrialsDue(clock.t);
  assert.deepEqual(due.map((r) => r.id), [r1.id]);

  registry.updateTrial(r1.id, { state: "expired" });
  assert.equal(registry.countActiveTrials(), 1);
  assert.equal(registry.listTrialsPastGrace(clock.t, 1000).length, 0);
  clock.t += 2000;
  assert.deepEqual(registry.listTrialsPastGrace(clock.t, 1000).map((r) => r.id), [r1.id]);
});

test("createNode accepts an explicit id and keeps generating ids otherwise", () => {
  const { registry } = freshRegistry();
  const acct = registry.createAccount({ email: "n@example.com" });
  const explicit = registry.createNode(acct.id, { id: "node-0123456789abcdef", kind: "trial", name: "Trial machine", pubkey: "pk", version: null });
  assert.equal(explicit.id, "node-0123456789abcdef");
  const generated = registry.createNode(acct.id, { kind: "byo", name: null, pubkey: "pk2", version: null });
  assert.match(generated.id, /^[0-9a-f-]{36}$/);
});

test("deleteAccount removes trial rows", () => {
  const { registry, clock } = freshRegistry();
  const acct = registry.createAccount({ email: "d@example.com" });
  registry.createTrialNode({ accountId: acct.id, enrollTokenHash: "h", expiresAt: clock.t + 10 });
  assert.equal(registry.deleteAccount(acct.id), true);
  assert.equal(registry.getTrialByAccount(acct.id), null);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/cloud && node --test test/trial-registry.test.mjs`
Expected: FAIL — `registry.createTrialNode is not a function`.

- [ ] **Step 3: Implement schema + registry functions**

In `product/cloud/src/db.js`, append to the `SCHEMA` template literal (before the index block at the end):

```sql
CREATE TABLE IF NOT EXISTS trial_nodes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  node_id TEXT,
  sandbox_id TEXT,
  enroll_token_hash TEXT,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_state_expires ON trial_nodes (state, expires_at);
```

In `product/cloud/src/registry.js`:

1. Change `createNode` (line ~344) to accept an explicit id:

```js
  function createNode(accountId, { id = randomUUID(), kind, name, pubkey, version }) {
    db.prepare(
      "INSERT INTO nodes (id, account_id, kind, name, pubkey, version, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)",
    ).run(id, accountId, kind, name ?? null, pubkey, version ?? null, now());
    return getNode(id);
  }
```

(Keep the body identical to the current implementation apart from the destructured `id` default — read the current lines first and preserve any details.)

2. Add the trial functions next to the node functions:

```js
  const TRIAL_PATCH_COLUMNS = {
    state: "state",
    nodeId: "node_id",
    sandboxId: "sandbox_id",
    enrollTokenHash: "enroll_token_hash",
    expiresAt: "expires_at",
  };

  function mapTrial(row) {
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      nodeId: row.node_id,
      sandboxId: row.sandbox_id,
      enrollTokenHash: row.enroll_token_hash,
      state: row.state,
      createdAt: Number(row.created_at),
      expiresAt: Number(row.expires_at),
      updatedAt: Number(row.updated_at),
    };
  }

  function createTrialNode({ accountId, enrollTokenHash, expiresAt }) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO trial_nodes (id, account_id, node_id, sandbox_id, enroll_token_hash, state, created_at, expires_at, updated_at) VALUES (?, ?, NULL, NULL, ?, 'creating', ?, ?, ?)",
    ).run(id, accountId, enrollTokenHash, now(), expiresAt, now());
    return getTrialById(id);
  }

  function getTrialById(id) {
    return mapTrial(db.prepare("SELECT * FROM trial_nodes WHERE id = ?").get(id));
  }

  function getTrialByAccount(accountId) {
    return mapTrial(db.prepare("SELECT * FROM trial_nodes WHERE account_id = ?").get(accountId));
  }

  function getTrialByTokenHash(hash) {
    if (!hash) return null;
    return mapTrial(db.prepare("SELECT * FROM trial_nodes WHERE enroll_token_hash = ?").get(hash));
  }

  function updateTrial(id, patch) {
    const sets = [];
    const values = [];
    for (const [key, column] of Object.entries(TRIAL_PATCH_COLUMNS)) {
      if (patch[key] !== undefined) {
        sets.push(`${column} = ?`);
        values.push(patch[key]);
      }
    }
    if (sets.length > 0) {
      sets.push("updated_at = ?");
      values.push(now(), id);
      db.prepare(`UPDATE trial_nodes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    }
    return getTrialById(id);
  }

  function listTrialsDue(nowMs) {
    return db
      .prepare("SELECT * FROM trial_nodes WHERE state IN ('creating','ready') AND expires_at <= ? ORDER BY expires_at")
      .all(nowMs)
      .map(mapTrial);
  }

  function listTrialsPastGrace(nowMs, graceMs) {
    return db
      .prepare("SELECT * FROM trial_nodes WHERE state = 'expired' AND expires_at + ? <= ? ORDER BY expires_at")
      .all(graceMs, nowMs)
      .map(mapTrial);
  }

  function countActiveTrials() {
    return Number(db.prepare("SELECT COUNT(*) AS c FROM trial_nodes WHERE state IN ('creating','ready')").get().c);
  }
```

3. Add all eight names (`createTrialNode, getTrialById, getTrialByAccount, getTrialByTokenHash, updateTrial, listTrialsDue, listTrialsPastGrace, countActiveTrials`) to the returned method list (registry.js:680-731).
4. In `deleteAccount`'s transaction (registry.js:145-161), add `db.prepare("DELETE FROM trial_nodes WHERE account_id = ?").run(accountId);` alongside the other per-account deletes.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/cloud && node --test test/trial-registry.test.mjs`
Expected: 4 pass / 0 fail.

- [ ] **Step 5: Full cloud suite green**

Run: `cd product/cloud && node --test test/*.test.mjs`
Expected: all pass, 0 fail.

### Task 3: Trial routes — create / current / delete

**Files:**
- Modify: `product/cloud/src/server.js`
- Test: `product/cloud/test/trial-api.test.mjs`

**Interfaces:**
- Consumes: Task 1 provisioner (injected into `createApp` as `provisioner` option, defaulting to `createProvisioner(config)`), Task 2 registry functions.
- Produces: routes per the Interface Contracts block. Trial JSON via a `publicTrial(trial, config)` helper: `{id, state, nodeId, sni: trial.nodeId ? trial.nodeId + config.tunnel.suffix : null, createdAt, expiresAt}` — **never** `enrollTokenHash`/`sandboxId`/`accountId`.
- Error taxonomy: 404 `{error:"trial_unavailable"}` when provisioner null; 409 `{error:"trial_already_used"}`; 503 `{error:"trial_capacity"}`; 502 `{error:"provision_failed"}` (sandbox create threw; row moved to `failed`); 400 `{error:"pairing_required"}` (missing/invalid `pairingId` or `pairingSecret`).

- [ ] **Step 1: Write the failing test**

```js
// product/cloud/test/trial-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

function makeFakeProvisioner() {
  const created = [];
  return {
    created,
    failNext: false,
    async createSandbox(opts) {
      if (this.failNext) throw new Error("provisioner_http_500");
      created.push(opts);
      return { sandboxId: `sbx_${created.length}` };
    },
    killed: [],
    async killSandbox(id) { this.killed.push(id); return true; },
    paused: [],
    async pauseSandbox(id) { this.paused.push(id); return true; },
  };
}

const TRIAL_ENV = { E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial", TUNNEL_HOST: "broker.test", TUNNEL_PORT: "80", TUNNEL_SUFFIX: ".tun.test" };
const PAIRING = { pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ" };

test("trial create: 201, sandbox env carries enroll+pairing+tunnel, poll shows creating", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await signIn(t);
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
    assert.equal(res.status, 201);
    assert.equal(res.json.trial.state, "creating");
    assert.equal(res.json.trial.nodeId, null);
    assert.equal(res.json.trial.sni, null);
    assert.ok(!("enrollTokenHash" in res.json.trial));
    assert.ok(!("sandboxId" in res.json.trial));

    const env = provisioner.created[0].envVars;
    assert.equal(env.RELAYD_ENROLL_PAIRING_ID, PAIRING.pairingId);
    assert.equal(env.RELAYD_ENROLL_PAIRING_SECRET, PAIRING.pairingSecret);
    assert.equal(env.RELAYD_TUNNEL_HOST, "broker.test");
    assert.equal(env.RELAYD_TUNNEL_PORT, "80");
    assert.equal(env.RELAYD_TUNNEL_SUFFIX, ".tun.test");
    assert.match(env.RELAYD_ENROLL_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.match(env.RELAYD_ENROLL_URL, /^http:\/\/127\.0\.0\.1:\d+$/);

    res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(res.status, 200);
    assert.equal(res.json.trial.state, "creating");
  } finally {
    await t.close();
  }
});

test("trial create: lifetime one per account (409), capacity 503, disabled 404, failure 502", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: { ...TRIAL_ENV, TRIAL_MAX_ACTIVE: "1" }, provisioner });
  try {
    const s1 = await signIn(t);
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s1.sessionToken) });
    assert.equal(res.status, 201);
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s1.sessionToken) });
    assert.equal(res.status, 409);
    assert.equal(res.json.error, "trial_already_used");
  } finally {
    await t.close();
  }

  // capacity: second ACCOUNT hits the global active cap
  const prov2 = makeFakeProvisioner();
  const t2 = await startTestApp({ env: { ...TRIAL_ENV, TRIAL_MAX_ACTIVE: "1" }, provisioner: prov2 });
  try {
    const a = await signIn(t2);
    await api(t2.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(a.sessionToken) });
    const b = await signIn(t2, { sub: "apple-sub-2", email: "second@example.com" });
    const res = await api(t2.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(b.sessionToken) });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, "trial_capacity");
  } finally {
    await t2.close();
  }

  // disabled: no E2B endpoint configured
  const t3 = await startTestApp();
  try {
    const s = await signIn(t3);
    const res = await api(t3.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    assert.equal(res.status, 404);
    assert.equal(res.json.error, "trial_unavailable");
  } finally {
    await t3.close();
  }

  // provision failure: row lands in failed, response 502
  const prov4 = makeFakeProvisioner();
  prov4.failNext = true;
  const t4 = await startTestApp({ env: TRIAL_ENV, provisioner: prov4 });
  try {
    const s = await signIn(t4);
    const res = await api(t4.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, "provision_failed");
    const row = t4.app.registry.getTrialByAccount(s.accountId);
    assert.equal(row.state, "failed");
  } finally {
    await t4.close();
  }
});

test("trial delete: kills sandbox, removes node row, marks destroyed", async () => {
  const provisioner = makeFakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    // Simulate a completed enroll so a node row exists.
    const trial = t.app.registry.getTrialByAccount(s.accountId);
    t.app.registry.createNode(s.accountId, { id: "node-00112233aabbccdd", kind: "trial", name: "Trial machine", pubkey: "pk", version: null });
    t.app.registry.updateTrial(trial.id, { state: "ready", nodeId: "node-00112233aabbccdd", sandboxId: "sbx_1" });

    const res = await api(t.baseUrl, "DELETE", "/v1/trial-nodes/current", authed(s.sessionToken));
    assert.equal(res.status, 204);
    assert.deepEqual(provisioner.killed, ["sbx_1"]);
    assert.equal(t.app.registry.getNode("node-00112233aabbccdd"), null);
    assert.equal(t.app.registry.getTrialByAccount(s.accountId).state, "destroyed");
  } finally {
    await t.close();
  }
});
```

Note: `signIn(t, {sub, email})` — check `test/helpers.mjs:150`; if `signIn` does not accept overrides, extend it to pass `{sub, email}` through to `idp.mintIdentityToken` (backward-compatible default args).

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/cloud && node --test test/trial-api.test.mjs`
Expected: FAIL — 404 `not_found` on `/v1/trial-nodes` (route absent). Also fix `startTestApp` to forward a `provisioner` override into `createApp` (add `provisioner: overrides.provisioner` to the `createApp` call in helpers.mjs) as part of Step 3.

- [ ] **Step 3: Implement the routes**

In `product/cloud/src/server.js`:

1. Imports: add `import { randomBytes, createHash } from "node:crypto";` (merge with the existing `node:crypto` import) and `import { createProvisioner } from "./provisioner.js";`.
2. `createApp` signature: add `provisioner = createProvisioner(config)` to the destructured options.
3. Helper near the bottom:

```js
function publicTrial(trial, config) {
  return {
    id: trial.id,
    state: trial.state,
    nodeId: trial.nodeId,
    sni: trial.nodeId && config.tunnel.suffix ? `${trial.nodeId}${config.tunnel.suffix}` : null,
    createdAt: trial.createdAt,
    expiresAt: trial.expiresAt,
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}
```

4. Routes, inside the session-authed section (after the `/v1/nodes` handlers, before the final 404):

```js
    if (path === "/v1/trial-nodes" && method === "POST") {
      if (!provisioner) return sendJson(res, 404, { error: "trial_unavailable" });
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const pairingId = typeof body?.pairingId === "string" ? body.pairingId : "";
      const pairingSecret = typeof body?.pairingSecret === "string" ? body.pairingSecret : "";
      if (!/^[0-9a-f-]{36}$/.test(pairingId) || !/^[A-Za-z0-9_-]{22,128}$/.test(pairingSecret)) {
        return sendJson(res, 400, { error: "pairing_required" });
      }
      if (registry.getTrialByAccount(account.id)) {
        return sendJson(res, 409, { error: "trial_already_used" });
      }
      if (registry.countActiveTrials() >= config.trial.maxActive) {
        return sendJson(res, 503, { error: "trial_capacity" });
      }
      const enrollToken = randomBytes(32).toString("base64url");
      const trial = registry.createTrialNode({
        accountId: account.id,
        enrollTokenHash: sha256Hex(enrollToken),
        expiresAt: now() + config.trial.ttlSec * 1000,
      });
      try {
        const { sandboxId } = await provisioner.createSandbox({
          envVars: {
            RELAYD_ENROLL_URL: config.enrollBaseUrl || `http://${config.host}:${config.port}`,
            RELAYD_ENROLL_TOKEN: enrollToken,
            RELAYD_ENROLL_PAIRING_ID: pairingId,
            RELAYD_ENROLL_PAIRING_SECRET: pairingSecret,
            RELAYD_TUNNEL_HOST: config.tunnel.host,
            RELAYD_TUNNEL_PORT: String(config.tunnel.port),
            RELAYD_TUNNEL_SUFFIX: config.tunnel.suffix,
          },
          metadata: { trialId: trial.id },
        });
        registry.updateTrial(trial.id, { sandboxId });
      } catch {
        registry.updateTrial(trial.id, { state: "failed", enrollTokenHash: null });
        return sendJson(res, 502, { error: "provision_failed" });
      }
      return sendJson(res, 201, { trial: publicTrial(registry.getTrialById(trial.id), config) });
    }

    if (path === "/v1/trial-nodes/current" && method === "GET") {
      const trial = registry.getTrialByAccount(account.id);
      if (!trial) return sendJson(res, 404, { error: "no_trial" });
      return sendJson(res, 200, { trial: publicTrial(trial, config) });
    }

    if (path === "/v1/trial-nodes/current" && method === "DELETE") {
      const trial = registry.getTrialByAccount(account.id);
      if (!trial) return sendJson(res, 404, { error: "no_trial" });
      if (trial.sandboxId && provisioner) {
        try { await provisioner.killSandbox(trial.sandboxId); } catch {}
      }
      if (trial.nodeId) registry.deleteNode(account.id, trial.nodeId);
      registry.updateTrial(trial.id, { state: "destroyed", enrollTokenHash: null });
      return sendJson(res, 204, null);
    }
```

Also add `enrollBaseUrl: env.ENROLL_BASE_URL || ""` to `loadConfig` (the public cloud URL the sandbox reaches; tests fall back to host:port). Note `startTestApp` binds an ephemeral port, so in tests the fallback uses `config.port` = the CONFIGURED port, not the bound one — set `ENROLL_BASE_URL` is the production path; for the test assertion `RELAYD_ENROLL_URL` matches `http://127.0.0.1:<configured port>`; keep the assertion regex loose (`/^http:\/\/127\.0\.0\.1:\d+$/`) as written.
5. Expose the provisioner on the returned app object (`{ server, registry, ..., provisioner }`) for the reaper task.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/cloud && node --test test/trial-api.test.mjs`
Expected: 3 pass / 0 fail.

- [ ] **Step 5: Full cloud suite green**

Run: `cd product/cloud && node --test test/*.test.mjs`
Expected: all pass, 0 fail.

### Task 4: Enroll endpoint (token-authed, called from inside the sandbox)

**Files:**
- Modify: `product/cloud/src/server.js`
- Test: `product/cloud/test/trial-enroll.test.mjs`

**Interfaces:**
- Produces: `POST /v1/trial-nodes/enroll` — body `{token, nodeId, pubkey, version}`. NOT session-authed (placed with the public/token-authed routes BEFORE the session gate). Validates: token hash matches a trial row in state `creating` (else 401 `{error:"invalid_enroll_token"}`); `nodeId` matches `/^node-[0-9a-f]{16}$/` (else 400 `{error:"invalid_node_id"}`); `parseNodePubkey(pubkey)` non-null (else 400 `{error:"invalid_pubkey"}`); node id not already taken (else 409 `{error:"node_exists"}`). On success: creates node row `{id: nodeId, kind: "trial", name: "Trial machine", pubkey, version}`, updates trial `{state:"ready", nodeId, enrollTokenHash: null}` (token burned), returns 200 `{ok:true, sni}`.
- Consumes: `parseNodePubkey` (already imported in server.js), Task 2 registry functions.

- [ ] **Step 1: Write the failing test**

```js
// product/cloud/test/trial-enroll.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";

const TRIAL_ENV = { E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial", TUNNEL_SUFFIX: ".tun.test" };
const PAIRING = { pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ" };

async function createTrial(t) {
  const provisioner = t.provisionerRef;
  const session = await signIn(t);
  const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(session.sessionToken) });
  assert.equal(res.status, 201);
  return { session, enrollToken: provisioner.created.at(-1).envVars.RELAYD_ENROLL_TOKEN };
}

function fakeProvisioner() {
  const created = [];
  return { created, async createSandbox(o) { created.push(o); return { sandboxId: "sbx_1" }; }, async killSandbox() { return true; }, async pauseSandbox() { return true; } };
}

test("enroll: valid token registers the node and burns the token", async () => {
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  t.provisionerRef = provisioner;
  try {
    const { session, enrollToken } = await createTrial(t);
    const identity = makeNodeIdentity();
    const nodeId = "node-00112233aabbccdd";
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token: enrollToken, nodeId, pubkey: identity.pubkeyPem, version: "0.1.0" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.sni, `${nodeId}.tun.test`);

    // Node row exists, owned by the trial account, kind trial.
    const node = t.app.registry.getNode(nodeId);
    assert.equal(node.accountId, session.accountId);
    assert.equal(node.kind, "trial");

    // Trial is ready and visible to the account.
    res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(session.sessionToken));
    assert.equal(res.json.trial.state, "ready");
    assert.equal(res.json.trial.sni, `${nodeId}.tun.test`);

    // Token is single-use.
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", {
      body: { token: enrollToken, nodeId: "node-ffffffffffffffff", pubkey: identity.pubkeyPem, version: null },
    });
    assert.equal(res.status, 401);

    // Broker hook resolves the trial node.
    res = await api(t.baseUrl, "GET", `/v1/tunnel/nodes/${nodeId}`, { headers: { authorization: "Bearer test-broker-token-0123456789abcdef" } });
    assert.equal(res.status, 200);
    assert.equal(res.json.kind, "trial");
    assert.equal(res.json.pubkey, identity.pubkeyPem);
  } finally {
    await t.close();
  }
});

test("enroll: bad token 401, bad node id 400, bad pubkey 400", async () => {
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  t.provisionerRef = provisioner;
  try {
    const { enrollToken } = await createTrial(t);
    const identity = makeNodeIdentity();
    let res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", { body: { token: "wrong", nodeId: "node-00112233aabbccdd", pubkey: identity.pubkeyPem } });
    assert.equal(res.status, 401);
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", { body: { token: enrollToken, nodeId: "NODE-UPPER", pubkey: identity.pubkeyPem } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_node_id");
    res = await api(t.baseUrl, "POST", "/v1/trial-nodes/enroll", { body: { token: enrollToken, nodeId: "node-00112233aabbccdd", pubkey: "not-a-key" } });
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_pubkey");
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/cloud && node --test test/trial-enroll.test.mjs`
Expected: FAIL — enroll route 401s via the session gate (route missing).

- [ ] **Step 3: Implement the route**

In `product/cloud/src/server.js`, BEFORE the `const account = await auth.authenticate(req);` line (this endpoint is token-authed, the sandbox has no session), after the tunnel-registry hook block:

```js
    // ── trial enroll (single-use token from the sandbox bootstrap) ─────────
    if (method === "POST" && path === "/v1/trial-nodes/enroll") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const token = typeof body?.token === "string" ? body.token : "";
      const trial = token ? registry.getTrialByTokenHash(sha256Hex(token)) : null;
      if (!trial || trial.state !== "creating") {
        return sendJson(res, 401, { error: "invalid_enroll_token" });
      }
      const nodeId = typeof body?.nodeId === "string" ? body.nodeId : "";
      if (!/^node-[0-9a-f]{16}$/.test(nodeId)) {
        return sendJson(res, 400, { error: "invalid_node_id" });
      }
      if (!parseNodePubkey(body?.pubkey)) {
        return sendJson(res, 400, { error: "invalid_pubkey" });
      }
      if (registry.getNode(nodeId)) {
        return sendJson(res, 409, { error: "node_exists" });
      }
      registry.createNode(trial.accountId, {
        id: nodeId,
        kind: "trial",
        name: "Trial machine",
        pubkey: String(body.pubkey),
        version: strOrNull(body?.version),
      });
      registry.updateTrial(trial.id, { state: "ready", nodeId, enrollTokenHash: null });
      return sendJson(res, 200, { ok: true, sni: config.tunnel.suffix ? `${nodeId}${config.tunnel.suffix}` : nodeId });
    }
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/cloud && node --test test/trial-enroll.test.mjs`
Expected: 2 pass / 0 fail.

- [ ] **Step 5: Full cloud suite green**

Run: `cd product/cloud && node --test test/*.test.mjs`
Expected: all pass, 0 fail.

### Task 5: Trial reaper (expiry → pause; grace → destroy)

**Files:**
- Modify: `product/cloud/src/server.js` (`runSweeps` becomes async-safe; add `sweepTrials`)
- Test: `product/cloud/test/trial-reaper.test.mjs`

**Interfaces:**
- Produces: `async sweepTrials()` on the app object: (1) rows from `listTrialsDue(now())` → `pauseSandbox(sandboxId)` (errors swallowed), state → `"expired"`; (2) rows from `listTrialsPastGrace(now(), graceSec*1000)` → `killSandbox` (errors swallowed), `deleteNode(accountId, nodeId)` when nodeId set, state → `"destroyed"`. Idempotent: re-running moves nothing twice (state guards are in the SQL scans). `runSweeps()` calls `sweepTrials()` fire-and-forget (`.catch(() => {})`) so the existing sync callers (main.js interval) keep working.

- [ ] **Step 1: Write the failing test**

```js
// product/cloud/test/trial-reaper.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const TRIAL_ENV = { E2B_API_URL: "http://cube.invalid", E2B_API_KEY: "k", TRIAL_TEMPLATE_ID: "relay-trial", TRIAL_TTL_SEC: "10", TRIAL_GRACE_SEC: "5", TUNNEL_SUFFIX: ".tun.test" };
const PAIRING = { pairingId: "11111111-1111-4111-8111-111111111111", pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ" };

test("reaper: expiry pauses, grace destroys, idempotent", async () => {
  const paused = [];
  const killed = [];
  const provisioner = {
    async createSandbox() { return { sandboxId: "sbx_1" }; },
    async pauseSandbox(id) { paused.push(id); return true; },
    async killSandbox(id) { killed.push(id); return true; },
  };
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const s = await signIn(t);
    await api(t.baseUrl, "POST", "/v1/trial-nodes", { body: PAIRING, ...authed(s.sessionToken) });
    const trial = t.app.registry.getTrialByAccount(s.accountId);
    t.app.registry.createNode(s.accountId, { id: "node-00112233aabbccdd", kind: "trial", name: "Trial machine", pubkey: "pk", version: null });
    t.app.registry.updateTrial(trial.id, { state: "ready", nodeId: "node-00112233aabbccdd" });

    await t.app.sweepTrials();               // nothing due yet
    assert.deepEqual(paused, []);

    t.clock.t += 11_000;                     // past TTL
    await t.app.sweepTrials();
    assert.deepEqual(paused, ["sbx_1"]);
    assert.equal(t.app.registry.getTrialByAccount(s.accountId).state, "expired");
    const res = await api(t.baseUrl, "GET", "/v1/trial-nodes/current", authed(s.sessionToken));
    assert.equal(res.json.trial.state, "expired");

    await t.app.sweepTrials();               // idempotent within grace
    assert.deepEqual(paused, ["sbx_1"]);
    assert.deepEqual(killed, []);

    t.clock.t += 6_000;                      // past grace
    await t.app.sweepTrials();
    assert.deepEqual(killed, ["sbx_1"]);
    assert.equal(t.app.registry.getTrialByAccount(s.accountId).state, "destroyed");
    assert.equal(t.app.registry.getNode("node-00112233aabbccdd"), null);

    await t.app.sweepTrials();               // idempotent after destroy
    assert.deepEqual(killed, ["sbx_1"]);
  } finally {
    await t.close();
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/cloud && node --test test/trial-reaper.test.mjs`
Expected: FAIL — `t.app.sweepTrials is not a function`.

- [ ] **Step 3: Implement sweepTrials**

In `product/cloud/src/server.js`, next to `runSweeps`:

```js
  async function sweepTrials() {
    if (!provisioner) return;
    for (const trial of registry.listTrialsDue(now())) {
      if (trial.sandboxId) {
        try { await provisioner.pauseSandbox(trial.sandboxId); } catch {}
      }
      registry.updateTrial(trial.id, { state: "expired", enrollTokenHash: null });
    }
    for (const trial of registry.listTrialsPastGrace(now(), config.trial.graceSec * 1000)) {
      if (trial.sandboxId) {
        try { await provisioner.killSandbox(trial.sandboxId); } catch {}
      }
      if (trial.nodeId) registry.deleteNode(trial.accountId, trial.nodeId);
      registry.updateTrial(trial.id, { state: "destroyed" });
    }
  }

  function runSweeps() {
    pairing.sweep();
    notify.sweep();
    sweepTrials().catch((err) => console.error(`trial sweep failed: ${err?.message}`));
  }
```

Add `sweepTrials` to the returned app object.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/cloud && node --test test/trial-reaper.test.mjs`
Expected: 1 pass / 0 fail.

- [ ] **Step 5: Full cloud suite green**

Run: `cd product/cloud && node --test test/*.test.mjs`
Expected: all pass, 0 fail.

---

## Phase 2 — Broker: dynamic node registry (`product/broker`)

### Task 6: HTTP registry resolver with TTL cache

**Files:**
- Create: `product/broker/internal/registry/registry.go`
- Test: `product/broker/internal/registry/registry_test.go`

**Interfaces:**
- Produces: `registry.NewResolver(cfg Config) *Resolver` with

```go
type Config struct {
    URL        string        // cloud base, e.g. http://127.0.0.1:8790 ("" ⇒ resolver disabled, static only)
    Token      string        // BROKER_TOKEN bearer
    HTTPClient *http.Client  // nil ⇒ 3s-timeout default
    PositiveTTL time.Duration // 0 ⇒ 60s
    NegativeTTL time.Duration // 0 ⇒ 10s
    Now        func() time.Time // nil ⇒ time.Now
    Logf       func(string, ...any)
}
func (r *Resolver) Lookup(nodeID string) (ed25519.PublicKey, bool)
```

- Contract with the cloud: `GET {URL}/v1/tunnel/nodes/{id}` with `Authorization: Bearer {Token}`; 200 body `{"nodeId":..., "accountId":..., "kind":..., "pubkey":...}`; 404 unknown. `pubkey` may be an SPKI PEM **or** base64 of the raw 32-byte key (both are accepted by the cloud's `parseNodePubkey`); the resolver parses PEM via the existing `certs.ParseEd25519PublicKeyPEM` and falls back to base64-raw-32.
- `Lookup` satisfies `tunnelauth.VerifyFunc` (`tunnelauth.go:68`).

- [ ] **Step 1: Write the failing test**

```go
// product/broker/internal/registry/registry_test.go
package registry

import (
    "crypto/ed25519"
    "crypto/rand"
    "encoding/base64"
    "net/http"
    "net/http/httptest"
    "sync/atomic"
    "testing"
    "time"
)

func fakeCloud(t *testing.T, pub ed25519.PublicKey, hits *atomic.Int64) *httptest.Server {
    t.Helper()
    return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        hits.Add(1)
        if r.Header.Get("Authorization") != "Bearer tok" {
            w.WriteHeader(http.StatusUnauthorized)
            return
        }
        if r.URL.Path != "/v1/tunnel/nodes/node-0011223344556677" {
            w.WriteHeader(http.StatusNotFound)
            _, _ = w.Write([]byte(`{"error":"unknown_node"}`))
            return
        }
        w.Header().Set("Content-Type", "application/json")
        _, _ = w.Write([]byte(`{"nodeId":"node-0011223344556677","accountId":"a1","kind":"trial","pubkey":"` +
            base64.StdEncoding.EncodeToString(pub) + `"}`))
    }))
}

func TestLookupResolvesCachesAndNegativeCaches(t *testing.T) {
    pub, _, err := ed25519.GenerateKey(rand.Reader)
    if err != nil {
        t.Fatal(err)
    }
    var hits atomic.Int64
    srv := fakeCloud(t, pub, &hits)
    defer srv.Close()

    now := time.Unix(1000, 0)
    r := NewResolver(Config{URL: srv.URL, Token: "tok", Now: func() time.Time { return now }})

    got, ok := r.Lookup("node-0011223344556677")
    if !ok || !got.Equal(pub) {
        t.Fatalf("want key, got ok=%v", ok)
    }
    if _, ok := r.Lookup("node-0011223344556677"); !ok {
        t.Fatal("cached lookup failed")
    }
    if hits.Load() != 1 {
        t.Fatalf("expected 1 HTTP hit (cache), got %d", hits.Load())
    }

    // Unknown node: negative cached.
    if _, ok := r.Lookup("node-ffffffffffffffff"); ok {
        t.Fatal("unknown node resolved")
    }
    if _, ok := r.Lookup("node-ffffffffffffffff"); ok {
        t.Fatal("unknown node resolved from cache")
    }
    if hits.Load() != 2 {
        t.Fatalf("expected 2 HTTP hits, got %d", hits.Load())
    }

    // Positive entry expires after TTL.
    now = now.Add(61 * time.Second)
    if _, ok := r.Lookup("node-0011223344556677"); !ok {
        t.Fatal("expired entry did not re-resolve")
    }
    if hits.Load() != 3 {
        t.Fatalf("expected re-fetch after TTL, got %d hits", hits.Load())
    }
}

func TestLookupDisabledWithoutURL(t *testing.T) {
    r := NewResolver(Config{})
    if _, ok := r.Lookup("node-0011223344556677"); ok {
        t.Fatal("resolver without URL must miss")
    }
}

func TestLookupParsesPEM(t *testing.T) {
    // The cloud may store SPKI PEM pubkeys (what relayd registers).
    pub, _, _ := ed25519.GenerateKey(rand.Reader)
    srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Content-Type", "application/json")
        _, _ = w.Write([]byte(`{"nodeId":"node-aa","accountId":"a","kind":"byo","pubkey":` + pemJSON(pub) + `}`))
    }))
    defer srv.Close()
    r := NewResolver(Config{URL: srv.URL, Token: "tok"})
    got, ok := r.Lookup("node-aa")
    if !ok || !got.Equal(pub) {
        t.Fatal("PEM pubkey did not resolve")
    }
}
```

Add the small `pemJSON` helper in the test file (marshal SPKI PEM then JSON-quote it):

```go
func pemJSON(pub ed25519.PublicKey) string {
    der, err := x509.MarshalPKIXPublicKey(pub)
    if err != nil {
        panic(err)
    }
    p := pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})
    b, _ := json.Marshal(string(p))
    return string(b)
}
```

(with imports `crypto/x509`, `encoding/pem`, `encoding/json` added.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/broker && go test ./internal/registry/`
Expected: FAIL — package does not exist / `NewResolver` undefined.

- [ ] **Step 3: Implement the resolver**

```go
// product/broker/internal/registry/registry.go
//
// Package registry resolves node ids to ed25519 public keys from the
// control-plane hook GET /v1/tunnel/nodes/:id, with a small TTL cache so a
// reconnect storm cannot hammer the cloud. Unknown ids are negative-cached
// briefly. A resolver with no URL is inert (static registrations only).
package registry

import (
    "crypto/ed25519"
    "encoding/base64"
    "encoding/json"
    "fmt"
    "io"
    "net/http"
    "sync"
    "time"

    "relay.example/broker/internal/certs"
)

type Config struct {
    URL         string
    Token       string
    HTTPClient  *http.Client
    PositiveTTL time.Duration
    NegativeTTL time.Duration
    Now         func() time.Time
    Logf        func(string, ...any)
}

type entry struct {
    key     ed25519.PublicKey // nil ⇒ negative entry
    expires time.Time
}

type Resolver struct {
    cfg    Config
    client *http.Client
    now    func() time.Time
    logf   func(string, ...any)

    mu    sync.Mutex
    cache map[string]entry
}

func NewResolver(cfg Config) *Resolver {
    if cfg.PositiveTTL == 0 {
        cfg.PositiveTTL = 60 * time.Second
    }
    if cfg.NegativeTTL == 0 {
        cfg.NegativeTTL = 10 * time.Second
    }
    client := cfg.HTTPClient
    if client == nil {
        client = &http.Client{Timeout: 3 * time.Second}
    }
    now := cfg.Now
    if now == nil {
        now = time.Now
    }
    logf := cfg.Logf
    if logf == nil {
        logf = func(string, ...any) {}
    }
    return &Resolver{cfg: cfg, client: client, now: now, logf: logf, cache: make(map[string]entry)}
}

// Lookup satisfies tunnelauth.VerifyFunc.
func (r *Resolver) Lookup(nodeID string) (ed25519.PublicKey, bool) {
    if r.cfg.URL == "" {
        return nil, false
    }
    r.mu.Lock()
    if e, ok := r.cache[nodeID]; ok && r.now().Before(e.expires) {
        r.mu.Unlock()
        return e.key, e.key != nil
    }
    r.mu.Unlock()

    key, found := r.fetch(nodeID)
    ttl := r.cfg.NegativeTTL
    if found {
        ttl = r.cfg.PositiveTTL
    }
    r.mu.Lock()
    r.cache[nodeID] = entry{key: key, expires: r.now().Add(ttl)}
    r.mu.Unlock()
    return key, found
}

func (r *Resolver) fetch(nodeID string) (ed25519.PublicKey, bool) {
    req, err := http.NewRequest(http.MethodGet, fmt.Sprintf("%s/v1/tunnel/nodes/%s", r.cfg.URL, nodeID), nil)
    if err != nil {
        return nil, false
    }
    req.Header.Set("Authorization", "Bearer "+r.cfg.Token)
    resp, err := r.client.Do(req)
    if err != nil {
        r.logf("registry: fetch %s: %v", nodeID, err)
        return nil, false
    }
    defer resp.Body.Close()
    if resp.StatusCode != http.StatusOK {
        return nil, false
    }
    body, err := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
    if err != nil {
        return nil, false
    }
    var payload struct {
        Pubkey string `json:"pubkey"`
    }
    if err := json.Unmarshal(body, &payload); err != nil || payload.Pubkey == "" {
        return nil, false
    }
    return parsePubkey(payload.Pubkey)
}

func parsePubkey(s string) (ed25519.PublicKey, bool) {
    if key, err := certs.ParseEd25519PublicKeyPEM([]byte(s)); err == nil {
        return key, true
    }
    raw, err := base64.StdEncoding.DecodeString(s)
    if err != nil || len(raw) != ed25519.PublicKeySize {
        return nil, false
    }
    return ed25519.PublicKey(raw), true
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/broker && go vet ./internal/registry/ && go test ./internal/registry/`
Expected: PASS (3 tests).

### Task 7: Wire the resolver into the broker + main.go flags

**Files:**
- Modify: `product/broker/internal/broker/broker.go`, `product/broker/cmd/broker/main.go`
- Test: `product/broker/internal/broker/broker_dynamic_test.go`

**Interfaces:**
- Produces: `broker.New(suffix string, logf func(string, ...any))` unchanged; new `func (b *Broker) SetFallbackLookup(fn func(string) (ed25519.PublicKey, bool))` — `lookupKey` checks the static map first, then the fallback. main.go flags: `-registry-url` (string), `-registry-token-file` (string; file contents trimmed; refuse `-registry-url` without a token file).
- Consumes: Task 6 `registry.NewResolver(...).Lookup`.

- [ ] **Step 1: Write the failing test**

```go
// product/broker/internal/broker/broker_dynamic_test.go
package broker

import (
    "crypto/ed25519"
    "crypto/rand"
    "testing"
)

func TestLookupFallsBackToDynamicRegistry(t *testing.T) {
    pubStatic, _, _ := ed25519.GenerateKey(rand.Reader)
    pubDyn, _, _ := ed25519.GenerateKey(rand.Reader)

    b := New(".tun.test", func(string, ...any) {})
    b.RegisterNode("static-node", pubStatic)
    b.SetFallbackLookup(func(id string) (ed25519.PublicKey, bool) {
        if id == "node-0011223344556677" {
            return pubDyn, true
        }
        return nil, false
    })

    if got, ok := b.lookupKey("static-node"); !ok || !got.Equal(pubStatic) {
        t.Fatal("static lookup broken")
    }
    if got, ok := b.lookupKey("node-0011223344556677"); !ok || !got.Equal(pubDyn) {
        t.Fatal("dynamic fallback not used")
    }
    if _, ok := b.lookupKey("node-unknown"); ok {
        t.Fatal("unknown id resolved")
    }
}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/broker && go test ./internal/broker/`
Expected: FAIL — `b.SetFallbackLookup undefined`.

- [ ] **Step 3: Implement fallback + flags**

In `broker.go`: add a `fallback func(string) (ed25519.PublicKey, bool)` field to `Broker`, plus:

```go
// SetFallbackLookup installs a dynamic resolver consulted when a node id is
// not in the static registry (production: the control-plane registry hook).
func (b *Broker) SetFallbackLookup(fn func(string) (ed25519.PublicKey, bool)) {
    b.mu.Lock()
    defer b.mu.Unlock()
    b.fallback = fn
}

func (b *Broker) lookupKey(nodeID string) (ed25519.PublicKey, bool) {
    b.mu.Lock()
    pub, ok := b.registry[nodeID]
    fallback := b.fallback
    b.mu.Unlock()
    if ok {
        return pub, true
    }
    if fallback != nil {
        return fallback(nodeID) // network call — must run outside the lock
    }
    return nil, false
}
```

(The existing `lookupKey` holds the lock for its whole body — this rewrite releases it before the fallback so a slow HTTP fetch cannot block tunnel registration.)

In `main.go`, after the existing `-node` loop:

```go
    registryURL := flag.String("registry-url", "", "control-plane base URL for dynamic node lookup (e.g. http://127.0.0.1:8790)")
    registryTokenFile := flag.String("registry-token-file", "", "file containing the broker bearer token for -registry-url")
```

(declare with the other flags before `flag.Parse()`), and after node registration:

```go
    if *registryURL != "" {
        if *registryTokenFile == "" {
            fmt.Fprintln(os.Stderr, "-registry-url requires -registry-token-file")
            os.Exit(2)
        }
        tokenBytes, err := os.ReadFile(*registryTokenFile)
        if err != nil {
            log.Fatalf("read registry token: %v", err)
        }
        resolver := registry.NewResolver(registry.Config{
            URL:   *registryURL,
            Token: strings.TrimSpace(string(tokenBytes)),
            Logf:  log.Printf,
        })
        b.SetFallbackLookup(resolver.Lookup)
        log.Printf("dynamic registry enabled: %s", *registryURL)
    }
```

with import `"relay.example/broker/internal/registry"`.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/broker && go vet ./... && go build ./... && go test -count=1 ./...`
Expected: all packages ok, including the new test and the existing e2e/mux/sni/verify suites.

---

## Phase 3 — relayd: enroll + trial pairing (`product/relayd`)

### Task 8: `enrollWithCloud` (non-interactive identity + cloud registration)

**Files:**
- Create: `product/relayd/src/enroll.mjs`
- Test: `product/relayd/test/enroll.test.mjs`

**Interfaces:**
- Produces: `async enrollWithCloud({cloudUrl, token, version = null, baseDir = undefined, fetchImpl = fetch})` → `{nodeId, sni}`. Steps: `initIdentity({baseDir})` (idempotent, creates `node-<16hex>` id + Ed25519 keypair + CA), read `identityPubPath` PEM, `POST {cloudUrl}/v1/trial-nodes/enroll` with `{token, nodeId, pubkey, version}`; non-200 → throw `Error("enroll_failed_<status>")`; returns `{nodeId, sni}` from the response. No secrets logged.
- Consumes: `initIdentity`, `identityPaths`, `readNodeId` from `src/identity.mjs` (identity.mjs:87, :58, :133).

- [ ] **Step 1: Write the failing test**

```js
// product/relayd/test/enroll.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-data-"));

const { enrollWithCloud } = await import("../src/enroll.mjs");

function startFakeCloud(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        handler(res, calls.at(-1));
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

test("enrollWithCloud initializes identity and registers the pubkey", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-id-"));
  const cloud = await startFakeCloud((res, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sni: `${call.body.nodeId}.tun.test` }));
  });
  try {
    const out = await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-1", version: "0.1.0", baseDir });
    assert.match(out.nodeId, /^node-[0-9a-f]{16}$/);
    assert.equal(out.sni, `${out.nodeId}.tun.test`);

    const call = cloud.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/v1/trial-nodes/enroll");
    assert.equal(call.body.token, "tok-1");
    assert.equal(call.body.nodeId, out.nodeId);
    assert.match(call.body.pubkey, /BEGIN PUBLIC KEY/);

    // Idempotent: same identity on a second run.
    const again = await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-2", baseDir });
    assert.equal(again.nodeId, out.nodeId);
  } finally {
    await cloud.close();
  }
});

test("enrollWithCloud surfaces cloud rejection", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-id2-"));
  const cloud = await startFakeCloud((res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_enroll_token" }));
  });
  try {
    await assert.rejects(() => enrollWithCloud({ cloudUrl: cloud.url, token: "bad", baseDir }), /enroll_failed_401/);
  } finally {
    await cloud.close();
  }
});
```

(Openssl must be present — it already is for the identity suite; identity tests use the same pattern.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/relayd && node --test test/enroll.test.mjs`
Expected: FAIL — `Cannot find module '../src/enroll.mjs'`.

- [ ] **Step 3: Implement enroll.mjs**

```js
// relayd enroll — non-interactive bootstrap for cloud-provisioned (trial)
// nodes. Creates the node identity if missing and registers the identity
// public key with the control plane using a single-use enroll token. The
// token authenticates exactly one registration and is burned server-side.

import fs from "node:fs";
import { initIdentity, identityPaths, readNodeId } from "./identity.mjs";

export async function enrollWithCloud({ cloudUrl, token, version = null, baseDir = undefined, fetchImpl = fetch }) {
  if (!cloudUrl) throw new Error("enroll requires a cloud URL");
  if (!token) throw new Error("enroll requires an enroll token");

  initIdentity(baseDir ? { baseDir } : {});
  const paths = identityPaths(baseDir || undefined);
  const nodeId = readNodeId(paths);
  const pubkey = fs.readFileSync(paths.identityPubPath, "utf8");

  const res = await fetchImpl(`${cloudUrl.replace(/\/+$/, "")}/v1/trial-nodes/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, nodeId, pubkey, version }),
  });
  if (res.status !== 200) throw new Error(`enroll_failed_${res.status}`);
  const json = await res.json();
  return { nodeId, sni: json.sni };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/relayd && node --test test/enroll.test.mjs`
Expected: 2 pass / 0 fail.

- [ ] **Step 5: relayd suite still green**

Run: `cd product/relayd && node --test test/enroll.test.mjs test/identity.test.mjs test/pairing.test.mjs`
Expected: pass. (Full suite run comes in Task 10.)

### Task 9: Trial pairing — node-minted p12 over the cloud rendezvous

**Files:**
- Create: `product/relayd/src/trialpair.mjs`
- Test: `product/relayd/test/trialpair.test.mjs`

**Interfaces:**
- Produces: `async runTrialPairing({cloudUrl, pairingId, secret, baseDir = undefined, fetchImpl = fetch, pollIntervalMs = 1000, timeoutMs = 120000, execFileImpl = undefined})` → `{deviceId, certSerial}`. Behavior:
  1. Derive `{authToken, macKey}` via `pairingKeys(secret)` (pairing.mjs export).
  2. Poll `GET {cloudUrl}/v1/pairing/sessions/{pairingId}/device-blob` with header `X-Pairing-Auth: {authToken}` until 200 (404 `not_posted_yet` → retry; other statuses → throw `Error("trial_pair_device_blob_<status>")`; deadline → `Error("trial_pair_timeout")`).
  3. Verify the returned `x-pairing-tag` with `verifyBlobTag(macKey, DEVICE_SLOT, blob, tag)`; parse JSON `{deviceName, platform}`.
  4. Mint the device credential locally: `openssl ecparam -name prime256v1 -genkey` (device key) → `openssl req -new` CSR with `-subj "/CN=trial-device"` → `issueDeviceCert({csrPem, deviceName, platform, baseDir})` → `openssl pkcs12 -export` bundling device key + issued cert + `caPem`, passphrase `hex(HMAC-SHA256(key=secret, msg="relay-trial-p12-v1"))`; device private key + p12 built under the identity `tmp/` dir and deleted in a `finally`.
  5. `POST` the raw p12 bytes to `.../node-blob` with `X-Pairing-Auth` and `X-Pairing-Tag: blobTag(macKey, NODE_SLOT, p12Bytes)`; 204 expected, else throw `Error("trial_pair_post_<status>")`.
- Consumes: `pairingKeys, blobTag, verifyBlobTag, DEVICE_SLOT, NODE_SLOT` from `src/pairing.mjs` (exports at pairing.mjs:463-482); `issueDeviceCert, identityPaths, getCaPem, initIdentity` from `src/identity.mjs`.

- [ ] **Step 1: Write the failing test**

```js
// product/relayd/test/trialpair.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-data-"));

const { pairingKeys, blobTag, verifyBlobTag, DEVICE_SLOT, NODE_SLOT } = await import("../src/pairing.mjs");
const { initIdentity } = await import("../src/identity.mjs");
const { runTrialPairing } = await import("../src/trialpair.mjs");

// Minimal in-process rendezvous implementing the cloud contract for one session.
function startFakeRendezvous(pairingId, expectedAuthToken) {
  const slots = { "device-blob": null, "node-blob": null };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const m = req.url.match(/^\/v1\/pairing\/sessions\/([^/]+)\/(device-blob|node-blob)$/);
      if (!m || m[1] !== pairingId || req.headers["x-pairing-auth"] !== expectedAuthToken) {
        res.writeHead(401).end();
        return;
      }
      const slot = m[2];
      if (req.method === "GET") {
        if (!slots[slot]) {
          res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_posted_yet"}');
          return;
        }
        res.writeHead(200, { "x-pairing-tag": slots[slot].tag }).end(slots[slot].blob);
        return;
      }
      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          slots[slot] = { blob: Buffer.concat(chunks), tag: String(req.headers["x-pairing-tag"] || "") };
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(405).end();
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ slots, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

test("runTrialPairing issues a cert and posts a MAC-tagged p12 the device passphrase opens", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-id-"));
  initIdentity({ baseDir });

  const secret = crypto.randomBytes(24).toString("base64url");
  const keys = pairingKeys(secret);
  const pairingId = crypto.randomUUID();
  const rv = await startFakeRendezvous(pairingId, keys.authToken);
  try {
    // Phone side: post the device blob first.
    const deviceBlob = Buffer.from(JSON.stringify({ deviceName: "Test iPhone", platform: "ios" }), "utf8");
    await fetch(`${rv.url}/v1/pairing/sessions/${pairingId}/device-blob`, {
      method: "POST",
      headers: { "x-pairing-auth": keys.authToken, "x-pairing-tag": blobTag(keys.macKey, DEVICE_SLOT, deviceBlob) },
      body: deviceBlob,
    });

    const out = await runTrialPairing({ cloudUrl: rv.url, pairingId, secret, baseDir, pollIntervalMs: 10 });
    assert.match(out.certSerial, /^[0-9A-F]+$/);

    // Node blob is a valid, MAC-tagged p12 the derived passphrase opens.
    const posted = rv.slots["node-blob"];
    assert.ok(posted, "node blob posted");
    assert.equal(verifyBlobTag(keys.macKey, NODE_SLOT, posted.blob, posted.tag), true);

    const passphrase = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update("relay-trial-p12-v1").digest("hex");
    const p12Path = path.join(baseDir, "check.p12");
    fs.writeFileSync(p12Path, posted.blob);
    const dump = execFileSync("openssl", ["pkcs12", "-in", p12Path, "-passin", `pass:${passphrase}`, "-nokeys", "-clcerts"], { encoding: "utf8" });
    assert.match(dump, /BEGIN CERTIFICATE/);

    // No stray private material left in tmp/.
    const tmpDir = path.join(baseDir, "tmp");
    assert.deepEqual(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [], []);
  } finally {
    await rv.close();
  }
});

test("runTrialPairing rejects a tampered device blob", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-id2-"));
  initIdentity({ baseDir });
  const secret = crypto.randomBytes(24).toString("base64url");
  const keys = pairingKeys(secret);
  const pairingId = crypto.randomUUID();
  const rv = await startFakeRendezvous(pairingId, keys.authToken);
  try {
    const deviceBlob = Buffer.from(JSON.stringify({ deviceName: "Evil", platform: "ios" }), "utf8");
    await fetch(`${rv.url}/v1/pairing/sessions/${pairingId}/device-blob`, {
      method: "POST",
      headers: { "x-pairing-auth": keys.authToken, "x-pairing-tag": blobTag(keys.macKey, DEVICE_SLOT, Buffer.from("other")) },
      body: deviceBlob,
    });
    await assert.rejects(() => runTrialPairing({ cloudUrl: rv.url, pairingId, secret, baseDir, pollIntervalMs: 10 }), /trial_pair_bad_tag/);
  } finally {
    await rv.close();
  }
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/relayd && node --test test/trialpair.test.mjs`
Expected: FAIL — `Cannot find module '../src/trialpair.mjs'`.

- [ ] **Step 3: Implement trialpair.mjs**

```js
// Trial pairing (trial tier ONLY — documented delta from the zero-knowledge
// BYO flow in pairing.mjs). The phone has no CSR stack yet, so the NODE
// mints the device keypair, issues the certificate against its own CA, and
// delivers key+cert+CA as a passphrase-protected PKCS#12 through the cloud
// rendezvous. Both blobs are MAC-tagged with keys derived from the pairing
// secret; on the trial tier the cloud transports that secret to the sandbox
// (operator-hosted trust), which is exactly why BYO must never use this path.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pairingKeys, blobTag, verifyBlobTag, DEVICE_SLOT, NODE_SLOT } from "./pairing.mjs";
import { identityPaths, issueDeviceCert, getCaPem } from "./identity.mjs";

const execFileAsync = promisify(execFile);
const P12_LABEL = "relay-trial-p12-v1";

function p12Passphrase(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(P12_LABEL).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTrialPairing({
  cloudUrl,
  pairingId,
  secret,
  baseDir = undefined,
  fetchImpl = fetch,
  pollIntervalMs = 1000,
  timeoutMs = 120000,
  execFileImpl = execFileAsync,
}) {
  if (!cloudUrl || !pairingId || !secret) throw new Error("trial pairing requires cloudUrl, pairingId and secret");
  const base = `${cloudUrl.replace(/\/+$/, "")}/v1/pairing/sessions/${encodeURIComponent(pairingId)}`;
  const keys = pairingKeys(secret);

  // 1. Wait for the phone's device blob.
  const deadline = Date.now() + timeoutMs;
  let blob = null;
  let tag = "";
  for (;;) {
    const res = await fetchImpl(`${base}/device-blob`, { headers: { "x-pairing-auth": keys.authToken } });
    if (res.status === 200) {
      blob = Buffer.from(await res.arrayBuffer());
      tag = res.headers.get("x-pairing-tag") || "";
      break;
    }
    if (res.status !== 404) throw new Error(`trial_pair_device_blob_${res.status}`);
    if (Date.now() >= deadline) throw new Error("trial_pair_timeout");
    await sleep(pollIntervalMs);
  }
  if (!verifyBlobTag(keys.macKey, DEVICE_SLOT, blob, tag)) throw new Error("trial_pair_bad_tag");

  let parsed;
  try {
    parsed = JSON.parse(blob.toString("utf8"));
  } catch {
    throw new Error("trial_pair_bad_device_blob");
  }
  const deviceName = typeof parsed?.deviceName === "string" ? parsed.deviceName : null;
  const platform = typeof parsed?.platform === "string" ? parsed.platform : null;

  // 2. Mint the device credential. Key material stays inside tmp/ (0700)
  //    and is removed before this function returns, success or not.
  const paths = identityPaths(baseDir || undefined);
  fs.mkdirSync(paths.tmpDir, { recursive: true, mode: 0o700 });
  const stamp = crypto.randomBytes(6).toString("hex");
  const keyPath = path.join(paths.tmpDir, `trial-device-${stamp}.key.pem`);
  const csrPath = path.join(paths.tmpDir, `trial-device-${stamp}.csr.pem`);
  const certPath = path.join(paths.tmpDir, `trial-device-${stamp}.cert.pem`);
  const caPath = path.join(paths.tmpDir, `trial-device-${stamp}.ca.pem`);
  const p12Path = path.join(paths.tmpDir, `trial-device-${stamp}.p12`);
  try {
    await execFileImpl("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
    fs.chmodSync(keyPath, 0o600);
    await execFileImpl("openssl", ["req", "-new", "-key", keyPath, "-subj", "/CN=trial-device", "-out", csrPath]);
    const issued = issueDeviceCert({
      csrPem: fs.readFileSync(csrPath, "utf8"),
      deviceName,
      platform,
      ...(baseDir ? { baseDir } : {}),
    });
    fs.writeFileSync(certPath, issued.certificatePem);
    fs.writeFileSync(caPath, getCaPem(baseDir || undefined));
    const passphrase = p12Passphrase(secret);
    await execFileImpl("openssl", [
      "pkcs12", "-export",
      "-inkey", keyPath,
      "-in", certPath,
      "-certfile", caPath,
      "-name", "relay-trial-device",
      "-passout", `pass:${passphrase}`,
      "-out", p12Path,
    ]);
    const p12 = fs.readFileSync(p12Path);

    // 3. Post the node blob.
    const res = await fetchImpl(`${base}/node-blob`, {
      method: "POST",
      headers: {
        "x-pairing-auth": keys.authToken,
        "x-pairing-tag": blobTag(keys.macKey, NODE_SLOT, p12),
        "content-type": "application/octet-stream",
      },
      body: p12,
    });
    if (res.status !== 204) throw new Error(`trial_pair_post_${res.status}`);
    return { deviceId: issued.deviceId, certSerial: issued.certSerial };
  } finally {
    for (const f of [keyPath, csrPath, certPath, caPath, p12Path]) {
      try { fs.rmSync(f, { force: true }); } catch {}
    }
  }
}
```

Check `identityPaths(...).tmpDir` and `getCaPem(baseDir)` signatures against `src/identity.mjs:58` and `:149` — `getCaPem` takes `baseDir` directly (not an options object).

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/relayd && node --test test/trialpair.test.mjs`
Expected: 2 pass / 0 fail.

### Task 10: `relayd enroll` CLI command

**Files:**
- Modify: `product/relayd/bin/relayd`
- Test: `product/relayd/test/enroll-cli.test.mjs`

**Interfaces:**
- Produces: `relayd enroll` subcommand, env-driven (no secrets in argv): requires `RELAYD_ENROLL_URL` + `RELAYD_ENROLL_TOKEN`; optional `RELAYD_ENROLL_PAIRING_ID` + `RELAYD_ENROLL_PAIRING_SECRET` (both or neither; runs trial pairing when present). Prints `enrolled <nodeId> sni=<sni>` on success, exits 0; prints failure to stderr and exits 1. Never prints the token or secret.
- Consumes: Task 8 `enrollWithCloud`, Task 9 `runTrialPairing`.

- [ ] **Step 1: Write the failing test**

```js
// product/relayd/test/enroll-cli.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const relaydBin = fileURLToPath(new URL("../bin/relayd", import.meta.url));

test("relayd enroll registers via env config and exits 0", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-data-"));
  const calls = [];
  const cloud = await new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push(JSON.parse(body));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, sni: `${JSON.parse(body).nodeId}.tun.test` }));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
  try {
    const { stdout } = await execFileAsync(process.execPath, [relaydBin, "enroll"], {
      env: {
        ...process.env,
        CODEX_DATA_DIR: dataDir,
        RELAYD_ENROLL_URL: cloud.url,
        RELAYD_ENROLL_TOKEN: "tok-cli",
      },
    });
    assert.match(stdout, /enrolled node-[0-9a-f]{16} sni=node-[0-9a-f]{16}\.tun\.test/);
    assert.ok(!stdout.includes("tok-cli"), "token must never be printed");
    assert.equal(calls[0].token, "tok-cli");
  } finally {
    cloud.server.close();
  }
});

test("relayd enroll fails cleanly without env", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cli-data2-"));
  await assert.rejects(
    () => execFileAsync(process.execPath, [relaydBin, "enroll"], { env: { ...process.env, CODEX_DATA_DIR: dataDir, RELAYD_ENROLL_URL: "", RELAYD_ENROLL_TOKEN: "" } }),
    (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /RELAYD_ENROLL_URL/);
      return true;
    },
  );
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd product/relayd && node --test test/enroll-cli.test.mjs`
Expected: FAIL — `unknown command: enroll` (exit 1 but with the wrong stderr, so the first test fails on stdout match).

- [ ] **Step 3: Implement the subcommand**

In `product/relayd/bin/relayd`:

1. Add to the `usage` template literal (bin/relayd:295-305): `  relayd enroll              enroll with the control plane (env: RELAYD_ENROLL_URL, RELAYD_ENROLL_TOKEN[, RELAYD_ENROLL_PAIRING_ID, RELAYD_ENROLL_PAIRING_SECRET])`.
2. Add the command function (same dynamic-import style as `cmdPair`, bin/relayd:60):

```js
async function cmdEnroll() {
  const cloudUrl = (process.env.RELAYD_ENROLL_URL || "").trim();
  const token = (process.env.RELAYD_ENROLL_TOKEN || "").trim();
  const pairingId = (process.env.RELAYD_ENROLL_PAIRING_ID || "").trim();
  const pairingSecret = (process.env.RELAYD_ENROLL_PAIRING_SECRET || "").trim();
  if (!cloudUrl || !token) {
    fail("enroll requires RELAYD_ENROLL_URL and RELAYD_ENROLL_TOKEN");
  }
  if (Boolean(pairingId) !== Boolean(pairingSecret)) {
    fail("RELAYD_ENROLL_PAIRING_ID and RELAYD_ENROLL_PAIRING_SECRET must be set together");
  }
  const { enrollWithCloud } = await import("../src/enroll.mjs");
  const { nodeId, sni } = await enrollWithCloud({ cloudUrl, token, version: "0.1.0" });
  console.log(`enrolled ${nodeId} sni=${sni}`);
  if (pairingId) {
    const { runTrialPairing } = await import("../src/trialpair.mjs");
    const { deviceId } = await runTrialPairing({ cloudUrl, pairingId, secret: pairingSecret });
    console.log(`trial device paired: ${deviceId}`);
  }
}
```

3. Add `case "enroll": await cmdEnroll(); break;` to the switch (bin/relayd:307-332) and mention `enroll` in the header comment block. Wrap the call so a thrown error becomes `fail(error.message)` — match how other commands surface errors (check `cmdPair`'s error path first; if commands rely on the top-level unhandled rejection, add an explicit try/catch in `cmdEnroll` calling `fail`).

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `cd product/relayd && node --test test/enroll-cli.test.mjs`
Expected: 2 pass / 0 fail.

- [ ] **Step 5: FULL relayd suite green**

Run: `cd product/relayd && node --test test/*.test.mjs`
Expected: 102+ existing tests plus the 6 new ones, 0 fail. (Conformance takes ~73s.)

---

## Phase 4 — Trial sandbox template (`product/trial`)

### Task 11: Template: Dockerfile, start.sh, build script

**Files:**
- Create: `product/trial/Dockerfile`, `product/trial/start.sh`, `product/trial/e2b.toml`, `product/trial/build.sh`, `product/trial/README.md`

**Interfaces:**
- Consumes: `relayd enroll` (Task 10), env injected by the cloud (Task 3): `RELAYD_ENROLL_URL/TOKEN/PAIRING_ID/PAIRING_SECRET`, `RELAYD_TUNNEL_HOST/PORT/SUFFIX`.
- Produces: an E2B/Cube template named `relay-trial` whose start command boots relayd in tunneled mode as a non-root user with the jail at `/srv/relay-workspaces`. No systemd — `start.sh` is the init.

- [ ] **Step 1: Write the files**

`product/trial/Dockerfile`:

```dockerfile
# Relay trial machine template (Cube / E2B). No systemd: the sandbox runs
# start.sh as its init. Harness CLIs are preinstalled but UNAUTHENTICATED —
# the user connects their own subscriptions (device-code login) after boot.
FROM ubuntu:24.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates curl git openssl python3 ripgrep unzip xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (relayd floor; also used by the harness CLIs).
RUN curl -fsSL https://nodejs.org/dist/v22.23.1/node-v22.23.1-linux-x64.tar.xz \
      | tar -xJ -C /opt && ln -s /opt/node-v22.23.1-linux-x64 /opt/node
ENV PATH="/opt/node/bin:${PATH}"

# Harness CLIs, pinned at template-build time (versions recorded in the image).
RUN npm install -g @openai/codex @anthropic-ai/claude-code \
    && curl -fsSL https://cursor.com/install | bash || true

# Non-root runtime user + jail with a seeded welcome workspace.
RUN useradd --system --create-home --shell /bin/bash relay \
    && mkdir -p /srv/relay-workspaces/welcome /var/lib/relayd \
    && printf '# Welcome to your Relay trial machine\n\nThis folder is your agent workspace. Open a conversation from the app to get started.\n' \
         > /srv/relay-workspaces/welcome/README.md \
    && chown -R relay:relay /srv/relay-workspaces /var/lib/relayd \
    && chmod 0750 /srv/relay-workspaces

# relayd source (stdlib-only; no npm install step by design).
COPY relayd/src /opt/relayd/app/src
COPY relayd/bin /opt/relayd/app/bin
COPY relayd/package.json /opt/relayd/app/package.json
COPY start.sh /opt/relayd/start.sh
RUN chmod 0755 /opt/relayd/start.sh /opt/relayd/app/bin/relayd

USER relay
WORKDIR /home/relay
CMD ["/opt/relayd/start.sh"]
```

`product/trial/start.sh`:

```bash
#!/usr/bin/env bash
# Trial sandbox init: enroll once (idempotent), then run relayd tunneled.
# All configuration arrives as sandbox env vars injected by relay-cloud.
# The enroll token and pairing secret are consumed here and exported to
# nothing else; relayd run does not need them.
set -euo pipefail

export CODEX_DATA_DIR="${CODEX_DATA_DIR:-/var/lib/relayd}"
export RELAYD_IDENTITY_DIR="${RELAYD_IDENTITY_DIR:-/var/lib/relayd/identity}"
export CODEX_WORKSPACE_BROWSE_ROOT="${CODEX_WORKSPACE_BROWSE_ROOT:-/srv/relay-workspaces}"
export CODEX_WORKSPACES="${CODEX_WORKSPACES:-[{\"id\":\"welcome\",\"name\":\"Welcome\",\"path\":\"/srv/relay-workspaces/welcome\"}]}"
export CODEX_RUN_HOME="${CODEX_RUN_HOME:-/home/relay}"
export RELAYD_STORE="${RELAYD_STORE:-sqlite}"

ENROLL_MARKER="${CODEX_DATA_DIR}/enrolled"
if [ ! -f "${ENROLL_MARKER}" ]; then
  node /opt/relayd/app/bin/relayd enroll
  touch "${ENROLL_MARKER}"
fi

# The enroll secrets must not leak into the long-running daemon environment.
unset RELAYD_ENROLL_TOKEN RELAYD_ENROLL_PAIRING_ID RELAYD_ENROLL_PAIRING_SECRET

exec node /opt/relayd/app/bin/relayd run --mode tunneled
```

`product/trial/e2b.toml`:

```toml
# Cube/E2B template manifest. Build with ./build.sh on the Cube host.
template_id = "relay-trial"
dockerfile = "Dockerfile"
start_cmd = "/opt/relayd/start.sh"
cpu_count = 1
memory_mb = 1024
```

`product/trial/build.sh`:

```bash
#!/usr/bin/env bash
# Build the relay-trial template. Run ON the Cube host (or wherever the
# e2b-compatible CLI is authenticated against it). Copies relayd source in
# fresh so the image always matches the checked-out tree.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf relayd
mkdir -p relayd
cp -R ../relayd/src ../relayd/bin ../relayd/package.json relayd/
e2b template build --name relay-trial
rm -rf relayd
echo "template relay-trial built"
```

`product/trial/README.md` — document (genericized): what the template contains, the env contract (`RELAYD_ENROLL_*`, `RELAYD_TUNNEL_*`), that harness CLIs are installed unauthenticated, egress expectations (allow LLM providers/git/package registries; deny-by-default is enforced by the Cube host's eBPF config, not this image), and the build/verify commands.

- [ ] **Step 2: Lint both scripts**

Run: `bash -n product/trial/start.sh product/trial/build.sh && command -v shellcheck >/dev/null && shellcheck product/trial/start.sh product/trial/build.sh || echo "shellcheck unavailable — bash -n passed"`
Expected: no syntax errors (shellcheck clean if installed).

- [ ] **Step 3: Dry-run the start script's enroll path locally**

Run (from repo root, using the Task 8/10 fake-cloud test as the harness — this just re-runs the CLI suite to prove the exact invocation start.sh makes works):
`cd product/relayd && node --test test/enroll-cli.test.mjs`
Expected: PASS. (A real container boot happens in Phase 7 on the Cube host; Docker is not assumed locally.)

---

## Phase 5 — iOS (`ios/POCVault`)

### Task 12: Trial DTOs + pairing derivations (pure code + tests)

**Files:**
- Create: `ios/POCVault/POCVault/Models/RelayTrialNode.swift`, `ios/POCVault/POCVault/Security/RelayTrialPairing.swift`
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj` (add files to the POCVault target sources; follow the existing hand-written sequential-UUID style, e.g. after `RelayAccount.swift`'s entries)
- Test: `ios/POCVault/POCVaultTests/TrialPairingTests.swift` (add to POCVaultTests target)

**Interfaces:**
- Produces:

```swift
struct RelayTrialNode: Decodable, Equatable {
    enum State: String, Decodable { case creating, ready, expired, destroyed, failed }
    let id: String
    let state: State
    let nodeId: String?
    let sni: String?
    let createdAt: Int64   // epoch ms
    let expiresAt: Int64   // epoch ms
    var nodeURL: URL? { sni.flatMap { URL(string: "https://\($0)") } }
    var expiresDate: Date { Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000) }
}

enum RelayTrialPairing {
    static func generateSecret() -> String                       // 24 random bytes, base64url (no padding)
    static func authToken(secret: String) -> String              // base64url(SHA256("relay-pair-auth-v1" || 0x00 || secret))
    static func macKey(secret: String) -> SymmetricKey           // HMAC-SHA256(key: secret, msg: "relay-pair-mac-v1")
    static func blobTag(macKey: SymmetricKey, slot: String, blob: Data) -> String   // base64(HMAC-SHA256(macKey, slot || 0x00 || blob))
    static func verifyTag(macKey: SymmetricKey, slot: String, blob: Data, tag: String) -> Bool
    static func p12Passphrase(secret: String) -> String          // lowercase hex of HMAC-SHA256(key: secret, msg: "relay-trial-p12-v1")
    static let deviceSlot = "device-blob"
    static let nodeSlot = "node-blob"
}
```

- These derivations MUST byte-match `product/relayd/src/pairing.mjs:147-193` and Task 9's passphrase. The test locks them with fixture values generated from the Node side.

- [ ] **Step 1: Generate cross-implementation fixtures from the Node reference**

Run:

```bash
cd product/relayd && node -e '
const { pairingKeys, blobTag, DEVICE_SLOT } = await import("./src/pairing.mjs");
const crypto = await import("node:crypto");
const secret = "fixture-secret-0123456789";
const keys = pairingKeys(secret);
const blob = Buffer.from("{\"deviceName\":\"Fixture\",\"platform\":\"ios\"}", "utf8");
console.log(JSON.stringify({
  secret,
  authToken: keys.authToken,
  deviceTag: blobTag(keys.macKey, DEVICE_SLOT, blob),
  p12Passphrase: crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update("relay-trial-p12-v1").digest("hex"),
}, null, 2));
' 
```

(Requires `CODEX_DATA_DIR` set as in the tests if config import complains: prefix with `CODEX_DATA_DIR=$(mktemp -d)`.) Record the four printed values — they are pasted into the Swift test as constants.

- [ ] **Step 2: Write the failing test**

```swift
// ios/POCVault/POCVaultTests/TrialPairingTests.swift
import XCTest
@testable import POCVault

final class TrialPairingTests: XCTestCase {
    // Fixtures generated from product/relayd/src/pairing.mjs (Step 1) — the
    // two implementations must agree byte-for-byte.
    private let secret = "fixture-secret-0123456789"
    private let expectedAuthToken = "<PASTE authToken FROM STEP 1>"
    private let expectedDeviceTag = "<PASTE deviceTag FROM STEP 1>"
    private let expectedP12Passphrase = "<PASTE p12Passphrase FROM STEP 1>"
    private let fixtureBlob = Data("{\"deviceName\":\"Fixture\",\"platform\":\"ios\"}".utf8)

    func testAuthTokenMatchesNodeDerivation() {
        XCTAssertEqual(RelayTrialPairing.authToken(secret: secret), expectedAuthToken)
    }

    func testBlobTagMatchesNodeDerivation() {
        let key = RelayTrialPairing.macKey(secret: secret)
        XCTAssertEqual(RelayTrialPairing.blobTag(macKey: key, slot: RelayTrialPairing.deviceSlot, blob: fixtureBlob), expectedDeviceTag)
        XCTAssertTrue(RelayTrialPairing.verifyTag(macKey: key, slot: RelayTrialPairing.deviceSlot, blob: fixtureBlob, tag: expectedDeviceTag))
        XCTAssertFalse(RelayTrialPairing.verifyTag(macKey: key, slot: RelayTrialPairing.nodeSlot, blob: fixtureBlob, tag: expectedDeviceTag))
    }

    func testP12PassphraseMatchesNodeDerivation() {
        XCTAssertEqual(RelayTrialPairing.p12Passphrase(secret: secret), expectedP12Passphrase)
    }

    func testGenerateSecretShape() {
        let s = RelayTrialPairing.generateSecret()
        XCTAssertNil(s.rangeOfCharacter(from: CharacterSet(charactersIn: "+/=")))
        XCTAssertGreaterThanOrEqual(s.count, 32)
        XCTAssertNotEqual(RelayTrialPairing.generateSecret(), s)
    }

    func testTrialNodeDecoding() throws {
        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1000,"expiresAt":2000}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
        XCTAssertEqual(trial.state, .ready)
        XCTAssertEqual(trial.nodeURL, URL(string: "https://node-0011223344556677.tun.test"))
    }
}
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ios/POCVault && xcodebuild test -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:POCVaultTests/TrialPairingTests 2>&1 | tail -20`
Expected: BUILD FAILED (types don't exist yet).

- [ ] **Step 4: Implement the two source files**

`RelayTrialNode.swift` exactly per the interface block. `RelayTrialPairing.swift`:

```swift
import CryptoKit
import Foundation
import Security

enum RelayTrialPairing {
    static let deviceSlot = "device-blob"
    static let nodeSlot = "node-blob"
    private static let authLabel = "relay-pair-auth-v1"
    private static let macLabel = "relay-pair-mac-v1"
    private static let p12Label = "relay-trial-p12-v1"

    static func generateSecret() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Data(bytes).base64URLEncodedString()
    }

    static func authToken(secret: String) -> String {
        var input = Data(authLabel.utf8)
        input.append(0)
        input.append(Data(secret.utf8))
        return Data(SHA256.hash(data: input)).base64URLEncodedString()
    }

    static func macKey(secret: String) -> SymmetricKey {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(macLabel.utf8), using: SymmetricKey(data: Data(secret.utf8)))
        return SymmetricKey(data: Data(mac))
    }

    static func blobTag(macKey: SymmetricKey, slot: String, blob: Data) -> String {
        var message = Data(slot.utf8)
        message.append(0)
        message.append(blob)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: macKey)).base64EncodedString()
    }

    static func verifyTag(macKey: SymmetricKey, slot: String, blob: Data, tag: String) -> Bool {
        guard let tagData = Data(base64Encoded: tag) else { return false }
        var message = Data(slot.utf8)
        message.append(0)
        message.append(blob)
        let expected = Data(HMAC<SHA256>.authenticationCode(for: message, using: macKey))
        guard expected.count == tagData.count else { return false }
        return expected.withUnsafeBytes { a in
            tagData.withUnsafeBytes { b in
                var diff: UInt8 = 0
                for i in 0..<expected.count { diff |= a[i] ^ b[i] }
                return diff == 0
            }
        }
    }

    static func p12Passphrase(secret: String) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: Data(p12Label.utf8), using: SymmetricKey(data: Data(secret.utf8)))
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
```

Paste the Step 1 fixture values into the test. Register both source files and the test file in `project.pbxproj` (sources build phases of the app and test targets respectively).

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `cd ios/POCVault && xcodebuild test -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:POCVaultTests/TrialPairingTests 2>&1 | tail -5`
Expected: `TEST SUCCEEDED` — the derivation fixtures prove Swift/Node agreement.

### Task 13: Cloud client additions — trial + rendezvous endpoints

**Files:**
- Create: `ios/POCVault/POCVault/Networking/RelayTrialClient.swift`
- Modify: `ios/POCVault/POCVault/Security/RelayAccountStore.swift` (expose the session token: add `var currentSessionToken: String? { sessionToken }`)
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj`
- Test: append cases to `ios/POCVault/POCVaultTests/TrialPairingTests.swift` (decoding/error mapping only — network calls follow the house dead-endpoint idiom)

**Interfaces:**
- Produces:

```swift
enum RelayTrialClientError: Error, Equatable {
    case unavailable        // 404 trial_unavailable
    case alreadyUsed        // 409
    case capacity           // 503
    case provisionFailed    // 502
    case noTrial            // 404 no_trial
    case blobPending        // 404 not_posted_yet
    case tagMismatch
    case server(status: Int)
}

final class RelayTrialClient {
    init(baseURL: URL, session: URLSession = .shared)  // baseURL = AppConfiguration.authBaseURL
    func createPairingSession(authToken: String, bearer: String) async throws -> String        // POST /v1/pairing/sessions {authToken} → pairingId
    func createTrial(pairingId: String, pairingSecret: String, bearer: String) async throws -> RelayTrialNode
    func currentTrial(bearer: String) async throws -> RelayTrialNode                            // throws .noTrial on 404
    func deleteTrial(bearer: String) async throws
    func postDeviceBlob(pairingId: String, authToken: String, blob: Data, tag: String) async throws        // POST device-blob
    func fetchNodeBlob(pairingId: String, authToken: String) async throws -> (blob: Data, tag: String)     // GET node-blob; .blobPending on 404
}
```

- JSON decoding: responses wrap the trial as `{"trial": {...}}` — decode via a private `struct TrialEnvelope: Decodable { let trial: RelayTrialNode }`. Blob endpoints use `X-Pairing-Auth` / `X-Pairing-Tag` headers, raw octet-stream bodies. Follow `RelayAuthClient`'s request style (`RelayAuthClient.swift:166`): same headers (`Accept`, `Cache-Control: no-store`), `Authorization: Bearer` for the session-authed calls.

- [ ] **Step 1: Write the failing test additions**

Append to `TrialPairingTests.swift`:

```swift
    func testTrialEnvelopeDecoding() throws {
        let json = #"{"trial":{"id":"t1","state":"creating","nodeId":null,"sni":null,"createdAt":1,"expiresAt":2}}"#
        let trial = try RelayTrialClient.decodeTrialEnvelope(Data(json.utf8))
        XCTAssertEqual(trial.state, .creating)
        XCTAssertNil(trial.nodeURL)
    }

    func testTrialErrorMapping() {
        XCTAssertEqual(RelayTrialClient.mapError(status: 409, code: "trial_already_used"), .alreadyUsed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 503, code: "trial_capacity"), .capacity)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "trial_unavailable"), .unavailable)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "no_trial"), .noTrial)
        XCTAssertEqual(RelayTrialClient.mapError(status: 404, code: "not_posted_yet"), .blobPending)
        XCTAssertEqual(RelayTrialClient.mapError(status: 502, code: "provision_failed"), .provisionFailed)
        XCTAssertEqual(RelayTrialClient.mapError(status: 500, code: nil), .server(status: 500))
    }
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ios/POCVault && xcodebuild test -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -only-testing:POCVaultTests/TrialPairingTests 2>&1 | tail -5`
Expected: BUILD FAILED (`RelayTrialClient` unresolved).

- [ ] **Step 3: Implement RelayTrialClient**

Implement per the interface, with two internal static helpers the tests exercise directly:

```swift
    static func decodeTrialEnvelope(_ data: Data) throws -> RelayTrialNode {
        struct TrialEnvelope: Decodable { let trial: RelayTrialNode }
        return try JSONDecoder().decode(TrialEnvelope.self, from: data).trial
    }

    static func mapError(status: Int, code: String?) -> RelayTrialClientError {
        switch (status, code) {
        case (409, _): return .alreadyUsed
        case (503, _): return .capacity
        case (502, _): return .provisionFailed
        case (404, "trial_unavailable"): return .unavailable
        case (404, "no_trial"): return .noTrial
        case (404, "not_posted_yet"): return .blobPending
        default: return .server(status: status)
        }
    }
```

The instance methods build `URLRequest`s in `RelayAuthClient`'s style, decode `{"error": "..."}` bodies for the code, and throw `Self.mapError(...)`. `RelayAccountStore` gets the one-line token accessor. Register the file in the pbxproj.

- [ ] **Step 4: Run the tests and make sure they pass**

Run: same as Step 2. Expected: `TEST SUCCEEDED`.

### Task 14: RelayNodeStore — runtime-mutable node endpoint

**Files:**
- Create: `ios/POCVault/POCVault/Models/RelayNodeStore.swift`
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift`
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj`
- Test: `ios/POCVault/POCVaultTests/TrialPairingTests.swift` (append)

**Interfaces:**
- Produces:

```swift
@MainActor final class RelayNodeStore: ObservableObject {
    @Published private(set) var activeNodeURL: URL?          // nil ⇒ use AppConfiguration.codexBaseURL
    @Published private(set) var trial: RelayTrialNode?       // last known trial state (persisted)
    var effectiveBaseURL: URL                                 // activeNodeURL ?? AppConfiguration.codexBaseURL
    init(defaults: UserDefaults = .standard)
    func adoptTrial(_ trial: RelayTrialNode)                  // persists trial JSON + sets activeNodeURL from trial.nodeURL
    func updateTrial(_ trial: RelayTrialNode?)                // refresh state (expiry countdown), keep/clear URL
    func clear()                                              // remove persisted state
}
```

- Persistence: UserDefaults key `com.parikshit.pocvault.trial.node` (JSON-encoded `RelayTrialNode`). On init, decode and restore both properties.
- App wiring (`POCVaultApp.swift`): create `@StateObject` nodeStore; `POCVaultRootView` receives a `CodexClient` built from `nodeStore.effectiveBaseURL` — construct the client at the `switch accountStore.phase` site (`.ready` branch) instead of once in `init()`, keyed with `.id(nodeStore.effectiveBaseURL)` so SwiftUI rebuilds the view tree when the node URL changes. The existing personal-install behavior is preserved exactly when `activeNodeURL == nil`.

- [ ] **Step 1: Write the failing test**

```swift
    func testNodeStorePersistsAndRestoresTrial() throws {
        let suite = "trial-node-store-tests"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defaults.removePersistentDomain(forName: suite)

        let json = #"{"id":"t1","state":"ready","nodeId":"node-0011223344556677","sni":"node-0011223344556677.tun.test","createdAt":1,"expiresAt":2}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))

        let store = RelayNodeStore(defaults: defaults)
        XCTAssertNil(store.activeNodeURL)
        store.adoptTrial(trial)
        XCTAssertEqual(store.activeNodeURL, URL(string: "https://node-0011223344556677.tun.test"))

        let restored = RelayNodeStore(defaults: defaults)
        XCTAssertEqual(restored.trial?.id, "t1")
        XCTAssertEqual(restored.activeNodeURL, store.activeNodeURL)

        restored.clear()
        XCTAssertNil(RelayNodeStore(defaults: defaults).activeNodeURL)
    }
```

(Mark the test `@MainActor func ... async throws` to construct the store, matching the house async view-model test style.)

- [ ] **Step 2: Run to verify failure** — same xcodebuild command. Expected: BUILD FAILED.

- [ ] **Step 3: Implement RelayNodeStore + app wiring** per the interface. In `POCVaultApp.swift`, the `.ready` case becomes:

```swift
        case .ready:
            POCVaultRootView(
                libraryViewModel: libraryViewModel,
                statusFeedViewModel: statusFeedViewModel,
                chatSessionStore: chatSessionStore,
                accountStore: accountStore,
                identityStore: identityStore,
                manifestClient: manifestClient,
                codexClient: CodexClient(baseURL: nodeStore.effectiveBaseURL, identityStore: identityStore)
            )
            .id(nodeStore.effectiveBaseURL)
```

(Verify the actual `POCVaultRootView` initializer signature at `POCVaultApp.swift:114` before editing and keep all existing arguments.)

- [ ] **Step 4: Run the tests** — same command. Expected: `TEST SUCCEEDED`.

- [ ] **Step 5: Full iOS suite** — `xcodebuild test -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 17 Pro' 2>&1 | tail -5`. Expected: `TEST SUCCEEDED`, 79+ tests.

### Task 15: Fork screen + trial provisioning flow

**Files:**
- Create: `ios/POCVault/POCVault/Views/TrialProvisioningView.swift`, `ios/POCVault/POCVault/Views/RelayTrialFlowModel.swift`
- Modify: `ios/POCVault/POCVault/Views/RelayOnboardingView.swift`, `ios/POCVault/POCVault/POCVaultApp.swift`
- Modify: `ios/POCVault/POCVault.xcodeproj/project.pbxproj`
- Test: `ios/POCVault/POCVaultTests/TrialPairingTests.swift` (append state-machine tests)

**Interfaces:**
- Produces:

```swift
@MainActor final class RelayTrialFlowModel: ObservableObject {
    enum Step: Equatable { case idle, creating, waitingForMachine, pairing, importingIdentity, done, failed(String) }
    @Published private(set) var step: Step = .idle
    init(client: RelayTrialClient, identityStore: ClientIdentityStore, nodeStore: RelayNodeStore,
         pollIntervalNs: UInt64 = 2_000_000_000)
    func start(bearer: String, deviceName: String) async   // full sequence below
}
```

  `start` sequence: generate secret → `createPairingSession(authToken:)` → `createTrial(pairingId:pairingSecret:)` (step `.creating`) → post device blob `{deviceName, platform:"ios"}` tagged with `blobTag` → poll `currentTrial` until `.ready` (step `.waitingForMachine`) → poll `fetchNodeBlob` swallowing `.blobPending` (step `.pairing`) → `verifyTag(...)` else `.failed` → write blob to a temp file → `identityStore.importIdentity(from:passphrase: p12Passphrase(secret:))` (step `.importingIdentity`; `ClientIdentityStore.swift:154`) → `nodeStore.adoptTrial(trial)` → `.done`. Every thrown error maps to `.failed(message)` with a user-readable message; `RelayTrialClientError.alreadyUsed` → "This account's trial was already used." etc.
- UI: `RelayOnboardingView` page 3 gains the fork: primary button **"Try instantly"** (accessibility id `relay-trial-start`, visible only when the flow model exists — i.e., always in this build), secondary **"Connect your own machine"** (opens the existing `completeOnboarding()` path, copy explains BYO install; accessibility id `relay-onboarding-continue` retained), tertiary link "What's a trial machine?" (sheet with the trust copy: *"Trial machines run on Relay infrastructure — connect your own machine for full privacy."*). "Try instantly" presents `TrialProvisioningView` (sheet), which renders the `Step` progression as a checklist (Creating → Booting → Pairing → Ready) with a retry button on `.failed`, and calls `accountStore.completeOnboarding()` on `.done`.
- App wiring: `POCVaultApp` owns `@StateObject` trial flow dependencies; pass `nodeStore` + a `RelayTrialClient(baseURL: AppConfiguration.authBaseURL)` into the onboarding view.

- [ ] **Step 1: Write the failing state-machine test**

```swift
    @MainActor
    func testTrialFlowSurfacesAlreadyUsedFailure() async {
        // Dead-endpoint client (house idiom): every call throws .server/.connection,
        // so the flow must land in .failed with a message, never hang.
        let client = RelayTrialClient(baseURL: URL(string: "http://127.0.0.1:9")!)
        let flow = RelayTrialFlowModel(
            client: client,
            identityStore: ClientIdentityStore(),
            nodeStore: RelayNodeStore(defaults: UserDefaults(suiteName: "trial-flow-tests")!),
            pollIntervalNs: 1
        )
        await flow.start(bearer: "b", deviceName: "Test")
        guard case .failed = flow.step else {
            return XCTFail("expected .failed, got \(flow.step)")
        }
    }
```

- [ ] **Step 2: Run to verify failure** — BUILD FAILED (types missing).

- [ ] **Step 3: Implement flow model + views** per the interface. Keep the chat-keyboard invariants untouched (no changes to editor views). Follow `RelayOnboardingView`'s existing styling for the new buttons; do not remove the carousel pages.

- [ ] **Step 4: Run the flow test** — `TEST SUCCEEDED`.

- [ ] **Step 5: Full iOS suite + build** — full `xcodebuild test` run: `TEST SUCCEEDED`, no new warnings.

### Task 16: Trial lifecycle UI — badge, countdown, expiry

**Files:**
- Modify: `ios/POCVault/POCVault/POCVaultApp.swift` (root toolbar area in `POCVaultRootView`), `ios/POCVault/POCVault/Views/AccountSettingsView.swift`
- Create: `ios/POCVault/POCVault/Views/TrialStatusBanner.swift`
- Test: `ios/POCVault/POCVaultTests/TrialPairingTests.swift` (append formatting tests)

**Interfaces:**
- Produces: `TrialStatusBanner(trial: RelayTrialNode, onUpgrade: () -> Void)` — compact capsule under the browser toolbar showing `Trial · <n> days left` (computed via `RelayTrialNode.remainingDescription(now:)`, a new pure helper: `>1 day` → "N days left", `<1 day` → "N hours left", expired → "Trial expired"). When `state == .expired`: full-width banner "Your trial machine has expired — data is kept for 3 days." with a "Connect your own machine" button (opens the existing BYO copy) and a "Join the paid waitlist" link posting to `/v1/waitlist` via `RelayTrialClient`. AccountSettingsView gains a "Trial machine" section (state, expiry date, Delete trial machine button → `deleteTrial` + `nodeStore.clear()`).
- On foreground (`scenePhase == .active`) the root view refreshes `currentTrial` and calls `nodeStore.updateTrial(_:)`.

- [ ] **Step 1: Write the failing formatting test**

```swift
    func testTrialRemainingDescription() throws {
        let json = #"{"id":"t","state":"ready","nodeId":"n","sni":"s.tun.test","createdAt":0,"expiresAt":172800000}"#
        let trial = try JSONDecoder().decode(RelayTrialNode.self, from: Data(json.utf8))
        XCTAssertEqual(trial.remainingDescription(now: Date(timeIntervalSince1970: 0)), "2 days left")
        XCTAssertEqual(trial.remainingDescription(now: Date(timeIntervalSince1970: 169_200)), "1 hour left")
        XCTAssertEqual(trial.remainingDescription(now: Date(timeIntervalSince1970: 200_000)), "Trial expired")
    }
```

- [ ] **Step 2: Run to verify failure** — compile error (`remainingDescription` missing).
- [ ] **Step 3: Implement** the helper on `RelayTrialNode`, the banner view, settings section, and foreground refresh.
- [ ] **Step 4: Run the tests** — `TEST SUCCEEDED`.
- [ ] **Step 5: Full iOS suite** — `TEST SUCCEEDED`.

---

## Phase 6 — Workspace export at expiry

### Task 17: relayd `GET /v1/export.tar`

**Files:**
- Modify: `product/relayd/src/fsapi.mjs` (or `src/additions.mjs` — put it wherever the other `/v1/fs` routes are registered; read the router wiring in `src/server.mjs` first and follow it)
- Test: `product/relayd/test/conformance.test.mjs` (append one test at the end, same style as the fs tests)

**Interfaces:**
- Produces: `GET /v1/export.tar` — mTLS-authed like every data route; spawns `tar -cf - -C <CODEX_WORKSPACE_BROWSE_ROOT> .` and streams stdout with `content-type: application/x-tar`, `cache-control: no-store`, `content-disposition: attachment; filename="relay-workspaces.tar"`. Applies the existing fs denylist by exporting via a file list: build the entry list with the already-present jail-safe directory walk (reuse the listing internals from fsapi.mjs) and pass paths explicitly to `tar` — secret-denylisted names are excluded. Bounded: refuse with 413 `{error:"export_too_large"}` when the pre-computed total size exceeds 512 MiB.

- [ ] **Step 1: Write the failing conformance test** (append; use the suite's existing helpers for authed requests and workspace fixtures — read the nearest fs test and copy its setup):

```js
test("GET /v1/export.tar streams a tar of the jail and excludes denylisted files", async () => {
  // ...same authed-request setup as the fs/list tests...
  // seed: welcome/hello.txt plus welcome/.env (denylisted)
  const res = await authedRequest("GET", "/v1/export.tar");
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "application/x-tar");
  const listing = tarEntryNames(res.body); // helper: parse ustar headers every 512-byte block
  assert.ok(listing.some((n) => n.endsWith("welcome/hello.txt")));
  assert.ok(!listing.some((n) => n.endsWith(".env")));
});
```

Write the small `tarEntryNames(buffer)` helper inside the test file (ustar name field = bytes 0-99 of each header block; skip file-content blocks by rounding size up to 512).

- [ ] **Step 2: Run to verify failure** — 404 from the router.
- [ ] **Step 3: Implement** the route following the exact auth/routing pattern of the adjacent fs endpoints.
- [ ] **Step 4: Run the conformance suite** — `cd product/relayd && node --test test/conformance.test.mjs` → all pass.

### Task 18: iOS export button

**Files:**
- Modify: `ios/POCVault/POCVault/Views/TrialStatusBanner.swift`, `ios/POCVault/POCVault/Networking/CodexClient.swift` (add `downloadExport() async throws -> URL` writing to a temp file via the existing mTLS session)
- Test: build + existing suite green (network path follows the dead-endpoint idiom; no new unit test beyond compilation — the live check happens in Phase 7)

- [ ] **Step 1: Implement** `downloadExport` (GET `/v1/export.tar` with the client-cert `URLSession` already used by `CodexClient`; save to `FileManager.default.temporaryDirectory/relay-workspaces.tar`) and an "Export my files" button on the expired banner presenting a `ShareLink`/`UIActivityViewController` with that file.
- [ ] **Step 2: Full iOS suite** — `TEST SUCCEEDED`.

---

## Phase 7 — Live wiring & end-to-end verification (requires owner infra access)

### Task 19: Deploy + live smoke matrix

**Blocked on owner-supplied details (gather before starting):** Cube host address + API key (from the owner's secrets manager), confirmation that relay-router may be updated, and the current SSH /32 allowlist entry.

- [ ] **Step 1: Deploy cloud + broker to relay-router.** Rsync `product/cloud` to `/opt/relay-cloud`, restart `relay-cloud`; cross-compile the broker (`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build ./cmd/broker`) and install with the new flags: `-registry-url http://127.0.0.1:8790 -registry-token-file /etc/relay-broker/registry-token` (write the token file on-box by copying the BROKER_TOKEN value from `/etc/relay-cloud/cloud.env` — on-box only, never through the laptop). Add trial env to `/etc/relay-cloud/cloud.env` on-box: `E2B_API_URL`, `E2B_API_KEY` (from the secrets manager), `TRIAL_TEMPLATE_ID=relay-trial`, `TUNNEL_HOST=<router-ip>`, `TUNNEL_PORT=80`, `TUNNEL_SUFFIX=.<dashed-router-ip>.sslip.io`, `ENROLL_BASE_URL=<public cloud URL>` (requires exposing relay-cloud via Caddy/broker for the sandbox to reach — decide with the owner: simplest is Caddy vhost on the router forwarding to 127.0.0.1:8790 for `/v1/trial-nodes/enroll`, `/v1/pairing/*`, and `/api/auth/*` only).
- [ ] **Step 2: Build the template on the Cube host:** copy `product/trial/` + `product/relayd/` over, run `./build.sh`, verify with one manual `POST /sandboxes` that a sandbox boots and its relayd appears in the broker log (`node "<node-id>" tunnel registered`).
- [ ] **Step 3: Smoke matrix (scripted where possible):** (1) `POST /v1/trial-nodes` with a real session → 201; (2) sandbox enrolls → trial `ready`; (3) broker resolves the node id via the registry hook (log line) and `curl --resolve <sni>:443:<router-ip> https://<sni>/healthz` with the trial client cert → 200; (4) unauthenticated → TLS alert; (5) reaper: set `TRIAL_TTL_SEC=60` on a second account's trial, watch pause + expiry state; (6) capacity + one-per-account rejections.
- [ ] **Step 4: Physical-device run:** TestFlight/dev build on the iPhone: sign in → Try instantly → Ready < 10 s target (measure) → device-code login for one harness inside the folder conversation → first task completes → trial badge counts down. Record timings in `product/DEPLOY.md` (genericized).
- [ ] **Step 5: Update docs:** `product/STATUS.md` (new capabilities), `revamp/07-trial-sandbox-plan.md` (mark implemented, note deltas), `product/cloud/README.md` (new env vars + routes), `product/broker/README.md` (registry flags). No live values in any doc.

---

## Self-review notes (already applied)

- Spec coverage: fork screen ✔ (T15), provisioning progress ✔ (T15), trial badge/countdown ✔ (T16), expiry/grace/destroy ✔ (T5), export ✔ (T17/T18), server-mediated pairing ✔ (T9/T15 — trial p12 variant, trust delta documented in code comments and the sheet copy), dynamic registry ✔ (T6/T7), reconnect/backoff — already shipped in relayd (verified `tunnel.mjs:417-534`), feature-flag degradation ✔ (T3 `trial_unavailable` → iOS hides the option when `createTrial` returns `.unavailable`), warning push at T-24h — **deferred**: APNs transport is still no-op in main.js (STATUS W3); wire the push when live APNs lands (tracked in spec Open Questions).
- Type consistency: trial states, error codes, header names, and derivation labels appear in exactly one canonical block (Interface Contracts) and every task references it.
- One-per-account is enforced by BOTH the route check (409) and the `UNIQUE(account_id)` column (T2), so a race collapses to the DB constraint.
