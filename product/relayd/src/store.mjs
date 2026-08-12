// relayd store.mjs — W2-MODULES: storage interface with two backends.
//
// - "json" (default): byte-identical to the historical on-disk layout
//   (jobs/<id>.json with atomic tmp+rename, chats/<id>.json, devices.json,
//   revocations.json). The conformance suite reads and writes these files
//   directly, so this backend must never change shape.
// - "sqlite": node:sqlite (built into Node 22) with tables
//   jobs, threads, chats, events, devices, revocations, pairing_sessions.
//   Logs, attachments and artifacts always stay on disk regardless of backend.
//
// Selection: RELAYD_STORE=json|sqlite (default json).
// SQLite path: RELAYD_SQLITE_PATH (default <dataDir>/relayd.sqlite).
//
// Pairing sessions are persisted (not held in a process-local Map) because
// `relayd pair` runs in a SHORT-LIVED CLI PROCESS while the redemption is
// served by the long-running daemon — a different process. Both backends
// therefore expose an ATOMIC claim (`consumePairingSession`) that at most one
// caller can win, ACROSS PROCESSES:
//   - json:   exclusive create — open(O_CREAT|O_EXCL) of a `<id>.claim` marker.
//             POSIX (and Windows CREATE_NEW) require the existence test and the
//             creation to be ONE indivisible filesystem operation, so of N
//             racing creators exactly one gets the file and the rest get EEXIST.
//   - sqlite: DELETE ... WHERE id = ?; the write transaction is exclusive, so
//             exactly one caller observes changes === 1.
//
// What this must never go back to: `unlink`. It was documented here as "unlink
// is atomic, the loser gets ENOENT" and that is FALSE — unlink carries no
// test-and-act requirement, and on darwin/APFS two processes unlinking the same
// path both return success. One pairing code then minted TWO device
// certificates, i.e. an unauthorized device with full data-path access.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { dataDir, jobsDir, chatsDir, pairingDir, realpathOrResolve } from "./config.mjs";
import { appendAudit } from "./audit.mjs";
import { nowIso } from "./util.mjs";

const SAFE_RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

// Suffix of the pairing claim marker written by the JSON backend.
const CLAIM_SUFFIX = ".claim";

function assertSafeRecordId(id) {
  if (typeof id !== "string" || !SAFE_RECORD_ID.test(id) || id.includes("..")) {
    throw new Error("record id is invalid");
  }
  return id;
}

// Same containment-checked removal as jobs.removePathInsideRoot (duplicated
// here to avoid a jobs.mjs <-> store.mjs import cycle).
function removeInsideRoot(target, rootDir) {
  if (typeof target !== "string" || !target || /[\0\r\n]/.test(target)) return false;
  const root = realpathOrResolve(rootDir);
  const resolvedTarget = realpathOrResolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
    return true;
  } catch (error) {
    appendAudit("remove_path_failed", null, {
      target: relative,
      error: error.message || String(error),
    });
    return false;
  }
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// tmp + rename, with a temp name that is UNIQUE PER WRITE.
//
// A fixed `<file>.tmp` is shared mutable state between processes: `relayd
// devices revoke` mutates devices.json in its own process while the daemon may
// be writing it during a pairing, and both would open the same temp path. The
// interleaving is write(A) → write(B) → rename(A) → rename(B): A's rename moves
// the temp away, B's rename then fails with ENOENT — which surfaced to an
// unauthenticated pairing caller as a 500 carrying absolute host paths.
// pid + random bytes make the temp private to one writer; rename stays atomic,
// so a reader still sees either the old file or the new one, never a partial.
function writeJsonFileAtomic(file, value, { mode } = {}) {
  const tmpFile = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpFile, `${JSON.stringify(value, null, 2)}\n`, mode ? { encoding: "utf8", mode } : "utf8");
    fs.renameSync(tmpFile, file);
  } catch (error) {
    // Never leave the temp behind: it is now unreachable by name.
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // Already gone.
    }
    throw error;
  }
}

