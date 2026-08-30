// Separate atomic records for hosted device bearers. Never replace the legacy
// bearer hash; adding one phone must not sign another out. SQLite transactions
// also make prepared responses durable across crashes and concurrent workers.
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_DEVICES = 32;
const MAX_PENDING = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createHostedDeviceStore({ hashFile, now = Date.now }) {
  if (!hashFile || !path.isAbsolute(hashFile)) throw new Error("hosted_device_store_unconfigured");
  const dir = `${hashFile}.devices`;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error("hosted_device_store_unsafe");
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, "devices.sqlite");
  for (const candidate of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("hosted_device_store_unsafe");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  fs.closeSync(fd);
  fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS devices (
      device_id TEXT PRIMARY KEY, pairing_id TEXT UNIQUE NOT NULL,
      token_hash TEXT UNIQUE NOT NULL, cert_serial TEXT NOT NULL, not_after INTEGER NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS legacy_bindings (token_hash TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS initial_pairings (
      pairing_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, prepared TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pairings (
      pairing_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, expires_at INTEGER NOT NULL,
      phase TEXT NOT NULL, prepared TEXT, owner TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    );`);

  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  function claim(pairingId, fingerprint, expiresAt) {
    if (!UUID.test(pairingId) || !Number.isSafeInteger(expiresAt) || expiresAt <= now()) throw new Error("hosted_pairing_expired");
    return transaction(() => {
      db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(now());
      db.prepare("DELETE FROM devices WHERE not_after <= ? OR disabled=1").run(now());
      let row = db.prepare("SELECT * FROM pairings WHERE pairing_id = ?").get(pairingId);
      if (row && (row.fingerprint !== fingerprint || row.expires_at !== expiresAt)) throw new Error("hosted_pairing_conflict");
      if (row?.phase === "active") return { active: true };
      if (row?.lease_until > now()) return null;
      if (!row) {
        const pending = db.prepare("SELECT count(*) AS n FROM pairings WHERE phase != 'active'").get().n;
        const devices = db.prepare("SELECT count(*) AS n FROM devices").get().n;
        const initialPending = db.prepare(`SELECT count(*) AS n FROM initial_pairings
          WHERE completed=0 AND expires_at>? AND pairing_id NOT IN (SELECT pairing_id FROM devices)`).get(now()).n;
        if (pending >= MAX_PENDING || devices + pending + initialPending >= MAX_DEVICES) throw new Error("hosted_device_limit");
        db.prepare("INSERT INTO pairings(pairing_id,fingerprint,expires_at,phase) VALUES (?,?,?,'preparing')")
          .run(pairingId, fingerprint, expiresAt);
      }
      const owner = crypto.randomUUID();
      db.prepare("UPDATE pairings SET owner=?, lease_until=? WHERE pairing_id=?")
        .run(owner, Math.min(expiresAt, now() + 30_000), pairingId);
      return { owner, prepared: row?.prepared ? JSON.parse(row.prepared) : null };
    });
  }
  function savePrepared(pairingId, owner, prepared) {
    const changed = db.prepare(`UPDATE pairings SET phase='prepared',prepared=?
      WHERE pairing_id=? AND owner=? AND expires_at>? AND phase='preparing'`)
      .run(JSON.stringify(prepared), pairingId, owner, now()).changes;
    if (changed !== 1) throw new Error("hosted_pairing_claim_lost");
  }
  function insertDevice(pairingId, prepared) {
    if (!UUID.test(prepared.deviceId) || !/^[a-f0-9]{64}$/.test(prepared.tokenHash) ||
        !/^[A-F0-9]+$/.test(prepared.certSerial) || !Number.isSafeInteger(prepared.notAfter) || prepared.notAfter <= now()) {
      throw new Error("hosted_device_invalid");
    }
    db.prepare(`INSERT INTO devices(device_id,pairing_id,token_hash,cert_serial,not_after)
      VALUES (?,?,?,?,?) ON CONFLICT(pairing_id) DO NOTHING`)
      .run(prepared.deviceId, pairingId, prepared.tokenHash, prepared.certSerial, prepared.notAfter);
  }
  function activate(pairingId, owner) {
    transaction(() => {
      const row = db.prepare("SELECT * FROM pairings WHERE pairing_id=? AND owner=? AND expires_at>?")
        .get(pairingId, owner, now());
      if (!row || row.phase !== "prepared") throw new Error("hosted_pairing_claim_lost");
      insertDevice(pairingId, JSON.parse(row.prepared));
      db.prepare("UPDATE pairings SET phase='active',prepared=NULL,owner=NULL,lease_until=0 WHERE pairing_id=?").run(pairingId);
    });
  }
  function addInitial(pairingId, prepared) {
    transaction(() => {
      const active = db.prepare("SELECT count(*) AS n FROM devices WHERE not_after>? AND disabled=0").get(now()).n;
      const pending = db.prepare("SELECT count(*) AS n FROM pairings WHERE phase!='active' AND expires_at>?").get(now()).n;
      const otherInitial = db.prepare(`SELECT count(*) AS n FROM initial_pairings
        WHERE completed=0 AND expires_at>? AND pairing_id!=? AND pairing_id NOT IN (SELECT pairing_id FROM devices)`)
        .get(now(), pairingId).n;
      if (!db.prepare("SELECT 1 FROM devices WHERE pairing_id=?").get(pairingId) &&
          active + pending + otherInitial >= MAX_DEVICES) throw new Error("hosted_device_limit");
      insertDevice(pairingId, prepared);
      // Permanent denial tombstone: after its device row expires/is revoked
      // and is collected, this managed bearer must NEVER fall back to the
      // pre-migration single-hash credential path.
      db.prepare("INSERT OR IGNORE INTO legacy_bindings(token_hash) VALUES (?)").run(prepared.tokenHash);
    });
  }
  function initial(pairingId, fingerprint) {
    const row = db.prepare("SELECT * FROM initial_pairings WHERE pairing_id=?").get(pairingId);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new Error("hosted_pairing_conflict");
    if (!row.completed && row.expires_at <= now()) {
      // Leave a denial marker, never mint a different cert for a spent initial
      // rendezvous. Its private response is no longer useful after the TTL.
      db.prepare("UPDATE initial_pairings SET prepared='{}' WHERE pairing_id=?").run(pairingId);
      throw new Error("hosted_pairing_expired");
    }
    return { completed: Boolean(row.completed), prepared: JSON.parse(row.prepared) };
  }
  function saveInitial(pairingId, fingerprint, prepared) {
    if (!UUID.test(pairingId)) throw new Error("hosted_pairing_invalid");
    db.prepare(`INSERT OR IGNORE INTO initial_pairings(pairing_id,fingerprint,prepared,expires_at)
      VALUES (?,?,?,?)`).run(pairingId, fingerprint, JSON.stringify(prepared), now() + 900_000);
    return initial(pairingId, fingerprint);
  }
  function finishInitial(pairingId) {
    transaction(() => {
      const row = db.prepare("SELECT prepared FROM initial_pairings WHERE pairing_id=?").get(pairingId);
      if (!row) throw new Error("hosted_pairing_invalid");
      const { p12, tag, ...metadata } = JSON.parse(row.prepared);
      db.prepare("UPDATE initial_pairings SET completed=1,prepared=? WHERE pairing_id=?").run(JSON.stringify(metadata), pairingId);
    });
  }
  function find(tokenHash) {
    const row = db.prepare("SELECT * FROM devices WHERE token_hash=?").get(tokenHash);
    return row ? { deviceId: row.device_id, certSerial: row.cert_serial, notAfter: row.not_after, disabled: Boolean(row.disabled) } : null;
  }
  function reclaimRevoked(isRevoked) {
    transaction(() => {
      for (const row of db.prepare("SELECT cert_serial FROM devices WHERE disabled=0").all()) {
        if (isRevoked(row.cert_serial)) db.prepare("UPDATE devices SET disabled=1 WHERE cert_serial=?").run(row.cert_serial);
      }
    });
  }
  const wasRegisteredLegacy = (hash) => Boolean(db.prepare("SELECT 1 FROM legacy_bindings WHERE token_hash=?").get(hash));
  function release(pairingId, owner) {
    db.prepare("UPDATE pairings SET owner=NULL,lease_until=0 WHERE pairing_id=? AND owner=?").run(pairingId, owner);
  }
  return { claim, savePrepared, activate, addInitial, initial, saveInitial, finishInitial,
    find, reclaimRevoked, wasRegisteredLegacy, release, close: () => db.close() };
}

const stores = new Map();
export function hostedDeviceStore(hashFile = process.env.RELAYD_DEVICE_TOKEN_HASH_FILE) {
  if (!hashFile) return null;
  if (!stores.has(hashFile)) stores.set(hashFile, createHostedDeviceStore({ hashFile }));
  return stores.get(hashFile);
}
