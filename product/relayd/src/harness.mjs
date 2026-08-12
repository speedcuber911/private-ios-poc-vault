// relayd harness.mjs — W2-MODULES: provider CLI detection, smoke runs, and
// device-code login orchestration (API.md §2.5). Long-running harness
// actions are modeled as OPERATIONS, not jobs. Login never transports
// credentials over the API — only the provider's own public device-code
// verification URL/code parsed from CLI stdout.

import { spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { codexBin, claudeBin, cursorBin, runHome, allowedJobProviders } from "./config.mjs";
import { nowIso, cleanApiText, suffixByBytes } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import { emitEvent } from "./events.mjs";

const opLogTailBytes = 8 * 1024;

const loginTimeoutMs = 10 * 60 * 1000;

const smokeTimeoutMs = 2 * 60 * 1000;

// Static capability flags per provider adapter (extraction judgment call —
// mirrors what the job engine supports today).
const providerCapabilities = {
  codex: { supportsApprovals: false, supportsResume: true, supportsChat: true },
  claude: { supportsApprovals: true, supportsResume: true, supportsChat: false },
  cursor: { supportsApprovals: false, supportsResume: true, supportsChat: false },
};

function providerBinary(provider) {
  if (provider === "claude") return claudeBin;
  if (provider === "cursor") return cursorBin;
  return codexBin;
}

function cleanHarnessProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowedJobProviders.has(normalized)) {
    throw Object.assign(new Error("provider must be codex, claude, or cursor"), { status: 400 });
  }
  return normalized;
}

// Optional override: RELAYD_HARNESS_LOGIN_ARGS='{"codex":["login"],...}'
function loginArgsFor(provider) {
  const raw = process.env.RELAYD_HARNESS_LOGIN_ARGS;
  if (raw) {
    try {
      const map = JSON.parse(raw);
      if (Array.isArray(map?.[provider])) return map[provider].map(String);
    } catch {
      // Fall through to defaults.
    }
  }
  return ["login"];
}

function detectHarness(provider) {
  const bin = providerBinary(provider);
  let installed = false;
  let version = null;
  if (fs.existsSync(bin)) {
    installed = true;
  }
  try {
    const output = execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
    installed = true;
    version = cleanApiText(output.split("\n")[0] || "").trim() || null;
  } catch {
    // Missing binary or --version failure: version stays null.
  }
  return {
    provider,
    installed,
    version,
    loggedIn: null,
    authKind: "unknown",
    ...providerCapabilities[provider],
    lastSmoke: lastSmokeByProvider.get(provider) || null,
  };
}

function listHarnesses() {
  return [...allowedJobProviders].map((provider) => detectHarness(provider));
}

// --------------------------------------------------------------------------
// Operations
// --------------------------------------------------------------------------

const harnessOps = new Map();

const lastSmokeByProvider = new Map();

const activeOpChildren = new Map();

// Provider CLIs echo whatever they like on stdout/stderr; if one ever printed
// a credential it would land in the op's public logTail. Scrub well-known
// secret shapes before the log leaves the process. Deliberately narrow so the
// device-code UX (an https verification URL + a short user code) survives —
// none of these patterns can match a bare https URL or an XXXX-YYYY code.
const redactionPatterns = [
  // PEM private-key blocks (any flavour), including the body — first, so the
  // base64 body cannot be partially chewed by a later pattern.
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /sk-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
];

// Pure + exported for direct testing.
function redactSecrets(text) {
  if (!text) return "";
  let out = String(text);
  for (const pattern of redactionPatterns) out = out.replace(pattern, "[redacted]");
  return out;
}

function publicOp(op) {
  return {
    id: op.id,
    provider: op.provider,
    action: op.action,
    status: op.status,
    verificationUrl: op.verificationUrl || null,
    userCode: op.userCode || null,
    expiresAt: op.expiresAt || null,
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    finishedAt: op.finishedAt || null,
    error: op.error || null,
    // Redact BEFORE truncating: a PEM block straddling the tail boundary must
    // not survive as a headless (unmatched) base64 body.
    logTail: cleanApiText(suffixByBytes(redactSecrets(op.log || ""), opLogTailBytes)),
  };
}

function getOp(id) {
  return harnessOps.get(id) || null;
}

function listOps(limit = 50) {
  return [...harnessOps.values()]
    .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
    .slice(0, limit)
    .map(publicOp);
}

const activeOpStatuses = new Set(["queued", "running", "waiting_for_user"]);

function assertNoActiveOp(provider, action) {
  for (const op of harnessOps.values()) {
    if (op.provider === provider && op.action === action && activeOpStatuses.has(op.status)) {
      throw Object.assign(new Error(`a ${action} operation is already running for ${provider}`), { status: 409 });
    }
  }
}

function touchOp(op, changes = {}) {
  Object.assign(op, changes, { updatedAt: nowIso() });
  emitEvent("harness.changed", publicOp(op));
}

function makeOp(provider, action) {
  const op = {
    id: crypto.randomUUID(),
    provider,
    action,
    status: "running",
    verificationUrl: null,
    userCode: null,
    expiresAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    finishedAt: null,
    error: null,
    log: "",
  };
  harnessOps.set(op.id, op);
  return op;
}

