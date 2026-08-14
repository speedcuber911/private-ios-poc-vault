// relayd jobs.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { dataDir, jobsDir, logsDir, attachmentsDir, artifactsDir, approvalsDir, codexBin, claudeBin, cursorBin, runHome, codexHome, npmCacheDir, bunCacheDir, codexTransport, maxConcurrent, maxJobStreams, jobStreamHeartbeatMs, maxBodyBytes, maxJobAttachments, maxJobAttachmentBytes, maxJobAttachmentTotalBytes, maxOutputBytes, maxJobSkills, maxSkillPromptBytes, responseOutputBytes, listOutputBytes, maxTimeoutMs, defaultTimeoutMs, terminalStatuses, allowedReasoningEfforts, allowedJobProviders, allowedClaudePermissionModes, allowedCodexApprovalPolicies, claudeAwsProfile, claudeAwsRegion, claudeDefaultModel, cleanOptionalModel, normalizeClaudeModel, realpathOrResolve } from "./config.mjs";
import { nowIso, durationMs, sendError, initSse, sendSse, isSafeJobId, headerValue, shapeTextPayload, prefixByBytes, cleanAssistantResult, cleanApiText, readTextFileBounded } from "./util.mjs";
import { appendAudit } from "./audit.mjs";
import { resolveWorkspaceById, cleanWorkspaceId } from "./workspaces.mjs";
import { listProviderSkills } from "./skills.mjs";
import { cleanOptionalSessionId, findThreadResumeMeta, resumeMetaBelongsToWorkspace, workspaceForJob, workspaceForPath, readSessionMeta, walkSessionFiles, workspaceForSessionCwd, sessionBelongsToWorkspace } from "./threads.mjs";
import { extractJobArtifacts, sanitizePersistedArtifacts, publicArtifactResponses } from "./artifacts.mjs";
import { buildCodexArgs } from "./adapters/codex.mjs";
import { buildClaudeArgs } from "./adapters/claude.mjs";
import { buildCursorArgs, parseCursorResult } from "./adapters/cursor.mjs";
import { store } from "./store.mjs";
import { emitEvent } from "./events.mjs";
import { prepareJobWorkdir, completeJobWorktree } from "./worktree.mjs";
import { ApprovalStore } from "./approval-store.mjs";
import { assertProviderReady } from "./harness.mjs";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const codexJobRunner = path.join(moduleDir, "codex-job-runner.mjs");
const approvalStore = new ApprovalStore(approvalsDir);

const jobsState = { queuedJobIds: [] };

// Set by index.mjs when the handoff loop starts. Default is a no-op so jobs.mjs
// never depends on handoff.mjs and the module graph stays acyclic (handoff.mjs
// imports enqueueJob from here).
let handoffCompletionHook = async () => null;
let jobNotificationHook = async () => null;

function setHandoffCompletionHook(hook) {
  handoffCompletionHook = hook;
}

function setJobNotificationHook(hook) {
  jobNotificationHook = typeof hook === "function" ? hook : async () => null;
}

const jobs = new Map();

const activeChildren = new Map();

const jobStreamSubscribers = new Map();

let activeJobStreamCount = 0;

