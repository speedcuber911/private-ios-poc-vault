import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parsePairingLink, readDirectConfig, requestJsonPinned, spkiPin, writeDirectConfig } from "../src/direct.mjs";
import { chooseWorkspace, cmdSyncSessions } from "../src/commands/syncsessions.mjs";

const ID = "11111111-2222-4333-8444-555555555555";

function invite() {
  const b64 = (value) => Buffer.from(value).toString("base64url");
  return `https://get.openrelay.sh/pair#v=1&n=node-1&m=EC2&t=${"a".repeat(32)}` +
    `&p=${b64("https://203.0.113.7:8891/v1/pair")}` +
    `&a=${b64("https://203.0.113.7:8890")}&f=${"b".repeat(43)}`;
}

test("direct config is private and pairing links retain both direct endpoints", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-direct-config-"));
  const parsed = parsePairingLink(invite());
  assert.equal(parsed.nodeId, "node-1");
  assert.equal(parsed.pairUrl, "https://203.0.113.7:8891/v1/pair");
  assert.equal(parsed.apiBaseUrl, "https://203.0.113.7:8890");
  writeDirectConfig({
    nodeId: "node-1", nodeName: "EC2", apiBaseUrl: parsed.apiBaseUrl,
    deviceToken: "c".repeat(64), caPem: "certificate", workspaceMappings: {},
  }, { home });
  assert.equal(fs.statSync(path.join(home, ".relay", "direct.json")).mode & 0o777, 0o600);
  assert.equal(readDirectConfig({ home }).nodeId, "node-1");
  const insecure = invite().replace(
    Buffer.from("https://203.0.113.7:8891/v1/pair").toString("base64url"),
    Buffer.from("http://203.0.113.7:8891/v1/pair").toString("base64url"),
  );
  assert.throws(() => parsePairingLink(insecure), /pairing_link_insecure_pair_url/);
});

test("the pairing request sends its secret only on a TLS connection matching the QR pin", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-pin-"));
  try {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
      "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
      "-days", "1", "-addext", "subjectAltName=IP:127.0.0.1",
    ], { stdio: "ignore" });
  } catch {
    t.skip("openssl is unavailable");
    return;
  }
  const cert = fs.readFileSync(path.join(dir, "cert.pem"));
  let received = null;
  const server = https.createServer({
    key: fs.readFileSync(path.join(dir, "key.pem")), cert,
  }, (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      received = Buffer.concat(chunks).toString("utf8");
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `https://127.0.0.1:${server.address().port}/v1/pair`;
  try {
    const accepted = await requestJsonPinned(endpoint, spkiPin(cert), { secret: "accepted" });
    assert.equal(accepted.status, 201);
    assert.equal(JSON.parse(received).secret, "accepted");
    received = null;
    await assert.rejects(
      requestJsonPinned(endpoint, "z".repeat(43), { secret: "must-not-arrive" }),
      /pairing_certificate_pin_mismatch/,
    );
    assert.equal(received, null, "a mismatched TLS peer must receive no HTTP request body");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("workspace selection remembers an explicit match and can infer a unique repo name", () => {
  const workspaces = [
    { id: "scratch", name: "Scratch", path: "/srv/codex-workspaces/scratch" },
    { id: "poc-vault", name: "POC Vault", path: "/srv/codex-workspaces/poc-vault" },
  ];
  assert.equal(chooseWorkspace(workspaces, {
    root: "/Users/dev/private-ios-poc-vault", explicit: null, mapped: null,
  }).id, "poc-vault");
  assert.equal(chooseWorkspace(workspaces, {
    root: "/Users/dev/anything", explicit: "scratch", mapped: null,
  }).id, "scratch");
  assert.equal(chooseWorkspace(workspaces, {
    root: "/Users/dev/anything", explicit: null, mapped: "dir-projects-repo",
  }).id, "dir-projects-repo", "a remembered dynamic workspace survives a relayd restart");
  assert.equal(chooseWorkspace(workspaces, {
    root: "/Users/dev/anything", explicit: "dir-projects-repo",
    mapped: { id: "dir-projects-repo", name: "Projects / repo", path: "/home/dev/projects/repo" },
  }).path, "/home/dev/projects/repo", "an explicit remembered dynamic workspace retains its path");
});

test("sync-sessions uploads native Codex transcripts without reading Git state or committing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sync-cli-"));
  const root = path.join(home, "private-ios-poc-vault");
  fs.mkdirSync(root);
  const transcript = Buffer.from(`${JSON.stringify({
    timestamp: "2026-09-17T10:00:00.000Z",
    type: "session_meta",
    payload: { id: ID, cwd: root, timestamp: "2026-09-17T10:00:00.000Z", provider: "codex" },
  })}\n`);
  const filePath = path.join(home, "rollout.jsonl");
  fs.writeFileSync(filePath, transcript);
  writeDirectConfig({
    nodeId: "node-1", nodeName: "EC2", apiBaseUrl: "https://relay.example",
    deviceToken: "d".repeat(64), caPem: "certificate", workspaceMappings: {},
  }, { home });

  const calls = [];
  const apiRequest = async (_config, endpoint, options = {}) => {
    calls.push({ endpoint, options });
    if (endpoint === "/v1/codex/workspaces") {
      return { status: 200, json: { workspaces: [{ id: "poc-vault", name: "POC Vault", path: "/srv/poc-vault" }] } };
    }
    if (endpoint.endsWith("/plan")) {
      return { status: 200, json: { sessions: [{ id: ID, status: "upload" }] } };
    }
    return { status: 201, json: { status: "imported", sessionId: ID, workspaceId: "poc-vault" } };
  };
  const output = [];
  const result = await cmdSyncSessions([], {
    home, cwd: root, log: (line) => output.push(line), apiRequest,
    findGitRootImpl: async () => root,
    discoverSessionsImpl: () => [{
      id: ID,
      harness: "codex",
      filePath,
      sizeBytes: transcript.length,
      sourceCwd: root,
      createdAt: "2026-09-17T10:00:00.000Z",
      lastActive: "2026-09-17T10:05:00.000Z",
    }],
  });
  assert.equal(result.imported, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].options.body.sessions[0].sha256, crypto.createHash("sha256").update(transcript).digest("hex"));
  assert.equal(Buffer.from(calls[2].options.body.session.transcript, "base64").toString("utf8"), transcript.toString("utf8"));
  assert.deepEqual(readDirectConfig({ home }).workspaceMappings[root], {
    id: "poc-vault",
    name: "POC Vault",
    path: "/srv/poc-vault",
  });
  assert.match(output.join("\n"), /1 imported/);
});

