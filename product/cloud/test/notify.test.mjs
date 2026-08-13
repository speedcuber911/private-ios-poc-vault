import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  startTestApp,
  api,
  authed,
  signIn,
  makeNodeIdentity,
} from "./helpers.mjs";
import {
  apnsCollapseId,
  createHttp2Transport,
  APNS_COLLAPSE_ID_MAX_BYTES,
} from "../src/apns.js";

async function setupNodeWithDevices(t, apnsTokens = ["apns-token-aaa", "apns-token-bbb"]) {
  const session = await signIn(t);
  const identity = makeNodeIdentity();
  const nodeRes = await api(t.baseUrl, "POST", "/v1/nodes", {
    body: { kind: "byo", name: "box-1", pubkey: identity.pubkeyPem },
    ...authed(session.sessionToken),
  });
  assert.equal(nodeRes.status, 201);
  // Devices with APNs tokens, plus one without (must not receive pushes).
  const specs = apnsTokens.map((tok, i) => [`device-${i}`, tok]);
  specs.push(["mac-cli", null]);
  for (const [name, apnsToken] of specs) {
    const res = await api(t.baseUrl, "POST", "/v1/devices", {
      body: { name, platform: "ios", apnsToken },
      ...authed(session.sessionToken),
    });
    assert.equal(res.status, 201);
  }
  return { session, identity, nodeId: nodeRes.json.node.id };
}

// Per-node monotonic sequence, exactly as the relayd client is specified to
// derive it: max(lastSeq + 1, now).
function seqSource(startAt = 1) {
  let n = startAt;
  return () => n++;
}

function eventBody(t, nodeId, overrides = {}) {
  const base = {
    v: 1,
    nodeId,
    seq: overrides.seq ?? 1,
    jobId: "job-1",
    type: "job.needs_input",
    ts: t.clock.t,
  };
  return Buffer.from(JSON.stringify({ ...base, ...overrides }));
}

async function post(t, identity, body) {
  return api(t.baseUrl, "POST", "/v1/node-events", {
    raw: body,
    headers: { "x-relay-signature": identity.signBody(body) },
  });
}

// Loud failures are logged with console.warn; capture rather than pollute.
function captureWarnings() {
  const lines = [];
  const original = console.warn;
  console.warn = (...args) => lines.push(args.join(" "));
  return { lines, restore: () => { console.warn = original; } };
}

// Recording transport with a scripted response (or per-call responder).
function makeTransport(responder) {
  const requests = [];
  const transport = async (req) => {
    requests.push({ ...req, body: JSON.parse(req.body) });
    return typeof responder === "function"
      ? responder(req, requests.length - 1)
      : responder;
  };
  transport.requests = requests;
  return transport;
}

test("signed event ingest: happy path fans out APNs with correct categories", async () => {
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    const nextSeq = seqSource();

    // needs_input → mutable alert push to both push-capable devices.
    let body = eventBody(t, nodeId, { type: "job.needs_input", seq: nextSeq() });
    let res = await post(t, identity, body);
    assert.equal(res.status, 202);
    assert.equal(res.json.kind, "mutable");
    assert.equal(res.json.queued, 2);
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 2);
    for (const push of t.apnsTransport.requests) {
      assert.equal(push.headers["apns-push-type"], "alert");
      assert.equal(push.body.aps["mutable-content"], 1);
      assert.equal(push.body.aps.category, "RELAY_NEEDS_INPUT");
      // Minimal payload: ids only, no content fields.
      assert.deepEqual(Object.keys(push.body.relay).sort(), [
        "jobId",
        "nodeId",
        "seq",
        "ts",
        "type",
      ]);
      assert.ok(push.headers.authorization.startsWith("bearer "));
      assert.equal(push.headers["apns-topic"], "com.relay.test.app");
    }
    const tokens = t.apnsTransport.requests.map((r) => r.path);
    assert.ok(tokens.some((p) => p.endsWith("apns-token-aaa")));
    assert.ok(tokens.some((p) => p.endsWith("apns-token-bbb")));
    assert.equal(t.app.notify.stats().delivered, 2);

    // job.state → silent background push.
    t.apnsTransport.requests.length = 0;
    body = eventBody(t, nodeId, { type: "job.state", seq: nextSeq() });
    res = await post(t, identity, body);
    assert.equal(res.status, 202);
    assert.equal(res.json.kind, "silent");
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 2);
    for (const push of t.apnsTransport.requests) {
      assert.equal(push.headers["apns-push-type"], "background");
      assert.equal(push.body.aps["content-available"], 1);
      assert.equal(push.body.aps["mutable-content"], undefined);
    }

    // Ingest updates node last_seen.
    const admin = await api(t.baseUrl, "GET", "/v1/admin/nodes", {
      headers: { authorization: "Bearer test-admin-token-0123456789abcdef" },
    });
    assert.ok(admin.json.nodes[0].lastSeen > 0);
  } finally {
    await t.close();
  }
});

