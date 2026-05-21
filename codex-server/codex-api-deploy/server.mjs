import http from "node:http";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const host = process.env.CODEX_API_HOST || "127.0.0.1";
const port = parseIntegerEnv("CODEX_API_PORT", 8787, 1, 65535);
const requireMtls = parseBooleanEnv("CODEX_REQUIRE_MTLS", true);
const allowedCertSubjects = new Set(splitCsv(process.env.CODEX_ALLOWED_CERT_SUBJECTS));
const dataDir = process.env.CODEX_DATA_DIR || "/var/lib/codex-api";
const jobsDir = path.join(dataDir, "jobs");
const logsDir = path.join(dataDir, "logs");
const auditPath = path.join(dataDir, "audit.jsonl");
const codexBin = process.env.CODEX_BIN || "/usr/local/bin/codex";
const runHome = process.env.CODEX_RUN_HOME || process.env.HOME || "/home/ec2-user";
const codexHome = process.env.CODEX_HOME || path.join(runHome, ".codex");
const dangerousMode = parseBooleanEnv("CODEX_DANGEROUS_MODE", true);
const maxConcurrent = parseIntegerEnv("CODEX_MAX_CONCURRENT", 1, 1, 16);
const maxBodyBytes = parseIntegerEnv("CODEX_MAX_BODY_BYTES", 1024 * 1024, 1, 20 * 1024 * 1024);
const maxOutputBytes = parseIntegerEnv("CODEX_MAX_OUTPUT_BYTES", 5 * 1024 * 1024, 1, 50 * 1024 * 1024);
const responseOutputBytes = Math.min(
  parseIntegerEnv("CODEX_RESPONSE_OUTPUT_BYTES", 64 * 1024, 1, maxOutputBytes),
  maxOutputBytes,
);
const listOutputBytes = Math.min(
  parseIntegerEnv("CODEX_LIST_OUTPUT_BYTES", 4 * 1024, 1, responseOutputBytes),
  responseOutputBytes,
);
const maxTimeoutMs = parseIntegerEnv("CODEX_MAX_TIMEOUT_MS", 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000);
const defaultTimeoutMs = Math.min(
  parseIntegerEnv("CODEX_DEFAULT_TIMEOUT_MS", 10 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
  maxTimeoutMs,
);
const threadSummaryCharacters = parseIntegerEnv("CODEX_THREAD_SUMMARY_CHARACTERS", 240, 40, 2000);

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timeout"]);
const allowedReasoningEfforts = new Set(["low", "medium", "high", "xhigh"]);
const jobs = new Map();
const activeChildren = new Map();
let queuedJobIds = [];

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(jobsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });

const workspaces = loadWorkspaces();
loadPersistedJobs();
processQueue();

function parseIntegerEnv(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function parseBooleanEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function splitCsv(value) {
  return (value || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function loadWorkspaces() {
  const configured = process.env.CODEX_WORKSPACES
    ? JSON.parse(process.env.CODEX_WORKSPACES)
    : [
        { id: "scratch", name: "Scratch", path: "/srv/codex-workspaces/scratch" },
        { id: "poc-vault", name: "POC Vault", path: "/srv/codex-workspaces/poc-vault" },
      ];

  if (!Array.isArray(configured) || configured.length === 0) {
    throw new Error("CODEX_WORKSPACES must be a non-empty JSON array");
  }

  const registry = new Map();
  for (const entry of configured) {
    if (!entry || typeof entry !== "object") {
      throw new Error("CODEX_WORKSPACES entries must be objects");
    }

    const id = cleanWorkspaceId(entry.id);
    const name = cleanDisplayName(entry.name || entry.id, "workspace name", 120);
    const workspacePath = cleanWorkspacePath(entry.path, id);

    if (registry.has(id)) {
      throw new Error(`duplicate workspace id: ${id}`);
    }

    fs.mkdirSync(workspacePath, { recursive: true });
    registry.set(id, {
      id,
      name,
      path: fs.realpathSync(workspacePath),
    });
  }

  return registry;
}

function cleanWorkspaceId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(value)) {
    throw new Error("workspace id must be 1-80 characters of letters, numbers, dots, underscores, or hyphens");
  }
  return value;
}

function cleanDisplayName(value, name, maxLength) {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength || /[\0\r\n]/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function cleanWorkspacePath(value, id) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`workspace ${id} path is invalid`);
  }
  return path.resolve(value);
}

