// Pairing protocol v2 tests (API.md §2.3):
//   - persisted, cross-process, atomically-claimed single-use sessions
//   - the derivation the cloud can never perform
//   - blob tags that make a control-plane substitution fail closed
//   - the CSR⇄cert exchange over the dedicated pairing listener
//   - rate limiting, and that the issued cert chains to the returned node CA
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

// Shared hang-detector waits: see the block comment in test/helpers/wait.mjs
// for why a readiness deadline is never a synchronization primitive here.
import { waitForServer, watchChild } from "./helpers/wait.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-pairing-test-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(tmpRoot, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";
// Every listener in this file is started explicitly on an ephemeral port; the
// daemon's configured pairing port is never bound here.

const pairing = await import("../src/pairing.mjs");
const identity = await import("../src/identity.mjs");
const config = await import("../src/config.mjs");
const { store } = await import("../src/store.mjs");

const repoRelaydDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function openssl(args, input = undefined) {
  return execFileSync("openssl", args, { encoding: "utf8", input });
}

function makeCsr(cn = "pair-device") {
  const dir = fs.mkdtempSync(path.join(tmpRoot, "csr-"));
  const keyPath = path.join(dir, "k.pem");
  openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
  const csrPath = path.join(dir, "c.pem");
  openssl(["req", "-new", "-key", keyPath, "-subj", `/CN=${cn}`, "-out", csrPath]);
  return fs.readFileSync(csrPath, "utf8");
}

// The device half of protocol v2: build the device blob and tag it.
function deviceBlobFor({ csrPem, deviceName = null, platform = null }) {
  return Buffer.from(JSON.stringify({ csrPem, deviceName, platform }), "utf8");
}

function pairBody(session, blob, { tamperTag = false, blobOverride = null } = {}) {
  const { macKey } = pairing.pairingKeys(session.token);
  let tag = pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob);
  if (tamperTag) {
    const bytes = Buffer.from(tag, "base64");
    bytes[0] ^= 0x01;
    tag = bytes.toString("base64");
  }
  return {
    v: 2,
    code: session.code,
    blob: (blobOverride ?? blob).toString("base64"),
    tag,
  };
}

async function postPair(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }
  return { status: response.status, json };
}

// Decodes a 201 node blob back into the historical v1 response object.
function readNodeBlob(session, json) {
  const blob = Buffer.from(json.blob, "base64");
  const { macKey } = pairing.pairingKeys(session.token);
  assert.ok(
    pairing.verifyBlobTag(macKey, pairing.NODE_SLOT, blob, json.tag),
    "node blob tag must verify on the device",
  );
  return JSON.parse(blob.toString("utf8"));
}

test("pairing session: code shape, TTL, presentation without secrets leakage", () => {
  pairing.resetPairingState();
  const session = pairing.createPairingSession();
  assert.match(session.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.ok(session.token.length >= 24);
  const ttlMs = Date.parse(session.expiresAt) - Date.parse(session.createdAt);
  assert.ok(Math.abs(ttlMs - 15 * 60 * 1000) < 5000, `ttl was ${ttlMs}`);

  const presentation = pairing.pairingPresentation(session);
  assert.equal(presentation.code, session.code);
  assert.ok(presentation.url.includes(session.token));
  assert.ok(presentation.otpauthUrl.startsWith("otpauth://relay-pair/"));
  // Placeholder domain only — no live endpoint baked in.
  assert.ok(presentation.url.includes("<domain>"));
  // The address the phone should reach is part of the CLI contract.
  assert.match(presentation.pairUrl, /\/v1\/pair$/);
});

test("key derivation matches the specification and the cloud can never reach macKey", () => {
  const secret = "test-pairing-secret-value";
  const expectedAuth = crypto
    .createHash("sha256")
    .update(Buffer.concat([Buffer.from("relay-pair-auth-v1"), Buffer.from([0]), Buffer.from(secret)]))
    .digest("base64url");
  const expectedMac = crypto.createHmac("sha256", Buffer.from(secret)).update("relay-pair-mac-v1").digest();

  const { authToken, macKey } = pairing.pairingKeys(secret);
  assert.equal(authToken, expectedAuth);
  assert.ok(macKey.equals(expectedMac));

  // The tag binds the slot name: the same bytes in the other slot tag
  // differently, so a node-blob can never be replayed as a device-blob.
  const blob = Buffer.from("same bytes");
  assert.notEqual(
    pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob),
    pairing.blobTag(macKey, pairing.NODE_SLOT, blob),
  );

  // Knowing authToken (all the cloud is ever told) does not yield macKey.
  const fromAuthToken = crypto.createHmac("sha256", Buffer.from(authToken)).update("relay-pair-mac-v1").digest();
  assert.ok(!fromAuthToken.equals(macKey));
});

test("tag verification is constant-time and rejects a one-byte-flipped tag", () => {
  const { macKey } = pairing.pairingKeys("another-secret");
  const blob = Buffer.from("device blob bytes");
  const tag = pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob);
  assert.equal(pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, tag), true);

  // Flip one byte of the DECODED tag: same length, different value.
  const flipped = Buffer.from(tag, "base64");
  flipped[7] ^= 0x01;
  assert.equal(flipped.length, Buffer.from(tag, "base64").length);
  assert.equal(
    pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, flipped.toString("base64")),
    false,
  );

  // Wrong-length, empty and missing tags are rejected without throwing.
  assert.equal(pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, ""), false);
  assert.equal(pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, undefined), false);
  assert.equal(pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, "AAAA"), false);
  // A tag for the other slot never verifies here.
  assert.equal(
    pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, pairing.blobTag(macKey, pairing.NODE_SLOT, blob)),
    false,
  );

  // The comparison itself goes through crypto.timingSafeEqual on equal-length
  // buffers — never a short-circuiting === on strings.
  const original = crypto.timingSafeEqual;
  const calls = [];
  crypto.timingSafeEqual = (a, b) => {
    calls.push([Buffer.from(a), Buffer.from(b)]);
    return original(a, b);
  };
  try {
    pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, blob, flipped.toString("base64"));
  } finally {
    crypto.timingSafeEqual = original;
  }
  assert.equal(calls.length, 1, "verifyBlobTag must delegate to crypto.timingSafeEqual");
  assert.equal(calls[0][0].length, calls[0][1].length);
  assert.equal(calls[0][0].length, 32);
});

test("pairing codes are single-use and expired codes are indistinguishable", () => {
  pairing.resetPairingState();
  const session = pairing.createPairingSession();
  const redeemed = pairing.consumePairingSecret(session.code);
  assert.equal(redeemed.id, session.id);
  // Second use → 403 with the generic message.
  assert.throws(
    () => pairing.consumePairingSecret(session.code),
    (error) => error.status === 403 && /pairing code is invalid or expired/.test(error.message),
  );
  // Unknown code → same 403.
  assert.throws(
    () => pairing.consumePairingSecret("ZZZZ-9999"),
    (error) => error.status === 403 && /pairing code is invalid or expired/.test(error.message),
  );
  // The long token also redeems.
  const tokenSession = pairing.createPairingSession();
  assert.equal(pairing.consumePairingSecret(tokenSession.token).id, tokenSession.id);
});