test("signed event ingest: tamper, wrong key, unknown node, bad shape rejected", async () => {
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);

    // Body tampered after signing.
    const body = eventBody(t, nodeId);
    const sig = identity.signBody(body);
    const tampered = eventBody(t, nodeId, { jobId: "job-EVIL" });
    let res = await api(t.baseUrl, "POST", "/v1/node-events", {
      raw: tampered,
      headers: { "x-relay-signature": sig },
    });
    assert.equal(res.status, 401);

    // Signature from a different key.
    const rogue = makeNodeIdentity();
    res = await api(t.baseUrl, "POST", "/v1/node-events", {
      raw: body,
      headers: { "x-relay-signature": rogue.signBody(body) },
    });
    assert.equal(res.status, 401);

    // Missing signature.
    res = await api(t.baseUrl, "POST", "/v1/node-events", { raw: body });
    assert.equal(res.status, 401);

    // Unknown node.
    const ghost = eventBody(t, "no-such-node");
    res = await post(t, identity, ghost);
    assert.equal(res.status, 404);

    // Unknown event type.
    const weird = eventBody(t, nodeId, { type: "job.exfiltrate" });
    res = await post(t, identity, weird);
    assert.equal(res.status, 400);

    // Unsupported protocol version.
    const future = eventBody(t, nodeId, { v: 99 });
    res = await post(t, identity, future);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "unsupported_version");

    // Nothing reached APNs.
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 0);
    assert.equal(t.app.registry.countNodeEvents(), 0);
  } finally {
    await t.close();
  }
});

test("event retention: 7-day sweep purges old events, keeps recent", async () => {
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    const nextSeq = seqSource();

    const oldBody = eventBody(t, nodeId, { type: "job.state", seq: nextSeq() });
    assert.equal((await post(t, identity, oldBody)).status, 202);
    assert.equal(t.app.registry.countNodeEvents(), 1);

    // 8 days later, a fresh event arrives; sweep must drop only the old one.
    t.clock.t += 8 * 24 * 3600 * 1000;
    const newBody = eventBody(t, nodeId, {
      type: "job.completed",
      seq: nextSeq(),
    });
    assert.equal((await post(t, identity, newBody)).status, 202);
    assert.equal(t.app.registry.countNodeEvents(), 2);

    t.app.runSweeps();
    assert.equal(t.app.registry.countNodeEvents(), 1);
    await t.app.notify.drain();
  } finally {
    await t.close();
  }
});

