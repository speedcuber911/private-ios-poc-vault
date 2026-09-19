import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { codexHome, dataDir, runHome } from "./config.mjs";
import { importSession, claudeProjectSlug, cursorWorkspaceHash, codexRolloutLeafName } from "./sessionimport.mjs";
import { isResumableSessionId } from "./sessionid.mjs";
import { findSessionFile } from "./threads.mjs";
import { browseWorkspaceForPath, resolveWorkspaceById } from "./workspaces.mjs";

const SESSION_SYNC_VERSION = 1;
const MAX_SESSION_BYTES = 256 * 1024 * 1024;
const MAX_INLINE_SESSION_BYTES = 20 * 1024 * 1024;
const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const UPLOAD_ID_RE = /^[a-f0-9-]{36}$/;
const uploads = new Map();

function fail(status, message) {
  throw Object.assign(new Error(message), { status });
}

function syncStatePath(baseDir = dataDir) {
  return path.join(baseDir, "session-sync", "index.json");
}

function readState(baseDir = dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(syncStatePath(baseDir), "utf8"));
    if (parsed?.v !== SESSION_SYNC_VERSION || !parsed.sessions || typeof parsed.sessions !== "object") {
      return { v: SESSION_SYNC_VERSION, sessions: {} };
    }
    return parsed;
  } catch {
    return { v: SESSION_SYNC_VERSION, sessions: {} };
  }
}

