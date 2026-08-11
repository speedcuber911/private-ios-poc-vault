// W2-MODULES store tests: both backends via the storage interface, plus the
// JSON -> SQLite migration and a live-server persistence round-trip on the
// sqlite backend.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { freePort, waitForJob, waitForServer, watchChild } from "./helpers/wait.mjs";

// The store module transitively evaluates config.mjs, which creates the data
// dir tree: point everything at a temp dir before the first import.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-store-test-"));
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(tmpRoot, "ws", "scratch"), { recursive: true });
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(tmpRoot, "ws", "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";

const { createStore, migrateJsonToSqlite } = await import("../src/store.mjs");

const sampleJob = (id) => ({
  id,
  status: "succeeded",
  provider: "codex",
  workspaceId: "scratch",
  sessionId: "019e46a4-0000-7000-8000-00000000aaaa",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:01.000Z",
  prompt: "hello",
  result: "world",
});

const sampleChat = (id) => ({
  id,
  sessionId: id,
  mode: "chat",
  provider: "azure",
  workspaceId: "scratch",
  createdAt: "2026-08-09T00:00:00.000Z",
  updatedAt: "2026-08-09T00:00:02.000Z",
  messages: [{ role: "user", text: "hi", timestamp: "2026-08-09T00:00:00.000Z" }],
});

async function makeBackend(kind) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `${kind}-`));
  const jobsDir = path.join(dir, "jobs");
  const chatsDir = path.join(dir, "chats");
  fs.mkdirSync(jobsDir, { recursive: true });
  fs.mkdirSync(chatsDir, { recursive: true });
  const store = await createStore(kind, { dataDir: dir, jobsDir, chatsDir, dbPath: path.join(dir, "store.sqlite") });
  return { store, dir, jobsDir, chatsDir };
}

for (const kind of ["json", "sqlite"]) {
  test(`${kind} backend: job save/load/delete round-trip`, async () => {
    const { store } = await makeBackend(kind);
    const jobId = "019e46a4-0000-7000-8000-000000000001";
    store.saveJob(sampleJob(jobId));
    const records = store.loadJobRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0].job.id, jobId);
    assert.equal(records[0].job.result, "world");

    // Update persists over the same id.
    store.saveJob({ ...sampleJob(jobId), status: "failed" });
    assert.equal(store.loadJobRecords().length, 1);
    assert.equal(store.loadJobRecords()[0].job.status, "failed");

    store.deleteJob(jobId);
    if (kind === "sqlite") {
      assert.equal(store.loadJobRecords().length, 0);
    }
    store.close();
  });

  test(`${kind} backend: chat thread save/read/list/delete`, async () => {
    const { store } = await makeBackend(kind);
    const threadId = "019e46a4-0000-7000-8000-000000000002";
    store.saveChatThread(sampleChat(threadId));
    assert.deepEqual(store.listChatThreadIds(), [threadId]);
    assert.equal(store.readChatThreadRecord(threadId).provider, "azure");
    assert.equal(store.readChatThreadRecord("019e46a4-0000-7000-8000-00000000ffff"), null);
    assert.equal(store.deleteChatThread(threadId), true);
    assert.equal(store.deleteChatThread(threadId), false);
    assert.deepEqual(store.listChatThreadIds(), []);
    store.close();
  });

  test(`${kind} backend: devices and revocations`, async () => {
    const { store } = await makeBackend(kind);
    const device = {
      id: "019e46a4-0000-7000-8000-000000000003",
      name: "Test iPhone",
      platform: "ios",
      certSerial: "AB12",
      certSubject: "CN=test",
      createdAt: "2026-08-09T00:00:00.000Z",
      lastSeenAt: null,
      revoked: false,
      revokedAt: null,
    };
    store.saveDevice(device);
    assert.equal(store.listDevices().length, 1);
    assert.equal(store.getDevice(device.id).name, "Test iPhone");

    store.addRevocation({ serial: "AB12", deviceId: device.id, revokedAt: "2026-08-09T00:01:00.000Z" });
    store.saveDevice({ ...device, revoked: true, revokedAt: "2026-08-09T00:01:00.000Z" });
    assert.equal(store.listRevocations().length, 1);
    assert.equal(store.listRevocations()[0].serial, "AB12");
    assert.equal(store.getDevice(device.id).revoked, true);
    store.close();
  });

  test(`${kind} backend: pairing sessions persist and are claimed atomically`, async () => {
    const { store } = await makeBackend(kind);
    const session = (id, expiresAt) => ({
      id,
      code: "ABCD-2345",
      token: "pairing-token-0123456789abcdef",
      nodeId: "node-0123456789abcdef",
      nodeName: "test-node",
      createdAt: "2026-08-09T00:00:00.000Z",
      expiresAt,
    });
    const future = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const id = "019e46a4-0000-7000-8000-00000000000a";

    store.savePairingSession(session(id, future));
    const listed = store.listPairingSessions();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, id);
    assert.equal(listed[0].code, "ABCD-2345");
    assert.equal(listed[0].token, "pairing-token-0123456789abcdef");
    assert.equal(listed[0].expiresAt, future);

    // The claim is single-winner: the first consume takes it, every later one
    // fails. This is the invariant that stops two concurrent redemptions of
    // the same code from both succeeding.
    assert.equal(store.consumePairingSession(id), true);
    assert.equal(store.consumePairingSession(id), false);
    assert.equal(store.listPairingSessions().length, 0);

    // Racing consumers: exactly one wins, whatever the interleaving.
    const raceId = "019e46a4-0000-7000-8000-00000000000b";
    store.savePairingSession(session(raceId, future));
    const winners = await Promise.all(
      Array.from({ length: 8 }, async () => store.consumePairingSession(raceId)),
    );
    assert.equal(winners.filter(Boolean).length, 1);

    // Expiry pruning removes only expired rows.
    const expiredId = "019e46a4-0000-7000-8000-00000000000c";
    const liveId = "019e46a4-0000-7000-8000-00000000000d";
    store.savePairingSession(session(expiredId, "2020-01-01T00:00:00.000Z"));
    store.savePairingSession(session(liveId, future));
    assert.equal(store.prunePairingSessions(Date.now()), 1);
    assert.deepEqual(store.listPairingSessions().map((entry) => entry.id), [liveId]);

    // Path-traversal ids are refused, never written outside the store.
    assert.throws(() => store.savePairingSession(session("../evil", future)));
    assert.equal(store.consumePairingSession("../../etc/passwd"), false);
    store.close();
  });

  test(`${kind} backend: rejects path-traversal record ids`, async () => {
    const { store, jobsDir } = await makeBackend(kind);
    assert.throws(() => store.saveJob({ ...sampleJob("../evil"), id: "../evil" }));
    assert.throws(() => store.saveChatThread({ ...sampleChat("../evil"), id: "../evil" }));
    assert.equal(store.readChatThreadRecord("../../etc/passwd"), null);
    assert.equal(store.deleteChatThread("../../etc"), false);
    assert.equal(fs.existsSync(path.join(jobsDir, "..", "evil.json")), false);
    store.close();
  });
}