// ── DEFECT 1: collapse id must fit in 64 bytes for realistic ids ──────────
test("collapse id stays inside Apple's 64-byte cap for UUID node and job ids", async () => {
  // Direct: worst realistic case is a UUID node id and a UUID job id (73
  // bytes when concatenated, which APNs rejects with 400/BadCollapseId).
  const id = apnsCollapseId(randomUUID(), randomUUID(), "mutable");
  assert.ok(
    Buffer.byteLength(id, "utf8") <= APNS_COLLAPSE_ID_MAX_BYTES,
    `collapse id is ${Buffer.byteLength(id, "utf8")} bytes`,
  );
  // Deterministic: identical inputs must produce an identical key, otherwise
  // collapsing does nothing at all.
  const [n, j] = [randomUUID(), randomUUID()];
  assert.equal(apnsCollapseId(n, j, "mutable"), apnsCollapseId(n, j, "mutable"));
  assert.notEqual(apnsCollapseId(n, j, "mutable"), apnsCollapseId(n, "other", "mutable"));

  // End to end: node ids ARE randomUUIDs, so only the job id is ours to pick.
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    assert.equal(nodeId.length, 36, "node ids are UUIDs in this system");
    const jobId = randomUUID();
    const body = eventBody(t, nodeId, { jobId, seq: 1 });
    const res = await post(t, identity, body);
    assert.equal(res.status, 202);
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 2);
    for (const push of t.apnsTransport.requests) {
      const header = push.headers["apns-collapse-id"];
      assert.ok(header, "job-scoped pushes must carry a collapse id");
      assert.ok(
        Buffer.byteLength(header, "utf8") <= APNS_COLLAPSE_ID_MAX_BYTES,
        `apns-collapse-id is ${Buffer.byteLength(header, "utf8")} bytes, Apple caps it at 64`,
      );
    }
  } finally {
    await t.close();
  }
});

// ── DEFECT 2: a silent push must not evict a pending actionable alert ─────
test("collapse id is scoped to push class so silent pushes cannot evict alerts", async () => {
  assert.notEqual(
    apnsCollapseId("<node-id>", "<job-id>", "mutable"),
    apnsCollapseId("<node-id>", "<job-id>", "silent"),
  );

  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t, ["apns-token-aaa"]);
    const jobId = randomUUID();
    const nextSeq = seqSource();

    // Actionable alert the user has not responded to yet.
    let res = await post(
      t,
      identity,
      eventBody(t, nodeId, { jobId, type: "job.needs_input", seq: nextSeq() }),
    );
    assert.equal(res.status, 202);
    // …followed by a low-priority silent state sync for the SAME job.
    res = await post(
      t,
      identity,
      eventBody(t, nodeId, { jobId, type: "job.state", seq: nextSeq() }),
    );
    assert.equal(res.status, 202);
    await t.app.notify.drain();

    assert.equal(t.apnsTransport.requests.length, 2);
    const [alertPush, silentPush] = t.apnsTransport.requests;
    assert.equal(alertPush.headers["apns-push-type"], "alert");
    assert.equal(silentPush.headers["apns-push-type"], "background");
    assert.notEqual(
      alertPush.headers["apns-collapse-id"],
      silentPush.headers["apns-collapse-id"],
      "a background push sharing the alert's collapse id evicts an unread actionable alert",
    );

    // Two alerts for the same job DO still collapse onto each other.
    t.apnsTransport.requests.length = 0;
    res = await post(
      t,
      identity,
      eventBody(t, nodeId, { jobId, type: "job.needs_input", seq: nextSeq() }),
    );
    assert.equal(res.status, 202);
    await t.app.notify.drain();
    assert.equal(
      t.apnsTransport.requests[0].headers["apns-collapse-id"],
      alertPush.headers["apns-collapse-id"],
    );
  } finally {
    await t.close();
  }
});

// ── DEFECT 3: ingest latency must not depend on a black-holed device ──────
test("a hung APNs connection neither stalls ingest nor blocks other devices", { timeout: 20_000 }, async () => {
  const hung = { settled: false };
  const transport = makeTransport((req) => {
    if (req.path.endsWith("hung-token")) {
      // A black-holed connection: this promise never settles, ever.
      const blackHole = new Promise(() => {});
      blackHole.finally(() => {
        hung.settled = true;
      });
      return blackHole;
    }
    return { status: 200, headers: {}, body: "" };
  });
  const warnings = captureWarnings();
  const t = await startTestApp({ apnsTransport: transport });
  try {
    // Deliberately tiny deadline so the test does not wait on the real one.
    t.config.apns.requestTimeoutMs = 25;
    const { identity, nodeId } = await setupNodeWithDevices(t, [
      "hung-token",
      "good-token",
    ]);

    const res = await post(t, identity, eventBody(t, nodeId, { seq: 1 }));
    // Before the fix this awaited the hung send inline and never returned.
    assert.equal(res.status, 202);
    assert.equal(res.json.queued, 2);
    assert.equal(hung.settled, false, "ingest returned without the hung device settling");

    await t.app.notify.drain();
    const stats = t.app.notify.stats();
    assert.equal(stats.delivered, 1, "the healthy device is delivered to anyway");
    assert.equal(stats.timeout, 1, "the black-holed device is timed out, not awaited forever");
    assert.ok(
      warnings.lines.some((l) => l.includes("timed out")),
      `expected a timeout warning, got ${JSON.stringify(warnings.lines)}`,
    );
  } finally {
    warnings.restore();
    await t.close();
  }
});

