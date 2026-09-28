import assert from "node:assert/strict";
import { test } from "node:test";

import { hashWakeToken } from "../src/power.js";
import { instancePricing } from "../src/instance-pricing.js";
import { createEc2Client, parseInstanceStates } from "../src/ec2.js";
import { createDb } from "../src/db.js";
import { startTestApp, api, makeNodeIdentity } from "./helpers.mjs";

const INSTANCE = "i-0123456789abcdef0";
const OTHER_INSTANCE = "i-0fedcba9876543210";
const WAKE = "a".repeat(64);
const WAKE_HASH = hashWakeToken(WAKE);

function makeFakeEc2() {
  const calls = [];
  const states = new Map();
  const types = new Map();
  return {
    calls,
    states,
    types,
    async startInstances({ instanceIds }) {
      calls.push(["start", [...instanceIds]]);
      return {
        instances: instanceIds.map((instanceId) => {
          const state = states.get(instanceId) === "running" ? "running" : "pending";
          states.set(instanceId, state);
          return { instanceId, state };
        }),
      };
    },
    async stopInstances({ instanceIds }) {
      calls.push(["stop", [...instanceIds]]);
      return {
        instances: instanceIds.map((instanceId) => {
          states.set(instanceId, "stopping");
          return { instanceId, state: "stopping" };
        }),
      };
    },
    async describeInstances({ instanceIds }) {
      calls.push(["describe", [...instanceIds]]);
      return {
        instances: instanceIds.map((instanceId) => ({
          instanceId,
          state: states.get(instanceId) || "stopped",
          instanceType: types.get(instanceId) || "t3.medium",
        })),
      };
    },
    async modifyInstanceType({ instanceId, instanceType }) {
      calls.push(["modify", instanceId, instanceType]);
      if (this.failModify) throw new Error("incompatible_type");
      if (states.get(instanceId) !== "stopped") throw new Error("must_be_stopped");
      types.set(instanceId, instanceType);
    },
  };
}

async function startPowerApp(overrides = {}) {
  const ec2 = overrides.ec2 ?? makeFakeEc2();
  const t = await startTestApp({
    env: {
      RELAY_POWER_INSTANCE_ALLOWLIST: INSTANCE,
      ...(overrides.env || {}),
    },
    ec2,
    clock: overrides.clock,
    db: overrides.db,
  });
  t.ec2 = ec2;
  return t;
}

function registerBody(identity, extra = {}) {
  return {
    v: 1,
    nodeId: extra.nodeId || "node-aabbccddeeff0011",
    pubkey: identity.pubkeyPem,
    instanceId: extra.instanceId || INSTANCE,
    region: extra.region || "ap-south-1",
    wakeTokenHash: extra.wakeTokenHash || WAKE_HASH,
    ts: extra.ts ?? Date.now(),
    ...(extra.enrollToken !== undefined ? { enrollToken: extra.enrollToken } : {}),
  };
}

async function register(t, identity, extra = {}) {
  const body = registerBody(identity, extra);
  const raw = Buffer.from(JSON.stringify(body));
  return api(t.baseUrl, "POST", "/v1/power/registration", {
    raw,
    headers: {
      "content-type": "application/json",
      "x-relay-node": body.nodeId,
      "x-relay-signature": extra.signature || identity.signBody(raw),
    },
  });
}

test("power routes are off until an instance allowlist is configured", async () => {
  const t = await startTestApp();
  try {
    const res = await api(t.baseUrl, "POST", "/v1/power/registration", {
      body: { v: 1 },
    });
    assert.equal(res.status, 503);
    assert.equal(res.json.error, "power_unconfigured");
  } finally {
    await t.close();
  }
});

test("register + start + stop use the wake token and never a Relay account", async () => {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  try {
    const created = await register(t, identity);
    assert.equal(created.status, 201);
    assert.equal(created.json.power.instanceId, INSTANCE);
    assert.equal(created.json.power.nodeId, "node-aabbccddeeff0011");

    const denied = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start", {
      headers: { authorization: "Bearer not-the-wake-token-at-all" },
    });
    assert.equal(denied.status, 401);

    const unsigned = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start");
    assert.equal(unsigned.status, 401);

    const started = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start", {
      headers: { authorization: `Bearer ${WAKE}` },
    });
    assert.equal(started.status, 200);
    assert.equal(started.json.power.instanceState, "pending");
    assert.deepEqual(t.ec2.calls[0], ["start", [INSTANCE]]);

    t.ec2.states.set(INSTANCE, "running");
    const state = await api(t.baseUrl, "GET", "/v1/power/node-aabbccddeeff0011", {
      headers: { authorization: `Bearer ${WAKE}` },
    });
    assert.equal(state.status, 200);
    assert.equal(state.json.power.instanceState, "running");

    t.clock.t += 16_000;
    const stopped = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/stop", {
      headers: { authorization: `Bearer ${WAKE}` },
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.json.power.instanceState, "stopping");
    assert.equal(t.ec2.calls.some((call) => call[0] === "stop"), true);
  } finally {
    await t.close();
  }
});

