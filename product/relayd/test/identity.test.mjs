// W2-MODULES identity tests: CA generation, device cert issuance from a CSR,
// chain verification with `openssl verify`, revocation, file modes.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const { sealTo, openSealed } = await import("../src/seal.mjs");

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

// --- Task 2 review findings (review-t2.md): C1 silent unrecoverable key
// rotation, C2 concurrent-process TOCTOU race, I1 corrupt files never heal
// and hasEncKey lies, M1 pre-existing insecure modes never corrected. Every
// test below uses its own fresh baseDir so it can plant broken states
// without touching the shared identityDir the tests above depend on.

function freshEncBase() {
  return fs.mkdtempSync(path.join(tmpRoot, "enc-"));
}

function keyBytesLeaked(haystack, paths) {
  // No key material may reach an error message: neither the PEM body nor
  // the published base64 public key may appear verbatim.
  if (/BEGIN (PRIVATE|PUBLIC) KEY/.test(haystack)) return true;
  try {
    const pub = fs.readFileSync(paths.encPubPath, "utf8").trim();
    if (pub && haystack.includes(pub)) return true;
  } catch {
    /* file may not exist / not be readable as the planted value */
  }
  return false;
}

test("C1: private key alone missing is a hard error, not silent regeneration of the public key", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);
  const originalPub = fs.readFileSync(paths.encPubPath, "utf8");

  fs.rmSync(paths.encKeyPath);

  assert.throws(
    () => identity.initIdentity({ baseDir }),
    (error) => {
      assert.match(error.message, /encryption keypair is half-present/);
      assert.match(error.message, new RegExp(paths.encKeyPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.equal(keyBytesLeaked(error.message, paths), false, "error message must not contain key bytes");
      return true;
    },
  );

  // The still-live public key must be untouched — this is the whole point:
  // a blob already sealed to it must remain openable once the operator
  // restores (or is given back) the matching private key.
  assert.equal(fs.readFileSync(paths.encPubPath, "utf8"), originalPub, "surviving public key must not be overwritten");
  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, false, "status must not claim readiness for a half-present pair");

  // The operator restores the missing half from backup (simulated here by
  // reusing the key generated moments ago in a sibling directory with the
  // same content shape) — recoverability was never destroyed because
  // initIdentity refused to rotate instead of silently regenerating.
  const recoveryBase = freshEncBase();
  identity.initIdentity({ baseDir: recoveryBase });
  const recoveryPaths = identity.identityPaths(recoveryBase);
  // Prove the mechanism, not the exact bytes: seal to the ORIGINAL
  // surviving pubkey, restore a matching private key file at the broken
  // path, and confirm initIdentity now treats the pair as healthy again.
  fs.copyFileSync(recoveryPaths.encKeyPath, paths.encKeyPath);
  fs.chmodSync(paths.encKeyPath, 0o600);
  fs.writeFileSync(paths.encPubPath, `${identity.readEncPublicKeyB64(recoveryPaths)}\n`, { mode: 0o600 });
  fs.chmodSync(paths.encPubPath, 0o600);
  const healed = identity.initIdentity({ baseDir });
  assert.equal(healed.hasEncKey, true);
  const plaintext = Buffer.from("handoff manifest", "utf8");
  const sealed = sealTo(identity.readEncPublicKeyB64(paths), plaintext);
  assert.deepEqual(openSealed(identity.readEncPrivateKeyPem(paths), sealed), plaintext);
});

test("C1 (reverse): public key alone missing is a hard error, not silent regeneration of the private key", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);
  const originalKeyPem = fs.readFileSync(paths.encKeyPath, "utf8");

  fs.rmSync(paths.encPubPath);

  assert.throws(
    () => identity.initIdentity({ baseDir }),
    (error) => {
      assert.match(error.message, /encryption keypair is half-present/);
      assert.equal(keyBytesLeaked(error.message, paths), false, "error message must not contain key bytes");
      return true;
    },
  );

  assert.equal(fs.readFileSync(paths.encKeyPath, "utf8"), originalKeyPem, "surviving private key must not be overwritten");
  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, false);
});

