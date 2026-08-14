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
