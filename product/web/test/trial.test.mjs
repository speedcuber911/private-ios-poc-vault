import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCloud } from "../src/api/cloud.js";
import {
  createTrial,
  decideMachineAction,
  deriveAuthToken,
  kindWord,
  machineStatusWord,
  mintPairingSecret,
  provisioningStage,
} from "../src/api/trial.js";

function mockFetch(handler) {
  return async (url, init) => {
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    const res = await handler({
      url,
      path: parsed.pathname,
      method: init?.method || "GET",
      credentials: init?.credentials,
      body,
    });
    const json = res.json === undefined ? {} : res.json;
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      async text() {
        return json == null ? "" : JSON.stringify(json);
      },
    };
  };
}

function trialWith(handler, extras = {}) {
  const cloud = createCloud({
    baseUrl: "https://cloud.example.test",
    fetchImpl: mockFetch(handler),
  });
  return createTrial({ cloud, ...extras });
}

function expectedAuthToken(secret) {
  return createHash("sha256")
    .update(
      Buffer.concat([
        Buffer.from("relay-pair-auth-v1", "utf8"),
        Buffer.from([0]),
        Buffer.from(secret, "utf8"),
      ]),
    )
    .digest("base64url");
}

test("mintPairingSecret is 24 random bytes encoded as base64url", () => {
  const bytes = Uint8Array.from({ length: 24 }, (_, i) => i + 1);
  const secret = mintPairingSecret(() => bytes);
  assert.match(secret, /^[A-Za-z0-9_-]{22,128}$/);
  assert.equal(secret, Buffer.from(bytes).toString("base64url"));
});

test("deriveAuthToken is base64url sha256 of relay-pair-auth-v1 || 0x00 || secretUtf8", async () => {
  const secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQ";
  const token = await deriveAuthToken(secret);
  assert.equal(token, expectedAuthToken(secret));
  assert.match(token, /^[A-Za-z0-9_-]{22,128}$/);
});