function loadPersistedJobs() {
  const files = fs.readdirSync(jobsDir).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
      if (!job || typeof job.id !== "string") continue;

      ensureLogPaths(job);
      if (job.status === "running") {
        const finishedAt = nowIso();
        job.status = "failed";
        job.updatedAt = finishedAt;
        job.finishedAt = finishedAt;
        job.durationMs = durationMs(job.startedAt, finishedAt);
        job.exitCode = null;
        job.timedOut = false;
        job.result = null;
        job.error = "service restarted while job was running";
        persistJob(job);
        appendAudit("stale_running_marked_failed", job);
      }

      jobs.set(job.id, job);
      if (job.status === "queued") queuedJobIds.push(job.id);
    } catch (error) {
      appendAudit("load_job_failed", { id: file, status: "unknown" }, { error: error.message });
    }
  }

  queuedJobIds.sort((left, right) => {
    const leftJob = jobs.get(left);
    const rightJob = jobs.get(right);
    return Date.parse(leftJob?.createdAt || 0) - Date.parse(rightJob?.createdAt || 0);
  });
}

function ensureLogPaths(job) {
  job.stdoutPath ||= path.join(logsDir, `${job.id}.stdout.log`);
  job.stderrPath ||= path.join(logsDir, `${job.id}.stderr.log`);
  job.resultPath ||= path.join(logsDir, `${job.id}.answer.md`);
}

function jobPath(id) {
  return path.join(jobsDir, `${id}.json`);
}

function persistJob(job) {
  ensureLogPaths(job);
  const file = jobPath(job.id);
  const tmpFile = `${file}.tmp`;
  fs.writeFileSync(tmpFile, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  fs.renameSync(tmpFile, file);
}

function appendAudit(event, job, extra = {}) {
  const line = JSON.stringify({
    ts: nowIso(),
    event,
    jobId: job?.id || null,
    status: job?.status || null,
    workspaceId: job?.workspaceId || null,
    certSubject: job?.certSubject || null,
    ...extra,
  });
  try {
    fs.appendFileSync(auditPath, `${line}\n`, "utf8");
  } catch (error) {
    console.error(`failed to append audit log: ${error.message}`);
  }
}

function nowIso() {
  return new Date().toISOString();
}

function durationMs(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return null;
  const value = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendError(res, status, message) {
  return sendJson(res, status, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw.length === 0) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("invalid JSON body"), { status: 400 }));
      }
    });

    req.on("error", reject);
  });
}

function authorize(req) {
  const verify = headerValue(req.headers["x-ssl-client-verify"]);
  const subject = headerValue(req.headers["x-ssl-client-s-dn"]);

  if (!requireMtls) {
    return { ok: true, subject: subject || null };
  }

  if (verify !== "SUCCESS") {
    return { ok: false, status: 401, error: "client certificate is required" };
  }

  if (!allowedCertSubjects.has(subject)) {
    return { ok: false, status: 403, error: "client certificate subject is not allowed" };
  }

  return { ok: true, subject };
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

async function routeRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, healthPayload(false));
  }

  const auth = authorize(req);
  if (!auth.ok) {
    return sendError(res, auth.status, auth.error);
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/health") {
    return sendJson(res, 200, healthPayload(true));
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/workspaces") {
    return sendJson(res, 200, {
      workspaces: [...workspaces.values()].map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
      })),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/sessions") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    return sendJson(res, 200, { sessions: listWorkspaceSessions({ workspaceId, limit }) });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/threads") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    return sendJson(res, 200, { threads: listWorkspaceThreads({ workspaceId, limit }) });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/jobs") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const selectedJobs = [...jobs.values()]
      .sort((left, right) => Date.parse(right.createdAt || 0) - Date.parse(left.createdAt || 0))
      .slice(0, limit);
    return sendJson(res, 200, {
      jobs: await Promise.all(selectedJobs.map((job) => toJobResponse(job, responseShape("compact")))),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/jobs") {
    const body = await readBody(req);
    const job = createJob(body, auth.subject);
    jobs.set(job.id, job);
    queuedJobIds.push(job.id);
    persistJob(job);
    appendAudit("job_created", job);
    processQueue();
    return sendJson(res, 202, await toJobResponse(job, responseShape("preview")));
  }

  const jobMatch = url.pathname.match(/^\/v1\/codex\/jobs\/([^/]+)(?:\/(cancel))?$/);
  if (jobMatch) {
    const [, id, action] = jobMatch;
    if (!isSafeJobId(id)) return sendError(res, 404, "job not found");
    const job = jobs.get(id);
    if (!job) return sendError(res, 404, "job not found");

    if (!action && req.method === "GET") {
      return sendJson(res, 200, await toJobResponse(job, responseShape(wantsFullLogs(url.searchParams) ? "full" : "preview")));
    }

    if (action === "cancel" && req.method === "POST") {
      const cancelledJob = cancelJob(job);
      return sendJson(res, 202, await toJobResponse(cancelledJob, responseShape("preview")));
    }
  }

  return sendError(res, 404, "not found");
}

