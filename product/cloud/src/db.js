// Thin data-access layer over node:sqlite.
//
// The SQL below is deliberately portable: TEXT/INTEGER columns, no SQLite
// AUTOINCREMENT, ids generated in code (UUIDs), timestamps as INTEGER epoch
// milliseconds, binary blobs stored base64-encoded in TEXT. Swapping in
// Postgres later means re-pointing createDb at a pg client and translating
// `?` placeholders to `$n` — the registry API surface (registry.js) does not
// change.

import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id          TEXT PRIMARY KEY,
  apple_sub   TEXT UNIQUE,
  email       TEXT UNIQUE,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL,
  apns_token   TEXT,
  platform     TEXT,
  name         TEXT,
  cert_serials TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT,
  pubkey      TEXT NOT NULL,
  version     TEXT,
  last_seen   INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS entitlements (
  account_id  TEXT NOT NULL,
  feature     TEXT NOT NULL,
  value       TEXT NOT NULL,
  PRIMARY KEY (account_id, feature)
);

CREATE TABLE IF NOT EXISTS waitlist (
  email       TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS magic_links (
  id          TEXT PRIMARY KEY,
  email       TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

-- Pairing rendezvous (protocol v2). The cloud stores only sha256(authToken),
-- which is itself a one-way function of a secret the cloud never receives, and
-- the two opaque blobs with the MAC tags their SENDERS computed. Tags are
-- stored verbatim and never validated here — validating them would require
-- macKey, which the cloud cannot derive. Each slot is written at most once
-- (put-once, enforced by the WHERE ... IS NULL guards in registry.js) and the
-- blobs are deleted as soon as both have been read.
CREATE TABLE IF NOT EXISTS pairing_sessions (
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

CREATE TABLE IF NOT EXISTS node_events (
  id          TEXT PRIMARY KEY,
  node_id     TEXT NOT NULL,
  account_id  TEXT NOT NULL,
  job_id      TEXT,
  type        TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

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

CREATE INDEX IF NOT EXISTS idx_devices_account ON devices (account_id);
CREATE INDEX IF NOT EXISTS idx_nodes_account ON nodes (account_id);
CREATE INDEX IF NOT EXISTS idx_node_events_created ON node_events (created_at);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_pairing_account ON pairing_sessions (account_id);
`;

export function createDb(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migratePairingSessions(db);
  db.exec(SCHEMA);
  return db;
}

// Protocol v1 stored a `secret_hash` of a secret the CLOUD generated. v2 never
// receives a secret at all, so the column is gone and the table shape changed
// incompatibly. Pairing sessions are ephemeral (15-minute TTL) and carry no
// user data, so the correct migration is to drop the v1 table outright — any
// in-flight v1 pairing simply has to be restarted.
function migratePairingSessions(db) {
  let columns;
  try {
    columns = db.prepare("PRAGMA table_info(pairing_sessions)").all();
  } catch {
    return;
  }
  if (columns.length === 0) return; // fresh database
  if (columns.some((column) => column.name === "auth_token_hash")) return; // already v2
  db.exec("DROP TABLE pairing_sessions;");
}
