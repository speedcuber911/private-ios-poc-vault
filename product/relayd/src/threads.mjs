// relayd threads.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { runHome, codexHome, dataDir, threadSummaryCharacters, threadMessageCharacters, workspaceBrowseRoot, terminalStatuses, allowedThreadProviders, realpathOrResolve, pathWithinRoot } from "./config.mjs";
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

function cursorWorkspaceHash(cwd) {
  return crypto.createHash("md5").update(String(cwd)).digest("hex");
}

function cursorProjectSlug(cwd) {
  return String(cwd).replace(/^\/+/, "").replace(/\//g, "-");
}

function readJsonObject(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readCursorMeta(sessionDir) {
  const parsed = readJsonObject(path.join(sessionDir, "meta.json"));
  const cwd = parsed?.cwd;
  if (typeof cwd !== "string" || cwd.length === 0 || /[\0\r\n]/.test(cwd)) return null;
  const createdAtMs = Number(parsed.createdAtMs);
  return {
    cwd,
    provider: "cursor",
    timestamp: Number.isFinite(createdAtMs) ? new Date(createdAtMs).toISOString() : cleanSessionTimestamp(parsed.timestamp),
  };
}

function cursorTranscriptInDir(sessionDir, sessionId) {
  const candidates = [
    path.join(sessionDir, "transcript.jsonl"),
    path.join(sessionDir, `${sessionId}.jsonl`),
  ];
  for (const file of candidates) {
    try {
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // try the next known leaf name
    }
  }
  return null;
}

function findCursorProjectTranscript(sessionId) {
  const projectsRoot = path.join(runHome, ".cursor", "projects");
  let projectNames = [];
  try {
    projectNames = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  let newest = null;
  let newestMtimeMs = -Infinity;
  for (const entry of projectNames) {
    if (!entry.isDirectory()) continue;
    const file = path.join(projectsRoot, entry.name, "agent-transcripts", sessionId, `${sessionId}.jsonl`);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (newest === null || stat.mtimeMs > newestMtimeMs) {
      newest = { file, slug: entry.name, stat };
      newestMtimeMs = stat.mtimeMs;
    }
  }
  if (!newest) return null;

  let matchedWorkspace = null;
  for (const workspace of [...workspaces.values(), ...dynamicWorkspaces.values()]) {
    if (cursorProjectSlug(workspace.path) === newest.slug || cursorProjectSlug(realpathOrResolve(workspace.path)) === newest.slug) {
      if (!matchedWorkspace || workspace.path.length > matchedWorkspace.path.length) matchedWorkspace = workspace;
    }
  }
  return {
    id: sessionId,
    cwd: matchedWorkspace?.path || null,
    provider: "cursor",
    timestamp: newest.stat.mtime.toISOString(),
    file: newest.file,
    sessionDir: path.dirname(newest.file),
    updatedAt: newest.stat.mtime.toISOString(),
    workspace: matchedWorkspace,
  };
}

function findCursorSession(sessionId) {
  if (!isResumableSessionId(sessionId)) return null;
  const chatsRoot = path.join(runHome, ".cursor", "chats");
  let buckets = [];
  try {
    buckets = fs.readdirSync(chatsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  let newest = null;
  let newestMtimeMs = -Infinity;
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || !/^[a-f0-9]{32}$/.test(bucket.name)) continue;
    const sessionDir = path.join(chatsRoot, bucket.name, sessionId);
    let stat;
    try {
      stat = fs.statSync(sessionDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const meta = readCursorMeta(sessionDir);
    if (!meta) continue;
    if (newest === null || stat.mtimeMs > newestMtimeMs) {
      newest = {
        id: sessionId,
        ...meta,
        file: cursorTranscriptInDir(sessionDir, sessionId),
        sessionDir,
        updatedAt: stat.mtime.toISOString(),
      };
      newestMtimeMs = stat.mtimeMs;
    }
  }
  return newest || findCursorProjectTranscript(sessionId);
}

function findCursorSessionMeta(sessionId) {
  const session = findCursorSession(sessionId);
  if (!session?.cwd) return null;
  return { cwd: session.cwd, provider: "cursor", timestamp: session.timestamp };
}

function listCursorSessionsForWorkspace(workspace) {
  const found = new Map();
  const chatsRoot = path.join(runHome, ".cursor", "chats");
  let buckets = [];
  try {
    buckets = fs.readdirSync(chatsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || !/^[a-f0-9]{32}$/.test(bucket.name)) continue;
    let names = [];
    try {
      names = fs.readdirSync(path.join(chatsRoot, bucket.name), { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory() || !isResumableSessionId(entry.name)) continue;
      const sessionDir = path.join(chatsRoot, bucket.name, entry.name);
      const meta = readCursorMeta(sessionDir);
      if (!meta) continue;
      const sessionWorkspace = workspaceForSessionCwd(meta.cwd);
      if (!sessionWorkspace || sessionWorkspace.id !== workspace.id) continue;
      let stat;
      try {
        stat = fs.statSync(sessionDir);
      } catch {
        continue;
      }
      found.set(entry.name, {
        id: entry.name,
        provider: "cursor",
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        updatedAt: stat.mtime.toISOString(),
        file: cursorTranscriptInDir(sessionDir, entry.name),
      });
    }
  }

  for (const slug of [cursorProjectSlug(workspace.path), cursorProjectSlug(realpathOrResolve(workspace.path))]) {
    const transcriptsDir = path.join(runHome, ".cursor", "projects", slug, "agent-transcripts");
    let names = [];
    try {
      names = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory() || !isResumableSessionId(entry.name)) continue;
      if (found.has(entry.name)) {
        if (!found.get(entry.name).file) {
          const nested = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
          try {
            if (fs.statSync(nested).isFile()) found.get(entry.name).file = nested;
          } catch {
            // keep the chat metadata even when the nested transcript is missing
          }
        }
        continue;
      }
      const file = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      found.set(entry.name, {
        id: entry.name,
        provider: "cursor",
        cwd: workspace.path,
        timestamp: stat.mtime.toISOString(),
        updatedAt: stat.mtime.toISOString(),
        file,
      });
    }
  }

  return [...found.values()];
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

  // A session with no job yet is a native or staged transcript: Codex
  // rollouts, Claude Code jsonl, or Cursor chats/transcripts. Kimi still has
  // no portable file here.
  const sessionMeta = findSessionMeta(sessionId) || findClaudeSessionMeta(sessionId) || findCursorSessionMeta(sessionId);
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
  // session_meta is written at the beginning of a native Codex rollout. Read
  // a bounded prefix so listing a workspace cannot allocate every byte of a
  // long-running 100+ MiB conversation merely to learn its id and cwd.
  const stat = fs.statSync(sessionFile);
  const maxBytes = Math.min(stat.size, 1024 * 1024);
  const buffer = Buffer.alloc(maxBytes);
  const fd = fs.openSync(sessionFile, "r");
  try { fs.readSync(fd, buffer, 0, maxBytes, 0); } finally { fs.closeSync(fd); }
  const lines = buffer.toString("utf8").split("\n");
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


function recordDiscoveredSession(sessionMap, {
  id,
  sessionProvider,
  workspace,
  cwd,
  timestamp,
  updatedAt,
  file,
  includeSummary,
  syncedTitles,
}) {
  const session = {
    id,
    provider: sessionProvider,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    cwd,
    timestamp,
    updatedAt,
    title: syncedTitles.get(`${workspace.id}:${id}`) || null,
  };
  if (includeSummary && file) session.summary = readSessionSummary(file);
  sessionMap.set(id, session);
}

function listWorkspaceSessions({ workspaceId, provider = null, limit, includeSummary = false }) {
  const selectedWorkspace = resolveOptionalWorkspaceFilter(workspaceId);
  const syncedTitles = readSyncedSessionTitles();

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
    recordDiscoveredSession(sessionMap, {
      id: meta.id,
      sessionProvider,
      workspace,
      cwd: meta.cwd,
      timestamp: meta.timestamp,
      updatedAt: stat.mtime.toISOString(),
      file,
      includeSummary,
      syncedTitles,
    });
  }

  if (!provider || provider === "claude") {
    for (const file of walkSessionFiles(path.join(runHome, ".claude", "projects"))) {
      const id = path.basename(file, ".jsonl");
      if (!isResumableSessionId(id)) continue;
      const meta = readClaudeSessionMeta(file);
      if (!meta) continue;
      const workspace = workspaceForSessionCwd(meta.cwd);
      if (!workspace) continue;
      if (selectedWorkspace && workspace.id !== selectedWorkspace.id) continue;
      const stat = fs.statSync(file);
      recordDiscoveredSession(sessionMap, {
        id,
        sessionProvider: "claude",
        workspace,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        updatedAt: stat.mtime.toISOString(),
        file,
        includeSummary,
        syncedTitles,
      });
    }
  }

  if (!provider || provider === "cursor") {
    const cursorWorkspaces = selectedWorkspace
      ? [selectedWorkspace]
      : [...workspaces.values(), ...dynamicWorkspaces.values()];
    for (const workspace of cursorWorkspaces) {
      for (const session of listCursorSessionsForWorkspace(workspace)) {
        recordDiscoveredSession(sessionMap, {
          id: session.id,
          sessionProvider: "cursor",
          workspace,
          cwd: session.cwd,
          timestamp: session.timestamp,
          updatedAt: session.updatedAt,
          file: session.file,
          includeSummary,
          syncedTitles,
        });
      }
    }
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


function threadFromSessionFile(sessionFile, {
  id,
  sessionProvider,
  workspace,
  cwd,
  timestamp,
  updatedAt,
}) {
  const syncedTitle = readSyncedSessionTitles().get(`${workspace.id}:${id}`) || null;
  return {
    id,
    sessionId: id,
    provider: sessionProvider,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    cwd,
    timestamp,
    updatedAt,
    title: syncedTitle,
    hasSessionFile: true,
    summary: sessionFile ? readSessionSummary(sessionFile) : { firstUserPrompt: syncedTitle, lastAssistantAnswer: null },
    jobs: [],
  };
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
      thread = threadFromSessionFile(sessionFile, {
        id: meta.id,
        sessionProvider,
        workspace,
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        updatedAt: stat.mtime.toISOString(),
      });
      messages = await readSessionMessages(sessionFile);
    }
  }

  if (!thread) {
    const claudeFile = findClaudeSessionFile(sessionId);
    const claudeMeta = claudeFile ? readClaudeSessionMeta(claudeFile) : null;
    const workspace = claudeMeta ? workspaceForSessionCwd(claudeMeta.cwd) : null;
    if (claudeFile && workspace && (!provider || provider === "claude")) {
      const stat = fs.statSync(claudeFile);
      thread = threadFromSessionFile(claudeFile, {
        id: sessionId,
        sessionProvider: "claude",
        workspace,
        cwd: claudeMeta.cwd,
        timestamp: claudeMeta.timestamp,
        updatedAt: stat.mtime.toISOString(),
      });
      messages = await readSessionMessages(claudeFile);
    }
  }

  if (!thread) {
    const cursor = findCursorSession(sessionId);
    const workspace = cursor?.workspace || (cursor?.cwd ? workspaceForSessionCwd(cursor.cwd) : null);
    if (cursor && workspace && (!provider || provider === "cursor")) {
      thread = threadFromSessionFile(cursor.file, {
        id: sessionId,
        sessionProvider: "cursor",
        workspace,
        cwd: cursor.cwd || workspace.path,
        timestamp: cursor.timestamp,
        updatedAt: cursor.updatedAt,
      });
      if (cursor.file) messages = await readSessionMessages(cursor.file);
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

  const claudeFile = findClaudeSessionFile(sessionId);
  const claudeMeta = claudeFile ? readClaudeSessionMeta(claudeFile) : null;
  const claudeWorkspace = claudeMeta ? workspaceForSessionCwd(claudeMeta.cwd) : null;
  const claudeMatches =
    Boolean(claudeFile && claudeMeta && claudeWorkspace) &&
    (!provider || provider === "claude") &&
    (!selectedWorkspace || claudeWorkspace.id === selectedWorkspace.id);

  const cursor = findCursorSession(sessionId);
  const cursorWorkspace = cursor?.workspace || (cursor?.cwd ? workspaceForSessionCwd(cursor.cwd) : null);
  const cursorMatches =
    Boolean(cursor && cursorWorkspace) &&
    (!provider || provider === "cursor") &&
    (!selectedWorkspace || cursorWorkspace.id === selectedWorkspace.id);

  const matchedJobs = [...jobs.values()].filter((job) => {
    if (jobThreadId(job) !== sessionId) return false;
    const jobProvider = normalizeJobProvider(job.provider);
    if (provider && jobProvider !== provider) return false;
    const workspace = workspaceForJob(job);
    if (!workspace) return false;
    if (selectedWorkspace && workspace.id !== selectedWorkspace.id) return false;
    return true;
  });

  if (!sessionMatches && !claudeMatches && !cursorMatches && matchedJobs.length === 0) {
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

  const deletedCodexFile = sessionMatches ? removePathInsideRoot(sessionFile, sessionsDir) : false;
  const deletedClaudeFile = claudeMatches
    ? removePathInsideRoot(claudeFile, path.join(runHome, ".claude", "projects"))
    : false;
  let deletedCursorFile = false;
  if (cursorMatches) {
    const cursorRoot = path.join(runHome, ".cursor");
    if (cursor.file) deletedCursorFile = removePathInsideRoot(cursor.file, cursorRoot);
    if (cursor.sessionDir) {
      const metaFile = path.join(cursor.sessionDir, "meta.json");
      removePathInsideRoot(metaFile, cursorRoot);
    }
  }
  const deletedSessionFile = deletedCodexFile || deletedClaudeFile || deletedCursorFile;
  const workspaceForAudit = selectedWorkspace || sessionWorkspace || claudeWorkspace || cursorWorkspace || workspaceForJob(matchedJobs[0]);
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
  const title = summaryText(thread.title) || thread.summary?.firstUserPrompt || summaryText(lastJob?.prompt) || null;

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
    title,
    lastPrompt: title,
    lastResult: summaryText(lastJob?.result) || thread.summary?.lastAssistantAnswer || null,
    lastError: cleanApiText(lastJob?.error || "").trim() || null,
    hasSessionFile: Boolean(thread.hasSessionFile),
    isSmokeTest: isSmokeThread(lastJob),
  };
}


const SKIP_CONTENT_TYPES = new Set([
  "tool_use",
  "tool_result",
  "thinking",
  "redacted_thinking",
  "function_call",
  "function_call_output",
  "server_tool_use",
]);

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => firstText(item?.text ?? item?.content ?? item?.input_text ?? item?.output_text ?? item))
      .filter(Boolean)
      .join("\n\n");
  }
  if (value && typeof value === "object") {
    return firstText(value.text ?? value.content ?? value.input_text ?? value.output_text ?? "");
  }
  return "";
}

function contentPartsText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    if (content && typeof content === "object" && SKIP_CONTENT_TYPES.has(content.type)) return "";
    return firstText(content);
  }
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (SKIP_CONTENT_TYPES.has(item.type)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.input_text === "string") return item.input_text;
      if (typeof item.output_text === "string") return item.output_text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function parseTranscriptTurn(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type === "response_item" && entry.payload?.type === "message") {
    const role = entry.payload.role;
    if (role !== "user" && role !== "assistant") return null;
    return { role, text: messageText(entry.payload), timestamp: cleanSessionTimestamp(entry.timestamp) };
  }
  if (entry.type === "user" || entry.type === "assistant") {
    const text = contentPartsText(entry.message?.content ?? entry.message ?? entry.text);
    if (!text) return null;
    return { role: entry.type, text, timestamp: cleanSessionTimestamp(entry.timestamp) };
  }
  if (entry.role === "user" || entry.role === "assistant") {
    const text = contentPartsText(entry.message?.content ?? entry.message ?? entry.text);
    if (!text) return null;
    return { role: entry.role, text, timestamp: cleanSessionTimestamp(entry.timestamp) };
  }
  return null;
}

function readSessionSummary(sessionFile) {
  let firstUserPrompt = null;
  let lastAssistantAnswer = null;

  for (const line of readSessionLines(sessionFile, { fromEnd: false })) {
    if (!line.trim()) continue;
    try {
      const turn = parseTranscriptTurn(JSON.parse(line));
      if (turn?.role === "user" && !firstUserPrompt) {
        firstUserPrompt = userPromptSummary(turn.text);
      }
    } catch {
      continue;
    }
  }

  for (const line of readSessionLines(sessionFile, { fromEnd: true })) {
    if (!line.trim()) continue;
    try {
      const turn = parseTranscriptTurn(JSON.parse(line));
      if (turn?.role !== "assistant") continue;
      lastAssistantAnswer = boundedThreadText(turn.text);
      break;
    } catch {
      continue;
    }
  }

  return { firstUserPrompt, lastAssistantAnswer };
}


async function readSessionMessages(sessionFile) {
  const messages = [];
  const input = fs.createReadStream(sessionFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const turn = parseTranscriptTurn(JSON.parse(line));
      if (!turn) continue;

      const cleanText = turn.role === "user" ? userPromptText(turn.text) : cleanThreadMessageText(turn.text);
      const text = boundedThreadMessageText(cleanText);
      if (!text) continue;

      messages.push({
        role: turn.role,
        timestamp: turn.timestamp,
        text,
      });
      if (messages.length > 120) messages.shift();
    } catch {
      continue;
    }
  }
  return messages;
}


function readSessionLines(sessionFile, { fromEnd = true, maxBytes = 1024 * 1024 } = {}) {
  const stat = fs.statSync(sessionFile);
  if (stat.size <= maxBytes) {
    return fs.readFileSync(sessionFile, "utf8").split("\n");
  }

  const buffer = Buffer.alloc(maxBytes);
  const position = fromEnd ? stat.size - maxBytes : 0;
  const fd = fs.openSync(sessionFile, "r");
  try {
    fs.readSync(fd, buffer, 0, maxBytes, position);
    const lines = buffer.toString("utf8").split("\n");
    if (fromEnd) lines.shift();
    else lines.pop();
    return lines;
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
  return boundedThreadText(userPromptText(value));
}


const SYNTHETIC_USER_TAGS = [
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "system-reminder",
  "user-prompt-submit-hook",
  "environment_context",
  "user_instructions",
  "in-app-browser-context",
  "recommended_plugins",
  "app-context",
  "skills_instructions",
  "apps_instructions",
  "plugins_instructions",
  "collaboration_mode",
  "multi_agent_mode",
  "send_user_message_question_reply",
];
const SYNTHETIC_USER_TAG_PATTERN = SYNTHETIC_USER_TAGS.join("|");
const SYNTHETIC_USER_BLOCK_RE = new RegExp(
  `<(${SYNTHETIC_USER_TAG_PATTERN})(?:\\s[^>]*)?>[\\s\\S]*?</\\1\\s*>`,
  "gi",
);
const SYNTHETIC_USER_OPEN_RE = new RegExp(`<(?:${SYNTHETIC_USER_TAG_PATTERN})(?:\\s[^>]*)?>`, "i");
const SYNTHETIC_USER_STRAY_RE = new RegExp(
  `</?(?:${SYNTHETIC_USER_TAG_PATTERN})(?:\\s[^>]*)?>`,
  "gi",
);
const USER_REQUEST_HEADING_RE = /^#{1,3}\s+My request:\s*$/im;
const ATTACHED_IMAGE_OPEN_RE = /<image\s+name=\[[^\]]+\]\s+path="[^"]*">/i;
const INJECTED_DOCUMENT_PREFIX_RE = /^(?:# AGENTS\.md instructions for\b|# Files mentioned by the user:\s*|<permissions instructions>)/i;


function questionReplyText(value) {
  const match = /^\s*<send_user_message_question_reply>([\s\S]*)<\/send_user_message_question_reply>\s*$/i.exec(String(value ?? ""));
  if (!match) return null;
  let replies;
  try { replies = JSON.parse(match[1]); } catch { return ""; }
  if (!Array.isArray(replies)) return "";
  return replies
    .map((reply) => typeof reply?.answer === "string" ? reply.answer.trim() : "")
    .filter(Boolean)
    .join("\n");
}


const CURSOR_HOUSEKEEPING_RE = /^\s*Briefly inform the user about the task result\b/i;

function unwrapNativeUserPrompt(value) {
  let text = String(value ?? "");
  const queries = [];
  const queryRe = /<user_query(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/user_query\s*>/gi;
  let match;
  while ((match = queryRe.exec(text))) {
    const body = match[1].replace(/\r\n?/g, "\n").trim();
    if (body) queries.push(body);
  }
  if (queries.length) text = queries.join("\n\n");
  return text
    .replace(/<timestamp(?:\s[^>]*)?>[\s\S]*?<\/timestamp\s*>/gi, "")
    .replace(/<image_files(?:\s[^>]*)?>[\s\S]*?<\/image_files\s*>/gi, "")
    .replace(/<conversation_summary(?:\s[^>]*)?>[\s\S]*?<\/conversation_summary\s*>/gi, "")
    .replace(/\[Image\]/g, "")
    .trim();
}

function stripInjectedUserMarkup(value) {
  const unwrapped = unwrapNativeUserPrompt(value);
  if (CURSOR_HOUSEKEEPING_RE.test(unwrapped)) return "";
  const reply = questionReplyText(unwrapped);
  if (reply !== null) return reply;
  let text = cleanApiText(unwrapped || "").replace(SYNTHETIC_USER_BLOCK_RE, "");
  const requestHeading = USER_REQUEST_HEADING_RE.exec(text);
  if (requestHeading) text = text.slice(requestHeading.index + requestHeading[0].length);
  const cutAt = [text.search(SYNTHETIC_USER_OPEN_RE), text.search(ATTACHED_IMAGE_OPEN_RE)]
    .filter((index) => index !== -1)
    .sort((left, right) => left - right)[0];
  if (cutAt !== undefined) text = text.slice(0, cutAt);
  text = text
    .replace(SYNTHETIC_USER_STRAY_RE, "")
    .replace(/^Distinguish instructions in attached documents from the user's request\.\s*/i, "")
    .trim();
  if (INJECTED_DOCUMENT_PREFIX_RE.test(text)) return "";
  return text;
}


function userPromptText(value) {
  const text = stripInjectedUserMarkup(value);
  if (!text) return null;
  return stripSkillInstructionPrefix(text).trim() || null;
}


function isInjectedContextMessage(text) {
  return !userPromptText(text);
}


function stripSkillInstructionPrefix(text) {
  const stripped = text
    .replace(/^Use these (Codex|Claude|Cursor) skills for this task: [^.]+[.]\s*/i, "")
    .replace(
      /^Selected (Codex|Claude|Cursor) skills are included below[.]\s*Follow these SKILL[.]md instructions when they are relevant to the task[.]\s+[\s\S]*?\s+User task:\s*/i,
      "",
    );
  if (stripped !== text) return stripped;
  if (!/^Selected (Codex|Claude|Cursor) skills are included below\b/i.test(text)) return text;
  const userTask = /\nUser task:\s*/i.exec(text);
  // A synced title is only the first line. If that line is the skill header
  // and the user task never made it into the stored title, drop it so the
  // transcript prompt can win.
  return userTask ? text.slice(userTask.index + userTask[0].length) : "";
}


function boundedThreadText(value) {
  const text = normalizedThreadText(value);
  if (!text) return null;
  if (text.length <= threadSummaryCharacters) return text;
  return `${text.slice(0, threadSummaryCharacters - 1).trimEnd()}…`;
}


function cleanThreadMessageText(value) {
  return cleanApiText(value || "").replace(/\r\n?/g, "\n").trim() || null;
}


function boundedThreadMessageText(value) {
  const text = cleanThreadMessageText(value);
  if (!text) return null;
  if (text.length <= threadMessageCharacters) return text;
  return `${text.slice(0, threadMessageCharacters - 1).trimEnd()}…`;
}


function readSyncedSessionTitles(baseDir = dataDir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(baseDir, "session-sync", "index.json"), "utf8"));
  } catch {
    return new Map();
  }
  if (!parsed?.sessions || typeof parsed.sessions !== "object" || Array.isArray(parsed.sessions)) return new Map();
  const titles = new Map();
  for (const record of Object.values(parsed.sessions)) {
    if (!record || typeof record !== "object") continue;
    if (typeof record.workspaceId !== "string" || typeof record.sessionId !== "string") continue;
    const title = userPromptSummary(record.title);
    if (title) titles.set(`${record.workspaceId}:${record.sessionId}`, title);
  }
  return titles;
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
    pathWithinRoot(resolvedSessionCwd, resolvedWorkspacePath)
  );
}


export {
  cleanThreadProviderFilter,
  cleanOptionalSessionId,
  findSessionMeta,
  findClaudeSessionFile,
  readClaudeSessionMeta,
  findClaudeSessionMeta,
  findCursorSession,
  findCursorSessionMeta,
  cursorWorkspaceHash,
  listCursorSessionsForWorkspace,
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
  userPromptText,
  userPromptSummary,
  isInjectedContextMessage,
  stripSkillInstructionPrefix,
  boundedThreadText,
  boundedThreadMessageText,
  readSyncedSessionTitles,
  normalizedThreadText,
  isSmokeThread,
  maxIso,
  compareIsoDesc,
  walkSessionFiles,
  workspaceForSessionCwd,
  findSessionFile,
  sessionBelongsToWorkspace,
};
