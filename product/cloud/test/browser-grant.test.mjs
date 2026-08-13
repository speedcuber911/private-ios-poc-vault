import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { startTestApp, api, signIn, authed, makeNodeIdentity } from "./helpers.mjs";
import { decodeJwtUnsafe, verifyEd25519, verifyHS256 } from "../src/jwt.js";

function fakeProvisioner() {
  const writes = [];
  return {
    writes,
    async createSandbox() { return { sandboxId: "sbx_1" }; },
    async writeSandboxFile(sandboxId, filePath, content) {
      writes.push({ sandboxId, filePath, content });
      return true;
    },
    async killSandbox() { return true; },
    async pauseSandbox() { return true; },
  };
}

function grantKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
    publicRaw: publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("base64url"),
  };
}

function grantEnv(keys, extra = {}) {
  return {
    BROWSER_GRANT_PRIVATE_KEY: keys.privatePem,
    BROWSER_GRANT_PUBLIC_KEY: keys.publicRaw,
    GRANT_GATEWAY_URL: "https://gateway.example.test",
    ...extra,
  };
}

const TRIAL_ENV = {
  E2B_API_URL: "http://cube.invalid",
  E2B_API_KEY: "k",
  TRIAL_TEMPLATE_ID: "relay-trial",
  TUNNEL_HOST: "broker.test",
  TUNNEL_PORT: "80",
  TUNNEL_SUFFIX: ".tun.test",
};
const PAIRING = {
  pairingId: "11111111-1111-4111-8111-111111111111",
  pairingSecret: "c2VjcmV0LXNlY3JldC1zZWNyZXQ",
};

test("mints an Ed25519 grant for the account's own node", async () => {
  const keys = grantKeys();
  const t = await startTestApp({
    env: {
      BROWSER_GRANT_PRIVATE_KEY: keys.privatePem,
      BROWSER_GRANT_PUBLIC_KEY: keys.publicRaw,
      GRANT_GATEWAY_URL: "https://gateway.example.test",
    },
  });
  try {
    const session = await signIn(t);
    const node = t.app.registry.createNode(session.accountId, {
      kind: "trial",
      pubkey: makeNodeIdentity().pubkeyPem,
    });
    const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(session.sessionToken));
    assert.equal(res.status, 201);
    assert.equal(res.json.gatewayUrl, "https://gateway.example.test");
    assert.equal(res.json.expiresIn, 900);
    const payload = verifyEd25519(res.json.grant, keys.publicKey);
    assert.equal(payload.sub, session.accountId);
    assert.equal(payload.node, node.id);
    assert.deepEqual(payload.scope, ["jobs.read", "threads.read", "events.read"]);
    assert.equal(typeof payload.jti, "string");
  } finally { await t.close(); }
});

test("foreign node is 404 and does not leak existence", async () => {
  const keys = grantKeys();
  const t = await startTestApp({
    env: { BROWSER_GRANT_PRIVATE_KEY: keys.privatePem, GRANT_GATEWAY_URL: "https://gateway.example.test" },
  });
  try {
    const owner = await signIn(t, { sub: "owner", email: "o@example.com" });
    const other = await signIn(t, { sub: "other", email: "x@example.com" });
    const node = t.app.registry.createNode(owner.accountId, {
      kind: "trial",
      pubkey: makeNodeIdentity().pubkeyPem,
    });
    const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(other.sessionToken));
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: "not_found" });
  } finally { await t.close(); }
});

test("unknown node returns the same 404 body as a foreign node", async () => {
  const keys = grantKeys();
  const t = await startTestApp({ env: grantEnv(keys) });
  try {
    const session = await signIn(t);
    const res = await api(
      t.baseUrl,
      "POST",
      "/v1/nodes/node-ffffffffffffffff/browser-grants",
      authed(session.sessionToken),
    );
    assert.equal(res.status, 404);
    assert.deepEqual(res.json, { error: "not_found" });
  } finally { await t.close(); }
});