function loadPersistedJobs() {
  // W2-MODULES: job records now come from the storage backend (store.mjs);
  // the default JSON backend reads the same jobs/<id>.json files as before.
  for (const { sourceId, job } of store.loadJobRecords()) {
    try {
      if (!job || typeof job.id !== "string") continue;

      job.provider = normalizeJobProvider(job.provider);
      job.artifacts = sanitizePersistedArtifacts(job);
      ensureLogPaths(job);
      if (job.status === "running" || job.status === "waiting_for_approval") {
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
      if (job.status === "queued") jobsState.queuedJobIds.push(job.id);
    } catch (error) {
      appendAudit("load_job_failed", { id: sourceId, status: "unknown" }, { error: error.message });
    }
  }

  jobsState.queuedJobIds.sort((left, right) => {
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
  // W2-MODULES: persisted through the storage backend. The default JSON
  // backend performs the same atomic tmp+rename write to jobPath(job.id).
  store.saveJob(job);
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
  const selectedSkills = cleanSelectedSkills(provider, body.skills, workspace.path);
  const codexPrompt = promptWithAttachments(promptWithSelectedSkills(body.prompt, provider, selectedSkills), attachments);
  const permissionMode = cleanOptionalClaudePermissionMode(body.permissionMode);
  const approvalPolicy = cleanOptionalCodexApprovalPolicy(body.approvalPolicy);
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
    skillInputs: selectedSkills.map((skill) => ({ name: skill.name, path: skill.file, kind: skill.kind || "skill" })),
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
    permissionMode: provider === "claude" ? (permissionMode || "manual") : null,
    approvalPolicy: provider === "codex" ? approvalPolicy : null,
    resumeSessionId,
    sessionId: resumeSessionId || (provider === "claude" ? crypto.randomUUID() : null),
  };

  fs.writeFileSync(job.stdoutPath, "", "utf8");
  fs.writeFileSync(job.stderrPath, "", "utf8");
  fs.writeFileSync(job.resultPath, "", "utf8");
  return job;
}


// The seven steps every new job needs, in one place: validate, register in the
// live map, queue it, persist, audit, publish, and drain. Both the HTTP route
// and the handoff continue-path go through here so they cannot drift.
async function enqueueJob(body, certSubject) {
  const provider = cleanOptionalProvider(body?.provider);
  await assertProviderReady(provider);
  const job = createJob(body, certSubject);
  jobs.set(job.id, job);
  jobsState.queuedJobIds.push(job.id);
  persistJob(job);
  appendAudit("job_created", job);
  emitJobStateEvent(job);
  processQueue();
  return job;
}


function cleanProviderModel(provider, value) {
  const model = cleanOptionalModel(value);
  if (provider !== "claude") return model;
  if (!model) return claudeDefaultModel;
  return normalizeClaudeModel(model);
}


function cleanOptionalProvider(value) {
  if (value === undefined || value === null || value === "") return "codex";
  if (typeof value !== "string") {
    throw Object.assign(new Error("provider must be codex, claude, or cursor"), { status: 400 });
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedJobProviders.has(normalized)) {
    throw Object.assign(new Error("provider must be codex, claude, or cursor"), { status: 400 });
  }
  return normalized;
}


function cleanJobProviderFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  return cleanOptionalProvider(value);
}


function normalizeJobProvider(value) {
  return allowedJobProviders.has(value) ? value : "codex";
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


function cleanOptionalCodexApprovalPolicy(value) {
  if (value === undefined || value === null || value === "") return "on-request";
  if (typeof value !== "string" || !allowedCodexApprovalPolicies.has(value.trim())) {
    throw Object.assign(new Error("approvalPolicy must be untrusted, on-failure, on-request, or never"), { status: 400 });
  }
  return value.trim();
}


function cleanSelectedSkills(provider, value, workspacePath = null) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("skills must be an array of skill ids"), { status: 400 });
  }
  if (value.length > maxJobSkills) {
    throw Object.assign(new Error(`skills may include at most ${maxJobSkills} entries`), { status: 400 });
  }

  const available = new Map(listProviderSkills(provider, workspacePath).map((skill) => [skill.id, skill]));
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
  const label = provider === "claude" ? "Claude" : provider === "cursor" ? "Cursor" : "Codex";
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


