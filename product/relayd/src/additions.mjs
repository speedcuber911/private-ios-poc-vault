// relayd additions.mjs — W2-MODULES: dispatcher for the new v1 ADDITIONS
// routes (API.md Part 2). Called by server.routeRequest just before its
// final 404, so every path here previously returned `not found` — the
// frozen Part 1 contract is untouched. All routes are behind the same mTLS
// authorize() gate as the rest of the data path; POST /v1/pair is
// deliberately NOT routed here (it never rides the data listener).

import { sendJson, sendError, readBody, clampLimit, isSafeJobId } from "./util.mjs";
import { streamNodeEvents, emitEvent } from "./events.mjs";
import { listDevices, revokeDevice, publicDevice } from "./identity.mjs";
import { listHarnesses, getOp, listOps, publicOp, startLoginOp, startSmokeOp } from "./harness.mjs";
import { serveExportTar } from "./fsapi.mjs";
import { continueHandoff } from "./handoff.mjs";
import { store } from "./store.mjs";
import { toJobResponse, responseShape } from "./jobs.mjs";
import { readMacSessions } from "./syncauth.mjs";
import { dataDir } from "./config.mjs";

// Returns true when the request was handled.
async function handleAdditionRoutes(req, res, url, auth) {
  if (req.method === "GET" && url.pathname === "/v1/events") {
    streamNodeEvents(req, res, url);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/export.tar") {
    serveExportTar(req, res);
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/devices") {
    sendJson(res, 200, { devices: listDevices({ callerSubject: auth.subject }) });
    return true;
  }

  const revokeMatch = url.pathname.match(/^\/v1\/devices\/([^/]+)\/revoke$/);
  if (revokeMatch && req.method === "POST") {
    const deviceId = revokeMatch[1];
    if (!isSafeJobId(deviceId)) {
      sendError(res, 404, "not found");
      return true;
    }
    const body = await readBody(req);
    const force = body && typeof body === "object" && body.force === true;
    const result = revokeDevice(deviceId, { force });
    emitEvent("device.revoked", publicDevice(result.device));
    sendJson(res, 200, { id: result.id, revoked: true, revokedAt: result.revokedAt });
    return true;
  }

  // "On your Mac" session index the phone renders (Task 15). Index metadata
  // only — harness, title, repo, last-active. Never a transcript, never a
  // credential: readMacSessions only ever returns what saveMacSessions wrote,
  // and that allow-lists the fields it copies in.
  if (req.method === "GET" && url.pathname === "/v1/mac-sessions") {
    sendJson(res, 200, { index: readMacSessions({ dataDir }) });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/harness") {
    sendJson(res, 200, { harnesses: listHarnesses() });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/harness/ops") {
    sendJson(res, 200, { ops: listOps(clampLimit(url.searchParams.get("limit"))) });
    return true;
  }

  const opMatch = url.pathname.match(/^\/v1\/harness\/ops\/([^/]+)$/);
  if (opMatch && req.method === "GET") {
    if (!isSafeJobId(opMatch[1])) {
      sendError(res, 404, "not found");
      return true;
    }
    const op = getOp(opMatch[1]);
    if (!op) {
      sendError(res, 404, "not found");
      return true;
    }
    sendJson(res, 200, { op: publicOp(op) });
    return true;
  }

  const actionMatch = url.pathname.match(/^\/v1\/harness\/([^/]+)\/(login|smoke)$/);
  if (actionMatch && req.method === "POST") {
    const [, provider, action] = actionMatch;
    await readBody(req);
    const op = action === "login" ? startLoginOp(provider) : startSmokeOp(provider);
    sendJson(res, 202, { op });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/v1/handoffs") {
    const handoffs = store.listHandoffs().map(publicHandoff);
    sendJson(res, 200, { handoffs });
    return true;
  }

  const handoffMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)$/);
  if (handoffMatch && req.method === "GET") {
    const record = store.getHandoff(handoffMatch[1]);
    if (!record) { sendError(res, 404, "handoff not found"); return true; }
    sendJson(res, 200, { handoff: { ...publicHandoff(record), manifest: record.manifest } });
    return true;
  }

  const continueMatch = url.pathname.match(/^\/v1\/handoffs\/([^/]+)\/continue$/);
  if (continueMatch && req.method === "POST") {
    const body = await readBody(req);
    const job = await continueHandoff(continueMatch[1], {
      prompt: typeof body?.prompt === "string" && body.prompt.trim() ? body.prompt.trim() : null,
      certSubject: auth.subject,
    });
    sendJson(res, 202, { job: await toJobResponse(job, responseShape("preview")) });
    return true;
  }

  return false;
}

// Public projection of a handoff record for GET /v1/handoffs[/:id]. Omits
// primedPrompt, which is prompt scaffolding rather than user-facing content.
function publicHandoff(record) {
  return {
    id: record.id,
    state: record.state,
    repo: record.repo,
    branch: record.branch,
    title: record.title,
    provider: record.provider,
    workspaceId: record.workspaceId,
    canResumeNatively: Boolean(record.resumeSessionId),
    lastJobId: record.lastJobId,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export { handleAdditionRoutes };