function healthPayload(authenticated) {
  return {
    ok: true,
    authenticated,
    requireMtls,
    queueLength: queuedJobIds.length,
    activeJobs: activeChildren.size,
    maxConcurrent,
    workspaceCount: workspaces.size,
  };
}

function clampLimit(value) {
  const parsed = Number(value || "50");
  if (!Number.isFinite(parsed)) return 50;
  return Math.min(Math.max(Math.trunc(parsed), 1), 200);
}

function isSafeJobId(id) {
  return /^[a-f0-9-]{36}$/.test(id);
}

function responseShape(mode) {
  if (mode === "full") {
    return { logsIncluded: "full", byteLimit: responseOutputBytes, includeFullLogs: true };
  }
  if (mode === "compact") {
    return { logsIncluded: "compact", byteLimit: listOutputBytes, includeFullLogs: false };
  }
  return { logsIncluded: "preview", byteLimit: responseOutputBytes, includeFullLogs: false };
}

function wantsFullLogs(searchParams) {
  const full = (searchParams.get("full") || "").trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(full)) return true;

  return searchParams
    .getAll("include")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .includes("fullLogs");
}

function createJob(body, certSubject) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }

  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    throw Object.assign(new Error("prompt is required and must be a non-empty string"), { status: 400 });
  }

  if (Buffer.byteLength(body.prompt, "utf8") > maxBodyBytes) {
    throw Object.assign(new Error("prompt is too large"), { status: 413 });
  }

  const workspaceId = cleanWorkspaceId(body.workspaceId);
  const workspace = workspaces.get(workspaceId);
  if (!workspace) {
    throw Object.assign(new Error("workspaceId is not registered"), { status: 400 });
  }

  const resumeSessionId = cleanOptionalSessionId(body.resumeSessionId);
  if (resumeSessionId) {
    const sessionMeta = findSessionMeta(resumeSessionId);
    if (!sessionMeta) {
      throw Object.assign(new Error("session not found in runner CODEX_HOME"), { status: 400 });
    }
    if (!sessionBelongsToWorkspace(sessionMeta.cwd, workspace.path)) {
      throw Object.assign(new Error("session does not belong to workspace"), { status: 400 });
    }
  }

  const requestedTimeout = body.timeoutMs === undefined ? defaultTimeoutMs : Number(body.timeoutMs);
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
    throw Object.assign(new Error("timeoutMs must be a positive number"), { status: 400 });
  }

  const id = crypto.randomUUID();
  const createdAt = nowIso();
  const timeoutMs = Math.min(Math.max(Math.trunc(requestedTimeout), 1000), maxTimeoutMs);
  const job = {
    id,
    status: "queued",
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    prompt: body.prompt,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    exitCode: null,
    timedOut: false,
    stdoutPath: path.join(logsDir, `${id}.stdout.log`),
    stderrPath: path.join(logsDir, `${id}.stderr.log`),
    resultPath: path.join(logsDir, `${id}.answer.md`),
    result: null,
    error: null,
    certSubject,
    timeoutMs,
    model: cleanOptionalModel(body.model),
    reasoningEffort: cleanOptionalReasoningEffort(body.reasoningEffort),
    resumeSessionId,
    sessionId: resumeSessionId || null,
  };

  fs.writeFileSync(job.stdoutPath, "", "utf8");
  fs.writeFileSync(job.stderrPath, "", "utf8");
  fs.writeFileSync(job.resultPath, "", "utf8");
  return job;
}

