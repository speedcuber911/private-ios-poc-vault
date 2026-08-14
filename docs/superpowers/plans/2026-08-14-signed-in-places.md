# Signed-In Places Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the iPhone list and revoke signed-in places — exactly one CLI computer, many browsers — and approve a web QR while a computer is already linked, without ever linking a second CLI.

**Architecture:** Relay-owned `browser_sessions` sidecar plus Better Auth `session` rows. Cap is a synchronous `BEGIN IMMEDIATE` count+INSERT (no `await` inside the transaction). Revoke deletes the `session` row by id with SQL, not Better Auth's token-keyed revoke API. iOS Account & Settings becomes Signed in; the scanner stays available when a computer is linked and branches copy on `client`.

**Tech Stack:** Node 22 ESM (`node:test`, `node:sqlite`, `node:crypto`), Better Auth 1.6.26 (already in cloud), SwiftUI iOS tests (`POCVaultTests`), Vite React `product/web`.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-14-signed-in-places-design.md` (review nits included).
- Exactly one CLI computer. `inspect`/`approve` of `client: "cli"` still 409 `computer_already_linked` when a link exists. `client: "web"` never 409 for that reason.
- `BROWSER_SESSION_MAX = 10`. Do not silently evict the oldest.
- Do not `await` inside `BEGIN IMMEDIATE` (shared `DatabaseSync` across requests).
- Revoke: `DELETE FROM session WHERE id = ?`, then delete the sidecar, one transaction. Never call `auth.api.revokeSession` (token-keyed; we do not store the token).
- Responses never include Better Auth session tokens or cookie values.
- Do not reuse `/v1/devices` (APNs). Do not list this iPhone as a browser. Do not add a web session manager.
- Editorial Ember: status is a word, never a dot. Copy says **machine**, not sandbox.
- Zero new npm dependencies. Secrets never in argv, logs, responses, or the repo.
- Cloud tests: `cd product/cloud && node --test test/*.test.mjs`. Web: `cd product/web && node --test test/*.test.mjs`.
- iOS tests: `xcodebuild test -project ios/POCVault/POCVault.xcodeproj -scheme POCVault -destination 'platform=iOS Simulator,name=iPhone 16' -only-testing:POCVaultTests/<Class>`.
- Commit after every task. Conventional subjects (`feat:`, `test:`, `docs:`).
- Do not `ops/deploy-poc` the app. Do not print `/etc/relay-cloud/env`.

---

## File Structure

### Modified — `product/cloud/`

| File | Change |
|---|---|
| `src/db.js` | `browser_sessions` table + index |
| `src/registry.js` | `BROWSER_SESSION_MAX`, `ensureBrowserSessionsSchema`, reserve/attach/list/revoke, deleteAccount wipe, direct `session` delete |
| `src/server.js` | `GET/DELETE /v1/auth/places`, web token writes sidecar, password-origin sidecar after `/api/auth` |
| `src/better-auth.js` | Optional: `AsyncLocalStorage` origin for session.create if wrapping `/api/auth` is cleaner |
| `README.md` | Document places endpoints |
| `test/browser-sessions.test.mjs` | **New.** Registry cap, list, revoke, join-live-session |
| `test/places.test.mjs` | **New.** HTTP list/revoke/cap/password-origin |

### Modified — `ios/POCVault/`

| File | Change |
|---|---|
| `POCVault/Views/CLILinkFlowModel.swift` | `client` on inspect result; web vs CLI copy; scanner not CLI-only |
| `POCVault/Networking/RelayAuthClient.swift` | Decode `client`; `signedInPlaces`; `removeBrowser` |
| `POCVault/Views/CLILinkScannerView.swift` | Title/confirm/success branch on `client` |
| `POCVault/Views/AccountSettingsView.swift` | Signed in section; always-on Approve a sign-in; browsers + Remove |
| `POCVaultTests/CLILinkTests.swift` | `client` copy + 409 still CLI |
| `POCVaultTests/SignedInPlacesTests.swift` | **New.** Decode places; remove path |

### Modified — `product/web/`

| File | Change |
|---|---|
| `src/pages/Login.tsx` | `too_many_browsers` copy |
| `test/device.test.mjs` | Poll surfaces cap error to the caller (already returns the poll body) |

---

### Task 1: `browser_sessions` schema and transactional reserve

**Files:**
- Modify: `product/cloud/src/db.js`
- Modify: `product/cloud/src/registry.js` (`ensureAuthSchema` or sibling `ensureBrowserSessionsSchema`, export `BROWSER_SESSION_MAX`, new functions, `deleteAccount`)
- Test: `product/cloud/test/browser-sessions.test.mjs`

**Interfaces:**
- Consumes: existing `createRegistry(db, { now })`, `randomUUID`
- Produces:
  - `BROWSER_SESSION_MAX === 10`
  - `reserveBrowserSession({ accountId, displayName, platform })` → `{ status: "ok", id }` \| `{ status: "cap" }`
  - `attachBrowserAuthSession(id, betterAuthSessionId)` → `true` if the reservation existed
  - `listBrowserSessions(accountId)` → live rows `{ id, name, platform, createdAt }`, newest first; skip null `better_auth_session_id` and expired/missing `session` rows
  - `deleteAccount` also `DELETE FROM browser_sessions WHERE account_id = ?`

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/browser-sessions.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb } from "../src/db.js";
import { BROWSER_SESSION_MAX, createRegistry } from "../src/registry.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "relay-bs-"));
  const db = createDb(join(dir, "t.sqlite"));
  db.exec(`
    CREATE TABLE IF NOT EXISTS session (
      id TEXT PRIMARY KEY,
      token TEXT,
      userId TEXT,
      expiresAt INTEGER
    );
  `);
  const registry = createRegistry(db, { now: () => 1_700_000_000_000 });
  return { db, registry };
}

test("BROWSER_SESSION_MAX is 10", () => {
  assert.equal(BROWSER_SESSION_MAX, 10);
});

test("reserveBrowserSession inserts a row and the 11th is cap", () => {
  const { registry } = setup();
  const ids = [];
  for (let i = 0; i < 10; i += 1) {
    const reserved = registry.reserveBrowserSession({
      accountId: "acct-1",
      displayName: `Browser ${i}`,
      platform: "web",
    });
    assert.equal(reserved.status, "ok");
    ids.push(reserved.id);
    assert.equal(
      registry.attachBrowserAuthSession(reserved.id, `sess-${i}`),
      true,
    );
    registry.db?.prepare?.(
      "INSERT INTO session (id, token, userId, expiresAt) VALUES (?, ?, ?, ?)",
    );
  }
  // attach + session insert via the same DatabaseSync through a test helper
  // exported only if needed: use registry's db by keeping db in setup().
});
```

Rewrite the loop to use `db` from setup (do not put `db` on registry). Full test body:

```js
test("the 11th reserve is cap and inserts no 11th sidecar row", () => {
  const { db, registry } = setup();
  for (let i = 0; i < 10; i += 1) {
    const reserved = registry.reserveBrowserSession({
      accountId: "acct-1",
      displayName: `Browser ${i}`,
      platform: "web",
    });
    assert.equal(reserved.status, "ok", `reserve ${i}`);
    assert.equal(registry.attachBrowserAuthSession(reserved.id, `sess-${i}`), true);
    db.prepare(
      "INSERT INTO session (id, token, userId, expiresAt) VALUES (?, ?, ?, ?)",
    ).run(`sess-${i}`, `tok-${i}`, "acct-1", 1_800_000_000_000);
  }
  const eleventh = registry.reserveBrowserSession({
    accountId: "acct-1",
    displayName: "Browser 10",
    platform: "web",
  });
  assert.equal(eleventh.status, "cap");
  assert.equal(eleventh.id, undefined);
  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM browser_sessions WHERE account_id = ?",
  ).get("acct-1").n;
  assert.equal(count, 10);
});

test("two accounts do not share the cap", () => {
  const { registry } = setup();
  for (let i = 0; i < 10; i += 1) {
    assert.equal(
      registry.reserveBrowserSession({ accountId: "a", displayName: "x", platform: "web" }).status,
      "ok",
    );
  }
  assert.equal(
    registry.reserveBrowserSession({ accountId: "b", displayName: "y", platform: "web" }).status,
    "ok",
  );
});

test("listBrowserSessions omits reservations still missing a Better Auth session id", () => {
  const { db, registry } = setup();
  const reserved = registry.reserveBrowserSession({
    accountId: "acct-1",
    displayName: "Safari on Mac",
    platform: "web",
  });
  assert.deepEqual(registry.listBrowserSessions("acct-1"), []);
  registry.attachBrowserAuthSession(reserved.id, "sess-live");
  db.prepare(
    "INSERT INTO session (id, token, userId, expiresAt) VALUES (?, ?, ?, ?)",
  ).run("sess-live", "tok", "acct-1", 1_800_000_000_000);
  const listed = registry.listBrowserSessions("acct-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, reserved.id);
  assert.equal(listed[0].name, "Safari on Mac");
  assert.equal(listed[0].platform, "web");
  assert.equal(listed[0].createdAt, 1_700_000_000_000);
});

test("listBrowserSessions omits expired Better Auth sessions", () => {
  const { db, registry } = setup();
  const reserved = registry.reserveBrowserSession({
    accountId: "acct-1",
    displayName: "Old",
    platform: "web",
  });
  registry.attachBrowserAuthSession(reserved.id, "sess-dead");
  db.prepare(
    "INSERT INTO session (id, token, userId, expiresAt) VALUES (?, ?, ?, ?)",
  ).run("sess-dead", "tok", "acct-1", 1_600_000_000_000);
  assert.deepEqual(registry.listBrowserSessions("acct-1"), []);
});

test("deleteAccount drops browser_sessions", () => {
  const { db, registry } = setup();
  registry.ensureAccount({ id: "acct-1", email: "a@example.com" });
  registry.reserveBrowserSession({ accountId: "acct-1", displayName: "x", platform: "web" });
  registry.deleteAccount("acct-1");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM browser_sessions WHERE account_id = ?").get("acct-1").n,
    0,
  );
});
```

Live-count for the cap must count **reservations + live attached rows** for that account (a reserved-but-not-yet-attached row still occupies a slot). `list` still hides unattached rows.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/browser-sessions.test.mjs`

Expected: FAIL (`BROWSER_SESSION_MAX` is not exported / `reserveBrowserSession` is not a function).

- [ ] **Step 3: Write minimal implementation**

In `product/cloud/src/db.js` SCHEMA, after `cli_computer_links`:

```sql
CREATE TABLE IF NOT EXISTS browser_sessions (
  id                      TEXT PRIMARY KEY,
  account_id              TEXT NOT NULL,
  better_auth_session_id  TEXT UNIQUE,
  display_name            TEXT,
  platform                TEXT,
  created_at              INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_account
  ON browser_sessions (account_id);
```

In `registry.js`, next to `ensureCliComputerSchema`, add `ensureBrowserSessionsSchema(db)` with the same `CREATE TABLE IF NOT EXISTS` (idempotent for callers that skip `createDb`). Call it from `createRegistry` after `ensureAuthSchema`.

Export:

```js
export const BROWSER_SESSION_MAX = 10;
```

`reserveBrowserSession`:

```js
function reserveBrowserSession({ accountId, displayName, platform }) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const { n } = db.prepare(
      "SELECT COUNT(*) AS n FROM browser_sessions WHERE account_id = ?",
    ).get(accountId);
    if (Number(n) >= BROWSER_SESSION_MAX) {
      db.exec("ROLLBACK");
      return { status: "cap" };
    }
    const id = randomUUID();
    db.prepare(
      `INSERT INTO browser_sessions
         (id, account_id, better_auth_session_id, display_name, platform, created_at)
       VALUES (?, ?, NULL, ?, ?, ?)`,
    ).run(id, accountId, displayName ?? null, platform ?? null, now());
    db.exec("COMMIT");
    return { status: "ok", id };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
```

`attachBrowserAuthSession(id, betterAuthSessionId)`: `UPDATE ... SET better_auth_session_id = ? WHERE id = ? AND better_auth_session_id IS NULL`, return `changes > 0`.

`listBrowserSessions(accountId)`: join `browser_sessions` to `session` on `better_auth_session_id = session.id` where `better_auth_session_id IS NOT NULL` and `session.expiresAt > now()` (Better Auth 1.6 sqlite stores `expiresAt` as integer ms in this codebase's injected DatabaseSync — if a live HTTP test shows ISO text, compare with `CAST(strftime('%s', session.expiresAt) AS INTEGER) * 1000`. Confirm in Task 3 against a real minted session; do not guess twice). Order `created_at DESC`. Map `display_name` → `name`.

If `session` table is missing (unit test without the stub), `listBrowserSessions` should not throw: catch `no such table` and return `[]` **only in tests if you must** — prefer always creating the join against `session` and requiring the stub in unit tests. HTTP tests have Better Auth's table.

Add `DELETE FROM browser_sessions WHERE account_id = ?` inside `deleteAccount`'s existing transaction, next to `cli_computer_links`.

Export the new functions on the registry return object.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd product/cloud && node --test test/browser-sessions.test.mjs`

Expected: PASS. Then `node --test test/*.test.mjs` still green.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/db.js product/cloud/src/registry.js product/cloud/test/browser-sessions.test.mjs
git commit -m "$(cat <<'EOF'
feat(cloud): reserve browser sessions with a transactional cap

Count and insert share BEGIN IMMEDIATE so two sign-ins at 9 rows
cannot persist an 11th sidecar.
EOF
)"
```

---

### Task 2: Revoke by sidecar id with a direct `session` delete

**Files:**
- Modify: `product/cloud/src/registry.js`
- Test: `product/cloud/test/browser-sessions.test.mjs`

**Interfaces:**
- Consumes: Task 1 reserve/attach/list
- Produces:
  - `revokeBrowserSession(accountId, id)` → `{ status: "ok" }` \| `{ status: "unknown" }`
  - Deletes the Better Auth `session` row by **id** (`DELETE FROM session WHERE id = ?`), then the sidecar, in one `BEGIN IMMEDIATE`. Foreign or missing ids are `unknown` (no 403 distinction).
  - Does not touch `cli_computer_links`.

- [ ] **Step 1: Write the failing test**

Append to `product/cloud/test/browser-sessions.test.mjs`:

```js
test("revokeBrowserSession deletes the sidecar and the session row", () => {
  const { db, registry } = setup();
  const reserved = registry.reserveBrowserSession({
    accountId: "acct-1",
    displayName: "Chrome",
    platform: "web",
  });
  registry.attachBrowserAuthSession(reserved.id, "sess-live");
  db.prepare(
    "INSERT INTO session (id, token, userId, expiresAt) VALUES (?, ?, ?, ?)",
  ).run("sess-live", "tok", "acct-1", 1_800_000_000_000);

  const other = registry.reserveBrowserSession({
    accountId: "acct-1",
    displayName: "Firefox",
    platform: "web",
  });
  registry.attachBrowserAuthSession(other.id, "sess-other");
  db.prepare(
    "INSERT INTO session (id, token, userId, expiresAt) VALUES (?, ?, ?, ?)",
  ).run("sess-other", "tok2", "acct-1", 1_800_000_000_000);

  assert.equal(registry.revokeBrowserSession("acct-1", reserved.id).status, "ok");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM session WHERE id = ?").get("sess-live").n,
    0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM session WHERE id = ?").get("sess-other").n,
    1,
  );
  assert.equal(registry.listBrowserSessions("acct-1").length, 1);
  assert.equal(registry.listBrowserSessions("acct-1")[0].id, other.id);
});

test("revokeBrowserSession is unknown for a foreign account or missing id", () => {
  const { registry } = setup();
  const reserved = registry.reserveBrowserSession({
    accountId: "acct-1",
    displayName: "Chrome",
    platform: "web",
  });
  assert.equal(registry.revokeBrowserSession("acct-2", reserved.id).status, "unknown");
  assert.equal(registry.revokeBrowserSession("acct-1", "no-such").status, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/browser-sessions.test.mjs`

Expected: FAIL (`revokeBrowserSession` is not a function).

- [ ] **Step 3: Write minimal implementation**

```js
function revokeBrowserSession(accountId, id) {
  if (!id) return { status: "unknown" };
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare(
      "SELECT * FROM browser_sessions WHERE id = ? AND account_id = ?",
    ).get(id, accountId);
    if (!row) {
      db.exec("ROLLBACK");
      return { status: "unknown" };
    }
    if (row.better_auth_session_id) {
      try {
        db.prepare("DELETE FROM session WHERE id = ?").run(row.better_auth_session_id);
      } catch (err) {
        if (!/no such table/i.test(err.message || "")) throw err;
      }
    }
    db.prepare("DELETE FROM browser_sessions WHERE id = ? AND account_id = ?")
      .run(id, accountId);
    db.exec("COMMIT");
    return { status: "ok" };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
```

Do not import or call Better Auth here. Policy stays in `server.js`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd product/cloud && node --test test/browser-sessions.test.mjs && node --test test/*.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/registry.js product/cloud/test/browser-sessions.test.mjs
git commit -m "$(cat <<'EOF'
feat(cloud): revoke a browser by deleting the session row

Better Auth's revoke API keys off the token, which we do not store.
EOF
)"
```

---

### Task 3: HTTP `GET/DELETE /v1/auth/places` and web-token sidecar

**Files:**
- Modify: `product/cloud/src/server.js` (`mintBetterAuthSessionCookie` + device/token web branch + places routes)
- Test: `product/cloud/test/places.test.mjs`
- Modify: `product/cloud/README.md` (endpoint table only)

**Interfaces:**
- Consumes: Task 1–2 registry functions; existing `publicCliComputer`, `mintBetterAuthSessionCookie`, CSRF `/v1/` DELETE guard (already applies)
- Produces:
  - `GET /v1/auth/places` → `{ computer, browsers }` (`computer` matches `publicCliComputer`, `browsers` from `listBrowserSessions`)
  - `DELETE /v1/auth/places/browsers/:id` → `{ ok: true }` or 404 `{ error: "unknown_browser" }`
  - Web `POST /v1/auth/device/token`: reserve → mint cookie → attach. On `cap`, 429 `{ error: "too_many_browsers" }` and do not Set-Cookie. On mint failure, delete the reservation.
  - `mintBetterAuthSessionCookie` returns `{ cookie, sessionId }` (sessionId is Better Auth `session.id`)

- [ ] **Step 1: Write the failing test**

Create `product/cloud/test/places.test.mjs`. Reuse helpers from `device-code.test.mjs` / `helpers.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { startTestApp, api, signIn, authed } from "./helpers.mjs";

const APP = "https://app.example.test";

async function signUp(t, { email, username }) {
  const res = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
    headers: { origin: t.config.betterAuthBaseURL },
    body: { email, username, name: username, password: "correct-horse-battery" },
  });
  assert.equal(res.status, 200);
  return res.headers.get("set-auth-token");
}

async function approveWeb(t, sessionToken, machineName = "This browser") {
  const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
    body: { client: "web", machineName, platform: "web" },
  });
  assert.equal(started.status, 201);
  assert.equal(
    (await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: started.json.userCode },
      ...authed(sessionToken),
    })).status,
    200,
  );
  const granted = await api(t.baseUrl, "POST", "/v1/auth/device/token", {
    body: { deviceCode: started.json.deviceCode },
  });
  return { started, granted };
}

test("GET /v1/auth/places requires a session", async () => {
  const t = await startTestApp();
  try {
    assert.equal((await api(t.baseUrl, "GET", "/v1/auth/places")).status, 401);
  } finally { await t.close(); }
});

test("places lists a linked computer and no browsers", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const started = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { machineName: "dev-box", platform: "macos" },
    });
    assert.equal(
      (await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
        body: { userCode: started.json.userCode },
        ...authed(session.sessionToken),
      })).status,
      200,
    );
    await api(t.baseUrl, "POST", "/v1/auth/device/token", {
      body: { deviceCode: started.json.deviceCode },
    });
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    assert.equal(places.status, 200);
    assert.equal(places.json.computer.machineName, "dev-box");
    assert.equal(places.json.computer.status, "connected");
    assert.deepEqual(places.json.browsers, []);
  } finally { await t.close(); }
});

test("a web token appears as a browser and does not drop the computer", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t, { sub: "both", email: "both@example.com" });
    const cli = await api(t.baseUrl, "POST", "/v1/auth/device/start", {
      body: { machineName: "dev-box", platform: "macos" },
    });
    await api(t.baseUrl, "POST", "/v1/auth/device/approve", {
      body: { userCode: cli.json.userCode },
      ...authed(session.sessionToken),
    });
    await api(t.baseUrl, "POST", "/v1/auth/device/token", {
      body: { deviceCode: cli.json.deviceCode },
    });
    const { granted } = await approveWeb(t, session.sessionToken, "Safari on Mac");
    assert.equal(granted.status, 200);
    const cookie = (granted.headers.get("set-cookie") || "").split(";")[0];
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    assert.equal(places.json.computer.machineName, "dev-box");
    assert.equal(places.json.browsers.length, 1);
    assert.equal(places.json.browsers[0].name, "Safari on Mac");
    assert.equal(places.json.browsers[0].platform, "web");
    assert.ok(places.json.browsers[0].id);
    assert.equal(places.json.browsers[0].token, undefined);
    const me = await api(t.baseUrl, "GET", "/v1/account", { headers: { cookie } });
    assert.equal(me.status, 200);
  } finally { await t.close(); }
});

test("DELETE /v1/auth/places/browsers/:id signs that browser out and keeps the computer", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t, { sub: "rev", email: "rev@example.com" });
    const { granted } = await approveWeb(t, session.sessionToken);
    const cookie = (granted.headers.get("set-cookie") || "").split(";")[0];
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    const id = places.json.browsers[0].id;
    const removed = await api(
      t.baseUrl,
      "DELETE",
      `/v1/auth/places/browsers/${id}`,
      authed(session.sessionToken),
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.json.ok, true);
    assert.equal(
      (await api(t.baseUrl, "GET", "/v1/account", { headers: { cookie } })).status,
      401,
    );
    const after = await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken));
    assert.deepEqual(after.json.browsers, []);
  } finally { await t.close(); }
});

test("DELETE of a missing or foreign browser is unknown_browser", async () => {
  const t = await startTestApp();
  try {
    const session = await signIn(t);
    const other = await signIn(t, { sub: "other", email: "other-places@example.com" });
    const { granted } = await approveWeb(t, session.sessionToken);
    assert.equal(granted.status, 200);
    const id = (await api(t.baseUrl, "GET", "/v1/auth/places", authed(session.sessionToken)))
      .json.browsers[0].id;
    const foreign = await api(
      t.baseUrl,
      "DELETE",
      `/v1/auth/places/browsers/${id}`,
      authed(other.sessionToken),
    );
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json.error, "unknown_browser");
    const missing = await api(
      t.baseUrl,
      "DELETE",
      "/v1/auth/places/browsers/no-such",
      authed(session.sessionToken),
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error, "unknown_browser");
  } finally { await t.close(); }
});

test("the 11th web token is too_many_browsers and sets no cookie", async () => {
  const t = await startTestApp();
  try {
    const token = await signUp(t, { email: "cap@example.com", username: "capuser" });
    for (let i = 0; i < 10; i += 1) {
      const { granted } = await approveWeb(t, token, `Browser ${i}`);
      assert.equal(granted.status, 200, `mint ${i}`);
    }
    const eleventh = await approveWeb(t, token, "Browser 10");
    assert.equal(eleventh.granted.status, 429);
    assert.equal(eleventh.granted.json.error, "too_many_browsers");
    assert.equal(eleventh.granted.headers.get("set-cookie"), null);
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(token));
    assert.equal(places.json.browsers.length, 10);
  } finally { await t.close(); }
});
```

If `session.expiresAt` format makes list empty in the HTTP test, fix the join in Task 1's `listBrowserSessions` here (ISO vs integer) — that is part of making this test pass, not a new task.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/places.test.mjs`

Expected: FAIL (`GET /v1/auth/places` is 404, not 401/200).

- [ ] **Step 3: Write minimal implementation**

Change `mintBetterAuthSessionCookie` to return `{ cookie, sessionId }` or `null`. `sessionId` is `session.id` from `createSession`.

Web token branch (`POST /v1/auth/device/token`, `record.client === "web"`), after the account is loaded:

```js
const reserved = registry.reserveBrowserSession({
  accountId: account.id,
  displayName: record.machineName,
  platform: record.platform,
});
if (reserved.status === "cap") {
  return sendJson(res, 429, { error: "too_many_browsers" });
}
const minted = await mintBetterAuthSessionCookie(account);
if (!minted) {
  registry.revokeBrowserSession(account.id, reserved.id);
  return sendJson(res, 400, { error: "web_session_unavailable" });
}
registry.attachBrowserAuthSession(reserved.id, minted.sessionId);
const consumed = registry.consumeDeviceCode(record.id);
if (!consumed) {
  registry.revokeBrowserSession(account.id, reserved.id);
  return sendJson(res, 400, { error: "invalid_grant" });
}
return sendJson(res, 200, { accountId: account.id }, { "set-cookie": minted.cookie });
```

Session-authed block, next to `/v1/auth/device/link`:

```js
if (path === "/v1/auth/places" && method === "GET") {
  return sendJson(res, 200, {
    computer: publicCliComputer(registry.getCliComputerLink(account.id)),
    browsers: registry.listBrowserSessions(account.id),
  });
}

if (method === "DELETE" && seg[0] === "v1" && seg[1] === "auth" && seg[2] === "places" && seg[3] === "browsers" && seg[4]) {
  const revoked = registry.revokeBrowserSession(account.id, seg[4]);
  if (revoked.status !== "ok") {
    return sendJson(res, 404, { error: "unknown_browser" });
  }
  return sendJson(res, 200, { ok: true });
}
```

README: add the two rows under the existing device-code table. Do not rewrite the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd product/cloud && node --test test/places.test.mjs test/device-code.test.mjs test/csrf.test.mjs`

Expected: PASS. CSRF still covers this DELETE (foreign Origin 403) because it is `/v1/` + DELETE.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/server.js product/cloud/test/places.test.mjs product/cloud/README.md
git commit -m "$(cat <<'EOF'
feat(cloud): list and revoke signed-in places

Web device-code tokens occupy a browser sidecar slot instead of the
CLI computer, and DELETE inherits the /v1 CSRF origin guard.
EOF
)"
```

---

### Task 4: Password web-origin sign-in writes a sidecar

**Files:**
- Modify: `product/cloud/src/server.js` and/or `product/cloud/src/better-auth.js`
- Test: `product/cloud/test/places.test.mjs`

**Interfaces:**
- Consumes: Task 1 reserve/attach; `config.trustedWebOrigins`
- Produces: a successful `POST /api/auth/sign-in/username` or `sign-up/email` whose `Origin` is in `trustedWebOrigins` inserts a sidecar (`platform: "web"`, `display_name` from sanitized User-Agent ≤64 chars). iOS-style `/api/auth` with no that Origin does not. At cap: 429 `too_many_browsers`, Better Auth session deleted, cookie cleared (`Set-Cookie` max-age 0).

Do **not** treat `betterAuthBaseURL` as a web origin for this sidecar (tests and the API origin stay phone-like).

- [ ] **Step 1: Write the failing test**

Append to `product/cloud/test/places.test.mjs`:

```js
test("password sign-up from a trusted web origin appears as a browser", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const signup = await api(t.baseUrl, "POST", "/api/auth/sign-up/email", {
      headers: { origin: APP, "user-agent": "Mozilla/5.0 Safari/605.1.15" },
      body: {
        email: "webpass@example.test",
        username: "webpass",
        name: "webpass",
        password: "correct-horse-battery",
      },
    });
    assert.equal(signup.status, 200);
    const bearer = signup.headers.get("set-auth-token");
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(bearer));
    assert.equal(places.json.browsers.length, 1);
    assert.equal(places.json.browsers[0].platform, "web");
    assert.ok(String(places.json.browsers[0].name || "").length > 0);
  } finally { await t.close(); }
});

test("password sign-up without a trusted web Origin does not appear as a browser", async () => {
  const t = await startTestApp({ env: { RELAY_WEB_ORIGINS: APP } });
  try {
    const token = await signUp(t, { email: "phonepass@example.test", username: "phonepass" });
    const places = await api(t.baseUrl, "GET", "/v1/auth/places", authed(token));
    assert.deepEqual(places.json.browsers, []);
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/cloud && node --test test/places.test.mjs`

Expected: FAIL (browsers length 0 after web-origin signup).

- [ ] **Step 3: Write minimal implementation**

Prefer wrapping `/api/auth` in `server.js` over a racy module global:

After `betterAuth.handler` returns, you cannot run more logic (it already wrote `res`). Use `AsyncLocalStorage` keyed by Origin, set in `handle` before calling the handler, read in `databaseHooks.session.create.after` in `better-auth.js`.

`product/cloud/src/web-origin.js` (new, tiny):

```js
import { AsyncLocalStorage } from "node:async_hooks";
export const webOriginStore = new AsyncLocalStorage();
```

In `server.js` `/api/auth` branch:

```js
return webOriginStore.run(originOf(req), () => betterAuth.handler(req, res));
```

In `createRelayBetterAuth`, `databaseHooks.session.create.after(session)`:

```js
const origin = webOriginStore.getStore();
const trusted = config.trustedWebOrigins || [];
if (!origin || !trusted.includes(origin)) return;
const reserved = registry.reserveBrowserSession({
  accountId: session.userId,
  displayName: sanitizeBrowserName(session.userAgent),
  platform: "web",
});
if (reserved.status === "cap") {
  try { db.prepare("DELETE FROM session WHERE id = ?").run(session.id); } catch {}
  return;
}
registry.attachBrowserAuthSession(reserved.id, session.id);
```

Cap on this path: Better Auth has already set the cookie. Also intercept in `server.js` is hard. Spec requires 429 + clear cookie. If the hook cannot change the HTTP status, wrap the Node handler:

Capture `res.end` / `writeHead` only for `POST /api/auth/sign-up/email` and `POST /api/auth/sign-in/username` when Origin is trusted. After the handler finishes with 200, `GET` live browser count; if we had to delete the session in the hook on cap, overwrite status 429 and `Set-Cookie` max-age 0.

Simpler cap behavior that still matches the spec: in the hook, on cap, delete `session` immediately. Cookie is set but the next request is 401. **Not good enough** — spec wants 429. Implement the wrapper:

```js
if (isWebPasswordAuth(method, path) && trusted.includes(originOf(req))) {
  const captured = captureResponse(res);
  await webOriginStore.run(originOf(req), () => betterAuth.handler(req, captured.proxy));
  if (captured.status === 200 && registry last reserve was cap) {
    return sendJson(res, 429, { error: "too_many_browsers" }, { "set-cookie": expireCookie });
  }
  return captured.flush(res);
}
```

Keep `captureResponse` local to `server.js` (no new framework). `sanitizeBrowserName(ua)`: strip control chars, slice 64, fallback `"Browser"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd product/cloud && node --test test/places.test.mjs test/csrf.test.mjs test/better-auth.test.mjs`

Expected: PASS. Apple `/v1/auth/apple` still creates no sidecar.

- [ ] **Step 5: Commit**

```bash
git add product/cloud/src/server.js product/cloud/src/better-auth.js product/cloud/src/web-origin.js product/cloud/test/places.test.mjs
git commit -m "$(cat <<'EOF'
feat(cloud): record password web logins as browser places

Only trusted SPA origins get a sidecar; the API origin and iOS
bearer sign-in stay off the list.
EOF
)"
```

---

### Task 5: iOS inspect `client` and confirm copy

**Files:**
- Modify: `ios/POCVault/POCVault/Views/CLILinkFlowModel.swift`
- Modify: `ios/POCVault/POCVault/Networking/RelayAuthClient.swift`
- Modify: `ios/POCVault/POCVault/Views/CLILinkScannerView.swift`
- Test: `ios/POCVault/POCVaultTests/CLILinkTests.swift`

**Interfaces:**
- Consumes: inspect JSON already includes `client`
- Produces: `DeviceCodeInspectResult.client` is `"cli"` \| `"web"` (missing → `"cli"`). Confirm/success/stale copy branch. 409 still `alreadyLinkedMessage`. Scanner title: web → "Approve a sign-in", cli → "Link a computer".

- [ ] **Step 1: Write the failing test**

In `CLILinkTests.swift`, extend `DeviceCodeInspectResult` usage:

```swift
func testFlowWebClientUsesBrowserConfirmCopy() async {
    let stub = StubCLILinkAuth()
    stub.inspectResult = DeviceCodeInspectResult(
        machineName: "This browser",
        platform: "web",
        createdAt: 1,
        expiresAt: 2,
        client: .web
    )
    let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")
    await model.submitScannedPayload("https://relay.example/cli-login#code=ABCD-EFGH")
    XCTAssertEqual(
        model.step,
        .confirm(machineName: "This browser", platform: "web", client: .web)
    )
}

func testFlowMissingClientIsCli() async {
    let stub = StubCLILinkAuth()
    stub.inspectResult = DeviceCodeInspectResult(
        machineName: "dev-box",
        platform: "macos",
        createdAt: 1,
        expiresAt: 2,
        client: .cli
    )
    let model = CLILinkFlowModel(authClient: stub, bearerToken: "tok")
    await model.submitScannedPayload("ABCD-EFGH")
    XCTAssertEqual(
        model.step,
        .confirm(machineName: "dev-box", platform: "macos", client: .cli)
    )
}

func testWebStaleCopyDoesNotMentionRelayLogin() {
    XCTAssertFalse(CLILinkFlowModel.staleCodeMessage(for: .web).contains("`relay login`"))
    XCTAssertTrue(CLILinkFlowModel.staleCodeMessage(for: .cli).contains("`relay login`"))
}
```

Keep `testFlowExplainsSingleComputerConflict` unchanged.

Update `StubCLILinkAuth` and existing happy-path test to pass `client: .cli` on `DeviceCodeInspectResult`.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
xcodebuild test \
  -project ios/POCVault/POCVault.xcodeproj \
  -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:POCVaultTests/CLILinkTests
```

Expected: FAIL (no `client` on `DeviceCodeInspectResult`, extra `confirm` associated value).

If that simulator name is missing, use `xcrun simctl list devices available` and pick any iPhone.

- [ ] **Step 3: Write minimal implementation**

```swift
enum DeviceCodeClient: String, Equatable {
    case cli
    case web
}

struct DeviceCodeInspectResult: Equatable {
    let machineName: String?
    let platform: String?
    let createdAt: Int64
    let expiresAt: Int64
    let client: DeviceCodeClient
}
```

`Step.confirm(machineName:platform:client:)`. Decode `client` in `RelayAuthClient.deviceInspect` (`"web"` → `.web`, else `.cli`).

Copy:

- web confirm: “Only continue if you just tapped Sign in with iPhone in this browser.”
- cli confirm: existing `relay login` sentence
- web success: “This browser is signed in.”
- cli success: existing finish-`relay login` sentence
- web stale: “That code isn't valid anymore. Open Sign in with iPhone again to get a fresh one.”
- cli stale: existing message
- 409: existing `alreadyLinkedMessage`

`CLILinkScannerView`: `navigationTitle` and primary button from `model.pendingClient` / confirm associated `client`. Web primary: “Sign in this browser”. CLI primary: “Link computer”.

- [ ] **Step 4: Run test to verify it passes**

Same `xcodebuild test ... -only-testing:POCVaultTests/CLILinkTests`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/POCVault/POCVault/Views/CLILinkFlowModel.swift \
  ios/POCVault/POCVault/Networking/RelayAuthClient.swift \
  ios/POCVault/POCVault/Views/CLILinkScannerView.swift \
  ios/POCVault/POCVaultTests/CLILinkTests.swift
git commit -m "$(cat <<'EOF'
feat(ios): treat web device codes as browser sign-in

A second CLI scan still fails until the linked computer is
disconnected.
EOF
)"
```

---

### Task 6: iOS Signed in list, always-on Approve a sign-in, Remove

**Files:**
- Modify: `ios/POCVault/POCVault/Networking/RelayAuthClient.swift`
- Modify: `ios/POCVault/POCVault/Views/AccountSettingsView.swift`
- Modify: `ios/POCVault/POCVault/Views/CLILinkFlowModel.swift` (add `CLIBrowserSession` next to `CLIComputerLink` if that is where link types live — keep types next to the client that decodes them)
- Test: `ios/POCVault/POCVaultTests/SignedInPlacesTests.swift`

**Interfaces:**
- Consumes: Task 3 JSON; Task 5 scanner
- Produces:
  - `signedInPlaces(bearerToken:)` → `(computer: CLIComputerLink?, browsers: [RelayBrowserSession])`
  - `removeBrowser(id:bearerToken:)`
  - Account section title **Signed in**. **Approve a sign-in** is always shown (including when `linkedComputer != nil`). Each browser has **Remove**. Footer is the spec's single combined paragraph.

- [ ] **Step 1: Write the failing test**

`ios/POCVault/POCVaultTests/SignedInPlacesTests.swift`:

```swift
import XCTest
@testable import POCVault

final class SignedInPlacesTests: XCTestCase {
    func testPlacesPayloadDecodesComputerAndBrowsers() throws {
        let data = Data(#"""
        {
          "computer": {
            "id": "c1",
            "machineName": "dev-box",
            "platform": "macos",
            "status": "connected",
            "connectedAt": 1,
            "createdAt": 1
          },
          "browsers": [
            { "id": "b1", "name": "Safari on Mac", "platform": "web", "createdAt": 2 }
          ]
        }
        """#.utf8)
        let places = try JSONDecoder().decode(RelaySignedInPlaces.self, from: data)
        XCTAssertEqual(places.computer?.id, "c1")
        XCTAssertEqual(places.browsers.count, 1)
        XCTAssertEqual(places.browsers[0].id, "b1")
        XCTAssertEqual(places.browsers[0].name, "Safari on Mac")
    }

    func testPlacesPayloadAllowsNullComputer() throws {
        let data = Data(#"""
        { "computer": null, "browsers": [] }
        """#.utf8)
        let places = try JSONDecoder().decode(RelaySignedInPlaces.self, from: data)
        XCTAssertNil(places.computer)
        XCTAssertTrue(places.browsers.isEmpty)
    }
}
```

Add a small `RelaySignedInPlaces` / `RelayBrowserSession` Codable in `RelayAuthClient.swift` or `CLILinkFlowModel.swift`.

- [ ] **Step 2: Run test to verify it fails**

```bash
xcodebuild test \
  -project ios/POCVault/POCVault.xcodeproj \
  -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:POCVaultTests/SignedInPlacesTests
```

Expected: FAIL (types missing).

- [ ] **Step 3: Write minimal implementation**

Client:

```swift
struct RelayBrowserSession: Decodable, Equatable, Identifiable {
    let id: String
    let name: String?
    let platform: String?
    let createdAt: Int64
}

struct RelaySignedInPlaces: Decodable, Equatable {
    let computer: CLIComputerLink?
    let browsers: [RelayBrowserSession]
}

func signedInPlaces(bearerToken: String) async throws -> RelaySignedInPlaces
func removeBrowser(id: String, bearerToken: String) async throws
```

`GET /v1/auth/places`, `DELETE /v1/auth/places/browsers/:id`.

`AccountSettingsView`:

- Replace Computers section header with **Signed in**.
- Load `signedInPlaces` instead of only `linkedComputer` (keep `linkedComputer` derived from `places.computer` so the connecting poll still works).
- Always show `Button("Approve a sign-in") { showingCLILink = true }` (disabled only while loading/disconnecting).
- For each browser: name (fallback “Browser”), platform label (`web` → “Web”), signed-in time, `Button("Remove", role: .destructive)`.
- Confirmation dialog matching Disconnect: “Remove \(name)? That browser will be signed out.”
- Footer: spec §5 combined paragraph.
- Accessibility ids: `relay-approve-sign-in`, `relay-remove-browser`.
- Keep Disconnect computer behavior.

Do not hide Approve a sign-in when a computer is connected. That is the whole bug.

- [ ] **Step 4: Run test to verify it passes**

```bash
xcodebuild test \
  -project ios/POCVault/POCVault.xcodeproj \
  -scheme POCVault \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  -only-testing:POCVaultTests/SignedInPlacesTests \
  -only-testing:POCVaultTests/CLILinkTests \
  -only-testing:POCVaultTests/AccountTests
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ios/POCVault/POCVault/Networking/RelayAuthClient.swift \
  ios/POCVault/POCVault/Views/AccountSettingsView.swift \
  ios/POCVault/POCVault/Views/CLILinkFlowModel.swift \
  ios/POCVault/POCVaultTests/SignedInPlacesTests.swift
git commit -m "$(cat <<'EOF'
feat(ios): show signed-in computers and browsers

Approve a sign-in stays available while a computer is linked so the
web console can be authorized without disconnecting the CLI.
EOF
)"
```

---

### Task 7: Web `too_many_browsers` copy

**Files:**
- Modify: `product/web/src/pages/Login.tsx`
- Test: `product/web/test/device.test.mjs` (poll already returns non-pending errors; add an iPhone-panel test if Login is not unit-tested — prefer extracting the error mapper)

**Interfaces:**
- Consumes: poll body `{ error: "too_many_browsers" }`
- Produces: Sign in with iPhone panel shows: “This account already has 10 signed-in browsers. Remove one from the Relay app, then try again.”

- [ ] **Step 1: Write the failing test**

If Login has no unit test file, add `product/web/test/login-errors.test.mjs` that imports a tiny mapper extracted from Login (do not mount React):

In `product/web/src/pages/Login.tsx` export:

```js
export function iphonePollErrorMessage(error) {
  if (error === "expired_token") return "That code isn't valid anymore.";
  if (error === "too_many_browsers") {
    return "This account already has 10 signed-in browsers. Remove one from the Relay app, then try again.";
  }
  return "Relay could not complete that request.";
}
```

Test:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { iphonePollErrorMessage } from "../src/pages/Login.tsx";
```

If Node cannot import `.tsx`, put the mapper in `product/web/src/api/device.js` next to `pollWebLogin` and test it from `device.test.mjs`:

```js
test("iphonePollErrorMessage explains the browser cap", async () => {
  const { iphonePollErrorMessage } = await import("../src/api/device.js");
  assert.match(iphonePollErrorMessage("too_many_browsers"), /10 signed-in browsers/);
  assert.match(iphonePollErrorMessage("expired_token"), /isn't valid anymore/);
});
```

Add `iphonePollErrorMessage` to `device.js` and use it from `IPhonePanel` in `Login.tsx`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd product/web && node --test test/device.test.mjs`

Expected: FAIL (export missing).

- [ ] **Step 3: Write minimal implementation**

Add `iphonePollErrorMessage` to `device.js`. In `IPhonePanel`, replace the `expired_token` / generic branches with `setError(iphonePollErrorMessage(granted.json?.error))` (skip `aborted`).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd product/web && node --test test/*.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add product/web/src/api/device.js product/web/src/pages/Login.tsx product/web/test/device.test.mjs
git commit -m "$(cat <<'EOF'
feat(web): explain the ten-browser sign-in cap

Point the user at Remove in the Relay app instead of a generic
failure.
EOF
)"
```

---

## Self-review

**Spec coverage**

| Spec | Task |
|---|---|
| One CLI, 409 until unlink | existing device-code tests + Task 5 copy |
| Many browsers, list/revoke | Tasks 1–3, 6 |
| Ungated scanner | Task 6 |
| Web QR while CLI linked | existing + Task 3 combined test |
| Cap 10, transactional count+insert, no await in txn | Task 1 |
| Direct `DELETE FROM session` | Task 2 |
| Password web origin sidecar; API origin is not | Task 4 |
| Cookie-clear 429 on password cap | Task 4 |
| CSRF on DELETE /v1/… | inherited; Task 3 notes csrf.test.mjs |
| Web cap copy | Task 7 |
| Not APNs `/v1/devices` | no task touches it |
| iPhone not a list row | Task 6 |

**Placeholder scan:** none remaining.

**Type consistency:** `BROWSER_SESSION_MAX`, `reserveBrowserSession` / `attachBrowserAuthSession` / `listBrowserSessions` / `revokeBrowserSession`, `RelaySignedInPlaces`, `DeviceCodeClient`, `iphonePollErrorMessage` are used under the same names in later tasks.
