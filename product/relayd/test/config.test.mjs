// W2-MODULES config tests: the two files config.mjs writes on its own —
// allowed-cert-subjects.json (via allowCertSubject, on the pairing path) and
// pairing/listener.json (via recordPairingListener, on the bind path).
//
// Both used to write a FIXED `<file>.tmp`. That is shared mutable state between
// processes, and "only one relayd runs" is not an assumption this daemon may
// make: `relayd devices revoke`, `relayd pair` and a second daemon on the same
// CODEX_DATA_DIR all touch these paths. Racing two writers on one temp name
// interleaves as write(A) -> write(B) -> rename(A) -> rename(B): A's rename
// moves the temp away and B's rename fails with ENOENT. allowCertSubject is not
// wrapped in try/catch, so that ENOENT propagated out of redeemPairing as a 500
// to the phone AFTER the cert was issued, the device enrolled and the one-shot
// code burned. The read-modify-write was also unsynchronized, so a subject
// could be dropped outright — a genuinely paired device 403'd on the data path.
//
// Racing two calls inside ONE process cannot test any of this: allowCertSubject
// is fully synchronous, so one event loop serializes it no matter what the file
// code does. These tests fork real node processes that share one data dir and
// line them up on a spin barrier, exactly like store.test.mjs's pairing race.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-config-test-"));

