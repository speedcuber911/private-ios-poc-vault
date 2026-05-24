import http from "node:http";
import https from "node:https";
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
const attachmentsDir = path.join(dataDir, "attachments");
const artifactsDir = path.join(dataDir, "artifacts");
const auditPath = path.join(dataDir, "audit.jsonl");
const codexBin = process.env.CODEX_BIN || "/usr/bin/codex";
const claudeBin = process.env.CLAUDE_BIN || "/usr/bin/claude";
const runHome = process.env.CODEX_RUN_HOME || process.env.HOME || "/home/ec2-user";
const codexHome = process.env.CODEX_HOME || path.join(runHome, ".codex");
const claudeHome = process.env.CLAUDE_HOME || path.join(runHome, ".claude");
const npmCacheDir = process.env.NPM_CONFIG_CACHE || process.env.npm_config_cache || path.join(runHome, ".npm-cache");
const bunCacheDir = process.env.BUN_INSTALL_CACHE_DIR || path.join(runHome, ".bun-cache");
const dangerousMode = parseBooleanEnv("CODEX_DANGEROUS_MODE", true);
const maxConcurrent = parseIntegerEnv("CODEX_MAX_CONCURRENT", 1, 1, 16);
const maxBodyBytes = parseIntegerEnv("CODEX_MAX_BODY_BYTES", 30 * 1024 * 1024, 1, 50 * 1024 * 1024);
const maxJobAttachments = parseIntegerEnv("CODEX_MAX_JOB_ATTACHMENTS", 6, 0, 20);
const maxJobAttachmentBytes = parseIntegerEnv("CODEX_MAX_JOB_ATTACHMENT_BYTES", 8 * 1024 * 1024, 1, 25 * 1024 * 1024);
const maxJobAttachmentTotalBytes = parseIntegerEnv(
  "CODEX_MAX_JOB_ATTACHMENT_TOTAL_BYTES",
  18 * 1024 * 1024,
  1,
  50 * 1024 * 1024,
);
const maxTranscriptionAudioBytes = parseIntegerEnv(
  "CODEX_MAX_TRANSCRIPTION_AUDIO_BYTES",
  25 * 1024 * 1024,
  1024,
  250 * 1024 * 1024,
);
const maxOutputBytes = parseIntegerEnv("CODEX_MAX_OUTPUT_BYTES", 5 * 1024 * 1024, 1, 50 * 1024 * 1024);
const maxJobArtifacts = parseIntegerEnv("CODEX_MAX_JOB_ARTIFACTS", 12, 0, 50);
const maxArtifactBytes = parseIntegerEnv("CODEX_MAX_ARTIFACT_BYTES", 1024 * 1024, 1024, 25 * 1024 * 1024);
const maxArtifactTotalBytes = parseIntegerEnv("CODEX_MAX_ARTIFACT_TOTAL_BYTES", 5 * 1024 * 1024, 1024, 50 * 1024 * 1024);
const maxJobSkills = parseIntegerEnv("CODEX_MAX_JOB_SKILLS", 6, 0, 20);
const maxSkillPromptBytes = parseIntegerEnv("CODEX_MAX_SKILL_PROMPT_BYTES", 20 * 1024, 1024, 256 * 1024);
const maxSkillDiscoveryFiles = parseIntegerEnv("CODEX_MAX_SKILL_DISCOVERY_FILES", 600, 1, 5000);
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
const workspaceBrowseRoot = realpathOrResolve(
  process.env.CODEX_WORKSPACE_BROWSE_ROOT || process.env.CODEX_WORKSPACE_ROOT || "/srv/codex-workspaces",
);
const maxWorkspaceDirEntries = parseIntegerEnv("CODEX_MAX_WORKSPACE_DIR_ENTRIES", 100, 1, 1000);

const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timeout"]);
const allowedReasoningEfforts = new Set(["low", "medium", "high", "xhigh"]);
const allowedJobProviders = new Set(["codex", "claude"]);
const allowedClaudePermissionModes = new Set(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"]);
const claudeAwsProfile = cleanOptionalAwsProfile(process.env.CLAUDE_AWS_PROFILE || "sigiq");
const claudeAwsRegion = cleanOptionalAwsProfile(
  process.env.CLAUDE_AWS_REGION || process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION,
);
const claudeModelAliases = {
  sonnet: process.env.CLAUDE_SONNET_MODEL || "sonnet",
  opus: process.env.CLAUDE_OPUS_MODEL || "global.anthropic.claude-opus-4-6-v1",
  haiku: process.env.CLAUDE_HAIKU_MODEL || "global.anthropic.claude-haiku-4-5-20251001-v1:0",
};
const claudeDefaultModel = normalizeClaudeModel(cleanOptionalModel(process.env.CLAUDE_DEFAULT_MODEL || "sonnet"));
const azureSpeechEndpoint = cleanOptionalEndpoint(process.env.AZURE_SPEECH_ENDPOINT);
const azureSpeechApiKey = cleanOptionalSecret(process.env.AZURE_SPEECH_API_KEY || process.env.AZURE_SPEECH_KEY);
const azureSpeechApiVersion = cleanApiVersion(process.env.AZURE_SPEECH_API_VERSION || "2025-10-15");
const azureSpeechModel = cleanDisplayName(process.env.AZURE_SPEECH_TRANSCRIPTION_MODEL || "mai-transcribe-1", "Azure Speech transcription model", 120);
const azureSpeechLocales = splitCsv(process.env.AZURE_SPEECH_LOCALES || "en");
const proxyBaseUrl = cleanOptionalEndpoint(process.env.CODEX_PROXY_BASE_URL || process.env.CODEX_REMOTE_BASE_URL);
const proxyClientCertPath = cleanOptionalFilePath(process.env.CODEX_PROXY_CLIENT_CERT || process.env.CODEX_REMOTE_CLIENT_CERT);
const proxyClientKeyPath = cleanOptionalFilePath(process.env.CODEX_PROXY_CLIENT_KEY || process.env.CODEX_REMOTE_CLIENT_KEY);
const jobs = new Map();
const dynamicWorkspaces = new Map();
const activeChildren = new Map();
let queuedJobIds = [];

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(jobsDir, { recursive: true });
fs.mkdirSync(logsDir, { recursive: true });
fs.mkdirSync(attachmentsDir, { recursive: true });
fs.mkdirSync(artifactsDir, { recursive: true });

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

function splitPathList(value) {
  return (value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function loadWorkspaces() {
  const configured = process.env.CODEX_WORKSPACES
    ? JSON.parse(process.env.CODEX_WORKSPACES)
    : [
        { id: "scratch", name: "Scratch", path: "/srv/codex-workspaces/scratch" },
        { id: "poc-vault", name: "POC Vault", path: "/srv/codex-workspaces/poc-vault" },
        { id: "sigiq", name: "SigiQ", path: "/srv/codex-workspaces/sigiq" },
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

function workspaceList() {
  const byId = new Map(workspaces);
  for (const workspace of dynamicWorkspaces.values()) {
    byId.set(workspace.id, workspace);
  }
  return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function resolveWorkspaceById(id) {
  return workspaces.get(id) || dynamicWorkspaces.get(id) || findDynamicWorkspaceById(id);
}

function publicWorkspace(workspace) {
  return {
    id: workspace.id,
    name: workspace.name,
    path: workspace.path,
  };
}

function browseWorkspaceForPath(workspacePath, { materialize = false } = {}) {
  const resolvedPath = realpathOrResolve(workspacePath);
  const exactRegistered = [...workspaces.values()].find((workspace) => workspace.path === resolvedPath);
  if (exactRegistered) return exactRegistered;
  const exactDynamic = [...dynamicWorkspaces.values()].find((workspace) => workspace.path === resolvedPath);
  if (exactDynamic) return exactDynamic;

  if (!pathBelongsToRoot(resolvedPath, workspaceBrowseRoot) || resolvedPath === workspaceBrowseRoot) {
    return null;
  }

  const relativePath = path.relative(workspaceBrowseRoot, resolvedPath);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;

  const workspace = {
    id: dynamicWorkspaceId(relativePath),
    name: dynamicWorkspaceName(relativePath),
    path: resolvedPath,
    dynamic: true,
  };

  const existingById = workspaces.get(workspace.id) || dynamicWorkspaces.get(workspace.id);
  if (existingById) {
    if (existingById.path === workspace.path) return existingById;
    workspace.id = `${workspace.id}-${shortHash(relativePath)}`;
  }

  if (materialize) {
    dynamicWorkspaces.set(workspace.id, workspace);
  }
  return workspace;
}

function findDynamicWorkspaceById(id) {
  if (typeof id !== "string" || !id.startsWith("dir-")) return null;
  const stack = [workspaceBrowseRoot];
  let visited = 0;
  while (stack.length > 0 && visited < 5000) {
    const current = stack.pop();
    visited += 1;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = safeRealDirectory(path.join(current, entry.name));
      if (!entryPath || !pathBelongsToRoot(entryPath, workspaceBrowseRoot)) continue;
      const workspace = browseWorkspaceForPath(entryPath);
      if (workspace?.id === id) {
        dynamicWorkspaces.set(workspace.id, workspace);
        return workspace;
      }
      stack.push(entryPath);
    }
  }
  return null;
}

function dynamicWorkspaceId(relativePath) {
  const slug = relativePath
    .split(path.sep)
    .filter(Boolean)
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/--+/g, "-"),
    )
    .filter(Boolean)
    .join("-");
  return `dir-${slug || "workspace"}`.slice(0, 80);
}

function dynamicWorkspaceName(relativePath) {
  const segments = relativePath.split(path.sep).filter(Boolean);
  const first = segments[0];
  const firstPath = first ? path.join(workspaceBrowseRoot, first) : null;
  const firstWorkspace = firstPath ? [...workspaces.values()].find((workspace) => workspace.path === realpathOrResolve(firstPath)) : null;
  const displaySegments = segments.map((segment, index) => (index === 0 && firstWorkspace ? firstWorkspace.name : segment));
  return displaySegments.join(" / ");
}

function shortHash(value) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
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

function cleanOptionalEndpoint(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("AZURE_SPEECH_ENDPOINT must be a valid URL");
  }
  if (!["https:", "http:"].includes(url.protocol) || !url.host) {
    throw new Error("AZURE_SPEECH_ENDPOINT must include a supported protocol and host");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

function cleanOptionalSecret(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (/[\0\r\n]/.test(text)) {
    throw new Error("AZURE_SPEECH_API_KEY is invalid");
  }
  return text;
}

function cleanOptionalFilePath(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  if (/[\0\r\n]/.test(text)) {
    throw new Error("proxy client certificate path is invalid");
  }
  return path.resolve(text);
}

function cleanApiVersion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(text)) {
    throw new Error("AZURE_SPEECH_API_VERSION is invalid");
  }
  return text;
}

function cleanWorkspacePath(value, id) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) {
    throw new Error(`workspace ${id} path is invalid`);
  }
  return path.resolve(value);
}

function workspaceDirectoryResponse({ requestedPath = "", query = "" } = {}) {
  const currentPath = resolveBrowseDirectory(requestedPath || "");
  const relativePath = relativeBrowsePath(currentPath);
  const search = typeof query === "string" ? query.trim().toLowerCase() : "";
  const entries = workspaceDirectoryEntries(currentPath, search);
  const parent = currentPath === workspaceBrowseRoot ? null : path.dirname(currentPath);
  const selectedWorkspace = currentPath === workspaceBrowseRoot ? null : browseWorkspaceForPath(currentPath);

  return {
    rootPath: workspaceBrowseRoot,
    currentPath,
    relativePath,
    parentPath: parent && pathBelongsToRoot(parent, workspaceBrowseRoot) ? parent : null,
    selectedWorkspace: selectedWorkspace ? publicWorkspace(selectedWorkspace) : null,
    entries,
  };
}

function workspaceDirectoryEntries(currentPath, search) {
  const results = [];
  const stack = [{ dir: currentPath, depth: 0 }];
  const pathSearch = search.includes("/") || search.includes("\\");
  const normalizedPathSearch = search.replaceAll("\\", "/");

  while (stack.length > 0 && results.length < maxWorkspaceDirEntries) {
    const { dir, depth } = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((left, right) => right.name.localeCompare(left.name));
    for (const dirent of entries) {
      if (dirent.name.startsWith(".")) continue;
      const entryPath = safeRealDirectory(path.join(dir, dirent.name));
      if (!entryPath || !pathBelongsToRoot(entryPath, workspaceBrowseRoot)) continue;
      const relativePath = relativeBrowsePath(entryPath);
      const matches =
        !search ||
        dirent.name.toLowerCase().includes(search) ||
        (pathSearch && relativePath.toLowerCase().includes(normalizedPathSearch));
      if (matches) {
        const workspace = browseWorkspaceForPath(entryPath);
        results.push({
          name: dirent.name,
          path: entryPath,
          relativePath,
          workspaceId: workspace?.id || null,
          workspaceName: workspace?.name || null,
          hasGit: fs.existsSync(path.join(entryPath, ".git")),
          isRegistered: Boolean(workspace && workspaces.get(workspace.id)),
        });
        if (results.length >= maxWorkspaceDirEntries) break;
      }
      if (search && depth < 8) stack.push({ dir: entryPath, depth: depth + 1 });
    }
  }

  return results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function selectWorkspaceDirectory(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }
  const selectedPath = resolveBrowseDirectory(body.path || "");
  if (selectedPath === workspaceBrowseRoot) {
    throw Object.assign(new Error("workspace root cannot be selected"), { status: 400 });
  }
  const workspace = browseWorkspaceForPath(selectedPath, { materialize: true });
  if (!workspace) {
    throw Object.assign(new Error("selected path is not inside the workspace root"), { status: 400 });
  }
  return workspace;
}

function createWorkspaceDirectory(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw Object.assign(new Error("request body must be a JSON object"), { status: 400 });
  }

  const parentPath = resolveBrowseDirectory(body.parentPath || body.path || "");
  const name = cleanWorkspaceDirectoryName(body.name);
  const targetPath = path.resolve(parentPath, name);
  if (!pathBelongsToRoot(targetPath, workspaceBrowseRoot) || targetPath === workspaceBrowseRoot) {
    throw Object.assign(new Error("workspace path must stay inside the workspace root"), { status: 400 });
  }

  try {
    fs.mkdirSync(targetPath, { recursive: false, mode: 0o755 });
  } catch (error) {
    if (error.code === "EEXIST") {
      throw Object.assign(new Error("workspace folder already exists"), { status: 409 });
    }
    throw error;
  }

  const workspacePath = safeRealDirectory(targetPath);
  if (!workspacePath) {
    throw Object.assign(new Error("workspace folder could not be created"), { status: 500 });
  }
  return browseWorkspaceForPath(workspacePath, { materialize: true });
}