function removePersistedJobFiles(job) {
  store.deleteJob(job.id);
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


function cancelJob(job) {
  if (terminalStatuses.has(job.status)) {
    throw Object.assign(new Error("job is already finished"), { status: 409 });
  }

  if (job.status === "queued") {
    jobsState.queuedJobIds = jobsState.queuedJobIds.filter((id) => id !== job.id);
    const finishedAt = nowIso();
    job.status = "cancelled";
    job.updatedAt = finishedAt;
    job.finishedAt = finishedAt;
    job.durationMs = 0;
    job.exitCode = null;
    job.timedOut = false;
    job.result = null;
    job.error = "job cancelled before start";
    touchJob(job, "job_cancelled");
    processQueue();
    return job;
  }

  const active = activeChildren.get(job.id);
  if (!active) {
    throw Object.assign(new Error("job is not active"), { status: 409 });
  }

  active.cancelRequested = true;
  approvalStore.cancelPendingForJob(job.id, "Job cancelled from Relay.");
  job.updatedAt = nowIso();
  job.error = "cancellation requested";
  touchJob(job, "job_cancel_requested");
  terminateChild(active);
  return job;
}


function processQueue() {
  while (activeChildren.size < maxConcurrent && jobsState.queuedJobIds.length > 0) {
    const id = jobsState.queuedJobIds.shift();
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
  // W2-MODULES worktree handoff v0: when enabled and the workspace is a git
  // repo inside the jail, the job runs in a dedicated git worktree on branch
  // relay/<job-id-prefix>. No-op (null) when disabled — the default.
  prepareJobWorkdir(job);
  touchJob(job, "job_started");

  const stdoutStream = fs.createWriteStream(job.stdoutPath, { flags: "a" });
  const stderrStream = fs.createWriteStream(job.stderrPath, { flags: "a" });
  let stdout = "";
  let stderr = "";

  const args = buildJobArgs(job);
  const childEnv = buildJobEnv(job);
  const child = spawn(jobBinary(job.provider), args, {
    cwd: job.worktree?.path || job.workspacePath,
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
    timeoutRemainingMs: job.timeoutMs,
    timeoutStartedAt: null,
    approvalPollTimer: null,
    pendingApprovalCount: 0,
    stdoutStream,
    stderrStream,
    sessionIdsBefore: job.provider === "codex" && !job.resumeSessionId ? workspaceSessionIdSet(job.workspacePath) : null,
  };
  activeChildren.set(job.id, active);

  armJobTimeout(job, active);
  active.approvalPollTimer = setInterval(() => pollJobApprovals(job, active), 200);
  active.approvalPollTimer.unref();

  function onTimeout() {
    active.timedOut = true;
    job.timedOut = true;
    job.updatedAt = nowIso();
    job.error = "job timed out";
    touchJob(job, "job_timeout_requested");
    terminateChild(active);
  }
  active.onTimeout = onTimeout;

  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
    // Notify live stream subscribers only after the chunk reaches the
    // persisted log so their file reads observe the new bytes.
    stdoutStream.write(chunk, () => notifyJobStreamData(job.id));
  });

  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
    stderrStream.write(chunk, () => notifyJobStreamData(job.id));
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

  // A provider binary may exit or close stdin before the prompt write lands
  // (crash, immediate failure, or a CLI that never reads stdin). That surfaces
  // as an EPIPE on the stdin socket which must not crash the service; the job
  // outcome is decided by the exit code.
  child.stdin.on("error", (error) => {
    if (error?.code === "EPIPE") return;
    appendAudit("job_stdin_write_failed", job, { error: error.message || String(error) });
  });
  child.stdin.end(job.codexPrompt || job.prompt);
}


function buildJobArgs(job) {
  if (job.provider === "claude") return buildClaudeArgs(job);
  if (job.provider === "cursor") return buildCursorArgs(job);
  return codexTransport === "app-server" ? [codexJobRunner] : buildCodexArgs(job);
}


function jobBinary(provider) {
  if (provider === "claude") return claudeBin;
  if (provider === "cursor") return cursorBin;
  return codexTransport === "app-server" ? process.execPath : codexBin;
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
    RELAY_JOB_ID: job.id,
    RELAY_WORKSPACE_PATH: job.worktree?.path || job.workspacePath,
    RELAY_RESULT_PATH: job.resultPath,
    RELAY_SESSION_RESULT_PATH: path.join(logsDir, `${job.id}.session-id`),
    RELAY_APPROVAL_DIR: approvalsDir,
    RELAY_CODEX_BIN: codexBin,
    RELAY_CODEX_APPROVAL_POLICY: job.approvalPolicy || "on-request",
    RELAY_CODEX_SKILL_INPUTS: JSON.stringify(job.skillInputs || []),
  };

  if (job.model) env.RELAY_MODEL = job.model;
  if (job.reasoningEffort) env.RELAY_REASONING_EFFORT = job.reasoningEffort;
  if (job.resumeSessionId) env.RELAY_RESUME_SESSION_ID = job.resumeSessionId;

  if (job.provider === "cursor") {
    // Direct Cursor subscription jobs never inherit ambient AWS credential or
    // Bedrock configuration, mirroring the direct Claude scrub.
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

  if (job.provider === "claude") {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    delete env.AWS_DEFAULT_PROFILE;
    if (claudeAwsProfile === "sigiq") {
      env.CLAUDE_AWS_PROFILE = claudeAwsProfile;
      env.AWS_PROFILE = claudeAwsProfile;
      env.AWS_SDK_LOAD_CONFIG = process.env.AWS_SDK_LOAD_CONFIG || "1";
      if (claudeAwsRegion) {
        env.AWS_REGION = claudeAwsRegion;
        env.AWS_DEFAULT_REGION = claudeAwsRegion;
      } else {
        delete env.AWS_REGION;
        delete env.AWS_DEFAULT_REGION;
      }
    } else {
      delete env.CLAUDE_AWS_PROFILE;
      delete env.CLAUDE_CODE_USE_BEDROCK;
      delete env.AWS_PROFILE;
      delete env.AWS_REGION;
      delete env.AWS_DEFAULT_REGION;
    }
  }

  return env;
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

function armJobTimeout(job, active) {
  clearTimeout(active.timeoutTimer);
  active.timeoutStartedAt = Date.now();
  active.timeoutTimer = setTimeout(active.onTimeout || (() => {
    active.timedOut = true;
    job.timedOut = true;
    job.updatedAt = nowIso();
    job.error = "job timed out";
    touchJob(job, "job_timeout_requested");
    terminateChild(active);
  }), Math.max(active.timeoutRemainingMs, 1));
  active.timeoutTimer.unref();
}

function pauseJobTimeout(active) {
  if (!active.timeoutTimer) return;
  clearTimeout(active.timeoutTimer);
  active.timeoutTimer = null;
  active.timeoutRemainingMs = Math.max(1, active.timeoutRemainingMs - (Date.now() - active.timeoutStartedAt));
}

function pollJobApprovals(job, active) {
  if (active.finalized) return;
  const count = approvalStore.pendingCount(job.id);
  if (count === active.pendingApprovalCount) return;
  const previous = active.pendingApprovalCount;
  active.pendingApprovalCount = count;
  if (previous === 0 && count > 0) {
    pauseJobTimeout(active);
    job.status = "waiting_for_approval";
    job.updatedAt = nowIso();
    touchJob(job, "job_waiting_for_approval", { count });
    void jobNotificationHook("job.needs_input", job).catch(() => null);
  } else if (previous > 0 && count === 0) {
    job.status = "running";
    job.updatedAt = nowIso();
    touchJob(job, "job_approval_resolved");
    armJobTimeout(job, active);
  }
}

// Persists a job state transition, records the audit event, and pushes a
// status notification to any live SSE stream subscribers. Every job state
// transition (start/finish/cancel/timeout) goes through this wrapper.

function touchJob(job, auditEvent, auditExtra = {}) {
  persistJob(job);
  if (auditEvent) appendAudit(auditEvent, job, auditExtra);
  notifyJobStatusChanged(job);
  emitJobStateEvent(job);
}

// W2-MODULES: publishes job.state transitions on the in-process event bus
// (GET /v1/events). Payload matches jobStatusPayload plus queuePosition.

function emitJobStateEvent(job) {
  emitEvent("job.state", {
    ...jobStatusPayload(job),
    queuePosition: job.status === "queued" ? jobsState.queuedJobIds.indexOf(job.id) + 1 || null : null,
  });
}


const jobStreamChunkBytes = 64 * 1024;


function cleanStreamOffset(value) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw Object.assign(new Error("stream offset must be a non-negative integer"), { status: 400 });
  }
  return parsed;
}

