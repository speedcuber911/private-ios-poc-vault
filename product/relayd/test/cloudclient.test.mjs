import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-data-"));

const { initIdentity, identityPaths } = await import("../src/identity.mjs");
const { createCloudClient } = await import("../src/cloudclient.mjs");

const SIGNING_LABEL = "relay-node-req-v1";

function startFakeCloud(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, headers: req.headers, raw: Buffer.concat(chunks) });
        handler(res, calls.at(-1), calls);
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

function respondAccepted(res) {
  res.writeHead(202, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
}

function freshNode() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-"));
  const status = initIdentity({ baseDir });
  const paths = identityPaths(baseDir);
  const publicKey = crypto.createPublicKey(fs.readFileSync(paths.identityPubPath, "utf8"));
  return { baseDir, nodeId: status.nodeId, publicKey };
}

test("pollHandoffs signs the exact method, path, node id, and timestamp", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x" }] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    const handoffs = await client.pollHandoffs(20);

    assert.deepEqual(handoffs, [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x" }]);
    const call = cloud.calls[0];
    assert.equal(call.url, "/v1/node/handoffs?wait=20");
    assert.equal(call.headers["x-relay-node"], node.nodeId);

    const input = Buffer.from(
      `${SIGNING_LABEL}\nGET\n/v1/node/handoffs?wait=20\n${node.nodeId}\n${call.headers["x-relay-ts"]}`, "utf8");
    const signature = Buffer.from(call.headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, input, node.publicKey, signature), "the signature verifies against the node key");
  } finally { await cloud.close(); }
});

test("postEvent signs the raw body and advances a persistent sequence seeded from the clock", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud(respondAccepted);
  const FIXED_TS = 1754700000123;
  try {
    const first = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir, now: () => FIXED_TS });
    await first.postEvent("handoff.ready", { jobId: "job-1" });
    await first.postEvent("handoff.failed");

    // A fresh client stands in for a daemon restart: the sequence must not reset.
    const second = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir, now: () => FIXED_TS });
    await second.postEvent("handoff.ready");

    const bodies = cloud.calls.map((call) => JSON.parse(call.raw.toString("utf8")));
    // Seeded from the clock (max(current + 1, now())), not a bare 1/2/3 counter:
    // once seeded, current+1 stays ahead of the fixed clock so it increments by one.
    assert.deepEqual(bodies.map((body) => body.seq), [FIXED_TS, FIXED_TS + 1, FIXED_TS + 2]);
    assert.deepEqual(bodies.map((body) => body.type), ["handoff.ready", "handoff.failed", "handoff.ready"]);
    assert.equal(bodies[0].jobId, "job-1");
    assert.equal(bodies[1].jobId, null);
    assert.equal(bodies[0].nodeId, node.nodeId);
    assert.equal(bodies[0].v, 1);

    const signature = Buffer.from(cloud.calls[0].headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, cloud.calls[0].raw, node.publicKey, signature),
      "the event signature covers the exact raw body");
  } finally { await cloud.close(); }
});

test("a non-200 poll surfaces as an error rather than a silent empty list", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => { res.writeHead(503); res.end("{}"); });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await assert.rejects(() => client.pollHandoffs(5), /cloud_poll_503/);
  } finally { await cloud.close(); }
});

test("a node without an identity refuses to build a client", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-cloudclient-empty-"));
  assert.throws(() => createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir }), /cloud_client_no_identity/);
});

// ---------------------------------------------------------------------------
// CRITICAL: the sequence counter must never silently reset to 1. An
// unreadable/garbage/negative persisted value must seed from the clock
// instead, so a lost counter self-heals rather than permanently blackholing
// every future push (the cloud treats a low seq against its high-water mark
// as {duplicate:true} and drops it, looking exactly like success).
test("nextSeq seeds from the clock — not 1 — when the seq file is missing, empty, whitespace, garbage, or negative", async () => {
  const FIXED_TS = 1755000000123;
  const cases = [
    ["missing file", null],
    ["empty file", ""],
    ["whitespace-only", "   \n"],
    ["garbage", "not-a-number"],
    ["negative", "-5"],
    ["torn read (partial digit of a bigger number)", "1"],
  ];
  for (const [label, content] of cases) {
    const node = freshNode();
    const cloud = await startFakeCloud(respondAccepted);
    try {
      if (content !== null) fs.writeFileSync(path.join(node.baseDir, "cloud-event-seq"), content);
      const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir, now: () => FIXED_TS });
      await client.postEvent("handoff.ready");
      const body = JSON.parse(cloud.calls[0].raw.toString("utf8"));
      assert.equal(body.seq, FIXED_TS, `${label}: must self-heal to the clock value, not reset to a small counter`);
    } finally { await cloud.close(); }
  }
});

