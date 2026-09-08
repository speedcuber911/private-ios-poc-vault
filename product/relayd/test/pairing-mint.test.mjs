// The MINT pairing variant, the QR payload, and the CA pin that makes a
// self-signed node safe to talk to on the very first request.
//
// The phone has no CSR stack, so the node generates the keypair, issues the
// certificate against its own CA and returns both inside a PKCS#12 encrypted
// under a passphrase BOTH sides derive from the pairing secret. Nothing secret
// crosses that the peer could not already compute, and no private key crosses
// in cleartext. The pre-existing csrPem variant must keep working unchanged.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-mint-test-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(tmpRoot, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";
// The protocol assertions here are transport-independent; TLS has its own file.
process.env.RELAYD_DIRECT_TLS = "false";
process.env.RELAYD_PUBLIC_HOST = "203.0.113.7";
process.env.RELAYD_PAIRING_ADVERTISE = "https://203.0.113.7:8443";

const pairing = await import("../src/pairing.mjs");
const identity = await import("../src/identity.mjs");
const { deviceTokenStore } = await import("../src/device-tokens.mjs");
const { qrModules, renderQrAnsi, qrAnsiWidth } = await import("../src/qr.mjs");

identity.initIdentity();

function redeem(blobObject) {
  const session = pairing.createPairingSession();
  const blob = Buffer.from(JSON.stringify(blobObject), "utf8");
  const { macKey } = pairing.pairingKeys(session.token);
  const result = pairing.redeemPairing({
    secret: session.token,
    deviceBlob: blob,
    deviceTag: pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob),
  });
  // The node blob is authenticated in the same way, in the other slot.
  assert.ok(pairing.verifyBlobTag(macKey, pairing.NODE_SLOT, result.nodeBlob, result.nodeTag));
  return { session, body: JSON.parse(result.nodeBlob.toString("utf8")) };
}

test("mint variant: the p12 opens with the derived passphrase and nothing else", () => {
  const { session, body } = redeem({ mint: "p12", deviceName: "Parikshit's iPhone", platform: "ios" });

  assert.match(body.deviceId, /^[0-9a-f-]{36}$/);
  assert.match(body.caPem, /BEGIN CERTIFICATE/);
  assert.ok(!("certificatePem" in body), "the mint variant ships the leaf inside the p12, not beside it");
  assert.equal(body.apiBaseUrl, "http://203.0.113.7:8787");
  assert.equal(body.verificationCode, session.code);

  const p12Path = path.join(tmpRoot, `mint-${body.deviceId}.p12`);
  fs.writeFileSync(p12Path, Buffer.from(body.p12, "base64"));

  // hex(hmac-sha256(secret, "relay-trial-p12-v1")) — the label is a wire value
  // shared with the Swift side and must not drift.
  const expectedPass = crypto
    .createHmac("sha256", Buffer.from(session.token, "utf8"))
    .update("relay-trial-p12-v1")
    .digest("hex");
  assert.equal(pairing.p12Passphrase(session.token), expectedPass);

  const dumped = execFileSync(
    "openssl",
    ["pkcs12", "-in", p12Path, "-passin", "env:RELAY_P12_PASS", "-nodes"],
    { encoding: "utf8", env: { ...process.env, RELAY_P12_PASS: expectedPass } },
  );
  assert.match(dumped, /BEGIN PRIVATE KEY/, "the phone's key really is inside");
  assert.match(dumped, /BEGIN CERTIFICATE/);

  assert.throws(
    () => execFileSync(
      "openssl",
      ["pkcs12", "-in", p12Path, "-passin", "env:RELAY_P12_PASS", "-nodes"],
      { encoding: "utf8", stdio: "pipe", env: { ...process.env, RELAY_P12_PASS: "not-the-passphrase" } },
    ),
    "a wrong passphrase must not open it",
  );

  // The bearer the phone will present afterwards is recorded as a hash only.
  const tokenHash = crypto
    .createHash("sha256")
    .update(pairing.deviceToken(session.token), "utf8")
    .digest("hex");
  const registered = deviceTokenStore().find(tokenHash);
  assert.ok(registered, "the device bearer must be registered at pairing time");
  assert.equal(registered.deviceId, body.deviceId);
  assert.equal(registered.disabled, false);
});

test("csrPem variant is unchanged, and both variants carry the node's public keys", () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "csr-"));
  const keyPath = path.join(dir, "k.pem");
  execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  const csrPath = path.join(dir, "c.pem");
  execFileSync("openssl", ["req", "-new", "-key", keyPath, "-subj", "/CN=desktop-device", "-out", csrPath]);

  const { body } = redeem({
    csrPem: fs.readFileSync(csrPath, "utf8"),
    deviceName: "Desktop",
    platform: "macos",
  });
  assert.match(body.certificatePem, /BEGIN CERTIFICATE/);
  assert.ok(!("p12" in body), "a CSR caller made its own key and must never be sent one");

  // Deleting trial enrolment removed the only publisher of the node's X25519
  // key, and `relay handoff` seals to it — pairing is now the only way a phone
  // can learn it, so both variants must carry it.
  const mint = redeem({ mint: "p12", deviceName: "Phone", platform: "ios" }).body;
  for (const carried of [body, mint]) {
    assert.match(carried.pubkey, /BEGIN PUBLIC KEY/, "ed25519 identity, SPKI PEM");
    assert.match(carried.encPubkey, /^[A-Za-z0-9+/]{43}=$/, "X25519 public key, base64");
  }
  assert.equal(mint.encPubkey, body.encPubkey);
});

