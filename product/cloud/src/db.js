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
  cli_link_id TEXT,
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
  cli_link_id TEXT,
  approved_at INTEGER,
  consumed_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  -- Trusted client IP (nginx's X-Real-IP, set to $remote_addr; the app binds
  -- 127.0.0.1, so nginx is the only possible peer and the header cannot be
  -- spoofed by the caller) at POST /v1/auth/device/start. NULL when the
  -- signal isn't available (direct-to-app callers, e.g. tests). Backs the
  -- per-IP live-code ceiling — see countLiveDeviceCodesForIp in registry.js
  -- and config.deviceCodeMaxLivePerIp. The global ceiling alone let one
  -- attacker holding DEVICE_CODE_MAX_LIVE codes deny every other login.
  client_ip TEXT,
  -- Advisory machine identity the CLI self-reports on /device/start. Shown
  -- on the phone confirm sheet before approve; never authenticated — the
  -- confirm copy carries the weight. Nullable so older rows and starts that
  -- omit the fields still work.
  machine_name TEXT,
  platform TEXT,
  client TEXT NOT NULL DEFAULT 'cli'
);
CREATE INDEX IF NOT EXISTS idx_device_codes_expires ON device_codes (expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes (user_code);
-- Backs countLiveDeviceCodesForIp, read on every unauthenticated
-- POST /v1/auth/device/start, for the same reason idx_device_codes_hash
-- exists: an unauthenticated write must not amplify into an unauthenticated
-- blocking table scan.
CREATE INDEX IF NOT EXISTS idx_device_codes_client_ip ON device_codes (client_ip, expires_at);
-- device_code_hash is read on EVERY /v1/auth/device/token poll. Unindexed it
-- is a full table scan, and node:sqlite's DatabaseSync is synchronous, so the
-- scan blocks the whole event loop: ~11.6 ms per poll at 500k rows. The row
-- count is attacker-influenced (POST /v1/auth/device/start is unauthenticated),
-- which made an unauthenticated write amplify into an unauthenticated blocking
-- read. Not UNIQUE: the value is sha256 of 256 bits of entropy, so uniqueness
-- is guaranteed by construction, and a UNIQUE index would turn any legacy
-- duplicate into a failure to open the database at boot.
CREATE INDEX IF NOT EXISTS idx_device_codes_hash ON device_codes (device_code_hash);

-- A Relay account may authorize exactly one handoff computer at a time.
-- The row is created when the phone approves a device code and becomes
-- connected only when that computer redeems the code. CLI session/refresh
-- credentials carry this row's id, so deleting it immediately invalidates
-- that computer without signing the phone out of its Better Auth session.
CREATE TABLE IF NOT EXISTS cli_computer_links (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL UNIQUE,
  machine_name TEXT,
  platform     TEXT,
  connected_at INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cli_computer_links_account
  ON cli_computer_links (account_id);

-- Browser cookie sessions the phone can list and revoke. better_auth_session_id
-- is null until mint completes; UNIQUE still allows multiple nulls. Cap is
-- enforced in registry.reserveBrowserSession, not here.
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

-- A row is a durable owner-triggered revocation of the node data path. It is
-- deliberately separate from cli_computer_links: a brand-new account may use
-- its instant trial before linking a laptop, while an account that explicitly
-- disconnects a computer must stay revoked across app reinstalls and service
-- restarts until a replacement computer is approved.
CREATE TABLE IF NOT EXISTS cli_computer_access_revocations (
  account_id  TEXT PRIMARY KEY,
  revoked_at  INTEGER NOT NULL
);

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
  delivered_at INTEGER,
  -- A poll response reaching res.end()'s write() is not proof it reached the
  -- node — a partitioned peer observes no FIN and the socket looks alive for
  -- the whole poll (Task 8 review, Finding 1 / IMPORTANT 1). GET
  -- /v1/node/handoffs therefore LEASES a pending row (state='leased') rather
  -- than delivering it; lease_token is the single-use capability
  -- POST /v1/node/handoffs/ack must present to confirm it, and
  -- lease_expires_at is when an unconfirmed lease becomes claimable again.
  -- Both are NULL outside the 'leased' state. See registry.js's
  -- leaseHandoffs/confirmHandoffDelivery/reclaimExpiredLeases.
  lease_token TEXT,
  lease_expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_handoffs_node_state ON handoffs (node_id, state);
CREATE INDEX IF NOT EXISTS idx_handoffs_account_repo ON handoffs (account_id, repo, created_at);

-- Credential-sync notices: how a node learns that "relay sync-auth" left a
-- sealed bundle in a rendezvous slot for it. Nothing lets a node discover a
-- pending pairing session on its own (there is no route that lists them, and
-- there must not be one), so the CLI announces one here and the node picks it
-- up over the node-authenticated handoff long-poll it already holds open.
--
-- pairing_secret is the rendezvous secret, NOT the derived auth token: the
-- node needs authTokenFor(secret) to authorize the slot GET *and*
-- macKeyFor(secret) to verify the x-pairing-tag its sender computed, and the
-- auth token is a one-way function of the secret so it cannot yield the MAC
-- key. This row therefore grants slot access, and nothing else: the bundle in
-- that slot is sealed to the node's X25519 key, so this table's contents can
-- never open a credential. Rows are short-lived (they die with their
-- rendezvous, plus a grace window) and are dropped with their node/account.
--
-- state/lease_token/lease_expires_at are the SAME delivery lease the handoffs
-- table documents: a poll leases, POST /v1/node/handoffs/ack is the only path
-- to 'delivered', and an unconfirmed lease expires so the row is claimable
-- again. See registry.js's leaseSyncNotices/confirmSyncNoticeDelivery.
CREATE TABLE IF NOT EXISTS sync_notices (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL,
  pairing_secret TEXT NOT NULL,
  state TEXT NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER,
  expires_at INTEGER NOT NULL
);
-- One rendezvous is one notice, however many times the CLI announces it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_notices_pairing ON sync_notices (pairing_id);
CREATE INDEX IF NOT EXISTS idx_sync_notices_node_state ON sync_notices (node_id, state);
CREATE INDEX IF NOT EXISTS idx_sync_notices_expires ON sync_notices (expires_at);

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
  migrateCliComputerLinks(db);
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

// CREATE TABLE IF NOT EXISTS does not add columns to an existing SQLite
// table. These nullable link ids are backwards-compatible with credentials
// and in-flight device codes issued before single-computer linking existed.
function migrateCliComputerLinks(db) {
  const addColumnIfMissing = (table, column, declaration) => {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    if (!columns.some((entry) => entry.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${declaration}`);
    }
  };
  addColumnIfMissing("refresh_tokens", "cli_link_id", "cli_link_id TEXT");
  addColumnIfMissing("device_codes", "cli_link_id", "cli_link_id TEXT");
  addColumnIfMissing("device_codes", "client", "client TEXT NOT NULL DEFAULT 'cli'");
}
