// relayd cloudclient.mjs — the node's outbound half of the control-plane link.
//
// Two operations, both authenticated with the node's ed25519 identity key:
// a long-poll that collects pending handoffs, and a signed event post that the
// cloud fans out to APNs. The cloud sees names and event types only — never
// repository content, never transcripts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { identityPaths, readNodeId } from "./identity.mjs";

const NODE_REQUEST_LABEL = "relay-node-req-v1";

function nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) {
  return Buffer.from(`${NODE_REQUEST_LABEL}\n${method.toUpperCase()}\n${pathWithQuery}\n${nodeId}\n${ts}`, "utf8");
}

function createCloudClient({ cloudUrl, baseDir = undefined, fetchImpl = fetch, now = () => Date.now() }) {
  const paths = baseDir ? identityPaths(baseDir) : identityPaths();
  const nodeId = readNodeId(paths);
  let privateKey = null;
  try {
    privateKey = crypto.createPrivateKey(fs.readFileSync(paths.identityKeyPath, "utf8"));
  } catch {
    privateKey = null;
  }
  if (!nodeId || !privateKey) throw new Error("cloud_client_no_identity");

  const base = String(cloudUrl || "").replace(/\/+$/, "");
  const seqPath = path.join(paths.baseDir, "cloud-event-seq");

  function nextSeq() {
    let current = 0;
    try {
      current = Number.parseInt(fs.readFileSync(seqPath, "utf8").trim(), 10) || 0;
    } catch {
      current = 0;
    }
    const next = current + 1;
    fs.writeFileSync(seqPath, `${next}\n`, { mode: 0o600 });
    return next;
  }

  function signedHeaders(method, pathWithQuery) {
    const ts = now();
    const signature = crypto.sign(null, nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }), privateKey);
    return {
      "x-relay-node": nodeId,
      "x-relay-ts": String(ts),
      "x-relay-signature": signature.toString("base64url"),
    };
  }

  async function pollHandoffs(waitSec) {
    const pathWithQuery = `/v1/node/handoffs?wait=${Number(waitSec) || 0}`;
    const res = await fetchImpl(`${base}${pathWithQuery}`, {
      method: "GET",
      headers: signedHeaders("GET", pathWithQuery),
    });
    if (res.status !== 200) throw new Error(`cloud_poll_${res.status}`);
    const json = await res.json();
    return Array.isArray(json?.handoffs) ? json.handoffs : [];
  }

  async function postEvent(type, { jobId = null } = {}) {
    const body = Buffer.from(JSON.stringify({ v: 1, nodeId, jobId, type, ts: now(), seq: nextSeq() }), "utf8");
    const signature = crypto.sign(null, body, privateKey);
    const res = await fetchImpl(`${base}/v1/node-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-signature": signature.toString("base64url") },
      body,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  return { nodeId, pollHandoffs, postEvent };
}

export { createCloudClient, nodeRequestSigningInput };