test("a node cannot bind an instance that is not on the allowlist", async () => {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  try {
    const res = await register(t, identity, { instanceId: OTHER_INSTANCE });
    assert.equal(res.status, 403);
    assert.equal(res.json.error, "instance_not_allowed");
    assert.equal(t.ec2.calls.length, 0);
  } finally {
    await t.close();
  }
});

test("a second identity cannot steal an already-bound instance", async () => {
  const t = await startPowerApp();
  const owner = makeNodeIdentity();
  const thief = makeNodeIdentity();
  try {
    assert.equal((await register(t, owner)).status, 201);
    const hijack = await register(t, thief, { nodeId: "node-thief0000000001" });
    assert.equal(hijack.status, 409);
    assert.equal(hijack.json.error, "instance_bound");
  } finally {
    await t.close();
  }
});

test("updates must be signed by the original node key", async () => {
  const t = await startPowerApp();
  const owner = makeNodeIdentity();
  const other = makeNodeIdentity();
  try {
    assert.equal((await register(t, owner)).status, 201);
    const rotated = "b".repeat(64);
    const body = registerBody(owner, { wakeTokenHash: hashWakeToken(rotated) });
    const raw = Buffer.from(JSON.stringify(body));
    const forged = await api(t.baseUrl, "POST", "/v1/power/registration", {
      raw,
      headers: {
        "content-type": "application/json",
        "x-relay-node": body.nodeId,
        "x-relay-signature": other.signBody(raw),
      },
    });
    assert.equal(forged.status, 401);

    const ok = await api(t.baseUrl, "POST", "/v1/power/registration", {
      raw,
      headers: {
        "content-type": "application/json",
        "x-relay-node": body.nodeId,
        "x-relay-signature": owner.signBody(raw),
      },
    });
    assert.equal(ok.status, 200);

    const old = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start", {
      headers: { authorization: `Bearer ${WAKE}` },
    });
    assert.equal(old.status, 401);
    const next = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start", {
      headers: { authorization: `Bearer ${rotated}` },
    });
    assert.equal(next.status, 200);
  } finally {
    await t.close();
  }
});

test("a captured registration cannot be replayed", async () => {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  try {
    const body = registerBody(identity);
    const raw = Buffer.from(JSON.stringify(body));
    const headers = {
      "content-type": "application/json",
      "x-relay-node": body.nodeId,
      "x-relay-signature": identity.signBody(raw),
    };
    assert.equal((await api(t.baseUrl, "POST", "/v1/power/registration", { raw, headers })).status, 201);
    const replay = await api(t.baseUrl, "POST", "/v1/power/registration", { raw, headers });
    assert.equal(replay.status, 401);
    assert.equal(replay.json.error, "replayed");
  } finally {
    await t.close();
  }
});

test("an enroll token, when configured, is required to bind an instance", async () => {
  const t = await startPowerApp({ env: { RELAY_POWER_ENROLL_TOKEN: "operator-enroll" } });
  const identity = makeNodeIdentity();
  try {
    const missing = await register(t, identity);
    assert.equal(missing.status, 403);
    const wrong = await register(t, identity, { enrollToken: "nope" });
    assert.equal(wrong.status, 403);
    const ok = await register(t, identity, { enrollToken: "operator-enroll" });
    assert.equal(ok.status, 201);
  } finally {
    await t.close();
  }
});

