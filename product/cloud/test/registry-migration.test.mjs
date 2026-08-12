// Coverage for ensureNodeEncColumn (registry.js) — the guard that adds
// nodes.enc_pubkey to a database provisioned before the column existed.
//
// Every other test in this suite opens its database via db.js's createDb(),
// whose SCHEMA already declares enc_pubkey on CREATE TABLE — so the ALTER
// TABLE branch of ensureNodeEncColumn never actually runs in any of those
// tests, green or not. This file builds a database that reproduces the real
// pre-migration shape directly (bypassing db.js entirely) so the ALTER path
// itself is exercised and pinned, not merely inspected by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createRegistry } from "../src/registry.js";

// Minimal slice of the pre-task-3 schema: a `nodes` table with no enc_pubkey
// column, plus `refresh_tokens` — ensureAuthSchema unconditionally creates an
// index on it, so it must already exist or createRegistry() throws before
// ever reaching ensureNodeEncColumn.
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
      version     TEXT,
      last_seen   INTEGER,
      created_at  INTEGER NOT NULL
    );
  `);
  return db;
}

test("ensureNodeEncColumn migrates a pre-existing nodes table without dropping data", () => {
  const db = buildOldSchemaDb();
  db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run("acct-1", 1000);
  db.prepare(
    "INSERT INTO nodes (id, account_id, kind, name, pubkey, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("node-preexisting", "acct-1", "byo", "old box", "pk-pem-legacy", "0.0.1", 1000);

  const before = db.prepare("PRAGMA table_info(nodes)").all().map((c) => c.name);
  assert.ok(!before.includes("enc_pubkey"), "test fixture must start without the column (or this proves nothing)");

  // createRegistry() runs ensureNodeEncColumn (among other migration guards)
  // on open — this is the real production path, not a direct unit call.
  const registry = createRegistry(db, { now: () => 2000 });

  const after = db.prepare("PRAGMA table_info(nodes)").all().map((c) => c.name);
  assert.ok(after.includes("enc_pubkey"), "enc_pubkey must exist after opening an old-schema database");

  // The pre-existing row survived: same pubkey/kind/name, new column reads
  // back as null instead of erroring or losing the row to a rebuild.
  const node = registry.getNode("node-preexisting");
  assert.ok(node, "pre-existing row must survive the migration");
  assert.equal(node.pubkey, "pk-pem-legacy");
  assert.equal(node.kind, "byo");
  assert.equal(node.name, "old box");
  assert.equal(node.encPubkey, null);

  // And the migrated column is actually usable going forward, not just
  // present — a fresh node can now store an enc_pubkey through it.
  registry.createNode("acct-1", { id: "node-fresh", kind: "byo", name: "new box", pubkey: "pk-pem-fresh", encPubkey: "AAAA" });
  assert.equal(registry.getNode("node-fresh").encPubkey, "AAAA");
});

test("ensureNodeEncColumn is idempotent across repeated opens of the same database", () => {
  const db = buildOldSchemaDb();
  db.prepare("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run("acct-1", 1000);
  db.prepare(
    "INSERT INTO nodes (id, account_id, kind, name, pubkey, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("node-1", "acct-1", "byo", null, "pk-pem", null, 1000);

  // First open performs the ALTER TABLE. A second createRegistry() call over
  // the same handle (mirrors main.js restarting against the same file) must
  // not error re-adding a column that is already there.
  createRegistry(db, { now: () => 2000 });
  assert.doesNotThrow(() => createRegistry(db, { now: () => 3000 }));

  const columns = db.prepare("PRAGMA table_info(nodes)").all().filter((c) => c.name === "enc_pubkey");
  assert.equal(columns.length, 1, "enc_pubkey must appear exactly once even after repeated opens");
});
