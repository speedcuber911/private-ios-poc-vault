import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-data-"));
// pairing.mjs transitively imports jobs.mjs -> workspaces.mjs, whose default
// workspace list mkdir's hardcoded /srv/codex-workspaces/* paths at import
// time. Point it at a scratch dir so import doesn't fail outside prod hosts
// (mirrors the setup in test/pairing.test.mjs and test/identity.test.mjs).
if (!process.env.CODEX_WORKSPACES) {
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-ws-"));
  fs.mkdirSync(path.join(wsRoot, "scratch"), { recursive: true });
  process.env.CODEX_WORKSPACE_BROWSE_ROOT ||= wsRoot;
  process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "scratch", name: "Scratch", path: path.join(wsRoot, "scratch") }]);
}

const { pairingKeys, blobTag, verifyBlobTag, DEVICE_SLOT, NODE_SLOT } = await import("../src/pairing.mjs");
const { initIdentity } = await import("../src/identity.mjs");
const { runTrialPairing } = await import("../src/trialpair.mjs");

// Minimal in-process rendezvous implementing the cloud contract for one session.
function startFakeRendezvous(pairingId, expectedAuthToken) {
  const slots = { "device-blob": null, "node-blob": null };
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const m = req.url.match(/^\/v1\/pairing\/sessions\/([^/]+)\/(device-blob|node-blob)$/);
      if (!m || m[1] !== pairingId || req.headers["x-pairing-auth"] !== expectedAuthToken) {
        res.writeHead(401).end();
        return;
      }
      const slot = m[2];
      if (req.method === "GET") {
        if (!slots[slot]) {
          res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not_posted_yet"}');
          return;
        }
        res.writeHead(200, { "x-pairing-tag": slots[slot].tag }).end(slots[slot].blob);
        return;
      }
      if (req.method === "POST") {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          slots[slot] = { blob: Buffer.concat(chunks), tag: String(req.headers["x-pairing-tag"] || "") };
          res.writeHead(204).end();
        });
        return;
      }
      res.writeHead(405).end();
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ slots, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

test("runTrialPairing issues a cert and posts a MAC-tagged p12 the device passphrase opens", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-id-"));
  initIdentity({ baseDir });

  const secret = crypto.randomBytes(24).toString("base64url");
  const keys = pairingKeys(secret);
  const pairingId = crypto.randomUUID();
  const rv = await startFakeRendezvous(pairingId, keys.authToken);
  try {
    // Phone side: post the device blob first.
    const deviceBlob = Buffer.from(JSON.stringify({ deviceName: "Test iPhone", platform: "ios" }), "utf8");
    await fetch(`${rv.url}/v1/pairing/sessions/${pairingId}/device-blob`, {
      method: "POST",
      headers: { "x-pairing-auth": keys.authToken, "x-pairing-tag": blobTag(keys.macKey, DEVICE_SLOT, deviceBlob) },
      body: deviceBlob,
    });

    const out = await runTrialPairing({ cloudUrl: rv.url, pairingId, secret, baseDir, pollIntervalMs: 10 });
    assert.match(out.certSerial, /^[0-9A-F]+$/);

    // Node blob is a valid, MAC-tagged p12 the derived passphrase opens.
    const posted = rv.slots["node-blob"];
    assert.ok(posted, "node blob posted");
    assert.equal(verifyBlobTag(keys.macKey, NODE_SLOT, posted.blob, posted.tag), true);

    const passphrase = crypto.createHmac("sha256", Buffer.from(secret, "utf8")).update("relay-trial-p12-v1").digest("hex");
    const p12Path = path.join(baseDir, "check.p12");
    fs.writeFileSync(p12Path, posted.blob);
    const dump = execFileSync(
      "openssl",
      ["pkcs12", "-in", p12Path, "-passin", "env:RELAY_P12_PASS", "-nokeys", "-clcerts"],
      { encoding: "utf8", env: { ...process.env, RELAY_P12_PASS: passphrase } },
    );
    assert.match(dump, /BEGIN CERTIFICATE/);

    // No stray private material left in tmp/.
    const tmpDir = path.join(baseDir, "tmp");
    assert.deepEqual(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : [], []);
  } finally {
    await rv.close();
  }
});

test("runTrialPairing rejects a tampered device blob", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-tp-id2-"));
  initIdentity({ baseDir });
  const secret = crypto.randomBytes(24).toString("base64url");
  const keys = pairingKeys(secret);
  const pairingId = crypto.randomUUID();
  const rv = await startFakeRendezvous(pairingId, keys.authToken);
  try {
    const deviceBlob = Buffer.from(JSON.stringify({ deviceName: "Evil", platform: "ios" }), "utf8");
    await fetch(`${rv.url}/v1/pairing/sessions/${pairingId}/device-blob`, {
      method: "POST",
      headers: { "x-pairing-auth": keys.authToken, "x-pairing-tag": blobTag(keys.macKey, DEVICE_SLOT, Buffer.from("other")) },
      body: deviceBlob,
    });
    await assert.rejects(() => runTrialPairing({ cloudUrl: rv.url, pairingId, secret, baseDir, pollIntervalMs: 10 }), /trial_pair_bad_tag/);
  } finally {
    await rv.close();
  }
});