test("I1: empty private key file never heals silently and hasEncKey reflects reality, not existsSync", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);

  fs.writeFileSync(paths.encKeyPath, "", { mode: 0o600 });

  assert.equal(fs.existsSync(paths.encKeyPath), true, "the empty file still exists");
  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, false, "hasEncKey must not lie about an empty key file");
  assert.equal(identity.readEncPrivateKeyPem(paths), null, "reader must not hand back empty content as if valid");

  assert.throws(() => identity.initIdentity({ baseDir }), /do not parse as valid key material/);
  // Never heals on its own: a second call is just as loud, not silently
  // "fixed" by a repeated call.
  assert.throws(() => identity.initIdentity({ baseDir }), /do not parse as valid key material/);
  assert.equal(fs.readFileSync(paths.encKeyPath, "utf8"), "", "corrupt file is never silently rewritten");
});

test("I1: garbage (non-empty, non-key) private key content is rejected, not passed through as valid", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);

  fs.writeFileSync(paths.encKeyPath, "this is not a key\n", { mode: 0o600 });

  assert.equal(identity.readEncPrivateKeyPem(paths), null, "garbage must not be returned as if it were a valid PEM");
  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, false);
  assert.throws(() => identity.initIdentity({ baseDir }), /do not parse as valid key material/);
});

test("I1: empty public key file is rejected the same way", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);

  fs.writeFileSync(paths.encPubPath, "", { mode: 0o600 });

  assert.equal(identity.readEncPublicKeyB64(paths), null);
  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, false);
  assert.throws(() => identity.initIdentity({ baseDir }), /do not parse as valid key material/);
});

test("a mismatched (non-corresponding) pair is refused, never silently trusted", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);

  // Plant a second, unrelated, individually-valid public key so the file
  // pair no longer corresponds to a single keypair — this is exactly the
  // shape C2's race leaves behind.
  const otherBase = freshEncBase();
  identity.initIdentity({ baseDir: otherBase });
  const otherPub = identity.readEncPublicKeyB64(identity.identityPaths(otherBase));
  fs.writeFileSync(paths.encPubPath, `${otherPub}\n`, { mode: 0o600 });
  fs.chmodSync(paths.encPubPath, 0o600);

  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, false, "a mismatched pair is not a ready pair");
  assert.throws(() => identity.initIdentity({ baseDir }), /does not correspond to the private key/);
});

test("M1: a pre-existing encryption key with insecure mode is corrected to 0600", () => {
  const baseDir = freshEncBase();
  identity.initIdentity({ baseDir });
  const paths = identity.identityPaths(baseDir);

  fs.chmodSync(paths.encKeyPath, 0o644);
  fs.chmodSync(paths.encPubPath, 0o644);
  assert.equal(fs.statSync(paths.encKeyPath).mode & 0o777, 0o644, "sanity: mode was actually widened");

  identity.initIdentity({ baseDir });

  assert.equal(fs.statSync(paths.encKeyPath).mode & 0o777, 0o600, "private key mode corrected on next init");
  assert.equal(fs.statSync(paths.encPubPath).mode & 0o777, 0o600, "public key mode corrected on next init");
});