// Splits a buffer so `complete` ends on a UTF-8 code point boundary and
// `remainder` carries the trailing bytes of an incomplete sequence into the
// next chunk. Keeps streamed text valid UTF-8 across chunk boundaries.

function splitUtf8Tail(buffer) {
  let holdback = 0;
  for (let i = buffer.length - 1; i >= 0 && i >= buffer.length - 4; i -= 1) {
    const byte = buffer[i];
    if ((byte & 0b11000000) === 0b10000000) continue;
    let expected = 1;
    if ((byte & 0b11100000) === 0b11000000) expected = 2;
    else if ((byte & 0b11110000) === 0b11100000) expected = 3;
    else if ((byte & 0b11111000) === 0b11110000) expected = 4;
    const have = buffer.length - i;
    if (have < expected) holdback = have;
    break;
  }
  if (holdback === 0) return { complete: buffer, remainder: Buffer.alloc(0) };
  return {
    complete: buffer.subarray(0, buffer.length - holdback),
    remainder: Buffer.from(buffer.subarray(buffer.length - holdback)),
  };
}


function jobStatusPayload(job) {
  return {
    id: job.id,
    status: job.status,
    provider: normalizeJobProvider(job.provider),
    workspaceId: job.workspaceId || null,
    createdAt: job.createdAt || null,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    updatedAt: job.updatedAt || null,
    exitCode: job.exitCode ?? null,
    timedOut: Boolean(job.timedOut),
    error: cleanApiText(job.error || "").trim() || null,
  };
}