test("pairing sessions are persisted, so a separate process can redeem them", () => {
  pairing.resetPairingState();
  // Mint the session in a CHILD process and let it exit — exactly what
  // `relayd pair` does on a systemd install. Before v2 the session lived in a
  // module-level Map inside that process and died with it.
  const script = [
    'const pairing = await import(process.env.RELAY_TEST_PAIRING_URL);',
    'const session = pairing.createPairingSession();',
    'process.stdout.write(JSON.stringify({ id: session.id, code: session.code, token: session.token }));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      RELAY_TEST_PAIRING_URL: new URL("../src/pairing.mjs", import.meta.url).href,
    },
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  const minted = JSON.parse(result.stdout);

  // This process — the "daemon" — sees it and can redeem it.
  assert.ok(store.listPairingSessions().some((entry) => entry.id === minted.id));
  const redeemed = pairing.consumePairingSecret(minted.code);
  assert.equal(redeemed.id, minted.id);
  assert.equal(redeemed.token, minted.token);
  // Consumed => gone from the store, so a restarted daemon cannot replay it.
  assert.ok(!store.listPairingSessions().some((entry) => entry.id === minted.id));
});

test("expired persisted sessions are pruned and never redeemable", () => {
  pairing.resetPairingState();
  const expired = {
    id: crypto.randomUUID(),
    code: "AAAA-BBBB",
    token: "expired-token-value-0123456789",
    nodeId: "node-test",
    nodeName: "test",
    createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  };
  store.savePairingSession(expired);
  assert.throws(
    () => pairing.consumePairingSecret(expired.code),
    (error) => error.status === 403,
  );
  assert.equal(pairing.prunePairingSessions(Date.now()) >= 0, true);
  assert.ok(!store.listPairingSessions().some((entry) => entry.id === expired.id));
});

