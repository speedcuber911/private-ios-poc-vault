// device-tokens.mjs — the node's table of PAIRED DEVICE BEARER TOKENS.
//
// A phone that completed pairing authenticates every later request with a
// bearer token derived from the single-use pairing secret (label
// "relay-device-token-v1"). Only sha256(token) is stored here, so a reader of
// this file cannot authenticate as the device.
//
// There is nothing hosted-specific about it — a QR-paired BYO machine and a
// managed machine record a device the same way. Records are per-device and
// atomic on purpose: pairing a second phone must never sign the first one out,
// which is exactly what a single shared hash file did.
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

import { dataDir } from "./config.mjs";

const MAX_DEVICES = 32;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Where the sqlite file lives. Legacy single-hash installs keep it beside the
// hash file they were provisioned with; a BYO node keeps it in its data dir.
function deviceTokenStoreDir(hashFile = process.env.RELAYD_DEVICE_TOKEN_HASH_FILE) {
  if (hashFile) {
    if (!path.isAbsolute(hashFile)) throw new Error("device_token_store_unconfigured");
    return `${hashFile}.devices`;
  }
  return path.join(dataDir, "device-tokens");
}

export function createDeviceTokenStore({ dir, hashFile, now = Date.now } = {}) {
  const storeDir = dir || deviceTokenStoreDir(hashFile);
  if (!path.isAbsolute(storeDir)) throw new Error("device_token_store_unconfigured");
  fs.mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(storeDir).isDirectory() || fs.lstatSync(storeDir).isSymbolicLink()) {
    throw new Error("device_token_store_unsafe");
  }
  fs.chmodSync(storeDir, 0o700);
  const file = path.join(storeDir, "devices.sqlite");
  // A symlink or a hard link here would let a less-privileged writer aim the
  // database — and its bearer hashes — somewhere else.
  for (const candidate of [file, `${file}-journal`, `${file}-wal`, `${file}-shm`]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("device_token_store_unsafe");
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
    CREATE TABLE IF NOT EXISTS legacy_bindings (token_hash TEXT PRIMARY KEY);`);

  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  function assertRecord(record) {
    if (
      !UUID.test(String(record?.pairingId || "")) ||
      !UUID.test(String(record?.deviceId || "")) ||
      !/^[a-f0-9]{64}$/.test(String(record?.tokenHash || "")) ||
      !/^[A-F0-9]+$/.test(String(record?.certSerial || "")) ||
      !Number.isSafeInteger(record?.notAfter) ||
      record.notAfter <= now()
    ) {
      throw new Error("device_token_invalid");
    }
  }

  // Records one paired device. Idempotent per pairing id, so a retried pairing
  // exchange cannot double-count against the device budget.
  function registerDevice({ pairingId, deviceId, tokenHash, certSerial, notAfter }) {
    assertRecord({ pairingId, deviceId, tokenHash, certSerial, notAfter });
    return transaction(() => {
      db.prepare("DELETE FROM devices WHERE not_after <= ? OR disabled=1").run(now());
      const existing = db.prepare("SELECT 1 FROM devices WHERE pairing_id=?").get(pairingId);
      if (!existing) {
        const active = db.prepare("SELECT count(*) AS n FROM devices").get().n;
        if (active >= MAX_DEVICES) throw new Error("device_token_limit");
      }
      db.prepare(`INSERT INTO devices(device_id,pairing_id,token_hash,cert_serial,not_after)
        VALUES (?,?,?,?,?) ON CONFLICT(pairing_id) DO NOTHING`)
        .run(deviceId, pairingId, tokenHash, certSerial, notAfter);
      // Permanent denial tombstone: once a token is a per-device credential it
      // must NEVER fall back to the pre-migration single-hash path, not even
      // after its device row expires or is revoked and collected.
      db.prepare("INSERT OR IGNORE INTO legacy_bindings(token_hash) VALUES (?)").run(tokenHash);
      return { deviceId, pairingId };
    });
  }

  function find(tokenHash) {
    const row = db.prepare("SELECT * FROM devices WHERE token_hash=?").get(tokenHash);
    return row
      ? { deviceId: row.device_id, certSerial: row.cert_serial, notAfter: row.not_after, disabled: Boolean(row.disabled) }
      : null;
  }

  function list() {
    return db.prepare("SELECT * FROM devices ORDER BY not_after").all().map((row) => ({
      deviceId: row.device_id,
      certSerial: row.cert_serial,
      notAfter: row.not_after,
      disabled: Boolean(row.disabled),
    }));
  }

  // Revoking a device certificate must also kill its bearer token; the two are
  // one credential handed over in one pairing exchange.
  function reclaimRevoked(isRevoked) {
    transaction(() => {
      for (const row of db.prepare("SELECT cert_serial FROM devices WHERE disabled=0").all()) {
        if (isRevoked(row.cert_serial)) db.prepare("UPDATE devices SET disabled=1 WHERE cert_serial=?").run(row.cert_serial);
      }
    });
  }

  const wasRegisteredLegacy = (hash) => Boolean(db.prepare("SELECT 1 FROM legacy_bindings WHERE token_hash=?").get(hash));

  return { registerDevice, find, list, reclaimRevoked, wasRegisteredLegacy, dir: storeDir, close: () => db.close() };
}

const stores = new Map();

// One store per on-disk location, opened lazily: the daemon starts long before
// any device is paired, and an unpaired node should not create the database
// until it has something to put in it.
export function deviceTokenStore(hashFile = process.env.RELAYD_DEVICE_TOKEN_HASH_FILE) {
  const storeDir = deviceTokenStoreDir(hashFile);
  if (!stores.has(storeDir)) stores.set(storeDir, createDeviceTokenStore({ dir: storeDir }));
  return stores.get(storeDir);
}

export { MAX_DEVICES, deviceTokenStoreDir };
