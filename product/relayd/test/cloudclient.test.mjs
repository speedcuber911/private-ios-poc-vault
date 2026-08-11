import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-data-"));

const { initIdentity, identityPaths } = await import("../src/identity.mjs");
const { createCloudClient } = await import("../src/cloudclient.mjs");

const SIGNING_LABEL = "relay-node-req-v1";

function startFakeCloud(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
        handler(res, calls.at(-1), calls);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

function freshNode() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-"));
  const status = initIdentity({ baseDir });
  const paths = identityPaths(baseDir);
  const publicKey = crypto.createPublicKey(fs.readFileSync(paths.identityPubPath, "utf8"));
  return { baseDir, nodeId: status.nodeId, publicKey };
}

test("pollHandoffs signs the exact method, path, node id, and timestamp", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x" }] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    const handoffs = await client.pollHandoffs(20);

    assert.deepEqual(handoffs, [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x" }]);
    const call = cloud.calls[0];
    assert.equal(call.url, "/v1/node/handoffs?wait=20");
    assert.equal(call.headers["x-relay-node"], node.nodeId);

    const input = Buffer.from(
      `${SIGNING_LABEL}\nGET\n/v1/node/handoffs?wait=20\n${node.nodeId}\n${call.headers["x-relay-ts"]}`, "utf8");
    const signature = Buffer.from(call.headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, input, node.publicKey, signature), "the signature verifies against the node key");
  } finally { await cloud.close(); }
});

test("postEvent signs the raw body and advances a persistent sequence", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => {
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const first = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await first.postEvent("handoff.ready", { jobId: "job-1" });
    await first.postEvent("handoff.failed");

    // A fresh client stands in for a daemon restart: the sequence must not reset.
    const second = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await second.postEvent("handoff.ready");

    const bodies = cloud.calls.map((call) => JSON.parse(call.raw.toString("utf8")));
    assert.deepEqual(bodies.map((body) => body.seq), [1, 2, 3]);
    assert.deepEqual(bodies.map((body) => body.type), ["handoff.ready", "handoff.failed", "handoff.ready"]);
    assert.equal(bodies[0].jobId, "job-1");
    assert.equal(bodies[1].jobId, null);
    assert.equal(bodies[0].nodeId, node.nodeId);
    assert.equal(bodies[0].v, 1);

    const signature = Buffer.from(cloud.calls[0].headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, cloud.calls[0].raw, node.publicKey, signature),
      "the event signature covers the exact raw body");
  } finally { await cloud.close(); }
});

test("a non-200 poll surfaces as an error rather than a silent empty list", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => { res.writeHead(503); res.end("{}"); });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await assert.rejects(() => client.pollHandoffs(5), /cloud_poll_503/);
  } finally { await cloud.close(); }
});

test("a node without an identity refuses to build a client", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-empty-"));
  assert.throws(() => createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir }), /cloud_client_no_identity/);
});