// ── DEFECT 4: the HTTP/2 session must never leak ──────────────────────────
test("http2 transport destroys the session on every exit path", async () => {
  function fakeHttp2() {
    const sessions = [];
    const connect = () => {
      const session = new EventEmitter();
      session.destroyed = false;
      session.destroy = () => {
        if (session.destroyed) return;
        session.destroyed = true;
        session.emit("close");
      };
      // node:http2 tears the socket down once a gracefully-closed session has
      // no open streams, so close() models as destroy() here. That is exactly
      // why the OLD success path did not leak and the error paths did.
      session.close = () => session.destroy();
      session.request = () => {
        const req = new EventEmitter();
        req.end = () => {};
        req.close = () => {};
        session.stream = req;
        return req;
      };
      sessions.push(session);
      return session;
    };
    return { connect, sessions };
  }

  const call = (opts = {}) => {
    const h2 = fakeHttp2();
    const transport = createHttp2Transport({ connect: h2.connect, ...opts.factory });
    const promise = transport({
      host: "<apns-host>",
      path: "/3/device/<token>",
      headers: {},
      body: "{}",
      signal: opts.signal,
    });
    return { h2, promise, session: h2.sessions[0] };
  };

  // 1. Success path.
  {
    const { promise, session } = call();
    session.stream.emit("response", { ":status": 200 });
    session.stream.emit("data", Buffer.from('{"ok":true}'));
    session.stream.emit("end");
    const res = await promise;
    assert.equal(res.status, 200);
    assert.equal(session.destroyed, true, "session leaked on the success path");
  }

  // 2. Stream error.
  {
    const { promise, session } = call();
    session.stream.emit("error", new Error("stream boom"));
    await assert.rejects(promise, /stream boom/);
    assert.equal(session.destroyed, true, "session leaked on a stream error");
  }

  // 3. Session error — the original code's `client.on("error", reject)` left
  //    the socket open forever.
  {
    const { promise, session } = call();
    session.emit("error", new Error("session boom"));
    await assert.rejects(promise, /session boom/);
    assert.equal(session.destroyed, true, "session leaked on a session error");
  }

  // 4. Deadline.
  {
    const { promise, session } = call({ factory: { timeoutMs: 10 } });
    await assert.rejects(promise, /apns_request_timeout/);
    assert.equal(session.destroyed, true, "session leaked on timeout");
  }

  // 5. Caller abort.
  {
    const controller = new AbortController();
    const { promise, session } = call({ signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, /apns_request_aborted/);
    assert.equal(session.destroyed, true, "session leaked on abort");
  }
});

// ── DEFECT 5: delivery status must be inspected ───────────────────────────
test("APNs 403 is reported as failure, never as delivery, and is logged loudly", async () => {
  const transport = makeTransport({
    status: 403,
    headers: {},
    body: JSON.stringify({ reason: "InvalidProviderToken" }),
  });
  const warnings = captureWarnings();
  const t = await startTestApp({ apnsTransport: transport });
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    const res = await post(t, identity, eventBody(t, nodeId, { seq: 1 }));
    assert.equal(res.status, 202);
    // The response must not claim deliveries it did not make.
    assert.equal(res.json.devices, undefined);
    assert.equal(res.json.queued, 2);

    await t.app.notify.drain();
    const stats = t.app.notify.stats();
    assert.equal(stats.delivered, 0, "a 403 is not a delivery");
    assert.equal(stats.authFailed, 2);
    assert.ok(
      warnings.lines.some((l) => l.includes("AUTH FAILURE")),
      `a total push outage must be loud; got ${JSON.stringify(warnings.lines)}`,
    );
    // Push tokens must NOT be discarded because of a provider-side failure.
    const accountId = t.app.registry.adminListNodes()[0].accountId;
    assert.equal(t.app.registry.listPushDevices(accountId).length, 2);
    assert.equal(stats.tokensDropped, 0);
  } finally {
    warnings.restore();
    await t.close();
  }
});