function cleanOptionalModel(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw Object.assign(new Error("model is invalid"), { status: 400 });
  }
  return value;
}

function cleanOptionalReasoningEffort(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error("reasoningEffort is invalid"), { status: 400 });
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedReasoningEfforts.has(normalized)) {
    throw Object.assign(new Error("reasoningEffort must be low, medium, high, or xhigh"), { status: 400 });
  }
  return normalized;
}

function cleanOptionalSessionId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isSafeJobId(value)) {
    throw Object.assign(new Error("resumeSessionId is invalid"), { status: 400 });
  }
  return value;
}

function findSessionMeta(sessionId) {
  const sessionsDir = path.join(codexHome, "sessions");
  const sessionFile = findSessionFile(sessionsDir, sessionId);
  if (!sessionFile) return null;
  return readSessionMeta(sessionFile, sessionId);
}

function readSessionMeta(sessionFile, expectedSessionId = null) {
  const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "session_meta" && (!expectedSessionId || entry.payload?.id === expectedSessionId)) {
        const id = entry.payload?.id;
        const cwd = entry.payload.cwd;
        if (
          typeof id === "string" &&
          isSafeJobId(id) &&
          typeof cwd === "string" &&
          cwd.length > 0 &&
          !/[\0\r\n]/.test(cwd)
        ) {
          return { id, cwd, timestamp: cleanSessionTimestamp(entry.payload.timestamp || entry.timestamp) };
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function cleanSessionTimestamp(value) {
  return typeof value === "string" && value.length <= 80 && !/[\0\r\n]/.test(value) ? value : null;
}

function listWorkspaceSessions({ workspaceId, limit, includeSummary = false }) {
  let selectedWorkspace = null;
  if (workspaceId) {
    const cleanId = cleanWorkspaceId(workspaceId);
    selectedWorkspace = workspaces.get(cleanId);
    if (!selectedWorkspace) {
      throw Object.assign(new Error("workspaceId is not registered"), { status: 400 });
    }
  }

  return walkSessionFiles(path.join(codexHome, "sessions"))
    .map((file) => {
      const meta = readSessionMeta(file);
      if (!meta) return null;
      const workspace = workspaceForSessionCwd(meta.cwd);
      if (!workspace) return null;
      if (selectedWorkspace && workspace.id !== selectedWorkspace.id) return null;
      const stat = fs.statSync(file);
      const session = {
        id: meta.id,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        updatedAt: stat.mtime.toISOString(),
      };
      if (includeSummary) {
        session.summary = readSessionSummary(file);
      }
      return session;
    })
    .filter(Boolean)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

function listWorkspaceThreads({ workspaceId, limit }) {
  let selectedWorkspace = null;
  if (workspaceId) {
    const cleanId = cleanWorkspaceId(workspaceId);
    selectedWorkspace = workspaces.get(cleanId);
    if (!selectedWorkspace) {
      throw Object.assign(new Error("workspaceId is not registered"), { status: 400 });
    }
  }

  const threadMap = new Map();
  for (const session of listWorkspaceSessions({ workspaceId, limit: 200, includeSummary: true })) {
    threadMap.set(session.id, {
      ...session,
      sessionId: session.id,
      hasSessionFile: true,
      jobs: [],
    });
  }

  for (const job of jobs.values()) {
    const sessionId = jobThreadId(job);
    if (!sessionId) continue;

    const workspace = workspaces.get(job.workspaceId);
    if (!workspace) continue;
    if (selectedWorkspace && selectedWorkspace.id !== workspace.id) continue;

    let thread = threadMap.get(sessionId);
    if (!thread) {
      thread = {
        id: sessionId,
        sessionId,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: null,
        timestamp: null,
        updatedAt: job.updatedAt || job.createdAt || null,
        hasSessionFile: false,
        jobs: [],
      };
      threadMap.set(sessionId, thread);
    }

    thread.jobs.push(job);
    thread.updatedAt = maxIso(thread.updatedAt, job.updatedAt || job.createdAt);
  }

  return [...threadMap.values()]
    .map(threadSummary)
    .sort((left, right) => compareIsoDesc(left.updatedAt, right.updatedAt))
    .slice(0, limit);
}

function jobThreadId(job) {
  const sessionId = job?.sessionId || job?.resumeSessionId;
  return typeof sessionId === "string" && isSafeJobId(sessionId) ? sessionId : null;
}

function threadSummary(thread) {
  const sortedJobs = [...thread.jobs].sort((left, right) =>
    compareIsoDesc(left.updatedAt || left.createdAt, right.updatedAt || right.createdAt),
  );
  const lastJob = sortedJobs[0] || null;
  const activeJobCount = sortedJobs.filter((job) => !terminalStatuses.has(job.status)).length;

  return {
    id: thread.id,
    sessionId: thread.sessionId || thread.id,
    workspaceId: thread.workspaceId,
    workspaceName: thread.workspaceName,
    cwd: thread.cwd || null,
    timestamp: thread.timestamp || null,
    updatedAt: thread.updatedAt || thread.timestamp || null,
    jobCount: sortedJobs.length,
    activeJobCount,
    lastJobId: lastJob?.id || null,
    lastJobStatus: lastJob?.status || null,
    lastPrompt: summaryText(lastJob?.prompt) || thread.summary?.firstUserPrompt || null,
    lastResult: summaryText(lastJob?.result) || thread.summary?.lastAssistantAnswer || null,
    lastError: cleanApiText(lastJob?.error || "").trim() || null,
    hasSessionFile: Boolean(thread.hasSessionFile),
    isSmokeTest: isSmokeThread(lastJob),
  };
}

function readSessionSummary(sessionFile) {
  let firstUserPrompt = null;
  let lastAssistantAnswer = null;

  for (const line of readSessionLines(sessionFile)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "response_item") continue;
      const message = entry.payload;
      if (message?.type !== "message") continue;
      const text = boundedThreadText(messageText(message));
      if (!text) continue;
      if (message.role === "user" && !firstUserPrompt) {
        firstUserPrompt = text;
      } else if (message.role === "assistant") {
        lastAssistantAnswer = text;
      }
    } catch {
      continue;
    }
  }

  return { firstUserPrompt, lastAssistantAnswer };
}

function readSessionLines(sessionFile) {
  const maxBytes = 1024 * 1024;
  const stat = fs.statSync(sessionFile);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(sessionFile, "utf8").split("\n");
  }

  const buffer = Buffer.alloc(maxBytes);
  const fd = fs.openSync(sessionFile, "r");
  try {
    fs.readSync(fd, buffer, 0, maxBytes, Math.max(0, stat.size - maxBytes));
    return buffer.toString("utf8").split("\n");
  } finally {
    fs.closeSync(fd);
  }
}

