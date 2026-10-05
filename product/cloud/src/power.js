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
import { instancePricing } from "./instance-pricing.js";
import { apnsCollapseId, APNS_OUTCOME } from "./apns.js";

const NODE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REGION_RE = /^[a-z]{2}-[a-z]+-\d+$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const TS_MAX_AGE_MS = 10 * 60 * 1000;
const TS_MAX_SKEW_MS = 2 * 60 * 1000;
const MUTATE_MIN_INTERVAL_MS = 15_000;
const MUTATE_MAX_PER_HOUR = 20;
const ACTIVE_RESIZE_STAGES = ["requested", "waiting_stop", "modifying", "waiting_start", "waiting_running", "recovering", "recovery_wait"];
// Read by the dev-ec2-idle-autostop Lambda in the same account, which stops
// the machine after an idle hour unless this tag is "false". Absent = on.
export const AUTO_STOP_TAG = "AutoStopEnabled";

// Power notifications: see
// docs/superpowers/specs/2026-10-05-machine-power-notifications.md.
const UP_STATES = new Set(["pending", "running"]);
// An observation older than this means the cloud was not watching; the next
// one only records, because a banner about an old change is noise.
const WATCH_STALE_MS = 10 * 60_000;
// A stop requested through Relay stays silent for this long.
const STOP_REQUEST_QUIET_MS = 10 * 60_000;
// The idle Lambda tags AutoStoppedAt right after StopInstances.
const AUTO_STOP_TAG_FRESH_MS = 30 * 60_000;
// Running this long with no relayd registration still gets a banner.
const READY_FALLBACK_MS = 5 * 60_000;
const READY_WAIT_MAX_MS = 20 * 60_000;
const PUSH_DEVICES_MAX = 10;
const APNS_TOKEN_RE = /^[0-9a-f]{64,200}$/;
const MACHINE_NAME_MAX = 40;

// The EC2 Name tag, made safe for a lock screen. This is the one stored
// string a power banner hands to Apple.
function machineName(tags) {
  const clean = String(tags?.Name ?? "").replace(/\p{C}/gu, "").trim();
  if (!clean) return null;
  return clean.length > MACHINE_NAME_MAX ? `${clean.slice(0, MACHINE_NAME_MAX - 1)}…` : clean;
}

function idleFor(minutes) {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) return "Idle";
  if (minutes === 60) return "Idle for an hour";
  if (minutes % 60 === 0) return `Idle for ${minutes / 60} hours`;
  return `Idle for ${minutes} minutes`;
}

function stoppedBanner(tags, name, nowMs) {
  const label = name || "Your machine";
  const stoppedAt = Date.parse(tags?.AutoStoppedAt ?? "");
  const age = nowMs - stoppedAt;
  if (Number.isFinite(stoppedAt) && age >= -60_000 && age <= AUTO_STOP_TAG_FRESH_MS) {
    const minutes = Number(/^idle-(\d+)min$/.exec(tags?.AutoStopReason ?? "")?.[1]);
    return {
      title: `${label} paused`,
      body: `${idleFor(minutes)}, so it stopped to save cost. Start it from Relay when you need it.`,
    };
  }
  return { title: `${label} stopped`, body: "It was stopped outside Relay." };
}