test("mutating twice inside the minimum interval is rate-limited", async () => {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  try {
    assert.equal((await register(t, identity)).status, 201);
    const headers = { authorization: `Bearer ${WAKE}` };
    assert.equal((await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start", { headers })).status, 200);
    const again = await api(t.baseUrl, "POST", "/v1/power/node-aabbccddeeff0011/start", { headers });
    assert.equal(again.status, 429);
    assert.equal(again.json.error, "rate_limited");
  } finally {
    await t.close();
  }
});

test("paired phone reads the EC2 type and requests a durable same-series resize", async () => {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  const path = "/v1/power/node-aabbccddeeff0011";
  const headers = { authorization: `Bearer ${WAKE}` };
  try {
    assert.equal((await register(t, identity)).status, 201);
    t.ec2.states.set(INSTANCE, "running");
    const initial = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(initial.json.power.instanceType, "t3.medium");
    assert.ok(initial.json.power.resizeOptions.includes("t3.large"));

    assert.equal((await api(t.baseUrl, "POST", `${path}/resize`, {
      body: { expectedType: "t3.medium", targetType: "t3.large" },
    })).status, 401);
    assert.equal((await api(t.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "t3.medium", targetType: "m5.large" },
    })).status, 400);
    assert.equal((await api(t.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "t3.small", targetType: "t3.large" },
    })).json.error, "instance_type_changed");

    const accepted = await api(t.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "t3.medium", targetType: "t3.large" },
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.power.resize.stage, "requested");
    assert.equal((await api(t.baseUrl, "POST", `${path}/stop`, { headers })).status, 409);

    await t.app.power.advanceResizes();
    assert.deepEqual(t.ec2.calls.find((call) => call[0] === "stop"), ["stop", [INSTANCE]]);
    t.ec2.states.set(INSTANCE, "stopped");
    await t.app.power.advanceResizes();
    await t.app.power.advanceResizes();
    assert.deepEqual(t.ec2.calls.find((call) => call[0] === "modify"), ["modify", INSTANCE, "t3.large"]);
    await t.app.power.advanceResizes();
    assert.deepEqual(t.ec2.calls.find((call) => call[0] === "start"), ["start", [INSTANCE]]);
    t.ec2.states.set(INSTANCE, "running");
    await t.app.power.advanceResizes();
    const done = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(done.json.power.instanceType, "t3.large");
    assert.equal(done.json.power.resize.stage, "complete");
  } finally {
    await t.close();
  }
});

test("Mumbai m7i compute estimates use the 730-hour monthly basis", () => {
  const pricing = instancePricing("ap-south-1", ["m7i.large", "m7i.2xlarge", "m7i.4xlarge"]);
  assert.equal(pricing.currency, "USD");
  assert.equal(pricing.basis, "linux-on-demand");
  assert.equal(pricing.hoursPerMonth, 730);
  assert.equal(pricing.hourlyUSD["m7i.2xlarge"], 0.4242);
  assert.equal(pricing.hourlyUSD["m7i.2xlarge"] * pricing.hoursPerMonth, 309.666);
  assert.equal(pricing.hourlyUSD["m7i.4xlarge"], 0.8484);
  assert.equal(pricing.checkedAt, "2026-09-28");
});

test("unpriced regions and families return no compute estimate", () => {
  assert.equal(instancePricing("us-east-1", ["m7i.2xlarge"]), null);
  assert.equal(instancePricing("ap-south-1", ["t3.medium"]), null);
  assert.equal(instancePricing("ap-south-1", ["m7i.2xlarge", "m7i.metal"]), null);
  assert.equal(instancePricing("ap-south-1", []), null);
});

test("the authenticated machine route includes current and candidate m7i prices", async () => {
  const t = await startPowerApp();
  const path = "/v1/power/node-aabbccddeeff0011";
  const headers = { authorization: `Bearer ${WAKE}` };
  try {
    assert.equal((await register(t, makeNodeIdentity())).status, 201);
    t.ec2.types.set(INSTANCE, "m7i.2xlarge");
    t.ec2.states.set(INSTANCE, "running");

    const denied = await api(t.baseUrl, "GET", path);
    assert.equal(denied.status, 401);

    const described = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(described.status, 200);
    assert.equal(described.json.power.instanceType, "m7i.2xlarge");
    assert.equal(described.json.power.pricing.hourlyUSD["m7i.2xlarge"], 0.4242);
    assert.equal(described.json.power.pricing.hourlyUSD["m7i.4xlarge"], 0.8484);
    assert.equal(described.json.power.pricing.hoursPerMonth, 730);
    assert.deepEqual(Object.keys(described.json.power.pricing.hourlyUSD), described.json.power.resizeOptions);

    const accepted = await api(t.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "m7i.2xlarge", targetType: "m7i.4xlarge" },
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.power.pricing.hourlyUSD["m7i.4xlarge"], 0.8484);
    assert.equal(accepted.json.power.resize.wasRunning, true);
  } finally {
    await t.close();
  }
});

