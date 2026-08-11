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
  getCaPem,
  issueDeviceCert,
  publicDevice,
  listDevices,
  revokeDevice,
  isRevokedSerial,
  ensureServerCert,
  csrKeyIsSupported,
};
