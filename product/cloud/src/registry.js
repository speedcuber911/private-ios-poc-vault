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
// encryption key column. Follows the same idiom as ensureNodeEventSchema: a
// database provisioned from an earlier schema must gain the column on open
// rather than fail closed on first use. db.js stays the canonical home for
// the core tables.
function ensureNodeEncColumn(db) {
  let columns = [];
  try {
    columns = db.prepare("PRAGMA table_info(nodes)").all();
  } catch {
    return;
  }
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "enc_pubkey")) {
    db.exec("ALTER TABLE nodes ADD COLUMN enc_pubkey TEXT");
  }
}

export function createRegistry(db, { now = () => Date.now() } = {}) {
  ensureAuthSchema(db);
  ensureNodeEventSchema(db);
  ensureNodeEncColumn(db);

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
  function createDeviceCode({ deviceCodeHash, userCode, expiresAt }) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO device_codes (id, device_code_hash, user_code, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, deviceCodeHash, userCode, expiresAt, now());
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

  function approveDeviceCode(id, accountId) {
    db.prepare("UPDATE device_codes SET account_id = ?, approved_at = ? WHERE id = ?").run(accountId, now(), id);
    return mapDeviceCode(db.prepare("SELECT * FROM device_codes WHERE id = ?").get(id));
  }

  function consumeDeviceCode(id) {
    const result = db.prepare("UPDATE device_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL")
      .run(now(), id);
    return result.changes > 0;
  }

  function sweepDeviceCodes(nowMs) {
    db.prepare("DELETE FROM device_codes WHERE expires_at <= ?").run(nowMs);
  }

  // ── pairing sessions (protocol v2) ──────────────────────────────────────
  //
  // The cloud stores sha256(authToken) — never a pairing secret, which it is
  // never given — plus two opaque blobs and the MAC tags their senders
  // computed. Blobs and tags are bytes to this layer.
  function insertPairingSession({ id, accountId, authTokenHash, expiresAt }) {
    db.prepare(
      `INSERT INTO pairing_sessions
         (id, account_id, auth_token_hash,
          node_blob, node_tag, node_read_at,
          device_blob, device_tag, device_read_at,
          closed_at, expires_at, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).run(id, accountId, authTokenHash, expiresAt, now());
  }

  function getPairingSession(id) {
    const row = db
      .prepare("SELECT * FROM pairing_sessions WHERE id = ?")
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      accountId: row.account_id,
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

  // Live (unexpired, unclosed) sessions for one account — the anti-pinning cap.
  function countLivePairingSessions(accountId, nowMs) {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM pairing_sessions
         WHERE account_id = ? AND expires_at > ? AND closed_at IS NULL`,
      )
      .get(accountId, nowMs);
    return Number(row.n);
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
    approvedAt: row.approved_at ?? null,
    consumedAt: row.consumed_at ?? null,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
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