test("json backend writes the historical jobs/<id>.json layout", async () => {
  const { store, jobsDir } = await makeBackend("json");
  const jobId = "019e46a4-0000-7000-8000-000000000004";
  store.saveJob(sampleJob(jobId));
  const file = path.join(jobsDir, `${jobId}.json`);
  assert.ok(fs.existsSync(file));
  const raw = fs.readFileSync(file, "utf8");
  // Pretty-printed with trailing newline — same bytes the original wrote.
  assert.equal(raw, `${JSON.stringify(sampleJob(jobId), null, 2)}\n`);
  store.close();
});

// The claim marker is a TOMBSTONE, not a lock the winner releases: if the
// winner removed it, a loser that had already read the record could create it
// afterwards and win a second time. So a marker left behind by a process that
// died mid-claim must keep the session unusable — fail closed — and only the
// pruner may clear it, once the code could no longer be redeemed anyway.
test("json backend: a claim marker left by a crashed winner keeps the session unusable", async () => {
  const { store, dir } = await makeBackend("json");
  const pairingRoot = path.join(dir, "pairing");
  const id = "019e46a4-0000-7000-8000-00000000000e";
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  store.savePairingSession({
    id,
    code: "ABCD-2345",
    token: "pairing-token-0123456789abcdef",
    nodeId: "node-0123456789abcdef",
    nodeName: "test-node",
    createdAt: new Date().toISOString(),
    expiresAt,
  });

  // The winner claimed and then died before it could unlink the record.
  const claimFile = path.join(pairingRoot, `${id}.claim`);
  fs.writeFileSync(claimFile, `${JSON.stringify({ id, claimedAt: new Date().toISOString(), expiresAt })}\n`);
  assert.ok(fs.existsSync(path.join(pairingRoot, `${id}.json`)), "the record is still on disk");

  // It is neither offered for matching nor claimable.
  assert.deepEqual(store.listPairingSessions(), []);
  assert.equal(store.consumePairingSession(id), false);

  // While the code could still be presented, the marker stays.
  assert.equal(store.prunePairingSessions(Date.parse(expiresAt) - 1000), 0);
  assert.ok(fs.existsSync(claimFile), "the tombstone must outlive an early prune");

  // Past its expiry the marker has nothing left to guard: both files go.
  assert.equal(store.prunePairingSessions(Date.parse(expiresAt) + 1000), 0);
  assert.deepEqual(fs.readdirSync(pairingRoot), []);
  store.close();
});

