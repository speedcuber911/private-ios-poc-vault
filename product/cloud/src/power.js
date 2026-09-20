// Machine power plane: start/stop an allowlisted EC2 from a pairing-issued
// wake token, with no Relay account on the path.
//
// The node registers itself (signed body, TOFU on its ed25519 identity).
// A phone that received the wake token at pairing — or later via
// GET /v1/power/credential on the node — presents it here. The control plane
// stores sha256(token) only, calls StartInstances/StopInstances, and never
// sees prompts, files, or the node's data-path bearer.

import { createHash, timingSafeEqual, verify as cryptoVerify } from "node:crypto";

import { parseNodePubkey } from "./notify.js";
import { EC2_INSTANCE_ID_RE } from "./config.js";
import { createEc2Client } from "./ec2.js";

const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const TS_MAX_AGE_MS = 10 * 60 * 1000;
const TS_MAX_SKEW_MS = 2 * 60 * 1000;
const MUTATE_MIN_INTERVAL_MS = 15_000;
const MUTATE_MAX_PER_HOUR = 20;

function sha256Hex(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function secretEquals(a, b) {
  return timingSafeEqual(
    createHash("sha256").update(String(a)).digest(),
    createHash("sha256").update(String(b)).digest(),
  );
}

function decodeSignature(signatureB64) {
  const signature = Buffer.from(String(signatureB64 || ""), "base64url");
  if (signature.length === 0 || signature.toString("base64url") !== String(signatureB64 || "")) {
    return null;
  }
  return signature;
}

function publicPower(row, extra = {}) {
  return {
    nodeId: row.node_id,
    instanceId: row.instance_id,
    region: row.region,
    ...extra,
  };
}

export function hashWakeToken(token) {
  return sha256Hex(token);
}

export function createPower({
  db,
  config,
  now = () => Date.now(),
  ec2 = null,
  replayGuard,
  log = (msg) => console.warn(msg),
} = {}) {
  const allowlist = new Set(config.power?.allowlist || []);
  const enrollToken = config.power?.enrollToken || "";
  const regionDefault = config.power?.region || "ap-south-1";
  const client = ec2 || (allowlist.size > 0 ? createEc2Client({ region: regionDefault, now }) : null);

  const lastMutateAt = new Map();
  const mutateHits = new Map();

  function get(nodeId) {
    return db.prepare("SELECT * FROM node_power WHERE node_id = ?").get(nodeId) || null;
  }

  function getByInstance(instanceId) {
    return db.prepare("SELECT * FROM node_power WHERE instance_id = ?").get(instanceId) || null;
  }

  function getByTokenHash(tokenHash) {
    return db.prepare("SELECT * FROM node_power WHERE wake_token_hash = ?").get(tokenHash) || null;
  }

  function allowMutate(nodeId, nowMs) {
    const last = lastMutateAt.get(nodeId) || 0;
    if (nowMs - last < MUTATE_MIN_INTERVAL_MS) return false;
    let hits = mutateHits.get(nodeId) || [];
    hits = hits.filter((ts) => nowMs - ts < 60 * 60 * 1000);
    if (hits.length >= MUTATE_MAX_PER_HOUR) {
      mutateHits.set(nodeId, hits);
      return false;
    }
    hits.push(nowMs);
    mutateHits.set(nodeId, hits);
    lastMutateAt.set(nodeId, nowMs);
    return true;
  }

  function configured() {
    return allowlist.size > 0 && client != null;
  }

  function authorizeWake(req, nodeId) {
    if (!NODE_ID_RE.test(nodeId)) return { error: "invalid_node" };
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) return { error: "unauthorized" };
    const token = header.slice(7);
    if (token.length < 16 || token.length > 256) return { error: "unauthorized" };
    const row = get(nodeId);
    if (!row) return { error: "unknown_node" };
    const presented = Buffer.from(sha256Hex(token), "utf8");
    const stored = Buffer.from(row.wake_token_hash, "utf8");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
      return { error: "unauthorized" };
    }
    return { row };
  }

  function register(rawBody, signatureB64, nodeHeader) {
    if (!configured()) return { status: 503, body: { error: "power_unconfigured" } };
    let body;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (!body || typeof body !== "object" || Array.isArray(body) || body.v !== 1) {
      return { status: 400, body: { error: "invalid_registration" } };
    }
    const nodeId = String(body.nodeId || "");
    const instanceId = String(body.instanceId || "").toLowerCase();
    const region = String(body.region || "").toLowerCase();
    const wakeTokenHash = String(body.wakeTokenHash || "").toLowerCase();
    const ts = body.ts;
    if (!NODE_ID_RE.test(nodeId) || (nodeHeader && nodeHeader !== nodeId)) {
      return { status: 400, body: { error: "invalid_node" } };
    }
    if (!EC2_INSTANCE_ID_RE.test(instanceId)) {
      return { status: 400, body: { error: "invalid_instance" } };
    }
    if (!REGION_RE.test(region)) {
      return { status: 400, body: { error: "invalid_region" } };
    }
    if (!HASH_RE.test(wakeTokenHash)) {
      return { status: 400, body: { error: "invalid_wake_token_hash" } };
    }
    if (!Number.isSafeInteger(ts)) {
      return { status: 400, body: { error: "bad_ts" } };
    }
    const nowMs = now();
    if (ts < nowMs - TS_MAX_AGE_MS || ts > nowMs + TS_MAX_SKEW_MS) {
      return { status: 400, body: { error: "bad_ts" } };
    }
    if (!allowlist.has(instanceId)) {
      return { status: 403, body: { error: "instance_not_allowed" } };
    }
    if (enrollToken && !secretEquals(body.enrollToken || "", enrollToken)) {
      return { status: 403, body: { error: "invalid_enroll_token" } };
    }

    const existing = get(nodeId);
    const pem = existing ? existing.pubkey : body.pubkey;
    const key = parseNodePubkey(pem);
    if (!key) return { status: 400, body: { error: "node_key_unusable" } };
    const signature = decodeSignature(signatureB64);
    if (!signature || !cryptoVerify(null, rawBody, key, signature)) {
      return { status: 401, body: { error: "bad_signature" } };
    }
    if (replayGuard && !replayGuard.claim(
      { method: "POST", pathWithQuery: "/v1/power/registration", nodeId, ts, signature },
      nowMs,
    )) {
      return { status: 401, body: { error: "replayed" } };
    }

    const holder = getByInstance(instanceId);
    if (holder && holder.node_id !== nodeId) {
      return { status: 409, body: { error: "instance_bound" } };
    }

    if (existing) {
      db.prepare(
        "UPDATE node_power SET instance_id = ?, region = ?, wake_token_hash = ?, updated_at = ? WHERE node_id = ?",
      ).run(instanceId, region, wakeTokenHash, nowMs, nodeId);
      return { status: 200, body: { ok: true, power: publicPower(get(nodeId)) } };
    }

    db.prepare(
      `INSERT INTO node_power (node_id, pubkey, instance_id, region, wake_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(nodeId, pem, instanceId, region, wakeTokenHash, nowMs, nowMs);
    return { status: 201, body: { ok: true, power: publicPower(get(nodeId)) } };
  }

  async function mutate(row, action) {
    if (!configured()) return { status: 503, body: { error: "power_unconfigured" } };
    if (!allowMutate(row.node_id, now())) {
      return { status: 429, body: { error: "rate_limited" } };
    }
    try {
      const result = action === "stop"
        ? await client.stopInstances({ instanceIds: [row.instance_id] })
        : await client.startInstances({ instanceIds: [row.instance_id] });
      const instance = result.instances?.[0];
      return {
        status: 200,
        body: {
          ok: true,
          power: publicPower(row, {
            action,
            instanceState: instance?.state || (action === "stop" ? "stopping" : "pending"),
          }),
        },
      };
    } catch (error) {
      log(`power aws ${action} failed for ${row.node_id}: ${error?.message || error}`);
      return { status: 502, body: { error: "power_aws_failed" } };
    }
  }

  async function describe(row) {
    if (!configured()) return { status: 503, body: { error: "power_unconfigured" } };
    try {
      const result = await client.describeInstances({ instanceIds: [row.instance_id] });
      const instance = result.instances?.[0];
      return {
        status: 200,
        body: {
          ok: true,
          power: publicPower(row, { instanceState: instance?.state || "unknown" }),
        },
      };
    } catch (error) {
      log(`power aws describe failed for ${row.node_id}: ${error?.message || error}`);
      return { status: 502, body: { error: "power_aws_failed" } };
    }
  }

  return {
    configured,
    register,
    authorizeWake,
    mutate,
    describe,
    get,
    getByTokenHash,
  };
}
