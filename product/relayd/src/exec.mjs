// POST /v1/exec — run a shell command on this node and return its output.
//
// WHAT THIS IS NOT: it is not a jail. Read that before extending this file.
//
// The workspace jail (fsapi, workspaces.mjs) is a PATH containment check: it
// resolves a requested path and refuses one that escapes the browse root. That
// works because every fsapi caller reaches the filesystem through those
// helpers. A shell does not. Once a process exists it can `cd /` and read
// anything the runtime user can read, and no amount of checking the STARTING
// directory changes that. The only real confinements are OS-level — mount
// namespaces, bubblewrap, a container per command — and the trial image ships
// none of them (see product/trial/Dockerfile).
//
// So the honest security model here is:
//
//   - Authentication IS the boundary. This route sits behind the same mTLS
//     authorize() gate as the rest of the data path. A caller who reaches it
//     holds a device certificate this node's CA issued. There is no weaker
//     path in, and there must never be one.
//   - The runtime user is the blast radius. relayd runs as the non-root
//     `relay` user, so a command can reach what that user can reach — its own
//     workspaces and its own harness credentials. Not root, not other tenants.
//   - `cwd` containment is a usability guard, not a security control. It stops
//     a caller accidentally operating on the wrong tree; it does not stop a
//     determined one leaving it. Saying otherwise in a comment would be worse
//     than not checking at all, because the next person would trust it.
//
// Everything below that is about not letting one command take the node down:
// bounded runtime, bounded output, bounded concurrency, and a kill that
// reaches the whole process group rather than just the shell we spawned.
import { spawn } from "node:child_process";

import { workspaceBrowseRoot } from "./config.mjs";
import { pathBelongsToRoot } from "./workspaces.mjs";
import { appendAudit } from "./audit.mjs";
import { sendJson, sendError, readBody } from "./util.mjs";

// A command is interactive-shaped work, so the ceiling is generous but finite.
export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 300_000;
// Output is buffered in memory and returned in one JSON body, so this bounds
// both the response and the node's RSS. Truncation is reported, never silent.
export const EXEC_MAX_OUTPUT_BYTES = 1024 * 1024;
// A shell can fork. Without a ceiling, a phone with a stuck retry loop is a
// fork bomb with extra steps.
export const EXEC_MAX_CONCURRENT = 4;
// Audit records intent, not payload: enough to reconstruct who ran what,
// truncated so a command carrying a pasted secret does not persist it in full.
const AUDIT_COMMAND_MAX_CHARS = 200;

let running = 0;

function clampTimeout(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return EXEC_DEFAULT_TIMEOUT_MS;
  return Math.min(EXEC_MAX_TIMEOUT_MS, Math.max(1000, Math.floor(parsed)));
}

// Returns an absolute, realpath'd cwd inside the jail, or null when the caller
// asked for somewhere else. An absent cwd means the jail root.
export function resolveExecCwd(requested) {
  if (requested === undefined || requested === null || requested === "") {
    return workspaceBrowseRoot;
  }
  if (typeof requested !== "string") return null;
  // NUL terminates a C string: a path containing one is a different path to
  // the kernel than the one validated here.
  if (requested.includes("\0")) return null;
  try {
    return pathBelongsToRoot(requested, workspaceBrowseRoot) ? requested : null;
  } catch {
    return null;
  }
}

// Collects up to `limit` bytes and reports whether more was produced. The
// stream is NOT unpiped past the limit — a child whose stdout blocks on a full
// pipe never exits, so the timeout would fire on every large-output command
// and report a hang that did not happen. Read and discard instead.
function boundedCollector(limit) {
  const chunks = [];
  let kept = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (kept >= limit) {
        truncated = true;
        return;
      }
      const room = limit - kept;
      if (chunk.length <= room) {
        chunks.push(chunk);
        kept += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, room));
      kept = limit;
      truncated = true;
    },
    result() {
      return { text: Buffer.concat(chunks).toString("utf8"), truncated };
    },
  };
}