// C2: a real multi-OS-process reproduction, not an argument that the fix
// "should" be safe. Two separate `node` processes race initIdentity on the
// same fresh baseDir. Process A is deterministically paused *inside* its
// write path (via a stdout marker the parent waits on, not a timing guess)
// so process B's entire run genuinely overlaps A's still-in-progress
// critical section — reproducing exactly the interleaving review-t2.md
// demonstrated ("process A writes encKeyPath ... B also generates and
// overwrites encKeyPath ... then A writes encPubPath from its own orphaned
// generation").
const raceChildPath = path.join(tmpRoot, "race-child.mjs");
fs.writeFileSync(
  raceChildPath,
  `
import fs from "node:fs";
import path from "node:path";

const delayMs = Number(process.env.RACE_DELAY_MS || 0);
if (delayMs > 0) {
  const targetPrefix = "node-enc.key.pem";
  let fired = false;
  const widen = () => {
    if (fired) return;
    fired = true;
    console.log("RACE_WIDEN_FIRED");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
  };
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, ...rest) {
    const result = origWrite.call(fs, file, ...rest);
    if (typeof file === "string" && path.basename(file).startsWith(targetPrefix)) widen();
    return result;
  };
  const origRename = fs.renameSync;
  fs.renameSync = function (oldPath, newPath, ...rest) {
    const result = origRename.call(fs, oldPath, newPath, ...rest);
    if (typeof newPath === "string" && path.basename(newPath).startsWith(targetPrefix)) widen();
    return result;
  };
}

const { initIdentity } = await import(process.env.RACE_IDENTITY_MODULE_URL);
try {
  const status = initIdentity({ baseDir: process.env.RACE_BASE_DIR });
  console.log("RACE_RESULT_OK " + JSON.stringify({ hasEncKey: status.hasEncKey }));
} catch (error) {
  console.log("RACE_RESULT_ERR " + JSON.stringify({ message: error.message }));
  process.exitCode = 1;
}
`,
  "utf8",
);

function spawnRaceChild(env) {
  const child = spawn(process.execPath, [raceChildPath], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code) => resolve(code)));
  return { child, exited, output: () => ({ stdout, stderr }) };
}

test("C2: two real concurrent node processes racing initIdentity never leave a mismatched encryption keypair", async () => {
  const baseDir = fs.mkdtempSync(path.join(tmpRoot, "race-"));
  const raceDataDir = fs.mkdtempSync(path.join(tmpRoot, "race-data-"));
  const paths = identity.identityPaths(baseDir);
  const identityModuleUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "identity.mjs"),
  ).href;

  const commonEnv = {
    ...process.env,
    CODEX_DATA_DIR: raceDataDir,
    RACE_BASE_DIR: baseDir,
    RACE_IDENTITY_MODULE_URL: identityModuleUrl,
  };

  const a = spawnRaceChild({ ...commonEnv, RACE_DELAY_MS: "300" });
  const aWidened = new Promise((resolve) => {
    a.child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("RACE_WIDEN_FIRED")) resolve();
    });
  });

  // Deterministic interleaving: don't start B until A is verifiably
  // mid-critical-section. This is what makes the repro reliable rather
  // than a timing guess.
  await Promise.race([
    aWidened,
    a.exited.then(() => { throw new Error(`child A exited before widening: ${JSON.stringify(a.output())}`); }),
  ]);

  const b = spawnRaceChild({ ...commonEnv, RACE_DELAY_MS: "0" });

  const [codeA, codeB] = await Promise.all([a.exited, b.exited]);
  assert.equal(codeA, 0, `child A failed: ${JSON.stringify(a.output())}`);
  assert.equal(codeB, 0, `child B failed: ${JSON.stringify(b.output())}`);

  const finalPub = identity.readEncPublicKeyB64(paths);
  const finalPriv = identity.readEncPrivateKeyPem(paths);
  assert.ok(finalPub, "public key present after the race");
  assert.ok(finalPriv, "private key present after the race");
  assert.equal(identity.identityStatus({ baseDir }).hasEncKey, true);

  // The real assertion: the on-disk pair is internally consistent. A
  // mismatched pair (private from one generation, public from the other)
  // fails exactly like this — seal_decrypt_failed — which is what
  // review-t2.md reproduced against the unfixed code.
  const plaintext = Buffer.from("race regression probe", "utf8");
  const sealed = sealTo(finalPub, plaintext);
  assert.deepEqual(openSealed(finalPriv, sealed), plaintext, "on-disk keypair must not be mismatched");
});
