// relayd harness.mjs — W2-MODULES: provider CLI detection, smoke runs, and
// device-code login orchestration (API.md §2.5). Long-running harness
// actions are modeled as OPERATIONS, not jobs. Login never transports
// credentials over the API — only the provider's own public device-code
// verification URL/code parsed from CLI stdout.

import { execFile, spawn, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { codexBin, claudeBin, cursorBin, kimiBin, runHome, codexHome, kimiHome, allowedJobProviders } from "./config.mjs";
import { nowIso, cleanApiText, suffixByBytes } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import { emitEvent } from "./events.mjs";

const opLogTailBytes = 8 * 1024;

const loginTimeoutMs = 10 * 60 * 1000;

const smokeTimeoutMs = 2 * 60 * 1000;

// Direct login from the phone: bounded paste-back input and a bounded relay
// of the provider's own localhost OAuth callback. Both carry credentials
// (an authorization code), so neither the input text nor the callback query
// may ever reach op.log, the audit trail, or stderr.
const loginInputMaxBytes = 4 * 1024;

const loginCallbackTimeoutMs = 15 * 1000;

const loginCallbackMaxRedirects = 3;

// The provider CLI's own local OAuth-callback listener. Only providers listed
// here accept POST /v1/harness/ops/:id/callback; Codex's login server binds
// 1455 (fixed upstream). Override per install with
// RELAYD_HARNESS_CALLBACK_PORTS='{"codex":1455,...}'.
const defaultLoginCallbackPorts = { codex: 1455 };

const providerVersionCache = new Map();
const providerVersionCacheMs = 5 * 60 * 1000;
const providerHelpCache = new Map();

// Static capability flags per provider adapter (extraction judgment call —
// mirrors what the job engine supports today).
const providerCapabilities = {
  codex: {
    supportsApprovals: true,
    supportsResume: true,
    supportsChat: true,
    taskControls: {
      model: true,
      reasoningEffort: true,
      permissionModes: [],
      approvalPolicies: ["untrusted", "on-failure", "on-request", "never"],
    },
  },
  claude: {
    supportsApprovals: true,
    supportsResume: true,
    supportsChat: false,
    taskControls: {
      model: true,
      reasoningEffort: true,
      permissionModes: ["manual", "acceptEdits", "plan", "dontAsk", "auto"],
      approvalPolicies: [],
    },
  },
  cursor: {
    supportsApprovals: false,
    supportsResume: true,
    supportsChat: false,
    taskControls: {
      model: true,
      reasoningEffort: false,
      permissionModes: [],
      approvalPolicies: [],
    },
  },
  kimi: {
    supportsApprovals: false,
    supportsResume: true,
    supportsChat: false,
    taskControls: {
      model: true,
      reasoningEffort: false,
      permissionModes: [],
      approvalPolicies: [],
    },
  },
};

function providerBinary(provider) {
  if (provider === "claude") return claudeBin;
  if (provider === "cursor") return cursorBin;
  if (provider === "kimi") return kimiBin;
  return codexBin;
}

function cleanHarnessProvider(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!allowedJobProviders.has(normalized)) {
    throw Object.assign(new Error("provider must be codex, claude, cursor, or kimi"), { status: 400 });
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

function authStatusArgsFor(provider) {
  if (provider === "claude") return ["auth", "status", "--json"];
  if (provider === "cursor") return ["status", "--format", "json"];
  return ["login", "status"];
}

// Every readiness probe must see the same home and credential boundary as a
// real job. A successful login in the operator's account is irrelevant when
// the isolated Relay runner cannot read it.
function providerEnv(provider) {
  const env = {
    ...process.env,
    HOME: runHome,
    CODEX_HOME: codexHome,
    KIMI_CODE_HOME: kimiHome,
  };
  if (provider === "claude" || provider === "cursor" || provider === "kimi") {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    delete env.AWS_PROFILE;
    delete env.AWS_DEFAULT_PROFILE;
    delete env.AWS_REGION;
    delete env.AWS_DEFAULT_REGION;
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_AWS_PROFILE;
  }
  return env;
}

function detectKimiAuth() {
  const credentialsDir = path.join(kimiHome, "credentials");
  try {
    const hasCredential = fs.readdirSync(credentialsDir, { withFileTypes: true })
      .some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"));
    if (hasCredential) return { loggedIn: true, authKind: "subscription" };
  } catch {}
  return { loggedIn: false, authKind: "unknown" };
}

function jsonObject(text) {
  try {
    const parsed = JSON.parse(String(text || "").trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function authKindFromText(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("api key") || text.includes("apikey")) return "api";
  if (text.includes("chatgpt") || text.includes("subscription") || text.includes("oauth")) return "subscription";
  return "unknown";
}

function parseProviderAuth(provider, output, commandSucceeded) {
  const text = cleanApiText(output);
  const parsed = jsonObject(text);
  if (provider === "claude" && parsed && typeof parsed.loggedIn === "boolean") {
    return {
      loggedIn: parsed.loggedIn,
      authKind: parsed.loggedIn ? authKindFromText(parsed.authMethod || parsed.apiProvider) : "unknown",
    };
  }
  if (provider === "cursor" && parsed && typeof parsed.isAuthenticated === "boolean") {
    const authKind = parsed.isAuthenticated
      ? (parsed.hasRefreshToken ? "subscription" : parsed.hasAccessToken ? "api" : "unknown")
      : "unknown";
    return { loggedIn: parsed.isAuthenticated, authKind };
  }
  if (provider === "codex" && /not logged in|signed out|no (?:valid )?(?:session|credentials?)/i.test(text)) {
    return { loggedIn: false, authKind: "unknown" };
  }
  if (commandSucceeded) {
    return { loggedIn: true, authKind: authKindFromText(text) };
  }
  // Older or vendor-modified CLIs may not implement a status command. Keep
  // that distinguishable from a confirmed signed-out state so an upgrade does
  // not make a previously working provider unusable.
  return { loggedIn: null, authKind: "unknown" };
}

function detectProviderAuth(provider) {
  if (provider === "kimi") return detectKimiAuth();
  const bin = providerBinary(provider);
  try {
    const output = execFileSync(bin, authStatusArgsFor(provider), {
      encoding: "utf8",
      timeout: 10000,
      env: providerEnv(provider),
      cwd: runHome,
    });
    return parseProviderAuth(provider, output, true);
  } catch (error) {
    const output = [error?.stdout, error?.stderr]
      .map((value) => Buffer.isBuffer(value) ? value.toString("utf8") : String(value || ""))
      .join("\n");
    return parseProviderAuth(provider, output, false);
  }
}

function detectProviderVersion(provider) {
  const bin = providerBinary(provider);
  const cached = providerVersionCache.get(provider);
  if (cached && cached.bin === bin && cached.expiresAt > Date.now()) return cached.version;
  let version = null;
  try {
    const output = execFileSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 10000,
      env: providerEnv(provider),
      cwd: runHome,
    }).trim();
    version = cleanApiText(output.split("\n")[0] || "").trim() || null;
  } catch {}
  providerVersionCache.set(provider, { bin, version, expiresAt: Date.now() + providerVersionCacheMs });
  return version;
}

function providerHelp(provider) {
  const bin = providerBinary(provider);
  const cached = providerHelpCache.get(provider);
  if (cached && cached.bin === bin && cached.expiresAt > Date.now()) return cached.text;
  let help = "";
  try {
    help = cleanApiText(execFileSync(bin, ["--help"], {
      encoding: "utf8",
      timeout: 10000,
      env: providerEnv(provider),
      cwd: runHome,
    }));
  } catch {}
  providerHelpCache.set(provider, { bin, text: help, expiresAt: Date.now() + providerVersionCacheMs });
  return help;
}

function providerTaskControls(provider) {
  const declared = providerCapabilities[provider].taskControls;
  if (provider !== "claude") return declared;
  return { ...declared, reasoningEffort: /(?:^|\s)--effort(?:\s|$)/m.test(providerHelp(provider)) };
}

function detectHarness(provider) {
  const bin = providerBinary(provider);
  let installed = false;
  if (fs.existsSync(bin)) {
    installed = true;
  }
  const version = detectProviderVersion(provider);
  if (version) installed = true;
  const auth = installed
    ? detectProviderAuth(provider)
    : { loggedIn: false, authKind: "unknown" };
  return {
    provider,
    installed,
    version,
    ...auth,
    ...providerCapabilities[provider],
    taskControls: providerTaskControls(provider),
    lastSmoke: lastSmokeByProvider.get(provider) || null,
  };
}

function listHarnesses() {
  return [...allowedJobProviders].map((provider) => detectHarness(provider));
}

function providerDisplayName(provider) {
  if (provider === "claude") return "Claude Code";
  if (provider === "cursor") return "Cursor";
  if (provider === "kimi") return "Kimi K3";
  return "Codex";
}

function providerAuthResult(provider) {
  const bin = providerBinary(provider);
  if (provider === "kimi") {
    return Promise.resolve({ missing: !fs.existsSync(bin), auth: detectKimiAuth() });
  }
  return new Promise((resolve) => {
    const child = execFile(bin, authStatusArgsFor(provider), {
      encoding: "utf8",
      timeout: 10000,
      env: providerEnv(provider),
      cwd: runHome,
    }, (error, stdout, stderr) => {
      resolve({
        missing: error?.code === "ENOENT",
        auth: parseProviderAuth(provider, `${stdout || ""}\n${stderr || ""}`, !error),
      });
    });
    // Status commands are non-interactive. Close stdin explicitly so wrapper
    // scripts that read stdin cannot stall the API request until the timeout.
    child.stdin?.end();
  });
}

async function assertProviderReady(provider, requirements = {}) {
  const cleanProvider = cleanHarnessProvider(provider);
  const displayName = providerDisplayName(cleanProvider);
  const result = await providerAuthResult(cleanProvider);
  if (result.missing) {
    throw Object.assign(new Error(`${displayName} is not installed on this computer.`), { status: 503 });
  }
  if (result.auth.loggedIn === false) {
    const action = cleanProvider === "cursor"
      ? "Run cursor-agent login on the computer, then try again."
      : `Connect ${displayName} from the Relay app (Settings → Coding agents), or run relay sync-auth on your Mac, then try again.`;
    throw Object.assign(new Error(`${displayName} is not connected on this computer. ${action}`), { status: 503 });
  }
  if (cleanProvider === "claude" && requirements.reasoningEffort && !providerTaskControls(cleanProvider).reasoningEffort) {
    throw Object.assign(
      new Error("The installed Claude Code does not support --effort. Upgrade Claude Code on this computer, then try again."),
      { status: 503 },
    );
  }
  return { ...result.auth, version: detectProviderVersion(cleanProvider) };
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

function opEnv(provider) {
  return providerEnv(provider);
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

  // stdin stays open so a paste-back flow (the CLI prompts for the code the
  // provider's site displays after sign-in) can be completed remotely via
  // sendLoginInput. CLIs that never read stdin are unaffected.
  const child = spawn(providerBinary(cleanProvider), loginArgsFor(cleanProvider), {
    env: opEnv(cleanProvider),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin?.on("error", () => {});
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

function requireActiveLoginOp(opId) {
  const op = getOp(opId);
  if (!op) {
    throw Object.assign(new Error("operation not found"), { status: 404 });
  }
  if (op.action !== "login") {
    throw Object.assign(new Error("operation is not a login"), { status: 409 });
  }
  if (!activeOpStatuses.has(op.status)) {
    throw Object.assign(new Error("login has already finished"), { status: 409 });
  }
  return op;
}

// POST /v1/harness/ops/:id/input — deliver one line the user typed on the
// phone (typically the authorization code the provider's site shows after
// sign-in) to the login CLI's stdin. The text is a credential: it is written
// to the child and NOWHERE else — not op.log, not the audit record.
function sendLoginInput(opId, text) {
  const op = requireActiveLoginOp(opId);
  if (typeof text !== "string" || text.trim().length === 0) {
    throw Object.assign(new Error("text is required"), { status: 400 });
  }
  if (Buffer.byteLength(text, "utf8") > loginInputMaxBytes) {
    throw Object.assign(new Error(`text must be at most ${loginInputMaxBytes} bytes`), { status: 400 });
  }
  const line = text.trim();
  if (/[\u0000-\u001f\u007f]/.test(line)) {
    throw Object.assign(new Error("text must be a single line without control characters"), { status: 400 });
  }
  const stdin = activeOpChildren.get(op.id)?.child?.stdin;
  if (!stdin || stdin.destroyed || !stdin.writable) {
    throw Object.assign(new Error("login is not accepting input"), { status: 409 });
  }
  stdin.write(`${line}\n`);
  appendAudit("harness_login_input", null, { opId: op.id, provider: op.provider });
  touchOp(op, {});
  return publicOp(op);
}

// Optional override: RELAYD_HARNESS_CALLBACK_PORTS='{"codex":1455,...}'
function loginCallbackPortFor(provider) {
  const raw = process.env.RELAYD_HARNESS_CALLBACK_PORTS;
  if (raw) {
    try {
      const port = Number(JSON.parse(raw)?.[provider]);
      if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    } catch {
      // Fall through to defaults.
    }
  }
  return defaultLoginCallbackPorts[provider] || null;
}

// One GET against the provider CLI's local login server, following only
// same-origin (localhost, same port) redirects so the CLI's own
// callback → success chain runs exactly as it would in a local browser.
function relayLocalLoginGet(port, pathWithQuery, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: pathWithQuery, method: "GET", agent: false, headers: { connection: "close" } },
      (response) => {
        response.resume();
        const status = response.statusCode || 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location && redirectsLeft > 0) {
          let next = null;
          try {
            next = new URL(location, `http://127.0.0.1:${port}`);
          } catch {
            next = null;
          }
          if (
            next &&
            (next.hostname === "127.0.0.1" || next.hostname === "localhost") &&
            Number(next.port || 80) === port
          ) {
            response.on("end", () => {
              relayLocalLoginGet(port, `${next.pathname}${next.search}`, redirectsLeft - 1).then(resolve, reject);
            });
            return;
          }
        }
        response.on("end", () => resolve(status));
      },
    );
    request.setTimeout(loginCallbackTimeoutMs, () => request.destroy(new Error("login server timed out")));
    request.on("error", () => {
      reject(Object.assign(new Error("the provider's login server is not reachable on this machine"), { status: 502 }));
    });
    request.end();
  });
}

// POST /v1/harness/ops/:id/callback — the phone's in-app browser captured the
// provider's redirect to its localhost login server (Codex binds 1455) and
// hands it here to be replayed on the node, where that server actually runs.
// The query string carries the OAuth authorization code, so it is forwarded
// to 127.0.0.1 and NOWHERE else — never logged, never audited.
async function forwardLoginCallback(opId, rawUrl) {
  const op = requireActiveLoginOp(opId);
  const port = loginCallbackPortFor(op.provider);
  if (!port) {
    throw Object.assign(new Error(`${op.provider} login does not use a local callback`), { status: 400 });
  }
  let parsed;
  try {
    parsed = new URL(String(rawUrl || ""));
  } catch {
    throw Object.assign(new Error("url must be an absolute URL"), { status: 400 });
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "http:" || (hostname !== "localhost" && hostname !== "127.0.0.1")) {
    throw Object.assign(new Error("url must target the provider's localhost login server"), { status: 400 });
  }
  if (Number(parsed.port || 80) !== port) {
    throw Object.assign(new Error(`url must target localhost port ${port}`), { status: 400 });
  }
  if (parsed.pathname !== "/auth/callback") {
    throw Object.assign(new Error("url path is not a login callback"), { status: 400 });
  }
  appendAudit("harness_login_callback", null, { opId: op.id, provider: op.provider, path: parsed.pathname });
  const upstreamStatus = await relayLocalLoginGet(port, `${parsed.pathname}${parsed.search}`, loginCallbackMaxRedirects);
  touchOp(op, {});
  return { op: publicOp(op), upstreamStatus };
}

// POST /v1/harness/ops/:id/cancel — user dismissed the flow on the phone.
// Applies to any still-active op with a child (login or smoke).
function cancelOp(opId) {
  const op = getOp(opId);
  if (!op) {
    throw Object.assign(new Error("operation not found"), { status: 404 });
  }
  if (!activeOpStatuses.has(op.status) || op.finishedAt) {
    throw Object.assign(new Error("operation has already finished"), { status: 409 });
  }
  const child = activeOpChildren.get(op.id)?.child;
  if (child) {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  finishOp(op, "cancelled");
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
  } else if (cleanProvider === "kimi") {
    args = ["--model", "kimi-code/k3", "--prompt", prompt, "--output-format", "stream-json"];
  } else if (cleanProvider === "claude") {
    args = ["--print"];
  } else {
    args = ["exec", "-C", smokeDir, "--skip-git-repo-check", "-"];
  }

  const child = spawn(providerBinary(cleanProvider), args, {
    cwd: smokeDir,
    env: opEnv(cleanProvider),
    stdio: ["pipe", "pipe", "pipe"],
  });
  attachOpChild(op, child, { timeoutMs: smokeTimeoutMs, onExpire: "expired" });
  child.stdin.on("error", () => {});
  if (cleanProvider !== "cursor" && cleanProvider !== "kimi") child.stdin.end(prompt);
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
  detectProviderVersion,
  providerTaskControls,
  listHarnesses,
  assertProviderReady,
  redactSecrets,
  publicOp,
  getOp,
  listOps,
  startLoginOp,
  sendLoginInput,
  forwardLoginCallback,
  cancelOp,
  startSmokeOp,
};