test("nextSeq reseeds from the clock instead of emitting an unsafe integer when the persisted seq overflows", async () => {
  const FIXED_TS = 1755000000456;
  const node = freshNode();
  fs.writeFileSync(path.join(node.baseDir, "cloud-event-seq"), String(Number.MAX_SAFE_INTEGER));
  const cloud = await startFakeCloud(respondAccepted);
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir, now: () => FIXED_TS });
    await client.postEvent("handoff.ready");
    const body = JSON.parse(cloud.calls[0].raw.toString("utf8"));
    assert.ok(Number.isSafeInteger(body.seq), "seq must stay a safe integer even after a persisted MAX_SAFE_INTEGER");
    assert.equal(body.seq, FIXED_TS);
  } finally { await cloud.close(); }
});

// nextSeq's write must go through config.mjs's writeFileAtomic (unique temp
// name + rename), not an in-place fs.writeFileSync (O_TRUNC). rename() is
// what makes a concurrent reader atomic: it can only ever see the whole old
// file or the whole new one, never a half-written one (a "torn read"). This
// is checked directly (rather than by racing real processes, which is
// inherently timing-dependent) so the regression signal is deterministic.
test("nextSeq persists the seq file via an atomic rename, not an in-place truncating write", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud(respondAccepted);
  const seqPath = path.join(node.baseDir, "cloud-event-seq");
  const originalRename = fs.renameSync;
  const renames = [];
  fs.renameSync = (from, to) => {
    if (to === seqPath) renames.push(from);
    return originalRename(from, to);
  };
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    await client.postEvent("handoff.ready");
  } finally {
    fs.renameSync = originalRename;
    await cloud.close();
  }
  assert.equal(renames.length, 1, "the seq file must be written by renaming a temp file into place");
  assert.notEqual(renames[0], seqPath, "the rename source must be a distinct temp file, never the seq path itself");
  assert.ok(fs.existsSync(seqPath));
  assert.ok(!fs.existsSync(renames[0]), "the temp file must not survive a successful rename");
});

