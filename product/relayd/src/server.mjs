// relayd server.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { host, port, requireMtls, allowedCertSubjects, maxConcurrent, maxBodyBytes, maxTranscriptionAudioBytes, proxyBaseUrl, proxyClientCertPath, proxyClientKeyPath, grantPublicKey, nodeId, approvalsDir, codexBin, runHome, codexHome } from "./config.mjs";
import { isJwtShaped, verifyBrowserGrant, activityScope, scopeCovers } from "./grant.mjs";
import { sendJson, sendHtml, sendError, readBody, readBinaryBody, headerValue, clampLimit, isSafeJobId } from "./util.mjs";
import { isThreadSessionId } from "./sessionid.mjs";
import { workspaces, workspaceList, pickerWorkspaceList, resolveWorkspaceById, publicWorkspace, workspaceDirectoryResponse, selectWorkspaceDirectory, createWorkspaceDirectory } from "./workspaces.mjs";
import { publicRuntimeModelCatalog } from "./catalog.mjs";
import { fsListResponse, serveFsFile } from "./fsapi.mjs";
import { listProviderSkills, publicSkill } from "./skills.mjs";
import { cleanThreadProviderFilter, workspaceForJob, listWorkspaceSessions, listWorkspaceThreads, resolveOptionalWorkspaceFilter, threadDetailResponse, serveThreadAttachment, isSafeThreadAttachmentId, deleteThread } from "./threads.mjs";
import { handleChatRequest } from "./chat.mjs";
import { isSafeArtifactId, serveJobArtifact } from "./artifacts.mjs";
import { transcribeAudio, cleanAudioContentType, cleanAudioFilename } from "./transcribe.mjs";
import { jobsState, jobs, activeChildren, responseShape, wantsFullLogs, enqueueJob, cleanJobProviderFilter, normalizeJobProvider, jobThreadId, cancelJob, streamJobEvents, toJobResponse, serveJobAttachment, isSafeAttachmentIndex } from "./jobs.mjs";
import { planSessionImports, importCodexSession, createSessionUpload, appendSessionUpload, completeSessionUpload } from "./session-sync.mjs";
import { codexThreadUiHtml } from "./ui.mjs";
import { handleAdditionRoutes } from "./additions.mjs";
import { ApprovalStore, publicApproval, terminalDecisions } from "./approval-store.mjs";
import { createTerminalService } from "./terminals.mjs";
import { appendAudit } from "./audit.mjs";
import { emitEvent } from "./events.mjs";
import { createPreviewService } from "./previews.mjs";
import { deviceTokenStore } from "./device-tokens.mjs";
import { isRevokedSerial } from "./identity.mjs";
import { version } from "./version.mjs";

const approvalStore = new ApprovalStore(approvalsDir);
const terminalService = createTerminalService({
  codexBin,
  runHome,
  codexHome,
  resolveWorkspaceById,
  readBody,
  sendJson,
  sendError,
  appendAudit,
});
const previewService = createPreviewService({ jobs, relayPort: port, appendAudit });

// SHA-256 of the LEGACY single device bearer token, when this node was
// provisioned with one. Re-read when the file changes, because the daemon
// starts before pairing has written it. A QR-paired node has no such file: its
// devices live in device-tokens.mjs, one row each.
let deviceTokenHashCache = { mtimeMs: -1, value: null };
function deviceTokenHash() {
  const file = process.env.RELAYD_DEVICE_TOKEN_HASH_FILE;
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  if (stat.mtimeMs !== deviceTokenHashCache.mtimeMs) {
    try {
      const value = fs.readFileSync(file, "utf8").trim().toLowerCase();
      deviceTokenHashCache = { mtimeMs: stat.mtimeMs, value: /^[0-9a-f]{64}$/.test(value) ? value : null };
    } catch {
      deviceTokenHashCache = { mtimeMs: stat.mtimeMs, value: null };
    }
  }
  return deviceTokenHashCache.value;
}

function bearerToken(header) {
  const value = headerValue(header);
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match ? match[1].trim() : null;
}

// One public error for every bearer rejection. Which of the three bearer paths
// refused, and whether a token is merely unknown or has been revoked, are not
// the caller's business.
const badToken = { ok: false, status: 401, error: "device token is not valid" };

