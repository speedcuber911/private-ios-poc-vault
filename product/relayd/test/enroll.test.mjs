import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-data-"));

const { enrollWithCloud } = await import("../src/enroll.mjs");

function startFakeCloud(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        handler(res, calls.at(-1));
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }),
    );
  });
}

test("enrollWithCloud initializes identity and registers the pubkey", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-id-"));
  const cloud = await startFakeCloud((res, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sni: `${call.body.nodeId}.tun.test` }));
  });
  try {
    const out = await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-1", version: "0.1.0", baseDir });
    assert.match(out.nodeId, /^node-[0-9a-f]{16}$/);
    assert.equal(out.sni, `${out.nodeId}.tun.test`);

    // nodeId is lowercase hex (`node-${randomBytes(8).toString("hex")}`); the
    // regex above only pins lowercase when the draw contains a letter a-f —
    // an all-digit 16-char draw (~0.0546% of draws) can't distinguish a case
    // regression, since digits are case-invariant. Retry with fresh
    // identities against the same fake cloud until a letter appears, and
    // assert the premise so a stuck loop fails loudly instead of silently
    // passing.
    let letterNodeId = null;
    for (let attempt = 0; attempt < 32; attempt++) {
      const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-nodeid-probe-"));
      const probe = await enrollWithCloud({ cloudUrl: cloud.url, token: `tok-probe-${attempt}`, baseDir: probeDir });
      if (/[a-f]/.test(probe.nodeId)) { letterNodeId = probe.nodeId; break; }
    }
    assert.ok(letterNodeId,
      "could not mint a nodeId containing a hex letter after 32 attempts — the test premise is broken, not the code under test");
    assert.match(letterNodeId, /^node-[0-9a-f]{16}$/);
    assert.doesNotMatch(letterNodeId, /^node-[0-9A-F]{16}$/,
      "sanity: this fixture must actually be capable of catching an uppercase regression");

    const call = cloud.calls[0];
    assert.equal(call.method, "POST");
    assert.equal(call.url, "/v1/trial-nodes/enroll");
    assert.equal(call.body.token, "tok-1");
    assert.equal(call.body.nodeId, out.nodeId);
    assert.match(call.body.pubkey, /BEGIN PUBLIC KEY/);

    // Idempotent: same identity on a second run.
    const again = await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-2", baseDir });
    assert.equal(again.nodeId, out.nodeId);
  } finally {
    await cloud.close();
  }
});

test("enrollWithCloud surfaces cloud rejection", async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-id2-"));
  const cloud = await startFakeCloud((res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid_enroll_token" }));
  });
  try {
    await assert.rejects(() => enrollWithCloud({ cloudUrl: cloud.url, token: "bad", baseDir }), /enroll_failed_401/);
  } finally {
    await cloud.close();
  }
});

test("enroll publishes the node encryption public key", async () => {
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sni: "node-x.tun.test" }));
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-enc-"));
  try {
    await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-enc", baseDir });

    const body = cloud.calls.at(-1).body;
    assert.equal(Buffer.from(body.encPubkey, "base64").length, 32, "encPubkey is 32 raw bytes");
    assert.match(body.pubkey, /BEGIN PUBLIC KEY/, "the ed25519 identity key is still sent as PEM");
  } finally { await cloud.close(); }
});

test("re-enrolling reuses the same encryption key", async () => {
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, sni: "node-x.tun.test" }));
  });
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-enroll-enc2-"));
  try {
    await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-one", baseDir });
    await enrollWithCloud({ cloudUrl: cloud.url, token: "tok-two", baseDir });
    assert.equal(cloud.calls[0].body.encPubkey, cloud.calls[1].body.encPubkey);
  } finally { await cloud.close(); }
});
