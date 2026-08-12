// Coverage for ensureHandoffLeaseColumns (registry.js) — the guard that adds
// handoffs.lease_token / handoffs.lease_expires_at to a database provisioned
// before the handoff lease (Task 8 review, Finding 1 / IMPORTANT 1).
//
// Every other test in this suite opens its database via db.js's createDb(),
// whose SCHEMA already declares both columns on CREATE TABLE — so the ALTER
// TABLE branch of ensureHandoffLeaseColumns never actually runs in any of
// those tests, green or not. This file builds a database that reproduces the
// real pre-lease shape directly (bypassing db.js entirely), mirroring
// registry-migration.test.mjs's coverage of ensureNodeEncColumn, so the ALTER
// path itself is exercised and pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRegistry } from "../src/registry.js";

// Minimal slice of the pre-lease schema: a `handoffs` table with no
// lease_token/lease_expires_at columns, plus the tables ensureAuthSchema and
// createRegistry's other migration guards unconditionally touch on open.
function buildOldSchemaDb() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE accounts (
      id          TEXT PRIMARY KEY,
      apple_sub   TEXT UNIQUE,
      email       TEXT UNIQUE,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE refresh_tokens (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      token_hash  TEXT NOT NULL UNIQUE,
      expires_at  INTEGER NOT NULL,
      revoked_at  INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE nodes (
      id          TEXT PRIMARY KEY,
      account_id  TEXT NOT NULL,
      kind        TEXT NOT NULL,
      name        TEXT,
      pubkey      TEXT NOT NULL,
      enc_pubkey  TEXT,
      version     TEXT,
      last_seen   INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE handoffs (
      id           TEXT PRIMARY KEY,
      account_id   TEXT NOT NULL,
      node_id      TEXT NOT NULL,
      repo         TEXT NOT NULL,
      branch       TEXT NOT NULL,
      state        TEXT NOT NULL,
      reason       TEXT,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      delivered_at INTEGER
    );
  `);
  return db;
}

test("ensureHandoffLeaseColumns migrates a pre-existing handoffs table without dropping data", () => {
  const db = buildOldSchemaDb();
  db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run("acct-1", 1000);
  db.prepare(
    "INSERT INTO nodes (id, account_id, kind, pubkey, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("node-1", "acct-1", "byo", "pk-pem", 1000);
  db.prepare(
    "INSERT INTO handoffs (id, account_id, node_id, repo, branch, state, created_at, updated_at) " +
    "VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
  ).run("aaaaaaaaaaaaaaaa", "acct-1", "node-1", "o/r", "relay/handoff-old", 1000, 1000);

  const before = db.prepare("PRAGMA table_info(handoffs)").all().map((c) => c.name);
  assert.ok(!before.includes("lease_token") && !before.includes("lease_expires_at"),
    "test fixture must start without the lease columns (or this proves nothing)");

  // createRegistry() runs ensureHandoffLeaseColumns (among other migration
  // guards) on open — this is the real production path, not a direct call.
  const registry = createRegistry(db, { now: () => 2000 });

  const after = db.prepare("PRAGMA table_info(handoffs)").all().map((c) => c.name);
  assert.ok(after.includes("lease_token"), "lease_token must exist after opening an old-schema database");
  assert.ok(after.includes("lease_expires_at"), "lease_expires_at must exist after opening an old-schema database");

  // The pre-existing row survived: same fields, new columns read back as
  // null instead of erroring or losing the row to a rebuild.
  const handoff = registry.getHandoff("aaaaaaaaaaaaaaaa");
  assert.ok(handoff, "pre-existing row must survive the migration");
  assert.equal(handoff.repo, "o/r");
  assert.equal(handoff.state, "pending");
  assert.equal(handoff.leaseToken, null);
  assert.equal(handoff.leaseExpiresAt, null);

  // And the migrated columns are actually usable going forward, not just
  // present — a fresh handoff can now be leased through them.
  const [leased] = registry.leaseHandoffs(["aaaaaaaaaaaaaaaa"], "node-1", 30_000);
  assert.equal(leased.state, "leased");
  assert.equal(typeof leased.leaseToken, "string");
  assert.equal(leased.leaseExpiresAt, 32_000);
});

test("ensureHandoffLeaseColumns is idempotent across repeated opens of the same database", () => {
  const db = buildOldSchemaDb();
  db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run("acct-1", 1000);
  db.prepare(
    "INSERT INTO nodes (id, account_id, kind, pubkey, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run("node-1", "acct-1", "byo", "pk-pem", 1000);

  // First open performs the ALTER TABLE. A second createRegistry() call over
  // the same handle (mirrors main.js restarting against the same file) must
  // not error re-adding a column that is already there.
  createRegistry(db, { now: () => 2000 });
  assert.doesNotThrow(() => createRegistry(db, { now: () => 3000 }));

  const columns = db.prepare("PRAGMA table_info(handoffs)").all()
    .filter((c) => c.name === "lease_token" || c.name === "lease_expires_at");
  assert.equal(columns.length, 2, "each lease column must appear exactly once even after repeated opens");
});