function messageText(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      if (typeof part.text === "string") return part.text;
      if (typeof part.input_text === "string") return part.input_text;
      if (typeof part.output_text === "string") return part.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function summaryText(value) {
  return boundedThreadText(value);
}

function boundedThreadText(value) {
  const text = cleanApiText(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.length <= threadSummaryCharacters) return text;
  return `${text.slice(0, threadSummaryCharacters - 1).trimEnd()}…`;
}

function isSmokeThread(job) {
  if (!job) return false;
  const prompt = summaryText(job.prompt)?.toLowerCase() || "";
  const result = summaryText(job.result)?.toLowerCase() || "";
  return (
    (prompt.includes("reply with exactly codex-async-ok") && result === "codex-async-ok") ||
    (prompt.includes("reply with exactly resume-ok") && result === "resume-ok")
  );
}

function maxIso(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function compareIsoDesc(left, right) {
  return Date.parse(right || 0) - Date.parse(left || 0);
}

function walkSessionFiles(rootDir) {
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  if (!rootStat.isDirectory()) return [];

  const files = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function workspaceForSessionCwd(sessionCwd) {
  for (const workspace of workspaces.values()) {
    if (sessionBelongsToWorkspace(sessionCwd, workspace.path)) return workspace;
  }
  return null;
}

function findSessionFile(rootDir, sessionId) {
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  if (!rootStat.isDirectory()) return null;

  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile() && entry.name.includes(sessionId) && entry.name.endsWith(".jsonl")) {
        return entryPath;
      }
    }
  }
  return null;
}

