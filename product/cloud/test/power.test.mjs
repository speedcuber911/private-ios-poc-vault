import assert from "node:assert/strict";
import { test } from "node:test";

import { hashWakeToken, resizeOptions } from "../src/power.js";
import { instancePricing } from "../src/instance-pricing.js";
import { createEc2Client, parseInstanceStates, parseInstanceTags } from "../src/ec2.js";
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
  const tags = new Map();
  return {
    calls,
    states,
    types,
    tags,
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
          tags: { ...(tags.get(instanceId) || {}) },
        })),
      };
    },
    async createTags({ instanceId, tags: next }) {
      calls.push(["tags", instanceId, { ...next }]);
      if (this.failTags) throw new Error("UnauthorizedOperation");
      tags.set(instanceId, { ...(tags.get(instanceId) || {}), ...next });
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

test("paired M4 worker exposes real same-series sizes and resizes while stopped", async () => {
  const t = await startPowerApp();
  const path = "/v1/power/node-aabbccddeeff0011";
  const headers = { authorization: `Bearer ${WAKE}` };
  try {
    assert.equal((await register(t, makeNodeIdentity())).status, 201);
    t.ec2.types.set(INSTANCE, "m4.large");
    t.ec2.states.set(INSTANCE, "stopped");

    const initial = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.json.power.resizeOptions, [
      "m4.large", "m4.xlarge", "m4.2xlarge", "m4.4xlarge", "m4.10xlarge", "m4.16xlarge",
    ]);

    for (const targetType of ["m4.8xlarge", "m4.12xlarge", "m7i.xlarge"]) {
      const invalid = await api(t.baseUrl, "POST", `${path}/resize`, {
        headers, body: { expectedType: "m4.large", targetType },
      });
      assert.equal(invalid.status, 400);
      assert.equal(invalid.json.error, "invalid_resize");
    }

    const accepted = await api(t.baseUrl, "POST", `${path}/resize`, {
      headers, body: { expectedType: "m4.large", targetType: "m4.xlarge" },
    });
    assert.equal(accepted.status, 202);
    assert.equal(accepted.json.power.resize.wasRunning, false);
    await t.app.power.advanceResizes();
    await t.app.power.advanceResizes();

    const done = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(done.json.power.instanceType, "m4.xlarge");
    assert.equal(done.json.power.instanceState, "stopped");
    assert.equal(done.json.power.resize.stage, "complete");
    assert.deepEqual(t.ec2.calls.find((call) => call[0] === "modify"), ["modify", INSTANCE, "m4.xlarge"]);
    assert.ok(!t.ec2.calls.some((call) => call[0] === "start" || call[0] === "stop"));
  } finally {
    await t.close();
  }
});