// Reproduces the reviewer's exact measurement: three processes racing 40
// postEvent calls each against one shared seq file. Under the OLD
// fs.writeFileSync (O_TRUNC, not safe against a concurrent reader), a torn
// read could parse as a small garbage number, and multiple writers reset to
// that same small number — the reviewer measured 120 emitted collapsing to
// 56 distinct (64 collisions), with the persisted file left reading "29"
// while the highest seq actually emitted was 1027. Atomic (rename-based)
// writes remove that collapse mechanism; every seq is seeded from the clock,
// so a real collision can only tie two writers at a large, clock-plausible
// value — never a reset to a small one. This test asserts BOTH: the
// blackhole/reset pattern is gone (deterministic), and — as of the task-11
// review follow-up wiring nextSeq() through config.mjs's withFileLock — the
// residual cross-process tie window (independently measured at 57.5%-87.5%
// distinct across 19 trials of this exact scenario when nextSeq() was
// unsynchronized) is closed: every event now gets a distinct seq, verified
// below rather than merely logged.
test("concurrent postEvent calls from multiple processes never reset to a small/blackhole seq", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud(respondAccepted);
  const testStartedAt = Date.now();
  try {
    const workerPath = path.join(node.baseDir, "..", `cloudclient-race-worker-${process.pid}.mjs`);
    const cloudclientUrl = new URL("../src/cloudclient.mjs", import.meta.url).href;
    const COUNT = 40;
    fs.writeFileSync(
      workerPath,
      [
        `const { createCloudClient } = await import(${JSON.stringify(cloudclientUrl)});`,
        `const client = createCloudClient({ cloudUrl: ${JSON.stringify(cloud.url)}, baseDir: ${JSON.stringify(node.baseDir)} });`,
        `for (let i = 0; i < ${COUNT}; i++) { await client.postEvent("handoff.ready"); }`,
      ].join("\n"),
      "utf8",
    );

    const PROCS = 3;
    await Promise.all(
      Array.from({ length: PROCS }, () => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [workerPath], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exited ${code}: ${stderr}`))));
      })),
    );

    const seqs = cloud.calls.map((call) => JSON.parse(call.raw.toString("utf8")).seq);
    assert.equal(seqs.length, PROCS * COUNT, "every event must reach the fake cloud");

    // Deterministic, load-independent: this is the actual CRITICAL claim
    // ("silently resets to 1, permanently blackholing"). A reset would show
    // up as a seq far below testStartedAt regardless of how much residual
    // cross-process contention there is.
    const minSeq = Math.min(...seqs);
    assert.ok(
      minSeq >= testStartedAt,
      `no seq may fall back into a small/blackhole range; smallest observed was ${minSeq}, test started at ${testStartedAt}`,
    );

    // Now asserted, not just logged: nextSeq()'s read-modify-write is
    // serialized across processes with config.mjs's withFileLock (task-11
    // review follow-up), so every one of the 120 events gets a genuinely
    // distinct seq — no cross-process tie survives. Pre-fix this same
    // workload collapsed to ~37-47% distinct (45-56/120) from torn reads
    // resetting multiple writers to the same small number; that collapse
    // mechanism was already gone once seq writes became atomic (proved
    // deterministically above and by the atomic-rename test) but the file
    // lock is what actually eliminates the READ-then-WRITE race itself,
    // rather than just narrowing its blast radius.
    const distinct = new Set(seqs).size;
    if (process.env.RELAYD_TEST_VERBOSE) {
      console.log(`[cloudclient race] ${distinct}/${seqs.length} distinct seqs`);
    }
    assert.equal(distinct, seqs.length, "every concurrent event must get a distinct seq now that nextSeq() is file-locked");
    fs.rmSync(workerPath, { force: true });
  } finally { await cloud.close(); }
});

// ---------------------------------------------------------------------------
// IMPORTANT: nextSeq() is synchronous, so seq ALLOCATION is already ordered
// by call order within one process. But an unserialized send lets the actual
// network requests race, so a lower seq can arrive at the cloud after a
// higher one and get dropped as a duplicate. Delivery must be serialized
// through one promise chain.
test("postEvent serializes delivery so concurrent calls reach the wire in call order", async () => {
  const node = freshNode();
  const seenTypes = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let fetchCalls = 0;
  const fetchImpl = async (_url, opts) => {
    fetchCalls += 1;
    if (fetchCalls === 1) await firstGate; // hold the first request open
    seenTypes.push(JSON.parse(Buffer.from(opts.body).toString("utf8")).type);
    return { status: 202, json: async () => ({ ok: true }) };
  };
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });

  const p1 = client.postEvent("handoff.ready");
  const p2 = client.postEvent("handoff.failed");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1, "the second send must not dispatch until the first has settled");

  releaseFirst();
  await Promise.all([p1, p2]);
  assert.deepEqual(seenTypes, ["handoff.ready", "handoff.failed"], "requests must land on the wire in call order");
});

// ---------------------------------------------------------------------------
// IMPORTANT: postEvent must expose whether the cloud actually accepted the
// push, not just that the HTTP round trip completed — a 202 {duplicate:true}
// looks identical to a genuine accept at the {status,body} level.
test("postEvent reports accepted:false for a dropped duplicate and accepted:true for a genuine accept", async () => {
  const node = freshNode();
  let call = 0;
  const fetchImpl = async () => {
    call += 1;
    if (call === 1) return { status: 202, json: async () => ({ ok: true, duplicate: true }) };
    return { status: 202, json: async () => ({ ok: true }) };
  };
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });

  const dropped = await client.postEvent("handoff.ready");
  assert.equal(dropped.accepted, false, "a duplicate must not read as accepted");

  const accepted = await client.postEvent("handoff.ready");
  assert.equal(accepted.accepted, true);
});

// MINOR (task-11 review follow-up): a 202 whose body fails to parse as JSON
// used to read as accepted:true (parsedBody was null, and `!null?.duplicate`
// is true) — a malformed-but-202 response was indistinguishable from a
// genuine accept. It must now read as not-accepted instead.
test("postEvent reports accepted:false for a 202 whose body fails to parse as JSON", async () => {
  const node = freshNode();
  const fetchImpl = async () => ({ status: 202, json: async () => { throw new Error("invalid json"); } });
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });

  const result = await client.postEvent("handoff.ready");
  assert.equal(result.status, 202);
  assert.equal(result.body, null);
  assert.equal(result.accepted, false, "an unparseable 202 body must not read as a genuine accept");
});

test("postEvent reports accepted:false (and does not throw) for a signature or unknown-node rejection", async () => {
  const node = freshNode();
  const responses = [
    { status: 401, json: async () => ({ error: "bad_signature" }) },
    { status: 404, json: async () => ({ error: "unknown_node" }) },
  ];
  let call = 0;
  const fetchImpl = async () => responses[call++];
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });

  const badSig = await client.postEvent("handoff.ready");
  assert.equal(badSig.accepted, false);
  assert.equal(badSig.status, 401);

  const unknownNode = await client.postEvent("handoff.ready");
  assert.equal(unknownNode.accepted, false);
  assert.equal(unknownNode.status, 404);
});

// ---------------------------------------------------------------------------
// MINOR 1: an empty/null cloudUrl must fail fast at construction, not with an
// opaque TypeError the first time a request is attempted.
test("an empty or null cloudUrl refuses to build a client", () => {
  const node = freshNode();
  assert.throws(() => createCloudClient({ cloudUrl: "", baseDir: node.baseDir }), /cloud_client_no_url/);
  assert.throws(() => createCloudClient({ cloudUrl: null, baseDir: node.baseDir }), /cloud_client_no_url/);
});

// ---------------------------------------------------------------------------
// MINOR 2: cleanOptionalUrlBase preserves a path component on the base URL
// (e.g. RELAYD_CLOUD_URL=https://host/api), but the signed pathWithQuery is
// always rooted at /v1/... . A non-root base would put /api/v1/... on the
// wire while the signature covers /v1/..., producing an unexplainable
// bad_signature. Reject it at construction instead.
test("a cloud base URL carrying a path is rejected at construction", () => {
  const node = freshNode();
  assert.throws(
    () => createCloudClient({ cloudUrl: "http://127.0.0.1:1/api", baseDir: node.baseDir }),
    /cloud_client_base/,
  );
  // Root URLs (no path, or just a trailing slash) remain fine.
  assert.doesNotThrow(() => createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir }));
  assert.doesNotThrow(() => createCloudClient({ cloudUrl: "http://127.0.0.1:1/", baseDir: node.baseDir }));
});

// ---------------------------------------------------------------------------
// MINOR 3: the seq is consumed at body-build time. If the send is retried
// internally (transient network failure), the retry must reuse the exact
// same signed body/seq rather than building a fresh one — otherwise the
// cloud receives two different seqs for one logical event and pushes twice.
test("postEvent reuses one body and one seq across an internal retry", async () => {
  const node = freshNode();
  const seenRaw = [];
  let attempt = 0;
  const fetchImpl = async (_url, opts) => {
    attempt += 1;
    seenRaw.push(Buffer.from(opts.body).toString("utf8"));
    if (attempt === 1) throw new Error("simulated_network_failure");
    return { status: 202, json: async () => ({ ok: true }) };
  };
  const client = createCloudClient({
    cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl, now: () => 1755000000999,
  });

  const result = await client.postEvent("handoff.ready");
  assert.equal(result.accepted, true);
  assert.equal(attempt, 2, "expected exactly one retry after the simulated failure");
  assert.equal(seenRaw[0], seenRaw[1], "the retried attempt must resend the identical signed body, not rebuild one");

  await client.postEvent("handoff.failed");
  const firstBody = JSON.parse(seenRaw[0]);
  const followUpBody = JSON.parse(seenRaw.at(-1));
  assert.equal(
    followUpBody.seq, firstBody.seq + 1,
    "only one seq should have been consumed by the retried call, not one per attempt",
  );
});

test("postEvent gives up after a bounded number of attempts rather than retrying forever", async () => {
  const node = freshNode();
  let attempts = 0;
  const fetchImpl = async () => { attempts += 1; throw new Error("simulated_network_failure"); };
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });
  await assert.rejects(() => client.postEvent("handoff.ready"));
  assert.ok(attempts >= 1 && attempts <= 5, `expected a small bounded retry count, saw ${attempts} attempts`);
});

// ---------------------------------------------------------------------------
// task-11: relayd's half of the delivery-lease contract. The cloud (commit
// 8bffba2, .superpowers/sdd/handoff/task-8-report.md) now hands out a LEASE
// on poll rather than marking a handoff delivered the instant it writes the
// response — a partitioned node (no FIN, socket looks alive) used to have
// its handoff marked delivered into a dead peer and lost for good. The ack
// below is the only path to `delivered`; it belongs in pollHandoffs (the
// transport layer, which is the only place that actually knows the bytes
// crossed a live connection), not in the handoff-import loop, and it must
// never be gated on import succeeding — that would resurrect the same
// lost-handoff bug in a new shape.

// A minimal per-test guard against the documented trap: node:test's per-test
// `timeout` does not kill a hung async loop underneath it, it just marks the
// test cancelled while the loop keeps running — which is how a broken bound
// leaves an orphaned process behind instead of a fast, clean failure.
function withHardTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hard guard: ${label} exceeded ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// A faithful-enough model of the cloud's lease semantics (poll hands out a
// pending row with a fresh random token and a short visibility timeout; an
// unconfirmed lease expires and becomes claimable again; POST .../ack is the
// only path to `delivered`), entirely self-contained in this test file —
// cloudclient.mjs's job ends at making the poll/ack HTTP calls correctly, so
// this fake does not verify signatures (that is covered directly, below, by
// checking the ack request against nodeRequestSigningInput).
function startLeasingFakeCloud({ handoffs, leaseMs, clock }) {
  const state = new Map(handoffs.map((h) => [h.id, { ...h, state: "pending", lease: null, leaseExpiresAt: 0 }]));
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const url = new URL(req.url, "http://fake-cloud");
        if (req.method === "GET" && url.pathname === "/v1/node/handoffs") {
          const nowMs = clock.t;
          const due = [];
          for (const h of state.values()) {
            if (h.state === "pending" || (h.state === "leased" && h.leaseExpiresAt <= nowMs)) {
              h.state = "leased";
              h.lease = crypto.randomUUID();
              h.leaseExpiresAt = nowMs + leaseMs;
              due.push(h);
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ handoffs: due.map(({ id, repo, branch, lease }) => ({ id, repo, branch, lease })) }));
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/node/handoffs/ack") {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { body = {}; }
          const acked = [];
          for (const entry of Array.isArray(body.acks) ? body.acks : []) {
            const h = state.get(entry?.id);
            if (h && h.state === "leased" && h.lease === entry.lease) {
              h.state = "delivered";
              acked.push(entry.id);
            }
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ acked }));
          return;
        }
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not_found" }));
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

test("pollHandoffs sends a batched, signed ack for every handoff in the poll response", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res, call) => {
    if (call.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        handoffs: [
          { id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-token-1" },
          { id: "def456", repo: "me/relay", branch: "relay/handoff-y", lease: "lease-token-2" },
        ],
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ acked: ["abc123", "def456"] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    const handoffs = await client.pollHandoffs(20);

    // The ack must not alter what the caller receives back.
    assert.deepEqual(handoffs, [
      { id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-token-1" },
      { id: "def456", repo: "me/relay", branch: "relay/handoff-y", lease: "lease-token-2" },
    ]);

    assert.equal(cloud.calls.length, 2, "a poll response must be followed by exactly one ack request");
    const ackCall = cloud.calls[1];
    assert.equal(ackCall.method, "POST");
    assert.equal(ackCall.url, "/v1/node/handoffs/ack");
    const body = JSON.parse(ackCall.raw.toString("utf8"));
    assert.deepEqual(body, {
      acks: [
        { id: "abc123", lease: "lease-token-1" },
        { id: "def456", lease: "lease-token-2" },
      ],
    });

    // Signed exactly the same way as the poll: same header names, same
    // canonical signing string, method="POST" this time.
    assert.equal(ackCall.headers["x-relay-node"], node.nodeId);
    const input = Buffer.from(
      `${SIGNING_LABEL}\nPOST\n/v1/node/handoffs/ack\n${node.nodeId}\n${ackCall.headers["x-relay-ts"]}`, "utf8");
    const signature = Buffer.from(ackCall.headers["x-relay-signature"], "base64url");
    assert.ok(crypto.verify(null, input, node.publicKey, signature), "the ack signature verifies against the node key");
  } finally { await cloud.close(); }
});

test("a poll that returns no handoffs sends no ack", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ handoffs: [] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    const handoffs = await client.pollHandoffs(5);
    assert.deepEqual(handoffs, []);
    assert.equal(cloud.calls.length, 1, "an empty poll must not trigger an ack call");
  } finally { await cloud.close(); }
});

test("an ack that fails at the transport layer does not throw out of pollHandoffs or lose the handoffs", async () => {
  const node = freshNode();
  let ackAttempts = 0;
  const fetchImpl = async (_url, opts) => {
    if (opts.method === "GET") {
      return {
        status: 200,
        json: async () => ({ handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-1" }] }),
      };
    }
    ackAttempts += 1;
    throw new Error("simulated_ack_transport_failure");
  };
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });

  const handoffs = await withHardTimeout(client.pollHandoffs(5), 2000, "pollHandoffs with a failing ack");
  assert.deepEqual(handoffs, [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-1" }],
    "the handoffs must still be returned even though every ack attempt failed");
  assert.ok(ackAttempts >= 1, "at least one ack attempt must have been made");
});

test("the ack retry is bounded — it gives up rather than retrying forever", async () => {
  const node = freshNode();
  let ackAttempts = 0;
  const fetchImpl = async (_url, opts) => {
    if (opts.method === "GET") {
      return {
        status: 200,
        json: async () => ({ handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-1" }] }),
      };
    }
    ackAttempts += 1;
    throw new Error("simulated_ack_transport_failure");
  };
  const client = createCloudClient({ cloudUrl: "http://127.0.0.1:1", baseDir: node.baseDir, fetchImpl });

  await withHardTimeout(client.pollHandoffs(5), 2000, "bounded ack retry");
  assert.ok(ackAttempts >= 1 && ackAttempts <= 5, `expected a small bounded retry count, saw ${ackAttempts} attempts`);
});

// The point of the whole exercise: an ack that never arrives (crash,
// partition, anything transport-level — indistinguishable to relayd) must
// not lose the handoff. The cloud's lease expires, the SAME handoff is
// redelivered on a later poll, and — per importHandoff's own
// idempotent-on-id contract, which this test models without touching
// handoff.mjs — the redelivery is a safe no-op to import.
test("a handoff whose ack never arrives is redelivered on the next poll and imports cleanly", async () => {
  const node = freshNode();
  const clock = { t: 1755100000000 };
  const LEASE_MS = 5000;
  const cloud = await startLeasingFakeCloud({
    handoffs: [{ id: "deadbeefcafef00d", repo: "me/relay", branch: "relay/handoff-recover" }],
    leaseMs: LEASE_MS,
    clock,
  });
  try {
    // This client's acks always fail at the transport layer — standing in
    // for "the ack never arrives" (crash, partition, anything).
    const brokenAckFetch = async (url, opts) => {
      if (opts.method === "POST" && String(url).endsWith("/v1/node/handoffs/ack")) {
        throw new Error("simulated_ack_never_arrives");
      }
      return fetch(url, opts);
    };
    const flaky = createCloudClient({
      cloudUrl: cloud.url, baseDir: node.baseDir, fetchImpl: brokenAckFetch, now: () => clock.t,
    });

    const first = await withHardTimeout(flaky.pollHandoffs(0), 3000, "first poll");
    assert.equal(first.length, 1);
    assert.equal(first[0].id, "deadbeefcafef00d");
    assert.equal(cloud.state.get("deadbeefcafef00d").state, "leased", "an un-acked lease must not become delivered");

    const stillLeased = await withHardTimeout(flaky.pollHandoffs(0), 3000, "second poll, still inside the lease window");
    assert.deepEqual(stillLeased, [], "a live, unexpired lease is not handed out twice");

    // Past the lease window with no successful ack ever sent: the row must
    // become claimable again.
    clock.t += LEASE_MS + 1;

    // A healthy client (default fetch, acks succeed) polls next and must see
    // the SAME handoff redelivered.
    const healthy = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir, now: () => clock.t });
    const second = await withHardTimeout(healthy.pollHandoffs(0), 3000, "third poll, after lease expiry");
    assert.equal(second.length, 1, "an unconfirmed lease must expire and become claimable again — nothing may be lost");
    assert.equal(second[0].id, "deadbeefcafef00d", "the redelivered handoff is the same logical handoff");
    assert.deepEqual(
      { repo: second[0].repo, branch: second[0].branch },
      { repo: "me/relay", branch: "relay/handoff-recover" },
      "redelivery preserves the exact same content",
    );
    // DELETED: `assert.notEqual(second[0].lease, first[0].lease, ...)` tested
    // nothing about cloudclient.mjs — startLeasingFakeCloud (this file's own
    // fixture, above) mints `h.lease = crypto.randomUUID()` itself, so the
    // two values being unequal is a fact about the TEST's randomness, not
    // about the client under test. The client's actual job re: leases —
    // relaying whatever id/lease pairs the poll response carries into the
    // ack unchanged — is already pinned by "pollHandoffs sends a batched,
    // signed ack for every handoff in the poll response" above, and this
    // test's own next line (state reaches "delivered") already proves the
    // SAME logical handoff was correctly re-acked after redelivery.
    assert.equal(cloud.state.get("deadbeefcafef00d").state, "delivered", "a healthy ack reaches delivered on the next poll");

    // "Imports cleanly": modeled here (not in handoff.mjs, which this task
    // does not touch) per importHandoff's own documented contract —
    // `readHandoff(id)` already `ready` short-circuits, so a redelivery is a
    // cheap no-op, never a duplicate import.
    const imported = new Set();
    function simulateIdempotentImport(descriptor) {
      if (imported.has(descriptor.id)) return "already-imported-noop";
      imported.add(descriptor.id);
      return "imported";
    }
    assert.equal(simulateIdempotentImport(first[0]), "imported");
    assert.equal(
      simulateIdempotentImport(second[0]), "already-imported-noop",
      "the redelivered handoff must import as a cheap no-op",
    );
  } finally { await cloud.close(); }
});

// ---------------------------------------------------------------------------
// MINOR 4: the injected `now` must actually be exercised at both call sites
// (x-relay-ts header AND the event body's ts). Hardcoding Date.now() at
// either site must fail this test.
test("the injected now() drives both x-relay-ts and the event body ts", async () => {
  const FIXED_TS = 1754700000123;

  const pollNode = freshNode();
  const pollCloud = await startFakeCloud((res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ handoffs: [] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: pollCloud.url, baseDir: pollNode.baseDir, now: () => FIXED_TS });
    await client.pollHandoffs(5);
    assert.equal(pollCloud.calls[0].headers["x-relay-ts"], String(FIXED_TS));
  } finally { await pollCloud.close(); }

  const eventNode = freshNode();
  const eventCloud = await startFakeCloud(respondAccepted);
  try {
    const client = createCloudClient({ cloudUrl: eventCloud.url, baseDir: eventNode.baseDir, now: () => FIXED_TS });
    await client.postEvent("handoff.ready");
    const body = JSON.parse(eventCloud.calls[0].raw.toString("utf8"));
    assert.equal(body.ts, FIXED_TS);
  } finally { await eventCloud.close(); }
});

// ---------------------------------------------------------------------------
// Credential-sync notices ride the SAME long-poll and the SAME ack as
// handoffs (cloud commit 8d8fadc): `{ handoffs: [...], notices: [...] }` and
// `{ acks: [...], notices: [...] }`. relayd's transport layer is where they
// are acknowledged — the only layer that knows the bytes crossed a live
// connection — and where they are handed to whatever the daemon wired up to
// install them. pollHandoffs' return value is unchanged: handoff.mjs's import
// loop must keep seeing exactly the handoff descriptors it always saw.

test("pollHandoffs acks notices in the same signed batch as handoffs and hands them to onNotice", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res, call) => {
    if (call.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-h" }],
        notices: [
          { id: "notice-1", pairingId: "pair-1", secret: "secret-one-0123456789abcd", lease: "lease-n1" },
          { id: "notice-2", pairingId: "pair-2", secret: "secret-two-0123456789abcd", lease: "lease-n2" },
        ],
      }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ acked: ["abc123"], noticesAcked: ["notice-1", "notice-2"] }));
  });
  const seen = [];
  try {
    const client = createCloudClient({
      cloudUrl: cloud.url, baseDir: node.baseDir, onNotice: async (notice) => { seen.push(notice); },
    });
    const handoffs = await client.pollHandoffs(20);

    assert.deepEqual(handoffs, [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-h" }],
      "the caller's view of a poll is unchanged: handoff descriptors only");

    assert.equal(cloud.calls.length, 2, "one poll, one ack — notices must not open a second round trip");
    const body = JSON.parse(cloud.calls[1].raw.toString("utf8"));
    assert.deepEqual(body, {
      acks: [{ id: "abc123", lease: "lease-h" }],
      notices: [{ id: "notice-1", lease: "lease-n1" }, { id: "notice-2", lease: "lease-n2" }],
    });

    const input = Buffer.from(
      `${SIGNING_LABEL}\nPOST\n/v1/node/handoffs/ack\n${node.nodeId}\n${cloud.calls[1].headers["x-relay-ts"]}`, "utf8");
    assert.ok(crypto.verify(null, input, node.publicKey,
      Buffer.from(cloud.calls[1].headers["x-relay-signature"], "base64url")));

    assert.deepEqual(seen, [
      { id: "notice-1", pairingId: "pair-1", secret: "secret-one-0123456789abcd", lease: "lease-n1" },
      { id: "notice-2", pairingId: "pair-2", secret: "secret-two-0123456789abcd", lease: "lease-n2" },
    ], "every notice in the response must be handed on, in order");
  } finally { await cloud.close(); }
});

test("a poll carrying only notices still acks, and a poll with neither acks nothing", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (call.method === "GET" && cloud.calls.filter((c) => c.method === "GET").length === 1) {
      res.end(JSON.stringify({ handoffs: [], notices: [{ id: "n1", pairingId: "p1", secret: "s1", lease: "l1" }] }));
      return;
    }
    if (call.method === "GET") {
      res.end(JSON.stringify({ handoffs: [], notices: [] }));
      return;
    }
    res.end(JSON.stringify({ acked: [], noticesAcked: ["n1"] }));
  });
  const seen = [];
  try {
    const client = createCloudClient({
      cloudUrl: cloud.url, baseDir: node.baseDir, onNotice: async (notice) => { seen.push(notice.id); },
    });

    assert.deepEqual(await client.pollHandoffs(5), []);
    assert.equal(cloud.calls.length, 2, "a notice-only response must still be acked");
    assert.deepEqual(JSON.parse(cloud.calls[1].raw.toString("utf8")), { notices: [{ id: "n1", lease: "l1" }] });
    assert.deepEqual(seen, ["n1"]);

    await client.pollHandoffs(5);
    assert.equal(cloud.calls.length, 3, "an empty poll must not trigger an ack call");
  } finally { await cloud.close(); }
});

// An install that fails is the notice handler's problem to report (it writes
// an audit line and emits credentials.failed itself). It must not take down
// the poll loop, and — exactly like the handoff ack — the ack must NOT be
// gated on it: the ack means "these bytes reached this node", nothing more.
test("a notice handler that throws neither fails the poll nor withholds the ack", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (call.method === "GET") {
      res.end(JSON.stringify({
        handoffs: [{ id: "abc123", repo: "me/relay", branch: "relay/handoff-x", lease: "lease-h" }],
        notices: [{ id: "n1", pairingId: "p1", secret: "s1", lease: "l1" }],
      }));
      return;
    }
    res.end(JSON.stringify({ acked: ["abc123"], noticesAcked: ["n1"] }));
  });
  try {
    const client = createCloudClient({
      cloudUrl: cloud.url, baseDir: node.baseDir,
      onNotice: async () => { throw new Error("simulated_install_explosion"); },
    });
    const handoffs = await withHardTimeout(client.pollHandoffs(5), 2000, "poll with an exploding notice handler");
    assert.equal(handoffs.length, 1, "the handoffs from this poll must survive a failing notice handler");
    const ackBody = JSON.parse(cloud.calls[1].raw.toString("utf8"));
    assert.deepEqual(ackBody.notices, [{ id: "n1", lease: "l1" }],
      "the ack is evidence of delivery, never a verdict on the install");
  } finally { await cloud.close(); }
});

test("a malformed notice is skipped rather than dispatched or acked", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (call.method === "GET") {
      res.end(JSON.stringify({
        handoffs: [],
        notices: [
          { id: "n1", pairingId: "p1", lease: "l1" },              // no secret
          { pairingId: "p2", secret: "s2", lease: "l2" },          // no id
          { id: "n3", pairingId: "p3", secret: "s3" },             // no lease
          { id: "n4", pairingId: "p4", secret: "s4", lease: "l4" }, // the only good one
          "not-an-object",
        ],
      }));
      return;
    }
    res.end(JSON.stringify({ acked: [], noticesAcked: ["n4"] }));
  });
  const seen = [];
  try {
    const client = createCloudClient({
      cloudUrl: cloud.url, baseDir: node.baseDir, onNotice: async (notice) => { seen.push(notice.id); },
    });
    await client.pollHandoffs(5);
    assert.deepEqual(seen, ["n4"], "only a complete notice may be acted on");
    assert.deepEqual(JSON.parse(cloud.calls[1].raw.toString("utf8")).notices, [{ id: "n4", lease: "l4" }]);
  } finally { await cloud.close(); }
});

test("a client with no notice handler ignores notices instead of crashing the poll", async () => {
  const node = freshNode();
  const cloud = await startFakeCloud((res, call) => {
    res.writeHead(200, { "content-type": "application/json" });
    if (call.method === "GET") {
      res.end(JSON.stringify({ handoffs: [], notices: [{ id: "n1", pairingId: "p1", secret: "s1", lease: "l1" }] }));
      return;
    }
    res.end(JSON.stringify({ acked: [], noticesAcked: ["n1"] }));
  });
  try {
    const client = createCloudClient({ cloudUrl: cloud.url, baseDir: node.baseDir });
    assert.deepEqual(await withHardTimeout(client.pollHandoffs(5), 2000, "poll with no notice handler"), []);
  } finally { await cloud.close(); }
});