test("sqlite backend: events append/list/prune and lastEventId", async () => {
  const { store } = await makeBackend("sqlite");
  const first = store.appendEvent({ name: "job.state", ts: "2026-08-09T00:00:00.000Z", data: { id: "x" } });
  const second = store.appendEvent({ name: "node.health", ts: "2026-08-09T00:00:01.000Z", data: { ok: true } });
  assert.equal(second, first + 1);
  assert.equal(store.lastEventId(), second);
  const events = store.listEvents({ sinceId: first, limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].name, "node.health");
  assert.deepEqual(events[0].data, { ok: true });

  for (let i = 0; i < 20; i += 1) store.appendEvent({ name: "tick", ts: "2026-08-09T00:00:02.000Z", data: {} });
  store.pruneEvents(5);
  const remaining = store.listEvents({ sinceId: 0, limit: 100 });
  assert.equal(remaining.length, 5);
  assert.equal(store.lastEventId(), second + 20);
  store.close();
});

test("sqlite backend: threads table tracks task and chat threads", async () => {
  const { store } = await makeBackend("sqlite");
  store.saveJob(sampleJob("019e46a4-0000-7000-8000-000000000005"));
  store.saveChatThread(sampleChat("019e46a4-0000-7000-8000-000000000006"));
  const rows = store.db.prepare("SELECT id, mode FROM threads ORDER BY id").all();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.mode).sort(),
    ["chat", "task"],
  );
  store.close();
});

test("migrateJsonToSqlite moves jobs, chats, devices and revocations", async () => {
  const dataRoot = fs.mkdtempSync(path.join(tmpRoot, "migrate-"));
  fs.mkdirSync(path.join(dataRoot, "jobs"), { recursive: true });
  fs.mkdirSync(path.join(dataRoot, "chats"), { recursive: true });
  const jsonStore = await createStore("json", {
    dataDir: dataRoot,
    jobsDir: path.join(dataRoot, "jobs"),
    chatsDir: path.join(dataRoot, "chats"),
  });
  const jobId = "019e46a4-0000-7000-8000-000000000007";
  const chatId = "019e46a4-0000-7000-8000-000000000008";
  jsonStore.saveJob(sampleJob(jobId));
  jsonStore.saveChatThread(sampleChat(chatId));
  jsonStore.saveDevice({
    id: "019e46a4-0000-7000-8000-000000000009",
    name: "Migrated",
    platform: "ios",
    certSerial: "CDEF",
    certSubject: "CN=m",
    createdAt: "2026-08-09T00:00:00.000Z",
    lastSeenAt: null,
    revoked: false,
    revokedAt: null,
  });
  jsonStore.addRevocation({ serial: "CDEF", deviceId: "019e46a4-0000-7000-8000-000000000009", revokedAt: "2026-08-09T00:02:00.000Z" });
  // A malformed file must be skipped, not crash the migration.
  fs.writeFileSync(path.join(dataRoot, "jobs", "corrupt.json"), "{not json", "utf8");

  const dbPath = path.join(dataRoot, "migrated.sqlite");
  const { counts, store: migrated } = await migrateJsonToSqlite({ dataDir: dataRoot, dbPath });
  assert.deepEqual(counts, { jobs: 1, chats: 1, devices: 1, revocations: 1 });
  assert.equal(migrated.loadJobRecords()[0].job.id, jobId);
  assert.equal(migrated.readChatThreadRecord(chatId).id, chatId);
  assert.equal(migrated.listDevices()[0].certSerial, "CDEF");
  assert.equal(migrated.listRevocations()[0].serial, "CDEF");
  migrated.close();
});