test("paired phone reads and switches idle auto-stop through the instance tag", async () => {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  const path = "/v1/power/node-aabbccddeeff0011";
  const headers = { authorization: `Bearer ${WAKE}` };
  try {
    assert.equal((await register(t, identity)).status, 201);
    const initial = await api(t.baseUrl, "GET", path, { headers });
    assert.equal(initial.json.power.autoStopEnabled, true, "no tag means auto-stop is on");

    assert.equal((await api(t.baseUrl, "POST", `${path}/autostop`, { body: { enabled: false } })).status, 401);
    assert.equal((await api(t.baseUrl, "POST", `${path}/autostop`, { headers, body: { enabled: "no" } })).status, 400);
    assert.equal(t.ec2.calls.some((call) => call[0] === "tags"), false);

    const off = await api(t.baseUrl, "POST", `${path}/autostop`, { headers, body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.json.power.autoStopEnabled, false);
    assert.deepEqual(t.ec2.calls.find((call) => call[0] === "tags"), ["tags", INSTANCE, { AutoStopEnabled: "false" }]);
    assert.equal((await api(t.baseUrl, "GET", path, { headers })).json.power.autoStopEnabled, false);

    const tooSoon = await api(t.baseUrl, "POST", `${path}/autostop`, { headers, body: { enabled: true } });
    assert.equal(tooSoon.status, 429);
    assert.equal((await api(t.baseUrl, "POST", `${path}/start`, { headers })).status, 200,
      "the auto-stop limiter must not block power");

    t.clock.t += 16_000;
    const on = await api(t.baseUrl, "POST", `${path}/autostop`, { headers, body: { enabled: true } });
    assert.equal(on.status, 200);
    assert.equal((await api(t.baseUrl, "GET", path, { headers })).json.power.autoStopEnabled, true);

    t.clock.t += 16_000;
    t.ec2.failTags = true;
    const failed = await api(t.baseUrl, "POST", `${path}/autostop`, { headers, body: { enabled: false } });
    assert.equal(failed.status, 502);
    assert.equal(failed.json.error, "power_aws_failed");
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
  assert.equal(pricing.checkedAt, "2026-10-05");
});

test("Mumbai m8a estimates cover every size the resize control offers", () => {
  const options = resizeOptions("m8a.large");
  const pricing = instancePricing("ap-south-1", options);
  assert.deepEqual(Object.keys(pricing.hourlyUSD), options);
  assert.equal(pricing.hourlyUSD["m8a.large"], 0.12806);
  assert.equal(pricing.hourlyUSD["m8a.xlarge"], 0.25612);
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

test("EC2 auto-stop tag signs the exact CreateTags query", async () => {
  let body;
  const client = createEc2Client({
    region: "ap-south-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    fetchImpl: async (_url, init) => {
      body = new URLSearchParams(init.body);
      return { ok: true, status: 200, text: async () => "<CreateTagsResponse><return>true</return></CreateTagsResponse>" };
    },
  });
  await client.createTags({ instanceId: INSTANCE, tags: { AutoStopEnabled: "false" } });
  assert.equal(body.get("Action"), "CreateTags");
  assert.equal(body.get("ResourceId.1"), INSTANCE);
  assert.equal(body.get("Tag.1.Key"), "AutoStopEnabled");
  assert.equal(body.get("Tag.1.Value"), "false");
  assert.equal(body.get("InstanceId.1"), null);
});

test("DescribeInstances tags stay with their own instance despite nested items", async () => {
  const xml = `
    <DescribeInstancesResponse>
      <reservationSet>
        <item>
          <instancesSet>
            <item>
              <instanceId>i-0123456789abcdef0</instanceId>
              <instanceState><code>16</code><name>running</name></instanceState>
              <instanceType>m7i.xlarge</instanceType>
              <groupSet><item><groupId>sg-1</groupId></item></groupSet>
              <tagSet>
                <item><key>Name</key><value>pariksj-dev</value></item>
                <item><key>Empty</key><value/></item>
                <item><key>AutoStopEnabled</key><value>false</value></item>
              </tagSet>
            </item>
            <item>
              <instanceId>i-0fedcba9876543210</instanceId>
              <instanceState><code>80</code><name>stopped</name></instanceState>
              <instanceType>m4.large</instanceType>
            </item>
          </instancesSet>
        </item>
      </reservationSet>
    </DescribeInstancesResponse>`;
  assert.deepEqual(parseInstanceTags(xml), {
    [INSTANCE]: { Name: "pariksj-dev", AutoStopEnabled: "false" },
    [OTHER_INSTANCE]: {},
  });

  const client = createEc2Client({
    region: "ap-south-1",
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => xml }),
  });
  const described = await client.describeInstances({ instanceIds: [INSTANCE, OTHER_INSTANCE] });
  assert.deepEqual(described.instances, [
    { instanceId: INSTANCE, state: "running", instanceType: "m7i.xlarge", tags: { Name: "pariksj-dev", AutoStopEnabled: "false" } },
    { instanceId: OTHER_INSTANCE, state: "stopped", instanceType: "m4.large", tags: {} },
  ]);
});

// ── power notifications ─────────────────────────────────────────────────────
// docs/superpowers/specs/2026-10-05-machine-power-notifications.md

const NODE = "node-aabbccddeeff0011";
const PHONE = "ab".repeat(32);
const WAKE_HEADERS = { authorization: `Bearer ${WAKE}` };

function powerPushes(t) {
  return t.apnsTransport.requests.filter((request) => String(request.body.relay?.type).startsWith("power."));
}

// A registered machine named pariksj-dev, one subscribed phone, and a first
// watcher observation already recorded in `state`.
async function watchedMachine(state = "running") {
  const t = await startPowerApp();
  const identity = makeNodeIdentity();
  assert.equal((await register(t, identity, { ts: t.clock.t })).status, 201);
  const subscribed = await api(t.baseUrl, "PUT", `/v1/power/${NODE}/push`, {
    headers: WAKE_HEADERS, body: { apnsToken: PHONE, apnsEnvironment: "production" },
  });
  assert.equal(subscribed.status, 200);
  t.ec2.tags.set(INSTANCE, { Name: "pariksj-dev" });
  t.ec2.states.set(INSTANCE, state);
  await t.app.power.watchPower();
  t.identity = identity;
  t.tick = async (ms = 30_000) => {
    t.clock.t += ms;
    await t.app.power.watchPower();
    await t.app.power.drainPushes();
  };
  return t;
}

test("a phone subscribes to its machine's power pushes with the wake token alone", async () => {
  const t = await startPowerApp();
  try {
    assert.equal((await register(t, makeNodeIdentity(), { ts: t.clock.t })).status, 201);
    const path = `/v1/power/${NODE}/push`;
    assert.equal((await api(t.baseUrl, "PUT", path, { body: { apnsToken: PHONE } })).status, 401);
    assert.equal((await api(t.baseUrl, "PUT", path, {
      headers: { authorization: "Bearer not-the-wake-token-at-all" }, body: { apnsToken: PHONE },
    })).status, 401);
    const invalid = await api(t.baseUrl, "PUT", path, { headers: WAKE_HEADERS, body: { apnsToken: "not hex" } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.error, "invalid_apns_token");

    assert.equal((await api(t.baseUrl, "PUT", path, {
      headers: WAKE_HEADERS, body: { apnsToken: PHONE.toUpperCase(), apnsEnvironment: "development" },
    })).status, 200);
    const rows = t.app.db.prepare("SELECT * FROM node_power_devices").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].apns_token, PHONE);
    assert.equal(rows[0].apns_environment, "development");

    assert.equal((await api(t.baseUrl, "DELETE", path, { headers: WAKE_HEADERS, body: { apnsToken: PHONE } })).status, 200);
    assert.equal(t.app.db.prepare("SELECT count(*) AS c FROM node_power_devices").get().c, 0);
  } finally {
    await t.close();
  }
});