function makeStreamChannel(name, file, offset) {
  return { name, file, offset, remainder: Buffer.alloc(0) };
}


function safeSendSse(subscriber, event, data) {
  if (subscriber.closed) return;
  try {
    // W2-MODULES (API.md §2.1): every job-stream event carries an SSE id of
    // the form "<stdoutOffset>:<stderrOffset>:<seq>" where the offsets are
    // the byte offsets after applying this event. Clients resume with
    // Last-Event-ID; heartbeat comments carry no id.
    subscriber.seq = (subscriber.seq || 0) + 1;
    subscriber.res.write(`id: ${streamResumeOffsets(subscriber)}:${subscriber.seq}\n`);
    sendSse(subscriber.res, event, data);
  } catch {
    closeJobStream(subscriber);
  }
}


function streamResumeOffsets(subscriber) {
  const [stdoutChannel, stderrChannel] = subscriber.channels;
  const stdoutOffset = Math.max(0, stdoutChannel.offset - stdoutChannel.remainder.length);
  const stderrOffset = Math.max(0, stderrChannel.offset - stderrChannel.remainder.length);
  return `${stdoutOffset}:${stderrOffset}`;
}

// W2-MODULES: SSE stream slots are shared between job streams and the
// /v1/events feed (API.md §2.2 — "503 stream cap shared with job streams").

function tryAcquireStreamSlot() {
  if (activeJobStreamCount >= maxJobStreams) return false;
  activeJobStreamCount += 1;
  return true;
}


function releaseStreamSlot() {
  activeJobStreamCount = Math.max(0, activeJobStreamCount - 1);
}

// W2-MODULES (API.md §2.1): parses a job-stream Last-Event-ID header
// ("<stdoutOffset>:<stderrOffset>:<seq>") into resume offsets. Returns null
// when absent; throws 400 when malformed. Precedence over query offsets.