test("server on RELAYD_STORE=sqlite persists jobs across restarts", async () => {
  const serverEntry = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "index.mjs");
  const dir = fs.mkdtempSync(path.join(tmpRoot, "sqlite-server-"));
  const workspaceDir = path.join(dir, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const fakeCodex = path.join(dir, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    `#!/bin/sh\nwhile [ "$#" -gt 1 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\ncat > /dev/null\necho fake-answer > "$out"\necho done-stdout\n`,
    { mode: 0o755 },
  );

  const env = {
    ...process.env,
    CODEX_API_HOST: "127.0.0.1",
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(dir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: dir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: fakeCodex,
    RELAYD_STORE: "sqlite",
  };

  // Both waits below are HANG DETECTORS, not synchronization: they return the
  // instant the daemon reports the state, and their ceilings (60 s, from
  // test/helpers/wait.mjs) sit far above anything a saturated box needs. The
  // five-second versions they replaced failed this test with "job stuck" while
  // the captured job already carried exitCode 0, finishedAt and the result.
  async function startOnce(port) {
    const child = spawn(process.execPath, [serverEntry], {
      env: { ...env, CODEX_API_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const watch = watchChild(child, "relayd(sqlite-persistence)");
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });
    return { child, baseUrl, describe: watch.describe };
  }

  const port = await freePort();

  let server = await startOnce(port);
  let jobId;
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "persist me" }),
    });
    assert.equal(create.status, 202);
    jobId = (await create.json()).id;
    // Returns on the FIRST terminal status: a job that failed surfaces here as
    // a status mismatch, not as a timeout a minute later.
    const job = await waitForJob(server, jobId);
    assert.equal(job.status, "succeeded", `job did not succeed: ${JSON.stringify(job)}; ${server.describe()}`);
  } finally {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => server.child.once("exit", resolve));
  }

  // No jobs/<id>.json file in sqlite mode; the row is the record.
  assert.equal(fs.existsSync(path.join(dir, "data", "jobs", `${jobId}.json`)), false);
  assert.ok(fs.existsSync(path.join(dir, "data", "relayd.sqlite")));

  server = await startOnce(port);
  try {
    const detail = await fetch(`${server.baseUrl}/v1/codex/jobs/${jobId}`);
    assert.equal(detail.status, 200);
    const job = await detail.json();
    assert.equal(job.status, "succeeded");
    assert.equal(job.result, "fake-answer");
  } finally {
    server.child.kill("SIGTERM");
    await new Promise((resolve) => server.child.once("exit", resolve));
  }
});

// ---------------------------------------------------------------------------
// CROSS-PROCESS RACES
//
// Single-use pairing is a SECURITY property, and it is a property of the
// FILESYSTEM PRIMITIVE, not of the JavaScript around it. Racing two calls
// inside one process cannot test it: one event loop serializes them no matter
// what consumePairingSession does underneath. These tests fork real node
// processes that share one data dir and line them up on a spin barrier, so
// their claims land within microseconds of each other — the same alignment
// that made two `fs.unlinkSync` calls on darwin/APFS both return success.
// ---------------------------------------------------------------------------