function cleanWorkspaceDirectoryName(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("workspace folder name is invalid"), { status: 400 });
  }
  const name = value.trim();
  if (
    name.length === 0 ||
    name.length > 80 ||
    name === "." ||
    name === ".." ||
    name.startsWith(".") ||
    /[\/\\\0\r\n]/.test(name) ||
    !/^[A-Za-z0-9][A-Za-z0-9._ -]*$/.test(name)
  ) {
    throw Object.assign(new Error("workspace folder name is invalid"), { status: 400 });
  }
  return name;
}

function resolveBrowseDirectory(value) {
  if (typeof value !== "string" || /[\0\r\n]/.test(value)) {
    throw Object.assign(new Error("workspace path is invalid"), { status: 400 });
  }
  const trimmed = value.trim();
  const candidate = trimmed
    ? path.resolve(path.isAbsolute(trimmed) ? trimmed : path.join(workspaceBrowseRoot, trimmed))
    : workspaceBrowseRoot;
  const resolved = safeRealDirectory(candidate);
  if (!resolved) {
    throw Object.assign(new Error("workspace directory was not found"), { status: 404 });
  }
  if (!pathBelongsToRoot(resolved, workspaceBrowseRoot)) {
    throw Object.assign(new Error("workspace path must stay inside the workspace root"), { status: 400 });
  }
  return resolved;
}

function safeRealDirectory(candidate) {
  let resolved;
  try {
    resolved = fs.realpathSync(candidate);
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) return null;
  } catch {
    return null;
  }
  return resolved;
}

function relativeBrowsePath(value) {
  const relativePath = path.relative(workspaceBrowseRoot, value);
  return relativePath ? relativePath.split(path.sep).join("/") : "";
}