function parseJobStreamLastEventId(req) {
  const raw = headerValue(req.headers["last-event-id"]).trim();
  if (!raw) return null;
  const match = /^(\d{1,15}):(\d{1,15}):(\d{1,15})$/.exec(raw);
  if (!match) {
    throw Object.assign(new Error("last-event-id is invalid"), { status: 400 });
  }
  const stdoutOffset = Number(match[1]);
  const stderrOffset = Number(match[2]);
  if (!Number.isSafeInteger(stdoutOffset) || !Number.isSafeInteger(stderrOffset)) {
    throw Object.assign(new Error("last-event-id is invalid"), { status: 400 });
  }
  return { stdoutOffset, stderrOffset };
}

// GET /v1/codex/jobs/<id>/stream?stdoutOffset=&stderrOffset= — SSE live view
// of one job. Emits an immediate status snapshot, replays persisted logs from
// the requested byte offsets (bounded), follows live output, then sends a
// terminal `done` event with the job response and closes. Safe to call at any
// point in the job lifecycle, including after the job finished.

async function streamJobEvents(req, res, job, searchParams) {
  // Last-Event-ID resume (API.md §2.1) takes precedence over query offsets.
  const resume = parseJobStreamLastEventId(req);
  const stdoutOffset = resume ? resume.stdoutOffset : cleanStreamOffset(searchParams.get("stdoutOffset"));
  const stderrOffset = resume ? resume.stderrOffset : cleanStreamOffset(searchParams.get("stderrOffset"));
  if (!tryAcquireStreamSlot()) {
    return sendError(res, 503, "too many concurrent job streams");
  }
  initSse(res);

  ensureLogPaths(job);
  const subscriber = {
    res,
    job,
    closed: false,
    pumping: false,
    repump: false,
    finishing: false,
    heartbeatTimer: null,
    channels: [
      makeStreamChannel("stdout", job.stdoutPath, stdoutOffset),
      makeStreamChannel("stderr", job.stderrPath, stderrOffset),
    ],
  };

  let subscribers = jobStreamSubscribers.get(job.id);
  if (!subscribers) {
    subscribers = new Set();
    jobStreamSubscribers.set(job.id, subscribers);
  }
  subscribers.add(subscriber);

  subscriber.heartbeatTimer = setInterval(() => {
    if (subscriber.closed) return;
    try {
      subscriber.res.write(": heartbeat\n\n");
    } catch {
      closeJobStream(subscriber);
      return;
    }
    // Opportunistically drain bytes the log stream flushed after the last
    // data notification.
    void pumpJobStream(subscriber);
  }, jobStreamHeartbeatMs);
  subscriber.heartbeatTimer.unref();

  req.on("close", () => closeJobStream(subscriber));

  safeSendSse(subscriber, "status", jobStatusPayload(job));
  boundStreamReplayStart(subscriber);
  await pumpJobStream(subscriber);
  if (terminalStatuses.has(job.status)) {
    await finishJobStream(subscriber);
  }
}

// Bounds the initial replay: at most maxOutputBytes of persisted log per
// channel. Skipped bytes are visible to the client through the first event's
// explicit byte offset.

function boundStreamReplayStart(subscriber) {
  for (const channel of subscriber.channels) {
    let size = 0;
    try {
      size = fs.statSync(channel.file).size;
    } catch {
      continue;
    }
    if (size - channel.offset > maxOutputBytes) {
      channel.offset = size - maxOutputBytes;
    }
  }
}


async function pumpJobStream(subscriber) {
  if (subscriber.closed) return;
  if (subscriber.pumping) {
    subscriber.repump = true;
    return;
  }
  subscriber.pumping = true;
  try {
    do {
      subscriber.repump = false;
      for (const channel of subscriber.channels) {
        await drainStreamChannel(subscriber, channel);
      }
    } while (subscriber.repump && !subscriber.closed);
  } finally {
    subscriber.pumping = false;
  }
}

// Reads any new bytes for one channel from the persisted log file and emits
// them as SSE events carrying real byte offsets.