// SAME-PROCESS version, kept for the request-shaping it covers. It CANNOT test
// the atomicity of the claim: one event loop serializes the two redemptions
// whatever primitive the store uses underneath. The real test is
// "two relayd daemons sharing one data dir…" below, which races real
// processes; this one would pass even against the broken unlink claim.
test("concurrent redemptions of one code: exactly one succeeds", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    const session = pairing.createPairingSession();
    // Two devices race with independently valid, correctly-tagged requests.
    const bodies = [
      pairBody(session, deviceBlobFor({ csrPem: makeCsr("race-a"), deviceName: "A", platform: "ios" })),
      pairBody(session, deviceBlobFor({ csrPem: makeCsr("race-b"), deviceName: "B", platform: "ios" })),
    ];
    const before = identity.listDevices().length;
    const results = await Promise.all(bodies.map((body) => postPair(port, body)));
    const created = results.filter((r) => r.status === 201);
    const refused = results.filter((r) => r.status === 403);
    assert.equal(created.length, 1, `expected exactly one 201, got ${JSON.stringify(results.map((r) => r.status))}`);
    assert.equal(refused.length, 1);
    // …and exactly one certificate was issued.
    assert.equal(identity.listDevices().length, before + 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("POST /v1/pair on the pairing listener issues a cert chained to the node CA", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    const session = pairing.createPairingSession();
    const blob = deviceBlobFor({ csrPem: makeCsr(), deviceName: "Paired iPhone", platform: "ios" });
    const response = await postPair(port, pairBody(session, blob));
    assert.equal(response.status, 201);
    assert.equal(response.json.v, 2);
    const body = readNodeBlob(session, response.json);
    assert.match(body.certificatePem, /BEGIN CERTIFICATE/);
    assert.match(body.caPem, /BEGIN CERTIFICATE/);
    assert.match(body.nodeId, /^node-/);
    assert.ok(body.deviceId && body.certSerial && body.notAfter);
    assert.ok(!JSON.stringify(body).includes("PRIVATE KEY"));
    // The wire response itself carries no key material either.
    assert.ok(!JSON.stringify(response.json).includes("PRIVATE KEY"));

    const dir = fs.mkdtempSync(path.join(tmpRoot, "verify-"));
    fs.writeFileSync(path.join(dir, "cert.pem"), body.certificatePem);
    fs.writeFileSync(path.join(dir, "ca.pem"), body.caPem);
    assert.match(openssl(["verify", "-CAfile", path.join(dir, "ca.pem"), path.join(dir, "cert.pem")]), /: OK/);

    const device = identity.listDevices().find((entry) => entry.id === body.deviceId);
    assert.equal(device.name, "Paired iPhone");

    // Replaying the same code fails with 403.
    const replayBlob = deviceBlobFor({ csrPem: makeCsr() });
    const replay = await postPair(port, pairBody(session, replayBlob));
    assert.equal(replay.status, 403);

    // Unsupported CSR (RSA) → 400 csr is unsupported; code consumed anyway.
    const rsaDir = fs.mkdtempSync(path.join(tmpRoot, "rsa-"));
    const rsaKey = path.join(rsaDir, "k.pem");
    openssl(["genpkey", "-algorithm", "RSA", "-pkeyopt", "rsa_keygen_bits:2048", "-out", rsaKey]);
    const rsaCsrPath = path.join(rsaDir, "c.pem");
    openssl(["req", "-new", "-key", rsaKey, "-subj", "/CN=rsa-device", "-out", rsaCsrPath]);
    const session2 = pairing.createPairingSession();
    const rsaBlob = deviceBlobFor({ csrPem: fs.readFileSync(rsaCsrPath, "utf8") });
    const unsupported = await postPair(port, pairBody(session2, rsaBlob));
    assert.equal(unsupported.status, 400);
    assert.match(unsupported.json.error, /csr is unsupported/);

    // Missing fields → 400s.
    const session3 = pairing.createPairingSession();
    const noCode = await postPair(port, { v: 2, blob: blob.toString("base64"), tag: "AAAA" });
    assert.equal(noCode.status, 400);
    const noTag = await postPair(port, { v: 2, code: session3.code, blob: blob.toString("base64") });
    assert.equal(noTag.status, 400);
    const badBlob = await postPair(port, { v: 2, code: session3.code, blob: "!!!not base64!!!", tag: "AAAA" });
    assert.equal(badBlob.status, 400);

    // Only POST /v1/pair exists on this listener.
    const nothingElse = await fetch(`http://127.0.0.1:${port}/v1/devices`);
    assert.equal(nothingElse.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("substitution attack: a cloud-swapped device blob is refused and no cert is issued", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    // A faithful model of the rendezvous: the cloud holds opaque {blob, tag}
    // per slot and hands back whatever it holds. It cannot check the tag —
    // that needs macKey, which is derived from a secret it never receives.
    const cloud = new Map();
    const putBlob = (id, slot, blob, tag) => {
      const key = `${id}/${slot}`;
      if (cloud.has(key)) throw new Error("put-once violated");
      cloud.set(key, { blob, tag });
    };
    const getBlob = (id, slot) => cloud.get(`${id}/${slot}`);

    const session = pairing.createPairingSession();
    const { macKey, authToken } = pairing.pairingKeys(session.token);

    // 1. Honest exchange: the device posts its real CSR blob + tag.
    const honestCsr = makeCsr("honest-device");
    const honestBlob = deviceBlobFor({ csrPem: honestCsr, deviceName: "Honest", platform: "ios" });
    putBlob(session.id, pairing.DEVICE_SLOT, honestBlob, pairing.blobTag(macKey, pairing.DEVICE_SLOT, honestBlob));

    // 2. The control plane is compromised and swaps the stored blob for one
    //    carrying ITS OWN CSR — the exact v1 attack. It keeps the honest tag,
    //    because it cannot compute a new one.
    const attackerCsr = makeCsr("attacker-device");
    const attackerBlob = deviceBlobFor({ csrPem: attackerCsr, deviceName: "Attacker", platform: "ios" });
    const stored = getBlob(session.id, pairing.DEVICE_SLOT);
    cloud.set(`${session.id}/${pairing.DEVICE_SLOT}`, { blob: attackerBlob, tag: stored.tag });

    // The cloud has authToken and the swapped bytes; it still cannot forge a
    // matching tag.
    const forged = crypto
      .createHmac("sha256", Buffer.from(authToken))
      .update(Buffer.concat([Buffer.from(pairing.DEVICE_SLOT), Buffer.from([0]), attackerBlob]))
      .digest("base64");
    assert.equal(pairing.verifyBlobTag(macKey, pairing.DEVICE_SLOT, attackerBlob, forged), false);

    // 3. The node fetches the slot and runs the real exchange.
    const devicesBefore = identity.listDevices();
    const relayed = getBlob(session.id, pairing.DEVICE_SLOT);
    const response = await postPair(port, {
      v: 2,
      code: session.code,
      blob: relayed.blob.toString("base64"),
      tag: relayed.tag,
    });

    // The node REFUSES: no certificate, no device, session burned.
    assert.equal(response.status, 403);
    assert.match(response.json.error, /pairing blob authentication failed/);
    const devicesAfter = identity.listDevices();
    assert.equal(devicesAfter.length, devicesBefore.length, "no device may be enrolled");
    assert.ok(!devicesAfter.some((device) => device.name === "Attacker"));
    assert.ok(!cloud.has(`${session.id}/${pairing.NODE_SLOT}`), "no node blob may be produced");
    // The session was consumed, so the attacker cannot retry it.
    assert.ok(!store.listPairingSessions().some((entry) => entry.id === session.id));

    // The refusal is audited.
    const audit = fs.readFileSync(config.auditPath, "utf8");
    assert.ok(audit.includes("pairing_blob_auth_failed"), "refusal must be audited");

    // 4. Control: the untouched honest blob would have been accepted.
    const honestSession = pairing.createPairingSession();
    const honest = await postPair(port, pairBody(honestSession, honestBlob));
    assert.equal(honest.status, 201);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a one-byte-flipped tag on an otherwise valid request issues nothing", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    const session = pairing.createPairingSession();
    const blob = deviceBlobFor({ csrPem: makeCsr("flip"), deviceName: "Flip", platform: "ios" });
    const before = identity.listDevices().length;
    const response = await postPair(port, pairBody(session, blob, { tamperTag: true }));
    assert.equal(response.status, 403);
    assert.equal(identity.listDevices().length, before);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a freshly paired subject is allowlisted explicitly and audited", async () => {
  pairing.resetPairingState();
  assert.equal(config.pairingAutoAllow, true, "auto-allow is the documented default");
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    // A REAL multi-RDN subject — the shape a device certificate actually has.
    const dir = fs.mkdtempSync(path.join(tmpRoot, "multirdn-"));
    const keyPath = path.join(dir, "k.pem");
    openssl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
    const csrPath = path.join(dir, "c.pem");
    openssl(["req", "-new", "-key", keyPath, "-subj", "/O=Relay/OU=Devices/CN=multi-rdn-phone", "-out", csrPath]);

    const session = pairing.createPairingSession();
    const blob = deviceBlobFor({
      csrPem: fs.readFileSync(csrPath, "utf8"),
      deviceName: "Multi RDN",
      platform: "ios",
    });
    const response = await postPair(port, pairBody(session, blob));
    assert.equal(response.status, 201);
    const body = readNodeBlob(session, response.json);

    const subject = store.listDevices().find((device) => device.id === body.deviceId).certSubject;
    assert.ok(subject.includes(","), `expected a multi-RDN subject, got ${subject}`);

    // The subject is now allowlisted in-process and on disk, with a reason.
    assert.ok(config.allowedCertSubjects.has(subject));
    const persisted = JSON.parse(fs.readFileSync(config.allowedCertSubjectsPath, "utf8"));
    const entry = persisted.find((item) => item.subject === subject);
    assert.ok(entry, "the addition must be written to a reviewable file");
    assert.equal(entry.reason, "paired");
    assert.equal(entry.deviceId, body.deviceId);

    const audit = fs.readFileSync(config.auditPath, "utf8");
    assert.ok(audit.includes("cert_subject_allowlisted"), "the widening must be audited");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the allowlist can express a real multi-RDN certificate subject", async () => {
  const multi = "CN=device,OU=Devices,O=Relay";
  const second = "CN=laptop,OU=Devices,O=Relay";

  // JSON-array form: the one that can carry commas inside a DN.
  assert.deepEqual(config.parseCertSubjectList(JSON.stringify([multi, second])), [multi, second]);
  // Newline form.
  assert.deepEqual(config.parseCertSubjectList(`${multi}\n${second}\n`), [multi, second]);
  // Legacy comma form still works for the single-RDN values already deployed.
  assert.deepEqual(config.parseCertSubjectList("CN=allowed,CN=other"), ["CN=allowed", "CN=other"]);
  assert.deepEqual(config.parseCertSubjectList(""), []);
  assert.deepEqual(config.parseCertSubjectList(undefined), []);
  assert.throws(() => config.parseCertSubjectList("[not json"), /not valid JSON/);
  assert.throws(() => config.parseCertSubjectList('[1,2]'), /JSON array of subject DN strings/);

  // End to end: a server configured with a JSON allowlist authorizes a
  // multi-RDN DN that the old comma-splitting could never have matched.
  const serverModuleUrl = new URL("../src/server.mjs", import.meta.url).href;
  const script = [
    'const server = await import(process.env.RELAY_TEST_SERVER_URL);',
    'const headers = { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": process.env.RELAY_TEST_DN };',
    'process.stdout.write(JSON.stringify(server.authorize({ headers })));',
  ].join("\n");
  const run = (dn, allowEnvName, allowEnvValue) =>
    JSON.parse(
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        cwd: repoRelaydDir,
        timeout: 120000,
        env: {
          ...process.env,
          CODEX_DATA_DIR: fs.mkdtempSync(path.join(tmpRoot, "allow-")),
          CODEX_REQUIRE_MTLS: "true",
          RELAYD_PAIRING_AUTOALLOW: "false",
          CODEX_ALLOWED_CERT_SUBJECTS: "",
          RELAYD_ALLOWED_CERT_SUBJECTS: "",
          [allowEnvName]: allowEnvValue,
          RELAY_TEST_SERVER_URL: serverModuleUrl,
          RELAY_TEST_DN: dn,
        },
      }),
    );

  assert.deepEqual(run(multi, "RELAYD_ALLOWED_CERT_SUBJECTS", JSON.stringify([multi])), {
    ok: true,
    subject: multi,
  });
  // The historical comma format cannot express it — 403, as the verifier saw.
  assert.equal(run(multi, "CODEX_ALLOWED_CERT_SUBJECTS", multi).ok, false);
  assert.equal(run(multi, "CODEX_ALLOWED_CERT_SUBJECTS", multi).status, 403);
  // And an unrelated DN is still refused under the JSON format.
  assert.equal(run(second, "RELAYD_ALLOWED_CERT_SUBJECTS", JSON.stringify([multi])).ok, false);
});

test("POST /v1/pair is never routable on the mTLS data listener", async () => {
  const server = await import("../src/server.mjs");
  const chunks = [];
  let status = null;
  const res = {
    writeHead(code) {
      status = code;
      return this;
    },
    end(body) {
      if (body) chunks.push(body);
    },
    setHeader() {},
  };
  const req = { method: "POST", url: "/v1/pair", headers: {} };
  await server.routeRequest(req, res);
  assert.equal(status, 404);
  assert.match(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), /not found/);
});