// Node-side authorization (spec "Node-side auth after pairing").
//
//   1. bearer, JWT-shaped, grant key configured  -> browser grant
//   2. bearer matching a row in device-tokens    -> that paired device
//   3. RELAYD_DEVICE_TOKEN_HASH_FILE set         -> legacy single-hash compare
//   4. otherwise                                 -> mTLS
//
// The two modes COEXIST deliberately. Token mode used to be switched on by the
// mere presence of the legacy hash file, which meant adopting QR pairing would
// have turned off certificate auth for an existing cert-based install (and
// vice versa). Ordering by what the request actually carries keeps both alive
// on one node: a phone paired by QR sends a bearer, a desktop with a client
// certificate sends none, and each takes its own branch.
//
// Why a bearer at all: iOS will not send a client certificate on a connection
// it did not itself anchor, and declines SILENTLY — the handshake completes
// with nothing sent and the server sees no failed handshake to report. Proven
// against a live machine: a certificate minted from the node's own CA
// authenticated and returned 200, while the phone's — same CA, byte-identical,
// with a usable key — was never sent at all.
function authorize(req, { pathname } = {}) {
  const verify = headerValue(req.headers["x-ssl-client-verify"]);
  const subject = headerValue(req.headers["x-ssl-client-s-dn"]);
  const provided = bearerToken(req.headers.authorization);
  const legacyHashConfigured = Boolean(process.env.RELAYD_DEVICE_TOKEN_HASH_FILE);

  if (provided) {
    // 1. Browser grant. Only ever entered when an operator configured
    //    RELAYD_GRANT_PUBLIC_KEY; without it browser grants are simply off and
    //    a JWT-shaped bearer is treated as any other opaque token.
    if (isJwtShaped(provided) && grantPublicKey) {
      const grant = verifyBrowserGrant(provided, { publicKey: grantPublicKey, nodeId });
      const needed = activityScope(req.method, pathname);
      if (grant.ok && scopeCovers(grant.payload.scope, needed)) {
        return { ok: true, subject: "browser-grant" };
      }
      return badToken;
    }

    const actual = crypto.createHash("sha256").update(provided, "utf8").digest("hex");

    // 2. A device paired with this node. Never hash a JWT into this lookup —
    //    the branch above has already returned for anything grant-shaped.
    let device;
    let registeredLegacy;
    try {
      const tokens = deviceTokenStore();
      device = tokens?.find(actual);
      registeredLegacy = tokens?.wasRegisteredLegacy(actual);
    } catch {
      return badToken;
    }
    if (device) {
      if (device.disabled || device.notAfter <= Date.now() || isRevokedSerial(device.certSerial)) {
        return badToken;
      }
      return { ok: true, subject: `device:${device.deviceId}`, deviceId: device.deviceId };
    }

    // 3. Legacy single-hash install. `registeredLegacy` is a permanent denial
    //    tombstone: a token that was ever a per-device credential must not fall
    //    back to the shared hash after its row expires or is revoked.
    if (legacyHashConfigured && !registeredLegacy) {
      const a = Buffer.from(actual, "utf8");
      const b = Buffer.from(deviceTokenHash() || "", "utf8");
      if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
        return { ok: true, subject: "legacy-device" };
      }
    }
    return badToken;
  }

  // No bearer. A legacy token-mode node has no other credential to offer, so
  // it keeps its historical error rather than falling through to a client
  // certificate it was never configured for.
  if (legacyHashConfigured) {
    return { ok: false, status: 401, error: "device token is required" };
  }

  // 4. mTLS, terminated either by this process (tunnel / direct TLS) or by a
  //    reverse proxy that forwards x-ssl-client-*.
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