test("a rejected type change restarts a previously running machine", async () => {
  const t = await startPowerApp();
  const headers = { authorization: `Bearer ${WAKE}` };
  const path = "/v1/power/node-aabbccddeeff0011";
  try {
    assert.equal((await register(t, makeNodeIdentity())).status, 201);
    t.ec2.states.set(INSTANCE, "running");
    t.ec2.failModify = true;
    assert.equal((await api(t.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "t3.medium", targetType: "t3.large" },
    })).status, 202);
    await t.app.power.advanceResizes();
    t.ec2.states.set(INSTANCE, "stopped");
    await t.app.power.advanceResizes();
    await t.app.power.advanceResizes();
    assert.equal((await api(t.baseUrl, "GET", path, { headers })).json.power.resize.stage, "recovering");
    await t.app.power.advanceResizes();
    assert.equal(t.ec2.calls.some((call) => call[0] === "start"), true);
    t.ec2.states.set(INSTANCE, "running");
    await t.app.power.advanceResizes();
    const result = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(result.json.power.instanceType, "t3.medium");
    assert.equal(result.json.power.resize.stage, "failed");
  } finally {
    await t.close();
  }
});

test("a cloud restart resumes a resize after the instance has stopped", async () => {
  const db = createDb(":memory:");
  const ec2 = makeFakeEc2();
  const first = await startPowerApp({ db, ec2 });
  const path = "/v1/power/node-aabbccddeeff0011";
  const headers = { authorization: `Bearer ${WAKE}` };
  try {
    assert.equal((await register(first, makeNodeIdentity())).status, 201);
    ec2.states.set(INSTANCE, "running");
    assert.equal((await api(first.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "t3.medium", targetType: "t3.large" },
    })).status, 202);
    await first.app.power.advanceResizes();
  } finally {
    await first.close();
  }

  ec2.states.set(INSTANCE, "stopped");
  const second = await startPowerApp({ db, ec2 });
  try {
    await second.app.power.advanceResizes();
    await second.app.power.advanceResizes();
    await second.app.power.advanceResizes();
    ec2.states.set(INSTANCE, "running");
    await second.app.power.advanceResizes();
    const result = await api(second.baseUrl, "GET", path, { headers });
    assert.equal(result.json.power.instanceType, "t3.large");
    assert.equal(result.json.power.resize.stage, "complete");
  } finally {
    await second.close();
  }
});

test("EC2 XML instance states parse from StartInstances and DescribeInstances shapes", () => {
  const started = parseInstanceStates(`
    <StartInstancesResponse>
      <instancesSet>
        <item>
          <instanceId>i-0123456789abcdef0</instanceId>
          <currentState><code>0</code><name>pending</name></currentState>
        </item>
      </instancesSet>
    </StartInstancesResponse>`);
  assert.deepEqual(started, [{ instanceId: INSTANCE, state: "pending" }]);

  const described = parseInstanceStates(`
    <DescribeInstancesResponse>
      <reservationSet>
        <item>
          <instancesSet>
            <item>
              <instanceId>i-0123456789abcdef0</instanceId>
              <instanceType>t3.medium</instanceType>
              <instanceState><code>16</code><name>running</name></instanceState>
            </item>
          </instancesSet>
        </item>
      </reservationSet>
    </DescribeInstancesResponse>`);
  assert.deepEqual(described, [{ instanceId: INSTANCE, state: "running", instanceType: "t3.medium" }]);
});

test("EC2 type change signs the exact ModifyInstanceAttribute query", async () => {
  let body;
  const client = createEc2Client({
    region: "ap-south-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    fetchImpl: async (_url, init) => {
      body = new URLSearchParams(init.body);
      return { ok: true, status: 200, text: async () => "<ModifyInstanceAttributeResponse><return>true</return></ModifyInstanceAttributeResponse>" };
    },
  });
  await client.modifyInstanceType({ instanceId: INSTANCE, instanceType: "m7i.4xlarge" });
  assert.equal(body.get("Action"), "ModifyInstanceAttribute");
  assert.equal(body.get("InstanceId"), INSTANCE);
  assert.equal(body.get("InstanceType.Value"), "m7i.4xlarge");
  assert.equal(body.get("InstanceId.1"), null);
});