test("a machine keeps at most ten subscribed phones, dropping the stalest", async () => {
  const t = await startPowerApp();
  try {
    assert.equal((await register(t, makeNodeIdentity(), { ts: t.clock.t })).status, 201);
    for (let index = 0; index < 11; index += 1) {
      t.clock.t += 1_000;
      assert.equal((await api(t.baseUrl, "PUT", `/v1/power/${NODE}/push`, {
        headers: WAKE_HEADERS, body: { apnsToken: index.toString(16).padStart(2, "0").repeat(32) },
      })).status, 200);
    }
    const tokens = t.app.db.prepare("SELECT apns_token FROM node_power_devices").all().map((row) => row.apns_token);
    assert.equal(tokens.length, 10);
    assert.ok(!tokens.includes("00".repeat(32)));
  } finally {
    await t.close();
  }
});

test("the idle Lambda's pause pushes once, naming the machine and the idle window", async () => {
  const t = await watchedMachine("running");
  try {
    assert.equal(powerPushes(t).length, 0, "the first observation only records");

    t.ec2.states.set(INSTANCE, "stopping");
    await t.tick();
    assert.equal(powerPushes(t).length, 0, "announced at stopped, not stopping");

    t.ec2.tags.set(INSTANCE, {
      Name: "pariksj-dev",
      AutoStoppedAt: new Date(t.clock.t).toISOString().replace("Z", "123+00:00"),
      AutoStopReason: "idle-60min",
    });
    t.ec2.states.set(INSTANCE, "stopped");
    await t.tick();
    const [push] = powerPushes(t);
    assert.equal(powerPushes(t).length, 1);
    assert.equal(push.path, `/3/device/${PHONE}`);
    assert.equal(push.host, "api.push.apple.com");
    assert.deepEqual(push.body.aps.alert, {
      title: "pariksj-dev paused",
      body: "Idle for an hour, so it stopped to save cost. Start it from Relay when you need it.",
    });
    assert.equal(push.body.aps.category, "RELAY_POWER_STOPPED");
    assert.deepEqual(push.body.relay, { nodeId: NODE, jobId: null, type: "power.stopped", ts: t.clock.t, seq: 0 });

    await t.tick();
    assert.equal(powerPushes(t).length, 1, "one transition, one push");
  } finally {
    await t.close();
  }
});

test("a stop outside Relay says so; a stop through Relay stays silent", async () => {
  const t = await watchedMachine("running");
  try {
    t.ec2.states.set(INSTANCE, "stopped");
    await t.tick();
    assert.equal(powerPushes(t).length, 1);
    assert.deepEqual(powerPushes(t)[0].body.aps.alert, {
      title: "pariksj-dev stopped",
      body: "It was stopped outside Relay.",
    });

    t.ec2.states.set(INSTANCE, "running");
    await t.tick();
    t.clock.t += 16_000;
    assert.equal((await api(t.baseUrl, "POST", `/v1/power/${NODE}/stop`, { headers: WAKE_HEADERS })).status, 200);
    await t.tick();
    t.ec2.states.set(INSTANCE, "stopped");
    await t.tick();
    assert.equal(powerPushes(t).length, 1, "the phone that asked already knows");
  } finally {
    await t.close();
  }
});