async function routeRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${port}`}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, healthPayload(false));
  }

  // Preview subresources use the short-lived, unguessable lease returned by an
  // authenticated POST below. This is required for token-authenticated trial
  // nodes because a WKWebView iframe cannot inherit the top-level Authorization
  // header. The capability is scoped to one loopback origin and expires quickly.
  if (previewService.isCapabilityPath(url)) {
    await previewService.routeCapability(req, res, url);
    return;
  }

  // Explicit invariant (API.md §2.3): pairing is authenticated by a single-use
  // secret and a blob MAC, never by a client certificate. It lives on its own
  // listener (pairing.mjs / RELAYD_PAIRING_*) and is NEVER routable here — not
  // even to fall through to authorize(), which would advertise its existence.
  if (url.pathname === "/v1/pair") {
    return sendError(res, 404, "not found");
  }

  const auth = authorize(req, { pathname: url.pathname });
  if (!auth.ok) {
    return sendError(res, auth.status, auth.error);
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/health") {
    return sendJson(res, 200, healthPayload(true));
  }

  if (await previewService.routeAuthenticated(req, res, url, auth)) return;

  if (req.method === "GET" && url.pathname === "/v1/codex/ui") {
    return sendHtml(res, 200, codexThreadUiHtml());
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/models") {
    return sendJson(res, 200, { models: await publicRuntimeModelCatalog() });
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/chat") {
    const body = await readBody(req);
    return handleChatRequest(req, res, body, auth.subject);
  }

  if (shouldProxyCodexRequest(req, url)) {
    return proxyCodexRequest(req, url, res);
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/approvals") {
    const jobId = url.searchParams.get("jobId")?.trim() || null;
    const status = url.searchParams.get("status")?.trim() || null;
    if (jobId && !isSafeJobId(jobId)) return sendError(res, 400, "jobId is invalid");
    if (status && status !== "pending" && status !== "resolved") return sendError(res, 400, "status must be pending or resolved");
    return sendJson(res, 200, { approvals: approvalStore.list({ jobId, status }).map(publicApproval) });
  }

  const approvalMatch = url.pathname.match(/^\/v1\/codex\/approvals\/([^/]+)\/decision$/);
  if (approvalMatch && req.method === "POST") {
    const body = await readBody(req);
    const decision = typeof body?.decision === "string" ? body.decision : "";
    if (!terminalDecisions.has(decision)) return sendError(res, 400, "decision is invalid");
    const record = approvalStore.decide(decodeURIComponent(approvalMatch[1]), decision, {
      decidedBy: auth.subject || "phone",
      message: body?.message,
    });
    appendAudit("approval_decided", jobs.get(record.jobId) || null, { approvalId: record.id, decision });
    emitEvent("approval.resolved", publicApproval(record));
    return sendJson(res, 200, { approval: publicApproval(record) });
  }

  if (await terminalService.route(req, res, url)) return;

  if (req.method === "GET" && url.pathname === "/v1/codex/skills") {
    const provider = cleanJobProviderFilter(url.searchParams.get("provider")) || "codex";
    const workspaceId = url.searchParams.get("workspaceId")?.trim() || null;
    const workspace = workspaceId ? resolveWorkspaceById(workspaceId) : null;
    if (workspaceId && !workspace) return sendError(res, 400, "unknown workspaceId");
    return sendJson(res, 200, {
      provider,
      skills: listProviderSkills(provider, workspace?.path).map(publicSkill),
    });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/workspaces") {
    return sendJson(res, 200, {
      workspaces: pickerWorkspaceList().map((workspace) => ({
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

  if (req.method === "GET" && url.pathname === "/v1/codex/fs/list") {
    return sendJson(res, 200, fsListResponse(url.searchParams));
  }

  if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/v1/codex/fs/file") {
    return serveFsFile(req, res, url.searchParams);
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/workspaces/select") {
    const body = await readBody(req);
    return sendJson(res, 200, publicWorkspace(selectWorkspaceDirectory(body)));
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/workspaces/create") {
    const body = await readBody(req);
    return sendJson(res, 201, publicWorkspace(createWorkspaceDirectory(body)));
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/session-imports/plan") {
    const body = await readBody(req);
    const plan = planSessionImports(body);
    const activeSessionIds = new Set(
      [...jobs.values()]
        .filter((job) => !["succeeded", "failed", "cancelled", "timed_out"].includes(job.status))
        .map(jobThreadId)
        .filter(Boolean),
    );
    plan.sessions = plan.sessions.map((entry) => activeSessionIds.has(entry.id)
      ? { ...entry, status: "conflict", reason: "session_is_active" }
      : entry);
    return sendJson(res, 200, plan);
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/session-imports") {
    const body = await readBody(req);
    const sessionId = body?.session?.id;
    const active = [...jobs.values()].some((job) =>
      jobThreadId(job) === sessionId && !["succeeded", "failed", "cancelled", "timed_out"].includes(job.status));
    if (active) return sendError(res, 409, "session_is_active");
    const imported = importCodexSession(body);
    appendAudit("session_imported", null, {
      sessionId: imported.sessionId,
      workspaceId: imported.workspaceId,
      status: imported.status,
      importedBy: auth.subject || null,
    });
    return sendJson(res, imported.status === "current" ? 200 : 201, imported);
  }

  if (req.method === "POST" && url.pathname === "/v1/codex/session-imports/uploads") {
    const body = await readBody(req);
    const sessionId = body?.session?.id;
    const active = [...jobs.values()].some((job) =>
      jobThreadId(job) === sessionId && !["succeeded", "failed", "cancelled", "timed_out"].includes(job.status));
    if (active) return sendError(res, 409, "session_is_active");
    const created = createSessionUpload(body);
    return sendJson(res, created.status === "current" ? 200 : 201, created);
  }

  const uploadChunkMatch = url.pathname.match(/^\/v1\/codex\/session-imports\/uploads\/([^/]+)\/chunks$/);
  if (uploadChunkMatch && req.method === "POST") {
    const body = await readBody(req);
    return sendJson(res, 200, appendSessionUpload(decodeURIComponent(uploadChunkMatch[1]), body));
  }

  const uploadCompleteMatch = url.pathname.match(/^\/v1\/codex\/session-imports\/uploads\/([^/]+)\/complete$/);
  if (uploadCompleteMatch && req.method === "POST") {
    const imported = completeSessionUpload(decodeURIComponent(uploadCompleteMatch[1]), {
      isSessionActive: (sessionId) => [...jobs.values()].some((job) =>
        jobThreadId(job) === sessionId && !["succeeded", "failed", "cancelled", "timed_out"].includes(job.status)),
    });
    appendAudit("session_imported", null, {
      sessionId: imported.sessionId,
      workspaceId: imported.workspaceId,
      status: imported.status,
      importedBy: auth.subject || null,
    });
    return sendJson(res, imported.status === "current" ? 200 : 201, imported);
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/sessions") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanThreadProviderFilter(url.searchParams.get("provider"));
    return sendJson(res, 200, { sessions: listWorkspaceSessions({ workspaceId, provider, limit }) });
  }

  if (req.method === "GET" && url.pathname === "/v1/codex/threads") {
    const limit = clampLimit(url.searchParams.get("limit"));
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanThreadProviderFilter(url.searchParams.get("provider"));
    return sendJson(res, 200, { threads: listWorkspaceThreads({ workspaceId, provider, limit }) });
  }

  const threadAttachmentMatch = url.pathname.match(/^\/v1\/codex\/threads\/([^/]+)\/attachments\/([^/]+)\/raw$/);
  if (threadAttachmentMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(threadAttachmentMatch[1]);
    const attachmentId = decodeURIComponent(threadAttachmentMatch[2]);
    const provider = cleanThreadProviderFilter(url.searchParams.get("provider"));
    if (!isThreadSessionId(sessionId) || !isSafeThreadAttachmentId(attachmentId)) {
      return sendError(res, 404, "attachment not found");
    }
    return serveThreadAttachment(res, sessionId, attachmentId, { provider });
  }

  const threadMatch = url.pathname.match(/^\/v1\/codex\/threads\/([^/]+)$/);
  if (threadMatch && req.method === "GET") {
    const sessionId = decodeURIComponent(threadMatch[1]);
    const provider = cleanThreadProviderFilter(url.searchParams.get("provider"));
    if (!isThreadSessionId(sessionId)) return sendError(res, 404, "thread not found");
    const detail = await threadDetailResponse(sessionId, { provider });
    if (!detail) return sendError(res, 404, "thread not found");
    return sendJson(res, 200, detail);
  }

  if (threadMatch && req.method === "DELETE") {
    const sessionId = decodeURIComponent(threadMatch[1]);
    const workspaceId = url.searchParams.get("workspaceId");
    const provider = cleanThreadProviderFilter(url.searchParams.get("provider"));
    if (!isThreadSessionId(sessionId)) return sendError(res, 404, "thread not found");
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
    const provider = cleanJobProviderFilter(url.searchParams.get("provider"));
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
    const job = await enqueueJob(body, auth.subject);
    return sendJson(res, 202, await toJobResponse(job, responseShape("preview")));
  }

  const jobAttachmentMatch = url.pathname.match(/^\/v1\/codex\/jobs\/([^/]+)\/attachments\/([^/]+)\/raw$/);
  if (jobAttachmentMatch && req.method === "GET") {
    const [, jobId, indexText] = jobAttachmentMatch;
    if (!isSafeJobId(jobId) || !isSafeAttachmentIndex(indexText)) return sendError(res, 404, "attachment not found");
    const job = jobs.get(jobId);
    if (!job) return sendError(res, 404, "attachment not found");
    return serveJobAttachment(res, job, indexText);
  }

  const artifactMatch = url.pathname.match(/^\/v1\/codex\/jobs\/([^/]+)\/artifacts\/([^/]+)\/(raw|preview)$/);
  if (artifactMatch && req.method === "GET") {
    const [, jobId, artifactId, mode] = artifactMatch;
    if (!isSafeJobId(jobId) || !isSafeArtifactId(artifactId)) return sendError(res, 404, "artifact not found");
    const job = jobs.get(jobId);
    if (!job) return sendError(res, 404, "artifact not found");
    return serveJobArtifact(res, job, artifactId, mode);
  }

  const streamMatch = url.pathname.match(/^\/v1\/codex\/jobs\/([^/]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    const id = streamMatch[1];
    if (!isSafeJobId(id)) return sendError(res, 404, "job not found");
    const job = jobs.get(id);
    if (!job) return sendError(res, 404, "job not found");
    return streamJobEvents(req, res, job, url.searchParams);
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

  // W2-MODULES: v1 ADDITIONS (API.md Part 2) — events feed, devices,
  // harness ops. Every path handled there previously 404'd; frozen routes
  // above are untouched.
  if (await handleAdditionRoutes(req, res, url, auth)) return;

  return sendError(res, 404, "not found");
}


// Terminal sessions whose shell is still alive. Counted for the drain check in
// update.mjs, not for display: a restart kills the child shell whether or not
// a phone happens to be streaming it at that instant, so "attached" here means
// "the session still owns a process", which is the thing a restart would break
// mid-sentence.
//
// terminals.mjs owns the sessions; this is the one place that can see the
// service instance, so the count is derived here rather than by inventing a
// counter somewhere else.
function liveTerminalCount() {
  let live = 0;
  for (const session of terminalService.sessions.values()) {
    if (session.status === "running" || session.status === "starting") live += 1;
  }
  return live;
}

// `version` (spec 2026-09-21): a node that cannot say what build it is running
// is invisible to the fleet, and the iOS app currently infers "too old to
// report usage" from a 404 instead of asking.
//
// NOTE: API.md §2.7 documents `GET /v1/meta` carrying a `version` field, and
// that route does not exist. It is deliberately NOT implemented here — the
// health routes are what `relayd status`, the update engine's post-restart
// check and the fleet actually read, and adding a capability-negotiation route
// is a separate piece of work with its own contract.
//
// `activeTerminals` rides along because the drain check is the one consumer
// that may be running in a DIFFERENT process from the daemon (`relayd update
// --file`), where an in-process counter tells it nothing. /healthz is already
// the node's public introspection surface, so it is where the answer belongs.
function healthPayload(authenticated) {
  return {
    ok: true,
    authenticated,
    requireMtls,
    version,
    queueLength: jobsState.queuedJobIds.length,
    activeJobs: activeChildren.size,
    activeTerminals: liveTerminalCount(),
    maxConcurrent,
    workspaceCount: workspaces.size,
  };
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
      const contentType = headerValue(upstreamRes.headers["content-type"]);
      if (/text\/event-stream/i.test(contentType)) {
        // Pipe SSE responses through instead of buffering so live streams
        // (chat, job streaming) work in dev proxy mode.
        res.writeHead(upstreamRes.statusCode || 502, {
          "content-type": contentType,
          "cache-control": upstreamRes.headers["cache-control"] || "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        upstreamRes.pipe(res);
        res.on("close", () => upstreamRes.destroy());
        upstreamRes.on("end", () => resolve());
        upstreamRes.on("error", () => {
          res.end();
          resolve();
        });
        return;
      }

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


export {
  authorize,
  routeRequest,
  healthPayload,
  liveTerminalCount,
  shouldProxyCodexRequest,
  proxyCodexRequest,
  readRawBody,
};