// Cross-process mutual exclusion for the read-modify-write list files.
//
// A unique temp name fixes the temp-path COLLISION but not the LOST UPDATE:
// two processes can both read devices.json, each append their own record, and
// each rename a complete file over the other's — one device record silently
// disappears, so a genuinely paired device has no enrollment row and cannot be
// listed or revoked. Serializing the read-modify-write is the only fix; the
// claim uses the same O_EXCL create that makes the pairing claim atomic.
//
// Degrades to the old unsynchronized behavior rather than failing the write:
// losing an update is bad, refusing to record a device at all is worse.
const listLockStaleMs = 10 * 1000;
const listLockTimeoutMs = 5 * 1000;

// Timer-free synchronous nap; the daemon is single-threaded and contention
// here is measured in milliseconds.
function napSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireListLock(lockPath) {
  const deadline = Date.now() + listLockTimeoutMs;
  for (;;) {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") return false;
    }
    // Take over a lock left behind by a process that died holding it.
    try {
      if (Date.now() - fs.statSync(lockPath).mtimeMs > listLockStaleMs) fs.unlinkSync(lockPath);
    } catch {
      // Someone else already cleared it.
    }
    if (Date.now() >= deadline) return false;
    napSync(2);
  }
}

function mutateListFile(file, readList, mutate) {
  const lockPath = `${file}.lock`;
  const locked = acquireListLock(lockPath);
  try {
    writeJsonFileAtomic(file, mutate(readList(file)));
  } finally {
    if (locked) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // Already taken over as stale.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// JSON backend — preserves the historical layout exactly.
// ---------------------------------------------------------------------------

function createJsonStore({ jobsDir: jobsRoot, chatsDir: chatsRoot, dataDir: dataRoot, pairingDir: pairingRoot }) {
  const devicesPath = path.join(dataRoot, "devices.json");
  const revocationsPath = path.join(dataRoot, "revocations.json");
  const pairingSessionsRoot = pairingRoot || path.join(dataRoot, "pairing");
  const handoffsDir = path.join(dataRoot, "handoffs");

  function readListFile(file) {
    try {
      const value = readJsonFile(file);
      return Array.isArray(value) ? value : [];
    } catch {
      return [];
    }
  }

  function ensurePairingRoot() {
    fs.mkdirSync(pairingSessionsRoot, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(pairingSessionsRoot, 0o700);
    } catch {
      // Best effort: a pre-existing dir with looser modes still works.
    }
    return pairingSessionsRoot;
  }

  function pairingSessionPath(id) {
    return path.join(pairingSessionsRoot, `${assertSafeRecordId(id)}.json`);
  }

  // The claim marker (tombstone) for a session. Session records always end in
  // ".json", markers always in ".claim", so the two name spaces cannot overlap.
  function pairingClaimPath(id) {
    return path.join(pairingSessionsRoot, `${assertSafeRecordId(id)}${CLAIM_SUFFIX}`);
  }

  function pairingSessionIsClaimed(id) {
    try {
      return fs.existsSync(pairingClaimPath(id));
    } catch {
      return true;
    }
  }

  // Drops tombstones (and any record a crashed winner failed to unlink) once
  // the session they stand for has expired: past that point the code is
  // refused on expiry grounds alone, so the marker has nothing left to guard.
  function sweepPairingClaims(nowMs) {
    let names = [];
    try {
      names = fs.readdirSync(pairingSessionsRoot);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(CLAIM_SUFFIX)) continue;
      const claimFile = path.join(pairingSessionsRoot, name);
      let expiresAt = NaN;
      try {
        expiresAt = Date.parse(readJsonFile(claimFile)?.expiresAt);
      } catch {
        // Unreadable marker: fall back to its own age.
      }
      if (!Number.isFinite(expiresAt)) {
        try {
          expiresAt = fs.statSync(claimFile).mtimeMs;
        } catch {
          continue;
        }
      }
      if (expiresAt > nowMs) continue;
      // Record first, marker second: a crash in between leaves the marker,
      // which is the fail-closed order.
      try {
        fs.unlinkSync(path.join(pairingSessionsRoot, `${name.slice(0, -CLAIM_SUFFIX.length)}.json`));
      } catch {
        // Normally already consumed.
      }
      try {
        fs.unlinkSync(claimFile);
      } catch {
        // Another pruner got there first.
      }
    }
  }

  return {
    kind: "json",

    saveJob(job) {
      assertSafeRecordId(job.id);
      writeJsonFileAtomic(path.join(jobsRoot, `${job.id}.json`), job);
    },

    loadJobRecords() {
      let files = [];
      try {
        files = fs.readdirSync(jobsRoot).filter((file) => file.endsWith(".json")).sort();
      } catch {
        return [];
      }
      const records = [];
      for (const file of files) {
        try {
          records.push({ sourceId: file, job: readJsonFile(path.join(jobsRoot, file)) });
        } catch (error) {
          appendAudit("load_job_failed", { id: file, status: "unknown" }, { error: error.message });
        }
      }
      return records;
    },

    deleteJob() {
      // The job JSON file lives inside dataDir and is removed by
      // jobs.removePersistedJobFiles alongside logs/attachments/artifacts.
      return false;
    },

    saveChatThread(thread) {
      assertSafeRecordId(thread.id);
      fs.writeFileSync(path.join(chatsRoot, `${thread.id}.json`), `${JSON.stringify(thread, null, 2)}\n`, "utf8");
    },

    readChatThreadRecord(threadId) {
      try {
        assertSafeRecordId(threadId);
        return readJsonFile(path.join(chatsRoot, `${threadId}.json`));
      } catch {
        return null;
      }
    },

    listChatThreadIds() {
      let entries = [];
      try {
        entries = fs.readdirSync(chatsRoot, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => entry.name.slice(0, -5));
    },

    deleteChatThread(threadId) {
      try {
        assertSafeRecordId(threadId);
      } catch {
        return false;
      }
      return removeInsideRoot(path.join(chatsRoot, `${threadId}.json`), chatsRoot);
    },

    appendEvent() {
      // Events are in-memory only on the JSON backend (bounded bus in
      // events.mjs); nothing is persisted.
      return null;
    },

    listEvents() {
      return [];
    },

    lastEventId() {
      return 0;
    },

    saveDevice(device) {
      assertSafeRecordId(device.id);
      // Locked: a concurrent writer (a pairing in the daemon, `relayd devices
      // revoke` in its own process) must not be able to drop this record.
      mutateListFile(devicesPath, readListFile, (devices) => [
        ...devices.filter((entry) => entry?.id !== device.id),
        device,
      ]);
    },

    getDevice(id) {
      return readListFile(devicesPath).find((entry) => entry?.id === id) || null;
    },

    listDevices() {
      return readListFile(devicesPath);
    },

    addRevocation(revocation) {
      mutateListFile(revocationsPath, readListFile, (revocations) => [
        ...revocations.filter((entry) => entry?.serial !== revocation.serial),
        revocation,
      ]);
    },

    listRevocations() {
      return readListFile(revocationsPath);
    },

    // ── pairing sessions (see the header note on cross-process atomicity) ──

    savePairingSession(session) {
      assertSafeRecordId(session.id);
      ensurePairingRoot();
      writeJsonFileAtomic(pairingSessionPath(session.id), session, { mode: 0o600 });
    },

    listPairingSessions() {
      let files = [];
      try {
        files = fs.readdirSync(pairingSessionsRoot).filter((file) => file.endsWith(".json"));
      } catch {
        return [];
      }
      const sessions = [];
      for (const file of files) {
        try {
          const value = readJsonFile(path.join(pairingSessionsRoot, file));
          // A concurrent claim can unlink the file between readdir and read;
          // a partially-written record is impossible (tmp + rename).
          if (!value || typeof value.id !== "string") continue;
          // A claimed session is never offered again, even if the winner died
          // before it could unlink the record. Fail closed.
          if (pairingSessionIsClaimed(value.id)) continue;
          sessions.push(value);
        } catch {
          // Missing or unreadable: treat as already consumed.
        }
      }
      return sessions;
    },

    // ATOMIC CLAIM — exclusive create, NOT unlink.
    //
    // `writeFileSync(..., { flag: "wx" })` is open(O_CREAT|O_EXCL|O_WRONLY).
    // POSIX requires that pair of flags to make the existence test and the
    // creation one indivisible filesystem operation, so when N processes race,
    // exactly one creates the marker and every other one gets EEXIST. That is
    // the entire single-use guarantee, and it holds on every platform — unlike
    // `unlink`, which this used to use: unlink has no test-and-act requirement
    // and on darwin/APFS two processes unlinking one path BOTH succeed, which
    // let one pairing code mint two device certificates.
    //
    // The marker is a TOMBSTONE and the winner deliberately does not remove it:
    // if it did, a loser that had already read the record could create the
    // marker afterwards and win a second time. It is swept once the session it
    // stands for would have expired anyway (prunePairingSessions).
    consumePairingSession(id) {
      let file;
      let claimFile;
      try {
        file = pairingSessionPath(id);
        claimFile = pairingClaimPath(id);
      } catch {
        return false;
      }
      // Nothing to claim — never leave a marker behind for a session that does
      // not exist (an already-consumed id included).
      let session = null;
      try {
        session = readJsonFile(file);
      } catch {
        return false;
      }
      try {
        fs.writeFileSync(
          claimFile,
          `${JSON.stringify({ id, claimedAt: nowIso(), expiresAt: session?.expiresAt ?? null })}\n`,
          { flag: "wx", mode: 0o600 },
        );
      } catch {
        // EEXIST: another process claimed it first. Anything else (no dir, no
        // permission) is also a lost claim — refusing is the safe answer.
        return false;
      }
      try {
        fs.unlinkSync(file);
      } catch {
        // Already gone or unremovable: the marker alone keeps it unusable.
      }
      return true;
    },

    prunePairingSessions(nowMs = Date.now()) {
      let removed = 0;
      for (const session of this.listPairingSessions()) {
        const expiresAt = Date.parse(session.expiresAt);
        if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
          if (this.consumePairingSession(session.id)) removed += 1;
        }
      }
      sweepPairingClaims(nowMs);
      return removed;
    },

    // ── handoffs (laptop -> cloud sandbox session handoff records) ──

    saveHandoff(handoff) {
      assertSafeRecordId(handoff.id);
      fs.mkdirSync(handoffsDir, { recursive: true });
      writeJsonFileAtomic(path.join(handoffsDir, `${handoff.id}.json`), handoff, { mode: 0o600 });
    },

    getHandoff(id) {
      assertSafeRecordId(id);
      try {
        return JSON.parse(fs.readFileSync(path.join(handoffsDir, `${id}.json`), "utf8"));
      } catch {
        return null;
      }
    },

    listHandoffs() {
      let names = [];
      try {
        names = fs.readdirSync(handoffsDir).filter((name) => name.endsWith(".json"));
      } catch {
        return [];
      }
      return names
        .map((name) => this.getHandoff(name.slice(0, -".json".length)))
        .filter(Boolean)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    },

    close() {},
  };
}

// ---------------------------------------------------------------------------
// SQLite backend — node:sqlite, zero external dependencies.
// ---------------------------------------------------------------------------

const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT,
  provider TEXT,
  workspace_id TEXT,
  session_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  mode TEXT,
  provider TEXT,
  workspace_id TEXT,
  updated_at TEXT,
  last_job_id TEXT
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  provider TEXT,
  workspace_id TEXT,
  created_at TEXT,
  updated_at TEXT,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ts TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  platform TEXT,
  cert_serial TEXT,
  cert_subject TEXT,
  created_at TEXT,
  last_seen_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS revocations (
  serial TEXT PRIMARY KEY,
  device_id TEXT,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS pairing_sessions (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  token TEXT NOT NULL,
  node_id TEXT,
  node_name TEXT,
  created_at TEXT,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  repo TEXT NOT NULL,
  branch TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  record TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs (created_at);
CREATE INDEX IF NOT EXISTS idx_events_name ON events (name);
CREATE INDEX IF NOT EXISTS idx_pairing_expires ON pairing_sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_handoffs_created ON handoffs (created_at);
`;

async function openSqlite(dbPath) {
  const { DatabaseSync } = await import("node:sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  // Two relayd processes on one data dir is normal (`relayd devices revoke`,
  // `relayd pair`, the daemon). Without a busy timeout the loser of a write
  // race fails immediately with SQLITE_BUSY — which reached an unauthenticated
  // pairing caller as {"error":"database is locked"}. Wait for the writer
  // instead; the writes here are single-row and finish in microseconds.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SQLITE_SCHEMA);
  return db;
}

function pairingSessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code,
    token: row.token,
    nodeId: row.node_id,
    nodeName: row.node_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function deviceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    certSerial: row.cert_serial,
    certSubject: row.cert_subject,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revoked: Boolean(row.revoked),
    revokedAt: row.revoked_at,
  };
}

function createSqliteStore(db) {
  const upsertJob = db.prepare(`
    INSERT INTO jobs (id, status, provider, workspace_id, session_id, created_at, updated_at, record)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status, provider = excluded.provider,
      workspace_id = excluded.workspace_id, session_id = excluded.session_id,
      created_at = excluded.created_at, updated_at = excluded.updated_at,
      record = excluded.record
  `);
  const upsertThread = db.prepare(`
    INSERT INTO threads (id, mode, provider, workspace_id, updated_at, last_job_id)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      mode = excluded.mode, provider = excluded.provider,
      workspace_id = excluded.workspace_id, updated_at = excluded.updated_at,
      last_job_id = excluded.last_job_id
  `);
  const upsertChat = db.prepare(`
    INSERT INTO chats (id, provider, workspace_id, created_at, updated_at, record)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      provider = excluded.provider, workspace_id = excluded.workspace_id,
      created_at = excluded.created_at, updated_at = excluded.updated_at,
      record = excluded.record
  `);
  const insertEvent = db.prepare("INSERT INTO events (name, ts, data) VALUES (?, ?, ?)");
  const upsertDevice = db.prepare(`
    INSERT INTO devices (id, name, platform, cert_serial, cert_subject, created_at, last_seen_at, revoked, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name, platform = excluded.platform,
      cert_serial = excluded.cert_serial, cert_subject = excluded.cert_subject,
      created_at = excluded.created_at, last_seen_at = excluded.last_seen_at,
      revoked = excluded.revoked, revoked_at = excluded.revoked_at
  `);
  const upsertRevocation = db.prepare(`
    INSERT INTO revocations (serial, device_id, revoked_at)
    VALUES (?, ?, ?)
    ON CONFLICT(serial) DO UPDATE SET
      device_id = excluded.device_id, revoked_at = excluded.revoked_at
  `);
  const insertPairingSession = db.prepare(`
    INSERT INTO pairing_sessions (id, code, token, node_id, node_name, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const saveHandoffStatement = db.prepare(
    `INSERT INTO handoffs (id, state, repo, branch, created_at, updated_at, record)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state, repo = excluded.repo, branch = excluded.branch,
       updated_at = excluded.updated_at, record = excluded.record`,
  );

  return {
    kind: "sqlite",
    db,

    saveJob(job) {
      assertSafeRecordId(job.id);
      upsertJob.run(
        job.id,
        job.status ?? null,
        job.provider ?? null,
        job.workspaceId ?? null,
        job.sessionId ?? null,
        job.createdAt ?? null,
        job.updatedAt ?? null,
        JSON.stringify(job),
      );
      const threadId = job.sessionId || job.resumeSessionId;
      if (typeof threadId === "string" && threadId) {
        upsertThread.run(threadId, "task", job.provider ?? null, job.workspaceId ?? null, job.updatedAt ?? null, job.id);
      }
    },

    loadJobRecords() {
      const rows = db.prepare("SELECT id, record FROM jobs ORDER BY id").all();
      const records = [];
      for (const row of rows) {
        try {
          records.push({ sourceId: row.id, job: JSON.parse(row.record) });
        } catch (error) {
          appendAudit("load_job_failed", { id: row.id, status: "unknown" }, { error: error.message });
        }
      }
      return records;
    },

    deleteJob(id) {
      try {
        assertSafeRecordId(id);
      } catch {
        return false;
      }
      return db.prepare("DELETE FROM jobs WHERE id = ?").run(id).changes > 0;
    },

    saveChatThread(thread) {
      assertSafeRecordId(thread.id);
      upsertChat.run(
        thread.id,
        thread.provider ?? null,
        thread.workspaceId ?? null,
        thread.createdAt ?? null,
        thread.updatedAt ?? null,
        JSON.stringify(thread),
      );
      upsertThread.run(thread.id, "chat", thread.provider ?? null, thread.workspaceId ?? null, thread.updatedAt ?? null, null);
    },

    readChatThreadRecord(threadId) {
      try {
        assertSafeRecordId(threadId);
      } catch {
        return null;
      }
      const row = db.prepare("SELECT record FROM chats WHERE id = ?").get(threadId);
      if (!row) return null;
      try {
        return JSON.parse(row.record);
      } catch {
        return null;
      }
    },

    listChatThreadIds() {
      return db.prepare("SELECT id FROM chats ORDER BY id").all().map((row) => row.id);
    },

    deleteChatThread(threadId) {
      try {
        assertSafeRecordId(threadId);
      } catch {
        return false;
      }
      db.prepare("DELETE FROM threads WHERE id = ? AND mode = 'chat'").run(threadId);
      return db.prepare("DELETE FROM chats WHERE id = ?").run(threadId).changes > 0;
    },

    appendEvent(event) {
      const result = insertEvent.run(event.name, event.ts || nowIso(), JSON.stringify(event.data ?? {}));
      return Number(result.lastInsertRowid);
    },

    listEvents({ sinceId = 0, limit = 1000 } = {}) {
      return db
        .prepare("SELECT id, name, ts, data FROM events WHERE id > ? ORDER BY id LIMIT ?")
        .all(sinceId, limit)
        .map((row) => ({ id: Number(row.id), name: row.name, ts: row.ts, data: JSON.parse(row.data) }));
    },

    lastEventId() {
      const row = db.prepare("SELECT MAX(id) AS maxId FROM events").get();
      return Number(row?.maxId || 0);
    },

    pruneEvents(keepCount) {
      db.prepare(
        "DELETE FROM events WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM events) - ?",
      ).run(keepCount);
    },

    saveDevice(device) {
      assertSafeRecordId(device.id);
      upsertDevice.run(
        device.id,
        device.name ?? null,
        device.platform ?? null,
        device.certSerial ?? null,
        device.certSubject ?? null,
        device.createdAt ?? null,
        device.lastSeenAt ?? null,
        device.revoked ? 1 : 0,
        device.revokedAt ?? null,
      );
    },

    getDevice(id) {
      try {
        assertSafeRecordId(id);
      } catch {
        return null;
      }
      return deviceFromRow(db.prepare("SELECT * FROM devices WHERE id = ?").get(id));
    },

    listDevices() {
      return db.prepare("SELECT * FROM devices ORDER BY created_at").all().map(deviceFromRow);
    },

    addRevocation(revocation) {
      upsertRevocation.run(revocation.serial, revocation.deviceId ?? null, revocation.revokedAt ?? nowIso());
    },

    listRevocations() {
      return db
        .prepare("SELECT serial, device_id, revoked_at FROM revocations ORDER BY revoked_at")
        .all()
        .map((row) => ({ serial: row.serial, deviceId: row.device_id, revokedAt: row.revoked_at }));
    },

    // ── pairing sessions (see the header note on cross-process atomicity) ──

    savePairingSession(session) {
      assertSafeRecordId(session.id);
      insertPairingSession.run(
        session.id,
        session.code,
        session.token,
        session.nodeId ?? null,
        session.nodeName ?? null,
        session.createdAt ?? null,
        session.expiresAt,
      );
    },

    listPairingSessions() {
      return db
        .prepare("SELECT * FROM pairing_sessions ORDER BY created_at")
        .all()
        .map(pairingSessionFromRow);
    },

    // ATOMIC CLAIM: the DELETE runs inside SQLite's exclusive write
    // transaction, so of N racing processes exactly one observes changes === 1
    // and the rest see 0. This is the same guarantee the JSON backend gets from
    // O_EXCL — the two backends are interchangeable for single-use pairing.
    consumePairingSession(id) {
      try {
        assertSafeRecordId(id);
      } catch {
        return false;
      }
      return db.prepare("DELETE FROM pairing_sessions WHERE id = ?").run(id).changes > 0;
    },

    prunePairingSessions(nowMs = Date.now()) {
      const cutoff = new Date(nowMs).toISOString();
      return Number(
        db.prepare("DELETE FROM pairing_sessions WHERE expires_at <= ?").run(cutoff).changes,
      );
    },

    // ── handoffs (laptop -> cloud sandbox session handoff records) ──

    saveHandoff(handoff) {
      assertSafeRecordId(handoff.id);
      saveHandoffStatement.run(handoff.id, handoff.state, handoff.repo, handoff.branch,
        handoff.createdAt, handoff.updatedAt, JSON.stringify(handoff));
    },

    getHandoff(id) {
      assertSafeRecordId(id);
      const row = db.prepare("SELECT record FROM handoffs WHERE id = ?").get(id);
      return row ? JSON.parse(row.record) : null;
    },

    listHandoffs() {
      return db.prepare("SELECT record FROM handoffs ORDER BY created_at DESC")
        .all().map((row) => JSON.parse(row.record));
    },

    close() {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory + migration
// ---------------------------------------------------------------------------

async function createStore(kind, options = {}) {
  if (kind === "json" || kind === undefined || kind === "") {
    return createJsonStore({
      jobsDir: options.jobsDir || jobsDir,
      chatsDir: options.chatsDir || chatsDir,
      dataDir: options.dataDir || dataDir,
      pairingDir: options.pairingDir || (options.dataDir ? path.join(options.dataDir, "pairing") : pairingDir),
    });
  }
  if (kind === "sqlite") {
    const dbPath = options.dbPath || process.env.RELAYD_SQLITE_PATH || path.join(options.dataDir || dataDir, "relayd.sqlite");
    return createSqliteStore(await openSqlite(dbPath));
  }
  throw new Error("RELAYD_STORE must be json or sqlite");
}

// Migrates an existing JSON data dir into a SQLite store. Logs, attachments
// and artifacts are not moved — they stay on disk and job records keep
// pointing at them. Returns per-table counts.
async function migrateJsonToSqlite({ dataDir: dataRoot, dbPath }) {
  const sourceJobsDir = path.join(dataRoot, "jobs");
  const sourceChatsDir = path.join(dataRoot, "chats");
  const source = createJsonStore({ jobsDir: sourceJobsDir, chatsDir: sourceChatsDir, dataDir: dataRoot });
  const target = await createStore("sqlite", { dataDir: dataRoot, dbPath });

  const counts = { jobs: 0, chats: 0, devices: 0, revocations: 0, handoffs: 0 };
  for (const { job } of source.loadJobRecords()) {
    if (!job || typeof job.id !== "string") continue;
    try {
      target.saveJob(job);
      counts.jobs += 1;
    } catch {
      // Skip malformed record ids; everything valid migrates.
    }
  }
  for (const threadId of source.listChatThreadIds()) {
    const thread = source.readChatThreadRecord(threadId);
    if (!thread || thread.id !== threadId) continue;
    try {
      target.saveChatThread(thread);
      counts.chats += 1;
    } catch {
      // Skip malformed record ids.
    }
  }
  for (const device of source.listDevices()) {
    if (!device || typeof device.id !== "string") continue;
    try {
      target.saveDevice(device);
      counts.devices += 1;
    } catch {
      // Skip malformed record ids.
    }
  }
  for (const revocation of source.listRevocations()) {
    if (!revocation || typeof revocation.serial !== "string") continue;
    target.addRevocation(revocation);
    counts.revocations += 1;
  }
  for (const handoff of source.listHandoffs()) {
    target.saveHandoff(handoff);
    counts.handoffs += 1;
  }
  return { counts, store: target };
}

const storeKind = (process.env.RELAYD_STORE || "json").trim().toLowerCase();
const store = await createStore(storeKind);

export { store, storeKind, createStore, migrateJsonToSqlite };
