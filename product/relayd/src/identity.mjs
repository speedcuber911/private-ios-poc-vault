// relayd identity.mjs — W2-MODULES: node identity + node CA + device certs.
//
// Trust model (04-product-plan §4.3): the node owns a private CA; devices
// mint their own keys and send a CSR through pairing; the node issues the
// device cert; private keys never transit the API. The node also has an
// Ed25519 identity keypair used only for tunnel-broker challenge auth.
//
// X.509 signing in pure Node is impractical, so certificate operations
// shell out to the system `openssl` binary (present on macOS/Linux; its
// availability is verified at runtime). All key material lives under a
// 0700 identityDir with 0600 keys. Nothing in this module ever returns or
// logs private key bytes except the documented PEM file paths.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dataDir } from "./config.mjs";
import { appendAudit } from "./audit.mjs";
import { nowIso } from "./util.mjs";
import { store } from "./store.mjs";
import { generateEncKeyPair } from "./seal.mjs";

const identityDir = process.env.RELAYD_IDENTITY_DIR || path.join(dataDir, "identity");

const nodeNameEnv = (process.env.RELAYD_NODE_NAME || "").trim();

const deviceCertDays = 825;

const caCertDays = 3650;

function opensslVersion() {
  try {
    return execFileSync("openssl", ["version"], { encoding: "utf8", timeout: 10000 }).trim();
  } catch {
    return null;
  }
}

function requireOpenssl() {
  const version = opensslVersion();
  if (!version) {
    throw Object.assign(new Error("openssl binary is required for certificate operations"), { status: 503 });
  }
  return version;
}