test("unset private key or gateway returns 503 grants_unavailable", async () => {
  const keys = grantKeys();
  for (const env of [
    { BROWSER_GRANT_PUBLIC_KEY: keys.publicRaw, GRANT_GATEWAY_URL: "https://gateway.example.test" },
    { BROWSER_GRANT_PRIVATE_KEY: keys.privatePem, BROWSER_GRANT_PUBLIC_KEY: keys.publicRaw },
  ]) {
    const t = await startTestApp({ env });
    try {
      const session = await signIn(t);
      const node = t.app.registry.createNode(session.accountId, {
        kind: "trial",
        pubkey: makeNodeIdentity().pubkeyPem,
      });
      const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(session.sessionToken));
      assert.equal(res.status, 503);
      assert.deepEqual(res.json, { error: "grants_unavailable" });
    } finally { await t.close(); }
  }
});

test("grant is EdDSA, not HMAC, even if BROWSER_GRANT_SECRET is set", async () => {
  const keys = grantKeys();
  const t = await startTestApp({
    env: grantEnv(keys, { BROWSER_GRANT_SECRET: "this-must-not-be-used-as-an-hmac-key" }),
  });
  try {
    const session = await signIn(t);
    const node = t.app.registry.createNode(session.accountId, {
      kind: "trial",
      pubkey: makeNodeIdentity().pubkeyPem,
    });
    const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(session.sessionToken));
    assert.equal(res.status, 201);
    const decoded = decodeJwtUnsafe(res.json.grant);
    assert.equal(decoded.header.alg, "EdDSA");
    assert.ok(verifyEd25519(res.json.grant, keys.publicKey));
    assert.equal(
      verifyHS256(res.json.grant, "this-must-not-be-used-as-an-hmac-key"),
      null,
    );
  } finally { await t.close(); }
});

test("minted grant expires after 900 seconds", async () => {
  const keys = grantKeys();
  const clock = { t: Date.now() };
  const t = await startTestApp({ env: grantEnv(keys), clock });
  try {
    const session = await signIn(t);
    const node = t.app.registry.createNode(session.accountId, {
      kind: "trial",
      pubkey: makeNodeIdentity().pubkeyPem,
    });
    const res = await api(t.baseUrl, "POST", `/v1/nodes/${node.id}/browser-grants`, authed(session.sessionToken));
    assert.equal(res.status, 201);
    const payload = verifyEd25519(res.json.grant, keys.publicKey, clock.t);
    assert.equal(payload.exp, Math.floor(clock.t / 1000) + 900);
    assert.equal(payload.iat, Math.floor(clock.t / 1000));
    assert.ok(verifyEd25519(res.json.grant, keys.publicKey, clock.t + 899_000));
    assert.equal(verifyEd25519(res.json.grant, keys.publicKey, clock.t + 900_000), null);
  } finally { await t.close(); }
});

test("enroll.json includes grantPublicKey when configured", async () => {
  const keys = grantKeys();
  const provisioner = fakeProvisioner();
  const t = await startTestApp({
    env: { ...TRIAL_ENV, ...grantEnv(keys) },
    provisioner,
  });
  try {
    const session = await signIn(t);
    const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", {
      body: PAIRING,
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);
    const cfg = JSON.parse(provisioner.writes[0].content);
    assert.equal(cfg.grantPublicKey, keys.publicRaw);
  } finally { await t.close(); }
});

test("enroll.json omits grantPublicKey when unset so existing phones still work", async () => {
  const provisioner = fakeProvisioner();
  const t = await startTestApp({ env: TRIAL_ENV, provisioner });
  try {
    const session = await signIn(t);
    const res = await api(t.baseUrl, "POST", "/v1/trial-nodes", {
      body: PAIRING,
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);
    const cfg = JSON.parse(provisioner.writes[0].content);
    assert.equal("grantPublicKey" in cfg, false);
  } finally { await t.close(); }
});