test("APNs 410 Unregistered drops the dead token instead of retrying it forever", async () => {
  const transport = makeTransport((req) =>
    req.path.endsWith("dead-token")
      ? {
          status: 410,
          headers: {},
          body: JSON.stringify({ reason: "Unregistered", timestamp: 1 }),
        }
      : { status: 200, headers: {}, body: "" },
  );
  const t = await startTestApp({ apnsTransport: transport });
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t, [
      "dead-token",
      "live-token",
    ]);
    const accountId = t.app.registry.adminListNodes()[0].accountId;
    const nextSeq = seqSource();

    let res = await post(t, identity, eventBody(t, nodeId, { seq: nextSeq() }));
    assert.equal(res.status, 202);
    assert.equal(res.json.queued, 2);
    await t.app.notify.drain();

    let stats = t.app.notify.stats();
    assert.equal(stats.delivered, 1);
    assert.equal(stats.unregistered, 1);
    assert.equal(stats.tokensDropped, 1);

    // The dead token is gone; the live one is untouched.
    const tokens = t.app.registry.listPushDevices(accountId).map((d) => d.apnsToken);
    assert.deepEqual(tokens, ["live-token"]);

    // The next event does not retry the dead token.
    transport.requests.length = 0;
    res = await post(t, identity, eventBody(t, nodeId, { seq: nextSeq() }));
    assert.equal(res.json.queued, 1);
    await t.app.notify.drain();
    assert.equal(transport.requests.length, 1);
    assert.ok(transport.requests[0].path.endsWith("live-token"));

    // A 400 that is OUR bug (BadCollapseId) must never drop a token.
    stats = t.app.notify.stats();
    assert.equal(stats.tokensDropped, 1);
  } finally {
    await t.close();
  }
});

test("APNs 400 BadCollapseId is surfaced but never costs the user a push token", async () => {
  const transport = makeTransport({
    status: 400,
    headers: {},
    body: JSON.stringify({ reason: "BadCollapseId" }),
  });
  const warnings = captureWarnings();
  const t = await startTestApp({ apnsTransport: transport });
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    const accountId = t.app.registry.adminListNodes()[0].accountId;
    await post(t, identity, eventBody(t, nodeId, { seq: 1 }));
    await t.app.notify.drain();

    const stats = t.app.notify.stats();
    assert.equal(stats.delivered, 0);
    assert.equal(stats.rejected, 2);
    assert.equal(stats.tokensDropped, 0);
    assert.equal(t.app.registry.listPushDevices(accountId).length, 2);
    assert.ok(warnings.lines.some((l) => l.includes("BadCollapseId")));
  } finally {
    warnings.restore();
    await t.close();
  }
});

