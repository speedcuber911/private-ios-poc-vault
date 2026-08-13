import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createGateway } from "../src/server.js";

const JOBS_BODY = '{"jobs":["SECRET_JOB_BODY_MUST_NOT_LOG"]}';

function mintGrant(privateKey, claims = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: "acct-1",
      node: "node-a",
      scope: ["jobs.read", "threads.read", "events.read"],
      iat: now,
      exp: now + 900,
      jti: "jti-1",
      ...claims,
    }),
  ).toString("base64url");
  const sig = cryptoSign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve) => server.listen(0, host, resolve));
  const { port } = server.address();
  return {
    port,
    baseUrl: `http://${host}:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function startFakeNode({ body = JOBS_BODY, status = 200, contentType = "application/json" } = {}) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
    });
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  });
  const bound = await listen(server);
  return { hits, ...bound };
}

async function startGateway({ publicKey, nodeProxyTarget, log = () => {}, now } = {}) {
  const server = createGateway({
    grantPublicKey: publicKey,
    nodeProxyTarget,
    log,
    now,
  });
  const bound = await listen(server);
  return { server, ...bound };
}

test("GET /activity/jobs proxies to the node jobs list with the grant", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node = await startFakeNode();
  const gateway = await startGateway({ publicKey, nodeProxyTarget: node.baseUrl });
  try {
    const grant = mintGrant(privateKey);
    const res = await fetch(`${gateway.baseUrl}/activity/jobs`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { jobs: ["SECRET_JOB_BODY_MUST_NOT_LOG"] });
    assert.equal(node.hits.length, 1);
    assert.equal(node.hits[0].method, "GET");
    assert.equal(node.hits[0].url, "/v1/codex/jobs");
    assert.equal(node.hits[0].authorization, `Bearer ${grant}`);
  } finally {
    await gateway.close();
    await node.close();
  }
});

test("GET /activity/files is 403 and the node is not contacted", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node = await startFakeNode();
  const gateway = await startGateway({ publicKey, nodeProxyTarget: node.baseUrl });
  try {
    const grant = mintGrant(privateKey);
    const res = await fetch(`${gateway.baseUrl}/activity/files`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    assert.equal(res.status, 403);
    assert.equal(node.hits.length, 0);
  } finally {
    await gateway.close();
    await node.close();
  }
});

test("logger is not given the response body", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const logs = [];
  const node = await startFakeNode();
  const gateway = await startGateway({
    publicKey,
    nodeProxyTarget: node.baseUrl,
    log: (...args) => logs.push(args),
  });
  try {
    const grant = mintGrant(privateKey);
    const res = await fetch(`${gateway.baseUrl}/activity/jobs`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), JOBS_BODY);
    const blob = JSON.stringify(logs);
    assert.equal(blob.includes("SECRET_JOB_BODY_MUST_NOT_LOG"), false);
    assert.equal(blob.includes(JOBS_BODY), false);
  } finally {
    await gateway.close();
    await node.close();
  }
});

test("expired grant is 401 and the node is not contacted", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node = await startFakeNode();
  const gateway = await startGateway({ publicKey, nodeProxyTarget: node.baseUrl });
  try {
    const grant = mintGrant(privateKey, { exp: 1 });
    const res = await fetch(`${gateway.baseUrl}/activity/jobs`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    assert.equal(res.status, 401);
    assert.equal(node.hits.length, 0);
  } finally {
    await gateway.close();
    await node.close();
  }
});

test("grant missing node is 403 and the node is not contacted", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node = await startFakeNode();
  const gateway = await startGateway({ publicKey, nodeProxyTarget: node.baseUrl });
  try {
    const grant = mintGrant(privateKey, { node: "" });
    const res = await fetch(`${gateway.baseUrl}/activity/jobs`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    assert.equal(res.status, 403);
    assert.equal(node.hits.length, 0);
  } finally {
    await gateway.close();
    await node.close();
  }
});

test("GET /activity/threads and /activity/events proxy to relayd list paths", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const node = await startFakeNode({ body: '{"ok":true}' });
  const gateway = await startGateway({ publicKey, nodeProxyTarget: node.baseUrl });
  try {
    const grant = mintGrant(privateKey);
    const threads = await fetch(`${gateway.baseUrl}/activity/threads`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    const events = await fetch(`${gateway.baseUrl}/activity/events?since=4`, {
      headers: { authorization: `Bearer ${grant}` },
    });
    assert.equal(threads.status, 200);
    assert.equal(events.status, 200);
    assert.deepEqual(
      node.hits.map((hit) => `${hit.method} ${hit.url}`),
      ["GET /v1/codex/threads", "GET /v1/events?since=4"],
    );
  } finally {
    await gateway.close();
    await node.close();
  }
});
