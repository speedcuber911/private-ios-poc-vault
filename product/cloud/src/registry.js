// Registry: accounts, devices, nodes, entitlements, waitlist — plus the
// storage-facing halves of auth (refresh tokens, magic links), pairing
// sessions and node events. Pure CRUD; policy lives in the callers.

import { randomUUID } from "node:crypto";

export const ENTITLEMENT_MAX_NODES = "nodes.max";

// THE canonical email rule for the whole control plane. One human must map to
// one row no matter which sign-in path they arrive on, so every write and
// every lookup that touches an address goes through this function — magic
// link, Sign in with Apple, and the waitlist alike. Trim + lowercase only:
// deliberately no plus-address stripping and no dot-folding, because those
// rewrites merge addresses that are genuinely distinct at most providers.
// Returns null for anything that is not a usable address.
export function normalizeEmail(value) {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : null;
}

// SQLITE_CONSTRAINT_UNIQUE / SQLITE_CONSTRAINT_PRIMARYKEY. accounts.email and
// accounts.apple_sub are UNIQUE, so a racing or conflicting writer must lose
// deterministically instead of raising through the HTTP layer as a 500.
function isUniqueViolation(err) {
  return (
    err?.errcode === 2067 ||
    err?.errcode === 1555 ||
    /UNIQUE constraint failed/i.test(err?.message || "")
  );
}

// Stores that hang off auth rather than off the core object model. Created
// here, idempotently, so that opening a database provisioned from an earlier
// schema turns these protections on rather than failing closed on first use;
// db.js stays the canonical home for the core tables.
function ensureAuthSchema(db) {
  db.exec(`
    -- Bumped by an owner-triggered "sign out everywhere". Session JWTs carry
    -- the epoch they were minted under and are rejected once it falls behind,
    -- which is what makes revocation apply to already-issued tokens.
    CREATE TABLE IF NOT EXISTS account_security (
      account_id     TEXT PRIMARY KEY,
      session_epoch  INTEGER NOT NULL
    );

    -- Single-use ledger for Apple identity tokens. Holds a hash of the
    -- credential's identifying claims and nothing else; rows are swept once
    -- the underlying token has expired.
    CREATE TABLE IF NOT EXISTS apple_token_uses (
      token_id    TEXT PRIMARY KEY,
      expires_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_apple_token_uses_expires
      ON apple_token_uses (expires_at);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_account
      ON refresh_tokens (account_id);
  `);
}

// Replay protection for node event ingest. Created here, idempotently, for the
// same reason as ensureAuthSchema: a database provisioned from an earlier
// schema must gain the protection on open rather than fail closed on first
// use. db.js stays the canonical home for the core tables.
//
// node_events.seq is the node-generated, per-node monotonic sequence number
// carried INSIDE the signed body. UNIQUE (node_id, seq) is the last line of
// defence against a replay that races the cursor check below; the cursor is
// the first, and unlike the events table it is never swept, so a capture
// replayed after retention has expired still cannot get through.
//
// The column is added rather than declared so that pre-existing rows survive.
// SQLite treats NULLs as distinct in a UNIQUE index, so legacy rows (seq NULL)
// never collide with each other or with new ones.
function ensureNodeEventSchema(db) {
  let columns = [];
  try {
    columns = db.prepare("PRAGMA table_info(node_events)").all();
  } catch {
    columns = [];
  }
  if (columns.length > 0) {
    if (!columns.some((column) => column.name === "seq")) {
      db.exec("ALTER TABLE node_events ADD COLUMN seq INTEGER");
    }
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_node_events_node_seq
        ON node_events (node_id, seq);
    `);
  }
  db.exec(`
    -- Per-node high-water mark. Survives the retention sweep, so "the highest
    -- seq this node has ever delivered" stays durable after the corresponding
    -- event rows are gone — which is what stops a capture from becoming
    -- replayable again once retention has expired.
    CREATE TABLE IF NOT EXISTS node_event_cursors (
      node_id    TEXT PRIMARY KEY,
      last_seq   INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

// Non-destructive guard for existing databases that predate the node
// encryption key column (nodes.enc_pubkey — see the two-key note on the
// `nodes` table in db.js before touching this). Follows the same idiom as
// ensureNodeEventSchema: a database provisioned from an earlier schema must
// gain the column on open rather than fail closed on first use. db.js stays
// the canonical home for the core tables.
//
// No try/catch around the PRAGMA read: unlike a bare `catch { return; }`,
// which would treat a genuine database error (closed handle, corruption)
// identically to "nothing to migrate" and silently leave the column missing
// — surfacing later as a confusing "no such column: enc_pubkey" from
// createNode's INSERT — PRAGMA table_info on a table that does not exist yet
// returns an empty rowset rather than throwing (verified against
// node:sqlite), so there is no expected error here to swallow. A real
// failure should propagate.
function ensureNodeEncColumn(db) {
  const columns = db.prepare("PRAGMA table_info(nodes)").all();
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "enc_pubkey")) {
    db.exec("ALTER TABLE nodes ADD COLUMN enc_pubkey TEXT");
  }
}

// Non-destructive guard for existing databases that predate the handoff
// lease columns (handoffs.lease_token, handoffs.lease_expires_at — Task 8
// review, Finding 1 / IMPORTANT 1: a poll response written into a
// partitioned node's socket looked exactly like a successful delivery, so
// the row was flipped to `delivered` and lost for good with no recovery
// path). Same idiom as ensureNodeEncColumn: gain the columns on open rather
// than fail closed on first use.
function ensureHandoffLeaseColumns(db) {
  const columns = db.prepare("PRAGMA table_info(handoffs)").all();
  if (columns.length === 0) return;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("lease_token")) db.exec("ALTER TABLE handoffs ADD COLUMN lease_token TEXT");
  if (!names.has("lease_expires_at")) db.exec("ALTER TABLE handoffs ADD COLUMN lease_expires_at INTEGER");
}

