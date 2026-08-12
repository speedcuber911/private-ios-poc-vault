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

-- A node carries TWO distinct public keys that must never be interchanged:
--   pubkey     - ed25519 SPKI PEM. Verifies signatures on node-originated
--                requests/events (nodeauth.js) and the broker tunnel
--                handshake. Set by every node-creation path.
--   enc_pubkey - base64 of 32 raw X25519 bytes. The recipient key relayd's
--                seal.mjs (sealTo) encrypts handoff manifests/transcripts
--                to, so only the node's matching private key can open them.
--                Currently set only by trial enroll (POST
--                /v1/trial-nodes/enroll); BYO/managed nodes registered via
--                POST /v1/nodes always read back null here today.
-- Using one where the other is expected is silent at write time and fails
-- much later — a signature check passing/failing for the wrong reason, or a
-- sealed handoff nobody can open — so name every local var and column that
-- holds either of these pubkey/encPubkey, never a bare "key".
CREATE TABLE IF NOT EXISTS nodes (
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
  kind            TEXT NOT NULL DEFAULT 'pair',
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

-- Sandboxes Relay believes are still alive but can no longer reach through
-- trial_nodes. Two ways in: account deletion drops the trial row while the
-- provisioner is unreachable, and the reaper hits its destroy point with the
-- trial feature's kill switch (E2B_API_URL) unset. Without this table both
-- cases lose the sandbox id forever, leaving a microVM holding the user's
-- files with nothing left that could ever name it. Rows carry no user data —
-- just the ids needed to finish the job later — and are cleared as soon as
-- the destroy succeeds.
CREATE TABLE IF NOT EXISTS sandbox_orphans (
  sandbox_id  TEXT PRIMARY KEY,
  trial_id    TEXT,
  account_id  TEXT,
  reason      TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_code_hash TEXT NOT NULL,
  user_code TEXT NOT NULL,
  account_id TEXT,
  approved_at INTEGER,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_device_codes_expires ON device_codes (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes (user_code);
-- device_code_hash is read on EVERY /v1/auth/device/token poll. Unindexed it
-- is a full table scan, and node:sqlite's DatabaseSync is synchronous, so the
-- scan blocks the whole event loop: ~11.6 ms per poll at 500k rows. The row
-- count is attacker-influenced (POST /v1/auth/device/start is unauthenticated),
-- which made an unauthenticated write amplify into an unauthenticated blocking
-- read. Not UNIQUE: the value is sha256 of 256 bits of entropy, so uniqueness
-- is guaranteed by construction, and a UNIQUE index would turn any legacy
-- duplicate into a failure to open the database at boot.
CREATE INDEX IF NOT EXISTS idx_device_codes_hash ON device_codes (device_code_hash);

CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_repos_account_name ON repos (account_id, full_name);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_handoffs_node_state ON handoffs (node_id, state);
CREATE INDEX IF NOT EXISTS idx_handoffs_account_repo ON handoffs (account_id, repo, created_at);

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
  if (!columns.some((column) => column.name === "auth_token_hash")) {
    db.exec("DROP TABLE pairing_sessions;");
    return;
  }
  if (!columns.some((column) => column.name === "kind")) {
    db.exec("DROP TABLE pairing_sessions");
  }
}