function pathBelongsToRoot(candidate, root) {
  const resolvedCandidate = realpathOrResolve(candidate);
  const resolvedRoot = realpathOrResolve(root);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function loadPersistedJobs() {
  const files = fs.readdirSync(jobsDir).filter((file) => file.endsWith(".json")).sort();
  for (const file of files) {
    try {
      const job = JSON.parse(fs.readFileSync(path.join(jobsDir, file), "utf8"));
      if (!job || typeof job.id !== "string") continue;

      job.provider = normalizeJobProvider(job.provider);
      job.artifacts = sanitizePersistedArtifacts(job);
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
  job.artifacts = sanitizePersistedArtifacts(job);
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

function sendHtml(res, status, body) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendBytes(res, status, body, headers = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-length": body.length,
    ...headers,
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

function readBinaryBody(req, byteLimit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > byteLimit) {
        reject(Object.assign(new Error("audio body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length === 0) {
        reject(Object.assign(new Error("audio body is required"), { status: 400 }));
        return;
      }
      resolve(body);
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

  if (req.method === "GET" && url.pathname === "/v1/codex/ui") {
    return sendHtml(res, 200, codexThreadUiHtml());
  }

  if (shouldProxyCodexRequest(req, url)) {
    return proxyCodexRequest(req, url, res);
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/skills") {
    const provider = cleanProviderFilter(url.searchParams.get("provider")) || "codex";
    return sendJson(res, 200, { provider, skills: listProviderSkills(provider).map(publicSkill) });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/workspaces") {
    return sendJson(res, 200, {
      workspaces: workspaceList().map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
      })),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/workspace-dirs") {
    return sendJson(
      res,
      200,
      workspaceDirectoryResponse({
        requestedPath: url.searchParams.get("path"),
        query: url.searchParams.get("q"),
      }),
    );
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/workspaces/select") {
    const body = await readBody(req);
    return sendJson(res, 200, publicWorkspace(selectWorkspaceDirectory(body)));
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/workspaces/create") {
    const body = await readBody(req);
    return sendJson(res, 201, publicWorkspace(createWorkspaceDirectory(body)));
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/sessions") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanProviderFilter(url.searchParams.get("provider"));
    return sendJson(res, 200, { sessions: listWorkspaceSessions({ workspaceId, provider, limit }) });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/threads") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanProviderFilter(url.searchParams.get("provider"));
    return sendJson(res, 200, { threads: listWorkspaceThreads({ workspaceId, provider, limit }) });
  }

  const threadMatch = url.pathname.match(/^\/v1\/codex\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(threadMatch[1]);
    const provider = cleanProviderFilter(url.searchParams.get("provider"));
    if (!isSafeJobId(sessionId)) return sendError(res, 404, "thread not found");
    const detail = await threadDetailResponse(sessionId, { provider });
    if (!detail) return sendError(res, 404, "thread not found");
    return sendJson(res, 200, detail);
  }

  if (threadMatch && req.method === "DELETE") {
    const sessionId = decodeURIComponent(threadMatch[1]);
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanProviderFilter(url.searchParams.get("provider"));
    if (!isSafeJobId(sessionId)) return sendError(res, 404, "thread not found");
    const deleted = deleteThread(sessionId, { workspaceId, provider, certSubject: auth.subject });
    if (!deleted) return sendError(res, 404, "thread not found");
    return sendJson(res, 200, deleted);
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/transcriptions") {
    const audio = await readBinaryBody(req, maxTranscriptionAudioBytes);
    const transcript = await transcribeAudio({
      audio,
      contentType: cleanAudioContentType(req.headers["content-type"]),
      filename: cleanAudioFilename(req.headers["x-audio-filename"]),
      certSubject: auth.subject,
    });
    return sendJson(res, 200, transcript);
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/jobs") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanProviderFilter(url.searchParams.get("provider"));
    const selectedWorkspace = resolveOptionalWorkspaceFilter(workspaceId);
    const selectedJobs = [...jobs.values()]
      .filter((job) => !provider || normalizeJobProvider(job.provider) === provider)
      .filter((job) => !selectedWorkspace || workspaceForJob(job)?.id === selectedWorkspace.id)
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

  const artifactMatch = url.pathname.match(/^\/v1\/codex\/jobs\/([^/]+)\/artifacts\/([^/]+)\/(raw|preview)$/);
  if (artifactMatch && req.method === "GET") {
    const [, jobId, artifactId, mode] = artifactMatch;
    if (!isSafeJobId(jobId) || !isSafeArtifactId(artifactId)) return sendError(res, 404, "artifact not found");
    const job = jobs.get(jobId);
    if (!job) return sendError(res, 404, "artifact not found");
    return serveJobArtifact(res, job, artifactId, mode);
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

function isSafeArtifactId(id) {
  return /^artifact-[0-9]{3}$/.test(id);
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

function shouldProxyCodexRequest(req, url) {
  return Boolean(
    proxyBaseUrl &&
      ["GET", "POST"].includes(req.method || "") &&
      url.pathname.startsWith("/v1/codex/") &&
      url.pathname !== "/v1/codex/transcriptions",
  );
}

async function proxyCodexRequest(req, url, res) {
  const body = req.method === "GET" ? null : await readRawBody(req, maxBodyBytes);
  return new Promise((resolve, reject) => {
    const target = new URL(`${url.pathname}${url.search}`, proxyBaseUrl);
    const transport = target.protocol === "https:" ? https : http;
    const options = {
      method: req.method,
      headers: {
        accept: headerValue(req.headers.accept) || "application/json",
        "user-agent": "poc-vault-codex-thread-ui/1",
      },
    };
    const contentType = headerValue(req.headers["content-type"]);
    if (contentType) options.headers["content-type"] = contentType;
    if (body) options.headers["content-length"] = String(body.length);

    if (target.protocol === "https:") {
      if (proxyClientCertPath) options.cert = fs.readFileSync(proxyClientCertPath);
      if (proxyClientKeyPath) options.key = fs.readFileSync(proxyClientKeyPath);
    }

    const upstream = transport.request(target, options, (upstreamRes) => {
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const body = Buffer.concat(chunks);
        res.writeHead(upstreamRes.statusCode || 502, {
          "content-type": upstreamRes.headers["content-type"] || "application/json",
          "cache-control": "no-store",
          "content-length": body.length,
        });
        res.end(body);
        resolve();
      });
    });

    upstream.on("error", reject);
    upstream.end(body || undefined);
  });
}

function readRawBody(req, byteLimit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > byteLimit) {
        reject(Object.assign(new Error("request body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
  const workspace = resolveWorkspaceById(workspaceId);
  if (!workspace) {
    throw Object.assign(new Error("workspaceId is not registered"), { status: 400 });
  }

  const provider = cleanOptionalProvider(body.provider);
  const resumeSessionId = cleanOptionalSessionId(body.resumeSessionId);
  if (resumeSessionId) {
    const resumeMeta = findThreadResumeMeta(resumeSessionId);
    if (!resumeMeta) {
      throw Object.assign(new Error("session not found in runner CODEX_HOME"), { status: 400 });
    }
    if (resumeMeta.provider !== provider) {
      throw Object.assign(new Error("session provider does not match requested provider"), { status: 400 });
    }
    if (!resumeMetaBelongsToWorkspace(resumeMeta, workspace)) {
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
  const attachments = saveJobAttachments(id, body.attachments);
  const selectedSkills = cleanSelectedSkills(provider, body.skills);
  const codexPrompt = promptWithAttachments(promptWithSelectedSkills(body.prompt, provider, selectedSkills), attachments);
  const permissionMode = cleanOptionalClaudePermissionMode(body.permissionMode);
  pruneRuntimeCachesIfIdle();
  const job = {
    id,
    status: "queued",
    provider,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    workspacePath: workspace.path,
    prompt: body.prompt,
    codexPrompt,
    skills: selectedSkills.map((skill) => skill.id),
    attachments,
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
    artifacts: [],
    error: null,
    certSubject,
    timeoutMs,
    model: cleanProviderModel(provider, body.model),
    reasoningEffort: provider === "codex" ? cleanOptionalReasoningEffort(body.reasoningEffort) : null,
    permissionMode: provider === "claude" ? permissionMode : null,
    resumeSessionId,
    sessionId: resumeSessionId || (provider === "claude" ? crypto.randomUUID() : null),
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

function cleanOptionalAwsProfile(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,100}$/.test(value)) {
    throw Object.assign(new Error("AWS profile or region is invalid"), { status: 400 });
  }
  return value;
}

function cleanProviderModel(provider, value) {
  const model = cleanOptionalModel(value);
  if (provider !== "claude") return model;
  if (!model) return claudeDefaultModel;
  return normalizeClaudeModel(model);
}

function normalizeClaudeModel(model) {
  return claudeModelAliases[model] || model;
}

function cleanOptionalProvider(value) {
  if (value === undefined || value === null || value === "") return "codex";
  if (typeof value !== "string") {
    throw Object.assign(new Error("provider must be codex or claude"), { status: 400 });
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedJobProviders.has(normalized)) {
    throw Object.assign(new Error("provider must be codex or claude"), { status: 400 });
  }
  return normalized;
}

function cleanProviderFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  return cleanOptionalProvider(value);
}

function normalizeJobProvider(value) {
  return allowedJobProviders.has(value) ? value : "codex";
}

function listProviderSkills(provider) {
  const roots = skillRoots(provider);
  const skills = [];
  const seen = new Set();

  for (const root of roots) {
    for (const file of findSkillFiles(root, 0, 10, [])) {
      const skill = parseSkillFile(provider, root, file);
      if (!skill || seen.has(skill.id)) continue;
      seen.add(skill.id);
      skills.push(skill);
      if (skills.length >= maxSkillDiscoveryFiles) return sortSkills(skills);
    }
  }

  return sortSkills(skills);
}

function skillRoots(provider) {
  if (provider === "claude") {
    return uniqueExistingDirectories([
      ...splitPathList(process.env.CLAUDE_SKILL_DIRS),
      path.join(claudeHome, "skills"),
      path.join(claudeHome, "plugins", "cache"),
    ]);
  }

  return uniqueExistingDirectories([
    ...splitPathList(process.env.CODEX_SKILL_DIRS),
    path.join(codexHome, "skills"),
    path.join(codexHome, "plugins", "cache"),
    path.join(codexHome, "superpowers"),
    path.join(runHome, ".agents", "skills"),
  ]);
}

function uniqueExistingDirectories(entries) {
  const result = [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry) continue;
    const resolved = path.resolve(entry);
    if (seen.has(resolved)) continue;
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
    } catch {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function findSkillFiles(root, depth, maxDepth, files) {
  if (files.length >= maxSkillDiscoveryFiles || depth > maxDepth) return files;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (files.length >= maxSkillDiscoveryFiles) break;
    if (entry.isSymbolicLink()) continue;
    if (entry.name === "SKILL.md" && entry.isFile()) {
      files.push(path.join(root, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".cursor" || entry.name === ".windsurf") continue;
    findSkillFiles(path.join(root, entry.name), depth + 1, maxDepth, files);
  }
  return files;
}

function parseSkillFile(provider, root, file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const frontmatter = raw.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  const fields = frontmatter ? parseFrontmatter(frontmatter[1]) : {};
  const name = cleanSkillIdPart(cleanSkillMetadata(fields.name) || path.basename(path.dirname(file)));
  if (!name) return null;
  const description = cleanSkillMetadata(fields.description) || "";
  const plugin = pluginNameForSkill(root, file);
  const id = plugin ? `${plugin}:${name}` : name;
  return {
    id,
    name,
    title: titleize(name),
    provider,
    group: plugin ? titleize(plugin) : "Personal",
    description,
    file,
  };
}

function parseFrontmatter(value) {
  const fields = {};
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = unquoteYamlScalar(match[2]);
  }
  return fields;
}

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function cleanSkillMetadata(value) {
  if (typeof value !== "string") return "";
  return cleanApiText(value).replace(/\s+/g, " ").trim().slice(0, 1000);
}

function pluginNameForSkill(root, file) {
  if (path.basename(root) === "skills") return "";
  if (path.basename(root) === "superpowers") return "superpowers";

  const segments = file.split(path.sep).filter(Boolean);
  const cacheIndex = segments.lastIndexOf("cache");
  if (cacheIndex >= 0 && segments.length > cacheIndex + 2) {
    return cleanSkillIdPart(segments[cacheIndex + 2]);
  }

  const skillsIndex = segments.lastIndexOf("skills");
  if (skillsIndex > 0) {
    const parent = cleanSkillIdPart(segments[skillsIndex - 1]);
    const rootName = cleanSkillIdPart(path.basename(root));
    if (parent && rootName && parent !== rootName) return parent;
  }

  return "";
}

function cleanSkillIdPart(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function titleize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sortSkills(skills) {
  return skills.sort((left, right) => left.group.localeCompare(right.group) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id));
}

function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    title: skill.title,
    provider: skill.provider,
    group: skill.group,
    description: skill.description,
  };
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

function cleanOptionalClaudePermissionMode(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error("permissionMode is invalid"), { status: 400 });
  }
  const cleaned = value.trim();
  if (!allowedClaudePermissionModes.has(cleaned)) {
    throw Object.assign(new Error("permissionMode must be a supported Claude permission mode"), { status: 400 });
  }
  return cleaned;
}

function cleanSelectedSkills(provider, value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("skills must be an array of skill ids"), { status: 400 });
  }
  if (value.length > maxJobSkills) {
    throw Object.assign(new Error(`skills may include at most ${maxJobSkills} entries`), { status: 400 });
  }

  const available = new Map(listProviderSkills(provider).map((skill) => [skill.id, skill]));
  const selected = [];
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw Object.assign(new Error("skills must contain only skill ids"), { status: 400 });
    }
    const id = entry.trim();
    if (!/^[A-Za-z0-9:_-]{1,160}$/.test(id)) {
      throw Object.assign(new Error("skill id is invalid"), { status: 400 });
    }
    if (seen.has(id)) continue;
    const skill = available.get(id);
    if (!skill) {
      throw Object.assign(new Error(`skill is not available for ${provider}: ${id}`), { status: 400 });
    }
    seen.add(id);
    selected.push(skill);
  }
  return selected;
}

function saveJobAttachments(jobId, attachments) {
  if (attachments === undefined || attachments === null) return [];
  if (!Array.isArray(attachments)) {
    throw Object.assign(new Error("attachments must be an array"), { status: 400 });
  }
  if (attachments.length > maxJobAttachments) {
    throw Object.assign(new Error(`attachments may include at most ${maxJobAttachments} files`), { status: 413 });
  }

  const jobAttachmentDir = path.join(attachmentsDir, jobId);
  const saved = [];
  let totalBytes = 0;
  for (const [index, attachment] of attachments.entries()) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw Object.assign(new Error("each attachment must be an object"), { status: 400 });
    }

    const data = decodeAttachmentData(attachment.dataBase64);
    if (data.length === 0) {
      throw Object.assign(new Error("attachment data is required"), { status: 400 });
    }
    if (data.length > maxJobAttachmentBytes) {
      throw Object.assign(new Error("attachment is too large"), { status: 413 });
    }
    totalBytes += data.length;
    if (totalBytes > Math.min(maxJobAttachmentTotalBytes, maxBodyBytes)) {
      throw Object.assign(new Error("attachments are too large"), { status: 413 });
    }

    fs.mkdirSync(jobAttachmentDir, { recursive: true });
    const filename = cleanAttachmentFilename(attachment.filename, index);
    const filePath = path.join(jobAttachmentDir, `${String(index + 1).padStart(2, "0")}-${filename}`);
    fs.writeFileSync(filePath, data);
    saved.push({
      filename,
      contentType: cleanAttachmentContentType(attachment.contentType),
      bytes: data.length,
      path: filePath,
    });
  }
  return saved;
}

function decodeAttachmentData(value) {
  if (typeof value !== "string") {
    throw Object.assign(new Error("attachment dataBase64 is required"), { status: 400 });
  }
  const normalized = value.replace(/\s+/g, "");
  if (!normalized || !/^[A-Za-z0-9+/=_-]+$/.test(normalized)) {
    throw Object.assign(new Error("attachment dataBase64 is invalid"), { status: 400 });
  }
  return Buffer.from(normalized.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function cleanAttachmentFilename(value, index) {
  const raw = typeof value === "string" ? path.basename(value.trim()) : "";
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").slice(0, 120);
  if (cleaned && cleaned !== "." && cleaned !== "..") return cleaned;
  return `attachment-${index + 1}.bin`;
}

function cleanAttachmentContentType(value) {
  const raw = typeof value === "string" ? value.split(";")[0].trim().toLowerCase() : "";
  if (/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i.test(raw)) {
    return raw;
  }
  return "application/octet-stream";
}

function promptWithAttachments(prompt, attachments) {
  if (!attachments.length) return prompt;
  const manifest = attachments
    .map((attachment, index) => `${index + 1}. ${attachment.filename} (${attachment.contentType}, ${attachment.bytes} bytes): ${attachment.path}`)
    .join("\n");
  return `${prompt.trimEnd()}\n\nAttached files from the phone are saved on this runner. Use these local paths when inspecting them:\n${manifest}`;
}

function promptWithSelectedSkills(prompt, provider, skills) {
  if (!skills.length) return prompt;
  const label = provider === "claude" ? "Claude" : "Codex";
  const blocks = skills
    .map((skill) => {
      const body = boundedSkillBody(skill.file);
      return `## ${skill.id}\n\n${body}`;
    })
    .join("\n\n---\n\n");
  return `Selected ${label} skills are included below. Follow these SKILL.md instructions when they are relevant to the task.\n\n${blocks}\n\nUser task:\n${prompt}`;
}

function boundedSkillBody(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
  const cleaned = cleanApiText(text).trim();
  if (Buffer.byteLength(cleaned, "utf8") <= maxSkillPromptBytes) return cleaned;
  return `${prefixByBytes(cleaned, maxSkillPromptBytes).trimEnd()}\n\n[Skill truncated by server prompt budget.]`;
}

function extractJobArtifacts(job, answerText) {
  if (maxJobArtifacts <= 0 || !answerText) return [];
  const blocks = parseMarkdownCodeBlocks(answerText);
  if (!blocks.length) return [];

  const jobArtifactsDir = path.join(artifactsDir, job.id);
  const saved = [];
  let totalBytes = 0;

  for (const block of blocks) {
    if (saved.length >= maxJobArtifacts) break;
    const content = cleanArtifactContent(block.content);
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes === 0 || bytes > maxArtifactBytes || totalBytes + bytes > maxArtifactTotalBytes) continue;

    const ordinal = saved.length + 1;
    const parsed = parseFenceInfo(block.info);
    const filename = safeArtifactFilename(parsed.filename, parsed.language, ordinal);
    const language = parsed.language || languageForFilename(filename);
    const artifact = writeJobArtifact({
      job,
      ordinal,
      filename,
      language,
      content,
      kind: kindForArtifact(filename, language),
    });
    saved.push({ artifact, content });
    totalBytes += bytes;
  }

  const assembled = assembleStaticPreviewArtifact(job, saved, totalBytes);
  if (assembled) saved.push(assembled);

  if (!saved.length) {
    removeArtifactDirectory(jobArtifactsDir);
    return [];
  }

  return saved.map((entry) => entry.artifact);
}

function parseMarkdownCodeBlocks(text) {
  const blocks = [];
  const lines = String(text).split(/\r?\n/);
  let current = null;

  for (const line of lines) {
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (!fence) {
      if (current) current.lines.push(line);
      continue;
    }

    const marker = fence[1][0];
    if (!current) {
      current = { marker, length: fence[1].length, info: fence[2].trim(), lines: [] };
      continue;
    }

    if (marker === current.marker && fence[1].length >= current.length) {
      blocks.push({ info: current.info, content: current.lines.join("\n") });
      current = null;
    } else {
      current.lines.push(line);
    }
  }

  return blocks;
}

function parseFenceInfo(info) {
  const tokens = String(info || "").trim().split(/\s+/).filter(Boolean);
  let language = "";
  let filename = "";

  for (const token of tokens) {
    const keyValue = token.match(/^(?:file|filename|path|name)=([^=]+)$/i);
    if (keyValue && !filename) {
      filename = stripFenceQuotes(keyValue[1]);
      continue;
    }

    if (!language && looksLikeFilename(token)) {
      filename ||= stripFenceQuotes(token);
      language = languageForFilename(filename);
      continue;
    }

    if (!language) {
      language = cleanArtifactLanguage(token);
      continue;
    }

    if (!filename && looksLikeFilename(token)) {
      filename = stripFenceQuotes(token);
    }
  }

  return { language, filename };
}

function stripFenceQuotes(value) {
  const trimmed = String(value || "").trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function looksLikeFilename(value) {
  const raw = stripFenceQuotes(value);
  return /[./\\]/.test(raw) || /^[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+$/.test(raw);
}

function cleanArtifactLanguage(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9#+._-]/g, "")
    .slice(0, 40);
}

function cleanArtifactContent(value) {
  return cleanApiText(value || "").replace(/\s+$/, "");
}

function safeArtifactFilename(value, language, ordinal) {
  const fallback = `artifact-${String(ordinal).padStart(3, "0")}${extensionForLanguage(language)}`;
  const raw = stripFenceQuotes(value);
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) return fallback;
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.startsWith(".")) return fallback;
  if (hasBlockedArtifactFilename(cleaned)) return fallback;
  return path.extname(cleaned) ? cleaned : `${cleaned}${extensionForLanguage(language)}`;
}

function hasBlockedArtifactFilename(filename) {
  const lower = filename.toLowerCase();
  return [".env", ".pem", ".key", ".p12", ".crt", ".csr", ".mobileconfig"].some((suffix) => lower.endsWith(suffix));
}

function extensionForLanguage(language) {
  switch (cleanArtifactLanguage(language)) {
    case "html":
    case "htm":
      return ".html";
    case "css":
      return ".css";
    case "javascript":
    case "js":
    case "jsx":
      return ".js";
    case "typescript":
    case "ts":
      return ".ts";
    case "tsx":
      return ".tsx";
    case "json":
      return ".json";
    case "svg":
      return ".svg";
    case "markdown":
    case "md":
      return ".md";
    case "python":
    case "py":
      return ".py";
    case "swift":
      return ".swift";
    case "bash":
    case "sh":
    case "shell":
      return ".sh";
    case "text":
    case "txt":
      return ".txt";
    default:
      return ".txt";
  }
}

function languageForFilename(filename) {
  switch (path.extname(String(filename || "")).toLowerCase()) {
    case ".html":
    case ".htm":
      return "html";
    case ".css":
      return "css";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".jsx":
      return "jsx";
    case ".ts":
      return "ts";
    case ".tsx":
      return "tsx";
    case ".json":
      return "json";
    case ".svg":
      return "svg";
    case ".md":
    case ".markdown":
      return "markdown";
    case ".py":
      return "python";
    case ".swift":
      return "swift";
    case ".sh":
      return "bash";
    case ".txt":
      return "text";
    default:
      return "";
  }
}

function kindForArtifact(filename, language) {
  const normalized = cleanArtifactLanguage(language || languageForFilename(filename));
  if (["html", "htm", "svg"].includes(normalized)) return "staticPreview";
  if (["markdown", "md"].includes(normalized)) return "document";
  return "code";
}

function contentTypeForArtifact(filename, language) {
  const normalized = cleanArtifactLanguage(language || languageForFilename(filename));
  switch (normalized) {
    case "html":
    case "htm":
      return "text/html; charset=utf-8";
    case "css":
      return "text/css; charset=utf-8";
    case "javascript":
    case "js":
    case "jsx":
      return "text/javascript; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "svg":
      return "image/svg+xml; charset=utf-8";
    case "markdown":
    case "md":
      return "text/markdown; charset=utf-8";
    default:
      return "text/plain; charset=utf-8";
  }
}

function writeJobArtifact({ job, ordinal, filename, language, content, kind }) {
  const id = `artifact-${String(ordinal).padStart(3, "0")}`;
  const jobArtifactsDir = path.join(artifactsDir, job.id);
  fs.mkdirSync(jobArtifactsDir, { recursive: true });
  const filePath = path.join(jobArtifactsDir, `${id}-${filename}`);
  fs.writeFileSync(filePath, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  return {
    id,
    kind,
    filename,
    title: titleForArtifact(filename),
    language: language || null,
    contentType: contentTypeForArtifact(filename, language),
    bytes,
    path: filePath,
    rawURL: artifactRoute(job.id, id, "raw"),
    previewURL: isPreviewableArtifact(filename, language, kind) ? artifactRoute(job.id, id, "preview") : null,
  };
}

function titleForArtifact(filename) {
  return String(filename || "Artifact").replace(/[-_]+/g, " ");
}

function isPreviewableArtifact(filename, language, kind) {
  if (kind === "staticPreview") return true;
  const normalized = cleanArtifactLanguage(language || languageForFilename(filename));
  return ["markdown", "md"].includes(normalized);
}

function artifactRoute(jobId, artifactId, mode) {
  return `/v1/codex/jobs/${jobId}/artifacts/${artifactId}/${mode}`;
}

function assembleStaticPreviewArtifact(job, saved, totalBytes) {
  if (saved.length >= maxJobArtifacts) return null;
  const html = saved.find((entry) => ["html", "htm"].includes(cleanArtifactLanguage(entry.artifact.language || languageForFilename(entry.artifact.filename))));
  if (!html) return null;
  const cssBlocks = saved
    .filter((entry) => cleanArtifactLanguage(entry.artifact.language || languageForFilename(entry.artifact.filename)) === "css")
    .map((entry) => entry.content);
  const jsBlocks = saved
    .filter((entry) => ["js", "javascript"].includes(cleanArtifactLanguage(entry.artifact.language || languageForFilename(entry.artifact.filename))))
    .map((entry) => entry.content);
  if (!cssBlocks.length && !jsBlocks.length) return null;

  const content = assembleStaticHtml(html.content, cssBlocks, jsBlocks);
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > maxArtifactBytes || totalBytes + bytes > maxArtifactTotalBytes) return null;

  const ordinal = saved.length + 1;
  const artifact = writeJobArtifact({
    job,
    ordinal,
    filename: "preview.html",
    language: "html",
    content,
    kind: "staticPreview",
  });
  return { artifact, content };
}

function assembleStaticHtml(html, cssBlocks, jsBlocks) {
  let document = html.trim();
  if (!/<html[\s>]/i.test(document)) {
    document = `<!doctype html>\n<html>\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n${document}\n</body>\n</html>`;
  }

  const styles = cssBlocks.length ? `<style>\n${cssBlocks.join("\n\n")}\n</style>\n` : "";
  const scripts = jsBlocks.length ? `<script>\n${jsBlocks.join("\n\n")}\n</script>\n` : "";
  if (styles && /<\/head>/i.test(document)) {
    document = document.replace(/<\/head>/i, `${styles}</head>`);
  } else if (styles) {
    document = `${styles}${document}`;
  }
  if (scripts && /<\/body>/i.test(document)) {
    document = document.replace(/<\/body>/i, `${scripts}</body>`);
  } else if (scripts) {
    document = `${document}\n${scripts}`;
  }
  return document;
}

function cleanOptionalSessionId(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isSafeJobId(value)) {
    throw Object.assign(new Error("resumeSessionId is invalid"), { status: 400 });
  }
  return value;
}

async function transcribeAudio({ audio, contentType, filename, certSubject }) {
  if (!azureSpeechEndpoint || !azureSpeechApiKey) {
    throw Object.assign(new Error("Azure Speech is not configured for transcription"), { status: 503 });
  }

  const definition = {
    locales: azureSpeechLocales.length > 0 ? azureSpeechLocales : ["en"],
    enhancedMode: {
      enabled: true,
      model: azureSpeechModel,
    },
  };
  const form = multipartFormData([
    {
      name: "audio",
      filename,
      contentType,
      value: audio,
    },
    {
      name: "definition",
      value: Buffer.from(JSON.stringify(definition), "utf8"),
    },
  ]);
  const endpoint = `${azureSpeechEndpoint}/speechtotext/transcriptions:transcribe?api-version=${encodeURIComponent(azureSpeechApiVersion)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": form.contentType,
      "content-length": String(form.body.length),
      "ocp-apim-subscription-key": azureSpeechApiKey,
    },
    body: form.body,
  });
  const responseText = await response.text();
  let payload = null;
  if (responseText.trim()) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    throw Object.assign(new Error(`Azure Speech failed with HTTP ${response.status}: ${azureSpeechErrorMessage(payload, responseText)}`), {
      status: 502,
    });
  }

  const text = azureTranscriptText(payload);
  appendAudit(
    "transcription_created",
    { id: null, status: "succeeded", workspaceId: null, certSubject },
    { provider: "azure-speech", model: azureSpeechModel, audioBytes: audio.length },
  );
  return {
    text,
    provider: "azure-speech",
    model: azureSpeechModel,
    audioBytes: audio.length,
    durationMilliseconds: Number.isFinite(payload?.durationMilliseconds) ? payload.durationMilliseconds : null,
  };
}

function multipartFormData(parts) {
  const boundary = `----codex-${crypto.randomUUID()}`;
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, "utf8"));
    const disposition = [`form-data`, `name="${escapeMultipartValue(part.name)}"`];
    if (part.filename) disposition.push(`filename="${escapeMultipartValue(part.filename)}"`);
    chunks.push(Buffer.from(`content-disposition: ${disposition.join("; ")}\r\n`, "utf8"));
    if (part.contentType) {
      chunks.push(Buffer.from(`content-type: ${part.contentType}\r\n`, "utf8"));
    }
    chunks.push(Buffer.from("\r\n", "utf8"));
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(String(part.value), "utf8"));
    chunks.push(Buffer.from("\r\n", "utf8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf8"));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function escapeMultipartValue(value) {
  return String(value).replace(/["\r\n]/g, "_");
}

function cleanAudioContentType(value) {
  const raw = headerValue(value).split(";")[0].trim().toLowerCase();
  const allowed = new Set([
    "audio/wav",
    "audio/x-wav",
    "audio/wave",
    "audio/mpeg",
    "audio/mp4",
    "audio/m4a",
    "audio/flac",
    "audio/webm",
    "audio/aac",
    "audio/ogg",
    "application/octet-stream",
  ]);
  return allowed.has(raw) ? raw : "audio/wav";
}

function cleanAudioFilename(value) {
  const raw = path.basename(headerValue(value).trim());
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  return cleaned && /\.[A-Za-z0-9]{2,8}$/.test(cleaned) ? cleaned : "phone-prompt.wav";
}

function azureTranscriptText(payload) {
  const combinedText = Array.isArray(payload?.combinedPhrases)
    ? payload.combinedPhrases
        .map((phrase) => cleanApiText(phrase?.text || "").trim())
        .filter(Boolean)
        .join("\n")
        .trim()
    : "";
  if (combinedText) return combinedText;

  const phraseText = Array.isArray(payload?.phrases)
    ? payload.phrases
        .map((phrase) => cleanApiText(phrase?.text || "").trim())
        .filter(Boolean)
        .join(" ")
        .trim()
    : "";
  if (phraseText) return phraseText;

  throw Object.assign(new Error("Azure Speech returned no transcript"), { status: 502 });
}

function azureSpeechErrorMessage(payload, fallback) {
  const message =
    payload?.error?.message ||
    payload?.message ||
    payload?.innerError?.message ||
    cleanApiText(fallback || "").trim();
  return message || "transcription request failed";
}

function findSessionMeta(sessionId) {
  const sessionsDir = path.join(codexHome, "sessions");
  const sessionFile = findSessionFile(sessionsDir, sessionId);
  if (!sessionFile) return null;
  return readSessionMeta(sessionFile, sessionId);
}

function findThreadResumeMeta(sessionId) {
  const relatedJobs = [...jobs.values()]
    .filter((job) => jobThreadId(job) === sessionId)
    .sort((left, right) => compareIsoDesc(left.updatedAt || left.createdAt, right.updatedAt || right.createdAt));
  if (relatedJobs.length > 0) {
    const latest = relatedJobs[0];
    return {
      provider: normalizeJobProvider(latest.provider),
      workspaceId: latest.workspaceId || null,
      workspacePath: latest.workspacePath || null,
      cwd: null,
    };
  }

  const sessionMeta = findSessionMeta(sessionId);
  if (!sessionMeta) return null;
  return {
    provider: normalizeJobProvider(sessionMeta.provider),
    workspaceId: null,
    workspacePath: null,
    cwd: sessionMeta.cwd,
  };
}

function resumeMetaBelongsToWorkspace(meta, workspace) {
  const metaWorkspace = workspaceForPath(meta.workspacePath || meta.cwd);
  if (metaWorkspace) return metaWorkspace.id === workspace.id;
  if (meta.workspaceId) return meta.workspaceId === workspace.id;
  return false;
}

function workspaceForJob(job) {
  return workspaceForPath(job?.workspacePath) || resolveWorkspaceById(job?.workspaceId);
}

function workspaceForPath(value) {
  if (typeof value !== "string" || value.length === 0 || /[\0\r\n]/.test(value)) return null;
  const resolvedPath = realpathOrResolve(value);
  if (pathBelongsToRoot(resolvedPath, workspaceBrowseRoot) && resolvedPath !== workspaceBrowseRoot) {
    return browseWorkspaceForPath(resolvedPath, { materialize: true });
  }
  let best = null;
  for (const workspace of workspaces.values()) {
    if (!sessionBelongsToWorkspace(resolvedPath, workspace.path)) continue;
    if (!best || workspace.path.length > best.path.length) best = workspace;
  }
  for (const workspace of dynamicWorkspaces.values()) {
    if (!sessionBelongsToWorkspace(resolvedPath, workspace.path)) continue;
    if (!best || workspace.path.length > best.path.length) best = workspace;
  }
  return best;
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
          return {
            id,
            cwd,
            provider: normalizeJobProvider(entry.payload.provider),
            timestamp: cleanSessionTimestamp(entry.payload.timestamp || entry.timestamp),
          };
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

function listWorkspaceSessions({ workspaceId, provider = null, limit, includeSummary = false }) {
  const selectedWorkspace = resolveOptionalWorkspaceFilter(workspaceId);

  const sessionMap = new Map();
  for (const file of walkSessionFiles(path.join(codexHome, "sessions"))) {
    const meta = readSessionMeta(file);
    if (!meta) continue;
    const workspace = workspaceForSessionCwd(meta.cwd);
    if (!workspace) continue;
    const sessionProvider = normalizeJobProvider(meta.provider);
    if (provider && sessionProvider !== provider) continue;
    if (selectedWorkspace && workspace.id !== selectedWorkspace.id) continue;
    const stat = fs.statSync(file);
    const session = {
      id: meta.id,
      provider: sessionProvider,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: meta.cwd,
      timestamp: meta.timestamp,
      updatedAt: stat.mtime.toISOString(),
    };
    if (includeSummary) {
      session.summary = readSessionSummary(file);
    }
    sessionMap.set(session.id, session);
  }

  for (const job of jobs.values()) {
    const sessionId = jobThreadId(job);
    if (!sessionId) continue;
    const jobProvider = normalizeJobProvider(job.provider);
    if (provider && jobProvider !== provider) continue;
    const workspace = workspaceForJob(job);
    if (!workspace) continue;
    if (selectedWorkspace && workspace.id !== selectedWorkspace.id) continue;

    const existing = sessionMap.get(sessionId);
    if (existing) {
      if (existing.provider !== jobProvider) continue;
      existing.updatedAt = maxIso(existing.updatedAt, job.updatedAt || job.createdAt);
      continue;
    }

    sessionMap.set(sessionId, {
      id: sessionId,
      provider: jobProvider,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: null,
      timestamp: null,
      updatedAt: job.updatedAt || job.createdAt || null,
    });
  }

  return [...sessionMap.values()]
    .sort((left, right) => Date.parse(right.updatedAt || 0) - Date.parse(left.updatedAt || 0))
    .slice(0, limit);
}

function listWorkspaceThreads({ workspaceId, provider = null, limit }) {
  const selectedWorkspace = resolveOptionalWorkspaceFilter(workspaceId);

  const threadMap = new Map();
  for (const session of listWorkspaceSessions({ workspaceId, provider, limit: 200, includeSummary: true })) {
    threadMap.set(session.id, {
      ...session,
      sessionId: session.id,
      provider: session.provider,
      hasSessionFile: true,
      jobs: [],
    });
  }

  for (const job of jobs.values()) {
    const sessionId = jobThreadId(job);
    if (!sessionId) continue;
    const jobProvider = normalizeJobProvider(job.provider);
    if (provider && jobProvider !== provider) continue;

    const workspace = workspaceForJob(job);
    if (!workspace) continue;
    if (selectedWorkspace && selectedWorkspace.id !== workspace.id) continue;

    let thread = threadMap.get(sessionId);
    if (thread && thread.provider !== jobProvider) continue;
    if (!thread) {
      thread = {
        id: sessionId,
        sessionId,
        provider: jobProvider,
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

function resolveOptionalWorkspaceFilter(workspaceId) {
  if (!workspaceId) return null;
  const cleanId = cleanWorkspaceId(workspaceId);
  const workspace = resolveWorkspaceById(cleanId);
  if (!workspace) {
    throw Object.assign(new Error("workspaceId is not registered"), { status: 400 });
  }
  return workspace;
}

async function threadDetailResponse(sessionId, { provider = null } = {}) {
  const sessionsDir = path.join(codexHome, "sessions");
  const sessionFile = findSessionFile(sessionsDir, sessionId);
  let thread = null;
  let messages = [];

  if (sessionFile) {
    const meta = readSessionMeta(sessionFile, sessionId);
    const workspace = meta ? workspaceForSessionCwd(meta.cwd) : null;
    const sessionProvider = meta ? normalizeJobProvider(meta.provider) : "codex";
    if (workspace && (!provider || sessionProvider === provider)) {
      const stat = fs.statSync(sessionFile);
      thread = {
        id: meta.id,
        sessionId: meta.id,
        provider: sessionProvider,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        updatedAt: stat.mtime.toISOString(),
        hasSessionFile: true,
        summary: readSessionSummary(sessionFile),
        jobs: [],
      };
      messages = readSessionMessages(sessionFile);
    }
  }

  for (const job of jobs.values()) {
    if (jobThreadId(job) !== sessionId) continue;
    const jobProvider = normalizeJobProvider(job.provider);
    if (provider && jobProvider !== provider) continue;
    const workspace = workspaceForJob(job);
    if (!workspace) continue;

    if (thread && thread.provider !== jobProvider) continue;
    if (!thread) {
      thread = {
        id: sessionId,
        sessionId,
        provider: jobProvider,
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        cwd: null,
        timestamp: null,
        updatedAt: job.updatedAt || job.createdAt || null,
        hasSessionFile: false,
        jobs: [],
      };
    }

    thread.jobs.push(job);
    thread.updatedAt = maxIso(thread.updatedAt, job.updatedAt || job.createdAt);
  }

  if (!thread) return null;

  const sortedJobs = [...thread.jobs].sort((left, right) =>
    compareIsoDesc(left.updatedAt || left.createdAt, right.updatedAt || right.createdAt),
  );

  return {
    thread: threadSummary(thread),
    messages,
    jobs: await Promise.all(sortedJobs.map((job) => toJobResponse(job, responseShape("compact")))),
  };
}

function deleteThread(sessionId, { workspaceId = null, provider = null, certSubject = null } = {}) {
  const selectedWorkspace = resolveOptionalWorkspaceFilter(workspaceId);
  const sessionsDir = path.join(codexHome, "sessions");
  const sessionFile = findSessionFile(sessionsDir, sessionId);
  const sessionMeta = sessionFile ? readSessionMeta(sessionFile, sessionId) : null;
  const sessionProvider = sessionMeta ? normalizeJobProvider(sessionMeta.provider) : null;
  const sessionWorkspace = sessionMeta ? workspaceForSessionCwd(sessionMeta.cwd) : null;
  const sessionMatches =
    Boolean(sessionFile && sessionMeta && sessionWorkspace) &&
    (!provider || sessionProvider === provider) &&
    (!selectedWorkspace || sessionWorkspace.id === selectedWorkspace.id);

  const matchedJobs = [...jobs.values()].filter((job) => {
    if (jobThreadId(job) !== sessionId) return false;
    const jobProvider = normalizeJobProvider(job.provider);
    if (provider && jobProvider !== provider) return false;
    const workspace = workspaceForJob(job);
    if (!workspace) return false;
    if (selectedWorkspace && workspace.id !== selectedWorkspace.id) return false;
    return true;
  });

  if (!sessionMatches && matchedJobs.length === 0) return null;
  const activeJob = matchedJobs.find((job) => !terminalStatuses.has(job.status));
  if (activeJob) {
    throw Object.assign(new Error("thread has active jobs"), { status: 409 });
  }

  for (const job of matchedJobs) {
    queuedJobIds = queuedJobIds.filter((id) => id !== job.id);
    activeChildren.delete(job.id);
    jobs.delete(job.id);
    removePersistedJobFiles(job);
  }

  const deletedSessionFile = sessionMatches ? removePathInsideRoot(sessionFile, sessionsDir) : false;
  const workspaceForAudit = selectedWorkspace || sessionWorkspace || workspaceForJob(matchedJobs[0]);
  appendAudit(
    "thread_deleted",
    {
      id: sessionId,
      status: "deleted",
      workspaceId: workspaceForAudit?.id || null,
      certSubject,
    },
    {
      provider,
      deletedJobs: matchedJobs.length,
      deletedSessionFile,
    },
  );

  return {
    deleted: true,
    threadId: sessionId,
    workspaceId: workspaceForAudit?.id || null,
    deletedJobs: matchedJobs.length,
    deletedSessionFile,
  };
}

function removePersistedJobFiles(job) {
  const paths = [
    jobPath(job.id),
    job.stdoutPath,
    job.stderrPath,
    job.resultPath,
    path.join(attachmentsDir, job.id),
    path.join(artifactsDir, job.id),
  ];
  for (const attachment of Array.isArray(job.attachments) ? job.attachments : []) {
    paths.push(attachment?.path);
  }
  for (const artifact of Array.isArray(job.artifacts) ? job.artifacts : []) {
    paths.push(artifact?.path);
  }

  for (const target of paths) {
    removePathInsideRoot(target, dataDir);
  }
}

function removePathInsideRoot(target, rootDir) {
  if (typeof target !== "string" || !target || /[\0\r\n]/.test(target)) return false;
  const root = realpathOrResolve(rootDir);
  const resolvedTarget = realpathOrResolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  try {
    fs.rmSync(resolvedTarget, { recursive: true, force: true });
    return true;
  } catch (error) {
    appendAudit("remove_path_failed", null, {
      target: relative,
      error: error.message || String(error),
    });
    return false;
  }
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
    provider: normalizeJobProvider(thread.provider),
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
      const text = messageText(message);
      if (message.role === "user" && !firstUserPrompt) {
        firstUserPrompt = userPromptSummary(text);
      } else if (message.role === "assistant") {
        lastAssistantAnswer = boundedThreadText(text);
      }
    } catch {
      continue;
    }
  }

  return { firstUserPrompt, lastAssistantAnswer };
}

function readSessionMessages(sessionFile) {
  const messages = [];
  for (const line of readSessionLines(sessionFile)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type !== "response_item") continue;
      const message = entry.payload;
      if (message?.type !== "message") continue;
      if (!["user", "assistant"].includes(message.role)) continue;

      const rawText = messageText(message);
      const text = message.role === "user" ? userPromptSummary(rawText) : boundedThreadText(rawText);
      if (!text) continue;

      messages.push({
        role: message.role,
        timestamp: cleanSessionTimestamp(entry.timestamp),
        text,
      });
    } catch {
      continue;
    }
  }
  return messages.slice(-120);
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

function userPromptSummary(value) {
  const text = normalizedThreadText(value);
  if (!text || isInjectedContextMessage(text)) return null;
  return boundedThreadText(stripSkillInstructionPrefix(text));
}

function isInjectedContextMessage(text) {
  const head = text.slice(0, 1000).toLowerCase();
  return (
    head.startsWith("# agents.md instructions for ") ||
    head.startsWith("<environment_context>") ||
    (head.includes("<instructions>") && head.includes("<environment_context>"))
  );
}

function stripSkillInstructionPrefix(text) {
  return text
    .replace(/^Use these (Codex|Claude) skills for this task: [^.]+[.]\s*/i, "")
    .replace(
      /^Selected (Codex|Claude) skills are included below[.]\s*Follow these SKILL[.]md instructions when they are relevant to the task[.]\s+[\s\S]*?\s+User task:\s*/i,
      "",
    );
}

function boundedThreadText(value) {
  const text = normalizedThreadText(value);
  if (!text) return null;
  if (text.length <= threadSummaryCharacters) return text;
  return `${text.slice(0, threadSummaryCharacters - 1).trimEnd()}…`;
}

function normalizedThreadText(value) {
  return cleanApiText(value || "")
    .replace(/\s+/g, " ")
    .trim();
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
  return workspaceForPath(sessionCwd);
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

  const args = buildJobArgs(job);
  const childEnv = buildJobEnv(job);
  const child = spawn(job.provider === "claude" ? claudeBin : codexBin, args, {
    cwd: job.workspacePath,
    env: childEnv,
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
    sessionIdsBefore: job.provider === "codex" && !job.resumeSessionId ? workspaceSessionIdSet(job.workspacePath) : null,
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

  child.stdin.end(job.codexPrompt || job.prompt);
}

function buildJobArgs(job) {
  return job.provider === "claude" ? buildClaudeArgs(job) : buildCodexArgs(job);
}

function buildJobEnv(job) {
  const env = {
    ...process.env,
    HOME: runHome,
    CODEX_HOME: codexHome,
    NPM_CONFIG_CACHE: npmCacheDir,
    npm_config_cache: npmCacheDir,
    NPM_CONFIG_LOGLEVEL: process.env.NPM_CONFIG_LOGLEVEL || "error",
    npm_config_loglevel: process.env.npm_config_loglevel || "error",
    NPM_CONFIG_PROGRESS: process.env.NPM_CONFIG_PROGRESS || "false",
    npm_config_progress: process.env.npm_config_progress || "false",
    NPM_CONFIG_UPDATE_NOTIFIER: process.env.NPM_CONFIG_UPDATE_NOTIFIER || "false",
    npm_config_update_notifier: process.env.npm_config_update_notifier || "false",
    BUN_INSTALL_CACHE_DIR: bunCacheDir,
    PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  };

  if (job.provider === "claude" && claudeAwsProfile) {
    env.AWS_PROFILE = claudeAwsProfile;
    env.AWS_SDK_LOAD_CONFIG = process.env.AWS_SDK_LOAD_CONFIG || "1";
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    if (claudeAwsRegion) {
      env.AWS_REGION = claudeAwsRegion;
      env.AWS_DEFAULT_REGION = claudeAwsRegion;
    } else {
      delete env.AWS_REGION;
      delete env.AWS_DEFAULT_REGION;
    }
  }

  return env;
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

function buildClaudeArgs(job) {
  const args = ["--print"];
  if (dangerousMode) args.push("--dangerously-skip-permissions");
  if (job.model) args.push("--model", job.model);
  if (job.permissionMode) args.push("--permission-mode", job.permissionMode);
  if (job.resumeSessionId) {
    args.push("--resume", job.resumeSessionId);
  } else {
    args.push("--session-id", job.sessionId);
  }
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
  const resultText =
    job.provider === "claude"
      ? await readTextFileBounded(job.stdoutPath, maxOutputBytes)
      : await readTextFileBounded(job.resultPath, maxOutputBytes);
  const cleanResult = cleanAssistantResult(resultText).trim();
  const failedOutputText = job.provider === "claude" ? cleanResult : "";

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
    try {
      job.artifacts = extractJobArtifacts(job, cleanResult);
    } catch (error) {
      job.artifacts = [];
      appendAudit("artifact_extraction_failed", job, { error: error.message || String(error) });
    }
  } else {
    job.status = "failed";
    job.result = null;
    job.artifacts = [];
    job.error =
      stderrText ||
      failedOutputText ||
      `${job.provider === "claude" ? "claude" : "codex"} exited with code ${code}${signal ? ` and signal ${signal}` : ""}`;
  }

  persistJob(job);
  appendAudit("job_finished", job, { code, signal });
  pruneRuntimeCachesIfIdle();
  scheduleRuntimeCachePrune();
  processQueue();
}

function scheduleRuntimeCachePrune() {
  for (const delayMs of [5000, 30000]) {
    const timer = setTimeout(pruneRuntimeCachesIfIdle, delayMs);
    timer.unref();
  }
}

function pruneRuntimeCachesIfIdle() {
  if (activeChildren.size > 0) return;
  pruneRuntimeCaches();
}

function pruneRuntimeCaches() {
  for (const target of runtimeCacheTargets()) {
    removePathInsideRunHome(target);
  }
}

function runtimeCacheTargets() {
  return [
    path.join(runHome, ".npm", "_cacache"),
    path.join(runHome, ".npm", "_npx"),
    path.join(runHome, ".npm", "_logs"),
    path.join(runHome, ".bun", "install", "cache"),
    npmCacheDir,
    bunCacheDir,
    path.join(codexHome, ".tmp"),
  ];
}

function removePathInsideRunHome(target) {
  const relative = path.relative(runHome, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    appendAudit("runtime_cache_prune_failed", null, {
      target: relative,
      error: error.message || String(error),
    });
  }
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
  const workspace = workspaceForPath(workspacePath);
  return walkSessionFiles(path.join(codexHome, "sessions"))
    .map((file) => {
      const meta = readSessionMeta(file);
      if (!meta || !sessionBelongsToWorkspace(meta.cwd, workspacePath)) return null;
      if (workspace && workspaceForSessionCwd(meta.cwd)?.id !== workspace.id) return null;
      return { id: meta.id, cwd: meta.cwd };
    })
    .filter(Boolean);
}

async function toJobResponse(job, shape = responseShape("preview")) {
  const workspace = workspaceForJob(job);
  const [stdout, stderr, result] = await Promise.all([
    shapeTextPayload({
      file: job.stdoutPath || path.join(logsDir, `${job.id}.stdout.log`),
      value: "",
      byteLimit: shape.byteLimit,
      includeFull: shape.includeFullLogs,
      slice: "suffix",
    }),
    shapeTextPayload({
      file: job.stderrPath || path.join(logsDir, `${job.id}.stderr.log`),
      value: "",
      byteLimit: shape.byteLimit,
      includeFull: shape.includeFullLogs,
      slice: "suffix",
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
    provider: normalizeJobProvider(job.provider),
    workspaceId: workspace?.id || job.workspaceId,
    workspaceName: workspace?.name || job.workspaceName,
    prompt: job.prompt,
    attachments: sanitizeAttachmentResponses(job.attachments),
    artifacts: publicArtifactResponses(job),
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
    permissionMode: job.permissionMode || null,
    skills: Array.isArray(job.skills) ? job.skills : [],
    resumeSessionId: job.resumeSessionId || null,
    sessionId: job.sessionId || job.resumeSessionId || null,
  };
}

function sanitizeAttachmentResponses(attachments) {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .filter((attachment) => attachment && typeof attachment === "object")
    .map((attachment) => ({
      filename: cleanApiText(attachment.filename || "attachment"),
      contentType: cleanApiText(attachment.contentType || "application/octet-stream"),
      bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : null,
      path: cleanApiText(attachment.path || ""),
    }));
}

function sanitizePersistedArtifacts(job) {
  if (!Array.isArray(job?.artifacts)) return [];
  return job.artifacts
    .filter((artifact) => artifact && typeof artifact === "object")
    .map((artifact) => {
      const id = isSafeArtifactId(artifact.id) ? artifact.id : "";
      const filename = safeArtifactFilename(artifact.filename, artifact.language, Number(id.slice(-3)) || 1);
      const language = cleanArtifactLanguage(artifact.language || languageForFilename(filename));
      const kind = ["code", "staticPreview", "document"].includes(artifact.kind) ? artifact.kind : kindForArtifact(filename, language);
      const filePath = cleanOptionalFilePath(artifact.path);
      if (!id || !filePath || !artifactPathBelongsToJob(job.id, filePath)) return null;
      const bytes = Number.isFinite(artifact.bytes) && artifact.bytes >= 0 ? artifact.bytes : 0;
      return {
        id,
        kind,
        filename,
        title: cleanDisplayName(artifact.title || titleForArtifact(filename), "artifact title", 120),
        language: language || null,
        contentType: contentTypeForArtifact(filename, language),
        bytes,
        path: filePath,
        rawURL: artifactRoute(job.id, id, "raw"),
        previewURL: isPreviewableArtifact(filename, language, kind) ? artifactRoute(job.id, id, "preview") : null,
      };
    })
    .filter(Boolean);
}

function publicArtifactResponses(job) {
  return sanitizePersistedArtifacts(job).map((artifact) => ({
    id: artifact.id,
    kind: artifact.kind,
    filename: artifact.filename,
    title: artifact.title,
    language: artifact.language,
    contentType: artifact.contentType,
    bytes: artifact.bytes,
    rawURL: artifact.rawURL,
    previewURL: artifact.previewURL,
  }));
}

function artifactPathBelongsToJob(jobId, filePath) {
  const root = path.resolve(path.join(artifactsDir, jobId));
  const resolved = path.resolve(filePath);
  const relative = path.relative(root, resolved);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function serveJobArtifact(res, job, artifactId, mode) {
  const artifact = sanitizePersistedArtifacts(job).find((entry) => entry.id === artifactId);
  if (!artifact || !artifact.path || !artifactPathBelongsToJob(job.id, artifact.path)) {
    return sendError(res, 404, "artifact not found");
  }

  let body;
  try {
    body = fs.readFileSync(artifact.path);
  } catch {
    return sendError(res, 404, "artifact not found");
  }

  if (mode === "raw") {
    return sendBytes(res, 200, body, {
      "content-type": artifact.contentType || "application/octet-stream",
      "content-disposition": `attachment; filename="${contentDispositionFilename(artifact.filename)}"`,
      "x-content-type-options": "nosniff",
    });
  }

  if (!artifact.previewURL) return sendError(res, 404, "artifact preview not available");
  return sendHtml(res, 200, artifactPreviewWrapper(artifact, body.toString("utf8")));
}

function contentDispositionFilename(filename) {
  return String(filename || "artifact.txt").replace(/["\r\n\\]/g, "-");
}

function artifactPreviewWrapper(artifact, rawContent) {
  const srcdoc = previewSrcdoc(artifact, rawContent);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(artifact.title || artifact.filename)}</title>
  <style>
    html, body { height: 100%; margin: 0; background: #101113; color: #f5f5f0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; border-bottom: 1px solid rgba(255,255,255,.12); background: #17181b; }
    strong { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    span { color: rgba(245,245,240,.62); font-size: 12px; }
    iframe { width: 100%; height: calc(100% - 42px); border: 0; background: white; display: block; }
  </style>
</head>
<body data-codex-artifact-preview="true">
  <header><strong>${escapeHtml(artifact.filename)}</strong><span>${escapeHtml(artifact.kind)}</span></header>
  <iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtmlAttribute(srcdoc)}"></iframe>
</body>
</html>`;
}

function previewSrcdoc(artifact, rawContent) {
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src data:;">`;
  const language = cleanArtifactLanguage(artifact.language || languageForFilename(artifact.filename));
  if (language === "markdown" || language === "md") {
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.5;margin:24px;color:#202124}pre{white-space:pre-wrap;word-break:break-word}</style></head><body><pre>${escapeHtml(rawContent)}</pre></body></html>`;
  }
  if (language === "svg") {
    return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#fff}</style></head><body>${rawContent}</body></html>`;
  }
  if (language === "html" || language === "htm") {
    return injectPreviewCsp(rawContent, csp);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}<style>body{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;margin:20px;white-space:pre-wrap;color:#202124}</style></head><body>${escapeHtml(rawContent)}</body></html>`;
}

function injectPreviewCsp(html, csp) {
  if (/<head[\s>]/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${csp}`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${csp}</head><body>${html}</body></html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function removeArtifactDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true });
  } catch {
    // Best effort cleanup only.
  }
}

async function shapeTextPayload({ file, value, byteLimit, includeFull, trim = false, slice = "prefix" }) {
  try {
    const stat = await fsp.stat(file);
    if (stat.size > 0 || !value) {
      return await shapeTextFile(file, stat.size, byteLimit, includeFull, trim, slice);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  return shapeTextValue(value, byteLimit, includeFull, trim, slice);
}

async function shapeTextFile(file, byteCount, byteLimit, includeFull, trim, slice) {
  const raw = includeFull ? await fsp.readFile(file, "utf8") : await readTextFileSlice(file, byteCount, byteLimit, slice);
  const text = cleanPayloadText(raw, trim);
  const preview = includeFull ? cleanPayloadText(sliceByBytes(raw, byteLimit, slice), trim) : text;
  return {
    text,
    preview,
    bytes: byteCount,
    truncated: !includeFull && byteCount > byteLimit,
  };
}

function shapeTextValue(value, byteLimit, includeFull, trim, slice) {
  const raw = value ? String(value) : "";
  const byteCount = Buffer.byteLength(raw, "utf8");
  const text = cleanPayloadText(includeFull ? raw : sliceByBytes(raw, byteLimit, slice), trim);
  return {
    text,
    preview: cleanPayloadText(sliceByBytes(raw, byteLimit, slice), trim),
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

async function readTextFileSuffix(file, byteCount, byteLimit) {
  const handle = await fsp.open(file, "r");
  try {
    const length = Math.min(byteCount, byteLimit);
    const offset = Math.max(0, byteCount - length);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function readTextFileSlice(file, byteCount, byteLimit, slice) {
  if (slice === "suffix") {
    return readTextFileSuffix(file, byteCount, byteLimit);
  }
  return readTextFilePrefix(file, byteLimit);
}

function prefixByBytes(value, byteLimit) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(0, Math.min(buffer.length, byteLimit)).toString("utf8");
}

function suffixByBytes(value, byteLimit) {
  const buffer = Buffer.from(value, "utf8");
  return buffer.subarray(Math.max(0, buffer.length - byteLimit)).toString("utf8");
}

function sliceByBytes(value, byteLimit, slice) {
  if (slice === "suffix") {
    return suffixByBytes(value, byteLimit);
  }
  return prefixByBytes(value, byteLimit);
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

function codexThreadUiHtml() {
  return `<!doctype html>
<html lang="en" data-codex-thread-ui="true">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Codex Threads</title>
  <style>
    :root {
      color-scheme: light;
      --background: 0 0% 100%;
      --foreground: 222.2 84% 4.9%;
      --muted: 210 40% 96.1%;
      --muted-foreground: 215.4 16.3% 46.9%;
      --card: 0 0% 100%;
      --card-foreground: 222.2 84% 4.9%;
      --popover: 0 0% 100%;
      --popover-foreground: 222.2 84% 4.9%;
      --primary: 222.2 47.4% 11.2%;
      --primary-foreground: 210 40% 98%;
      --secondary: 210 40% 96.1%;
      --secondary-foreground: 222.2 47.4% 11.2%;
      --accent: 210 40% 96.1%;
      --accent-foreground: 222.2 47.4% 11.2%;
      --destructive: 0 84.2% 60.2%;
      --destructive-foreground: 210 40% 98%;
      --border: 214.3 31.8% 91.4%;
      --input: 214.3 31.8% 91.4%;
      --ring: 222.2 84% 4.9%;
      --radius: 10px;
      --ok: 142.1 76.2% 36.3%;
      --warning: 32 95% 44%;
      --surface: 220 14% 97%;
    }

    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      min-height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      background: hsl(var(--surface));
      color: hsl(var(--foreground));
      font: 14px/1.5 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select {
      font: inherit;
    }
    button {
      border: 1px solid hsl(var(--border));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      border-radius: calc(var(--radius) - 3px);
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 140ms ease;
    }
    button:hover { background: hsl(var(--accent)); }
    button:active { transform: translateY(1px); }
    button:focus-visible, input:focus-visible, select:focus-visible {
      outline: 2px solid hsl(var(--ring));
      outline-offset: 2px;
    }

    .shell {
      display: grid;
      grid-template-columns: minmax(320px, 380px) minmax(0, 1fr);
      height: 100vh;
      min-height: 0;
      overflow: hidden;
    }
    .sidebar {
      border-right: 1px solid hsl(var(--border));
      background: hsl(var(--background));
      display: flex;
      flex-direction: column;
      min-width: 0;
      min-height: 0;
    }
    .topbar {
      padding: 18px;
      border-bottom: 1px solid hsl(var(--border));
      flex: 0 0 auto;
    }
    .title-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }
    h1 {
      margin: 0;
      font-size: 20px;
      line-height: 1.15;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .eyebrow {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .source-pill {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      border: 1px solid hsl(var(--border));
      background: hsl(var(--secondary));
      color: hsl(var(--secondary-foreground));
      border-radius: 999px;
      padding: 5px 9px;
      font-size: 12px;
      white-space: nowrap;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: hsl(var(--ok));
    }
    .dot.live {
      animation: pulse 1.5s ease-in-out infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.45); opacity: 0.45; }
    }
    .refresh {
      min-height: 36px;
      padding: 0 13px;
      white-space: nowrap;
      font-weight: 600;
    }
    .filters {
      display: grid;
      grid-template-columns: 1fr;
      gap: 10px;
    }
    .filter-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 140px;
      gap: 8px;
    }
    input, select {
      width: 100%;
      border: 1px solid hsl(var(--input));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      border-radius: calc(var(--radius) - 3px);
      min-height: 38px;
      padding: 0 11px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    label.toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      user-select: none;
    }
    label.toggle input {
      width: 15px;
      min-height: 15px;
      height: 15px;
      padding: 0;
      accent-color: hsl(var(--primary));
    }
    .meta-line {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      margin-top: 12px;
      min-height: 18px;
    }
    .thread-list {
      flex: 1 1 auto;
      min-height: 0;
      overflow: auto;
      padding: 10px;
    }
    .thread-row {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      text-align: left;
      padding: 13px;
      margin: 0 0 8px;
      border-color: hsl(var(--border));
      background: hsl(var(--card));
      border-radius: var(--radius);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .thread-row:hover { background: hsl(var(--accent)); }
    .thread-row.active {
      border-color: hsl(var(--primary));
      box-shadow: 0 0 0 1px hsl(var(--primary)), 0 12px 28px rgba(15, 23, 42, 0.08);
    }
    .thread-main { min-width: 0; }
    .thread-title {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-sub {
      margin-top: 4px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .thread-count {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      white-space: nowrap;
      display: grid;
      justify-items: end;
      gap: 6px;
    }
    .content {
      min-width: 0;
      min-height: 0;
      height: 100vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .detail-head {
      padding: 18px 26px 16px;
      border-bottom: 1px solid hsl(var(--border));
      background: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(14px);
      flex: 0 0 auto;
      z-index: 2;
    }
    .detail-head h2 {
      margin: 0 0 8px;
      font-size: 22px;
      line-height: 1.2;
      font-weight: 720;
      letter-spacing: -0.02em;
      overflow-wrap: anywhere;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .detail-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      border-radius: 999px;
      padding: 2px 8px;
      border: 1px solid hsl(var(--border));
      background: hsl(var(--secondary));
      color: hsl(var(--secondary-foreground));
      font-size: 12px;
      font-weight: 650;
    }
    .status.succeeded { background: hsl(142 76% 96%); color: hsl(var(--ok)); border-color: hsl(142 55% 84%); }
    .status.failed, .status.timeout, .status.cancelled { background: hsl(0 86% 97%); color: hsl(var(--destructive)); border-color: hsl(0 80% 88%); }
    .status.running, .status.queued { background: hsl(42 100% 96%); color: hsl(var(--warning)); border-color: hsl(42 88% 82%); }
    .detail-body {
      flex: 1 1 auto;
      padding: 0;
      overflow: hidden;
      min-height: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(300px, 34%);
      gap: 0;
      align-items: stretch;
      height: 100%;
      min-height: 0;
    }
    .section {
      background: hsl(var(--card));
      border: 1px solid hsl(var(--border));
      border-radius: var(--radius);
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
      margin-bottom: 14px;
      overflow: hidden;
    }
    .section h3 {
      margin: 0;
      padding: 12px 14px;
      font-size: 12px;
      letter-spacing: 0;
      color: hsl(var(--muted-foreground));
      border-bottom: 1px solid hsl(var(--border));
      background: hsl(var(--muted) / 0.42);
    }
    .section-body { padding: 14px; }
    .empty {
      color: hsl(var(--muted-foreground));
      padding: 18px 14px;
    }
    .message {
      display: flex;
      gap: 10px;
      padding: 10px 0;
    }
    .message.user { justify-content: flex-end; }
    .message.assistant { justify-content: flex-start; }
    .role {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      font-weight: 700;
      margin-bottom: 5px;
    }
    .bubble {
      max-width: min(760px, 86%);
      border: 1px solid hsl(var(--border));
      border-radius: 16px;
      padding: 12px 13px;
      background: hsl(var(--background));
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .message.user .bubble {
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
    }
    .message.user .role,
    .message.user .preview {
      color: hsl(var(--primary-foreground) / 0.76);
    }
    .message-text {
      overflow-wrap: anywhere;
      line-height: 1.55;
    }
    .markdown {
      overflow-wrap: anywhere;
      line-height: 1.58;
    }
    .markdown > *:first-child { margin-top: 0; }
    .markdown > *:last-child { margin-bottom: 0; }
    .markdown p {
      margin: 0 0 10px;
    }
    .markdown h1,
    .markdown h2,
    .markdown h3 {
      margin: 16px 0 8px;
      line-height: 1.22;
      letter-spacing: -0.01em;
    }
    .markdown h1 { font-size: 20px; }
    .markdown h2 { font-size: 17px; }
    .markdown h3 { font-size: 15px; }
    .markdown ul,
    .markdown ol {
      margin: 8px 0 12px;
      padding-left: 22px;
    }
    .markdown li {
      margin: 4px 0;
    }
    .markdown code {
      border: 1px solid hsl(var(--border));
      background: hsl(var(--muted));
      border-radius: 5px;
      padding: 1px 5px;
      font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .message.user .markdown code {
      background: hsl(var(--primary-foreground) / 0.12);
      border-color: hsl(var(--primary-foreground) / 0.18);
      color: inherit;
    }
    .markdown pre {
      margin: 10px 0 12px;
      padding: 12px;
      background: hsl(222.2 47.4% 11.2%);
      color: hsl(var(--primary-foreground));
      border-radius: calc(var(--radius) - 2px);
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .markdown pre code {
      border: 0;
      background: transparent;
      padding: 0;
      color: inherit;
      font: inherit;
    }
    .markdown blockquote {
      margin: 10px 0;
      padding: 8px 12px;
      border-left: 3px solid hsl(var(--border));
      color: hsl(var(--muted-foreground));
      background: hsl(var(--muted) / 0.55);
      border-radius: 0 calc(var(--radius) - 4px) calc(var(--radius) - 4px) 0;
    }
    .markdown a {
      color: hsl(221 83% 53%);
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .message.user .markdown a {
      color: inherit;
    }
    .job {
      border-bottom: 1px solid hsl(var(--border));
      padding: 12px 0;
    }
    .job:last-child { border-bottom: 0; }
    .log-tail {
      margin-top: 8px;
      max-height: 90px;
      overflow: auto;
      background: hsl(222.2 47.4% 11.2%);
      color: hsl(var(--primary-foreground));
      border-radius: calc(var(--radius) - 2px);
      padding: 10px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .job-top {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
      margin-bottom: 8px;
    }
    .job-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
      color: hsl(var(--muted-foreground));
    }
    .job-actions {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
      flex: 0 0 auto;
    }
    .small-button {
      min-height: 30px;
      padding: 0 10px;
      font-size: 12px;
      font-weight: 600;
    }
    .job-summary {
      max-height: 92px;
      overflow: hidden;
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      border-left: 2px solid hsl(var(--border));
      padding-left: 10px;
      margin-top: 8px;
    }
    .job-log-panel {
      margin-top: 12px;
      border: 1px solid hsl(var(--border));
      border-radius: calc(var(--radius) - 2px);
      background: hsl(var(--background));
      overflow: hidden;
    }
    .job-log-section {
      border-top: 1px solid hsl(var(--border));
    }
    .job-log-section:first-child {
      border-top: 0;
    }
    .job-log-title {
      padding: 9px 10px;
      color: hsl(var(--muted-foreground));
      background: hsl(var(--muted) / 0.48);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.02em;
    }
    .job-log-body {
      max-height: 260px;
      overflow: auto;
      padding: 10px;
    }
    .preview {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      overflow-wrap: anywhere;
      margin-top: 6px;
    }
    pre {
      margin: 0;
      padding: 12px;
      background: hsl(222.2 47.4% 11.2%);
      color: hsl(var(--primary-foreground));
      border-radius: calc(var(--radius) - 2px);
      overflow: auto;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 14px;
    }
    .stat {
      border: 1px solid hsl(var(--border));
      background: hsl(var(--card));
      border-radius: var(--radius);
      padding: 12px;
    }
    .stat-value {
      font-size: 20px;
      font-weight: 720;
      line-height: 1;
      letter-spacing: -0.02em;
    }
    .stat-label {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
      margin-top: 6px;
    }
    .conversation {
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: flex;
      flex-direction: column;
      border-right: 1px solid hsl(var(--border));
      background: hsl(var(--surface));
    }
    .conversation-scroll {
      flex: 1;
      min-height: 0;
      overflow: auto;
      padding: 22px 28px;
    }
    .inspector {
      height: 100%;
      min-height: 0;
      overflow: auto;
      padding: 18px;
      background: hsl(var(--background));
    }
    .chat-empty {
      border: 1px dashed hsl(var(--border));
      border-radius: var(--radius);
      padding: 24px;
      color: hsl(var(--muted-foreground));
      background: hsl(var(--background));
    }
    .composer {
      border: 0;
      border-top: 1px solid hsl(var(--border));
      background: hsl(var(--card));
      border-radius: 0;
      padding: 12px 18px;
      margin: 0;
      box-shadow: 0 -8px 28px rgba(15, 23, 42, 0.04);
    }
    .composer textarea {
      width: 100%;
      height: 72px;
      min-height: 72px;
      max-height: 150px;
      resize: vertical;
      border: 1px solid hsl(var(--input));
      background: hsl(var(--background));
      color: hsl(var(--foreground));
      border-radius: calc(var(--radius) - 3px);
      padding: 10px 11px;
      font: inherit;
      line-height: 1.5;
    }
    .composer-actions {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 10px;
    }
    .primary-button {
      min-height: 36px;
      padding: 0 14px;
      background: hsl(var(--primary));
      color: hsl(var(--primary-foreground));
      border-color: hsl(var(--primary));
      font-weight: 650;
    }
    .primary-button:hover {
      background: hsl(var(--primary) / 0.9);
    }
    .composer-status {
      color: hsl(var(--muted-foreground));
      font-size: 12px;
    }
    .split-stack {
      display: grid;
      gap: 10px;
      height: 100%;
      overflow: auto;
      padding: 18px;
    }
    .hidden { display: none !important; }

    @media (max-width: 900px) {
      .shell {
        grid-template-columns: 1fr;
      }
      .sidebar {
        height: 42vh;
        min-height: 0;
        border-right: 0;
        border-bottom: 1px solid hsl(var(--border));
      }
      .thread-list {
        max-height: 46vh;
      }
      .grid {
        grid-template-columns: 1fr;
        overflow: auto;
      }
      .detail-head {
        position: static;
      }
      .inspector {
        height: auto;
        overflow: visible;
        border-top: 1px solid hsl(var(--border));
      }
      .filter-row {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <aside class="sidebar">
      <div class="topbar">
        <div class="title-row">
          <div>
            <div class="eyebrow">POC Vault</div>
            <h1>Codex Threads</h1>
          </div>
          <span class="source-pill"><span class="dot"></span>${proxyBaseUrl ? "Live via cert proxy" : "Local runner"}</span>
        </div>
        <div class="filters">
          <div class="filter-row">
            <input id="searchInput" type="search" placeholder="Search threads">
            <select id="workspaceSelect" aria-label="Workspace"></select>
          </div>
          <label class="toggle"><input id="hideSmokeInput" type="checkbox" checked> Hide smoke tests</label>
        </div>
        <div class="meta-line" id="listMeta"></div>
        <button class="refresh" id="refreshButton" type="button">Refresh threads</button>
      </div>
      <div class="thread-list" id="threadList"></div>
    </aside>
    <section class="content">
      <header class="detail-head">
        <h2 id="detailTitle">Select a thread</h2>
        <div class="detail-meta" id="detailMeta"></div>
      </header>
      <div class="detail-body" id="detailBody">
        <div class="empty">No thread selected.</div>
      </div>
    </section>
  </main>
  <script>
    (function () {
      var state = {
        workspaces: [],
        threads: [],
        selectedThreadId: null,
        selectedWorkspace: "",
        query: "",
        hideSmoke: true,
        selectedJobs: [],
        selectedThread: null,
        pollTimer: null,
        threadPollInFlight: false,
        listPollInFlight: false,
        lastPollAt: null,
        composerDrafts: Object.create(null)
      };

      var els = {
        refreshButton: document.getElementById("refreshButton"),
        searchInput: document.getElementById("searchInput"),
        workspaceSelect: document.getElementById("workspaceSelect"),
        hideSmokeInput: document.getElementById("hideSmokeInput"),
        listMeta: document.getElementById("listMeta"),
        threadList: document.getElementById("threadList"),
        detailTitle: document.getElementById("detailTitle"),
        detailMeta: document.getElementById("detailMeta"),
        detailBody: document.getElementById("detailBody")
      };

      function api(path) {
        return apiRequest(path);
      }

      function apiRequest(path, options) {
        options = options || {};
        var headers = options.headers || {};
        headers.accept = headers.accept || "application/json";
        return fetch(path, Object.assign({}, options, { headers: headers })).then(function (response) {
          if (!response.ok) {
            return response.json().catch(function () { return {}; }).then(function (body) {
              throw new Error(body.error || "Request failed with HTTP " + response.status);
            });
          }
          return response.json();
        });
      }

      function formatDate(value) {
        if (!value) return "unknown";
        var date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        return date.toLocaleString();
      }

      function shortId(value) {
        return value ? value.slice(0, 8) : "unknown";
      }

      function statusClass(value) {
        return "status " + (value || "unknown");
      }

      function clear(node) {
        while (node.firstChild) node.removeChild(node.firstChild);
      }

      function captureComposerState() {
        var textarea = document.querySelector(".composer textarea");
        var chat = document.querySelector(".conversation-scroll");
        var inspector = document.querySelector(".inspector");
        var chatBottomGap = chat ? chat.scrollHeight - chat.scrollTop - chat.clientHeight : 0;
        var inspectorBottomGap = inspector ? inspector.scrollHeight - inspector.scrollTop - inspector.clientHeight : 0;
        var snapshot = {
          focused: false,
          threadId: null,
          selectionStart: 0,
          selectionEnd: 0,
          chatScrollTop: chat ? chat.scrollTop : 0,
          chatWasNearBottom: chat ? chatBottomGap < 32 : false,
          inspectorScrollTop: inspector ? inspector.scrollTop : 0,
          inspectorWasNearBottom: inspector ? inspectorBottomGap < 32 : false
        };
        if (!textarea) return snapshot;
        if (textarea.dataset.threadId) state.composerDrafts[textarea.dataset.threadId] = textarea.value;
        return {
          ...snapshot,
          focused: document.activeElement === textarea,
          threadId: textarea.dataset.threadId || null,
          selectionStart: textarea.selectionStart || 0,
          selectionEnd: textarea.selectionEnd || 0
        };
      }

      function restoreComposerState(thread, snapshot) {
        if (!snapshot) return;
        var chat = document.querySelector(".conversation-scroll");
        if (chat) {
          chat.scrollTop = snapshot.chatWasNearBottom ? chat.scrollHeight : snapshot.chatScrollTop || 0;
        }
        var inspector = document.querySelector(".inspector");
        if (inspector) {
          inspector.scrollTop = snapshot.inspectorWasNearBottom ? inspector.scrollHeight : snapshot.inspectorScrollTop || 0;
        }
        if (!snapshot.focused || snapshot.threadId !== thread.sessionId) return;
        var textarea = document.querySelector(".composer textarea[data-thread-id='" + thread.sessionId + "']");
        if (!textarea) return;
        textarea.focus();
        var start = Math.min(snapshot.selectionStart, textarea.value.length);
        var end = Math.min(snapshot.selectionEnd, textarea.value.length);
        textarea.setSelectionRange(start, end);
      }

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
      }

      function appendInlineMarkdown(parent, text) {
        var tick = String.fromCharCode(96);
        var pattern = new RegExp(
          "(\\\\[[^\\\\]]+\\\\]\\\\(https?:\\\\/\\\\/[^\\\\s)]+\\\\)|" +
            tick + "[^" + tick + "]+" + tick +
            "|\\\\*\\\\*[^*]+\\\\*\\\\*|__[^_]+__|\\\\*[^*]+\\\\*|_[^_]+_)",
          "g"
        );
        var last = 0;
        var match;
        while ((match = pattern.exec(text)) !== null) {
          if (match.index > last) parent.appendChild(document.createTextNode(text.slice(last, match.index)));
          var token = match[0];
          if (token[0] === "[" && token.includes("](")) {
            var close = token.indexOf("](");
            var label = token.slice(1, close);
            var href = token.slice(close + 2, -1);
            var link = document.createElement("a");
            link.textContent = label;
            link.href = href;
            link.target = "_blank";
            link.rel = "noreferrer";
            parent.appendChild(link);
          } else if (token[0] === tick) {
            parent.appendChild(el("code", "", token.slice(1, -1)));
          } else if (token.startsWith("**") || token.startsWith("__")) {
            var strong = document.createElement("strong");
            strong.textContent = token.slice(2, -2);
            parent.appendChild(strong);
          } else {
            var em = document.createElement("em");
            em.textContent = token.slice(1, -1);
            parent.appendChild(em);
          }
          last = pattern.lastIndex;
        }
        if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
      }

      function appendParagraph(parent, lines) {
        if (!lines.length) return;
        var paragraph = document.createElement("p");
        appendInlineMarkdown(paragraph, lines.join(" "));
        parent.appendChild(paragraph);
        lines.length = 0;
      }

      function appendList(parent, tag, items) {
        if (!items.length) return;
        var list = document.createElement(tag);
        items.forEach(function (item) {
          var li = document.createElement("li");
          appendInlineMarkdown(li, item);
          list.appendChild(li);
        });
        parent.appendChild(list);
        items.length = 0;
      }

      function normalizeMarkdownText(value) {
        var tick = String.fromCharCode(96);
        var fence = tick + tick + tick;
        var text = String(value || "").replace(/\\r\\n/g, "\\n");
        var output = "";
        var cursor = 0;

        while (cursor < text.length) {
          var start = text.indexOf(fence, cursor);
          if (start === -1) {
            output += text.slice(cursor);
            break;
          }

          var close = text.indexOf(fence, start + fence.length);
          var chunk = text.slice(start + fence.length, close === -1 ? text.length : close);
          var lang = "";
          var content = chunk;
          var langMatch = content.match(/^([A-Za-z0-9_-]+)(?:\\s+|$)/);
          if (langMatch) {
            lang = langMatch[1];
            content = content.slice(langMatch[0].length);
          }

          output += text.slice(cursor, start);
          output += "\\n" + fence + lang + "\\n" + content.trim() + "\\n" + fence + "\\n";
          if (close === -1) break;
          cursor = close + fence.length;
        }

        return output;
      }

      function markdownNode(text) {
        var tick = String.fromCharCode(96);
        var root = el("div", "markdown");
        var lines = normalizeMarkdownText(text).split("\\n");
        var paragraph = [];
        var unordered = [];
        var ordered = [];
        var inCode = false;
        var codeLines = [];
        var codeLang = "";

        function flushBlocks() {
          appendParagraph(root, paragraph);
          appendList(root, "ul", unordered);
          appendList(root, "ol", ordered);
        }

        lines.forEach(function (line) {
          var fence = line.match(new RegExp("^" + tick + tick + tick + "\\\\s*([A-Za-z0-9_-]+)?\\\\s*$"));
          if (fence) {
            if (inCode) {
              var pre = document.createElement("pre");
              var code = document.createElement("code");
              if (codeLang) code.dataset.language = codeLang;
              code.textContent = codeLines.join("\\n");
              pre.appendChild(code);
              root.appendChild(pre);
              codeLines = [];
              codeLang = "";
              inCode = false;
            } else {
              flushBlocks();
              inCode = true;
              codeLang = fence[1] || "";
            }
            return;
          }

          if (inCode) {
            codeLines.push(line);
            return;
          }

          if (!line.trim()) {
            flushBlocks();
            return;
          }

          var heading = line.match(/^(#{1,3})\\s+(.+)$/);
          if (heading) {
            flushBlocks();
            var h = document.createElement("h" + heading[1].length);
            appendInlineMarkdown(h, heading[2].trim());
            root.appendChild(h);
            return;
          }

          var quote = line.match(/^>\\s?(.+)$/);
          if (quote) {
            flushBlocks();
            var blockquote = document.createElement("blockquote");
            appendInlineMarkdown(blockquote, quote[1].trim());
            root.appendChild(blockquote);
            return;
          }

          var bullet = line.match(/^\\s*[-*]\\s+(.+)$/);
          if (bullet) {
            appendParagraph(root, paragraph);
            appendList(root, "ol", ordered);
            unordered.push(bullet[1].trim());
            return;
          }

          var number = line.match(/^\\s*\\d+[.)]\\s+(.+)$/);
          if (number) {
            appendParagraph(root, paragraph);
            appendList(root, "ul", unordered);
            ordered.push(number[1].trim());
            return;
          }

          appendList(root, "ul", unordered);
          appendList(root, "ol", ordered);
          paragraph.push(line.trim());
        });

        if (inCode) {
          var pre = document.createElement("pre");
          var code = document.createElement("code");
          code.textContent = codeLines.join("\\n");
          pre.appendChild(code);
          root.appendChild(pre);
        }
        flushBlocks();
        return root;
      }

      function setError(error) {
        els.detailTitle.textContent = "Could not load";
        clear(els.detailMeta);
        clear(els.detailBody);
        els.detailBody.appendChild(el("div", "empty", error.message || String(error)));
      }

      function filteredThreads() {
        var query = state.query.trim().toLowerCase();
        return state.threads.filter(function (thread) {
          if (state.hideSmoke && thread.isSmokeTest) return false;
          if (!query) return true;
          return [
            thread.sessionId,
            thread.workspaceName,
            thread.lastPrompt,
            thread.lastResult,
            thread.lastError,
            thread.lastJobStatus
          ].join(" ").toLowerCase().includes(query);
        });
      }

      function renderWorkspaces() {
        clear(els.workspaceSelect);
        var all = document.createElement("option");
        all.value = "";
        all.textContent = "All workspaces";
        els.workspaceSelect.appendChild(all);
        state.workspaces.forEach(function (workspace) {
          var option = document.createElement("option");
          option.value = workspace.id;
          option.textContent = workspace.name;
          els.workspaceSelect.appendChild(option);
        });
        els.workspaceSelect.value = state.selectedWorkspace;
      }

      function renderThreads() {
        var previousScrollTop = els.threadList.scrollTop;
        var threads = filteredThreads();
        clear(els.threadList);
        els.listMeta.textContent = threads.length + " of " + state.threads.length + " threads";

        if (threads.length === 0) {
          els.threadList.appendChild(el("div", "empty", "No matching threads."));
          return;
        }

        threads.forEach(function (thread) {
          var row = document.createElement("button");
          row.type = "button";
          row.className = "thread-row" + (thread.id === state.selectedThreadId ? " active" : "");
          row.addEventListener("click", function () { selectThread(thread.id); });

          var main = el("div", "thread-main");
          main.appendChild(el("div", "thread-title", thread.lastPrompt || thread.lastResult || shortId(thread.sessionId)));
          main.appendChild(el("div", "thread-sub", thread.workspaceName + " - " + formatDate(thread.updatedAt)));

          var side = el("div", "thread-count");
          side.appendChild(el("div", "", String(thread.jobCount) + " jobs"));
          if (thread.lastJobStatus) {
            side.appendChild(el("span", statusClass(thread.lastJobStatus), thread.lastJobStatus));
          }

          row.appendChild(main);
          row.appendChild(side);
          els.threadList.appendChild(row);
        });
        els.threadList.scrollTop = previousScrollTop;
      }

      function section(title, bodyNode) {
        var wrapper = el("section", "section");
        wrapper.appendChild(el("h3", "", title));
        var body = el("div", "section-body");
        body.appendChild(bodyNode);
        wrapper.appendChild(body);
        return wrapper;
      }

      function renderTextSection(title, text) {
        return section(title, markdownNode(text || "None"));
      }

      function renderMessages(messages) {
        var body = el("div", "");
        if (!messages || messages.length === 0) {
          body.appendChild(el("div", "chat-empty", "No transcript messages found."));
          return body;
        }
        messages.forEach(function (message) {
          var row = el("div", "message " + message.role);
          var bubble = el("div", "bubble");
          bubble.appendChild(el("div", "role", message.role === "user" ? "You" : "Codex"));
          bubble.appendChild(markdownNode(message.text));
          if (message.timestamp) bubble.appendChild(el("div", "preview", formatDate(message.timestamp)));
          row.appendChild(bubble);
          body.appendChild(row);
        });
        return body;
      }

      function renderJobs(jobs) {
        if (!jobs || jobs.length === 0) return section("Jobs", el("div", "empty", "No jobs recorded for this thread."));
        var body = el("div", "");
        jobs.forEach(function (job) {
          var row = el("div", "job");
          var top = el("div", "job-top");
          top.appendChild(el("div", "job-id", job.id));
          var actions = el("div", "job-actions");
          actions.appendChild(el("span", statusClass(job.status), job.status));
          var open = el("button", "small-button", "Open logs");
          open.type = "button";
          actions.appendChild(open);
          top.appendChild(actions);
          row.appendChild(top);
          var preview = el("div", "job-summary");
          preview.appendChild(markdownNode(job.resultPreview || job.error || job.prompt || "No preview yet."));
          row.appendChild(preview);
          var tail = [job.stdoutPreview, job.stderrPreview].filter(Boolean).join("\\n").trim();
          if (tail && !job.resultPreview) {
            row.appendChild(el("div", "log-tail", tail));
          }
          var logMount = el("div", "hidden");
          row.appendChild(logMount);
          open.addEventListener("click", function () { toggleJobLogs(job, logMount, open); });
          body.appendChild(row);
        });
        return section("Jobs", body);
      }

      function appendLogSection(parent, title, text) {
        var value = String(text || "").trim();
        if (!value) return;
        var wrapper = el("div", "job-log-section");
        wrapper.appendChild(el("div", "job-log-title", title));
        var body = el("div", "job-log-body");
        body.appendChild(markdownNode(value));
        wrapper.appendChild(body);
        parent.appendChild(wrapper);
      }

      function toggleJobLogs(job, mount, button) {
        if (!mount.classList.contains("hidden")) {
          mount.classList.add("hidden");
          button.textContent = "Open logs";
          return;
        }

        mount.classList.remove("hidden");
        button.textContent = "Close logs";
        if (mount.dataset.loaded === "true") return;

        clear(mount);
        mount.appendChild(el("div", "empty", "Loading logs..."));
        api("/v1/codex/jobs/" + encodeURIComponent(job.id) + "?include=fullLogs").then(function (fullJob) {
          clear(mount);
          var panel = el("div", "job-log-panel");
          appendLogSection(panel, "Result", fullJob.result || fullJob.resultPreview);
          appendLogSection(panel, "Stdout", fullJob.stdout || fullJob.stdoutPreview);
          appendLogSection(panel, "Stderr", fullJob.stderr || fullJob.stderrPreview || fullJob.error);
          if (!panel.childNodes.length) {
            panel.appendChild(el("div", "empty", "No logs captured for this job."));
          }
          mount.appendChild(panel);
          mount.dataset.loaded = "true";
        }).catch(function (error) {
          clear(mount);
          mount.appendChild(el("div", "empty", error.message || String(error)));
        });
      }

      function threadPreviewMessages(thread) {
        var messages = [];
        if (thread.lastPrompt) {
          messages.push({ role: "user", text: thread.lastPrompt, timestamp: thread.updatedAt });
        }
        if (thread.lastResult || thread.lastError) {
          messages.push({
            role: "assistant",
            text: thread.lastResult || thread.lastError,
            timestamp: thread.updatedAt
          });
        }
        return messages;
      }

      function jobsToMessages(thread, jobs) {
        var messages = [];
        jobs
          .slice()
          .sort(function (left, right) {
            return Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0);
          })
          .forEach(function (job) {
            if (job.prompt) {
              messages.push({ role: "user", text: job.prompt, timestamp: job.createdAt || job.startedAt || job.updatedAt });
            }
            var answer = job.resultPreview || job.result || job.error || job.stderrPreview || job.stdoutPreview;
            if (answer) {
              messages.push({ role: "assistant", text: answer, timestamp: job.finishedAt || job.updatedAt, status: job.status });
            } else if (job.status && job.status !== "succeeded") {
              messages.push({ role: "assistant", text: "Codex is " + job.status + "...", timestamp: job.updatedAt, status: job.status });
            }
          });
        return messages.length > 0 ? messages : threadPreviewMessages(thread);
      }

      function isActiveStatus(status) {
        return status === "queued" || status === "running";
      }

      function selectedHasActiveJob() {
        return state.selectedJobs.some(function (job) { return isActiveStatus(job.status); });
      }

      function renderConversation(thread, messages, jobs, detailNote, renderSnapshot) {
        state.selectedThread = thread;
        state.selectedJobs = jobs || [];
        var grid = el("div", "grid");
        var conversation = el("div", "conversation");
        var scroll = el("div", "conversation-scroll");
        if (messages && messages.length > 0) {
          scroll.appendChild(renderMessages(messages));
        } else {
          scroll.appendChild(el("div", "chat-empty", "No chat messages found for this thread yet."));
        }
        conversation.appendChild(scroll);
        conversation.appendChild(renderComposer(thread));

        var inspector = el("aside", "inspector");
        inspector.appendChild(renderStats(thread));
        inspector.appendChild(section("Live status", markdownNode(liveStatusText())));
        if (detailNote) {
          inspector.appendChild(section("Detail status", markdownNode(detailNote)));
        }
        inspector.appendChild(renderJobs(jobs || []));

        grid.appendChild(conversation);
        grid.appendChild(inspector);
        els.detailBody.appendChild(grid);
        restoreComposerState(thread, renderSnapshot);
      }

      function liveStatusText() {
        var cadence = selectedHasActiveJob() ? "Polling every 2s while active." : "Polling every 8s while idle.";
        var stamp = state.lastPollAt ? " Last check " + formatDate(state.lastPollAt) + "." : "";
        return cadence + stamp;
      }

      function renderStats(thread) {
        var stats = el("div", "stats");
        var jobStat = el("div", "stat");
        jobStat.appendChild(el("div", "stat-value", String(thread.jobCount || 0)));
        jobStat.appendChild(el("div", "stat-label", "Jobs"));
        var activeStat = el("div", "stat");
        activeStat.appendChild(el("div", "stat-value", String(thread.activeJobCount || 0)));
        activeStat.appendChild(el("div", "stat-label", "Active"));
        var sourceStat = el("div", "stat");
        sourceStat.appendChild(el("div", "stat-value", thread.hasSessionFile ? "Yes" : "No"));
        sourceStat.appendChild(el("div", "stat-label", "Session file"));
        stats.appendChild(jobStat);
        stats.appendChild(activeStat);
        stats.appendChild(sourceStat);
        return stats;
      }

      function renderComposer(thread) {
        var wrapper = el("div", "composer");
        var textarea = document.createElement("textarea");
        textarea.dataset.threadId = thread.sessionId;
        textarea.value = state.composerDrafts[thread.sessionId] || "";
        textarea.placeholder = "Reply on this Codex thread...";
        textarea.addEventListener("input", function () {
          state.composerDrafts[thread.sessionId] = textarea.value;
        });
        var actions = el("div", "composer-actions");
        var status = el("div", "composer-status", "Continues " + shortId(thread.sessionId));
        var button = el("button", "primary-button", "Send reply");
        button.type = "button";
        button.addEventListener("click", function () {
          var prompt = textarea.value.trim();
          if (!prompt) {
            status.textContent = "Write a reply first.";
            return;
          }
          button.disabled = true;
          status.textContent = "Sending...";
          apiRequest("/v1/codex/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              workspaceId: thread.workspaceId,
              provider: thread.provider || "codex",
              prompt: prompt,
              timeoutMs: 1800000,
              resumeSessionId: thread.sessionId
            })
          }).then(function (job) {
            textarea.value = "";
            state.composerDrafts[thread.sessionId] = "";
            status.textContent = "Queued job " + shortId(job.id || "");
            var current = state.threads.find(function (item) { return item.id === thread.id; }) || thread;
            current.lastPrompt = prompt;
            current.lastJobId = job.id || current.lastJobId;
            current.lastJobStatus = job.status || current.lastJobStatus || "queued";
            current.jobCount = (current.jobCount || 0) + 1;
            renderThreadSummaryOnly(current, "Reply queued. Refresh threads to watch status move.");
            loadThreadJobs(current);
            renderThreads();
          }).catch(function (error) {
            status.textContent = error.message || String(error);
          }).finally(function () {
            button.disabled = false;
          });
        });
        actions.appendChild(status);
        actions.appendChild(button);
        wrapper.appendChild(textarea);
        wrapper.appendChild(actions);
        return wrapper;
      }

      function renderDetail(body) {
        var renderSnapshot = captureComposerState();
        var thread = body.thread;
        els.detailTitle.textContent = thread.lastPrompt || thread.lastResult || thread.sessionId;
        clear(els.detailMeta);
        els.detailMeta.appendChild(el("span", "", thread.workspaceName));
        els.detailMeta.appendChild(el("span", "", "Updated " + formatDate(thread.updatedAt)));
        els.detailMeta.appendChild(el("span", "", thread.sessionId));
        if (thread.lastJobStatus) els.detailMeta.appendChild(el("span", statusClass(thread.lastJobStatus), thread.lastJobStatus));

        clear(els.detailBody);
        renderConversation(thread, body.messages, body.jobs, null, renderSnapshot);
      }

      function renderThreadSummaryOnly(thread, reason) {
        var renderSnapshot = captureComposerState();
        state.selectedThread = thread;
        state.selectedJobs = [];
        els.detailTitle.textContent = thread.lastPrompt || thread.lastResult || thread.sessionId;
        clear(els.detailMeta);
        els.detailMeta.appendChild(el("span", "", thread.workspaceName || "Workspace"));
        els.detailMeta.appendChild(el("span", "", "Updated " + formatDate(thread.updatedAt)));
        els.detailMeta.appendChild(el("span", "", thread.sessionId));
        if (thread.lastJobStatus) els.detailMeta.appendChild(el("span", statusClass(thread.lastJobStatus), thread.lastJobStatus));

        clear(els.detailBody);
        renderConversation(thread, threadPreviewMessages(thread), [], reason || "Full transcript detail is not available from this server yet.", renderSnapshot);
      }

      function renderJobDetail(job) {
        clear(els.detailBody);
        var stack = el("div", "split-stack");
        stack.appendChild(renderTextSection("Prompt", job.prompt || "None"));
        stack.appendChild(section("Result", el("pre", "", job.result || job.resultPreview || "")));
        stack.appendChild(section("Stdout", el("pre", "", job.stdout || job.stdoutPreview || "")));
        stack.appendChild(section("Stderr", el("pre", "", job.stderr || job.stderrPreview || "")));
        els.detailBody.appendChild(stack);
      }

      function loadThreadJobs(thread) {
        if (state.threadPollInFlight) return Promise.resolve();
        state.threadPollInFlight = true;
        return api("/v1/codex/jobs?limit=200").then(function (body) {
          var jobs = (body.jobs || []).filter(function (job) {
            return job.sessionId === thread.sessionId || job.resumeSessionId === thread.sessionId;
          });
          jobs.sort(function (left, right) {
            return Date.parse(left.createdAt || left.updatedAt || 0) - Date.parse(right.createdAt || right.updatedAt || 0);
          });
          if (state.selectedThreadId !== thread.id) return;
          state.lastPollAt = new Date().toISOString();
          thread.jobCount = jobs.length || thread.jobCount || 0;
          thread.activeJobCount = jobs.filter(function (job) { return isActiveStatus(job.status); }).length;
          if (jobs.length > 0) {
            var latest = jobs[jobs.length - 1];
            thread.lastJobId = latest.id || thread.lastJobId;
            thread.lastJobStatus = latest.status || thread.lastJobStatus;
            thread.lastPrompt = latest.prompt || thread.lastPrompt;
            thread.lastResult = latest.resultPreview || latest.result || latest.error || thread.lastResult;
            thread.updatedAt = latest.updatedAt || latest.finishedAt || thread.updatedAt;
          }
          var renderSnapshot = captureComposerState();
          clear(els.detailBody);
          renderConversation(thread, jobsToMessages(thread, jobs), jobs, jobs.length > 0 ? null : "No jobs were found for this thread yet.", renderSnapshot);
          renderThreads();
        }).catch(function () {
          if (state.selectedThreadId === thread.id) {
            renderThreadSummaryOnly(thread, "Could not load the job history, so this is the latest thread preview.");
          }
        }).finally(function () {
          state.threadPollInFlight = false;
        });
      }

      function selectThread(id) {
        state.selectedThreadId = id;
        renderThreads();
        var fallback = state.threads.find(function (thread) { return thread.id === id; });
        if (fallback) {
          renderThreadSummaryOnly(fallback, "Loading full transcript detail. The summary and latest job logs are usable now.");
          loadThreadJobs(fallback);
        } else {
          els.detailTitle.textContent = "Loading thread";
          clear(els.detailMeta);
          clear(els.detailBody);
          els.detailBody.appendChild(el("div", "empty", "Loading..."));
        }
        api("/v1/codex/threads/" + encodeURIComponent(id)).then(renderDetail).catch(function (error) {
          if (fallback) {
            renderThreadSummaryOnly(fallback, "Full transcript detail is not available here yet. The list summary and latest job logs are still usable.");
            return;
          }
          setError(error);
        });
      }

      function loadJob(id) {
        els.detailTitle.textContent = "Job " + shortId(id);
        clear(els.detailMeta);
        els.detailMeta.appendChild(el("span", "", id));
        clear(els.detailBody);
        els.detailBody.appendChild(el("div", "empty", "Loading logs..."));
        api("/v1/codex/jobs/" + encodeURIComponent(id) + "?include=fullLogs").then(renderJobDetail).catch(setError);
      }

      function loadThreads() {
        if (state.listPollInFlight) return Promise.resolve();
        state.listPollInFlight = true;
        els.listMeta.textContent = "Loading...";
        var params = new URLSearchParams();
        params.set("limit", "200");
        if (state.selectedWorkspace) params.set("workspaceId", state.selectedWorkspace);
        return api("/v1/codex/threads?" + params.toString()).then(function (body) {
          state.threads = body.threads || [];
          state.lastPollAt = new Date().toISOString();
          if (state.selectedThreadId && !state.threads.some(function (thread) { return thread.id === state.selectedThreadId; })) {
            state.selectedThreadId = null;
          }
          renderThreads();
          var threads = filteredThreads();
          if (!state.selectedThreadId && threads.length > 0) {
            selectThread(threads[0].id);
          } else if (state.selectedThreadId) {
            var current = state.threads.find(function (thread) { return thread.id === state.selectedThreadId; });
            if (current) state.selectedThread = current;
          }
        }).catch(function (error) {
          els.listMeta.textContent = error.message || String(error);
        }).finally(function () {
          state.listPollInFlight = false;
        });
      }

      function loadWorkspaces() {
        return api("/v1/codex/workspaces").then(function (body) {
          state.workspaces = body.workspaces || [];
          renderWorkspaces();
        });
      }

      function pollNow() {
        if (state.selectedThreadId && state.selectedThread) {
          loadThreadJobs(state.selectedThread);
        }
        loadThreads();
        schedulePoll();
      }

      function schedulePoll() {
        if (state.pollTimer) clearTimeout(state.pollTimer);
        var delay = selectedHasActiveJob() ? 2000 : 8000;
        state.pollTimer = setTimeout(pollNow, delay);
      }

      els.refreshButton.addEventListener("click", function () {
        if (state.selectedThread) loadThreadJobs(state.selectedThread);
        loadThreads();
      });
      els.searchInput.addEventListener("input", function () {
        state.query = els.searchInput.value;
        renderThreads();
      });
      els.workspaceSelect.addEventListener("change", function () {
        state.selectedWorkspace = els.workspaceSelect.value;
        state.selectedThreadId = null;
        loadThreads();
      });
      els.hideSmokeInput.addEventListener("change", function () {
        state.hideSmoke = els.hideSmokeInput.checked;
        renderThreads();
      });

      loadWorkspaces().then(loadThreads).then(schedulePoll).catch(setError);
    })();
  </script>
</body>
</html>`;
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