test("startTrial posts pairing session authToken then trial-nodes with that pair", async () => {
  const secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQ";
  const token = expectedAuthToken(secret);
  const calls = [];
  const api = trialWith(
    ({ path, method, credentials, body }) => {
      calls.push({ path, method, credentials, body });
      if (path === "/v1/pairing/sessions") {
        return { status: 201, json: { pairingId: "11111111-1111-4111-8111-111111111111", expiresAt: 1 } };
      }
      if (path === "/v1/trial-nodes") {
        return {
          status: 201,
          json: {
            trial: {
              id: "trial-1",
              state: "creating",
              nodeId: null,
              nodeEncPubkey: null,
              sni: null,
              createdAt: 1,
              expiresAt: 2,
            },
          },
        };
      }
      return { status: 500, json: { error: "unexpected" } };
    },
    {
      mintSecret: () => secret,
    },
  );

  const result = await api.startTrial();
  assert.equal(result.status, 201);
  assert.equal(result.json.trial.state, "creating");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    path: "/v1/pairing/sessions",
    method: "POST",
    credentials: "include",
    body: { authToken: token },
  });
  assert.deepEqual(calls[1], {
    path: "/v1/trial-nodes",
    method: "POST",
    credentials: "include",
    body: {
      pairingId: "11111111-1111-4111-8111-111111111111",
      pairingSecret: secret,
    },
  });
  assert.equal(
    calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("startTrial retries a failed trial by posting trial-nodes again and never deletes", async () => {
  const secret = "c2VjcmV0LXNlY3JldC1zZWNyZXQ";
  const calls = [];
  const api = trialWith(
    ({ path, method, credentials, body }) => {
      calls.push({ path, method, credentials, body });
      if (path === "/v1/pairing/sessions") {
        return { status: 201, json: { pairingId: "11111111-1111-4111-8111-111111111111", expiresAt: 1 } };
      }
      return {
        status: 201,
        json: {
          trial: { id: "trial-1", state: "creating", nodeId: null, createdAt: 1, expiresAt: 2 },
        },
      };
    },
    { mintSecret: () => secret },
  );

  await api.startTrial();
  await api.startTrial();
  const trialPosts = calls.filter((call) => call.path === "/v1/trial-nodes");
  assert.equal(trialPosts.length, 2);
  assert.equal(
    calls.some((call) => call.path === "/v1/trial-nodes/current" && call.method === "DELETE"),
    false,
  );
});

test("pollUntilSettled GETs current until ready or failed", async () => {
  const polls = [];
  let n = 0;
  const sleeps = [];
  const api = trialWith(
    ({ path, method, credentials }) => {
      polls.push({ path, method, credentials });
      n += 1;
      if (n < 3) {
        return {
          status: 200,
          json: { trial: { id: "t1", state: "creating", nodeId: n === 1 ? null : "node-1" } },
        };
      }
      return { status: 200, json: { trial: { id: "t1", state: "ready", nodeId: "node-1" } } };
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );

  const result = await api.pollUntilSettled({ interval: 2 });
  assert.equal(result.json.trial.state, "ready");
  assert.equal(polls.length, 3);
  for (const poll of polls) {
    assert.equal(poll.path, "/v1/trial-nodes/current");
    assert.equal(poll.method, "GET");
    assert.equal(poll.credentials, "include");
  }
  assert.deepEqual(sleeps, [2000, 2000]);
});

test("provisioningStage maps creating/nodeId/ready/failed and has no Pairing row", () => {
  assert.deepEqual(provisioningStage({ state: "creating", nodeId: null }), {
    stage: "creating",
    label: "Creating",
  });
  assert.deepEqual(provisioningStage({ state: "creating", nodeId: "node-1" }), {
    stage: "booting",
    label: "Booting",
  });
  assert.deepEqual(provisioningStage({ state: "ready", nodeId: "node-1" }), {
    stage: "ready",
    label: "Ready",
  });
  assert.deepEqual(provisioningStage({ state: "failed", nodeId: null }), {
    stage: "failed",
    label: "Failed",
  });
  assert.equal(
    ["Creating", "Booting", "Ready", "Failed"].includes(
      provisioningStage({ state: "creating", nodeId: null }).label,
    ),
    true,
  );
  assert.notEqual(provisioningStage({ state: "creating", nodeId: "x" }).label, "Pairing");
});

test("kindWord is TRIAL for trial and YOUR MACHINE otherwise", () => {
  assert.equal(kindWord("trial"), "TRIAL");
  assert.equal(kindWord("byo"), "YOUR MACHINE");
  assert.equal(kindWord("managed"), "YOUR MACHINE");
});

test("machineStatusWord is a typographic status, never a dot", () => {
  const now = 1_700_000_000_000;
  assert.equal(
    machineStatusWord({
      node: { kind: "trial" },
      trial: { state: "ready", expiresAt: now + 6 * 86_400_000 + 3_600_000 },
      now,
    }),
    "TRIAL · 6 DAYS LEFT",
  );
  assert.equal(
    machineStatusWord({
      node: { kind: "trial" },
      trial: { state: "ready", expiresAt: now - 1 },
      now,
    }),
    "EXPIRED",
  );
  assert.equal(machineStatusWord({ node: { kind: "byo", lastSeen: now }, now }), "READY");
  assert.equal(machineStatusWord({ node: { kind: "trial" }, trial: { state: "failed" }, now }).includes("•"), false);
});

test("decideMachineAction offers New machine below nodes.max and waitlist at the cap", () => {
  const max1 = [{ feature: "nodes.max", value: "1" }];
  assert.deepEqual(
    decideMachineAction({
      nodes: [{ kind: "trial" }],
      entitlements: max1,
    }),
    { action: "new_machine" },
  );
  assert.deepEqual(
    decideMachineAction({
      nodes: [{ kind: "byo" }],
      entitlements: max1,
    }),
    { action: "waitlist" },
  );
  assert.deepEqual(
    decideMachineAction({
      nodes: [{ kind: "byo" }, { kind: "trial" }],
      entitlements: max1,
      waitlistJoined: true,
    }),
    { action: "on_waitlist" },
  );
  assert.deepEqual(
    decideMachineAction({
      nodes: [{ kind: "byo" }],
      entitlements: [{ feature: "nodes.max", value: "2" }],
    }),
    { action: "new_machine" },
  );
});

test("joinWaitlist posts the account email with credentials and does not delete the trial", async () => {
  const calls = [];
  const api = trialWith(({ path, method, credentials, body }) => {
    calls.push({ path, method, credentials, body });
    return { status: 202, json: { ok: true } };
  });
  const result = await api.joinWaitlist("Owner@Example.com");
  assert.equal(result.status, 202);
  assert.deepEqual(calls[0], {
    path: "/v1/waitlist",
    method: "POST",
    credentials: "include",
    body: { email: "Owner@Example.com" },
  });
  assert.equal(
    calls.some((call) => call.method === "DELETE"),
    false,
  );
});

test("trial API does not offer destroy", () => {
  const api = trialWith(() => ({ status: 200, json: {} }));
  assert.equal(typeof api.destroy, "undefined");
  assert.equal(typeof api.deleteTrial, "undefined");
  assert.equal(typeof api.destroyTrial, "undefined");
});