function finishOp(op, status, error = null) {
  if (op.finishedAt) return;
  const child = activeOpChildren.get(op.id);
  if (child) {
    clearTimeout(child.timeoutTimer);
    activeOpChildren.delete(op.id);
  }
  touchOp(op, { status, error, finishedAt: nowIso() });
  appendAudit("harness_op_finished", null, { opId: op.id, provider: op.provider, action: op.action, opStatus: status });
}

const verificationUrlPattern = /(https?:\/\/[^\s"'<>]+)/;

const userCodePattern = /\b([A-Z0-9]{4,8}-[A-Z0-9]{4,8})\b/;

function scanLoginOutput(op) {
  if (op.status !== "running" && op.status !== "waiting_for_user") return;
  const text = cleanApiText(op.log);
  const urlMatch = verificationUrlPattern.exec(text);
  const codeMatch = userCodePattern.exec(text);
  const changes = {};
  if (urlMatch && op.verificationUrl !== urlMatch[1]) changes.verificationUrl = urlMatch[1];
  if (codeMatch && op.userCode !== codeMatch[1]) changes.userCode = codeMatch[1];
  if ((changes.verificationUrl || changes.userCode) && op.status === "running") {
    changes.status = "waiting_for_user";
    changes.expiresAt = new Date(Date.now() + loginTimeoutMs).toISOString();
  }
  if (Object.keys(changes).length > 0) touchOp(op, changes);
}

function attachOpChild(op, child, { timeoutMs, onExpire, onStdout = null }) {
  const record = { child, timeoutTimer: null };
  activeOpChildren.set(op.id, record);
  record.timeoutTimer = setTimeout(() => {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
    finishOp(op, onExpire, `${op.action} timed out`);
  }, timeoutMs);
  record.timeoutTimer.unref();

  const append = (chunk) => {
    op.log = (op.log + chunk.toString("utf8")).slice(-64 * 1024);
    if (onStdout) onStdout();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("error", (error) => finishOp(op, "failed", error.message || String(error)));
  return record;
}

function opEnv() {
  return { ...process.env, HOME: runHome };
}

// POST /v1/harness/:provider/login — spawns the CLI's device-code flow,
// parses the verification URL/code out of its output, exposes them on the
// op, confirms on exit 0.
function startLoginOp(provider) {
  const cleanProvider = cleanHarnessProvider(provider);
  assertNoActiveOp(cleanProvider, "login");
  const op = makeOp(cleanProvider, "login");
  appendAudit("harness_login_started", null, { opId: op.id, provider: cleanProvider });
  emitEvent("harness.changed", publicOp(op));

  const child = spawn(providerBinary(cleanProvider), loginArgsFor(cleanProvider), {
    env: opEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  attachOpChild(op, child, {
    timeoutMs: loginTimeoutMs,
    onExpire: "expired",
    onStdout: () => scanLoginOutput(op),
  });
  child.on("close", (code) => {
    scanLoginOutput(op);
    if (code === 0) {
      finishOp(op, "succeeded");
    } else if (!op.finishedAt) {
      finishOp(op, "failed", `login exited with code ${code}`);
    }
  });
  return publicOp(op);
}

// POST /v1/harness/:provider/smoke — catalog-honesty style: tiny prompt,
// bounded time, success = exit 0 with non-empty output.
function startSmokeOp(provider) {
  const cleanProvider = cleanHarnessProvider(provider);
  assertNoActiveOp(cleanProvider, "smoke");
  const op = makeOp(cleanProvider, "smoke");
  appendAudit("harness_smoke_started", null, { opId: op.id, provider: cleanProvider });
  emitEvent("harness.changed", publicOp(op));

  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-smoke-"));
  const prompt = "Reply with exactly: OK";
  let args;
  if (cleanProvider === "cursor") {
    args = ["-p", "--force", "--trust", "--workspace", smokeDir, "--output-format", "json", prompt];
  } else if (cleanProvider === "claude") {
    args = ["--print"];
  } else {
    args = ["exec", "-C", smokeDir, "--skip-git-repo-check", "-"];
  }

  const child = spawn(providerBinary(cleanProvider), args, {
    cwd: smokeDir,
    env: opEnv(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachOpChild(op, child, { timeoutMs: smokeTimeoutMs, onExpire: "expired" });
  child.stdin.on("error", () => {});
  if (cleanProvider !== "cursor") child.stdin.end(prompt);
  else child.stdin.end();

  child.on("close", (code) => {
    fs.rmSync(smokeDir, { recursive: true, force: true });
    const succeeded = code === 0 && cleanApiText(op.log).trim().length > 0;
    finishOp(op, succeeded ? "succeeded" : "failed", succeeded ? null : `smoke exited with code ${code}`);
    lastSmokeByProvider.set(cleanProvider, {
      status: succeeded ? "succeeded" : "failed",
      finishedAt: op.finishedAt,
      opId: op.id,
    });
  });
  return publicOp(op);
}

export {
  providerCapabilities,
  providerBinary,
  cleanHarnessProvider,
  detectHarness,
  listHarnesses,
  redactSecrets,
  publicOp,
  getOp,
  listOps,
  startLoginOp,
  startSmokeOp,
};