// Non-destructive guard for existing databases that predate the per-IP
// device-code ceiling (device_codes.client_ip — the correction to the
// "per-IP needs trusted proxy headers this deployment does not have"
// residual: nginx sets X-Real-IP and the app binds 127.0.0.1, so the signal
// IS trustworthy here). Same idiom as ensureNodeEncColumn.
function ensureDeviceCodeClientIpColumn(db) {
  const columns = db.prepare("PRAGMA table_info(device_codes)").all();
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "client_ip")) {
    db.exec("ALTER TABLE device_codes ADD COLUMN client_ip TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_device_codes_client_ip ON device_codes (client_ip, expires_at)");
}

export function createRegistry(db, { now = () => Date.now() } = {}) {
  ensureAuthSchema(db);
  ensureNodeEventSchema(db);
  ensureNodeEncColumn(db);
  ensureHandoffLeaseColumns(db);
  ensureDeviceCodeClientIpColumn(db);

  // ── accounts ────────────────────────────────────────────────────────────
  function createAccount({ id = randomUUID(), appleSub = null, email = null }) {
    db.prepare(
      "INSERT INTO accounts (id, apple_sub, email, created_at) VALUES (?, ?, ?, ?)",
    ).run(id, appleSub, normalizeEmail(email), now());
    return getAccount(id);
  }

  // Better Auth owns credentials and sessions, while this registry owns Relay
  // devices, nodes, and entitlements. Keep one stable Relay account for a
  // Better Auth user, linking a pre-existing email account when possible.
  function ensureAccount({ id, email = null }) {
    const byId = getAccount(id);
    if (byId) return attachEmail(id, email);
    const byEmail = findAccountByEmail(email);
    if (byEmail) return byEmail;
    try {
      return createAccount({ id, email });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return getAccount(id) || findAccountByEmail(email);
    }
  }

  // Hard-delete every control-plane row associated with an account. Better
  // Auth separately removes credentials, provider accounts, and sessions.
  // The transaction prevents a half-deleted account from remaining usable.
  //
  // Dropping the trial_nodes row is the point of no return for that account's
  // sandbox: nothing afterwards can map the account back to a live microVM.
  // The caller must therefore have destroyed it (or recorded it via
  // recordSandboxOrphan) BEFORE calling this — see the deleteUser hook in
  // better-auth.js. sandbox_orphans is deliberately NOT cleared here: those
  // rows exist precisely to outlive the account they came from.
  function deleteAccount(accountId) {
    const account = getAccount(accountId);
    if (!account) return false;
    const nodeIds = db
      .prepare("SELECT id FROM nodes WHERE account_id = ?")
      .all(accountId)
      .map((row) => row.id);

    db.exec("BEGIN IMMEDIATE");
    try {
      for (const nodeId of nodeIds) {
        db.prepare("DELETE FROM node_event_cursors WHERE node_id = ?").run(nodeId);
      }
      db.prepare("DELETE FROM node_events WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM pairing_sessions WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM refresh_tokens WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM account_security WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM entitlements WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM devices WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM nodes WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM trial_nodes WHERE account_id = ?").run(accountId);
      if (account.email) {
        db.prepare("DELETE FROM magic_links WHERE email = ?").run(account.email);
      }
      db.prepare("DELETE FROM device_codes WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM repos WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM handoffs WHERE account_id = ?").run(accountId);
      db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
      db.exec("COMMIT");
      return true;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  function getAccount(id) {
    const row = db.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
    return row ? mapAccount(row) : null;
  }

  function findAccountByAppleSub(appleSub) {
    const row = db
      .prepare("SELECT * FROM accounts WHERE apple_sub = ?")
      .get(appleSub);
    return row ? mapAccount(row) : null;
  }

  function findAccountByEmail(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;
    const row = db
      .prepare("SELECT * FROM accounts WHERE email = ?")
      .get(normalized);
    return row ? mapAccount(row) : null;
  }

  // Best-effort claim of a still-unset field: fills the slot when it is free
  // and the value is not already taken, and otherwise leaves the account
  // exactly as it was. Both always return the account's current state, so a
  // caller never has to distinguish "attached" from "was already correct".
  function attachEmail(accountId, email) {
    const normalized = normalizeEmail(email);
    if (normalized) {
      try {
        db.prepare(
          "UPDATE accounts SET email = ? WHERE id = ? AND email IS NULL",
        ).run(normalized, accountId);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // address belongs elsewhere
      }
    }
    return getAccount(accountId);
  }

  function attachAppleSub(accountId, appleSub) {
    if (typeof appleSub === "string" && appleSub.length > 0) {
      try {
        db.prepare(
          "UPDATE accounts SET apple_sub = ? WHERE id = ? AND apple_sub IS NULL",
        ).run(appleSub, accountId);
      } catch (err) {
        if (!isUniqueViolation(err)) throw err; // sub belongs to another account
      }
    }
    return getAccount(accountId);
  }

  // ── entitlements ────────────────────────────────────────────────────────
  function setEntitlement(accountId, feature, value) {
    const existing = db
      .prepare(
        "SELECT value FROM entitlements WHERE account_id = ? AND feature = ?",
      )
      .get(accountId, feature);
    if (existing) {
      db.prepare(
        "UPDATE entitlements SET value = ? WHERE account_id = ? AND feature = ?",
      ).run(String(value), accountId, feature);
    } else {
      db.prepare(
        "INSERT INTO entitlements (account_id, feature, value) VALUES (?, ?, ?)",
      ).run(accountId, feature, String(value));
    }
  }

  function getEntitlement(accountId, feature) {
    const row = db
      .prepare(
        "SELECT value FROM entitlements WHERE account_id = ? AND feature = ?",
      )
      .get(accountId, feature);
    return row ? row.value : null;
  }

  function listEntitlements(accountId) {
    return db
      .prepare(
        "SELECT feature, value FROM entitlements WHERE account_id = ? ORDER BY feature",
      )
      .all(accountId)
      .map((r) => ({ feature: r.feature, value: r.value }));
  }

  // ── devices ─────────────────────────────────────────────────────────────
  function createDevice(accountId, { apnsToken, platform, name, certSerials }) {
    const id = randomUUID();
    const t = now();
    db.prepare(
      `INSERT INTO devices (id, account_id, apns_token, platform, name, cert_serials, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      accountId,
      apnsToken ?? null,
      platform ?? null,
      name ?? null,
      JSON.stringify(certSerials ?? []),
      t,
      t,
    );
    return getDevice(accountId, id);
  }

  function updateDevice(accountId, id, patch) {
    const current = getDevice(accountId, id);
    if (!current) return null;
    const next = {
      apnsToken: patch.apnsToken !== undefined ? patch.apnsToken : current.apnsToken,
      platform: patch.platform !== undefined ? patch.platform : current.platform,
      name: patch.name !== undefined ? patch.name : current.name,
      certSerials:
        patch.certSerials !== undefined ? patch.certSerials : current.certSerials,
    };
    db.prepare(
      `UPDATE devices SET apns_token = ?, platform = ?, name = ?, cert_serials = ?, updated_at = ?
       WHERE id = ? AND account_id = ?`,
    ).run(
      next.apnsToken ?? null,
      next.platform ?? null,
      next.name ?? null,
      JSON.stringify(next.certSerials ?? []),
      now(),
      id,
      accountId,
    );
    return getDevice(accountId, id);
  }

  function getDevice(accountId, id) {
    const row = db
      .prepare("SELECT * FROM devices WHERE id = ? AND account_id = ?")
      .get(id, accountId);
    return row ? mapDevice(row) : null;
  }

  function listDevices(accountId) {
    return db
      .prepare("SELECT * FROM devices WHERE account_id = ? ORDER BY created_at")
      .all(accountId)
      .map(mapDevice);
  }

  function listPushDevices(accountId) {
    return listDevices(accountId).filter((d) => d.apnsToken);
  }

  function deleteDevice(accountId, id) {
    db.prepare("DELETE FROM devices WHERE id = ? AND account_id = ?").run(
      id,
      accountId,
    );
  }

  // Drops a push token APNs has told us is dead (410 Unregistered, or 400
  // BadDeviceToken). Matched on the token value as well as the id so that a
  // device which re-registered a *new* token while the failed push was still
  // in flight does not lose it. The device row itself is kept: it may still
  // carry the cert serials that identify the device on the mTLS data path.
  // Returns true when a token was actually cleared.
  function clearApnsToken(deviceId, apnsToken) {
    if (!apnsToken) return false;
    const result = db
      .prepare(
        "UPDATE devices SET apns_token = NULL, updated_at = ? WHERE id = ? AND apns_token = ?",
      )
      .run(now(), deviceId, apnsToken);
    return Number(result.changes) > 0;
  }

  // ── nodes ───────────────────────────────────────────────────────────────
  function createNode(accountId, { id = randomUUID(), kind, name, pubkey, encPubkey = null, version = null } = {}) {
    db.prepare(
      "INSERT INTO nodes (id, account_id, kind, name, pubkey, enc_pubkey, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(id, accountId, kind, name ?? null, pubkey, encPubkey, version, now());
    return getNode(id);
  }

  function getNode(id) {
    const row = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id);
    return row ? mapNode(row) : null;
  }

  function listNodes(accountId) {
    return db
      .prepare("SELECT * FROM nodes WHERE account_id = ? ORDER BY created_at")
      .all(accountId)
      .map(mapNode);
  }

  // `includeTrial: false` counts only the nodes that consume the account's
  // `nodes.max` entitlement. A trial node is granted by the cloud (the trial
  // enroll route creates it bypassing the gate entirely), not registered by
  // the user, so counting it would make `POST /v1/nodes` 403
  // `entitlement_limit` against the default limit of 1 for the whole 7+3 day
  // trial — closing off the "Upgrade to BYO" path the trial exists to funnel
  // people into, at exactly the moment they want to take it.
  function countNodes(accountId, { includeTrial = true } = {}) {
    const row = includeTrial
      ? db
          .prepare("SELECT COUNT(*) AS n FROM nodes WHERE account_id = ?")
          .get(accountId)
      : db
          .prepare(
            "SELECT COUNT(*) AS n FROM nodes WHERE account_id = ? AND kind != 'trial'",
          )
          .get(accountId);
    return Number(row.n);
  }

  function deleteNode(accountId, id) {
    const result = db
      .prepare("DELETE FROM nodes WHERE id = ? AND account_id = ?")
      .run(id, accountId);
    // The replay cursor is keyed by node id and would otherwise outlive the
    // node forever. Node ids are random UUIDs and never reused, so dropping it
    // with the node cannot resurrect a replay window.
    if (Number(result.changes) > 0) {
      db.prepare("DELETE FROM node_event_cursors WHERE node_id = ?").run(id);
      // A handoff row whose node no longer exists can never be delivered —
      // nothing will ever poll for it again. deleteAccount already clears
      // every handoff for an account in one transaction, but a single-node
      // delete (BYO/managed removal, or the trial reaper's past-grace path)
      // previously left these rows behind forever; no sweep touches the
      // handoffs table at all. See Task 8 review, M-5.
      db.prepare("DELETE FROM handoffs WHERE node_id = ?").run(id);
    }
  }

  function touchNode(id, { version } = {}) {
    if (version !== undefined) {
      db.prepare("UPDATE nodes SET last_seen = ?, version = ? WHERE id = ?").run(
        now(),
        version,
        id,
      );
    } else {
      db.prepare("UPDATE nodes SET last_seen = ? WHERE id = ?").run(now(), id);
    }
  }

  function adminListNodes() {
    return db
      .prepare("SELECT * FROM nodes ORDER BY created_at")
      .all()
      .map(mapNode);
  }

  // ── trial nodes ─────────────────────────────────────────────────────────
  const TRIAL_PATCH_COLUMNS = {
    state: "state",
    nodeId: "node_id",
    sandboxId: "sandbox_id",
    enrollTokenHash: "enroll_token_hash",
    expiresAt: "expires_at",
  };

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

  // ── sandbox orphans ─────────────────────────────────────────────────────
  //
  // A sandbox we still believe is running but can no longer destroy right now.
  // Recorded instead of being forgotten, so an unreachable Cube host degrades
  // into "we owe this a destroy" rather than "a microVM holds this user's
  // files forever". Keyed on sandbox id so repeated failures collapse to one
  // row and the first-seen reason/timestamp survives.
  function recordSandboxOrphan({ sandboxId, trialId = null, accountId = null, reason }) {
    if (!sandboxId) return false;
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO sandbox_orphans (sandbox_id, trial_id, account_id, reason, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(sandboxId, trialId, accountId, String(reason || "unknown"), now());
    return Number(result.changes) > 0;
  }

  function listSandboxOrphans(limit = 100) {
    return db
      .prepare("SELECT * FROM sandbox_orphans ORDER BY created_at LIMIT ?")
      .all(limit)
      .map((row) => ({
        sandboxId: row.sandbox_id,
        trialId: row.trial_id,
        accountId: row.account_id,
        reason: row.reason,
        createdAt: Number(row.created_at),
      }));
  }

  function clearSandboxOrphan(sandboxId) {
    if (!sandboxId) return false;
    const result = db
      .prepare("DELETE FROM sandbox_orphans WHERE sandbox_id = ?")
      .run(sandboxId);
    return Number(result.changes) > 0;
  }

  // ── repos ───────────────────────────────────────────────────────────────
  function upsertRepo(accountId, fullName) {
    const existing = getRepo(accountId, fullName);
    if (existing) return existing;
    try {
      db.prepare("INSERT INTO repos (id, account_id, full_name, created_at) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), accountId, fullName, now());
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
    }
    return getRepo(accountId, fullName);
  }

  function getRepo(accountId, fullName) {
    return mapRepo(db.prepare("SELECT * FROM repos WHERE account_id = ? AND full_name = ?").get(accountId, fullName));
  }

  function listRepos(accountId) {
    return db.prepare("SELECT * FROM repos WHERE account_id = ? ORDER BY full_name").all(accountId).map(mapRepo);
  }

  // ── waitlist ────────────────────────────────────────────────────────────
  function addToWaitlist(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return;
    const existing = db
      .prepare("SELECT email FROM waitlist WHERE email = ?")
      .get(normalized);
    if (!existing) {
      db.prepare("INSERT INTO waitlist (email, created_at) VALUES (?, ?)").run(
        normalized,
        now(),
      );
    }
  }

  // ── refresh tokens ──────────────────────────────────────────────────────
  function insertRefreshToken({ accountId, tokenHash, expiresAt }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO refresh_tokens (id, account_id, token_hash, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(id, accountId, tokenHash, expiresAt, now());
    return id;
  }

  function findRefreshToken(tokenHash) {
    const row = db
      .prepare("SELECT * FROM refresh_tokens WHERE token_hash = ?")
      .get(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      expiresAt: Number(row.expires_at),
      revokedAt: row.revoked_at == null ? null : Number(row.revoked_at),
    };
  }

  function revokeRefreshToken(id) {
    db.prepare(
      "UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).run(now(), id);
  }

  // Kills every live refresh token an account holds. Used both by reuse
  // detection (the chain is presumed stolen) and by the owner-triggered
  // sign-out-everywhere. Returns how many were still live.
  function revokeAllRefreshTokens(accountId) {
    const result = db
      .prepare(
        "UPDATE refresh_tokens SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL",
      )
      .run(now(), accountId);
    return Number(result.changes);
  }

  function countLiveRefreshTokens(accountId, nowMs) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM refresh_tokens
         WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(accountId, nowMs);
    return Number(row.n);
  }

  // ── session epoch ───────────────────────────────────────────────────────
  // Monotonic per account, deliberately not a timestamp: comparing counters
  // is exact, whereas comparing clocks leaves a window in which a session
  // minted "at the same instant" as a revocation is ambiguous.
  function getSessionEpoch(accountId) {
    const row = db
      .prepare("SELECT session_epoch FROM account_security WHERE account_id = ?")
      .get(accountId);
    return row ? Number(row.session_epoch) : 0;
  }

  function bumpSessionEpoch(accountId) {
    const next = getSessionEpoch(accountId) + 1;
    db.prepare(
      `INSERT INTO account_security (account_id, session_epoch) VALUES (?, ?)
       ON CONFLICT (account_id) DO UPDATE SET session_epoch = excluded.session_epoch`,
    ).run(accountId, next);
    return next;
  }

  // ── apple identity token single-use ─────────────────────────────────────
  // Returns true only for the caller that inserted the row, so exactly one
  // presentation of a given Apple credential can ever mint a session. The
  // insert is the atomic step — no read-then-write window.
  function claimAppleTokenUse({ tokenId, expiresAt, nowMs }) {
    db.prepare("DELETE FROM apple_token_uses WHERE expires_at <= ?").run(nowMs);
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO apple_token_uses (token_id, expires_at, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(tokenId, expiresAt, nowMs);
    return Number(result.changes) > 0;
  }

  function sweepAppleTokenUses(nowMs) {
    db.prepare("DELETE FROM apple_token_uses WHERE expires_at <= ?").run(nowMs);
  }

  // ── magic links ─────────────────────────────────────────────────────────
  function insertMagicLink({ email, tokenHash, expiresAt }) {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO magic_links (id, email, token_hash, expires_at, used_at, created_at)
       VALUES (?, ?, ?, ?, NULL, ?)`,
    ).run(id, normalizeEmail(email), tokenHash, expiresAt, now());
    return id;
  }

  function findMagicLink(tokenHash) {
    const row = db
      .prepare("SELECT * FROM magic_links WHERE token_hash = ?")
      .get(tokenHash);
    if (!row) return null;
    return {
      id: row.id,
      // Re-normalized on read as well: rows written before the rule existed
      // must resolve to the same account as rows written after it.
      email: normalizeEmail(row.email),
      expiresAt: Number(row.expires_at),
      usedAt: row.used_at == null ? null : Number(row.used_at),
    };
  }

  function markMagicLinkUsed(id) {
    db.prepare("UPDATE magic_links SET used_at = ? WHERE id = ?").run(now(), id);
  }

  // ── device codes (CLI login) ────────────────────────────────────────────
  function createDeviceCode({ deviceCodeHash, userCode, expiresAt, clientIp = null }) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO device_codes (id, device_code_hash, user_code, expires_at, created_at, client_ip) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(id, deviceCodeHash, userCode, expiresAt, now(), clientIp);
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE id = ?").get(id));
  }

  function getDeviceCodeByHash(hash) {
    if (!hash) return null;
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE device_code_hash = ?").get(hash));
  }

  function getDeviceCodeByUserCode(userCode) {
    if (!userCode) return null;
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE user_code = ?").get(userCode));
  }

  // Approval is a ONE-TIME transition, enforced atomically here rather than by
  // a read-then-write in the route. Without `AND account_id IS NULL` a second
  // account could silently rebind an already-approved code, and the victim's
  // CLI — which sees nothing but a successful login — would receive a session
  // for the ATTACKER's account: every later `relay handoff` targets the
  // attacker's node, and `relay sync-auth` seals the victim's GitHub token and
  // harness credentials to the attacker's node key. Returns null when the
  // transition did not happen, so the caller must decide what to do about it
  // instead of reading back a row that someone else's write may have won.
  function approveDeviceCode(id, accountId) {
    const result = db.prepare(
      `UPDATE device_codes SET account_id = ?, approved_at = ?
         WHERE id = ? AND account_id IS NULL AND consumed_at IS NULL`,
    ).run(accountId, now(), id);
    if (result.changes === 0) return null;
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE id = ?").get(id));
  }

  // The atomic `AND consumed_at IS NULL` is what makes redemption single-use
  // under concurrency: two simultaneous polls on one approved code race here,
  // and exactly one of them sees changes > 0.
  function consumeDeviceCode(id) {
    const result = db.prepare("UPDATE device_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .run(now(), id);
    return result.changes > 0;
  }

  // Redeemed rows go too, not just expired ones: a consumed row holds no live
  // secret (the device code is stored only as sha256) and is not redeemable,
  // but it pins a dead user_code in the unique index and keeps a dead
  // account_id link for the remainder of its TTL.
  function sweepDeviceCodes(nowMs) {
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ? OR consumed_at IS NOT NULL").run(nowMs);
  }

  // Live = still redeemable: unconsumed and unexpired. The ceiling on
  // POST /v1/auth/device/start is read off this, so consumed and aged-out rows
  // must not count against it.
  function countLiveDeviceCodes(nowMs) {
    return Number(db.prepare(
      "SELECT COUNT(*) AS n FROM device_codes WHERE consumed_at IS NULL AND expires_at > ?",
    ).get(nowMs).n);
  }

  // The per-IP twin of countLiveDeviceCodes. The global ceiling alone bounds
  // the table but not who fills it: one caller holding DEVICE_CODE_MAX_LIVE
  // codes denies every OTHER caller a code for the rest of the TTL window.
  // `clientIp` is nginx's `X-Real-IP` (trustworthy — see the column comment
  // on device_codes in db.js); a null clientIp (no trusted signal available)
  // counts against nothing, matching the global ceiling's own fail-open
  // posture when the signal is absent rather than inventing a shared bucket
  // for every signal-less caller to collide in.
  function countLiveDeviceCodesForIp(clientIp, nowMs) {
    if (!clientIp) return 0;
    return Number(db.prepare(
      "SELECT COUNT(*) AS n FROM device_codes WHERE client_ip = ? AND consumed_at IS NULL AND expires_at > ?",
    ).get(clientIp, nowMs).n);
  }

  // ── pairing sessions (protocol v2) ──────────────────────────────────────
  //
  // The cloud stores sha256(authToken) — never a pairing secret, which it is
  // never given — plus two opaque blobs and the MAC tags their senders
  // computed. Blobs and tags are bytes to this layer.
  function insertPairingSession({ id, accountId, kind, authTokenHash, expiresAt }) {
    db.prepare(
      `INSERT INTO pairing_sessions
         (id, account_id, kind, auth_token_hash,
          node_blob, node_tag, node_read_at,
          device_blob, device_tag, device_read_at,
          closed_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(id, accountId, kind, authTokenHash, expiresAt, now());
  }

  function getPairingSession(id) {
    const row = db
      .prepare("SELECT * FROM pairing_sessions WHERE id = ?")
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
      kind: row.kind,
      authTokenHash: row.auth_token_hash,
      nodeBlob: row.node_blob,
      nodeTag: row.node_tag,
      nodeReadAt: row.node_read_at == null ? null : Number(row.node_read_at),
      deviceBlob: row.device_blob,
      deviceTag: row.device_tag,
      deviceReadAt: row.device_read_at == null ? null : Number(row.device_read_at),
      closedAt: row.closed_at == null ? null : Number(row.closed_at),
      expiresAt: Number(row.expires_at),
    };
  }

  // PUT-ONCE. The `IS NULL` guard makes the first write win atomically; a
  // second write touches zero rows and the caller turns that into a 409.
  // Returns true when this call was the one that filled the slot.
  function setPairingBlob(id, slot, base64, tag) {
    const blobColumn = slot === "node" ? "node_blob" : "device_blob";
    const tagColumn = slot === "node" ? "node_tag" : "device_tag";
    const result = db
      .prepare(
        `UPDATE pairing_sessions SET ${blobColumn} = ?, ${tagColumn} = ?
         WHERE id = ? AND ${blobColumn} IS NULL AND closed_at IS NULL`,
      )
      .run(base64, tag, id);
    return Number(result.changes) > 0;
  }

  function markPairingBlobRead(id, slot) {
    const column = slot === "node" ? "node_read_at" : "device_read_at";
    db.prepare(
      `UPDATE pairing_sessions SET ${column} = ? WHERE id = ? AND ${column} IS NULL`,
    ).run(now(), id);
  }

  // Closes a completed exchange: the relayed bytes are dropped immediately
  // rather than lingering for the remainder of the TTL. The row survives only
  // as a tombstone so a late request gets a clean rejection.
  function closePairingSession(id) {
    db.prepare(
      `UPDATE pairing_sessions
         SET node_blob = NULL, node_tag = NULL,
             device_blob = NULL, device_tag = NULL,
             closed_at = ?
       WHERE id = ? AND closed_at IS NULL`,
    ).run(now(), id);
  }

  // Live (unexpired, unclosed) sessions for one (account, kind) — the
  // anti-pinning cap. Scoped per kind so a stuck backlog in one kind (e.g. a
  // sync-auth handoff nobody picked up) can never block another (e.g. pair).
  function countLivePairingSessions(accountId, kind, nowMs) {
    return Number(db.prepare(
      "SELECT COUNT(*) AS n FROM pairing_sessions WHERE account_id = ? AND kind = ? AND closed_at IS NULL AND expires_at > ?",
    ).get(accountId, kind, nowMs).n);
  }

  function sweepPairingSessions(nowMs) {
    db.prepare("DELETE FROM pairing_sessions WHERE expires_at <= ?").run(nowMs);
  }

  // ── node events ─────────────────────────────────────────────────────────
  //
  // Ingest is idempotent on (node_id, seq). Two layers, both required:
  //
  //   claimNodeEventSeq  — advances the per-node high-water mark, and only
  //                        succeeds when seq is strictly greater than it. One
  //                        atomic statement, so concurrent replays of the same
  //                        capture cannot both win. Durable across the event
  //                        retention sweep.
  //   UNIQUE(node_id,seq)— rejects the insert itself if anything slips past
  //                        the cursor (e.g. a cursor row deleted by hand).
  //
  // Callers treat "not claimed" and "unique violation" identically: the event
  // has already been accounted for, so respond 202 and push nothing.
  function claimNodeEventSeq(nodeId, seq) {
    const result = db
      .prepare(
        `INSERT INTO node_event_cursors (node_id, last_seq, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (node_id) DO UPDATE SET last_seq = excluded.last_seq, updated_at = excluded.updated_at
         WHERE excluded.last_seq > node_event_cursors.last_seq`,
      )
      .run(nodeId, seq, now());
    return Number(result.changes) > 0;
  }

  function getNodeEventCursor(nodeId) {
    const row = db
      .prepare("SELECT last_seq FROM node_event_cursors WHERE node_id = ?")
      .get(nodeId);
    return row ? Number(row.last_seq) : 0;
  }

  // Returns the new row id, or null when (node_id, seq) is already present.
  function insertNodeEvent({ nodeId, accountId, jobId, type, ts, seq }) {
    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO node_events (id, node_id, account_id, job_id, type, ts, seq, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, nodeId, accountId, jobId ?? null, type, ts, seq ?? null, now());
    } catch (err) {
      if (isUniqueViolation(err)) return null; // duplicate delivery
      throw err;
    }
    return id;
  }

  function countNodeEvents() {
    return Number(
      db.prepare("SELECT COUNT(*) AS n FROM node_events").get().n,
    );
  }

  function sweepNodeEvents(cutoffMs) {
    db.prepare("DELETE FROM node_events WHERE created_at < ?").run(cutoffMs);
  }

  // ── handoffs ────────────────────────────────────────────────────────────
  //
  // A handoff record is a content-free pointer — repo, branch, node id — that
  // lets a node long-poll pick up work with no content ever transiting the
  // cloud. `createHandoff` is the write half of `POST /v1/handoffs`;
  // idempotency on `id` is enforced by the caller via getHandoff, not here.
  const HANDOFF_PATCH_COLUMNS = { state: "state", reason: "reason", deliveredAt: "delivered_at" };

  function createHandoff({ id, accountId, nodeId, repo, branch }) {
    const ts = now();
    db.prepare(
      "INSERT INTO handoffs (id, account_id, node_id, repo, branch, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
    ).run(id, accountId, nodeId, repo, branch, ts, ts);
    return getHandoff(id);
  }

  function getHandoff(id) {
    return mapHandoff(db.prepare("SELECT * FROM handoffs WHERE id = ?").get(id));
  }

  // `rowid` is the tiebreaker on both queries below: `created_at` is
  // millisecond-resolution, so two handoffs minted in the same millisecond
  // would otherwise sort nondeterministically (SQLite makes no ordering
  // guarantee among rows with an equal ORDER BY key). rowid reflects
  // insertion order, so ties resolve to "most/least recently created" the
  // same way the millisecond column intends. See Task 8 review, M-7.
  function listHandoffsForRepo(accountId, repo, limit = 50) {
    return db.prepare(
      "SELECT * FROM handoffs WHERE account_id = ? AND repo = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    ).all(accountId, repo, limit).map(mapHandoff);
  }

  // A row a poll leased but nobody ever confirmed must become claimable
  // again, not stay stuck `leased` forever behind a peer that is never
  // coming back. Reclaiming lazily here — rather than on a timer — mirrors
  // createReplayGuard's lazy sweep: no extra timer to keep unref'd, and it
  // runs exactly when the answer matters (the next time this node's pending
  // work is read). Called from both listPendingHandoffs and
  // countPendingHandoffs so neither can observe a stale `leased` row the
  // other has already reclaimed.
  function reclaimExpiredLeases(nodeId) {
    db.prepare(
      "UPDATE handoffs SET state = 'pending', lease_token = NULL, lease_expires_at = NULL, updated_at = ? " +
      "WHERE node_id = ? AND state = 'leased' AND lease_expires_at <= ?",
    ).run(now(), nodeId, now());
  }

  // Capped so a node that was offline for a long stretch — during which many
  // pings landed — cannot be handed one unbounded JSON response; a node past
  // the cap simply finds the rest still `pending` on its next poll. See Task
  // 8 review, M-6.
  //
  // `rowid` is the tiebreaker: `created_at` is millisecond-resolution, so two
  // handoffs minted in the same millisecond would otherwise sort
  // nondeterministically under a LIMIT (SQLite makes no ordering guarantee
  // among rows with an equal ORDER BY key) — a node offline through a burst
  // could be hand-waved a nondeterministic, possibly-not-oldest slice of its
  // backlog on every poll. rowid reflects insertion order, so ties resolve to
  // "earliest created" the same way the millisecond column intends.
  function listPendingHandoffs(nodeId, limit = 50) {
    reclaimExpiredLeases(nodeId);
    return db.prepare(
      "SELECT * FROM handoffs WHERE node_id = ? AND state = 'pending' ORDER BY created_at, rowid LIMIT ?",
    ).all(nodeId, limit).map(mapHandoff);
  }

  function countPendingHandoffs(nodeId) {
    reclaimExpiredLeases(nodeId);
    return Number(db.prepare("SELECT COUNT(*) AS n FROM handoffs WHERE node_id = ? AND state = 'pending'")
      .get(nodeId).n);
  }

  // Hands a batch of pending rows out on a lease rather than delivering them
  // outright — see the lease_token/lease_expires_at comment on the handoffs
  // table in db.js and Task 8 review, Finding 1 / IMPORTANT 1. Each id is
  // flipped `pending` -> `leased` with a fresh, unguessable token
  // (capability, not just an identifier) and a `leaseMs` visibility timeout,
  // ONLY if it is still `pending` at the moment of the UPDATE — so a caller
  // can never lease a row twice or steal one already leased to a different
  // batch. Nothing awaits between a caller's listPendingHandoffs and this
  // call today, so there is no actual race in this single-threaded,
  // synchronous-DB process; the WHERE clause keeps the guarantee true
  // regardless.
  function leaseHandoffs(ids, nodeId, leaseMs) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const expiresAt = now() + leaseMs;
    const stmt = db.prepare(
      "UPDATE handoffs SET state = 'leased', lease_token = ?, lease_expires_at = ?, updated_at = ? " +
      "WHERE id = ? AND node_id = ? AND state = 'pending'",
    );
    const leased = [];
    for (const id of ids) {
      const token = randomUUID();
      const info = stmt.run(token, expiresAt, now(), id, nodeId);
      if (info.changes > 0) leased.push(getHandoff(id));
    }
    return leased;
  }

  // The ONLY path to `delivered`. A compare-and-swap on
  // (id, node_id, state='leased', lease_token): an ack naming the wrong
  // token — because the lease already expired and the row was reclaimed
  // (and possibly re-leased under a fresh token), or because the id/token
  // pairing was never issued to this node — matches zero rows and is
  // silently ignored. That is exactly what "unconfirmed" is supposed to
  // mean: no ambient authority lets a caller confirm a delivery it cannot
  // prove it received. Returns the subset of `acks` that were actually
  // confirmed, so the caller can tell a stale/rejected ack from a live one
  // without a second round trip.
  function confirmHandoffDelivery(nodeId, acks) {
    if (!Array.isArray(acks) || acks.length === 0) return [];
    const stmt = db.prepare(
      "UPDATE handoffs SET state = 'delivered', delivered_at = ?, lease_token = NULL, lease_expires_at = NULL, " +
      "updated_at = ? WHERE id = ? AND node_id = ? AND state = 'leased' AND lease_token = ?",
    );
    const confirmed = [];
    for (const { id, lease } of acks) {
      const info = stmt.run(now(), now(), id, nodeId, lease);
      if (info.changes > 0) confirmed.push(id);
    }
    return confirmed;
  }

  function updateHandoff(id, patch = {}) {
    const assignments = [];
    const values = [];
    for (const [key, column] of Object.entries(HANDOFF_PATCH_COLUMNS)) {
      if (key in patch) { assignments.push(`${column} = ?`); values.push(patch[key]); }
    }
    assignments.push("updated_at = ?");
    values.push(now(), id);
    db.prepare(`UPDATE handoffs SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return getHandoff(id);
  }

  return {
    createAccount,
    ensureAccount,
    deleteAccount,
    getAccount,
    findAccountByAppleSub,
    findAccountByEmail,
    attachEmail,
    attachAppleSub,
    setEntitlement,
    getEntitlement,
    listEntitlements,
    createDevice,
    updateDevice,
    getDevice,
    listDevices,
    listPushDevices,
    deleteDevice,
    clearApnsToken,
    createNode,
    getNode,
    listNodes,
    countNodes,
    deleteNode,
    touchNode,
    adminListNodes,
    createTrialNode,
    getTrialById,
    getTrialByAccount,
    getTrialByTokenHash,
    updateTrial,
    listTrialsDue,
    listTrialsPastGrace,
    countActiveTrials,
    recordSandboxOrphan,
    listSandboxOrphans,
    clearSandboxOrphan,
    upsertRepo,
    getRepo,
    listRepos,
    addToWaitlist,
    insertRefreshToken,
    findRefreshToken,
    revokeRefreshToken,
    revokeAllRefreshTokens,
    countLiveRefreshTokens,
    getSessionEpoch,
    bumpSessionEpoch,
    claimAppleTokenUse,
    sweepAppleTokenUses,
    insertMagicLink,
    findMagicLink,
    markMagicLinkUsed,
    createDeviceCode,
    getDeviceCodeByHash,
    getDeviceCodeByUserCode,
    approveDeviceCode,
    consumeDeviceCode,
    sweepDeviceCodes,
    countLiveDeviceCodes,
    countLiveDeviceCodesForIp,
    insertPairingSession,
    getPairingSession,
    setPairingBlob,
    markPairingBlobRead,
    closePairingSession,
    countLivePairingSessions,
    sweepPairingSessions,
    claimNodeEventSeq,
    getNodeEventCursor,
    insertNodeEvent,
    countNodeEvents,
    sweepNodeEvents,
    createHandoff,
    getHandoff,
    listHandoffsForRepo,
    listPendingHandoffs,
    countPendingHandoffs,
    leaseHandoffs,
    confirmHandoffDelivery,
    updateHandoff,
  };
}

function mapAccount(row) {
  return {
    id: row.id,
    appleSub: row.apple_sub,
    email: row.email,
    createdAt: Number(row.created_at),
  };
}

function mapDevice(row) {
  let certSerials = [];
  try {
    certSerials = JSON.parse(row.cert_serials);
  } catch {
    certSerials = [];
  }
  return {
    id: row.id,
    accountId: row.account_id,
    apnsToken: row.apns_token,
    platform: row.platform,
    name: row.name,
    certSerials,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapNode(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    kind: row.kind,
    name: row.name,
    pubkey: row.pubkey,
    // See the two-key note on the `nodes` table in db.js: this is the
    // X25519 sealed-handoff key, never the ed25519 `pubkey` above. Included
    // on every node returned from here (including /v1/nodes, which cannot
    // set it) deliberately: it is public-key material — safe to expose,
    // same as pubkey — and keeping one node shape everywhere a node is
    // returned means routes never need an allow-list kept in sync by hand
    // as fields are added. It is simply always null for nodes registered
    // through /v1/nodes today, since only trial enroll sets it (MINOR 5).
    encPubkey: row.enc_pubkey ?? null,
    version: row.version,
    lastSeen: row.last_seen == null ? null : Number(row.last_seen),
    createdAt: Number(row.created_at),
  };
}

function mapRepo(row) {
  if (!row) return null;
  return { id: row.id, fullName: row.full_name, createdAt: row.created_at };
}

function mapDeviceCode(row) {
  if (!row) return null;
  return {
    id: row.id,
    userCode: row.user_code,
    accountId: row.account_id ?? null,
    approvedAt: row.approved_at == null ? null : Number(row.approved_at),
    consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
    clientIp: row.client_ip ?? null,
  };
}

function mapHandoff(row) {
  if (!row) return null;
  return {
    id: row.id,
    accountId: row.account_id,
    nodeId: row.node_id,
    repo: row.repo,
    branch: row.branch,
    state: row.state,
    reason: row.reason ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deliveredAt: row.delivered_at ?? null,
    // Internal-only (never in publicHandoff's explicit field list, so a node
    // long-poll's own lease token is never echoed to the account's own
    // session-authed clients via POST/GET /v1/handoffs).
    leaseToken: row.lease_token ?? null,
    leaseExpiresAt: row.lease_expires_at ?? null,
  };
}

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