// The onboarding dead end, end to end: `relayd pair` runs in a short-lived CLI
// process (as on a systemd install) and the code it prints must be redeemable
// against the ALREADY-RUNNING daemon. Before v2 this was impossible — the
// session lived in the CLI process's memory and died with it.
test("integration: `relayd pair` prints a code the running daemon redeems", async () => {
  const net = await import("node:net");
  const freePort = () =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const value = probe.address().port;
        probe.close(() => resolve(value));
      });
    });

  const dir = fs.mkdtempSync(path.join(tmpRoot, "cli-"));
  const workspaceDir = path.join(dir, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const apiPort = await freePort();
  const pairPort = await freePort();
  const env = {
    ...process.env,
    CODEX_API_HOST: "127.0.0.1",
    CODEX_API_PORT: String(apiPort),
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(dir, "data"),
    RELAYD_IDENTITY_DIR: path.join(dir, "identity"),
    CODEX_WORKSPACE_BROWSE_ROOT: dir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    RELAYD_PAIRING_ENABLED: "true",
    RELAYD_PAIRING_HOST: "127.0.0.1",
    RELAYD_PAIRING_PORT: String(pairPort),
  };
  const relaydBin = path.join(repoRelaydDir, "bin", "relayd");

  const { spawn } = await import("node:child_process");
  const daemon = spawn(process.execPath, [relaydBin, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
  const watch = watchChild(daemon, "relayd(pair-cli)");
  const daemonLog = () => watch.output();
  try {
    await waitForServer(`http://127.0.0.1:${apiPort}`, { exited: watch.exited, output: watch.output });

    // `relayd pair` in a SEPARATE, short-lived process.
    const printed = execFileSync(process.execPath, [relaydBin, "pair"], {
      encoding: "utf8",
      env,
      timeout: 120000,
    });
    const code = /^\s+([A-Z2-9]{4}-[A-Z2-9]{4})\s*$/m.exec(printed)?.[1];
    assert.ok(code, `no pairing code in output:\n${printed}`);
    const token = /token=([A-Za-z0-9_-]+)/.exec(printed)?.[1];
    assert.ok(token, "the link must carry the long token");
    assert.ok(printed.includes(`http://127.0.0.1:${pairPort}/v1/pair`), "must print where the phone should connect");
    assert.ok(!printed.includes("PRIVATE KEY"), "the CLI must never print key material");
    // The stale, misleading instruction is gone.
    assert.ok(!/only redeemable while\s*$/m.test(printed));

    // The CLI process has exited. Redeem against the daemon's listener.
    const { macKey } = pairing.pairingKeys(token);
    const blob = deviceBlobFor({ csrPem: makeCsr("cli-paired"), deviceName: "CLI Paired", platform: "ios" });
    const response = await postPair(pairPort, {
      v: 2,
      code,
      blob: blob.toString("base64"),
      tag: pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob),
    });
    assert.equal(response.status, 201, `pair failed: ${JSON.stringify(response.json)} (daemon log: ${daemonLog()})`);
    const issuedBlob = Buffer.from(response.json.blob, "base64");
    assert.ok(pairing.verifyBlobTag(macKey, pairing.NODE_SLOT, issuedBlob, response.json.tag));
    const issued = JSON.parse(issuedBlob.toString("utf8"));
    assert.match(issued.certificatePem, /BEGIN CERTIFICATE/);

    // The daemon does NOT serve /v1/pair on the data listener.
    const onDataListener = await fetch(`http://127.0.0.1:${apiPort}/v1/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(onDataListener.status, 404);
  } finally {
    daemon.kill("SIGTERM");
    await new Promise((resolve) => daemon.once("exit", resolve));
  }
});

// ---------------------------------------------------------------------------
// ONE PAIRING CODE, TWO DAEMONS, ONE CERTIFICATE.
//
// The single-use guarantee is a SECURITY property: a second certificate minted
// from one code is an unauthorized device with full data-path access. It is
// also a property of the filesystem primitive the claim is built on, so it can
// only be tested across REAL PROCESSES — two relayd daemons sharing one
// CODEX_DATA_DIR, one code, both /v1/pair endpoints hit at once.
//
// Against the previous `fs.unlinkSync` claim this is exactly the shape that
// fails: on darwin/APFS two processes unlinking one path both return success.
// ---------------------------------------------------------------------------
test("two relayd daemons sharing one data dir: one code mints exactly one certificate", async () => {
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");
  const { createStore } = await import("../src/store.mjs");

  const freePort = () =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const value = probe.address().port;
        probe.close(() => resolve(value));
      });
    });

  // A raw socket client instead of fetch(), for ONE reason: the request bytes
  // must leave for every racer at the same instant. Connecting first and then
  // releasing all the writes in a single synchronous loop puts the two daemons
  // inside the same few microseconds — the alignment the double-unlink needs.
  // fetch() pools and schedules its own way and cannot promise that.
  async function openPairSocket(pairPort, payload) {
    const socket = net.connect(pairPort, "127.0.0.1");
    socket.setNoDelay(true);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const wire = Buffer.concat([
      Buffer.from(
        `POST /v1/pair HTTP/1.1\r\nhost: 127.0.0.1:${pairPort}\r\ncontent-type: application/json\r\n` +
          `content-length: ${payload.length}\r\nconnection: close\r\n\r\n`,
        "utf8",
      ),
      payload,
    ]);
    const response = new Promise((resolve) => {
      let raw = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        raw += chunk;
        const headerEnd = raw.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const length = Number(/content-length: (\d+)/i.exec(raw)?.[1] ?? 0);
        const bodyText = raw.slice(headerEnd + 4);
        if (Buffer.byteLength(bodyText, "utf8") < length) return;
        let json = null;
        try {
          json = JSON.parse(bodyText);
        } catch {
          json = null;
        }
        socket.destroy();
        resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1]), json });
      });
      const fail = (error) => resolve({ status: 0, json: { error: String(error?.message || "closed") } });
      socket.on("error", fail);
      socket.on("close", () => fail(new Error("closed before a complete response")));
    });
    return { response, send: () => socket.write(wire) };
  }

  const shared = fs.mkdtempSync(path.join(tmpRoot, "two-daemons-"));
  const sharedData = path.join(shared, "data");
  const workspaceDir = path.join(shared, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });

  const baseEnv = {
    ...process.env,
    CODEX_API_HOST: "127.0.0.1",
    CODEX_REQUIRE_MTLS: "false",
    // ONE data dir and ONE identity for both daemons: the co-located
    // deployment, and the only way two processes can race the same session.
    CODEX_DATA_DIR: sharedData,
    RELAYD_IDENTITY_DIR: path.join(shared, "identity"),
    CODEX_WORKSPACE_BROWSE_ROOT: shared,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    RELAYD_PAIRING_ENABLED: "true",
    RELAYD_PAIRING_HOST: "127.0.0.1",
  };

  const daemons = [];
  const startDaemon = async (apiPort, pairPort) => {
    const child = spawn(process.execPath, [path.join(repoRelaydDir, "src", "index.mjs")], {
      env: { ...baseEnv, CODEX_API_PORT: String(apiPort), RELAYD_PAIRING_PORT: String(pairPort) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemons.push(child);
    const watch = watchChild(child, `relayd(api ${apiPort})`);
    await waitForServer(`http://127.0.0.1:${apiPort}`, { exited: watch.exited, output: watch.output });
    return { output: watch.output };
  };

  const apiA = await freePort();
  const pairA = await freePort();
  const apiB = await freePort();
  const pairB = await freePort();

  try {
    // Sequential start: the node CA is created once, by whoever comes up first.
    const a = await startDaemon(apiA, pairA);
    const b = await startDaemon(apiB, pairB);

    // A THIRD process mints the sessions — exactly what `relayd pair` is.
    const sharedStore = await createStore("json", { dataDir: sharedData });
    const auditFile = path.join(sharedData, "audit.jsonl");
    const csrPem = makeCsr("two-daemon-race");
    const blob = deviceBlobFor({ csrPem, deviceName: "Racing phone", platform: "ios" });

    // 25 rounds, and each round is 12 simultaneous redemptions of ONE code
    // split across the two daemons — six per process, so the racers are both
    // cross-process and concurrent within each process.
    const rounds = 25;
    const racersPerDaemon = 6;
    const loserStatuses = [];
    const winners = [];
    for (let round = 0; round < rounds; round += 1) {
      const session = {
        id: crypto.randomUUID(),
        code: `RACE-${String(round).padStart(4, "0")}`,
        token: crypto.randomBytes(24).toString("base64url"),
        nodeId: "node-two-daemon-race",
        nodeName: "race-node",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      };
      sharedStore.savePairingSession(session);

      const { macKey } = pairing.pairingKeys(session.token);
      const body = {
        v: 2,
        code: session.code,
        blob: blob.toString("base64"),
        tag: pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob),
      };

      const payload = Buffer.from(JSON.stringify(body), "utf8");
      const racers = [];
      for (const pairPort of [pairA, pairB]) {
        for (let i = 0; i < racersPerDaemon; i += 1) racers.push(await openPairSocket(pairPort, payload));
      }

      const devicesBefore = sharedStore.listDevices().length;
      // One synchronous loop, no awaits in between.
      for (const racer of racers) racer.send();
      const results = await Promise.all(racers.map((racer) => racer.response));
      const codes = results.map((result) => result.status);
      winners.push(codes.slice(0, racersPerDaemon).includes(201) ? "A" : "B");

      const created = codes.filter((status) => status === 201).length;
      assert.equal(
        created,
        1,
        `round ${round}: ${created} certificates issued for one pairing code ` +
          `(statuses ${JSON.stringify(codes)}, devices ${devicesBefore} -> ${sharedStore.listDevices().length})`,
      );

      // Every loser is refused with one of the two answers an invalid code
      // gets, carrying its own fixed message — NEVER a 500, and never text
      // describing the host. Which of the two depends on where it lost: a
      // request that read the session and then lost the claim answers 403; one
      // that arrived after the winner had already removed it never matched at
      // all, and a used code is by design indistinguishable from a guess, so it
      // also spends that source's guessing budget and eventually answers 429.
      const losers = results.filter((result) => result.status !== 201);
      loserStatuses.push(losers.map((loser) => loser.status));
      for (const loser of losers) {
        assert.ok(
          loser.status === 403 || loser.status === 429,
          `round ${round}: loser returned ${loser.status} ${JSON.stringify(loser.json)}`,
        );
        assert.ok(
          loser.json?.error === "pairing code is invalid or expired" ||
            loser.json?.error === "too many pairing attempts",
          `round ${round}: unexpected loser message ${JSON.stringify(loser.json)}`,
        );
      }

      // …and exactly one certificate exists for it.
      const devicesAfter = sharedStore.listDevices().length;
      assert.equal(
        devicesAfter,
        devicesBefore + 1,
        `round ${round}: device count moved by ${devicesAfter - devicesBefore}, expected 1`,
      );
      // The audit log is append-only and written by both processes, so it is
      // the independent witness: one device_paired record for this session.
      const paired = fs
        .readFileSync(auditFile, "utf8")
        .split("\n")
        .filter((line) => line.includes('"device_paired"') && line.includes(session.id));
      assert.equal(paired.length, 1, `round ${round}: ${paired.length} device_paired records for one session`);

      // Consumed, so a restarted daemon cannot replay it.
      assert.ok(!sharedStore.listPairingSessions().some((entry) => entry.id === session.id));
    }

    // 25 codes in, 25 certificates out — no more, no fewer.
    assert.equal(sharedStore.listDevices().length, rounds);
    // In round 0 no source has spent any budget yet (at most 6 misses per
    // daemon against a limit of 10), so every refusal there is the plain 403 —
    // the answer an unknown code gets. Deterministic, not timing-dependent.
    assert.deepEqual(
      loserStatuses[0],
      new Array(racersPerDaemon * 2 - 1).fill(403),
      `round 0 refusals were ${JSON.stringify(loserStatuses[0])}`,
    );
    // Deliberately NOT asserted: which daemon wins, or that both do. That is
    // decided by kernel scheduling, and asserting it would be a coin flip.
    assert.equal(winners.length, rounds);
    assert.ok(!/pairing listener failed to bind/.test(a.output() + b.output()));
  } finally {
    for (const child of daemons) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  }
});