test("a start from Relay is announced when relayd registers, and a relayd restart is not", async () => {
  const t = await watchedMachine("stopped");
  try {
    assert.equal((await api(t.baseUrl, "POST", `/v1/power/${NODE}/start`, { headers: WAKE_HEADERS })).status, 200);
    await t.tick();
    t.ec2.states.set(INSTANCE, "running");
    await t.tick();
    assert.equal(powerPushes(t).length, 0, "EC2 running is not Relay ready");

    assert.equal((await register(t, t.identity, { ts: t.clock.t })).status, 200);
    await t.app.power.drainPushes();
    assert.equal(powerPushes(t).length, 1);
    assert.deepEqual(powerPushes(t)[0].body.aps.alert, { title: "pariksj-dev is ready", body: "Relay is connected." });
    assert.equal(powerPushes(t)[0].body.aps.category, "RELAY_POWER_READY");
    assert.equal(powerPushes(t)[0].body.relay.type, "power.ready");

    t.clock.t += 60_000;
    assert.equal((await register(t, t.identity, { ts: t.clock.t })).status, 200);
    await t.tick(READY_FALLBACK_TEST_MS);
    assert.equal(powerPushes(t).length, 1);
  } finally {
    await t.close();
  }
});

test("a machine started outside Relay is announced when relayd beats the watcher to it", async () => {
  const t = await watchedMachine("stopped");
  try {
    t.clock.t += 20_000;
    assert.equal((await register(t, t.identity, { ts: t.clock.t })).status, 200);
    await t.app.power.drainPushes();
    assert.equal(powerPushes(t).length, 1);
    assert.equal(powerPushes(t)[0].body.aps.alert.title, "pariksj-dev is ready");
    t.ec2.states.set(INSTANCE, "running");
    await t.tick();
    assert.equal(powerPushes(t).length, 1);
  } finally {
    await t.close();
  }
});

const READY_FALLBACK_TEST_MS = 5 * 60_000;

test("a machine running five minutes without relayd still gets a banner", async () => {
  const t = await watchedMachine("stopped");
  try {
    t.ec2.states.set(INSTANCE, "running");
    await t.tick();
    await t.tick(READY_FALLBACK_TEST_MS - 60_000);
    assert.equal(powerPushes(t).length, 0);
    await t.tick(60_000);
    assert.equal(powerPushes(t).length, 1);
    assert.deepEqual(powerPushes(t)[0].body.aps.alert, {
      title: "pariksj-dev is on",
      body: "It's running, but Relay hasn't connected yet.",
    });
    await t.tick();
    assert.equal(powerPushes(t).length, 1);
  } finally {
    await t.close();
  }
});

test("a resize never says stopped, and ends with one ready naming the new size", async () => {
  const t = await watchedMachine("running");
  try {
    t.ec2.types.set(INSTANCE, "m8a.large");
    assert.equal((await api(t.baseUrl, "POST", `/v1/power/${NODE}/resize`, {
      headers: WAKE_HEADERS, body: { expectedType: "m8a.large", targetType: "m8a.xlarge" },
    })).status, 202);
    await t.app.power.advanceResizes();
    await t.tick();
    t.ec2.states.set(INSTANCE, "stopped");
    await t.tick();
    await t.app.power.advanceResizes();
    await t.app.power.advanceResizes();
    await t.app.power.advanceResizes();
    await t.tick();
    t.ec2.states.set(INSTANCE, "running");
    await t.tick();
    await t.app.power.advanceResizes();
    assert.equal(powerPushes(t).length, 0);

    assert.equal((await register(t, t.identity, { ts: t.clock.t })).status, 200);
    await t.app.power.drainPushes();
    assert.equal(powerPushes(t).length, 1);
    assert.deepEqual(powerPushes(t)[0].body.aps.alert, {
      title: "pariksj-dev is ready",
      body: "Now running as m8a.xlarge. Relay is connected.",
    });
  } finally {
    await t.close();
  }
});

test("an observation after the cloud was away only records", async () => {
  const t = await watchedMachine("running");
  try {
    t.ec2.states.set(INSTANCE, "stopped");
    await t.tick(11 * 60_000);
    assert.equal(powerPushes(t).length, 0);
  } finally {
    await t.close();
  }
});

test("re-pairing drops the old phones, and Apple's 410 drops a dead token", async () => {
  const t = await watchedMachine("running");
  try {
    t.apnsTransport.respondWith({ status: 410, body: JSON.stringify({ reason: "Unregistered" }) });
    t.ec2.states.set(INSTANCE, "stopped");
    await t.tick();
    assert.equal(powerPushes(t).length, 1);
    assert.equal(t.app.db.prepare("SELECT count(*) AS c FROM node_power_devices").get().c, 0);

    assert.equal((await api(t.baseUrl, "PUT", `/v1/power/${NODE}/push`, {
      headers: WAKE_HEADERS, body: { apnsToken: PHONE },
    })).status, 200);
    t.clock.t += 1_000;
    const rotated = await register(t, t.identity, { ts: t.clock.t, wakeTokenHash: hashWakeToken("b".repeat(64)) });
    assert.equal(rotated.status, 200);
    assert.equal(t.app.db.prepare("SELECT count(*) AS c FROM node_power_devices").get().c, 0);
  } finally {
    await t.close();
  }
});
