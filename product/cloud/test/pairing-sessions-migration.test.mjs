// Coverage for the `kind` branch of migratePairingSessions (db.js) — the
// three-line guard that drops a pre-Task-10 pairing_sessions table
// (auth_token_hash present, kind absent) so createDb's SCHEMA can recreate it
// with kind. Every other test in this suite opens its database via
// createDb(":memory:"), which never had a pre-Task-10 table to begin with —
// SCHEMA just creates the current shape from nothing — so that branch of
// migratePairingSessions never actually runs in any of those tests, green or
// not. This file builds a REAL on-disk database file with the pre-Task-10
// shape directly (bypassing db.js entirely for the fixture) so the DROP TABLE
// path itself is exercised and pinned, not merely inspected by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "../src/db.js";
import { createRegistry } from "../src/registry.js";

// Exact pre-Task-10 shape (see db.js history at commit 0f35152, before
// `39c8eec` added `kind`): auth_token_hash is present (so this is NOT the
// even-older v1 secret_hash shape, which the OTHER branch of
// migratePairingSessions handles), kind is not.
function buildPreTask10Db(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE pairing_sessions (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL,
      auth_token_hash TEXT NOT NULL,
      node_blob       TEXT,
      node_tag        TEXT,
      node_read_at    INTEGER,
      device_blob     TEXT,
      device_tag      TEXT,
      device_read_at  INTEGER,
      closed_at       INTEGER,
      expires_at      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO pairing_sessions
       (id, account_id, auth_token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("session-preexisting", "acct-1", "hash-of-a-v1-secret", 999999999999, 1000);
  db.close();
}

test("createDb migrates a pre-kind pairing_sessions table instead of leaving it stale", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-pairing-migration-"));
  const filePath = path.join(dir, "relay.sqlite");
  try {
    buildPreTask10Db(filePath);

    // Sanity: the fixture really is pre-Task-10 before createDb ever touches
    // it, or this test proves nothing.
    const raw = new DatabaseSync(filePath);
    const preColumns = raw.prepare("PRAGMA table_info(pairing_sessions)").all().map((c) => c.name);
    raw.close();
    assert.ok(preColumns.includes("auth_token_hash"), "fixture must have the v2 shape");
    assert.ok(!preColumns.includes("kind"), "fixture must start without kind (or this proves nothing)");

    // createDb() is the real production open path (main.js calls this
    // directly on startup) — exercise it rather than migratePairingSessions
    // in isolation.
    const db = createDb(filePath);

    const afterColumns = db.prepare("PRAGMA table_info(pairing_sessions)").all().map((c) => c.name);
    assert.ok(afterColumns.includes("kind"), "kind must exist after opening a pre-Task-10 database");
    assert.ok(afterColumns.includes("auth_token_hash"));

    // The old table is dropped, not migrated in place — pairing sessions are
    // ephemeral (15-minute TTL, no user data by design, per the comment
    // above CREATE TABLE pairing_sessions in db.js), so an in-flight v1
    // session is deliberately lost rather than salvaged. A zombie row with
    // kind=NULL would be the wrong outcome (kind is NOT NULL DEFAULT 'pair',
    // so it could only appear via a botched in-place ALTER).
    const remaining = db.prepare("SELECT COUNT(*) AS n FROM pairing_sessions").get();
    assert.equal(Number(remaining.n), 0, "the stale pre-kind row must not survive the migration");

    // And the migrated schema is actually usable afterwards, not just
    // present. This is the exact path a real restart takes (main.js ->
    // createDb -> createRegistry) and it is what a missing guard breaks:
    // every POST /v1/pairing/sessions returns 500 because the INSERT names a
    // `kind` column that was never added to the on-disk table.
    const registry = createRegistry(db, { now: () => 2000 });
    registry.insertPairingSession({
      id: "session-fresh",
      accountId: "acct-1",
      kind: "pair",
      authTokenHash: "hash-fresh",
      expiresAt: 999999999999,
    });
    const fresh = registry.getPairingSession("session-fresh");
    assert.ok(fresh, "a session must be insertable through the migrated schema");
    assert.equal(fresh.kind, "pair");

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Finding 7 (review): the FIRST branch of migratePairingSessions —
// `if (!columns.some(c => c.name === "auth_token_hash")) { DROP TABLE;
// return; }` — was untested in isolation. Deleting it survives the suite,
// because every shipped v1 table that lacks auth_token_hash ALSO lacks
// kind, so the second branch (tested above) already drops it too — the two
// branches happen to overlap on every schema version that has ever shipped.
// The one shape this branch uniquely handles — auth_token_hash absent, kind
// present — never existed in production, so this is deliberately a
// synthetic fixture: it isolates the branch from its accidental cover so a
// future change that narrows or removes it is caught here, not by
// discovering in production that dropping a table full of NOT NULL columns
// it doesn't have is somehow not what happened.
function buildNoAuthTokenHashDb(filePath) {
  const db = new DatabaseSync(filePath);
  db.exec(`
    CREATE TABLE pairing_sessions (
      id              TEXT PRIMARY KEY,
      account_id      TEXT NOT NULL,
      kind            TEXT NOT NULL DEFAULT 'pair',
      node_blob       TEXT,
      node_tag        TEXT,
      node_read_at    INTEGER,
      device_blob     TEXT,
      device_tag      TEXT,
      device_read_at  INTEGER,
      closed_at       INTEGER,
      expires_at      INTEGER NOT NULL,
      created_at      INTEGER NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO pairing_sessions (id, account_id, kind, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("session-no-auth-token-hash", "acct-1", "pair", 999999999999, 1000);
  db.close();
}

test("createDb migrates a pairing_sessions table missing auth_token_hash even when kind is already present", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-pairing-migration-no-ath-"));
  const filePath = path.join(dir, "relay.sqlite");
  try {
    buildNoAuthTokenHashDb(filePath);

    const raw = new DatabaseSync(filePath);
    const preColumns = raw.prepare("PRAGMA table_info(pairing_sessions)").all().map((c) => c.name);
    raw.close();
    assert.ok(!preColumns.includes("auth_token_hash"), "fixture must start without auth_token_hash (or this proves nothing)");
    assert.ok(preColumns.includes("kind"), "fixture must isolate the auth_token_hash branch by already having kind");

    const db = createDb(filePath);
    const afterColumns = db.prepare("PRAGMA table_info(pairing_sessions)").all().map((c) => c.name);
    assert.ok(afterColumns.includes("auth_token_hash"), "auth_token_hash must exist after opening the old-shape database");
    assert.ok(afterColumns.includes("kind"));

    const remaining = db.prepare("SELECT COUNT(*) AS n FROM pairing_sessions").get();
    assert.equal(Number(remaining.n), 0, "the stale row must not survive the migration");

    const registry = createRegistry(db, { now: () => 2000 });
    registry.insertPairingSession({
      id: "session-fresh-2", accountId: "acct-1", kind: "pair", authTokenHash: "hash-fresh-2", expiresAt: 999999999999,
    });
    assert.ok(registry.getPairingSession("session-fresh-2"), "the migrated schema must be usable afterwards");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pairing_sessions migration is idempotent across repeated opens of the same on-disk file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "relay-pairing-migration-idem-"));
  const filePath = path.join(dir, "relay.sqlite");
  try {
    buildPreTask10Db(filePath);

    // First open performs the DROP + recreate.
    const db1 = createDb(filePath);
    db1.close();

    // Second open (mirrors main.js restarting against the same file) must not
    // error re-dropping an already-current table, and — critically — must not
    // wipe rows a live server wrote after the first open.
    const db2 = createDb(filePath);
    const registry2 = createRegistry(db2, { now: () => 5000 });
    registry2.insertPairingSession({
      id: "post-migration-session",
      accountId: "acct-1",
      kind: "pair",
      authTokenHash: "hash-2",
      expiresAt: 999999999999,
    });
    db2.close();

    assert.doesNotThrow(() => {
      const db3 = createDb(filePath);
      db3.close();
    });

    const db4 = createDb(filePath);
    const registry4 = createRegistry(db4, { now: () => 6000 });
    assert.ok(
      registry4.getPairingSession("post-migration-session"),
      "a row written after the migration must survive a later reopen, not get dropped again",
    );
    db4.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