// The unauthenticated listener must never describe the host. The reported
// leaks were an ENOENT carrying absolute filesystem paths (the fixed-name
// devices.json.tmp collision) and, on sqlite, "database is locked".
test("an internal failure on the pairing listener returns a fixed message, not host detail", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  const original = store.saveDevice;
  const leakyMessage =
    "ENOENT: no such file or directory, rename '/var/folders/zz/relayd/devices.json.tmp' -> '/var/folders/zz/relayd/devices.json'";
  try {
    // Persistence fails the way it did in the report: an error with no `status`.
    store.saveDevice = () => {
      throw Object.assign(new Error(leakyMessage), { code: "ENOENT" });
    };
    const session = pairing.createPairingSession();
    const blob = deviceBlobFor({ csrPem: makeCsr("leaky"), deviceName: "Leaky", platform: "ios" });
    const response = await postPair(port, pairBody(session, blob));

    assert.equal(response.status, 500);
    assert.deepEqual(response.json, { error: "internal error" });
    const wire = JSON.stringify(response.json);
    assert.ok(!wire.includes("ENOENT"), `errno leaked: ${wire}`);
    assert.ok(!wire.includes("/var/folders"), `host path leaked: ${wire}`);
    assert.ok(!wire.includes("devices.json"), `internal filename leaked: ${wire}`);
    // …but the operator can still see what happened, server-side.
    const audit = fs.readFileSync(config.auditPath, "utf8");
    assert.ok(audit.includes("pairing_request_failed"), "the failure must be audited");
    assert.ok(audit.includes("devices.json"), "the audit record keeps the real cause");
  } finally {
    store.saveDevice = original;
    await new Promise((resolve) => server.close(resolve));
  }
});

