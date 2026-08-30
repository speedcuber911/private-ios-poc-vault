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
import { workspaces, workspaceList, resolveWorkspaceById, publicWorkspace, workspaceDirectoryResponse, selectWorkspaceDirectory, createWorkspaceDirectory } from "./workspaces.mjs";
import { publicRuntimeModelCatalog } from "./catalog.mjs";
import { fsListResponse, serveFsFile } from "./fsapi.mjs";
import { listProviderSkills, publicSkill } from "./skills.mjs";
import { cleanThreadProviderFilter, workspaceForJob, listWorkspaceSessions, listWorkspaceThreads, resolveOptionalWorkspaceFilter, threadDetailResponse, deleteThread } from "./threads.mjs";
import { handleChatRequest } from "./chat.mjs";
import { isSafeArtifactId, serveJobArtifact } from "./artifacts.mjs";
import { transcribeAudio, cleanAudioContentType, cleanAudioFilename } from "./transcribe.mjs";
import { jobsState, jobs, activeChildren, responseShape, wantsFullLogs, enqueueJob, cleanJobProviderFilter, normalizeJobProvider, cancelJob, streamJobEvents, toJobResponse } from "./jobs.mjs";
import { codexThreadUiHtml } from "./ui.mjs";
import { handleAdditionRoutes } from "./additions.mjs";
import { computerAccessGate } from "./computeraccess.mjs";
import { ApprovalStore, publicApproval, terminalDecisions } from "./approval-store.mjs";
import { createTerminalService } from "./terminals.mjs";
import { appendAudit } from "./audit.mjs";
import { emitEvent } from "./events.mjs";
import { createPreviewService } from "./previews.mjs";
import { hostedDeviceStore } from "./hosted-device-store.mjs";
import { isRevokedSerial } from "./identity.mjs";

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

// SHA-256 of the device's bearer token, or null when this node authenticates
// with client certificates instead. Re-read when the file changes, because the
// daemon starts before pairing has written it.
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

function authorize(req, { pathname } = {}) {
  const verify = headerValue(req.headers["x-ssl-client-verify"]);
  const subject = headerValue(req.headers["x-ssl-client-s-dn"]);

  // Token authentication, when this node was paired with a device token.
  //
  // A trial machine cannot use client certificates: iOS will not send one on
  // a connection it did not itself anchor, and on a machine whose certificate
  // is publicly trusted it declines silently — the handshake dies with the
  // client having sent nothing, and the machine sees no failed handshake to
  // report. Proven against a live machine: a certificate minted from the
  // node's own CA authenticated and returned 200, while the phone's — the
  // same CA, byte-identical, with a usable key — was never sent at all.
  //
  // The token is derived from the same single-use pairing secret that already
  // authenticates pairing, so no new secret crosses the wire and the pairing
  // protocol is unchanged. Only its SHA-256 is stored here, and it is compared
  // in constant time.
  //
  // Browser grants are also Authorization: Bearer. Precedence lives inside
  // this first branch so trial traffic actually reaches it (spec §3.3):
  // 1. Read bearer.
  // 2. If JWT-shaped (exactly 3 base64url segments) AND grant public key
  //    configured: verify grant; payload.node === thisNodeId; exp valid; if
  //    pathname is an activity read, require matching scope. Fail → 401
  //    { error: "device token is not valid" } (identical public error).
  // 3. Else if deviceTokenHash() set: existing hash compare.
  // 4. Else: existing mTLS path.
  // Never hash a JWT and compare it to deviceTokenHash.
  const expected = deviceTokenHash();
  if (process.env.RELAYD_DEVICE_TOKEN_HASH_FILE) {
    const provided = bearerToken(req.headers.authorization);
    if (!provided) {
      return { ok: false, status: 401, error: "device token is required" };
    }
    if (isJwtShaped(provided) && grantPublicKey) {
      const grant = verifyBrowserGrant(provided, {
        publicKey: grantPublicKey,
        nodeId,
      });
      const needed = activityScope(req.method, pathname);
      if (grant.ok && scopeCovers(grant.payload.scope, needed)) {
        return { ok: true, subject: "browser-grant" };
      }
      return { ok: false, status: 401, error: "device token is not valid" };
    }
    const actual = crypto.createHash("sha256").update(provided, "utf8").digest("hex");
    let device, registeredLegacy;
    try {
      const deviceStore = hostedDeviceStore();
      device = deviceStore?.find(actual);
      registeredLegacy = deviceStore?.wasRegisteredLegacy(actual);
    }
    catch { return { ok: false, status: 401, error: "device token is not valid" }; }
    if (device) {
      if (device.disabled || device.notAfter <= Date.now() || isRevokedSerial(device.certSerial)) {
        return { ok: false, status: 401, error: "device token is not valid" };
      }
      const computerAccess = computerAccessGate.authorize();
      if (!computerAccess.ok) return computerAccess;
      return { ok: true, subject: `hosted-device:${device.deviceId}`, deviceId: device.deviceId };
    }
    if (registeredLegacy) {
      return { ok: false, status: 401, error: "device token is not valid" };
    }
    const a = Buffer.from(actual, "utf8");
    const b = Buffer.from(expected || "", "utf8");
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      return { ok: false, status: 401, error: "device token is not valid" };
    }
    const computerAccess = computerAccessGate.authorize();
    if (!computerAccess.ok) return computerAccess;
    return { ok: true, subject: "trial-device" };
  }

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


function healthPayload(authenticated) {
  return {
    ok: true,
    authenticated,
    requireMtls,
    queueLength: jobsState.queuedJobIds.length,
    activeJobs: activeChildren.size,
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
  shouldProxyCodexRequest,
  proxyCodexRequest,
  readRawBody,
};
