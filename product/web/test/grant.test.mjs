import test from "node:test";
import assert from "node:assert/strict";
import { createCloud } from "../src/api/cloud.js";
import {
  CANT_REACH_MACHINE,
  NO_RUNS_YET,
  activityCopy,
  createGrant,
} from "../src/api/grant.js";

const GRANT_V1 = "header.payload.signature-one";
const GRANT_V2 = "header.payload.signature-two";

function mockFetch(handler) {
  return async (url, init) => {
    const parsed = new URL(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    const res = await handler({
      url,
      path: parsed.pathname,
      origin: parsed.origin,
      method: init?.method || "GET",
      credentials: init?.credentials,
      headers: init?.headers || {},
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

function grantWith(handler) {
  const fetchImpl = mockFetch(handler);
  const cloud = createCloud({
    baseUrl: "https://cloud.example.test",
    fetchImpl,
  });
  return createGrant({ cloud, fetchImpl });
}

test("mintBrowserGrant posts to /v1/nodes/:id/browser-grants with credentials", async () => {
  const calls = [];
  const api = grantWith(({ path, method, credentials, body }) => {
    calls.push({ path, method, credentials, body });
    return {
      status: 201,
      json: { grant: GRANT_V1, expiresIn: 900, gatewayUrl: "https://gateway.example.test" },
    };
  });
  const result = await api.mintBrowserGrant("node-1");
  assert.equal(result.status, 201);
  assert.deepEqual(calls[0], {
    path: "/v1/nodes/node-1/browser-grants",
    method: "POST",
    credentials: "include",
    body: null,
  });
});

test("loadActivity fetches jobs and threads with the grant and remints once on 401", async () => {
  const calls = [];
  let grants = 0;
  const api = grantWith(({ path, origin, method, credentials, headers }) => {
    calls.push({ path, origin, method, credentials, authorization: headers.authorization });
    if (path === "/v1/nodes/node-1/browser-grants") {
      grants += 1;
      return {
        status: 201,
        json: {
          grant: grants === 1 ? GRANT_V1 : GRANT_V2,
          expiresIn: 900,
          gatewayUrl: "https://gateway.example.test",
        },
      };
    }
    if (path === "/activity/jobs") {
      if (headers.authorization === `Bearer ${GRANT_V1}`) {
        return { status: 401, json: { error: "unauthorized" } };
      }
      return { status: 200, json: { jobs: [{ id: "job-1", status: "running", durationMs: 134000 }] } };
    }
    if (path === "/activity/threads") {
      return { status: 200, json: { threads: [{ id: "th-1", lastJobStatus: "succeeded" }] } };
    }
    return { status: 500, json: { error: "unexpected" } };
  });

  const result = await api.loadActivity("node-1");
  assert.equal(result.ok, true);
  assert.equal(result.jobs[0].id, "job-1");
  assert.equal(result.threads[0].id, "th-1");
  const grantMints = calls.filter((call) => call.path.endsWith("/browser-grants"));
  assert.equal(grantMints.length, 2);
  const jobGets = calls.filter((call) => call.path === "/activity/jobs");
  assert.equal(jobGets.length, 2);
  assert.equal(jobGets[0].authorization, `Bearer ${GRANT_V1}`);
  assert.equal(jobGets[1].authorization, `Bearer ${GRANT_V2}`);
  assert.equal(jobGets[0].credentials, "include");
  assert.equal(jobGets[0].origin, "https://gateway.example.test");
  assert.equal(
    calls.filter((call) => call.path.endsWith("/browser-grants")).length <= 2,
    true,
  );
});

test("loadActivity does not remint a second time after a 401 retry still fails", async () => {
  let grants = 0;
  const api = grantWith(({ path }) => {
    if (path.endsWith("/browser-grants")) {
      grants += 1;
      return {
        status: 201,
        json: { grant: `g${grants}`, expiresIn: 900, gatewayUrl: "https://gateway.example.test" },
      };
    }
    return { status: 401, json: { error: "unauthorized" } };
  });
  const result = await api.loadActivity("node-1");
  assert.equal(result.ok, false);
  assert.equal(result.error, CANT_REACH_MACHINE);
  assert.equal(grants, 2);
});

test("loadActivity failure copy is Can't reach this machine", async () => {
  const api = grantWith(() => ({ status: 503, json: { error: "grants_unavailable" } }));
  const result = await api.loadActivity("node-1");
  assert.equal(result.ok, false);
  assert.equal(result.error, "Can't reach this machine.");
});

test("activityCopy uses the exact empty and failure strings", () => {
  assert.equal(activityCopy({ ok: false }), "Can't reach this machine.");
  assert.equal(activityCopy({ ok: true, jobs: [], threads: [] }), "No runs yet.");
  assert.equal(activityCopy({ ok: true, jobs: [{ id: "1" }], threads: [] }), null);
  assert.equal(CANT_REACH_MACHINE, "Can't reach this machine.");
  assert.equal(NO_RUNS_YET, "No runs yet.");
});

test("loadActivity never logs the grant JWT", async () => {
  const seen = [];
  const methods = ["log", "info", "warn", "error", "debug"];
  const originals = {};
  for (const method of methods) {
    originals[method] = console[method];
    console[method] = (...args) => {
      seen.push(args.map((arg) => String(arg)).join(" "));
    };
  }
  try {
    const api = grantWith(({ path }) => {
      if (path.endsWith("/browser-grants")) {
        return {
          status: 201,
          json: { grant: GRANT_V1, expiresIn: 900, gatewayUrl: "https://gateway.example.test" },
        };
      }
      return { status: 200, json: { jobs: [], threads: [] } };
    });
    await api.loadActivity("node-1");
  } finally {
    for (const method of methods) console[method] = originals[method];
  }
  assert.equal(
    seen.some((line) => line.includes(GRANT_V1)),
    false,
  );
});