// Runs one command. Resolves; never rejects — a caller of an exec endpoint
// wants the failure as data, not as a 500.
export function runExec({
  command,
  cwd,
  timeoutMs = EXEC_DEFAULT_TIMEOUT_MS,
  env = process.env,
  spawnImpl = spawn,
  now = () => Date.now(),
  maxOutputBytes = EXEC_MAX_OUTPUT_BYTES,
}) {
  return new Promise((resolve) => {
    const startedAt = now();
    let child;
    try {
      // `-l` is deliberately omitted: a login shell sources profile scripts
      // whose output would be prepended to every command's stdout. `-c` with
      // an explicit cwd is the reproducible shape.
      //
      // detached:true puts the child in its own process group so the timeout
      // kill can take the whole tree. Without it, `bash -c 'sleep 60 & wait'`
      // survives the kill as an orphan holding the node's resources.
      child = spawnImpl("/bin/bash", ["-c", command], {
        cwd,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({
        exitCode: null, signal: null, stdout: "", stderr: String(err?.message ?? err),
        truncated: false, timedOut: false, durationMs: now() - startedAt, spawnFailed: true,
      });
      return;
    }

    const out = boundedCollector(maxOutputBytes);
    const err = boundedCollector(maxOutputBytes);
    child.stdout?.on("data", (chunk) => out.push(chunk));
    child.stderr?.on("data", (chunk) => err.push(chunk));

    let settled = false;
    let timedOut = false;
    let timer = null;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      const stdout = out.result();
      const stderr = err.result();
      resolve({
        exitCode,
        signal: signal ?? null,
        stdout: stdout.text,
        stderr: stderr.text,
        truncated: stdout.truncated || stderr.truncated,
        timedOut,
        durationMs: now() - startedAt,
      });
    };

    timer = setTimeout(() => {
      timedOut = true;
      // Negative pid = the process group. SIGKILL rather than SIGTERM: this
      // deadline has already expired, and a command that ignores SIGTERM would
      // otherwise hold a concurrency slot indefinitely.
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    }, timeoutMs);

    child.on("error", (spawnErr) => {
      if (settled) return;
      err.push(Buffer.from(String(spawnErr?.message ?? spawnErr)));
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

// POST /v1/exec — body {command, cwd?, timeoutMs?}
export async function serveExec(req, res, { audit = appendAudit, run = runExec } = {}) {
  let body;
  try {
    body = await readBody(req);
  } catch {
    return sendError(res, 400, "invalid body");
  }

  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    return sendError(res, 400, "invalid JSON");
  }

  const command = typeof parsed?.command === "string" ? parsed.command : "";
  if (!command.trim()) return sendError(res, 400, "command is required");
  if (command.includes("\0")) return sendError(res, 400, "command must not contain NUL");

  const cwd = resolveExecCwd(parsed?.cwd);
  if (cwd === null) return sendError(res, 400, "cwd is outside the workspace root");

  if (running >= EXEC_MAX_CONCURRENT) {
    // 429, not 503: the node is healthy, this caller is asking for too much at
    // once, and retrying later is the correct client behaviour.
    return sendError(res, 429, "too many concurrent commands");
  }

  running += 1;
  try {
    const result = await run({ command, cwd, timeoutMs: clampTimeout(parsed?.timeoutMs) });
    // Audited AFTER the run so the record carries the outcome. Output is never
    // audited — it is the one part guaranteed to contain repository content.
    audit("exec", null, {
      cwd,
      command: command.slice(0, AUDIT_COMMAND_MAX_CHARS),
      commandChars: command.length,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
    });
    return sendJson(res, 200, result);
  } finally {
    running -= 1;
  }
}

// Test seam: the module-level counter would otherwise leak across cases.
export function _resetExecConcurrency() {
  running = 0;
}