function runOpenssl(args, { input = null } = {}) {
  return execFileSync("openssl", args, {
    encoding: "utf8",
    input: input === null ? undefined : input,
    timeout: 30000,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function identityPaths(baseDir = identityDir) {
  return {
    baseDir,
    nodeIdPath: path.join(baseDir, "node-id"),
    nodeNamePath: path.join(baseDir, "node-name"),
    identityKeyPath: path.join(baseDir, "node-identity.key.pem"),
    identityPubPath: path.join(baseDir, "node-identity.pub.pem"),
    encKeyPath: path.join(baseDir, "node-enc.key.pem"),
    encPubPath: path.join(baseDir, "node-enc.pub.b64"),
    caDir: path.join(baseDir, "ca"),
    caKeyPath: path.join(baseDir, "ca", "ca.key.pem"),
    caCertPath: path.join(baseDir, "ca", "ca.cert.pem"),
    serverDir: path.join(baseDir, "server"),
    issuedDir: path.join(baseDir, "issued"),
    tmpDir: path.join(baseDir, "tmp"),
    revokedSerialsPath: path.join(baseDir, "revoked-serials.txt"),
  };
}

function mkdirPrivate(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

// --- Encryption keypair: generation must be atomic and race-safe -------
//
// The X25519 keypair (encKeyPath/encPubPath) is how the laptop CLI seals a
// handoff transcript so only this node can read it, and the CLI pins the
// public key's fingerprint per repo on first use. A key that silently
// changes is not a nuisance: it permanently breaks already-sealed handoffs
// and makes the user's fingerprint comparison fail for a legitimate
// reason, training them to ignore it. So, unlike the ed25519/CA material
// below, this pair is never regenerated except from a genuinely fresh
// (both files absent) state — anything else (half-present, corrupt,
// mismatched) is a hard error that refuses to proceed.
//
// Generation is also made atomic across OS processes: two processes
// calling initIdentity on the same fresh baseDir (daemon start racing
// `relayd enroll`) must never be able to pair a private key from one
// generation with a public key from another. The lock below is the same
// exclusive-create ("wx") test-and-act primitive store.mjs already uses
// for pairing-session claims: of N racing creators exactly one gets the
// file, the rest get EEXIST — and here, the rest block until the winner
// is done and then adopt whatever it published instead of generating
// their own.

const ENC_KEY_LOCK_TIMEOUT_MS = 5000;
const ENC_KEY_LOCK_POLL_MS = 20;

function encKeyLockPath(paths) {
  return path.join(paths.baseDir, ".node-enc.lock");
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Runs `fn` while holding an exclusive, cross-process lock on the
// encryption-key files for this identity dir. A process that loses the
// race to acquire the lock blocks (briefly, synchronously — this module is
// synchronous throughout) until the winner releases it.
function withEncKeyLock(paths, fn) {
  const lockPath = encKeyLockPath(paths);
  const deadline = Date.now() + ENC_KEY_LOCK_TIMEOUT_MS;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() > deadline) {
        throw Object.assign(
          new Error(
            `timed out after ${ENC_KEY_LOCK_TIMEOUT_MS}ms waiting for the encryption-key lock at ${lockPath}. ` +
              `Another relayd process may be initializing identity, or a previous run crashed while holding it. ` +
              `If no relayd process is running, delete ${lockPath} and retry.`,
          ),
          { status: 500 },
        );
      }
      sleepSync(ENC_KEY_LOCK_POLL_MS);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lockPath, { force: true });
  }
}

function isValidEncPrivateKeyPem(pem) {
  if (typeof pem !== "string" || !pem.trim()) return false;
  try {
    return crypto.createPrivateKey(pem).asymmetricKeyType === "x25519";
  } catch {
    return false;
  }
}

function isValidEncPublicKeyB64(b64) {
  if (typeof b64 !== "string" || !b64) return false;
  const raw = Buffer.from(b64, "base64");
  // Canonical check mirrors seal.mjs's sealTo(): the only acceptable
  // encoding is the exact base64 a 32-byte buffer round-trips to.
  return raw.length === 32 && raw.toString("base64") === b64;
}

// Derives the raw 32-byte X25519 public key that corresponds to a private
// key PEM, so a stored pair can be checked for correspondence rather than
// "both individually parse". Returns null if pem isn't a valid x25519
// private key.
function encPublicRawFromPrivatePem(pem) {
  try {
    const key = crypto.createPrivateKey(pem);
    if (key.asymmetricKeyType !== "x25519") return null;
    const jwk = key.export({ format: "jwk" });
    if (typeof jwk?.x !== "string") return null;
    return Buffer.from(jwk.x, "base64url");
  } catch {
    return null;
  }
}

function readFileOrNull(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// Classifies the on-disk encryption-keypair state. `existsSync` alone is
// not a validity check (a 0-byte or garbage file "exists" forever), so
// this parses the key material and checks the two files correspond to the
// same keypair, not just that both happen to be present.
function encKeyPairState(paths) {
  const keyExists = fs.existsSync(paths.encKeyPath);
  const pubExists = fs.existsSync(paths.encPubPath);

  if (!keyExists && !pubExists) return { kind: "absent" };

  if (keyExists !== pubExists) {
    return {
      kind: "partial",
      presentPath: keyExists ? paths.encKeyPath : paths.encPubPath,
      missingPath: keyExists ? paths.encPubPath : paths.encKeyPath,
    };
  }

  const pem = readFileOrNull(paths.encKeyPath);
  const b64raw = readFileOrNull(paths.encPubPath);
  const b64 = typeof b64raw === "string" ? b64raw.trim() : b64raw;

  const privValid = isValidEncPrivateKeyPem(pem);
  const pubValid = isValidEncPublicKeyB64(b64);
  if (!privValid || !pubValid) {
    return { kind: "corrupt", privValid, pubValid };
  }

  const derived = encPublicRawFromPrivatePem(pem);
  const stored = Buffer.from(b64, "base64");
  if (!derived || !derived.equals(stored)) {
    return { kind: "mismatched" };
  }

  return { kind: "valid" };
}

// Refuses to proceed on anything short of a genuinely fresh (both files
// absent) or a genuinely healthy (both present, valid, matching) state.
// "Regenerate and hope" is exactly what silently destroyed already-sealed
// handoffs — a half-present or corrupt pair must stop the operator, not
// get papered over. Never includes key bytes.
function throwEncKeyStateError(paths, state) {
  const keyPath = paths.encKeyPath;
  const pubPath = paths.encPubPath;
  const recovery =
    `To resolve: restore the missing/corrupt file(s) from backup so the pair matches again, or — ` +
    `only if the original keypair is truly unrecoverable — delete BOTH ${keyPath} and ${pubPath} and ` +
    `re-run so a brand-new pair is generated. Deleting and regenerating permanently breaks decryption ` +
    `of anything already sealed to the old public key (including handoffs already distributed to devices), ` +
    `so only do this as a last resort.`;

  let detail;
  if (state.kind === "partial") {
    detail = `encryption keypair is half-present: ${state.presentPath} exists but ${state.missingPath} is missing.`;
  } else if (state.kind === "corrupt") {
    const bad = [];
    if (!state.privValid) bad.push(keyPath);
    if (!state.pubValid) bad.push(pubPath);
    detail = `encryption key file(s) present but do not parse as valid key material: ${bad.join(", ")}.`;
  } else {
    detail =
      `encryption keypair is inconsistent: the public key in ${pubPath} does not correspond to the ` +
      `private key in ${keyPath} (looks like two different generations were paired together).`;
  }

  throw Object.assign(new Error(`refusing to touch the encryption keypair — ${detail} ${recovery}`), {
    status: 500,
    code: `enc_keypair_${state.kind}`,
  });
}

// Idempotent + atomic + race-safe: on a fresh pair, generates into
// uniquely-named temp files (created with the correct mode) and publishes
// with rename (atomic on the same filesystem, guaranteed by keeping the
// temp files in baseDir alongside their destinations). A process that
// loses the race for the lock blocks until the winner is done, then
// re-checks and adopts whatever the winner published instead of
// generating its own — a mismatched pair is impossible, not just unlikely.
function ensureEncKeyPair(paths) {
  const state = encKeyPairState(paths);
  if (state.kind === "valid") {
    // Pre-existing key material that predates this guard (or a manual
    // restore) may not be 0600 yet — correct it every time, same as the
    // ed25519/CA key material below.
    fs.chmodSync(paths.encKeyPath, 0o600);
    fs.chmodSync(paths.encPubPath, 0o600);
    return;
  }
  if (state.kind !== "absent") {
    throwEncKeyStateError(paths, state);
  }

  withEncKeyLock(paths, () => {
    // Re-check under the lock: another process may have finished
    // generating (and released the lock) while we were waiting, or may
    // have left a broken pair behind.
    const current = encKeyPairState(paths);
    if (current.kind === "valid") {
      fs.chmodSync(paths.encKeyPath, 0o600);
      fs.chmodSync(paths.encPubPath, 0o600);
      return;
    }
    if (current.kind !== "absent") {
      throwEncKeyStateError(paths, current);
    }

    const encryption = generateEncKeyPair();
    const suffix = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
    const tmpKeyPath = `${paths.encKeyPath}.tmp-${suffix}`;
    const tmpPubPath = `${paths.encPubPath}.tmp-${suffix}`;
    try {
      writePrivate(tmpKeyPath, encryption.privateKeyPem);
      writePrivate(tmpPubPath, `${encryption.publicKeyB64}\n`);
      // Same-directory renames are atomic on the same filesystem; the tmp
      // files live next to their destinations for exactly that reason.
      fs.renameSync(tmpKeyPath, paths.encKeyPath);
      fs.renameSync(tmpPubPath, paths.encPubPath);
    } finally {
      fs.rmSync(tmpKeyPath, { force: true });
      fs.rmSync(tmpPubPath, { force: true });
    }
  });
}

// Idempotent: creates whatever is missing, never regenerates existing
// material. Returns a status summary (no key bytes).
function initIdentity({ baseDir = identityDir } = {}) {
  requireOpenssl();
  const paths = identityPaths(baseDir);
  mkdirPrivate(paths.baseDir);
  mkdirPrivate(paths.caDir);
  mkdirPrivate(paths.serverDir);
  mkdirPrivate(paths.issuedDir);
  mkdirPrivate(paths.tmpDir);

  if (!fs.existsSync(paths.nodeIdPath)) {
    // Unguessable node id (rendezvous/SNI label); lowercase hex, DNS-safe.
    writePrivate(paths.nodeIdPath, `node-${crypto.randomBytes(8).toString("hex")}\n`);
  }
  if (!fs.existsSync(paths.nodeNamePath)) {
    writePrivate(paths.nodeNamePath, `${nodeNameEnv || os.hostname() || "relay-node"}\n`);
  }

  if (!fs.existsSync(paths.identityKeyPath)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    writePrivate(paths.identityKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));
    writePrivate(paths.identityPubPath, publicKey.export({ type: "spki", format: "pem" }));
  }

  ensureEncKeyPair(paths);

  const nodeId = readNodeId(paths);
  if (!fs.existsSync(paths.caKeyPath)) {
    runOpenssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", paths.caKeyPath]);
    fs.chmodSync(paths.caKeyPath, 0o600);
  }
  if (!fs.existsSync(paths.caCertPath)) {
    runOpenssl([
      "req", "-x509", "-new",
      "-key", paths.caKeyPath,
      "-sha256",
      "-days", String(caCertDays),
      "-subj", `/CN=Relay Node CA ${nodeId}`,
      "-out", paths.caCertPath,
    ]);
    fs.chmodSync(paths.caCertPath, 0o600);
  }
  if (!fs.existsSync(paths.revokedSerialsPath)) {
    writePrivate(paths.revokedSerialsPath, "");
  }

  return identityStatus({ baseDir });
}

function readNodeId(paths = identityPaths()) {
  try {
    return fs.readFileSync(paths.nodeIdPath, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function readNodeName(paths = identityPaths()) {
  try {
    return fs.readFileSync(paths.nodeNamePath, "utf8").trim() || null;
  } catch {
    return nodeNameEnv || null;
  }
}

function readEncPublicKeyB64(paths = identityPaths()) {
  const value = readFileOrNull(paths.encPubPath);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isValidEncPublicKeyB64(trimmed) ? trimmed : null;
}

function readEncPrivateKeyPem(paths = identityPaths()) {
  const value = readFileOrNull(paths.encKeyPath);
  return isValidEncPrivateKeyPem(value) ? value : null;
}

function getCaPem(baseDir = identityDir) {
  const paths = identityPaths(baseDir);
  return fs.readFileSync(paths.caCertPath, "utf8");
}

function identityStatus({ baseDir = identityDir } = {}) {
  const paths = identityPaths(baseDir);
  return {
    identityDir: paths.baseDir,
    openssl: opensslVersion(),
    nodeId: readNodeId(paths),
    nodeName: readNodeName(paths),
    hasIdentityKey: fs.existsSync(paths.identityKeyPath),
    hasEncKey: encKeyPairState(paths).kind === "valid",
    hasCa: fs.existsSync(paths.caKeyPath) && fs.existsSync(paths.caCertPath),
    deviceCount: store.listDevices().length,
    revokedCount: store.listRevocations().length,
  };
}

// CSR key allowlist: P-256 or Ed25519 (API.md §2.3 — 400 `csr is unsupported`).
function csrKeyIsSupported(csrText) {
  if (/ED25519/i.test(csrText)) return true;
  if (/id-ecPublicKey/.test(csrText) && /(prime256v1|P-256|secp256r1)/.test(csrText)) return true;
  return false;
}

function cleanPem(value, label) {
  if (typeof value !== "string" || value.length > 64 * 1024) {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
  const text = value.trim();
  if (!text.startsWith("-----BEGIN") || /\0/.test(text)) {
    throw Object.assign(new Error(`${label} is invalid`), { status: 400 });
  }
  return `${text}\n`;
}

// Issues a client cert for a device CSR. Never sees or returns private keys.
function issueDeviceCert({ csrPem, deviceName = null, platform = null, baseDir = identityDir }) {
  requireOpenssl();
  const paths = identityPaths(baseDir);
  if (!fs.existsSync(paths.caKeyPath)) initIdentity({ baseDir });

  const csr = cleanPem(csrPem, "csr");
  const workDir = fs.mkdtempSync(path.join(paths.tmpDir, "issue-"));
  try {
    const csrPath = path.join(workDir, "device.csr.pem");
    writePrivate(csrPath, csr);

    let csrText;
    try {
      runOpenssl(["req", "-in", csrPath, "-noout", "-verify"]);
      csrText = runOpenssl(["req", "-in", csrPath, "-noout", "-text"]);
    } catch {
      throw Object.assign(new Error("csr is unsupported"), { status: 400 });
    }
    if (!csrKeyIsSupported(csrText)) {
      throw Object.assign(new Error("csr is unsupported"), { status: 400 });
    }

    const serialHex = crypto.randomBytes(9).toString("hex").toUpperCase();
    const extPath = path.join(workDir, "ext.cnf");
    writePrivate(
      extPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature",
        "extendedKeyUsage=clientAuth",
        "subjectKeyIdentifier=hash",
        "authorityKeyIdentifier=keyid,issuer",
        "",
      ].join("\n"),
    );
    const certPath = path.join(workDir, "device.cert.pem");
    runOpenssl([
      "x509", "-req",
      "-in", csrPath,
      "-CA", paths.caCertPath,
      "-CAkey", paths.caKeyPath,
      "-set_serial", `0x${serialHex}`,
      "-days", String(deviceCertDays),
      "-sha256",
      "-extfile", extPath,
      "-out", certPath,
    ]);

    const certificatePem = fs.readFileSync(certPath, "utf8");
    // RFC 2253 is the form that actually travels: it is what nginx/Caddy put in
    // $ssl_client_s_dn and what the tunnel derives from the peer certificate.
    // OpenSSL's default display format ("CN = a, OU = b") never matches it, so
    // capturing that instead silently locks every paired device out with a 403.
    const info = runOpenssl(["x509", "-in", certPath, "-noout", "-enddate", "-subject", "-nameopt", "RFC2253"]);
    const notAfterRaw = /notAfter=(.+)/.exec(info)?.[1]?.trim() || null;
    const notAfter = notAfterRaw ? new Date(notAfterRaw).toISOString() : null;
    const certSubject = /subject=\s*(.+)/.exec(info)?.[1]?.trim() || null;

    const device = {
      id: crypto.randomUUID(),
      name: typeof deviceName === "string" && deviceName.trim() ? deviceName.trim().slice(0, 120) : "Unnamed device",
      platform: ["ios", "macos", "cli", "other"].includes(platform) ? platform : "other",
      certSerial: serialHex,
      certSubject,
      createdAt: nowIso(),
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    };
    store.saveDevice(device);
    fs.copyFileSync(certPath, path.join(paths.issuedDir, `${serialHex}.cert.pem`));
    appendAudit("device_cert_issued", null, { deviceId: device.id, certSerial: serialHex, platform: device.platform });

    return {
      deviceId: device.id,
      certificatePem,
      caPem: getCaPem(baseDir),
      nodeId: readNodeId(paths),
      nodeName: readNodeName(paths),
      certSerial: serialHex,
      notAfter,
      device,
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function publicDevice(device, callerSubject = null) {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    certSerial: device.certSerial,
    createdAt: device.createdAt,
    lastSeenAt: device.lastSeenAt || null,
    revoked: Boolean(device.revoked),
    revokedAt: device.revokedAt || null,
    isCaller: Boolean(callerSubject && device.certSubject && device.certSubject === callerSubject),
  };
}

function listDevices({ callerSubject = null } = {}) {
  return store.listDevices().map((device) => publicDevice(device, callerSubject));
}

function isRevokedSerial(serial) {
  return store.listRevocations().some((entry) => entry.serial === serial);
}

// Adds the device's cert serial to the revocation list. Refuses to revoke
// the last unrevoked device unless force (API.md §2.4).
function revokeDevice(deviceId, { force = false, baseDir = identityDir } = {}) {
  const devices = store.listDevices();
  const device = devices.find((entry) => entry.id === deviceId);
  if (!device) {
    throw Object.assign(new Error("not found"), { status: 404 });
  }
  if (device.revoked) {
    throw Object.assign(new Error("device is already revoked"), { status: 409 });
  }
  const activeCount = devices.filter((entry) => !entry.revoked).length;
  if (activeCount <= 1 && !force) {
    throw Object.assign(new Error("revoking the last device would lock out this node"), { status: 409 });
  }

  const revokedAt = nowIso();
  store.addRevocation({ serial: device.certSerial, deviceId: device.id, revokedAt });
  const updated = { ...device, revoked: true, revokedAt };
  store.saveDevice(updated);

  // Flat serial list for the TLS layer / external gateways to consume.
  const paths = identityPaths(baseDir);
  try {
    mkdirPrivate(paths.baseDir);
    writePrivate(
      paths.revokedSerialsPath,
      store.listRevocations().map((entry) => entry.serial).join("\n") + "\n",
    );
  } catch (error) {
    appendAudit("revocation_list_write_failed", null, { error: error.message || String(error) });
  }

  appendAudit("device_revoked", null, { deviceId: device.id, certSerial: device.certSerial });
  return { id: device.id, revoked: true, revokedAt, device: updated };
}

// Node-CA-issued TLS server certificate for the tunnel listener (SAN-pinned
// by clients). Idempotent per SAN.
function ensureServerCert({ san, baseDir = identityDir }) {
  requireOpenssl();
  if (typeof san !== "string" || !/^[a-z0-9.-]{1,253}$/i.test(san)) {
    throw new Error("server cert SAN is invalid");
  }
  const paths = identityPaths(baseDir);
  if (!fs.existsSync(paths.caKeyPath)) initIdentity({ baseDir });
  const keyPath = path.join(paths.serverDir, `${san}.key.pem`);
  const certPath = path.join(paths.serverDir, `${san}.cert.pem`);
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { keyPath, certPath };
  }

  const workDir = fs.mkdtempSync(path.join(paths.tmpDir, "server-"));
  try {
    runOpenssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
    fs.chmodSync(keyPath, 0o600);
    const csrPath = path.join(workDir, "server.csr.pem");
    runOpenssl(["req", "-new", "-key", keyPath, "-subj", `/CN=${san}`, "-out", csrPath]);
    const extPath = path.join(workDir, "ext.cnf");
    writePrivate(
      extPath,
      [
        "basicConstraints=critical,CA:FALSE",
        "keyUsage=critical,digitalSignature,keyEncipherment",
        "extendedKeyUsage=serverAuth",
        `subjectAltName=DNS:${san}`,
        "",
      ].join("\n"),
    );
    runOpenssl([
      "x509", "-req",
      "-in", csrPath,
      "-CA", paths.caCertPath,
      "-CAkey", paths.caKeyPath,
      "-set_serial", `0x${crypto.randomBytes(9).toString("hex")}`,
      "-days", String(deviceCertDays),
      "-sha256",
      "-extfile", extPath,
      "-out", certPath,
    ]);
    fs.chmodSync(certPath, 0o600);
    return { keyPath, certPath };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

export {
  identityDir,
  identityPaths,
  opensslVersion,
  requireOpenssl,
  initIdentity,
  identityStatus,
  readNodeId,
  readNodeName,
  readEncPublicKeyB64,
  readEncPrivateKeyPem,
  getCaPem,
  issueDeviceCert,
  publicDevice,
  listDevices,
  revokeDevice,
  isRevokedSerial,
  ensureServerCert,
  csrKeyIsSupported,
};
