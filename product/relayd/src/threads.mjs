// relayd threads.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { runHome, codexHome, dataDir, attachmentsDir, threadSummaryCharacters, threadMessageCharacters, workspaceBrowseRoot, terminalStatuses, allowedThreadProviders, realpathOrResolve, pathWithinRoot } from "./config.mjs";
import { isSafeJobId, cleanApiText, sendBytes, sendError } from "./util.mjs";
import { isResumableSessionId, isKimiSessionId, isThreadSessionId } from "./sessionid.mjs";
import { appendAudit } from "./audit.mjs";
import { dynamicWorkspaces, workspaces, resolveWorkspaceById, browseWorkspaceForPath, cleanWorkspaceId, pathBelongsToRoot } from "./workspaces.mjs";
import { listChatThreads, chatThreadDetailResponse, deleteChatThread } from "./chat.mjs";
import { jobsState, jobs, activeChildren, responseShape, normalizeJobProvider, removePersistedJobFiles, removePathInsideRoot, jobThreadId, toJobResponse, attachmentKind } from "./jobs.mjs";

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

function cursorSlugCandidates(workspace) {
  return [...new Set([
    cursorProjectSlug(workspace.path),
    cursorProjectSlug(realpathOrResolve(workspace.path)),
  ])];
}

function cursorTranscriptUpdatedAt(file, directoryStat) {
  if (!file) return directoryStat.mtime.toISOString();
  try {
    const stat = fs.statSync(file);
    if (stat.isFile() && stat.mtimeMs > directoryStat.mtimeMs) return stat.mtime.toISOString();
  } catch {
    // The chat folder still has a usable timestamp when the transcript leaf is missing.
  }
  return directoryStat.mtime.toISOString();
}

function cursorLoggedWorkspacePath(projectDir) {
  let fd;
  try {
    fd = fs.openSync(path.join(projectDir, "worker.log"), "r");
    const buf = Buffer.alloc(65536);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const match = buf.subarray(0, read).toString("utf8").match(/workspacePath=([^\s\0]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function workspaceForCursorProjectName(projectName, projectDir) {
  let matched = null;
  for (const workspace of [...workspaces.values(), ...dynamicWorkspaces.values()]) {
    if (!cursorSlugCandidates(workspace).includes(projectName)) continue;
    if (!matched || workspace.path.length > matched.path.length) matched = workspace;
  }
  if (matched) return matched;
  // Cursor truncates long paths and appends a short hash. The folder name is
  // then no longer the workspace slug, so the log's workspacePath is the link.
  const hashed = /^(.+)-[0-9a-f]{6,8}$/.exec(projectName);
  if (!hashed || hashed[1].length < 20) return null;
  const logged = cursorLoggedWorkspacePath(projectDir);
  if (!logged) return null;
  return workspaceForPath(logged);
}

function cursorProjectDirsForWorkspace(workspace) {
  const projectsRoot = path.join(runHome, ".cursor", "projects");
  let entries = [];
  try {
    entries = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return [];
  }
  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(projectsRoot, entry.name);
    if (workspaceForCursorProjectName(entry.name, projectDir)?.id === workspace.id) dirs.push(projectDir);
  }
  return dirs;
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

  const matchedWorkspace = workspaceForCursorProjectName(newest.slug, path.join(projectsRoot, newest.slug));
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

function materializeCursorChatWorkspaces() {
  const chatsRoot = path.join(runHome, ".cursor", "chats");
  let buckets = [];
  try {
    buckets = fs.readdirSync(chatsRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return;
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
      const meta = readCursorMeta(path.join(chatsRoot, bucket.name, entry.name));
      if (meta?.cwd) workspaceForSessionCwd(meta.cwd);
    }
  }
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
      const file = cursorTranscriptInDir(sessionDir, entry.name);
      found.set(entry.name, {
        id: entry.name,
        provider: "cursor",
        cwd: meta.cwd,
        timestamp: meta.timestamp,
        updatedAt: cursorTranscriptUpdatedAt(file, stat),
        file,
      });
    }
  }

  for (const projectDir of cursorProjectDirsForWorkspace(workspace)) {
    const transcriptsDir = path.join(projectDir, "agent-transcripts");
    let names = [];
    try {
      names = fs.readdirSync(transcriptsDir, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      continue;
    }
    for (const entry of names) {
      if (!entry.isDirectory() || !isResumableSessionId(entry.name)) continue;
      const file = path.join(transcriptsDir, entry.name, `${entry.name}.jsonl`);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const existing = found.get(entry.name);
      if (existing) {
        if (!existing.file) existing.file = file;
        const updatedAt = stat.mtime.toISOString();
        if (Date.parse(updatedAt) > Date.parse(existing.updatedAt || 0)) existing.updatedAt = updatedAt;
        continue;
      }
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
    if (!selectedWorkspace) materializeCursorChatWorkspaces();
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
    .sort((left, right) => {
      const liveDelta = Number(Boolean(right.live || right.activeJobCount)) - Number(Boolean(left.live || left.activeJobCount));
      if (liveDelta) return liveDelta;
      return compareIsoDesc(left.updatedAt, right.updatedAt);
    })
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
  const state = await loadThreadDetailState(sessionId, { provider });
  if (!state) return null;
  if (state.chatDetail) return state.chatDetail;
  mergeJobAttachmentsIntoMessages(state.messages, state.thread.jobs, state.thread.sessionId || sessionId);
  const sortedJobs = [...state.thread.jobs].sort((left, right) =>
    compareIsoDesc(left.updatedAt || left.createdAt, right.updatedAt || right.createdAt),
  );
  return {
    thread: threadSummary(state.thread),
    messages: publicThreadMessages(state.messages),
    jobs: await Promise.all(sortedJobs.map((job) => toJobResponse(job, responseShape("compact")))),
  };
}


async function loadThreadDetailState(sessionId, { provider = null } = {}) {
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
      messages = await readSessionMessages(sessionFile, { sessionId: meta.id });
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
      messages = await readSessionMessages(claudeFile, { sessionId });
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
      if (cursor.file) messages = await readSessionMessages(cursor.file, { sessionId });
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
    const chatDetail = chatThreadDetailResponse(sessionId, { provider });
    if (!chatDetail) return null;
    return { chatDetail };
  }

  return { thread, messages };
}


function isSafeThreadAttachmentId(value) {
  return typeof value === "string" && /^[a-f0-9]{16}$/.test(value);
}

function publicThreadMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => ({
    role: message.role,
    timestamp: message.timestamp || null,
    text: message.text || "",
    attachments: publicAttachments(message.attachments),
  }));
}

function publicAttachments(attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    bytes: attachment.bytes ?? null,
    kind: attachment.kind || "file",
    rawURL: attachment.rawURL || null,
  }));
}