const raceWorkerPath = path.join(tmpRoot, "race-worker.mjs");
fs.writeFileSync(
  raceWorkerPath,
  [
    'import fs from "node:fs";',
    `import { createStore } from ${JSON.stringify(new URL("../src/store.mjs", import.meta.url).href)};`,
    "",
    "const store = await createStore(process.env.RACE_KIND, {",
    "  dataDir: process.env.RACE_DATA_DIR,",
    "  jobsDir: process.env.RACE_JOBS_DIR,",
    "  chatsDir: process.env.RACE_CHATS_DIR,",
    "  dbPath: process.env.RACE_DB_PATH,",
    "});",
    "",
    "const byte = Buffer.alloc(1);",
    'let pending = "";',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (chunk) => {',
    "  pending += chunk;",
    "  let index;",
    '  while ((index = pending.indexOf("\\n")) >= 0) {',
    "    const line = pending.slice(0, index).trim();",
    "    pending = pending.slice(index + 1);",
    "    if (!line) continue;",
    '    const [op, arg, barrierPath, armedPath] = line.split(" ");',
    '    const fd = fs.openSync(barrierPath, "r");',
    '    fs.writeFileSync(armedPath, "1");',
    "    // Tight spin on a shared byte the parent flips: no timers and no",
    "    // sleeping, so every worker leaves this loop within microseconds of",
    "    // the others. The deadline is only a hang guard, and a hang guard that",
    "    // FIRED means the workers were never released together — the round",
    "    // proves nothing about atomicity. Falling through to the claim there",
    "    // would let 'exactly one winner' pass vacuously on a starved box, so a",
    "    // timed-out barrier reports itself as a distinguishable outcome the",
    "    // parent asserts can never appear.",
    "    const deadline = Date.now() + 60000;",
    "    let released = false;",
    "    for (;;) {",
    "      fs.readSync(fd, byte, 0, 1, 0);",
    "      if (byte[0] === 1) {",
    "        released = true;",
    "        break;",
    "      }",
    "      if (Date.now() > deadline) break;",
    "    }",
    "    fs.closeSync(fd);",
    "    let outcome;",
    "    if (!released) {",
    '      outcome = "barrier-timeout";',
    "    } else {",
    "      try {",
    '        if (op === "claim") {',
    '          outcome = store.consumePairingSession(arg) ? "won" : "lost";',
    "        } else {",
    "          store.saveDevice({",
    "            id: arg,",
    "            name: arg,",
    '            platform: "ios",',
    "            certSerial: arg.slice(-8),",
    '            certSubject: "CN=" + arg,',
    "            createdAt: new Date().toISOString(),",
    "            lastSeenAt: null,",
    "            revoked: false,",
    "            revokedAt: null,",
    "          });",
    '          outcome = "saved";',
    "        }",
    "      } catch (error) {",
    '        outcome = "threw:" + error.message;',
    "      }",
    "    }",
    '    process.stdout.write(arg + " " + outcome + "\\n");',
    "  }",
    "});",
    "",
  ].join("\n"),
  "utf8",
);

// Timer-free synchronous nap. Used only where microsecond alignment does NOT
// matter (waiting for workers to arrive at the barrier); the barrier itself is
// a spin, and nothing in these tests is synchronized by elapsed time.
function napSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitForFiles(paths, label) {
  // Hang detector only: returns the instant every worker has armed.
  const deadline = Date.now() + 60000;
  for (;;) {
    if (paths.every((file) => fs.existsSync(file))) return;
    if (Date.now() > deadline) {
      const missing = paths.filter((file) => !fs.existsSync(file));
      throw new Error(`timed out waiting for ${label}; workers never armed: ${JSON.stringify(missing)}`);
    }
    napSync(1);
  }
}

// A worker that reports this never reached the barrier release, so its round is
// unsynchronised and cannot demonstrate anything. It must never appear.
const BARRIER_TIMEOUT = "barrier-timeout";

function assertBarrierFired(results, round) {
  const stalled = results.filter((line) => line.endsWith(` ${BARRIER_TIMEOUT}`));
  assert.deepEqual(
    stalled,
    [],
    `round ${round}: the spin barrier never released ${stalled.length} worker(s), so the round is ` +
      `unsynchronised and proves nothing (${JSON.stringify(results)})`,
  );
}

function startRaceWorkers(count, env) {
  return Array.from({ length: count }, () => {
    const child = spawn(process.execPath, [raceWorkerPath], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const worker = { child, lines: [], waiters: [], stderr: "" };
    let pending = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      pending += chunk;
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index).trim();
        pending = pending.slice(index + 1);
        if (!line) continue;
        const waiter = worker.waiters.shift();
        if (waiter) waiter(line);
        else worker.lines.push(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      worker.stderr += chunk;
    });
    // A dead worker must fail the assertion, never hang the test.
    child.once("exit", (code, signal) => {
      const message = `worker-exited code=${code} signal=${signal} stderr=${worker.stderr.trim()}`;
      while (worker.waiters.length) worker.waiters.shift()(message);
    });
    worker.next = () =>
      new Promise((resolve) => {
        const buffered = worker.lines.shift();
        if (buffered !== undefined) resolve(buffered);
        else worker.waiters.push(resolve);
      });
    return worker;
  });
}

async function stopRaceWorkers(workers) {
  for (const worker of workers) {
    worker.child.stdin.end();
    worker.child.kill("SIGKILL");
  }
  await Promise.all(
    workers.map(
      (worker) =>
        new Promise((resolve) => {
          if (worker.child.exitCode !== null || worker.child.signalCode !== null) resolve();
          else worker.child.once("exit", resolve);
        }),
    ),
  );
}

// Runs one round: every worker is handed its command, parks on the barrier,
// and is released together.
async function runRaceRound(workers, raceDir, round, commandFor) {
  const barrierPath = path.join(raceDir, `barrier-${round}`);
  fs.writeFileSync(barrierPath, Buffer.from([0]));
  const armed = workers.map((_, index) => path.join(raceDir, `armed-${round}-${index}`));
  workers.forEach((worker, index) => {
    worker.child.stdin.write(`${commandFor(index)} ${barrierPath} ${armed[index]}\n`);
  });
  waitForFiles(armed, `round ${round} arming`);
  const fd = fs.openSync(barrierPath, "r+");
  fs.writeSync(fd, Buffer.from([1]), 0, 1, 0);
  fs.closeSync(fd);
  return Promise.all(workers.map((worker) => worker.next()));
}