function sessionBelongsToWorkspace(sessionCwd, workspacePath) {
  const resolvedSessionCwd = realpathOrResolve(sessionCwd);
  const resolvedWorkspacePath = realpathOrResolve(workspacePath);
  return (
    resolvedSessionCwd === resolvedWorkspacePath ||
    resolvedSessionCwd.startsWith(`${resolvedWorkspacePath}${path.sep}`)
  );
}

function realpathOrResolve(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function cancelJob(job) {
  if (terminalStatuses.has(job.status)) {
    throw Object.assign(new Error("job is already finished"), { status: 409 });
  }

  if (job.status === "queued") {
    queuedJobIds = queuedJobIds.filter((id) => id !== job.id);
    const finishedAt = nowIso();
    job.status = "cancelled";
    job.updatedAt = finishedAt;
    job.finishedAt = finishedAt;
    job.durationMs = 0;
    job.exitCode = null;
    job.timedOut = false;
    job.result = null;
    job.error = "job cancelled before start";
    persistJob(job);
    appendAudit("job_cancelled", job);
    processQueue();
    return job;
  }

  const active = activeChildren.get(job.id);
  if (!active) {
    throw Object.assign(new Error("job is not active"), { status: 409 });
  }

  active.cancelRequested = true;
  job.updatedAt = nowIso();
  job.error = "cancellation requested";
  persistJob(job);
  appendAudit("job_cancel_requested", job);
  terminateChild(active);
  return job;
}

function processQueue() {
  while (activeChildren.size < maxConcurrent && queuedJobIds.length > 0) {
    const id = queuedJobIds.shift();
    const job = jobs.get(id);
    if (!job || job.status !== "queued") continue;
    startJob(job);
  }
}

function startJob(job) {
  const startedAt = nowIso();
  job.status = "running";
  job.startedAt = startedAt;
  job.updatedAt = startedAt;
  job.error = null;
  job.timedOut = false;
  persistJob(job);
  appendAudit("job_started", job);

  const stdoutStream = fs.createWriteStream(job.stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(job.stderrPath, { flags: "a" });
  let stdout = "";
  let stderr = "";

  const args = buildCodexArgs(job);
  const child = spawn(codexBin, args, {
    cwd: job.workspacePath,
    env: {
      ...process.env,
      HOME: runHome,
      CODEX_HOME: codexHome,
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const active = {
    child,
    cancelRequested: false,
    finalized: false,
    timedOut: false,
    killTimer: null,
    timeoutTimer: null,
    stdoutStream,
    stderrStream,
    sessionIdsBefore: job.resumeSessionId ? null : workspaceSessionIdSet(job.workspacePath),
  };
  activeChildren.set(job.id, active);

  active.timeoutTimer = setTimeout(() => {
    active.timedOut = true;
    job.timedOut = true;
    job.updatedAt = nowIso();
    job.error = "job timed out";
    persistJob(job);
    appendAudit("job_timeout_requested", job);
    terminateChild(active);
  }, job.timeoutMs);
  active.timeoutTimer.unref();

  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
    stdoutStream.write(chunk);
  });

  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
    stderrStream.write(chunk);
  });

  child.on("error", (error) => {
    stderr = appendBounded(stderr, Buffer.from(error.message));
    void finishJob(job, active, {
      code: null,
      signal: null,
      stdout,
      stderr,
      spawnError: error,
    });
  });

  child.on("close", (code, signal) => {
    void finishJob(job, active, {
      code,
      signal,
      stdout,
      stderr,
      spawnError: null,
    });
  });

  child.stdin.end(job.prompt);
}

function buildCodexArgs(job) {
  if (job.resumeSessionId) return buildCodexResumeArgs(job);

  const args = ["exec", "-C", job.workspacePath, "--skip-git-repo-check", "--ignore-rules"];
  if (dangerousMode) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write", "-a", "never");
  }
  if (job.model) args.push("-m", job.model);
  if (job.reasoningEffort) args.push("-c", `model_reasoning_effort="${job.reasoningEffort}"`);
  args.push("-o", job.resultPath);
  args.push("-");
  return args;
}

