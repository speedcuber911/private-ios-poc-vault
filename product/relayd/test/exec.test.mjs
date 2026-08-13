// POST /v1/exec — running a command on the node.
//
// The security model is stated in the header of src/exec.mjs and is worth
// restating here because these tests deliberately do NOT assert a jail: a
// shell is not confined by the workspace path checks, and a test asserting
// otherwise would encode a guarantee the code cannot make. What is tested is
// what is actually true — bounded runtime, bounded output, bounded
// concurrency, a kill that reaches the whole process group, and a cwd guard
// that is a usability check rather than a security boundary.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-exec-"));
const jail = path.join(tmpRoot, "workspaces");
fs.mkdirSync(path.join(jail, "welcome"), { recursive: true });
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = jail;
// Without this the module default points the sole workspace at
// /srv/codex-workspaces/scratch, which config bootstrap then tries to mkdir.
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "welcome", name: "Welcome", path: path.join(jail, "welcome") },
]);

const {
  runExec, resolveExecCwd, EXEC_MAX_OUTPUT_BYTES,
} = await import("../src/exec.mjs");
const { workspaceBrowseRoot } = await import("../src/config.mjs");

test("runs a command and returns its output and exit code", async () => {
  const result = await runExec({ command: "echo hello; exit 0", cwd: workspaceBrowseRoot });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "hello");
  assert.equal(result.timedOut, false);
  assert.equal(result.truncated, false);
});

test("a non-zero exit is data, not an error", async () => {
  const result = await runExec({ command: "echo to-stderr >&2; exit 7", cwd: workspaceBrowseRoot });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr.trim(), "to-stderr");
});

test("the command runs in the requested directory", async () => {
  const result = await runExec({ command: "pwd", cwd: path.join(jail, "welcome") });

  assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(path.join(jail, "welcome")));
});

// The deadline must actually end the command, and say that it did.
test("a command past its deadline is killed and reported as timed out", async () => {
  const result = await runExec({
    command: "sleep 30", cwd: workspaceBrowseRoot, timeoutMs: 1000,
  });

  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
  assert.ok(result.durationMs < 15_000, `took ${result.durationMs}ms; the kill did not land`);
});

// The reason for detached:true. A backgrounded grandchild outlives a kill
// aimed only at the shell, and would hold resources on the node forever.
test("the kill reaches the whole process group, not just the shell", async () => {
  const marker = path.join(tmpRoot, "grandchild-was-still-running");
  const result = await runExec({
    // The shell waits on a backgrounded child that would write the marker
    // after the deadline. If only the shell dies, the child survives and
    // writes it.
    command: `( sleep 4; touch ${JSON.stringify(marker)} ) & wait`,
    cwd: workspaceBrowseRoot,
    timeoutMs: 1000,
  });

  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 6000));
  assert.equal(
    fs.existsSync(marker), false,
    "a backgrounded grandchild survived the timeout kill",
  );
});

// Output is buffered into a JSON response, so it must be bounded — and a
// bounded read must not deadlock the child on a full pipe.
test("oversized output is truncated, reported, and does not hang", async () => {
  const result = await runExec({
    command: "head -c 200000 /dev/zero | tr '\\0' 'x'",
    cwd: workspaceBrowseRoot,
    timeoutMs: 20_000,
    maxOutputBytes: 1024,
  });

  assert.equal(result.truncated, true, "truncation must be reported, never silent");
  assert.equal(result.stdout.length, 1024);
  assert.equal(result.timedOut, false, "a large-output command must not be reported as a hang");
  assert.equal(result.exitCode, 0);
});

test("a command producing exactly the cap is not marked truncated", async () => {
  const result = await runExec({
    command: "printf 'abcd'", cwd: workspaceBrowseRoot, maxOutputBytes: 4,
  });

  assert.equal(result.stdout, "abcd");
  assert.equal(result.truncated, false);
});

// cwd resolution — a usability guard. These assert the guard behaves as
// written; they do NOT claim a command cannot leave the directory.
test("cwd defaults to the workspace root when absent", () => {
  assert.equal(resolveExecCwd(undefined), workspaceBrowseRoot);
  assert.equal(resolveExecCwd(""), workspaceBrowseRoot);
});

test("cwd inside the root is accepted, outside is refused", () => {
  assert.ok(resolveExecCwd(path.join(jail, "welcome")));
  assert.equal(resolveExecCwd("/etc"), null);
  assert.equal(resolveExecCwd(path.join(jail, "..", "..")), null);
});

test("a cwd containing NUL is refused", () => {
  // The kernel truncates at NUL, so the path it would open is not the path
  // that was validated.
  assert.equal(resolveExecCwd(`${jail}\0/etc`), null);
});

test("a non-string cwd is refused rather than coerced", () => {
  assert.equal(resolveExecCwd(42), null);
  assert.equal(resolveExecCwd({}), null);
  assert.equal(resolveExecCwd([]), null);
});

// A failure to spawn must come back as a result, not as a thrown error that
// turns into a 500.
test("a spawn failure resolves rather than rejecting", async () => {
  const result = await runExec({
    command: "whatever",
    cwd: workspaceBrowseRoot,
    spawnImpl: () => { throw new Error("ENOENT: no bash"); },
  });

  assert.equal(result.spawnFailed, true);
  assert.equal(result.exitCode, null);
  assert.match(result.stderr, /ENOENT/);
});

test("the default output cap is a megabyte", () => {
  assert.equal(EXEC_MAX_OUTPUT_BYTES, 1024 * 1024);
});