function mergeJobAttachmentsIntoMessages(messages, jobs, sessionId) {
  const list = Array.isArray(messages) ? messages : [];
  const sorted = [...(Array.isArray(jobs) ? jobs : [])].sort(
    (left, right) => Date.parse(left.createdAt || 0) - Date.parse(right.createdAt || 0),
  );
  for (const job of sorted) {
    const attachments = (Array.isArray(job.attachments) ? job.attachments : [])
      .map((attachment, index) => jobAttachmentRecord(job, attachment, index, sessionId))
      .filter(Boolean);
    if (!attachments.length) continue;
    const prompt = userPromptText(job.prompt) || String(job.prompt || "").trim();
    const match = [...list].reverse().find((message) => (
      message.role === "user" && (message.text || "") === prompt
    ));
    if (match) {
      match.attachments = dedupeAttachments([...(match.attachments || []), ...attachments]);
    } else {
      list.push({
        role: "user",
        timestamp: job.createdAt || null,
        text: prompt,
        attachments,
      });
    }
  }
}

function jobAttachmentRecord(job, attachment, index, sessionId) {
  if (!attachment || typeof attachment !== "object") return null;
  const filename = cleanApiText(attachment.filename || path.basename(attachment.path || "") || "attachment");
  const contentType = cleanApiText(attachment.contentType || mimeFromFilename(filename));
  const finalized = finalizeAttachments(sessionId || job.id, [{
    filename,
    contentType,
    bytes: attachment.bytes,
    path: attachment.path,
  }])[0];
  if (!finalized) return null;
  finalized.rawURL = `/v1/codex/jobs/${job.id}/attachments/${index}/raw`;
  finalized.readable = true;
  return finalized;
}

function dedupeAttachments(attachments) {
  const seen = new Set();
  const out = [];
  for (const attachment of attachments) {
    const key = attachment.path || attachment.rawURL || attachment.id || attachment.filename;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
  }
  return out;
}