test("a device blob with neither csrPem nor mint is 400", () => {
  assert.throws(
    () => redeem({ deviceName: "Nameless", platform: "ios" }),
    (error) => error.status === 400 && /csrPem or mint is required/.test(error.message),
  );
  assert.throws(
    () => redeem({ mint: "pem", deviceName: "Wrong", platform: "ios" }),
    (error) => error.status === 400,
  );
});

test("the QR payload carries the pin, the endpoints, and the token — in the fragment", () => {
  const session = pairing.createPairingSession();
  const presented = pairing.pairingPresentation(session);
  const [origin, fragment] = presented.url.split("#");
  assert.equal(origin, "https://get.openrelay.sh/pair");

  const fields = Object.fromEntries(fragment.split("&").map((pair) => pair.split("=")));
  assert.equal(fields.v, "1");
  assert.equal(fields.n, session.nodeId);
  assert.equal(fields.t, session.token);
  assert.equal(Buffer.from(fields.p, "base64url").toString("utf8"), "https://203.0.113.7:8443/v1/pair");
  assert.equal(Buffer.from(fields.a, "base64url").toString("utf8"), "http://203.0.113.7:8787");

  // f = base64url( sha256( node CA SubjectPublicKeyInfo ) ). Computed here from
  // the CA file directly, so a change to the helper cannot make this tautological.
  const caPem = fs.readFileSync(identity.identityPaths().caCertPath, "utf8");
  const spki = new crypto.X509Certificate(caPem).publicKey.export({ type: "spki", format: "der" });
  const expected = crypto.createHash("sha256").update(spki).digest("base64url");
  assert.equal(fields.f, expected);
  assert.equal(presented.caFingerprint, expected);
});

test("the CA pin survives a server-certificate regeneration", () => {
  const before = identity.caSpkiFingerprint();
  assert.ok(before);

  const first = identity.ensureServerCert({ san: "203.0.113.7", altNames: ["127.0.0.1"] });
  const firstSerial = new crypto.X509Certificate(fs.readFileSync(first.certPath)).serialNumber;
  // Reissued in place, so the serial has to be captured before the second call.
  const repeat = identity.ensureServerCert({ san: "203.0.113.7", altNames: ["127.0.0.1"] });
  assert.equal(
    new crypto.X509Certificate(fs.readFileSync(repeat.certPath)).serialNumber,
    firstSerial,
    "an unchanged name set must reuse the certificate, not churn it every boot",
  );

  // A changed advertised host reissues the leaf — that is the whole reason the
  // pin is taken over the CA and not over the leaf.
  const second = identity.ensureServerCert({ san: "203.0.113.7", altNames: ["127.0.0.1", "relay.test"] });
  assert.notEqual(
    new crypto.X509Certificate(fs.readFileSync(second.certPath)).serialNumber,
    firstSerial,
    "sanity: the leaf really was reissued",
  );
  assert.deepEqual(second.sans, ["IP:203.0.113.7", "IP:127.0.0.1", "DNS:relay.test"]);

  assert.equal(identity.caSpkiFingerprint(), before, "a printed pairing code must survive a leaf rotation");
});

test("a pairing link renders as a scannable QR that fits an 80-column terminal", () => {
  const session = pairing.createPairingSession();
  const presented = pairing.pairingPresentation(session);

  const modules = qrModules(presented.url);
  assert.ok(modules.length >= 21 && modules.length % 4 === 1, `unexpected QR size ${modules.length}`);
  // Finder pattern, top-left: a 7x7 ring. If this is wrong no camera locks.
  for (let i = 0; i < 7; i += 1) {
    assert.equal(modules[0][i], true);
    assert.equal(modules[6][i], true);
  }
  assert.equal(modules[1][1], false);
  assert.equal(modules[3][3], true);

  const rendered = renderQrAnsi(presented.url);
  assert.match(rendered, /[█▀▄ ]/);
  assert.ok(rendered.split("\n").length > 10);
  assert.ok(qrAnsiWidth(presented.url) <= 80, `QR is ${qrAnsiWidth(presented.url)} columns wide`);

  // A payload past the version ceiling fails loudly rather than truncating a
  // credential into an unscannable symbol.
  assert.throws(() => qrModules("x".repeat(5000)), /qr_payload_too_long/);
});