async function drainStreamChannel(subscriber, channel) {
  while (!subscriber.closed) {
    let handle;
    try {
      handle = await fsp.open(channel.file, "r");
    } catch {
      return;
    }
    let bytesRead = 0;
    const buffer = Buffer.alloc(jobStreamChunkBytes);
    try {
      ({ bytesRead } = await handle.read(buffer, 0, jobStreamChunkBytes, channel.offset));
    } finally {
      await handle.close();
    }
    if (bytesRead <= 0 || subscriber.closed) return;

    const combined = channel.remainder.length
      ? Buffer.concat([channel.remainder, buffer.subarray(0, bytesRead)])
      : buffer.subarray(0, bytesRead);
    const eventOffset = channel.offset - channel.remainder.length;
    channel.offset += bytesRead;
    const { complete, remainder } = splitUtf8Tail(combined);
    channel.remainder = remainder;
    if (complete.length > 0) {
      safeSendSse(subscriber, channel.name, { offset: eventOffset, text: complete.toString("utf8") });
    }
    if (bytesRead < jobStreamChunkBytes) return;
  }
}

// Final drain plus `done` event with the terminal job response, then close.

async function finishJobStream(subscriber) {
  if (subscriber.finishing || subscriber.closed) return;
  subscriber.finishing = true;
  await pumpJobStream(subscriber);
  if (subscriber.closed) return;
  for (const channel of subscriber.channels) {
    if (channel.remainder.length > 0) {
      safeSendSse(subscriber, channel.name, {
        offset: channel.offset - channel.remainder.length,
        text: channel.remainder.toString("utf8"),
      });
      channel.remainder = Buffer.alloc(0);
    }
  }
  const terminalResponse = await toJobResponse(subscriber.job, responseShape("preview"));
  safeSendSse(subscriber, "done", terminalResponse);
  closeJobStream(subscriber, { end: true });
}


function closeJobStream(subscriber, { end = false } = {}) {
  if (subscriber.closed) return;
  subscriber.closed = true;
  clearInterval(subscriber.heartbeatTimer);
  const subscribers = jobStreamSubscribers.get(subscriber.job.id);
  if (subscribers) {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) jobStreamSubscribers.delete(subscriber.job.id);
  }
  releaseStreamSlot();
  if (end) {
    try {
      subscriber.res.end();
    } catch {
      // Connection already gone.
    }
  }
}

// Called from the child stdout/stderr handlers after each chunk is flushed to
// the persisted log so subscribers can pick up the new bytes immediately.

function notifyJobStreamData(jobId) {
  const subscribers = jobStreamSubscribers.get(jobId);
  if (!subscribers) return;
  for (const subscriber of subscribers) {
    void pumpJobStream(subscriber);
  }
}


function notifyJobStatusChanged(job) {
  const subscribers = jobStreamSubscribers.get(job.id);
  if (!subscribers) return;
  const terminal = terminalStatuses.has(job.status);
  for (const subscriber of [...subscribers]) {
    if (subscriber.closed) continue;
    if (!subscriber.finishing) {
      safeSendSse(subscriber, "status", jobStatusPayload(job));
    }
    if (terminal) void finishJobStream(subscriber);
  }
}


