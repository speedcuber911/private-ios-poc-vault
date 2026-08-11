// Shared wait/poll helpers for the relayd test suite.
//
// WHY THIS FILE EXISTS
//
// Every integration test in this suite has to wait for a real child daemon to
// bind a port, and for a real child process to finish a job. The original shape
// of that wait was:
//
//     const deadline = Date.now() + 5000;
//     for (;;) { if (done) break; if (Date.now() > deadline) throw ...;
//                await new Promise(r => setTimeout(r, 50)); }
//
// which is a WALL-CLOCK BET USED AS A PASS CRITERION. Under CPU oversubscription
// a fake-codex job that normally finishes in ~200 ms has been measured at
// 11.6-14.0 s: the daemon reported exitCode 0, finishedAt and the result, and the
// test still failed because its five-second clock had run out. That is a defect
// in the test, not in the daemon.
//
// The rule these helpers encode: a deadline is a HANG DETECTOR, never a
// synchronization primitive. Every loop below returns the instant the server
// reports the state being waited for, so the ceiling costs nothing when things
// are fast; it sits far above anything a loaded machine plausibly needs, so the
// only thing that can trip it is a genuine hang — and when it trips it reports
// the daemon's exit code and captured output instead of a bare message.
//
// POLLING OVER UNPOOLED CONNECTIONS
//
// Every probe dials a FRESH socket (`agent: false`, `connection: close`) rather
// than going through global fetch(). fetch()'s keep-alive pool can hand the next
// poll a socket the daemon is closing at that very moment — node's http server
// drops idle connections after 5 s, and on a saturated machine the gap between
// two polls stretches past that — and undici reports losing that race as an
// opaque "TypeError: fetch failed" indistinguishable from a dead daemon. One
// connection per poll cannot lose that race. It also matters for the
// restart-on-the-same-port tests: a pooled socket to the daemon that was just
// SIGTERMed must never be reused against its replacement.
//
// These are the same helpers conformance.test.mjs grew for the same reason,
// hoisted so events/harness/store/tunnel/worktree share one implementation.
import http from "node:http";
import net from "node:net";

// Wall-clock ceilings, NOT synchronization. See the block comment above.
export const SERVER_READY_DEADLINE_MS = 60_000;
export const JOB_WAIT_DEADLINE_MS = 60_000;
export const STREAM_OBSERVE_DEADLINE_MS = 60_000;
export const POLL_INTERVAL_MS = 25;

export const TERMINAL_JOB_STATUSES = ["succeeded", "failed", "cancelled", "timeout"];

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Asks the kernel for a port and immediately gives it back. Reserves ONE port:
// daemons started with it must bind exactly one listener.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// Flattens an error and its cause chain: undici buries the real reason
// ("other side closed", ECONNREFUSED) one or two levels down.
export function describeError(error) {
  const parts = [];
  for (let current = error; current && parts.length < 5; current = current.cause) {
    parts.push(`${current.name || "Error"}: ${current.message}${current.code ? ` (${current.code})` : ""}`);
  }
  return parts.join(" <- ");
}

// One unpooled GET. Rejects on transport failure; resolves with status and body
// for anything the server actually answered.
export function pollGet(baseUrl, pathname) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      `${baseUrl}${pathname}`,
      { agent: false, headers: { connection: "close" } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            json = null;
          }
          resolve({ status: response.statusCode, text, json });
        });
      },
    );
    request.on("error", reject);
    request.setTimeout(20_000, () => request.destroy(new Error(`GET ${pathname} stalled for 20000ms`)));
    request.end();
  });
}

// Captures a spawned daemon's output and exit so every wait loop can say what
// happened to it. A daemon that died mid-test must report that itself instead of
// surfacing as an anonymous transport error.
export function watchChild(child, label = "child") {
  let output = "";
  let exited = null;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  const capture = (chunk) => {
    output = (output + chunk).slice(-4000);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });
  return {
    output: () => output,
    exited: () => exited,
    describe: () =>
      exited
        ? `${label} pid ${child.pid} EXITED (code=${exited.code} signal=${exited.signal}); ` +
          `output: ${output.trim() || "<no output>"}`
        : `${label} pid ${child.pid} still running; output: ${output.trim() || "<no output>"}`,
  };
}

// Accepts a bare base URL or a handle ({ baseUrl, describe() }), so the helpers
// stay usable before a handle exists.
function baseUrlOf(target) {
  return typeof target === "string" ? target : target.baseUrl;
}

function describerOf(target) {
  if (typeof target === "string") return () => `daemon at ${target}`;
  return typeof target.describe === "function" ? () => target.describe() : () => `daemon at ${target.baseUrl}`;
}

// Races readiness against the child's exit. A daemon that CRASHED (a port clash
// did exactly this) must report why it died; a pure timeout could only say
// "server did not start", indistinguishably from a slow start.
export async function waitForServer(baseUrl, { exited = () => null, output = () => "" } = {}) {
  const started = Date.now();
  let lastError = null;
  let lastStatus = null;
  for (;;) {
    const dead = exited();
    if (dead) {
      throw new Error(
        `relayd exited before it was ready (code=${dead.code} signal=${dead.signal}): ${output().trim() || "<no output>"}`,
      );
    }
    try {
      const response = await pollGet(baseUrl, "/healthz");
      if (response.status === 200) return;
      lastStatus = response.status;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() - started > SERVER_READY_DEADLINE_MS) {
      throw new Error(
        `server at ${baseUrl} did not become ready in ${Date.now() - started}ms ` +
          `(last status ${lastStatus ?? "none"}, last error ${lastError ? describeError(lastError) : "none"}): ` +
          `${output().trim() || "<no output>"}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Polls a JSON endpoint until `predicate(body)` holds. Generic backbone for the
// job/op waiters; `what` names the thing being waited for in failure messages.
export async function waitForJson(server, pathname, predicate, what, deadlineMs = JOB_WAIT_DEADLINE_MS) {
  const baseUrl = baseUrlOf(server);
  const describe = describerOf(server);
  const started = Date.now();
  let body = null;
  let polls = 0;
  for (;;) {
    polls += 1;
    let response;
    try {
      response = await pollGet(baseUrl, pathname);
    } catch (error) {
      throw new Error(
        `polling ${pathname} (${what}) failed after ${Date.now() - started}ms (${polls} polls, ` +
          `last body ${JSON.stringify(body)}): ${describeError(error)}; ${describe()}`,
        { cause: error },
      );
    }
    if (response.status !== 200) {
      throw new Error(`GET ${pathname} -> ${response.status}: ${response.text}; ${describe()}`);
    }
    body = response.json;
    if (predicate(body)) return body;
    if (Date.now() - started > deadlineMs) {
      throw new Error(
        `${what} was still ${JSON.stringify(body)} after ${Date.now() - started}ms (${polls} polls); ${describe()}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Waits for the server to REPORT a terminal status. Returns on the first
// terminal report, whatever it is — callers assert which one they expected, so a
// job that FAILED shows up as a status mismatch immediately instead of as a
// timeout a minute later.
export async function waitForJob(server, jobId) {
  return waitForJson(
    server,
    `/v1/codex/jobs/${jobId}`,
    (job) => TERMINAL_JOB_STATUSES.includes(job?.status),
    `job ${jobId}`,
  );
}