test("errors we raised deliberately still reach the client with their own message", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    // 400 (shaping), 403 (bad code) and the tag failure keep their text: they
    // carry an integer status, so they were written for the caller.
    assert.match((await postPair(port, {})).json.error, /code is required/);
    const unknown = await postPair(port, {
      v: 2,
      code: "ZZZZ-ZZZZ",
      blob: Buffer.from("{}").toString("base64"),
      tag: "AAAA",
    });
    assert.equal(unknown.status, 403);
    assert.equal(unknown.json.error, "pairing code is invalid or expired");

    const session = pairing.createPairingSession();
    const blob = deviceBlobFor({ csrPem: makeCsr("kept"), deviceName: "Kept", platform: "ios" });
    const tampered = await postPair(port, pairBody(session, blob, { tamperTag: true }));
    assert.equal(tampered.status, 403);
    assert.equal(tampered.json.error, "pairing blob authentication failed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Unit-level guard on the same rule, so a future refactor of the listener
// cannot quietly reintroduce the leak.
test("sendPairError forwards only messages that carry an integer status", () => {
  const capture = () => {
    const state = { status: null, body: "" };
    return {
      state,
      res: {
        writeHead(code) {
          state.status = code;
          return this;
        },
        setHeader() {},
        end(chunk) {
          if (chunk) state.body += chunk;
        },
      },
    };
  };

  const opaque = capture();
  pairing.sendPairError(opaque.res, new Error("database is locked"));
  assert.equal(opaque.state.status, 500);
  assert.deepEqual(JSON.parse(opaque.state.body), { error: "internal error" });

  const deliberate = capture();
  pairing.sendPairError(deliberate.res, Object.assign(new Error("code is required"), { status: 400 }));
  assert.equal(deliberate.state.status, 400);
  assert.deepEqual(JSON.parse(deliberate.state.body), { error: "code is required" });

  // A non-Error rejection is still opaque, never stringified onto the wire.
  const thrownString = capture();
  pairing.sendPairError(thrownString.res, "/etc/relayd/secret.json is unreadable");
  assert.equal(thrownString.state.status, 500);
  assert.deepEqual(JSON.parse(thrownString.state.body), { error: "internal error" });
});

// CHANGED BEHAVIOR (was: "pairing attempts are rate limited with 429" — a
// single global counter that ANY unauthenticated caller could fill). Blind
// guessing is still throttled, but per source, and only failed attempts count.
test("blind guessing is rate limited per source with 429", () => {
  pairing.resetPairingState();
  pairing.createPairingSession();
  let sawRateLimit = false;
  for (let i = 0; i < 12; i += 1) {
    try {
      pairing.consumePairingSecret("WRNG-CODE", { source: "203.0.113.7" });
    } catch (error) {
      if (error.status === 429) {
        sawRateLimit = true;
        break;
      }
      assert.equal(error.status, 403);
    }
  }
  assert.ok(sawRateLimit, "expected a 429 after repeated bad attempts from one source");

  // Another source has its own budget: one address cannot spend everyone's.
  assert.throws(
    () => pairing.consumePairingSecret("WRNG-CODE", { source: "198.51.100.4" }),
    (error) => error.status === 403,
  );
  // IPv4-mapped IPv6 is the same source as the bare form, not a fresh budget.
  assert.throws(
    () => pairing.consumePairingSecret("WRNG-CODE", { source: "::ffff:203.0.113.7" }),
    (error) => error.status === 429,
  );
});

// The lockout the verifier executed: 10 junk attempts, then the owner's real
// code. It must still redeem — a valid secret is never gated on a counter that
// unauthenticated traffic can move.
test("unauthenticated junk attempts cannot lock the owner out of pairing", () => {
  pairing.resetPairingState();
  const session = pairing.createPairingSession();
  for (let i = 0; i < 25; i += 1) {
    assert.throws(
      () => pairing.consumePairingSecret("ZZZZ-ZZZZ", { source: "203.0.113.9" }),
      (error) => error.status === 403 || error.status === 429,
    );
  }
  // Same source, same window, real code: succeeds.
  assert.equal(pairing.consumePairingSecret(session.code, { source: "203.0.113.9" }).id, session.id);
  // …and it consumed none of anyone's budget, so an unrelated source is still
  // only at its own count.
  assert.throws(
    () => pairing.consumePairingSecret("ZZZZ-ZZZZ", { source: "192.0.2.5" }),
    (error) => error.status === 403,
  );
});

// The same attack over the wire, end to end, exactly as reported: ten junk
// POSTs from one client, then a legitimate pairing from that same client.
test("HTTP: junk POSTs to /v1/pair do not deny a legitimate pairing", async () => {
  pairing.resetPairingState();
  const server = await pairing.startPairingListener({ host: "127.0.0.1", port: 0 });
  const port = server.address().port;
  try {
    const session = pairing.createPairingSession();
    const junk = { v: 2, code: "ZZZZ-ZZZZ", blob: Buffer.from("{}").toString("base64"), tag: "AAAA" };
    for (let i = 0; i < 10; i += 1) {
      const response = await postPair(port, junk);
      assert.ok(
        response.status === 403 || response.status === 429,
        `junk attempt ${i} unexpectedly returned ${response.status}`,
      );
    }
    const blob = deviceBlobFor({ csrPem: makeCsr("not-locked-out"), deviceName: "Owner", platform: "ios" });
    const legit = await postPair(port, pairBody(session, blob));
    assert.equal(legit.status, 201, `owner was locked out: ${JSON.stringify(legit.json)}`);
    assert.match(readNodeBlob(session, legit.json).certificatePem, /BEGIN CERTIFICATE/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
// The pairing listener's ADDRESS (the regression that crashed co-located
// daemons and published a cert-minting endpoint off-box).
// ---------------------------------------------------------------------------

// Reads config.mjs in a child process with a chosen environment. config is
// evaluated at import time, so this is the only way to test its defaults.
function readConfigIn(env) {
  const script = [
    'const c = await import(process.env.RELAY_TEST_CONFIG_URL);',
    'process.stdout.write(JSON.stringify({',
    '  pairingHost: c.pairingHost,',
    '  pairingPort: c.pairingPort,',
    '  pairingEnabled: c.pairingEnabled,',
    '  host: c.host,',
    '  port: c.port,',
    '  loopbackOnly: c.pairingIsLoopbackOnly(),',
    '  endpoint: c.pairingEndpointUrl(),',
    '}));',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 120000,
    env: {
      ...process.env,
      RELAY_TEST_CONFIG_URL: new URL("../src/config.mjs", import.meta.url).href,
      CODEX_DATA_DIR: fs.mkdtempSync(path.join(tmpRoot, "cfg-")),
      // Pin the inputs under test so an ambient value cannot decide the result.
      RELAYD_PAIRING_ENABLED: "true",
      RELAYD_PAIRING_HOST: "",
      RELAYD_PAIRING_PORT: "",
      RELAYD_PAIRING_ADVERTISE: "",
      ...env,
    },
  });
  assert.equal(result.status, 0, `config child failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

test("the pairing listener never inherits CODEX_API_HOST or CODEX_API_PORT", () => {
  // The documented gateway deployment: the DATA listener on every interface
  // behind a TLS terminator. The pairing listener must NOT follow it there —
  // it is plain HTTP, it needs no client certificate, and it mints device
  // certificates. Exposing it is an explicit opt-in.
  const gateway = readConfigIn({ CODEX_API_HOST: "0.0.0.0", CODEX_API_PORT: "8787" });
  assert.equal(gateway.host, "0.0.0.0");
  assert.equal(gateway.pairingHost, "127.0.0.1", "pairing must default to loopback, not CODEX_API_HOST");
  assert.equal(gateway.loopbackOnly, true);

  // And it must not claim CODEX_API_PORT + 1 — a port nobody allocated, which
  // is exactly how one relayd killed another with EADDRINUSE.
  assert.equal(gateway.pairingPort, 0, "an unset RELAYD_PAIRING_PORT means 'let the kernel choose'");
  assert.notEqual(gateway.pairingPort, 8788);
  assert.match(gateway.endpoint, /^http:\/\/127\.0\.0\.1:(<pairing-port>|\d+)\/v1\/pair$/);

  // Explicit opt-ins are still honored exactly as configured.
  const explicit = readConfigIn({
    CODEX_API_HOST: "127.0.0.1",
    CODEX_API_PORT: "8787",
    RELAYD_PAIRING_HOST: "0.0.0.0",
    RELAYD_PAIRING_PORT: "9999",
  });
  assert.equal(explicit.pairingHost, "0.0.0.0");
  assert.equal(explicit.pairingPort, 9999);
  assert.equal(explicit.loopbackOnly, false);
  assert.equal(explicit.endpoint, "http://<node-address>:9999/v1/pair");
});

test("two relayd daemons on adjacent ports coexist", async () => {
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");

  const bindable = (port) =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
  const ephemeral = () =>
    new Promise((resolve) => {
      const probe = net.createServer();
      probe.listen(0, "127.0.0.1", () => {
        const value = probe.address().port;
        probe.close(() => resolve(value));
      });
    });

  // A port P where P+1 is also free — the exact adjacency the old
  // "pairingPort = CODEX_API_PORT + 1" default turned into a crash.
  let first = null;
  for (let i = 0; i < 20 && first === null; i += 1) {
    const candidate = await ephemeral();
    if (candidate < 65535 && (await bindable(candidate + 1))) first = candidate;
  }
  assert.ok(first, "could not find a free adjacent port pair");
  const second = first + 1;

  const daemons = [];
  const startDaemon = async (port) => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, `adjacent-${port}-`));
    const workspaceDir = path.join(dir, "scratch");
    fs.mkdirSync(workspaceDir, { recursive: true });
    const env = {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
      CODEX_DATA_DIR: path.join(dir, "data"),
      RELAYD_IDENTITY_DIR: path.join(dir, "identity"),
      CODEX_WORKSPACE_BROWSE_ROOT: dir,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
      // Pairing left at its DEFAULTS on purpose: that is what regressed.
      RELAYD_PAIRING_ENABLED: "true",
      RELAYD_PAIRING_PORT: "",
      RELAYD_PAIRING_HOST: "",
      RELAYD_PAIRING_ADVERTISE: "",
    };
    const child = spawn(process.execPath, [path.join(repoRelaydDir, "src", "index.mjs")], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    daemons.push(child);
    const watch = watchChild(child, `relayd(api ${port})`);
    await waitForServer(`http://127.0.0.1:${port}`, { exited: watch.exited, output: watch.output });
    return { child, env, dataDir: path.join(dir, "data"), output: watch.output };
  };

  try {
    const a = await startDaemon(first);
    // Under the old default, daemon A also owns `second` and this dies with
    // EADDRINUSE.
    const b = await startDaemon(second);

    // Both are serving their own data listener…
    assert.equal((await fetch(`http://127.0.0.1:${first}/healthz`)).ok, true);
    assert.equal((await fetch(`http://127.0.0.1:${second}/healthz`)).ok, true);

    // …and each pairing listener bound a kernel-assigned port that is neither
    // daemon's data port, recorded so `relayd pair` can print it.
    for (const [daemon, apiPort] of [
      [a, first],
      [b, second],
    ]) {
      const match = /relayd pairing listener on http:\/\/127\.0\.0\.1:(\d+)\/v1\/pair/.exec(daemon.output());
      assert.ok(match, `no pairing listener line from the daemon on ${apiPort}: ${daemon.output()}`);
      const pairPort = Number(match[1]);
      assert.notEqual(pairPort, first);
      assert.notEqual(pairPort, second);
      const record = JSON.parse(fs.readFileSync(path.join(daemon.dataDir, "pairing", "listener.json"), "utf8"));
      assert.equal(record.port, pairPort, "the bound pairing port must be persisted for `relayd pair`");
      assert.equal(record.host, "127.0.0.1");
      // It is a real, serving listener.
      const probe = await fetch(`http://127.0.0.1:${pairPort}/v1/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(probe.status, 400);

      // …and `relayd pair`, a SEPARATE short-lived process, prints that exact
      // address: with a kernel-assigned port the record is the only way it can
      // know, and printing a wrong URL would be the new onboarding dead end.
      const printed = execFileSync(process.execPath, [path.join(repoRelaydDir, "bin", "relayd"), "pair"], {
        encoding: "utf8",
        env: daemon.env,
        timeout: 120000,
      });
      assert.ok(
        printed.includes(`Pair at: http://127.0.0.1:${pairPort}/v1/pair`),
        `\`relayd pair\` printed the wrong endpoint:\n${printed}`,
      );
    }
  } finally {
    for (const child of daemons) {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        await new Promise((resolve) => child.once("exit", resolve));
      }
    }
  }
});

test("a data-listener port clash is a clean, actionable exit — not a stack trace", async () => {
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");

  // Hold the port so relayd cannot have it.
  const squatter = net.createServer();
  const port = await new Promise((resolve) => {
    squatter.listen(0, "127.0.0.1", () => resolve(squatter.address().port));
  });

  const dir = fs.mkdtempSync(path.join(tmpRoot, "clash-"));
  const workspaceDir = path.join(dir, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  try {
    const child = spawn(process.execPath, [path.join(repoRelaydDir, "src", "index.mjs")], {
      env: {
        ...process.env,
        CODEX_API_HOST: "127.0.0.1",
        CODEX_API_PORT: String(port),
        CODEX_REQUIRE_MTLS: "false",
        CODEX_DATA_DIR: path.join(dir, "data"),
        RELAYD_IDENTITY_DIR: path.join(dir, "identity"),
        CODEX_WORKSPACE_BROWSE_ROOT: dir,
        CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
        RELAYD_PAIRING_ENABLED: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    const exit = await new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));

    assert.equal(exit.code, 1, `expected a clean exit(1), got ${JSON.stringify(exit)}: ${output}`);
    assert.match(output, /cannot bind the data listener on 127\.0\.0\.1:\d+ — address already in use/);
    assert.match(output, /CODEX_API_PORT/);
    // Not an unhandled 'error' event: no node stack trace, no throw dump.
    assert.ok(!/at Server\.|node:internal/.test(output), `expected no stack trace, got: ${output}`);
  } finally {
    await new Promise((resolve) => squatter.close(resolve));
  }
});

// The installer is the only place an operator meets these knobs; it must not
// hide the second listener, must clean up after a refused value, and must not
// claim "READY" while the phone still cannot reach pairing. (Running it needs
// root + apt + systemd, so this asserts on the script itself.)
test("dist/install.sh: valid bash, writes the pairing keys, cleans up, tells the truth", () => {
  const scriptPath = path.join(repoRelaydDir, "dist", "install.sh");
  const syntax = spawnSync("bash", ["-n", scriptPath], { encoding: "utf8", timeout: 120000 });
  assert.equal(syntax.status, 0, `bash -n failed: ${syntax.stderr}`);

  const text = fs.readFileSync(scriptPath, "utf8");
  // The second listener is written into the generated env file, so it is never
  // invisible to the operator who edits CODEX_API_HOST.
  assert.match(text, /env_kv RELAYD_PAIRING_ENABLED true/);
  assert.match(text, /env_kv RELAYD_PAIRING_HOST 127\.0\.0\.1/);
  assert.match(text, /env_kv RELAYD_PAIRING_PORT "\$PAIRING_PORT"/);
  // A refused value no longer strands a temp config in /etc/relayd.
  assert.match(text, /trap 'rm -f "\$ENV_TMP"' EXIT/);
  const tmpIndex = text.indexOf('ENV_TMP="$(mktemp');
  const trapIndex = text.indexOf(`trap 'rm -f "$ENV_TMP"' EXIT`);
  assert.ok(tmpIndex !== -1 && trapIndex > tmpIndex, "the trap must be armed right after mktemp");
  // The verdict folds in reachability instead of claiming READY regardless.
  assert.match(text, /pairing_reachability\(\)/);
  assert.match(text, /ONE STEP LEFT before the phone can pair/);
  assert.match(text, /RELAYD_PAIRING_ADVERTISE/);
});

// The installer used to print "Comma-separated allowed client-cert subject DNs"
// above CODEX_ALLOWED_CERT_SUBJECTS. An RFC 2253 DN CONTAINS commas, so an
// operator who followed that comment pasted CN=device,OU=Devices,O=Relay and
// was 403'd forever. This renders the comment the installer actually emits and
// feeds the example it shows to the parser that has to accept it.
test("dist/install.sh: the allowlist comment documents a format that works", () => {
  const text = fs.readFileSync(path.join(repoRelaydDir, "dist", "install.sh"), "utf8");
  const keyIndex = text.indexOf("env_kv CODEX_ALLOWED_CERT_SUBJECTS");
  assert.ok(keyIndex > 0, "the installer must still write the allowlist key");
  const before = text.slice(0, keyIndex);
  const blockStart = before.lastIndexOf("printf '%s\\n' \\");
  assert.ok(blockStart > 0, "the key must be preceded by a printf comment block");

  // Run the block so the assertions are about what the operator reads, not
  // about the shell quoting that produces it.
  const rendered = spawnSync("bash", ["-c", before.slice(blockStart).trim()], {
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(rendered.status, 0, `rendering the comment failed: ${rendered.stderr}`);
  const comment = rendered.stdout;

  assert.ok(
    !/comma-separated allowed client-cert subject dns/i.test(comment),
    `the installer still steers operators into the broken format:\n${comment}`,
  );
  assert.match(comment, /JSON-ARRAY FORM/, `no working format is shown:\n${comment}`);

  // The example it prints must be a value the parser actually accepts as ONE
  // multi-RDN DN — the whole point of the correction.
  const example = /CODEX_ALLOWED_CERT_SUBJECTS='([^']+)'/.exec(comment);
  assert.ok(example, `no copy-pasteable example in:\n${comment}`);
  assert.deepEqual(config.parseCertSubjectList(example[1]), ["CN=device,OU=Devices,O=Relay"]);
  // And the form the old comment recommended still does not work, which is
  // why the comment had to change.
  assert.deepEqual(config.parseCertSubjectList("CN=device,OU=Devices,O=Relay"), [
    "CN=device",
    "OU=Devices",
    "O=Relay",
  ]);
});
