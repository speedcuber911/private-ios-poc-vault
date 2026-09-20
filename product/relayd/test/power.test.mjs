import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-power-test-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.RELAYD_IDENTITY_DIR = path.join(tmpRoot, "identity");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";
process.env.RELAYD_DIRECT_TLS = "false";

const identity = await import("../src/identity.mjs");
const { wakeToken, wakeTokenHash, discoverPowerTarget, powerCredential, WAKE_LABEL } = await import("../src/power.mjs");
const pairing = await import("../src/pairing.mjs");

identity.initIdentity();

test("wake token is stable, hex, and hashed one-way", () => {
  const first = wakeToken();
  const second = wakeToken();
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(wakeTokenHash(), crypto.createHash("sha256").update(first, "utf8").digest("hex"));
  assert.notEqual(first, wakeTokenHash());
  const secret = fs.readFileSync(identity.identityPaths().wakeSecretPath, "utf8").trim();
  const expected = crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(WAKE_LABEL).digest("hex");
  assert.equal(first, expected);
});

test("pairing blob carries the wake token for both variants", () => {
  const session = pairing.createPairingSession();
  const blob = Buffer.from(JSON.stringify({ mint: "p12", deviceName: "Phone", platform: "ios" }), "utf8");
  const { macKey } = pairing.pairingKeys(session.token);
  const minted = pairing.redeemPairing({
    secret: session.token,
    deviceBlob: blob,
    deviceTag: pairing.blobTag(macKey, pairing.DEVICE_SLOT, blob),
  });
  const body = JSON.parse(minted.nodeBlob.toString("utf8"));
  assert.equal(body.wakeToken, wakeToken());
  assert.equal(body.nodeId, identity.readNodeId());
});

test("discoverPowerTarget uses an explicit instance id and ignores IMDS", async () => {
  const target = await discoverPowerTarget({
    instanceId: "i-0123456789abcdef0",
    region: "ap-south-1",
    fetchImpl: async () => {
      throw new Error("imds should not be consulted");
    },
  });
  assert.deepEqual(target, { instanceId: "i-0123456789abcdef0", region: "ap-south-1" });
});

test("discoverPowerTarget reads IMDSv2 when no instance id is configured", async () => {
  const urls = [];
  const fetchImpl = async (url, init = {}) => {
    urls.push({ url: String(url), method: init.method || "GET" });
    if (String(url).endsWith("/latest/api/token")) {
      return { ok: true, text: async () => "imds-token" };
    }
    if (String(url).endsWith("/latest/meta-data/instance-id")) {
      return { ok: true, text: async () => "i-0aa11bb22cc33dd44" };
    }
    if (String(url).endsWith("/latest/meta-data/placement/region")) {
      return { ok: true, text: async () => "ap-south-1" };
    }
    return { ok: false, text: async () => "" };
  };
  const target = await discoverPowerTarget({ instanceId: null, fetchImpl });
  assert.deepEqual(target, { instanceId: "i-0aa11bb22cc33dd44", region: "ap-south-1" });
  assert.equal(urls[0].method, "PUT");
});

test("discoverPowerTarget skips when power is disabled or IMDS is absent", async () => {
  assert.equal(await discoverPowerTarget({ enabled: false, instanceId: "i-0123456789abcdef0" }), null);
  assert.equal(await discoverPowerTarget({
    instanceId: null,
    fetchImpl: async () => { throw new Error("offline"); },
  }), null);
});

test("power credential names this node and the live wake token", () => {
  const cred = powerCredential();
  assert.equal(cred.v, 1);
  assert.equal(cred.nodeId, identity.readNodeId());
  assert.equal(cred.wakeToken, wakeToken());
});

test("cloudclient.registerPower posts a body signature, not an account session", async () => {
  const { createCloudClient } = await import("../src/cloudclient.mjs");
  let captured;
  const fetchImpl = async (url, init) => {
    captured = { url: String(url), init };
    return { status: 201, json: async () => ({ ok: true }) };
  };
  const client = createCloudClient({
    cloudUrl: "http://power.example",
    baseDir: identity.identityPaths().baseDir,
    fetchImpl,
    now: () => 1_700_000_000_000,
  });
  await client.registerPower({
    instanceId: "i-0123456789abcdef0",
    region: "ap-south-1",
    wakeTokenHash: wakeTokenHash(),
  });
  assert.equal(captured.url, "http://power.example/v1/power/registration");
  const body = JSON.parse(Buffer.from(captured.init.body).toString("utf8"));
  assert.equal(body.v, 1);
  assert.equal(body.instanceId, "i-0123456789abcdef0");
  assert.equal(body.wakeTokenHash, wakeTokenHash());
  assert.equal(body.nodeId, identity.readNodeId());
  assert.match(body.pubkey, /BEGIN PUBLIC KEY/);
  assert.equal(captured.init.headers["x-relay-node"], identity.readNodeId());
  assert.match(captured.init.headers["x-relay-signature"], /^[A-Za-z0-9_-]+$/);
  assert.equal(captured.init.headers.authorization, undefined);
});