function buildCodexResumeArgs(job) {
  const args = ["exec", "resume", "--skip-git-repo-check", "--ignore-rules"];
  if (dangerousMode) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (job.model) args.push("-m", job.model);
  if (job.reasoningEffort) args.push("-c", `model_reasoning_effort="${job.reasoningEffort}"`);
  args.push("-o", job.resultPath);
  args.push(job.resumeSessionId, "-");
  return args;
}

function terminateChild(active) {
  if (active.child.exitCode !== null || active.child.killed) return;
  active.child.kill("SIGTERM");
  if (!active.killTimer) {
    active.killTimer = setTimeout(() => {
      if (active.child.exitCode === null) active.child.kill("SIGKILL");
    }, 5000);
    active.killTimer.unref();
  }
}

async function finishJob(job, active, { code, signal, stdout, stderr, spawnError }) {
  if (active.finalized) return;
  active.finalized = true;

  clearTimeout(active.timeoutTimer);
  clearTimeout(active.killTimer);
  await Promise.all([finishStream(active.stdoutStream), finishStream(active.stderrStream)]);
  activeChildren.delete(job.id);

  const finishedAt = nowIso();
  const stderrText = cleanApiText(stderr).trim();
  const resultText = await readTextFileBounded(job.resultPath, maxOutputBytes);
  const cleanResult = cleanAssistantResult(resultText).trim();

  job.updatedAt = finishedAt;
  job.finishedAt = finishedAt;
  job.durationMs = durationMs(job.startedAt, finishedAt);
  job.exitCode = code;
  job.timedOut = active.timedOut;
  job.sessionId ||= job.resumeSessionId || findNewWorkspaceSessionId(job, active.sessionIdsBefore);

  if (active.cancelRequested) {
    job.status = "cancelled";
    job.result = null;
    job.error = "job cancelled";
  } else if (active.timedOut) {
    job.status = "timeout";
    job.result = null;
    job.error = "job timed out";
  } else if (spawnError) {
    job.status = "failed";
    job.result = null;
    job.error = spawnError.message;
  } else if (code === 0) {
    job.status = "succeeded";
    job.result = cleanResult || null;
    job.error = null;
  } else {
    job.status = "failed";
    job.result = null;
    job.error = stderrText || `codex exited with code ${code}${signal ? ` and signal ${signal}` : ""}`;
  }

  persistJob(job);
  appendAudit("job_finished", job, { code, signal });
  processQueue();
}

function finishStream(stream) {
  return new Promise((resolve) => {
    stream.once("error", resolve);
    stream.end(resolve);
  });
}

function appendBounded(current, chunk) {
  if (current.length >= maxOutputBytes) return current;
  const next = current + chunk.toString("utf8");
  if (next.length <= maxOutputBytes) return next;
  return `${next.slice(0, maxOutputBytes)}\n[output truncated]\n`;
}

function workspaceSessionIdSet(workspacePath) {
  return new Set(workspaceSessionEntries(workspacePath).map((entry) => entry.id));
}

function findNewWorkspaceSessionId(job, sessionIdsBefore) {
  if (!sessionIdsBefore) return null;
  const candidates = workspaceSessionEntries(job.workspacePath).filter((entry) => !sessionIdsBefore.has(entry.id));
  return candidates.length === 1 ? candidates[0].id : null;
}

function workspaceSessionEntries(workspacePath) {
  return walkSessionFiles(path.join(codexHome, "sessions"))
    .map((file) => {
      const meta = readSessionMeta(file);
      if (!meta || !sessionBelongsToWorkspace(meta.cwd, workspacePath)) return null;
      return { id: meta.id, cwd: meta.cwd };
    })
    .filter(Boolean);
}

