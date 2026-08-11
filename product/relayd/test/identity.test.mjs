// W2-MODULES identity tests: CA generation, device cert issuance from a CSR,
// chain verification with `openssl verify`, revocation, file modes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-identity-test-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(tmpRoot, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";

const identity = await import("../src/identity.mjs");

function openssl(args, input = undefined) {
  return execFileSync("openssl", args, { encoding: "utf8", input });
}

function makeDeviceCsr(dir, { keyType = "p256", cn = "relay-test-device" } = {}) {
  const keyPath = path.join(dir, "device.key.pem");
  if (keyType === "p256") {
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  } else if (keyType === "ed25519") {
    openssl(["genpkey", "-algorithm", "ED25519", "-out", keyPath]);
  } else {
    openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", keyPath]);
  }
  const csrPath = path.join(dir, "device.csr.pem");
  openssl(["req", "-new", "-key", keyPath, "-subj", `/CN=${cn}`, "-out", csrPath]);
  return { keyPath, csrPem: fs.readFileSync(csrPath, "utf8") };
}

test("initIdentity generates node id, ed25519 identity, and a CA with private modes", () => {
  const status = identity.initIdentity();
  assert.match(status.openssl, /SSL/i);
  assert.match(status.nodeId, /^node-[a-f0-9]{16}$/);
  assert.ok(status.nodeName);
  assert.equal(status.hasIdentityKey, true);
  assert.equal(status.hasCa, true);

  const paths = identity.identityPaths();
  assert.equal(fs.statSync(paths.baseDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(paths.caKeyPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(paths.identityKeyPath).mode & 0o777, 0o600);

  // Idempotent: a second init keeps the same node id and CA.
  const caBefore = fs.readFileSync(paths.caCertPath, "utf8");
  const again = identity.initIdentity();
  assert.equal(again.nodeId, status.nodeId);
  assert.equal(fs.readFileSync(paths.caCertPath, "utf8"), caBefore);

  // The CA cert is a CA and the identity key is Ed25519.
  const caText = openssl(["x509", "-in", paths.caCertPath, "-noout", "-text"]);
  assert.match(caText, /CA:\s*TRUE/i);
  const keyText = fs.readFileSync(paths.identityKeyPath, "utf8");
  assert.match(keyText, /BEGIN PRIVATE KEY/);
});

test("issues a P-256 device cert that verifies against the node CA", () => {
  const workDir = fs.mkdtempSync(path.join(tmpRoot, "csr-"));
  const { csrPem } = makeDeviceCsr(workDir);
  const issued = identity.issueDeviceCert({ csrPem, deviceName: "Test iPhone", platform: "ios" });

  assert.match(issued.certificatePem, /BEGIN CERTIFICATE/);
  assert.match(issued.caPem, /BEGIN CERTIFICATE/);
  assert.match(issued.certSerial, /^[0-9A-F]{18}$/);
  assert.ok(issued.notAfter && !Number.isNaN(Date.parse(issued.notAfter)));
  assert.match(issued.nodeId, /^node-/);

  // openssl verify against the CA — the real chain check.
  const certPath = path.join(workDir, "issued.cert.pem");
  const caPath = path.join(workDir, "ca.pem");
  fs.writeFileSync(certPath, issued.certificatePem);
  fs.writeFileSync(caPath, issued.caPem);
  const verify = openssl(["verify", "-CAfile", caPath, certPath]);
  assert.match(verify, /: OK/);

  // Client-auth EKU and not a CA.
  const certText = openssl(["x509", "-in", certPath, "-noout", "-text"]);
  assert.match(certText, /TLS Web Client Authentication/);
  assert.match(certText, /CA:\s*FALSE/i);

  // Device record captured; no private key anywhere in the response.
  const devices = identity.listDevices();
  const record = devices.find((device) => device.id === issued.deviceId);
  assert.equal(record.name, "Test iPhone");
  assert.equal(record.platform, "ios");
  assert.equal(record.revoked, false);
  assert.ok(!JSON.stringify(issued).includes("PRIVATE KEY"));
});

test("ed25519 CSRs are accepted; RSA CSRs are rejected with 400", () => {
  const edDir = fs.mkdtempSync(path.join(tmpRoot, "csr-ed-"));
  const { csrPem: edCsr } = makeDeviceCsr(edDir, { keyType: "ed25519" });
  const issued = identity.issueDeviceCert({ csrPem: edCsr, deviceName: "Ed device", platform: "cli" });
  assert.match(issued.certificatePem, /BEGIN CERTIFICATE/);

  const rsaDir = fs.mkdtempSync(path.join(tmpRoot, "csr-rsa-"));
  const { csrPem: rsaCsr } = makeDeviceCsr(rsaDir, { keyType: "rsa" });
  assert.throws(
    () => identity.issueDeviceCert({ csrPem: rsaCsr }),
    (error) => error.status === 400 && /csr is unsupported/.test(error.message),
  );

  assert.throws(
    () => identity.issueDeviceCert({ csrPem: "not a csr" }),
    (error) => error.status === 400,
  );
});

test("revocation: serial lands on the CRL, guards enforced", () => {
  const devices = identity.listDevices();
  assert.ok(devices.length >= 2, "expected devices from earlier tests");
  const [first, second] = devices;

  const result = identity.revokeDevice(first.id);
  assert.equal(result.revoked, true);
  assert.ok(identity.isRevokedSerial(first.certSerial));
  const crl = fs.readFileSync(identity.identityPaths().revokedSerialsPath, "utf8");
  assert.ok(crl.includes(first.certSerial));

  // Already revoked → 409.
  assert.throws(
    () => identity.revokeDevice(first.id),
    (error) => error.status === 409 && /already revoked/.test(error.message),
  );
  // Unknown → 404.
  assert.throws(
    () => identity.revokeDevice("019e46a4-0000-7000-8000-00000000dead"),
    (error) => error.status === 404,
  );
  // Revoking the last active device requires force.
  assert.throws(
    () => identity.revokeDevice(second.id),
    (error) => error.status === 409 && /lock out/.test(error.message),
  );
  const forced = identity.revokeDevice(second.id, { force: true });
  assert.equal(forced.revoked, true);
  assert.ok(identity.isRevokedSerial(second.certSerial));
});

test("issued certSubject is the RFC 2253 form the gateway and tunnel actually send", () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "subject-format-"));
  // A multi-RDN subject is where the two encodings diverge most visibly:
  // OpenSSL's display form is "CN = a, OU = b, O = c" while RFC 2253 is
  // "O=c,OU=b,CN=a" — reversed and unspaced.
  const keyPath = path.join(dir, "d.key.pem");
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  const csrPath = path.join(dir, "d.csr.pem");
  openssl(["req", "-new", "-key", keyPath, "-subj", "/CN=fmt-device/OU=Devices/O=Relay", "-out", csrPath]);

  const issued = identity.issueDeviceCert({ csrPem: fs.readFileSync(csrPath, "utf8") });
  const certPath = path.join(dir, "issued.pem");
  fs.writeFileSync(certPath, issued.certificatePem);

  const rfc2253 = openssl(["x509", "-in", certPath, "-noout", "-subject", "-nameopt", "RFC2253"])
    .replace(/^subject=\s*/, "")
    .trim();

  // This is the exact string authorize() compares against x-ssl-client-s-dn.
  // If certSubject is stored in any other encoding, a freshly paired device is
  // allowlisted under a name it will never present, and every request 403s.
  assert.equal(issued.device.certSubject, rfc2253);
  assert.match(issued.device.certSubject, /^O=Relay,OU=Devices,CN=fmt-device$/);
  assert.doesNotMatch(issued.device.certSubject, / = /);
});

test("ensureServerCert issues a SAN-pinned server cert signed by the node CA", () => {
  const { keyPath, certPath } = identity.ensureServerCert({ san: "node1.tun.test" });
  assert.equal(fs.statSync(keyPath).mode & 0o777, 0o600);
  const certText = openssl(["x509", "-in", certPath, "-noout", "-text"]);
  assert.match(certText, /DNS:node1\.tun\.test/);
  assert.match(certText, /TLS Web Server Authentication/);
  const paths = identity.identityPaths();
  const verify = openssl(["verify", "-CAfile", paths.caCertPath, certPath]);
  assert.match(verify, /: OK/);
  // Idempotent.
  const again = identity.ensureServerCert({ san: "node1.tun.test" });
  assert.equal(again.certPath, certPath);
});