// ── DEFECT 6: replay protection ───────────────────────────────────────────
test("replaying a captured signed event is idempotent, not another push", async () => {
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    const body = eventBody(t, nodeId, { seq: 7, jobId: "job-1" });
    const signature = identity.signBody(body);

    // 25 identical (body, signature) presentations — the captured-request
    // attack, and also the node's own at-least-once retry.
    const statuses = [];
    for (let i = 0; i < 25; i++) {
      const res = await api(t.baseUrl, "POST", "/v1/node-events", {
        raw: body,
        headers: { "x-relay-signature": signature },
      });
      statuses.push([res.status, res.json.duplicate === true]);
    }
    await t.app.notify.drain();

    assert.deepEqual(statuses[0], [202, false]);
    for (const entry of statuses.slice(1)) {
      assert.deepEqual(entry, [202, true], "a replay is an idempotent 202");
    }
    assert.equal(t.app.registry.countNodeEvents(), 1, "one row, not 25");
    assert.equal(t.apnsTransport.requests.length, 2, "two devices, one push each");
    assert.equal(t.app.notify.stats().duplicates, 24);

    // A regressed / out-of-order sequence number is a duplicate too.
    const older = eventBody(t, nodeId, { seq: 3 });
    let res = await post(t, identity, older);
    assert.equal(res.status, 202);
    assert.equal(res.json.duplicate, true);

    // …and the next in-order event is accepted normally.
    const next = eventBody(t, nodeId, { seq: 8, type: "job.completed" });
    res = await post(t, identity, next);
    assert.equal(res.status, 202);
    assert.equal(res.json.duplicate, undefined);
    await t.app.notify.drain();
    assert.equal(t.apnsTransport.requests.length, 4);

    // A missing sequence number is not a valid event at all.
    const noSeq = Buffer.from(
      JSON.stringify({ v: 1, nodeId, jobId: "j", type: "job.state", ts: t.clock.t }),
    );
    res = await post(t, identity, noSeq);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "invalid_event");
  } finally {
    await t.close();
  }
});

test("a replay dated later, and any non-finite or out-of-window ts, is rejected", async () => {
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);

    const body = eventBody(t, nodeId, { seq: 1 });
    assert.equal((await post(t, identity, body)).status, 202);
    assert.equal(t.app.registry.countNodeEvents(), 1);

    // The same capture, presented a year later. The cursor already rejects
    // it; the clock window rejects it even if the events table has been
    // swept in the meantime.
    t.clock.t += 365 * 24 * 3600 * 1000;
    let res = await post(t, identity, body);
    assert.equal(res.status, 400);
    assert.equal(res.json.error, "ts_out_of_window");

    // ts must be a finite integer near server time. Each of these was
    // accepted and stored before the fix.
    const nextSeq = seqSource(100);
    for (const [ts, expected] of [
      [-1, "ts_out_of_window"],
      [1.5, "invalid_event"],
      [1e308, "invalid_event"],
      [Number.NaN, "invalid_event"],
      [t.clock.t + 60 * 60 * 1000, "ts_out_of_window"], // an hour ahead
      [t.clock.t - 60 * 60 * 1000, "ts_out_of_window"], // an hour behind
      ["1754700000000", "invalid_event"],
    ]) {
      const bad = eventBody(t, nodeId, { ts, seq: nextSeq() });
      res = await post(t, identity, bad);
      assert.equal(res.status, 400, `ts=${String(ts)} must be rejected`);
      assert.equal(res.json.error, expected, `ts=${String(ts)}`);
    }

    await t.app.notify.drain();
    assert.equal(t.app.registry.countNodeEvents(), 1, "nothing else was stored");
    assert.equal(t.apnsTransport.requests.length, 2, "no extra pushes");

    // A slightly-fast node clock is tolerated, but the stored value is
    // clamped so it cannot outlive retention.
    const skewed = eventBody(t, nodeId, { ts: t.clock.t + 30_000, seq: 200 });
    assert.equal((await post(t, identity, skewed)).status, 202);
    await t.app.notify.drain();
    const push = t.apnsTransport.requests.at(-1);
    assert.equal(push.body.relay.ts, t.clock.t, "stored/forwarded ts is min(ts, now)");
  } finally {
    await t.close();
  }
});