// Keep the control to sizes in the current EC2 family. AWS still makes the
// final compatibility and regional-capacity decision for the specific VM.
export function resizeOptions(instanceType) {
  const [family, size] = String(instanceType || "").split(".");
  if (!family || !size) return [];
  let sizes;
  if (/^t(?:2|3|3a|4g)$/.test(family)) {
    sizes = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge"];
  } else if (family === "m4") {
    sizes = ["large", "xlarge", "2xlarge", "4xlarge", "10xlarge", "16xlarge"];
  } else if (/^[mcr][5-9](?:[a-z]*)$/.test(family)) {
    sizes = ["large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge"];
  } else {
    return [];
  }
  return sizes.includes(size) ? sizes.map((entry) => `${family}.${entry}`) : [];
}

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
  apns = null,
  replayGuard,
  log = (msg) => console.warn(msg),
} = {}) {
  const allowlist = new Set(config.power?.allowlist || []);
  const enrollToken = config.power?.enrollToken || "";
  const regionDefault = config.power?.region || "ap-south-1";
  const client = ec2 || (allowlist.size > 0 ? createEc2Client({ region: regionDefault, now }) : null);

  const lastMutateAt = new Map();
  const mutateHits = new Map();
  const advancing = new Set();
  const pushesInFlight = new Set();

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

  function resizeRow(nodeId) {
    return db.prepare("SELECT * FROM node_resize WHERE node_id = ?").get(nodeId) || null;
  }

  function publicResize(nodeId) {
    const row = resizeRow(nodeId);
    return row ? {
      targetType: row.target_type,
      originalType: row.original_type,
      stage: row.stage,
      error: row.error,
      wasRunning: Boolean(row.was_running),
    } : null;
  }

  function setResizeStage(nodeId, stage, error = null) {
    db.prepare("UPDATE node_resize SET stage = ?, error = ?, updated_at = ? WHERE node_id = ?")
      .run(stage, error, now(), nodeId);
  }

  function resizeActive(nodeId) {
    return ACTIVE_RESIZE_STAGES.includes(resizeRow(nodeId)?.stage);
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
      // A re-pair rotated the wake token: phones subscribed with the old one
      // must stop hearing about this machine.
      if (existing.wake_token_hash !== wakeTokenHash) {
        db.prepare("DELETE FROM node_power_devices WHERE node_id = ?").run(nodeId);
      }
      announceReady(nodeId);
      return { status: 200, body: { ok: true, power: publicPower(get(nodeId)) } };
    }

    db.prepare(
      `INSERT INTO node_power (node_id, pubkey, instance_id, region, wake_token_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(nodeId, pem, instanceId, region, wakeTokenHash, nowMs, nowMs);
    return { status: 201, body: { ok: true, power: publicPower(get(nodeId)) } };
  }

  async function mutate(row, action) {
    if (!configured() || !allowlist.has(row.instance_id)) return { status: 503, body: { error: "power_unconfigured" } };
    if (resizeActive(row.node_id)) return { status: 409, body: { error: "resize_in_progress" } };
    if (!allowMutate(row.node_id, now())) {
      return { status: 429, body: { error: "rate_limited" } };
    }
    try {
      const result = action === "stop"
        ? await client.stopInstances({ instanceIds: [row.instance_id] })
        : await client.startInstances({ instanceIds: [row.instance_id] });
      const instance = result.instances?.[0];
      if (action === "stop") markStopRequested(row.node_id);
      else markAwaitingReady(row.node_id, instance?.state || "pending");
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
    if (!configured() || !allowlist.has(row.instance_id)) return { status: 503, body: { error: "power_unconfigured" } };
    try {
      const result = await client.describeInstances({ instanceIds: [row.instance_id] });
      const instance = result.instances?.[0];
      const options = resizeOptions(instance?.instanceType);
      return {
        status: 200,
        body: {
          ok: true,
          power: publicPower(row, {
            instanceState: instance?.state || "unknown",
            instanceType: instance?.instanceType || null,
            resizeOptions: options,
            pricing: instancePricing(row.region, options),
            resize: publicResize(row.node_id),
            autoStopEnabled: instance?.tags?.[AUTO_STOP_TAG] !== "false",
          }),
        },
      };
    } catch (error) {
      log(`power aws describe failed for ${row.node_id}: ${error?.message || error}`);
      return { status: 502, body: { error: "power_aws_failed" } };
    }
  }

  async function setAutoStop(row, { enabled } = {}) {
    if (!configured() || !allowlist.has(row.instance_id)) return { status: 503, body: { error: "power_unconfigured" } };
    if (typeof enabled !== "boolean") return { status: 400, body: { error: "invalid_autostop" } };
    if (!allowMutate(`autostop:${row.node_id}`, now())) {
      return { status: 429, body: { error: "rate_limited" } };
    }
    try {
      await client.createTags({
        instanceId: row.instance_id,
        tags: { [AUTO_STOP_TAG]: enabled ? "true" : "false" },
      });
      return { status: 200, body: { ok: true, power: publicPower(row, { autoStopEnabled: enabled }) } };
    } catch (error) {
      log(`power aws autostop failed for ${row.node_id}: ${error?.message || error}`);
      return { status: 502, body: { error: "power_aws_failed" } };
    }
  }

  async function requestResize(row, { targetType, expectedType } = {}) {
    if (!configured() || !allowlist.has(row.instance_id)) return { status: 503, body: { error: "power_unconfigured" } };
    if (resizeActive(row.node_id)) return { status: 409, body: { error: "resize_in_progress" } };
    if (typeof targetType !== "string" || typeof expectedType !== "string") {
      return { status: 400, body: { error: "invalid_resize" } };
    }
    try {
      const instance = (await client.describeInstances({ instanceIds: [row.instance_id] })).instances?.[0];
      if (!instance?.instanceType || !["running", "stopped"].includes(instance.state)) {
        return { status: 409, body: { error: "instance_not_ready" } };
      }
      if (instance.instanceType !== expectedType) {
        return { status: 409, body: { error: "instance_type_changed" } };
      }
      if (targetType === expectedType || !resizeOptions(expectedType).includes(targetType)) {
        return { status: 400, body: { error: "invalid_resize" } };
      }
      if (!allowMutate(row.node_id, now())) {
        return { status: 429, body: { error: "rate_limited" } };
      }
      db.prepare(`INSERT INTO node_resize (node_id, target_type, original_type, stage, was_running, error, started_at, updated_at)
        VALUES (?, ?, ?, 'requested', ?, NULL, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET target_type = excluded.target_type,
          original_type = excluded.original_type, stage = 'requested',
          was_running = excluded.was_running, error = NULL,
          started_at = excluded.started_at, updated_at = excluded.updated_at`)
        .run(row.node_id, targetType, expectedType, instance.state === "running" ? 1 : 0, now(), now());
      const options = resizeOptions(instance.instanceType);
      return { status: 202, body: { ok: true, power: publicPower(row, {
        instanceState: instance.state, instanceType: instance.instanceType,
        resizeOptions: options, pricing: instancePricing(row.region, options),
        resize: publicResize(row.node_id),
      }) } };
    } catch (error) {
      log(`power aws resize request failed for ${row.node_id}: ${error?.message || error}`);
      return { status: 502, body: { error: "power_aws_failed" } };
    }
  }

  async function advanceResize(job) {
    const node = get(job.node_id);
    if (!node || !allowlist.has(node.instance_id)) return;
    const instance = (await client.describeInstances({ instanceIds: [node.instance_id] })).instances?.[0];
    if (!instance) throw new Error("instance_missing");
    if (now() - job.started_at > 15 * 60_000) {
      setResizeStage(job.node_id, "failed", "resize_timeout");
      return;
    }
    const id = node.instance_id;
    if (job.stage === "requested") {
      if (instance.state === "running") {
        setResizeStage(job.node_id, "waiting_stop");
        await client.stopInstances({ instanceIds: [id] });
      } else if (instance.state === "stopped") {
        setResizeStage(job.node_id, "modifying");
      }
      return;
    }
    if (job.stage === "waiting_stop") {
      if (instance.state === "stopped") setResizeStage(job.node_id, "modifying");
      else if (instance.state === "running" && now() - job.updated_at >= 15_000) {
        setResizeStage(job.node_id, "waiting_stop");
        await client.stopInstances({ instanceIds: [id] });
      }
      return;
    }
    if (job.stage === "modifying") {
      if (instance.instanceType !== job.target_type) {
        if (instance.state !== "stopped") return;
        await client.modifyInstanceType({ instanceId: id, instanceType: job.target_type });
      }
      setResizeStage(job.node_id, job.was_running ? "waiting_start" : "complete");
      return;
    }
    if (job.stage === "waiting_start") {
      if (instance.state === "running") {
        setResizeStage(job.node_id, "complete");
      } else if (instance.state === "stopped") {
        setResizeStage(job.node_id, "waiting_running");
        await client.startInstances({ instanceIds: [id] });
      }
      return;
    }
    if (job.stage === "waiting_running") {
      if (instance.state === "running") setResizeStage(job.node_id, "complete");
      else if (instance.state === "stopped" && now() - job.updated_at >= 15_000) {
        setResizeStage(job.node_id, "waiting_running");
        await client.startInstances({ instanceIds: [id] });
      }
      return;
    }
    if (job.stage === "recovering") {
      if (instance.state === "running") setResizeStage(job.node_id, "failed", job.error);
      else if (instance.state === "stopped") {
        setResizeStage(job.node_id, "recovery_wait", job.error);
        await client.startInstances({ instanceIds: [id] });
      }
      return;
    }
    if (job.stage === "recovery_wait") {
      if (instance.state === "running") setResizeStage(job.node_id, "failed", job.error);
      else if (instance.state === "stopped" && now() - job.updated_at >= 15_000) {
        setResizeStage(job.node_id, "recovery_wait", job.error);
        await client.startInstances({ instanceIds: [id] });
      }
    }
  }

  async function advanceResizes() {
    if (!configured()) return;
    const jobs = db.prepare(`SELECT * FROM node_resize WHERE stage IN (${ACTIVE_RESIZE_STAGES.map(() => "?").join(",")})`)
      .all(...ACTIVE_RESIZE_STAGES);
    for (const job of jobs) {
      if (advancing.has(job.node_id)) continue;
      advancing.add(job.node_id);
      try {
        await advanceResize(job);
      } catch (error) {
        log(`power aws resize failed for ${job.node_id}: ${error?.message || error}`);
        const current = resizeRow(job.node_id);
        if (current?.stage === "modifying" && current.was_running) {
          setResizeStage(job.node_id, "recovering", "resize_failed");
        } else {
          setResizeStage(job.node_id, "failed", "resize_failed");
        }
      } finally {
        advancing.delete(job.node_id);
      }
    }
  }

  // ── power notifications ───────────────────────────────────────────────

  function subscribePush(row, { apnsToken, apnsEnvironment } = {}) {
    if (!configured() || !allowlist.has(row.instance_id)) return { status: 503, body: { error: "power_unconfigured" } };
    const token = typeof apnsToken === "string" ? apnsToken.trim().toLowerCase() : "";
    if (!APNS_TOKEN_RE.test(token)) return { status: 400, body: { error: "invalid_apns_token" } };
    const environment = apnsEnvironment === "production" || apnsEnvironment === "development"
      ? apnsEnvironment
      : null;
    const nowMs = now();
    db.prepare(`INSERT INTO node_power_devices (node_id, apns_token, apns_environment, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(node_id, apns_token) DO UPDATE SET apns_environment = excluded.apns_environment,
        updated_at = excluded.updated_at`)
      .run(row.node_id, token, environment, nowMs, nowMs);
    db.prepare(`DELETE FROM node_power_devices WHERE node_id = ? AND apns_token NOT IN (
        SELECT apns_token FROM node_power_devices WHERE node_id = ? ORDER BY updated_at DESC LIMIT ?)`)
      .run(row.node_id, row.node_id, PUSH_DEVICES_MAX);
    return { status: 200, body: { ok: true } };
  }

  function unsubscribePush(row, { apnsToken } = {}) {
    const token = typeof apnsToken === "string" ? apnsToken.trim().toLowerCase() : "";
    if (!APNS_TOKEN_RE.test(token)) return { status: 400, body: { error: "invalid_apns_token" } };
    db.prepare("DELETE FROM node_power_devices WHERE node_id = ? AND apns_token = ?").run(row.node_id, token);
    return { status: 200, body: { ok: true } };
  }

  function watchRow(nodeId) {
    return db.prepare("SELECT * FROM node_power_watch WHERE node_id = ?").get(nodeId) || null;
  }

  function markStopRequested(nodeId) {
    db.prepare(`INSERT INTO node_power_watch (node_id, state, observed_at, stop_requested_at)
      VALUES (?, 'stopping', ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET stop_requested_at = excluded.stop_requested_at,
        awaiting_ready_since = NULL`)
      .run(nodeId, now(), now());
  }

  function markAwaitingReady(nodeId, state) {
    db.prepare(`INSERT INTO node_power_watch (node_id, state, observed_at, awaiting_ready_since)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET stop_requested_at = NULL,
        awaiting_ready_since = COALESCE(node_power_watch.awaiting_ready_since, excluded.awaiting_ready_since)`)
      .run(nodeId, state, now(), now());
  }

  // relayd registers on every start. After a start (or while the watcher
  // still believes the machine is stopped) that registration means Relay
  // itself is up; a relayd restart on a running machine stays silent.
  function announceReady(nodeId) {
    const watch = watchRow(nodeId);
    if (!watch) return;
    const nowMs = now();
    const awaiting = watch.awaiting_ready_since != null && nowMs - watch.awaiting_ready_since <= READY_WAIT_MAX_MS;
    const seenDown = !UP_STATES.has(watch.state) && nowMs - watch.observed_at <= WATCH_STALE_MS;
    if (!awaiting && !seenDown) return;
    db.prepare(`UPDATE node_power_watch SET state = 'running', stop_requested_at = NULL,
      awaiting_ready_since = NULL WHERE node_id = ?`).run(nodeId);
    const resize = resizeRow(nodeId);
    const resized = resize && ["waiting_start", "waiting_running", "complete"].includes(resize.stage)
      && nowMs - resize.started_at <= READY_WAIT_MAX_MS
      ? resize.target_type
      : null;
    sendPowerPush(nodeId, "power.ready", {
      title: `${watch.name || "Your machine"} is ready`,
      body: resized ? `Now running as ${resized}. Relay is connected.` : "Relay is connected.",
    });
  }

  function observe(row, instance) {
    const nodeId = row.node_id;
    const state = instance.state;
    const name = machineName(instance.tags);
    const prev = watchRow(nodeId);
    const nowMs = now();
    const record = (stopRequestedAt, awaitingSince) => {
      db.prepare(`INSERT INTO node_power_watch
          (node_id, state, name, observed_at, stop_requested_at, awaiting_ready_since)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET state = excluded.state, name = excluded.name,
          observed_at = excluded.observed_at, stop_requested_at = excluded.stop_requested_at,
          awaiting_ready_since = excluded.awaiting_ready_since`)
        .run(nodeId, state, name, nowMs, stopRequestedAt, awaitingSince);
    };
    if (!prev || nowMs - prev.observed_at > WATCH_STALE_MS) {
      record(null, null);
      return;
    }
    let stopRequestedAt = prev.stop_requested_at != null && nowMs - prev.stop_requested_at <= STOP_REQUEST_QUIET_MS
      ? prev.stop_requested_at
      : null;
    let awaitingSince = prev.awaiting_ready_since != null && nowMs - prev.awaiting_ready_since <= READY_WAIT_MAX_MS
      ? prev.awaiting_ready_since
      : null;
    let push = null;
    if (state === "stopped" && prev.state !== "stopped") {
      // Announced at `stopped`, not `stopping`: by then the Lambda's
      // AutoStoppedAt tag is reliably visible.
      if (["running", "pending", "stopping"].includes(prev.state) && !resizeActive(nodeId) && !stopRequestedAt) {
        push = { type: "power.stopped", banner: stoppedBanner(instance.tags, name, nowMs) };
      }
      stopRequestedAt = null;
      awaitingSince = null;
    } else if (UP_STATES.has(state) && !UP_STATES.has(prev.state)) {
      awaitingSince = awaitingSince ?? nowMs;
      stopRequestedAt = null;
    } else if (state === "running" && awaitingSince != null && nowMs - awaitingSince >= READY_FALLBACK_MS) {
      push = {
        type: "power.ready",
        banner: { title: `${name || "Your machine"} is on`, body: "It's running, but Relay hasn't connected yet." },
      };
      awaitingSince = null;
    }
    // Persisted before the push goes out: one transition, at most one push.
    record(stopRequestedAt, awaitingSince);
    if (push) sendPowerPush(nodeId, push.type, push.banner);
  }

  async function watchPower() {
    if (!configured()) return;
    const rows = db.prepare("SELECT * FROM node_power").all().filter((row) => allowlist.has(row.instance_id));
    if (rows.length === 0) return;
    const result = await client.describeInstances({ instanceIds: rows.map((row) => row.instance_id) });
    const byId = new Map((result.instances || []).map((instance) => [instance.instanceId, instance]));
    for (const row of rows) {
      const instance = byId.get(row.instance_id);
      if (instance) observe(row, instance);
    }
  }

  function sendPowerPush(nodeId, type, banner) {
    if (!apns) return;
    const devices = db.prepare("SELECT apns_token, apns_environment FROM node_power_devices WHERE node_id = ?")
      .all(nodeId);
    if (devices.length === 0) return;
    const payload = { nodeId, jobId: null, type, ts: now(), seq: 0 };
    const category = type === "power.ready" ? "RELAY_POWER_READY" : "RELAY_POWER_STOPPED";
    const job = (async () => {
      const tally = {};
      for (const device of devices) {
        const result = await apns.send({
          deviceToken: device.apns_token,
          kind: "mutable",
          category,
          payload,
          // One per machine: the newest power banner replaces the last one.
          collapseId: apnsCollapseId(nodeId, "power", "mutable"),
          banner,
          apnsEnvironment: device.apns_environment,
        });
        tally[result.outcome] = (tally[result.outcome] ?? 0) + 1;
        if (result.outcome === APNS_OUTCOME.UNREGISTERED) {
          db.prepare("DELETE FROM node_power_devices WHERE node_id = ? AND apns_token = ?")
            .run(nodeId, device.apns_token);
        }
      }
      // Outcome mix only — never a token.
      log(`power push ${type}: devices=${devices.length} ${Object.entries(tally).map(([key, count]) => `${key}=${count}`).join(" ")}`);
    })().catch((error) => log(`power push ${type} failed: ${error?.message || error}`));
    pushesInFlight.add(job);
    job.finally(() => pushesInFlight.delete(job));
  }

  async function drainPushes() {
    while (pushesInFlight.size > 0) await Promise.all([...pushesInFlight]);
  }

  return {
    configured,
    register,
    authorizeWake,
    mutate,
    describe,
    setAutoStop,
    requestResize,
    advanceResizes,
    subscribePush,
    unsubscribePush,
    watchPower,
    drainPushes,
    get,
    getByTokenHash,
  };
}