function writeState(state, baseDir = dataDir) {
  const filePath = syncStatePath(baseDir);
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const temporary = `${filePath}.new-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
}

function stateKey(workspaceId, sessionId) {
  return `${workspaceId}:${sessionId}`;
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function cleanIso(value, fallback = null) {
  if (typeof value !== "string" || value.length > 80 || /[\0\r\n]/.test(value)) return fallback;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function cleanTitle(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 500 || /[\0\r\n]/.test(value)) {
    fail(400, "session title is invalid");
  }
  const title = value.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 200) : null;
}

function cleanSessionHarness(value) {
  if (value === undefined || value === null || value === "") return "codex";
  if (typeof value !== "string") fail(400, "session harness is invalid");
  const harness = value.trim().toLowerCase();
  if (!["codex", "claude", "cursor"].includes(harness)) fail(400, "session harness is invalid");
  return harness;
}

function cleanSessionFormat(value, harness) {
  const expected = harness === "claude" ? "claude-jsonl" : harness === "cursor" ? "cursor-jsonl" : "codex-rollout";
  if (value === undefined || value === null || value === "") return expected;
  if (typeof value !== "string") fail(400, "session format is invalid");
  const format = value.trim().toLowerCase();
  if (format !== expected) fail(400, "session format does not match harness");
  return format;
}

function cleanDescriptor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(400, "session descriptor is invalid");
  if (!isResumableSessionId(value.id)) fail(400, "session id is invalid");
  if (!SHA256_RE.test(String(value.sha256 || ""))) fail(400, "session sha256 is invalid");
  if (!Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 1 || value.sizeBytes > MAX_SESSION_BYTES) {
    fail(400, "session size is invalid");
  }
  const harness = cleanSessionHarness(value.harness);
  return {
    id: value.id,
    harness,
    sessionFormat: cleanSessionFormat(value.sessionFormat ?? value.format, harness),
    title: cleanTitle(value.title),
    sha256: value.sha256,
    sizeBytes: value.sizeBytes,
    createdAt: cleanIso(value.createdAt),
    updatedAt: cleanIso(value.updatedAt),
  };
}

function resolveSyncWorkspace(
  workspaceId,
  resolver = resolveWorkspaceById,
  workspacePath = null,
  browser = browseWorkspaceForPath,
) {
  if (typeof workspaceId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(workspaceId)) {
    fail(400, "workspaceId is invalid");
  }
  let workspace = resolver(workspaceId);
  if (!workspace && workspacePath !== null && workspacePath !== undefined) {
    if (typeof workspacePath !== "string" || workspacePath.length < 2 || workspacePath.length > 4096 || /[\0\r\n]/.test(workspacePath)) {
      fail(400, "workspacePath is invalid");
    }
    const selected = browser(workspacePath, { materialize: true });
    if (selected?.id === workspaceId) workspace = selected;
  }
  if (!workspace) fail(400, "unknown workspaceId");
  return workspace;
}

function recordFilePath(record, targetCodexHome, targetRunHome = runHome) {
  if (!record?.fileName || path.basename(record.fileName) !== record.fileName) return null;
  if (record.harness === "claude") {
    if (typeof record.projectSlug !== "string" || path.basename(record.projectSlug) !== record.projectSlug) return null;
    return path.join(targetRunHome, ".claude", "projects", record.projectSlug, record.fileName);
  }
  if (record.harness === "cursor") {
    if (typeof record.workspaceHash !== "string" || !/^[a-f0-9]{32}$/.test(record.workspaceHash)) return null;
    if (!isResumableSessionId(record.sessionId)) return null;
    return path.join(targetRunHome, ".cursor", "chats", record.workspaceHash, record.sessionId, record.fileName);
  }
  return path.join(targetCodexHome, "sessions", record.fileName);
}

function existingRemoteSession(descriptor, workspace, {
  targetCodexHome = codexHome,
  targetRunHome = runHome,
} = {}) {
  if (descriptor.harness === "claude") {
    return fs.existsSync(path.join(
      targetRunHome,
      ".claude",
      "projects",
      claudeProjectSlug(workspace.path),
      `${descriptor.id}.jsonl`,
    ));
  }
  if (descriptor.harness === "cursor") {
    const sessionDir = path.join(
      targetRunHome,
      ".cursor",
      "chats",
      cursorWorkspaceHash(workspace.path),
      descriptor.id,
    );
    return fs.existsSync(path.join(sessionDir, "transcript.jsonl")) || fs.existsSync(path.join(sessionDir, "meta.json"));
  }
  return Boolean(findSessionFile(path.join(targetCodexHome, "sessions"), descriptor.id));
}

function classifyDescriptor(descriptor, workspace, {
  baseDir = dataDir,
  targetCodexHome = codexHome,
  targetRunHome = runHome,
  state: suppliedState = null,
} = {}) {
  const state = suppliedState || readState(baseDir);
  const key = stateKey(workspace.id, descriptor.id);
  const record = state.sessions[key] || null;
  if (!record) {
    const existing = existingRemoteSession(descriptor, workspace, { targetCodexHome, targetRunHome });
    return { status: existing ? "conflict" : "upload", reason: existing ? "session_already_exists" : null };
  }
  const filePath = recordFilePath(record, targetCodexHome, targetRunHome);
  if (!filePath || !fs.existsSync(filePath)) return { status: "conflict", reason: "remote_session_missing" };
  let remoteSha;
  try { remoteSha = sha256File(filePath); } catch { return { status: "conflict", reason: "remote_session_unreadable" }; }
  if (remoteSha !== record.installedSha256) {
    return { status: "conflict", reason: "remote_session_changed" };
  }
  return record.sourceSha256 === descriptor.sha256
    ? { status: "current", reason: null }
    : { status: "upload", reason: null };
}

function storeCurrentTitle(descriptor, workspace, { baseDir = dataDir, state: suppliedState = null } = {}) {
  if (!descriptor.title) return false;
  const state = suppliedState || readState(baseDir);
  const record = state.sessions[stateKey(workspace.id, descriptor.id)];
  if (!record || record.title === descriptor.title) return false;
  record.title = descriptor.title;
  if (!suppliedState) writeState(state, baseDir);
  return true;
}

function planSessionImports(body, options = {}) {
  if (body?.v !== SESSION_SYNC_VERSION || !Array.isArray(body?.sessions)) fail(400, "session sync plan is invalid");
  if (body.sessions.length > 500) fail(400, "too many sessions");
  const workspace = resolveSyncWorkspace(
    body.workspaceId,
    options.resolveWorkspace || resolveWorkspaceById,
    body.workspacePath,
    options.browseWorkspace || browseWorkspaceForPath,
  );
  const baseDir = options.baseDir || dataDir;
  const state = readState(baseDir);
  let stateChanged = false;
  const sessions = body.sessions.map((value) => {
    const descriptor = cleanDescriptor(value);
    const classification = classifyDescriptor(descriptor, workspace, { ...options, state });
    if (classification.status === "current") {
      stateChanged = storeCurrentTitle(descriptor, workspace, { baseDir, state }) || stateChanged;
    }
    return { id: descriptor.id, ...classification };
  });
  if (stateChanged) writeState(state, baseDir);
  return {
    workspaceId: workspace.id,
    sessions,
  };
}

function decodeTranscript(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > Math.ceil(MAX_INLINE_SESSION_BYTES * 4 / 3) + 4) {
    fail(400, "session transcript is invalid");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400, "session transcript is invalid");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > MAX_INLINE_SESSION_BYTES) fail(400, "session transcript is invalid");
  return bytes;
}

function codexMeta(bytes) {
  // session_meta is at the beginning of a native Codex rollout. Do not turn a
  // 100+ MiB transcript into a second full-size string merely to read it.
  const text = bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)).toString("utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.type !== "session_meta" || !entry.payload || typeof entry.payload !== "object") continue;
    const { id, cwd } = entry.payload;
    if (!isResumableSessionId(id) || typeof cwd !== "string" || cwd.length < 2 || cwd.length > 4096 || /[\0\r\n]/.test(cwd)) {
      fail(400, "session metadata is invalid");
    }
    return { id, cwd, timestamp: cleanIso(entry.payload.timestamp || entry.timestamp) };
  }
  fail(400, "session metadata is missing");
}

function importCodexSessionBytes(body, bytes, options = {}) {
  const workspace = resolveSyncWorkspace(
    body.workspaceId,
    options.resolveWorkspace || resolveWorkspaceById,
    body.workspacePath,
    options.browseWorkspace || browseWorkspaceForPath,
  );
  const sessionId = body.session.id;
  if (!isResumableSessionId(sessionId)) fail(400, "session id is invalid");
  if (!SHA256_RE.test(String(body.session.sha256 || ""))) fail(400, "session sha256 is invalid");
  const sourceSha256 = sha256Bytes(bytes);
  if (sourceSha256 !== body.session.sha256) fail(400, "session sha256 does not match transcript");
  const harness = cleanSessionHarness(body.session.harness);
  const sessionFormat = cleanSessionFormat(body.session.sessionFormat ?? body.session.format, harness);
  let sourceCwd = typeof body.sourceCwd === "string" ? body.sourceCwd : null;
  let createdAtHint = cleanIso(body.session.createdAt);
  if (harness === "codex") {
    const meta = codexMeta(bytes);
    if (meta.id !== sessionId) fail(400, "session id does not match transcript");
    if (sourceCwd !== meta.cwd) fail(400, "sourceCwd does not match transcript");
    createdAtHint = createdAtHint || meta.timestamp;
  } else if (!sourceCwd || sourceCwd.length < 2 || sourceCwd.length > 4096 || /[\0\r\n]/.test(sourceCwd)) {
    fail(400, "sourceCwd is invalid");
  }
  const descriptor = cleanDescriptor({
    id: sessionId,
    harness,
    sessionFormat,
    title: body.session.title,
    sha256: sourceSha256,
    sizeBytes: bytes.length,
    createdAt: createdAtHint,
    updatedAt: body.session.updatedAt,
  });
  const classification = classifyDescriptor(descriptor, workspace, options);
  if (classification.status === "current") {
    storeCurrentTitle(descriptor, workspace, options);
    return { status: "current", sessionId, workspaceId: workspace.id };
  }
  if (classification.status === "conflict") fail(409, classification.reason || "remote session changed");

  const baseDir = options.baseDir || dataDir;
  const targetCodexHome = options.targetCodexHome || codexHome;
  const targetRunHome = options.targetRunHome || runHome;
  const state = readState(baseDir);
  const key = stateKey(workspace.id, sessionId);
  const prior = state.sessions[key] || null;
  const createdAt = prior?.createdAt || descriptor.createdAt || new Date(0).toISOString();
  const importer = options.importSessionImpl || importSession;
  importer({
    manifest: {
      harness,
      sessionFormat,
      sessionId,
      cwd: sourceCwd,
      createdAt,
      title: descriptor.title || `Synced ${harness} session`,
    },
    sessionBytes: bytes,
    runHome: targetRunHome,
    codexHome: targetCodexHome,
    worktreePath: workspace.path,
  });

  const fileName = harness === "codex"
    ? codexRolloutLeafName(sessionId, createdAt)
    : harness === "claude"
      ? `${sessionId}.jsonl`
      : "transcript.jsonl";
  const record = {
    workspaceId: workspace.id,
    sessionId,
    harness,
    sessionFormat,
    title: descriptor.title,
    sourceSha256,
    fileName,
    createdAt,
    sourceUpdatedAt: descriptor.updatedAt,
    importedAt: new Date().toISOString(),
  };
  if (harness === "claude") record.projectSlug = claudeProjectSlug(workspace.path);
  if (harness === "cursor") record.workspaceHash = cursorWorkspaceHash(workspace.path);
  const installedPath = recordFilePath(record, targetCodexHome, targetRunHome);
  if (!installedPath || !fs.existsSync(installedPath)) fail(500, "session import did not produce a transcript");
  record.installedSha256 = sha256File(installedPath);
  state.sessions[key] = record;
  writeState(state, baseDir);
  return { status: prior ? "updated" : "imported", sessionId, workspaceId: workspace.id };
}

function importCodexSession(body, options = {}) {
  if (body?.v !== SESSION_SYNC_VERSION || !body?.session || typeof body.session !== "object") {
    fail(400, "session import is invalid");
  }
  return importCodexSessionBytes(body, decodeTranscript(body.session.transcript), options);
}

function uploadsDir(baseDir = dataDir) {
  const dir = path.join(baseDir, "session-sync", "uploads");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  return dir;
}

function createSessionUpload(body, options = {}) {
  if (body?.v !== SESSION_SYNC_VERSION || !body?.session || typeof body.session !== "object") {
    fail(400, "session upload is invalid");
  }
  const workspace = resolveSyncWorkspace(
    body.workspaceId,
    options.resolveWorkspace || resolveWorkspaceById,
    body.workspacePath,
    options.browseWorkspace || browseWorkspaceForPath,
  );
  const descriptor = cleanDescriptor(body.session);
  if (typeof body.sourceCwd !== "string" || body.sourceCwd.length < 2 || body.sourceCwd.length > 4096 || /[\0\r\n]/.test(body.sourceCwd)) {
    fail(400, "sourceCwd is invalid");
  }
  const classification = classifyDescriptor(descriptor, workspace, options);
  if (classification.status === "current") {
    storeCurrentTitle(descriptor, workspace, options);
    return { status: "current", sessionId: descriptor.id, workspaceId: workspace.id };
  }
  if (classification.status === "conflict") fail(409, classification.reason || "remote session changed");
  const uploadId = crypto.randomUUID();
  const baseDir = options.baseDir || dataDir;
  const filePath = path.join(uploadsDir(baseDir), `${uploadId}.part`);
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  fs.closeSync(fd);
  uploads.set(uploadId, {
    filePath,
    baseDir,
    received: 0,
    body: {
      v: SESSION_SYNC_VERSION,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      sourceCwd: body.sourceCwd,
      session: descriptor,
    },
    options,
  });
  return { status: "upload", uploadId, sessionId: descriptor.id, workspaceId: workspace.id, chunkBytes: MAX_CHUNK_BYTES };
}

function decodeChunk(value) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_CHUNK_BYTES * 4 / 3) + 4) {
    fail(400, "session chunk is invalid");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) fail(400, "session chunk is invalid");
  const chunk = Buffer.from(value, "base64");
  if (!chunk.length || chunk.length > MAX_CHUNK_BYTES) fail(400, "session chunk is invalid");
  return chunk;
}

function appendSessionUpload(uploadId, body) {
  if (!UPLOAD_ID_RE.test(String(uploadId || ""))) fail(404, "session upload not found");
  const upload = uploads.get(uploadId);
  if (!upload) fail(404, "session upload not found");
  if (!Number.isSafeInteger(body?.offset) || body.offset !== upload.received) fail(409, "session chunk offset mismatch");
  const chunk = decodeChunk(body.data);
  if (upload.received + chunk.length > upload.body.session.sizeBytes) fail(400, "session upload exceeds declared size");
  const fd = fs.openSync(upload.filePath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW);
  try { fs.writeFileSync(fd, chunk); } finally { fs.closeSync(fd); }
  upload.received += chunk.length;
  return { status: "uploading", uploadId, received: upload.received, sizeBytes: upload.body.session.sizeBytes };
}

function removeUpload(uploadId, upload) {
  uploads.delete(uploadId);
  try { fs.unlinkSync(upload.filePath); } catch { /* already gone */ }
}

function completeSessionUpload(uploadId, { isSessionActive = null } = {}) {
  if (!UPLOAD_ID_RE.test(String(uploadId || ""))) fail(404, "session upload not found");
  const upload = uploads.get(uploadId);
  if (!upload) fail(404, "session upload not found");
  if (upload.received !== upload.body.session.sizeBytes) fail(409, "session upload is incomplete");
  if (isSessionActive?.(upload.body.session.id)) fail(409, "session_is_active");
  let bytes;
  try {
    bytes = fs.readFileSync(upload.filePath);
    if (sha256Bytes(bytes) !== upload.body.session.sha256) fail(400, "session sha256 does not match upload");
    const result = importCodexSessionBytes(upload.body, bytes, upload.options);
    removeUpload(uploadId, upload);
    return result;
  } catch (error) {
    removeUpload(uploadId, upload);
    throw error;
  }
}

export {
  SESSION_SYNC_VERSION,
  MAX_SESSION_BYTES,
  MAX_INLINE_SESSION_BYTES,
  MAX_CHUNK_BYTES,
  syncStatePath,
  readState,
  cleanDescriptor,
  codexMeta,
  classifyDescriptor,
  planSessionImports,
  importCodexSession,
  createSessionUpload,
  appendSessionUpload,
  completeSessionUpload,
};