async function serveThreadAttachment(res, sessionId, attachmentId, { provider = null } = {}) {
  if (!isThreadSessionId(sessionId) || !isSafeThreadAttachmentId(attachmentId)) {
    return sendError(res, 404, "attachment not found");
  }
  const state = await loadThreadDetailState(sessionId, { provider });
  if (!state || state.chatDetail) return sendError(res, 404, "attachment not found");
  mergeJobAttachmentsIntoMessages(state.messages, state.thread.jobs, state.thread.sessionId || sessionId);
  const attachment = (state.messages || [])
    .flatMap((message) => message.attachments || [])
    .find((entry) => entry.id === attachmentId);
  if (!attachment) return sendError(res, 404, "attachment not found");

  let body = attachment.data || null;
  if (!body && attachment.path) {
    const resolved = tryResolveReadableAttachment(attachment.path);
    if (!resolved) return sendError(res, 404, "attachment not found");
    try {
      body = fs.readFileSync(resolved.path);
    } catch {
      return sendError(res, 404, "attachment not found");
    }
  }
  if (!body || !body.length) return sendError(res, 404, "attachment not found");

  const filename = attachment.filename || "attachment.bin";
  const contentType = attachment.contentType || mimeFromFilename(filename);
  const kind = attachment.kind || attachmentKind(filename, contentType);
  return sendBytes(res, 200, body, {
    "content-type": contentType,
    "content-disposition": `${kind === "image" ? "inline" : "attachment"}; filename="${String(filename).replace(/["\r\n\\]/g, "-")}"`,
    "x-content-type-options": "nosniff",
  });
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


const NATIVE_LIVE_WINDOW_MS = 3 * 60 * 1000;
const NATIVE_CONTINUATION_SLACK_MS = 15 * 1000;

function threadSummary(thread) {
  const sortedJobs = [...thread.jobs].sort((left, right) =>
    compareIsoDesc(left.updatedAt || left.createdAt, right.updatedAt || right.createdAt),
  );
  const lastJob = sortedJobs[0] || null;
  const activeJobCount = sortedJobs.filter((job) => !terminalStatuses.has(job.status)).length;
  const title = summaryText(thread.title) || thread.summary?.firstUserPrompt || summaryText(lastJob?.prompt) || null;
  const updatedMs = Date.parse(thread.updatedAt || "");
  // A transcript touched in the last few minutes is a session running on the
  // machine. Relay jobs already count through activeJobCount; a native resume
  // of an older finished job still counts when the transcript moves again
  // after that job. The slack keeps the final flush of a Relay job from
  // looking like a new run.
  const fresh = Number.isFinite(updatedMs) && Date.now() - updatedMs < NATIVE_LIVE_WINDOW_MS;
  const lastJobMs = Date.parse(lastJob?.updatedAt || lastJob?.createdAt || "");
  const continuedNatively = !lastJob || (Number.isFinite(lastJobMs) && updatedMs - lastJobMs > NATIVE_CONTINUATION_SLACK_MS);
  const live = activeJobCount > 0 || (fresh && continuedNatively);

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
    live,
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

  const take = (role, rawText, content, timestamp) => {
    const attachments = extractTurnAttachments(rawText, content);
    const cleaned = role === "user" ? userPromptText(rawText) : cleanThreadMessageText(rawText);
    const text = cleaned || "";
    if (!text && attachments.length === 0) return null;
    return { role, text, timestamp: cleanSessionTimestamp(timestamp), attachments };
  };

  if (entry.type === "response_item" && entry.payload?.type === "message") {
    const role = entry.payload.role;
    if (role !== "user" && role !== "assistant") return null;
    const content = Array.isArray(entry.payload.content) ? entry.payload.content : [];
    return take(role, messageText(entry.payload), content, entry.timestamp);
  }
  if (entry.type === "user" || entry.type === "assistant") {
    const content = entry.message?.content ?? entry.message ?? entry.content ?? entry.text;
    const parts = Array.isArray(content) ? content : Array.isArray(content?.content) ? content.content : [];
    return take(entry.type, contentPartsText(content), parts, entry.timestamp);
  }
  if (entry.role === "user" || entry.role === "assistant") {
    const content = entry.message?.content ?? entry.message ?? entry.content ?? entry.text;
    const parts = Array.isArray(content) ? content : [];
    return take(entry.role, contentPartsText(content), parts, entry.timestamp);
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
        firstUserPrompt = userPromptSummary(turn.text)
          || (turn.attachments?.[0]?.filename ? boundedThreadText(turn.attachments[0].filename) : null);
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


async function readSessionMessages(sessionFile, { sessionId = null } = {}) {
  const messages = [];
  const id = sessionId || path.basename(sessionFile, path.extname(sessionFile));
  const input = fs.createReadStream(sessionFile, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    try {
      const turn = parseTranscriptTurn(JSON.parse(line));
      if (!turn) continue;

      const cleanText = turn.role === "user" ? turn.text : cleanThreadMessageText(turn.text);
      const text = boundedThreadMessageText(cleanText) || "";
      const attachments = finalizeAttachments(id, turn.attachments);
      if (!text && attachments.length === 0) continue;

      messages.push({
        role: turn.role,
        timestamp: turn.timestamp,
        text,
        attachments,
      });
      if (messages.length > 120) messages.shift();
    } catch {
      continue;
    }
  }
  return messages;
}


const IMAGE_TAG_RE = /<image\s+name=\[([^\]]+)\]\s+path="([^"]*)"\s*>/gi;
const IMAGE_FILES_BLOCK_RE = /<image_files(?:\s[^>]*)?>([\s\S]*?)<\/image_files\s*>/gi;
const PHONE_ATTACHMENT_MANIFEST_RE = /Attached files from the phone are saved on this runner\. Use these local paths when inspecting them:\n([\s\S]*)$/i;
const FILES_MENTIONED_BLOCK_RE = /# Files mentioned by the user:\s*\n([\s\S]*?)(?:\n#{1,3}\s+My request:|$)/i;
const FILE_MENTION_LINE_RE = /^#{1,3}\s+([^:\n]+):\s+(\S+)\s*$/gm;
const PHONE_MANIFEST_LINE_RE = /^\s*\d+\.\s+(\S+)\s+\(([^,]+),\s*(\d+)\s*bytes\):\s+(\S+)\s*$/gm;
const MIME_BY_EXTENSION = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".bmp": "image/bmp",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
};