// ── content-free guarantee ────────────────────────────────────────────────
test("pushes carry ids and event types only — never prompts, paths or names", async () => {
  const t = await startTestApp();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t);
    const SECRETS = [
      "rm -rf the production database",
      "/Users/<user>/secret-project/notes.md",
      "acme-internal-workspace",
      "the model said something confidential",
    ];
    // A node that (buggily or maliciously) attaches content must not be able
    // to get any of it forwarded to Apple or written to the events table.
    const body = Buffer.from(
      JSON.stringify({
        v: 1,
        nodeId,
        seq: 1,
        jobId: "01J8XPQ4M0000000000000000",
        type: "job.needs_input",
        ts: t.clock.t,
        prompt: SECRETS[0],
        path: SECRETS[1],
        workspace: SECRETS[2],
        output: SECRETS[3],
        title: SECRETS[0],
      }),
    );
    const res = await post(t, identity, body);
    assert.equal(res.status, 202);
    await t.app.notify.drain();

    assert.equal(t.apnsTransport.requests.length, 2);
    for (const push of t.apnsTransport.requests) {
      const serialized = JSON.stringify(push.body);
      for (const secret of SECRETS) {
        assert.ok(
          !serialized.includes(secret),
          `push payload leaked content: ${serialized}`,
        );
      }
      assert.deepEqual(Object.keys(push.body.relay).sort(), [
        "jobId",
        "nodeId",
        "seq",
        "ts",
        "type",
      ]);
      // A job banner is a FIXED string — the cloud holds no job titles, and
      // nothing the node attached to the event may reach it. The SECRETS loop
      // above already proves the negative; this pins the positive, so a future
      // change that starts interpolating event fields into the banner fails
      // here rather than only on a payload that happens to name a secret.
      assert.deepEqual(push.body.aps.alert, {
        title: "Waiting on you",
        body: "A run needs your approval to continue.",
      });
      assert.deepEqual(Object.keys(push.body).sort(), ["aps", "relay"]);
    }

    // Nothing content-shaped reached storage either.
    const stored = JSON.stringify(
      t.app.db.prepare("SELECT * FROM node_events").all(),
    );
    for (const secret of SECRETS) assert.ok(!stored.includes(secret));

    // Free-form ids cannot smuggle prose past validation.
    const prose = eventBody(t, nodeId, {
      seq: 2,
      jobId: "job 1; drop the workspace named acme",
    });
    const rejected = await post(t, identity, prose);
    assert.equal(rejected.status, 400);
    assert.equal(rejected.json.error, "invalid_event");
  } finally {
    await t.close();
  }
});

// A fanout must say what it did, per fanout, in one line.
//
// Diagnosing a real "no notification arrived" report, the entire server-side
// record of a 27-device fanout was ONE line:
//
//   apns transport error: The pending stream has been canceled
//
// and that was consistent with 1 failure or with 27. alert() is rate-limited
// per key, so repeated failures collapse to a single line, and the stats
// counters — delivered, unregistered, error — were never printed anywhere at
// all. There was no way to tell a working fanout from a totally broken one.
test("every fanout logs a per-fanout outcome summary", async () => {
  const t = await startTestApp();
  const warn = captureWarnings();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t, ["tok-a", "tok-b"]);
    const res = await post(t, identity, eventBody(t, nodeId, { type: "handoff.ready", seq: 1 }));
    assert.equal(res.status, 202);
    await t.app.notify.drain();

    const summary = warn.lines.find((line) => line.startsWith("apns fanout:"));
    assert.ok(summary, `no fanout summary was logged; saw: ${JSON.stringify(warn.lines)}`);
    assert.match(summary, /devices=2/);
    assert.match(summary, /delivered=2/, "a successful fanout must state how many arrived");
  } finally {
    warn.restore();
    await t.close();
  }
});

// The case that was invisible: the summary must distinguish partial failure
// from success, even though alert() has already collapsed the error lines.
test("the summary separates delivered from failed when both happen", async () => {
  // First device 200, every later one a transport error.
  let n = 0;
  const transport = async () => {
    n += 1;
    if (n === 1) return { status: 200, headers: {}, body: "" };
    throw new Error("The pending stream has been canceled");
  };
  const t = await startTestApp({ apnsTransport: transport });
  const warn = captureWarnings();
  try {
    const { identity, nodeId } = await setupNodeWithDevices(t, ["tok-a", "tok-b", "tok-c"]);
    await post(t, identity, eventBody(t, nodeId, { type: "handoff.ready", seq: 1 }));
    await t.app.notify.drain();

    const summary = warn.lines.find((line) => line.startsWith("apns fanout:"));
    assert.ok(summary, "a summary must be logged even when sends fail");
    assert.match(summary, /devices=3/);
    assert.match(summary, /delivered=1/);
    assert.match(summary, /error=2/, "the failures must be counted, not just alerted once");
  } finally {
    warn.restore();
    await t.close();
  }
});
