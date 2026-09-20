import assert from "node:assert/strict";
import { test } from "node:test";

import { hashWakeToken } from "../src/power.js";
import { parseInstanceStates } from "../src/ec2.js";
import { startTestApp, api, makeNodeIdentity } from "./helpers.mjs";

const INSTANCE = "i-0123456789abcdef0";
const OTHER_INSTANCE = "i-0fedcba9876543210";
const WAKE = "a".repeat(64);
const WAKE_HASH = hashWakeToken(WAKE);

function makeFakeEc2() {
  const calls = [];
  const states = new Map();
  return {
    calls,
    states,
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
        })),
      };
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
              <instanceState><code>16</code><name>running</name></instanceState>
            </item>
          </instancesSet>
        </item>
      </reservationSet>
    </DescribeInstancesResponse>`);
  assert.deepEqual(described, [{ instanceId: INSTANCE, state: "running" }]);
});
