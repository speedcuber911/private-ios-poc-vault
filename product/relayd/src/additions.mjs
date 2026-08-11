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

// Returns true when the request was handled.
async function handleAdditionRoutes(req, res, url, auth) {
  if (req.method === "GET" && url.pathname === "/v1/events") {
    streamNodeEvents(req, res, url);
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

  return false;
}

export { handleAdditionRoutes };
