import test from "node:test";
import assert from "node:assert/strict";
import { createCloud } from "../src/api/cloud.js";
import {
  CLI_CONFIRM_COPY,
  createDevice,
  parseUserCodeFromHash,
  qrPayloadFromStart,
  decideCliLogin,
  iphonePollErrorMessage,
} from "../src/api/device.js";

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

function deviceWith(handler, extras = {}) {
  const cloud = createCloud({
    baseUrl: "https://cloud.example.test",
    fetchImpl: mockFetch(handler),
  });
  return createDevice({ cloud, ...extras });
}

test("startWebLogin posts client web, machineName, and platform web", async () => {
  const calls = [];
  const api = deviceWith(({ path, method, credentials, body }) => {
    calls.push({ path, method, credentials, body });
    return {
      status: 201,
      json: {
        deviceCode: "secret-device-code",
        userCode: "ABCD-EFGH",
        verificationUri: "https://app.example/cli-login",
        verificationUriComplete: "https://app.example/cli-login#code=ABCD-EFGH",
        interval: 5,
        expiresIn: 900,
      },
    };
  });

  const result = await api.startWebLogin();
  assert.equal(result.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/v1/auth/device/start");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].credentials, "include");
  assert.deepEqual(calls[0].body, {
    client: "web",
    machineName: "This browser",
    platform: "web",
  });
  assert.equal(result.json.deviceCode, "secret-device-code");
});

test("qrPayloadFromStart uses verificationUriComplete and never includes deviceCode", () => {
  const start = {
    deviceCode: "secret-device-code",
    userCode: "ABCD-EFGH",
    verificationUri: "https://app.example/cli-login",
    verificationUriComplete: "https://app.example/cli-login#code=ABCD-EFGH",
  };
  const payload = qrPayloadFromStart(start);
  assert.equal(payload, "https://app.example/cli-login#code=ABCD-EFGH");
  assert.equal(payload.includes("secret-device-code"), false);
  assert.equal(payload.includes("deviceCode"), false);
  assert.match(payload, /#code=ABCD-EFGH$/);
});

test("qrPayloadFromStart throws if verificationUriComplete embeds the deviceCode", () => {
  assert.throws(
    () =>
      qrPayloadFromStart({
        deviceCode: "secret-device-code",
        userCode: "ABCD-EFGH",
        verificationUriComplete: "https://app.example/cli-login#code=secret-device-code",
      }),
    /qr_payload_leaked_device_code/,
  );
});

test("pollWebLogin retries authorization_pending then returns the 200 cookie grant", async () => {
  const calls = [];
  let polls = 0;
  const sleeps = [];
  const api = deviceWith(
    ({ path, method, credentials, body }) => {
      if (path === "/v1/auth/device/token") {
        calls.push({ path, method, credentials, body });
        polls += 1;
        if (polls < 3) {
          return { status: 400, json: { error: "authorization_pending" } };
        }
        return { status: 200, json: { accountId: "acc-1" } };
      }
      return { status: 404, json: { error: "missing" } };
    },
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => 0,
    },
  );

  const result = await api.pollWebLogin("secret-device-code", { interval: 5, expiresIn: 900 });
  assert.equal(result.status, 200);
  assert.equal(result.json.accountId, "acc-1");
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.path, "/v1/auth/device/token");
    assert.equal(call.method, "POST");
    assert.equal(call.credentials, "include");
    assert.deepEqual(call.body, { deviceCode: "secret-device-code" });
  }
  assert.deepEqual(sleeps, [5000, 5000, 5000]);
});

test("pollWebLogin gives up on expired_token and never treats it as success", async () => {
  const api = deviceWith(
    () => ({ status: 400, json: { error: "expired_token" } }),
    { sleep: async () => {}, now: () => 0 },
  );
  const result = await api.pollWebLogin("secret-device-code", { interval: 1, expiresIn: 30 });
  assert.equal(result.ok, false);
  assert.equal(result.json.error, "expired_token");
});

test("inspectUserCode and approveUserCode post the userCode with credentials", async () => {
  const calls = [];
  const api = deviceWith(({ path, method, credentials, body }) => {
    calls.push({ path, method, credentials, body });
    if (path.endsWith("/inspect")) {
      return {
        status: 200,
        json: { client: "cli", machineName: "dev-box", platform: "macos" },
      };
    }
    return { status: 200, json: { ok: true } };
  });

  const inspected = await api.inspectUserCode("ABCD-EFGH");
  const approved = await api.approveUserCode("ABCD-EFGH");
  assert.equal(inspected.json.client, "cli");
  assert.equal(approved.json.ok, true);
  assert.deepEqual(calls[0], {
    path: "/v1/auth/device/inspect",
    method: "POST",
    credentials: "include",
    body: { userCode: "ABCD-EFGH" },
  });
  assert.deepEqual(calls[1], {
    path: "/v1/auth/device/approve",
    method: "POST",
    credentials: "include",
    body: { userCode: "ABCD-EFGH" },
  });
});

test("parseUserCodeFromHash reads #code= and normalizes case and dash", () => {
  assert.equal(parseUserCodeFromHash("#code=ABCD-EFGH"), "ABCD-EFGH");
  assert.equal(parseUserCodeFromHash("#code=abcd-efgh"), "ABCD-EFGH");
  assert.equal(parseUserCodeFromHash("#code=abcdefgh"), "ABCD-EFGH");
  assert.equal(parseUserCodeFromHash("#foo=1&code=WXYZ-2345"), "WXYZ-2345");
  assert.equal(parseUserCodeFromHash("#code=TOOSHRT"), null);
  assert.equal(parseUserCodeFromHash(""), null);
  assert.equal(parseUserCodeFromHash("#other=1"), null);
});

test("CLI confirm copy is the exact operator warning", () => {
  assert.equal(
    CLI_CONFIRM_COPY,
    "Only continue if you just ran relay login on this computer.",
  );
});

test("decideCliLogin never auto-approves a web code as CLI", () => {
  assert.deepEqual(decideCliLogin({ hasSession: false }), { action: "login" });
  assert.deepEqual(
    decideCliLogin({
      hasSession: true,
      inspect: { ok: true, status: 200, json: { client: "web", machineName: "This browser" } },
    }),
    { action: "web_code" },
  );
  assert.deepEqual(
    decideCliLogin({
      hasSession: true,
      inspect: { ok: true, status: 200, json: { client: "cli", machineName: "dev-box" } },
    }),
    { action: "cli_confirm", machineName: "dev-box" },
  );
  assert.deepEqual(
    decideCliLogin({
      hasSession: true,
      inspect: { ok: false, status: 404, json: { error: "unknown_user_code" } },
    }),
    { action: "invalid" },
  );
  assert.deepEqual(
    decideCliLogin({
      hasSession: true,
      inspect: { ok: false, status: 409, json: { error: "computer_already_linked" } },
    }),
    { action: "computer_linked" },
  );
  assert.deepEqual(
    decideCliLogin({
      hasSession: true,
      inspect: { ok: false, status: 401, json: { error: "unauthorized" } },
    }),
    { action: "login" },
  );
});

test("iphonePollErrorMessage explains the browser cap", () => {
  assert.match(iphonePollErrorMessage("too_many_browsers"), /10 signed-in browsers/);
  assert.match(iphonePollErrorMessage("expired_token"), /isn't valid anymore/);
  assert.match(iphonePollErrorMessage("other"), /could not complete/);
});