function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || "")).toLowerCase();
  return MIME_BY_EXTENSION[ext] || "application/octet-stream";
}

function extractTurnAttachments(rawText, content) {
  const found = [];
  const seen = new Set();
  const add = (attachment) => {
    if (!attachment) return;
    const filename = cleanApiText(attachment.filename || (attachment.path ? path.basename(attachment.path) : "") || "attachment");
    const key = attachment.path || (attachment.data ? `data:${filename}:${attachment.data.length}` : filename);
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push({
      filename,
      contentType: attachment.contentType || mimeFromFilename(filename),
      bytes: Number.isFinite(attachment.bytes) ? attachment.bytes : (attachment.data ? attachment.data.length : null),
      path: attachment.path || null,
      data: attachment.data || null,
    });
  };

  const parts = Array.isArray(content) ? content : [];
  for (const part of parts) add(attachmentFromContentPart(part));

  const text = String(rawText || "");
  IMAGE_TAG_RE.lastIndex = 0;
  let tagMatch;
  while ((tagMatch = IMAGE_TAG_RE.exec(text))) {
    const filePath = tagMatch[2];
    add({
      filename: filenameFromImageName(tagMatch[1], filePath),
      path: filePath,
      contentType: mimeFromFilename(filePath),
    });
  }

  IMAGE_FILES_BLOCK_RE.lastIndex = 0;
  let blockMatch;
  while ((blockMatch = IMAGE_FILES_BLOCK_RE.exec(text))) {
    for (const candidate of blockMatch[1].split(/\s+/)) {
      const filePath = candidate.replace(/^["']|["']$/g, "").trim();
      if (!filePath || !filePath.includes("/") && !filePath.includes(".")) continue;
      if (filePath.startsWith("<") || filePath.startsWith("http")) continue;
      add({ filename: path.basename(filePath), path: filePath, contentType: mimeFromFilename(filePath) });
    }
  }

  const mentioned = FILES_MENTIONED_BLOCK_RE.exec(text);
  if (mentioned) {
    FILE_MENTION_LINE_RE.lastIndex = 0;
    let lineMatch;
    while ((lineMatch = FILE_MENTION_LINE_RE.exec(mentioned[1]))) {
      add({
        filename: path.basename(lineMatch[1].trim()) || path.basename(lineMatch[2]),
        path: lineMatch[2],
        contentType: mimeFromFilename(lineMatch[1] || lineMatch[2]),
      });
    }
  }

  const manifest = PHONE_ATTACHMENT_MANIFEST_RE.exec(text);
  if (manifest) {
    PHONE_MANIFEST_LINE_RE.lastIndex = 0;
    let lineMatch;
    while ((lineMatch = PHONE_MANIFEST_LINE_RE.exec(manifest[1]))) {
      add({
        filename: lineMatch[1],
        contentType: lineMatch[2].trim(),
        bytes: Number(lineMatch[3]),
        path: lineMatch[4],
      });
    }
  }

  return found;
}

function filenameFromImageName(name, filePath) {
  const cleaned = String(name || "").trim();
  if (!cleaned || /^image\s*#?\d+$/i.test(cleaned)) {
    return path.basename(filePath || "") || "image";
  }
  return cleaned;
}

function attachmentFromContentPart(part) {
  if (!part || typeof part !== "object") return null;
  const type = String(part.type || "").toLowerCase();
  const looksLikeFile = type.includes("image") || type === "file" || type === "input_file" || type === "input_image";
  const filePath = firstString(
    part.path,
    part.file_path,
    part.filename && part.path,
    part.source?.path,
    part.source?.file_path,
    typeof part.image_url === "string" && !part.image_url.startsWith("data:") ? part.image_url : null,
    typeof part.image_url?.url === "string" && !part.image_url.url.startsWith("data:") ? part.image_url.url : null,
    typeof part.url === "string" && !part.url.startsWith("data:") && !part.url.startsWith("http") ? part.url : null,
  );
  const data = decodeInlineImageData(part);
  if (!looksLikeFile && !filePath && !data) return null;
  if (!filePath && !data) return null;
  const filename = firstString(
    part.filename,
    part.name,
    filePath ? path.basename(filePath.replace(/^file:\/\//, "")) : null,
    "image",
  );
  return {
    filename,
    contentType: firstString(part.contentType, part.media_type, part.source?.media_type, mimeFromFilename(filename)),
    path: filePath ? filePath.replace(/^file:\/\//, "") : null,
    data,
    bytes: data ? data.length : null,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function decodeInlineImageData(part) {
  const candidates = [
    part?.source?.data,
    part?.data,
    typeof part?.image_url === "string" ? part.image_url : null,
    part?.image_url?.url,
    part?.url,
  ];
  for (const value of candidates) {
    if (typeof value !== "string" || !value) continue;
    const dataUrl = /^data:[^;]+;base64,(.+)$/i.exec(value);
    const encoded = dataUrl ? dataUrl[1] : (/^[A-Za-z0-9+/=\s]+$/.test(value) && value.length > 80 ? value : null);
    if (!encoded) continue;
    try {
      const buffer = Buffer.from(encoded.replace(/\s+/g, ""), "base64");
      if (buffer.length) return buffer;
    } catch {
      continue;
    }
  }
  return null;
}

function finalizeAttachments(sessionId, attachments) {
  return (Array.isArray(attachments) ? attachments : []).map((attachment) => {
    const filename = cleanApiText(attachment.filename || (attachment.path ? path.basename(attachment.path) : "") || "attachment");
    const contentType = attachment.contentType || mimeFromFilename(filename);
    const kind = attachmentKind(filename, contentType);
    let data = attachment.data && Buffer.isBuffer(attachment.data) && attachment.data.length ? attachment.data : null;
    let filePath = typeof attachment.path === "string" && attachment.path.trim() ? attachment.path.trim() : null;
    let bytes = Number.isFinite(attachment.bytes) ? attachment.bytes : (data ? data.length : null);
    let readable = Boolean(data);
    if (!readable && filePath) {
      const resolved = tryResolveReadableAttachment(filePath);
      if (resolved) {
        filePath = resolved.path;
        bytes = resolved.bytes;
        readable = true;
      }
    }
    const id = attachmentPublicId(sessionId, filePath || data || filename);
    return {
      id,
      filename,
      contentType,
      bytes,
      kind,
      rawURL: readable ? `/v1/codex/threads/${sessionId}/attachments/${id}/raw` : null,
      path: filePath,
      data,
      readable,
    };
  }).filter((attachment) => attachment.filename);
}

function attachmentPublicId(sessionId, key) {
  const hash = crypto.createHash("sha256");
  hash.update(String(sessionId || ""));
  hash.update("\0");
  hash.update(Buffer.isBuffer(key) ? key : Buffer.from(String(key || ""), "utf8"));
  return hash.digest("hex").slice(0, 16);
}

function tryResolveReadableAttachment(filePath) {
  try {
    const resolved = realpathOrResolve(filePath);
    if (!isAllowedAttachmentRoot(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;
    return { path: resolved, bytes: stat.size };
  } catch {
    return null;
  }
}

function isAllowedAttachmentRoot(resolved) {
  const roots = [
    attachmentsDir,
    workspaceBrowseRoot,
    path.join(runHome, ".cursor"),
    path.join(runHome, ".claude"),
  ];
  for (const root of roots) {
    let resolvedRoot;
    try {
      resolvedRoot = realpathOrResolve(root);
    } catch {
      continue;
    }
    if (resolvedRoot && pathWithinRoot(resolved, resolvedRoot)) return true;
  }
  return false;
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
    .replace(/\n\nAttached files from the phone are saved on this runner\.[\s\S]*$/i, "")
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
  serveThreadAttachment,
  isSafeThreadAttachmentId,
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
