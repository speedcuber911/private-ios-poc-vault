// relayd threads.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { runHome, codexHome, threadSummaryCharacters, workspaceBrowseRoot, terminalStatuses, allowedThreadProviders, realpathOrResolve } from "./config.mjs";
import { isSafeJobId, cleanApiText } from "./util.mjs";
import { isResumableSessionId, isKimiSessionId } from "./sessionid.mjs";
import { appendAudit } from "./audit.mjs";
import { dynamicWorkspaces, workspaces, resolveWorkspaceById, browseWorkspaceForPath, cleanWorkspaceId, pathBelongsToRoot } from "./workspaces.mjs";
import { listChatThreads, chatThreadDetailResponse, deleteChatThread } from "./chat.mjs";
import { jobsState, jobs, activeChildren, responseShape, normalizeJobProvider, removePersistedJobFiles, removePathInsideRoot, jobThreadId, toJobResponse } from "./jobs.mjs";

function cleanThreadProviderFilter(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw Object.assign(new Error("provider is invalid"), { status: 400 });
  }
  const normalized = value.trim().toLowerCase();
  if (!allowedThreadProviders.has(normalized)) {
    throw Object.assign(new Error("provider must be codex, claude, cursor, kimi, azure, or bedrock"), { status: 400 });
  }
  return normalized;
}


// The gate every resume passes through, including the handoff Continue path
// (`handoff.continueHandoff` -> `jobs.enqueueJob` -> `jobs.createJob`). It
// applies the SHARED contract from sessionid.mjs — the same one
// `sessionimport.mjs` now stages by — rather than a second opinion of its own.
// While the two disagreed, a Codex handoff was staged successfully and then
// rejected here 400 `resumeSessionId is invalid`, every single time.
function cleanOptionalSessionId(value, provider = "codex") {
  if (value === undefined || value === null || value === "") return null;
  const valid = provider === "kimi" ? isKimiSessionId(value) : isResumableSessionId(value);
  if (!valid) {
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

// sessionimport.mjs stages a resumable Claude transcript at
// <runHome>/.claude/projects/<slug>/<sessionId>.jsonl (see its importSession
// and stageSessionFile) -- the exact leaf name is always `${sessionId}.jsonl`,
// never anything else. This walks that tree looking for it by exact name
// (unlike findSessionFile's substring match for Codex rollout filenames,
// which carry a timestamp prefix a Claude transcript never has) rather than
// hardcoding the slug logic itself, so a future change to how sessionimport.mjs
// derives the slug cannot silently desync this lookup from where sessions
// actually land.
//
// A real Claude session id is a client-generated UUID scoped to one cwd, so
// two DIFFERENT staged transcripts sharing one should never happen in
// practice -- but nothing here enforces that uniqueness, so if it ever does
// happen the most recently staged file is the one actually meant by "resume
// this session now", and the workspace-membership check the caller runs
// next still fails closed if even that guess lands on the wrong cwd.
function findClaudeSessionFile(sessionId) {
  const projectsDir = path.join(runHome, ".claude", "projects");
  const wantedName = `${sessionId}.jsonl`;
  let newest = null;
  let newestMtimeMs = -Infinity;
  for (const file of walkSessionFiles(projectsDir)) {
    if (path.basename(file) !== wantedName) continue;
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (newest === null || stat.mtimeMs > newestMtimeMs) {
      newest = file;
      newestMtimeMs = stat.mtimeMs;
    }
  }
  return newest;
}

// Claude's transcript format has no single "session_meta" line the way a
// Codex rollout does; sessionimport.mjs's rewriteSessionCwd instead
// rewrites a `cwd` field carried on every line to the sandbox checkout, so
// the first line with a well-formed cwd is enough to place the session in a
// workspace. (The Codex branch of the same function rewrites `payload.cwd` in
// the rollout's session_meta line, which is what readSessionMeta below reads.)
function readClaudeSessionMeta(sessionFile) {
  for (const line of readSessionLines(sessionFile)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const cwd = entry?.cwd;
    if (typeof cwd === "string" && cwd.length > 0 && !/[\0\r\n]/.test(cwd)) {
      return { cwd, provider: "claude", timestamp: cleanSessionTimestamp(entry.timestamp) };
    }
  }
  return null;
}


function findClaudeSessionMeta(sessionId) {
  const sessionFile = findClaudeSessionFile(sessionId);
  if (!sessionFile) return null;
  return readClaudeSessionMeta(sessionFile);
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

  // A session with no job yet is either a Codex rollout or a freshly staged
  // Claude handoff transcript -- check both layouts sessionimport.mjs can
  // have written before giving up. Cursor and Kimi never stage resumable
  // session files (see importSession's summary-primed fallback), so there is
  // no additional layout to check.
  const sessionMeta = findSessionMeta(sessionId) || findClaudeSessionMeta(sessionId);
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
    .concat(listChatThreads({ provider, workspace: selectedWorkspace, limit: 200 }))
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

  if (!thread) {
    return chatThreadDetailResponse(sessionId, { provider });
  }

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

  if (!sessionMatches && matchedJobs.length === 0) {
    const deletedChat = deleteChatThread(sessionId, { workspace: selectedWorkspace, provider, certSubject });
    if (deletedChat) return deletedChat;
    return null;
  }
  const activeJob = matchedJobs.find((job) => !terminalStatuses.has(job.status));
  if (activeJob) {
    throw Object.assign(new Error("thread has active jobs"), { status: 409 });
  }

  for (const job of matchedJobs) {
    jobsState.queuedJobIds = jobsState.queuedJobIds.filter((id) => id !== job.id);
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


function threadSummary(thread) {
  const sortedJobs = [...thread.jobs].sort((left, right) =>
    compareIsoDesc(left.updatedAt || left.createdAt, right.updatedAt || right.createdAt),
  );
  const lastJob = sortedJobs[0] || null;
  const activeJobCount = sortedJobs.filter((job) => !terminalStatuses.has(job.status)).length;

  return {
    id: thread.id,
    sessionId: thread.sessionId || thread.id,
    mode: "task",
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


export {
  cleanThreadProviderFilter,
  cleanOptionalSessionId,
  findSessionMeta,
  findClaudeSessionFile,
  readClaudeSessionMeta,
  findClaudeSessionMeta,
  findThreadResumeMeta,
  resumeMetaBelongsToWorkspace,
  workspaceForJob,
  workspaceForPath,
  readSessionMeta,
  cleanSessionTimestamp,
  listWorkspaceSessions,
  listWorkspaceThreads,
  resolveOptionalWorkspaceFilter,
  threadDetailResponse,
  deleteThread,
  threadSummary,
  readSessionSummary,
  readSessionMessages,
  readSessionLines,
  messageText,
  summaryText,
  userPromptSummary,
  isInjectedContextMessage,
  stripSkillInstructionPrefix,
  boundedThreadText,
  normalizedThreadText,
  isSmokeThread,
  maxIso,
  compareIsoDesc,
  walkSessionFiles,
  workspaceForSessionCwd,
  findSessionFile,
  sessionBelongsToWorkspace,
};