const raceWorkerCount = 4;
const claimRounds = 30;

for (const kind of ["json", "sqlite"]) {
  test(`${kind} backend: ${claimRounds} cross-process races on one session yield exactly one winner each`, async () => {
    const { store, dir, jobsDir, chatsDir } = await makeBackend(kind);
    const dbPath = path.join(dir, "store.sqlite");
    const raceDir = path.join(dir, "race");
    fs.mkdirSync(raceDir, { recursive: true });
    const workers = startRaceWorkers(raceWorkerCount, {
      RACE_KIND: kind,
      RACE_DATA_DIR: dir,
      RACE_JOBS_DIR: jobsDir,
      RACE_CHATS_DIR: chatsDir,
      RACE_DB_PATH: dbPath,
    });

    try {
      let totalWins = 0;
      for (let round = 0; round < claimRounds; round += 1) {
        const id = `019e46a4-0000-7000-8000-${String(round).padStart(12, "0")}`;
        store.savePairingSession({
          id,
          code: "ABCD-2345",
          token: `pairing-token-${id}`,
          nodeId: "node-0123456789abcdef",
          nodeName: "test-node",
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
        });

        const results = await runRaceRound(workers, raceDir, round, () => `claim ${id}`);
        assertBarrierFired(results, round);
        for (const line of results) {
          assert.ok(
            line === `${id} won` || line === `${id} lost`,
            `round ${round}: unexpected worker output ${JSON.stringify(line)}`,
          );
        }
        const wins = results.filter((line) => line === `${id} won`).length;
        assert.equal(
          wins,
          1,
          `round ${round}: ${wins} processes claimed one pairing session (${JSON.stringify(results)})`,
        );
        totalWins += wins;

        // The claim is single-use for this process too, and the session is gone.
        assert.equal(store.consumePairingSession(id), false);
        assert.ok(!store.listPairingSessions().some((entry) => entry.id === id));
      }
      assert.equal(totalWins, claimRounds);
    } finally {
      await stopRaceWorkers(workers);
      store.close();
    }
  });
}

// Defect: writeJsonFileAtomic used a FIXED `<file>.tmp`, so two processes
// writing devices.json collided on it (one rename fails with ENOENT), and the
// read-modify-write in saveDevice could drop the other process's record
// outright. `relayd devices revoke` runs in its own process while the daemon
// may be writing the same file during a pairing, so this is reachable in normal
// operation — a paired device losing its enrollment row.
test("json backend: concurrent saveDevice from separate processes keeps every record", async () => {
  const { store, dir, jobsDir, chatsDir } = await makeBackend("json");
  const raceDir = path.join(dir, "race");
  fs.mkdirSync(raceDir, { recursive: true });
  const workers = startRaceWorkers(raceWorkerCount, {
    RACE_KIND: "json",
    RACE_DATA_DIR: dir,
    RACE_JOBS_DIR: jobsDir,
    RACE_CHATS_DIR: chatsDir,
  });

  try {
    const expected = [];
    for (let round = 0; round < 10; round += 1) {
      const ids = workers.map(
        (_, index) => `019e46a4-0000-7000-8000-${String(round).padStart(6, "0")}${String(index).padStart(6, "0")}`,
      );
      const results = await runRaceRound(workers, raceDir, round, (index) => `device ${ids[index]}`);
      assertBarrierFired(results, round);
      results.forEach((line, index) => {
        assert.equal(line, `${ids[index]} saved`, `round ${round}: worker ${index} reported ${line}`);
      });
      expected.push(...ids);

      const stored = store.listDevices().map((device) => device.id);
      for (const id of ids) {
        assert.ok(stored.includes(id), `round ${round}: device ${id} was dropped by a concurrent writer`);
      }
      assert.equal(stored.length, expected.length, `round ${round}: expected ${expected.length} devices, got ${stored.length}`);
    }

    // No temp file survived, and the lock was released every time.
    const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
    assert.deepEqual(leftovers, [], `temp/lock files left behind: ${JSON.stringify(leftovers)}`);
  } finally {
    await stopRaceWorkers(workers);
    store.close();
  }
});