test("sync-sessions streams large rollouts in bounded chunks", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-sync-large-"));
  const root = path.join(home, "repo");
  fs.mkdirSync(root);
  const filePath = path.join(home, "large-rollout.jsonl");
  const sizeBytes = 20 * 1024 * 1024 + 17;
  fs.writeFileSync(filePath, Buffer.alloc(sizeBytes, 0x78));
  writeDirectConfig({
    nodeId: "node-1", nodeName: "EC2", apiBaseUrl: "https://relay.example",
    deviceToken: "d".repeat(64), caPem: "certificate", workspaceMappings: { [root]: "repo" },
  }, { home });
  const chunkOffsets = [];
  const apiRequest = async (_config, endpoint, options = {}) => {
    if (endpoint === "/v1/codex/workspaces") {
      return { status: 200, json: { workspaces: [{ id: "repo", name: "Repo", path: "/srv/repo" }] } };
    }
    if (endpoint.endsWith("/plan")) return { status: 200, json: { sessions: [{ id: ID, status: "upload" }] } };
    if (endpoint.endsWith("/uploads")) {
      assert.equal(options.body.session.sizeBytes, sizeBytes);
      return { status: 201, json: { status: "upload", uploadId: "22222222-2222-4333-8444-555555555555", chunkBytes: 4 * 1024 * 1024 } };
    }
    if (endpoint.endsWith("/chunks")) {
      chunkOffsets.push(options.body.offset);
      assert.ok(Buffer.from(options.body.data, "base64").length <= 4 * 1024 * 1024);
      return { status: 200, json: { status: "uploading" } };
    }
    if (endpoint.endsWith("/complete")) return { status: 201, json: { status: "imported", sessionId: ID } };
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const result = await cmdSyncSessions([], {
    home, cwd: root, log: () => {}, apiRequest,
    findGitRootImpl: async () => root,
    discoverSessionsImpl: () => [{
      id: ID, harness: "codex", filePath, sizeBytes, sourceCwd: root,
      createdAt: "2026-09-17T10:00:00.000Z", lastActive: "2026-09-17T10:05:00.000Z",
    }],
  });
  assert.equal(result.imported, 1);
  assert.deepEqual(chunkOffsets, [0, 4, 8, 12, 16, 20].map((mb) => mb * 1024 * 1024));
});