// Timer-free synchronous nap, used only where microsecond alignment does NOT
// matter (waiting for workers to arrive at the barrier). The barrier itself is
// a spin, and nothing here is synchronized by elapsed time.
function napSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Hang detector only: returns the instant every worker has armed.
function waitForFiles(paths, label) {
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

// A worker that reports this never saw the barrier release, so its round was
// never synchronized and proves nothing. It must never appear.
const BARRIER_TIMEOUT = "barrier-timeout";

const workerPath = path.join(tmpRoot, "config-race-worker.mjs");
fs.writeFileSync(
  workerPath,
  [
    'import fs from "node:fs";',
    `const config = await import(${JSON.stringify(new URL("../src/config.mjs", import.meta.url).href)});`,
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
    "    // FIRED means the round was never synchronized — report that rather",
    "    // than run unaligned and let the assertions pass vacuously.",
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
    `      outcome = ${JSON.stringify(BARRIER_TIMEOUT)};`,
    "    } else {",
    "      try {",
    '        if (op === "subject") {',
    '          const added = config.allowCertSubject(arg, { reason: "paired", deviceId: null });',
    '          outcome = added ? "added" : "duplicate";',
    "        } else {",
    '          const ok = config.recordPairingListener({ host: "127.0.0.1", port: Number(arg) });',
    '          outcome = ok ? "recorded" : "refused";',
    "        }",
    "      } catch (error) {",
    '        outcome = "threw:" + (error.code || "") + ":" + error.message;',
    "      }",
    "    }",
    '    process.stdout.write(arg + " " + outcome + "\\n");',
    "  }",
    "});",
    "",
  ].join("\n"),
  "utf8",
);

function startWorkers(count, env) {
  return Array.from({ length: count }, () => {
    const child = spawn(process.execPath, [workerPath], {
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

async function stopWorkers(workers) {
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

// Hands every worker its command, waits for all of them to park on the barrier,
// then releases them together.
async function runRound(workers, raceDir, round, commandFor) {
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
  const results = await Promise.all(workers.map((worker) => worker.next()));
  const stalled = results.filter((line) => line.endsWith(` ${BARRIER_TIMEOUT}`));
  assert.deepEqual(
    stalled,
    [],
    `round ${round}: the spin barrier never released ${stalled.length} worker(s), so the round is ` +
      `unsynchronised and proves nothing (${JSON.stringify(results)})`,
  );
  return results;
}

function makeDataDir(name) {
  const root = fs.mkdtempSync(path.join(tmpRoot, `${name}-`));
  const dataDir = path.join(root, "data");
  const workspaceDir = path.join(root, "ws", "scratch");
  fs.mkdirSync(workspaceDir, { recursive: true });
  return {
    root,
    dataDir,
    env: {
      CODEX_DATA_DIR: dataDir,
      CODEX_WORKSPACE_BROWSE_ROOT: path.join(root, "ws"),
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
      CODEX_REQUIRE_MTLS: "false",
      CODEX_ALLOWED_CERT_SUBJECTS: "",
    },
  };
}

const workerCount = 4;
const rounds = 15;

test("allowCertSubject: concurrent pairings from separate processes never throw and never lose a subject", async () => {
  const { dataDir, env } = makeDataDir("subjects");
  const raceDir = path.join(dataDir, "race");
  const workers = startWorkers(workerCount, env);
  try {
    // config.mjs creates dataDir at import time; the workers have done that by
    // the time the first round arms.
    const expected = [];
    for (let round = 0; round < rounds; round += 1) {
      fs.mkdirSync(raceDir, { recursive: true });
      const subjects = Array.from(
        { length: workerCount },
        (_, index) => `CN=relay-device-${String(round).padStart(3, "0")}-${index}`,
      );
      const results = await runRound(workers, raceDir, round, (index) => `subject ${subjects[index]}`);
      results.forEach((line, index) => {
        assert.equal(
          line,
          `${subjects[index]} added`,
          `round ${round}: worker ${index} reported ${JSON.stringify(line)} — a throw here is a 500 to a ` +
            `phone whose certificate was already issued and whose pairing code is already burned`,
        );
      });
      expected.push(...subjects);

      const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "allowed-cert-subjects.json"), "utf8"));
      const stored = persisted.map((entry) => entry.subject);
      for (const subject of expected) {
        assert.ok(
          stored.includes(subject),
          `round ${round}: ${subject} was dropped by a concurrent writer — that device is now 403'd ` +
            `on the data path despite being paired`,
        );
      }
      assert.equal(
        stored.length,
        expected.length,
        `round ${round}: expected ${expected.length} persisted subjects, got ${stored.length}`,
      );
    }

    // No temp file survived, and the lock was released every time.
    const leftovers = fs.readdirSync(dataDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
    assert.deepEqual(leftovers, [], `temp/lock files left behind: ${JSON.stringify(leftovers)}`);
  } finally {
    await stopWorkers(workers);
  }
});

test("recordPairingListener: concurrent binds all record, and the file is always parseable", async () => {
  const { dataDir, env } = makeDataDir("listener");
  const raceDir = path.join(dataDir, "race");
  const listenerPath = path.join(dataDir, "pairing", "listener.json");
  const workers = startWorkers(workerCount, env);
  try {
    for (let round = 0; round < rounds; round += 1) {
      fs.mkdirSync(raceDir, { recursive: true });
      const ports = Array.from({ length: workerCount }, (_, index) => 20000 + round * 10 + index);
      const results = await runRound(workers, raceDir, round, (index) => `listener ${ports[index]}`);
      results.forEach((line, index) => {
        assert.equal(
          line,
          `${ports[index]} recorded`,
          `round ${round}: worker ${index} reported ${JSON.stringify(line)} — a daemon with no recorded ` +
            `pairing address makes \`relayd pair\` print an unusable URL, with no error anywhere`,
        );
      });

      // Whoever renamed last wins, but the file must always be a complete
      // record: a half-written temp renamed into place is an onboarding dead
      // end, because readPairingListener can only return null for it.
      const parsed = JSON.parse(fs.readFileSync(listenerPath, "utf8"));
      assert.ok(ports.includes(parsed.port), `round ${round}: unexpected recorded port ${parsed.port}`);
      assert.equal(parsed.host, "127.0.0.1");
      assert.ok(Number.isInteger(parsed.pid) && parsed.pid > 0, `round ${round}: bad pid ${parsed.pid}`);
      assert.ok(!Number.isNaN(Date.parse(parsed.startedAt)), `round ${round}: bad startedAt ${parsed.startedAt}`);
    }

    const leftovers = fs
      .readdirSync(path.join(dataDir, "pairing"))
      .filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
    assert.deepEqual(leftovers, [], `temp/lock files left behind: ${JSON.stringify(leftovers)}`);
  } finally {
    await stopWorkers(workers);
  }
});

test("allowCertSubject: a subject already persisted by another process is not duplicated", async () => {
  const { dataDir, env } = makeDataDir("dedupe");
  const raceDir = path.join(dataDir, "race");
  const subjectsPath = path.join(dataDir, "allowed-cert-subjects.json");
  const workers = startWorkers(workerCount, env);
  try {
    // Every worker races to persist the SAME subject. Each has its own live Set
    // so each believes it is adding it; the file must still hold exactly one
    // entry, and no worker may throw.
    fs.mkdirSync(raceDir, { recursive: true });
    const subject = "CN=relay-device-shared";
    const results = await runRound(workers, raceDir, 0, () => `subject ${subject}`);
    for (const line of results) {
      assert.equal(line, `${subject} added`, `unexpected worker output ${JSON.stringify(line)}`);
    }
    const persisted = JSON.parse(fs.readFileSync(subjectsPath, "utf8"));
    assert.deepEqual(
      persisted.map((entry) => entry.subject),
      [subject],
      `the allowlist file must hold exactly one entry per subject: ${JSON.stringify(persisted)}`,
    );
  } finally {
    await stopWorkers(workers);
  }
});
