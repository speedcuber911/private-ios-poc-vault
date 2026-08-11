// W2-MODULES events tests: /v1/events feed (hello/replay/reset/400/503) and
// Last-Event-ID resume on the job SSE stream.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  STREAM_OBSERVE_DEADLINE_MS,
  freePort,
  waitForJob,
  waitForServer,
  watchChild,
} from "./helpers/wait.mjs";

const serverEntry = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "index.mjs");

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-events-test-"));
  const workspaceDir = path.join(dir, "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  const fakeCodex = path.join(dir, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    `#!/bin/sh\nwhile [ "$#" -gt 1 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\ncat > /dev/null\necho fake-answer > "$out"\nprintf 'line-one\\n'\nprintf 'line-two\\n'\n`,
    { mode: 0o755 },
  );
  const port = await freePort();
  const homeDir = path.join(dir, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
      // freePort() reserves ONE port; these daemons never exercise pairing, so
      // they bind exactly one listener and cannot squat on a port another test
      // was just handed.
      RELAYD_PAIRING_ENABLED: "false",
      // Isolate the runner HOME: the job engine prunes runtime caches under
      // CODEX_RUN_HOME, which must never point at the developer's real HOME
      // in tests (it also blocks the event loop when caches are large).
      CODEX_RUN_HOME: homeDir,
      CODEX_DATA_DIR: path.join(dir, "data"),
      CODEX_WORKSPACE_BROWSE_ROOT: dir,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
      CODEX_BIN: fakeCodex,
      CODEX_JOB_STREAM_HEARTBEAT_MS: "100",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Capture output and race readiness against the child's exit: a daemon that
  // died (a port clash used to do this) must say why, not time out with the
  // uninformative "server did not start". The readiness ceiling is a hang
  // detector (60 s, test/helpers/wait.mjs), not a bet on how fast a loaded box
  // can fork node.
  const watch = watchChild(child, "relayd(events)");
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });
  return {
    baseUrl,
    dir,
    describe: watch.describe,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

// Reads an open SSE stream until `predicate(events)` is satisfied. The deadline
// is a hang detector: the loop returns the instant the predicate holds, so the
// ceiling only fires when the stream genuinely never produces what was asked
// for. The 250 ms race below is a re-check tick for the predicate, not a
// synchronization delay — nothing is assumed to have happened when it fires.
async function collectSse(response, predicate, timeoutMs = STREAM_OBSERVE_DEADLINE_MS) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  const events = [];
  const parseAvailable = () => {
    const blocks = raw.split(/\r?\n\r?\n/);
    raw = blocks.pop();
    for (const block of blocks) {
      if (!block.trim() || block.trim().startsWith(":")) continue;
      const event = { id: null, event: "", data: null };
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("id:")) event.id = line.slice(3).trim();
        if (line.startsWith("event:")) event.event = line.slice(6).trim();
        if (line.startsWith("data:")) event.data = JSON.parse(line.slice(5).trim() || "{}");
      }
      if (event.event) events.push(event);
    }
  };
  const started = Date.now();
  try {
    for (;;) {
      if (predicate(events)) return events;
      if (Date.now() - started > timeoutMs) {
        throw new Error(
          `SSE stream produced nothing matching the predicate in ${Date.now() - started}ms; ` +
            `got: ${JSON.stringify(events.map((e) => e.event))}`,
        );
      }
      let tick;
      const result = await Promise.race([
        reader.read(),
        new Promise((resolve) => {
          tick = setTimeout(() => resolve({ timeout: true }), 250);
        }),
      ]);
      clearTimeout(tick);
      if (result.timeout) continue;
      if (result.done) return events;
      raw += decoder.decode(result.value, { stream: true });
      parseAvailable();
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

// `server` is a startServer() handle (a bare base URL still works, with less to
// say when things go wrong). Returns on the first TERMINAL status, so a job that
// failed is a status mismatch here rather than a timeout a minute later.
async function createAndFinishJob(server) {
  const baseUrl = typeof server === "string" ? server : server.baseUrl;
  const create = await fetch(`${baseUrl}/v1/codex/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "scratch", prompt: "emit events" }),
  });
  assert.equal(create.status, 202);
  const { id } = await create.json();
  const job = await waitForJob(server, id);
  assert.equal(job.status, "succeeded", `job did not succeed: ${JSON.stringify(job)}`);
  return job;
}

test("events feed: hello first, then job.state transitions with increasing cursors", async () => {
  const server = await startServer();
  try {
    const stream = await fetch(`${server.baseUrl}/v1/events`);
    assert.equal(stream.status, 200);
    const [job, events] = await Promise.all([
      createAndFinishJob(server),
      collectSse(stream, (seen) => seen.some((e) => e.event === "job.state" && e.data.status === "succeeded")),
    ]);
    assert.equal(events[0].event, "hello");
    assert.equal(typeof events[0].data.cursor, "number");
    const jobStates = events.filter((e) => e.event === "job.state");
    assert.deepEqual(
      jobStates.map((e) => e.data.status),
      ["queued", "running", "succeeded"],
    );
    assert.equal(jobStates[0].data.id, job.id);
    assert.equal(jobStates[0].data.queuePosition, 1);
    assert.equal(jobStates[2].data.queuePosition, null);
    const ids = jobStates.map((e) => Number(e.id));
    assert.ok(ids.every((value, index) => index === 0 || value > ids[index - 1]), `ids not increasing: ${ids}`);
  } finally {
    await server.stop();
  }
});

test("events feed: ?since replays only newer events; Last-Event-ID is equivalent", async () => {
  const server = await startServer();
  try {
    await createAndFinishJob(server);
    const full = await fetch(`${server.baseUrl}/v1/events?since=0`);
    // since=0 means "now": no replay, just hello.
    const nowEvents = await collectSse(full, (seen) => seen.length >= 1);
    assert.deepEqual(nowEvents.map((e) => e.event), ["hello"]);
    const cursor = nowEvents[0].data.cursor;
    assert.ok(cursor >= 3);

    const replay = await fetch(`${server.baseUrl}/v1/events?since=${cursor - 2}`);
    const replayed = await collectSse(replay, (seen) => seen.filter((e) => e.event === "job.state").length >= 2);
    const states = replayed.filter((e) => e.event === "job.state");
    assert.deepEqual(states.map((e) => e.data.status), ["running", "succeeded"]);

    const viaHeader = await fetch(`${server.baseUrl}/v1/events`, { headers: { "Last-Event-ID": String(cursor - 2) } });
    const headerEvents = await collectSse(viaHeader, (seen) => seen.filter((e) => e.event === "job.state").length >= 2);
    assert.deepEqual(
      headerEvents.filter((e) => e.event === "job.state").map((e) => e.data.status),
      ["running", "succeeded"],
    );
  } finally {
    await server.stop();
  }
});

test("events feed: invalid since is 400; stream cap is shared with job streams", async () => {
  const server = await startServer({ CODEX_MAX_JOB_STREAMS: "1" });
  try {
    const bad = await fetch(`${server.baseUrl}/v1/events?since=potato`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /since must be a non-negative integer/);

    // Hold the single slot open with the events feed (do NOT read/cancel it).
    const first = await fetch(`${server.baseUrl}/v1/events`);
    assert.equal(first.status, 200);
    const job = await createAndFinishJob(server);
    const second = await fetch(`${server.baseUrl}/v1/codex/jobs/${job.id}/stream`);
    assert.equal(second.status, 503);
    assert.match((await second.json()).error, /too many concurrent job streams/);
    await first.body.cancel().catch(() => {});
  } finally {
    await server.stop();
  }
});

test("job stream: events carry offset ids and Last-Event-ID resumes without duplicate bytes", async () => {
  const server = await startServer();
  try {
    const job = await createAndFinishJob(server);
    const stream = await fetch(`${server.baseUrl}/v1/codex/jobs/${job.id}/stream`);
    const events = await collectSse(stream, (seen) => seen.some((e) => e.event === "done"));
    assert.ok(events.every((e) => /^\d+:\d+:\d+$/.test(e.id)), `bad ids: ${JSON.stringify(events.map((e) => e.id))}`);
    const stdoutEvents = events.filter((e) => e.event === "stdout");
    assert.ok(stdoutEvents.length >= 1);
    const replayedText = stdoutEvents.map((e) => e.data.text).join("");
    assert.equal(replayedText, "line-one\nline-two\n");
    const doneEvent = events.find((e) => e.event === "done");
    const [stdoutOffset] = doneEvent.id.split(":").map(Number);
    assert.equal(stdoutOffset, Buffer.byteLength(replayedText));

    // Resume from the terminal id: no stdout/stderr replays, immediate done.
    const resumed = await fetch(`${server.baseUrl}/v1/codex/jobs/${job.id}/stream`, {
      headers: { "Last-Event-ID": doneEvent.id },
    });
    assert.equal(resumed.status, 200);
    const resumedEvents = await collectSse(resumed, (seen) => seen.some((e) => e.event === "done"));
    assert.equal(resumedEvents.filter((e) => e.event === "stdout").length, 0);
    assert.equal(resumedEvents.filter((e) => e.event === "stderr").length, 0);

    // Query offsets are still honored when the header is absent.
    const viaQuery = await fetch(`${server.baseUrl}/v1/codex/jobs/${job.id}/stream?stdoutOffset=${stdoutOffset}`);
    const queryEvents = await collectSse(viaQuery, (seen) => seen.some((e) => e.event === "done"));
    assert.equal(queryEvents.filter((e) => e.event === "stdout").length, 0);
  } finally {
    await server.stop();
  }
});

test("job stream: malformed Last-Event-ID is rejected with 400", async () => {
  const server = await startServer();
  try {
    const job = await createAndFinishJob(server);
    const bad = await fetch(`${server.baseUrl}/v1/codex/jobs/${job.id}/stream`, {
      headers: { "Last-Event-ID": "not-an-id" },
    });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /last-event-id is invalid/);
  } finally {
    await server.stop();
  }
});