async function toJobResponse(job, shape = responseShape("preview")) {
  const [stdout, stderr, result] = await Promise.all([
    shapeTextPayload({
      file: job.stdoutPath || path.join(logsDir, `${job.id}.stdout.log`),
      value: "",
      byteLimit: shape.byteLimit,
      includeFull: shape.includeFullLogs,
    }),
    shapeTextPayload({
      file: job.stderrPath || path.join(logsDir, `${job.id}.stderr.log`),
      value: "",
      byteLimit: shape.byteLimit,
      includeFull: shape.includeFullLogs,
    }),
    shapeTextPayload({
      file: job.resultPath || path.join(logsDir, `${job.id}.answer.md`),
      value: job.result || "",
      byteLimit: shape.byteLimit,
      includeFull: shape.includeFullLogs,
      trim: true,
    }),
  ]);

  return {
    id: job.id,
    status: job.status,
    workspaceId: job.workspaceId,
    workspaceName: job.workspaceName,
    prompt: job.prompt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.status === "running" && job.startedAt ? Date.now() - Date.parse(job.startedAt) : job.durationMs,
    exitCode: job.exitCode,
    timedOut: Boolean(job.timedOut),
    logsIncluded: shape.logsIncluded,
    stdout: stdout.text,
    stdoutPreview: stdout.preview,
    stdoutBytes: stdout.bytes,
    stdoutTruncated: stdout.truncated,
    stderr: stderr.text,
    stderrPreview: stderr.preview,
    stderrBytes: stderr.bytes,
    stderrTruncated: stderr.truncated,
    result: result.text,
    resultPreview: result.preview,
    resultBytes: result.bytes,
    resultTruncated: result.truncated,
    error: cleanApiText(job.error),
    certSubject: job.certSubject,
    model: job.model || null,
    reasoningEffort: job.reasoningEffort || null,
    resumeSessionId: job.resumeSessionId || null,
    sessionId: job.sessionId || job.resumeSessionId || null,
  };
}

async function shapeTextPayload({ file, value, byteLimit, includeFull, trim = false }) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 0 || !value) {
      return await shapeTextFile(file, stat.size, byteLimit, includeFull, trim);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return shapeTextValue(value, byteLimit, includeFull, trim);
}

async function shapeTextFile(file, byteCount, byteLimit, includeFull, trim) {
  const raw = includeFull ? await fsp.readFile(file, "utf8") : await readTextFilePrefix(file, byteLimit);
  const text = cleanPayloadText(raw, trim);
  const preview = includeFull ? cleanPayloadText(prefixByBytes(raw, byteLimit), trim) : text;
  return {
    text,
    preview,
    bytes: byteCount,
    truncated: !includeFull && byteCount > byteLimit,
  };
}

function shapeTextValue(value, byteLimit, includeFull, trim) {
  const raw = value ? String(value) : "";
  const byteCount = Buffer.byteLength(raw, "utf8");
  const text = cleanPayloadText(includeFull ? raw : prefixByBytes(raw, byteLimit), trim);
  return {
    text,
    preview: text,
    bytes: byteCount,
    truncated: !includeFull && byteCount > byteLimit,
  };
}

function cleanPayloadText(value, trim) {
  const text = cleanApiText(value);
  return trim ? text.trim() : text;
}

async function readTextFilePrefix(file, byteLimit) {
  const handle = await fsp.open(file, "r");
  try {
    const buffer = Buffer.alloc(byteLimit);
    const { bytesRead } = await handle.read(buffer, 0, byteLimit, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function prefixByBytes(value, byteLimit) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(0, Math.min(buffer.length, byteLimit)).toString("utf8");
}

function cleanAssistantResult(value) {
  if (!value) return "";
  return cleanApiText(value).trim();
}

function cleanApiText(value) {
  if (!value) return "";
  return stripAnsi(String(value)).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

async function readTextFileBounded(file, byteLimit) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size === 0) return "";

    const length = Math.min(stat.size, byteLimit);
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      const suffix = stat.size > byteLimit ? "\n[output truncated]\n" : "";
      return `${buffer.toString("utf8")}${suffix}`;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

const server = http.createServer((req, res) => {
  routeRequest(req, res).catch((error) => {
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendError(res, status, error.message || "internal error");
  });
});

server.listen(port, host, () => {
  console.log(`codex-api listening on http://${host}:${port}`);
});