async function finishJob(job, active, { code, signal, stdout, stderr, spawnError }) {
  if (active.finalized) return;
  active.finalized = true;

  clearTimeout(active.timeoutTimer);
  clearTimeout(active.killTimer);
  clearInterval(active.approvalPollTimer);
  approvalStore.cancelPendingForJob(job.id, "Job ended before this request was answered.");
  await Promise.all([finishStream(active.stdoutStream), finishStream(active.stderrStream)]);
  activeChildren.delete(job.id);

  const finishedAt = nowIso();
  const stderrText = cleanApiText(stderr).trim();
  const stdoutResultProvider = job.provider === "claude" || job.provider === "cursor";
  const resultText = stdoutResultProvider
    ? await readTextFileBounded(job.stdoutPath, maxOutputBytes)
    : await readTextFileBounded(job.resultPath, maxOutputBytes);
  const cursorResult = job.provider === "cursor" ? parseCursorResult(resultText) : null;
  const cleanResult = cleanAssistantResult(cursorResult?.result ?? resultText).trim();
  const failedOutputText = stdoutResultProvider ? cleanResult : "";

  job.updatedAt = finishedAt;
  job.finishedAt = finishedAt;
  job.durationMs = durationMs(job.startedAt, finishedAt);
  job.exitCode = code;
  job.timedOut = active.timedOut;
  const appServerSessionId = await readTextFileBounded(path.join(logsDir, `${job.id}.session-id`), 512).catch(() => "");
  job.sessionId ||= cursorResult?.sessionId || appServerSessionId.trim() || job.resumeSessionId || findNewWorkspaceSessionId(job, active.sessionIdsBefore);

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
  } else if (code === 0 && stdoutResultProvider && !cleanResult) {
    job.status = "failed";
    job.result = null;
    job.artifacts = [];
    job.error = `${job.provider === "cursor" ? "Cursor" : "Claude"} exited successfully without producing output.`;
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
      `${job.provider} exited with code ${code}${signal ? ` and signal ${signal}` : ""}`;
  }

  // W2-MODULES worktree handoff v0: on success push relay/<id-prefix> to the
  // remote (never force) and prune the worktree. No-op when worktree mode is
  // off or the job did not run in a worktree.
  await completeJobWorktree(job);
  await handoffCompletionHook(job).catch(() => null);

  touchJob(job, "job_finished", { code, signal });
  const notificationType = job.status === "succeeded" ? "job.completed" : "job.failed";
  void jobNotificationHook(notificationType, job).catch(() => null);
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
  // Keep the response internally consistent if a running job finishes while
  // asynchronous log reads are in progress. A subsequent poll will then return
  // the terminal status together with the terminal result.
  const status = job.status;
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
    status,
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
    durationMs: status === "running" && job.startedAt ? Date.now() - Date.parse(job.startedAt) : job.durationMs,
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
    approvalPolicy: job.approvalPolicy || null,
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


export {
  jobsState,
  jobs,
  activeChildren,
  jobStreamSubscribers,
  activeJobStreamCount,
  setHandoffCompletionHook,
  setJobNotificationHook,
  loadPersistedJobs,
  ensureLogPaths,
  jobPath,
  persistJob,
  responseShape,
  wantsFullLogs,
  createJob,
  enqueueJob,
  cleanProviderModel,
  cleanOptionalProvider,
  cleanJobProviderFilter,
  normalizeJobProvider,
  cleanOptionalReasoningEffort,
  cleanOptionalClaudePermissionMode,
  cleanOptionalCodexApprovalPolicy,
  cleanSelectedSkills,
  saveJobAttachments,
  decodeAttachmentData,
  cleanAttachmentFilename,
  cleanAttachmentContentType,
  promptWithAttachments,
  promptWithSelectedSkills,
  boundedSkillBody,
  removePersistedJobFiles,
  removePathInsideRoot,
  jobThreadId,
  cancelJob,
  processQueue,
  startJob,
  buildJobArgs,
  jobBinary,
  buildJobEnv,
  terminateChild,
  touchJob,
  jobStreamChunkBytes,
  cleanStreamOffset,
  splitUtf8Tail,
  jobStatusPayload,
  makeStreamChannel,
  safeSendSse,
  streamResumeOffsets,
  tryAcquireStreamSlot,
  releaseStreamSlot,
  parseJobStreamLastEventId,
  emitJobStateEvent,
  streamJobEvents,
  boundStreamReplayStart,
  pumpJobStream,
  drainStreamChannel,
  finishJobStream,
  closeJobStream,
  notifyJobStreamData,
  notifyJobStatusChanged,
  finishJob,
  scheduleRuntimeCachePrune,
  pruneRuntimeCachesIfIdle,
  pruneRuntimeCaches,
  runtimeCacheTargets,
  removePathInsideRunHome,
  finishStream,
  appendBounded,
  workspaceSessionIdSet,
  findNewWorkspaceSessionId,
  workspaceSessionEntries,
  toJobResponse,
  sanitizeAttachmentResponses,
};
