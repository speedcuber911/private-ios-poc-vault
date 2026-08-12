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
import { writeFileAtomic, withFileLock } from "./config.mjs";

const NODE_REQUEST_LABEL = "relay-node-req-v1";

// Bounded, small, and deliberately does not touch node identity or key
// material in its error path — every thrown message here is a static token.
const POST_EVENT_MAX_ATTEMPTS = 3;

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
  // MINOR 1: an empty/null cloudUrl must fail fast at construction, not with
  // an opaque `TypeError: Failed to parse URL` on the first request.
  if (!base) throw new Error("cloud_client_no_url");

  // MINOR 2: cleanOptionalUrlBase (config.mjs) preserves a path component on
  // the base URL (e.g. RELAYD_CLOUD_URL=https://host/api). The signed
  // pathWithQuery is always rooted at /v1/..., so a non-root base would put
  // /api/v1/... on the wire while the signature covers /v1/..., producing an
  // unexplainable bad_signature. Reject it here instead.
  let parsedBase;
  try {
    parsedBase = new URL(base);
  } catch {
    throw new Error("cloud_client_no_url");
  }
  if (parsedBase.pathname !== "/") throw new Error("cloud_client_base_has_path");

  const seqPath = path.join(paths.baseDir, "cloud-event-seq");

  // CRITICAL fix, part 2: seed from the clock so a lost/unreadable counter
  // self-heals instead of blackholing every future push. A plain counter
  // that resets to 0 on any unreadable state (missing file, empty file, a
  // torn read, garbage, a negative value) used to yield seq=1, which reads
  // as a legitimate-looking duplicate against the cloud's high-water mark
  // and is dropped forever, silently. Seeding from now() guarantees the
  // fresh seq is always ahead of anything the cloud has ever seen from this
  // node, because wall-clock ms already outruns any seq a real daemon could
  // have emitted. This is the derivation product/cloud/src/notify.js
  // recommends. The extra isSafeInteger clamp on `next` additionally
  // protects against a persisted MAX_SAFE_INTEGER (current + 1 rolling out
  // of the safe integer range, which the cloud would 400 on) — falling back
  // to the clock is safe there too.
  //
  // IMPORTANT (task-11 review follow-up): the read-modify-write below is
  // now serialized with config.mjs's own withFileLock, the same primitive
  // store.mjs and allowCertSubject already use for this exact class of
  // problem — closing the cross-process tie window this function's own
  // dedicated race test measured (two concurrent callers could both read
  // the same `current`, so both compute and persist the same `next`,
  // silently dropping one event as a cloud-side duplicate). withFileLock
  // (not identity.mjs's withEncKeyLock) is the deliberate choice: it fails
  // OPEN — degrades to unsynchronized rather than blocking indefinitely —
  // and self-heals a lock left behind by a crashed holder. This runs on
  // every postEvent for the daemon's entire lifetime, so a fail-closed lock
  // with no staleness recovery would let one crash-while-holding wedge
  // every future push behind a stuck lock file forever — reintroducing a
  // variant of the exact blackhole this fix exists to close.
  function nextSeq() {
    return withFileLock(seqPath, () => {
      let raw = "";
      try {
        raw = fs.readFileSync(seqPath, "utf8").trim();
      } catch {
        raw = "";
      }
      const parsed = Number.parseInt(raw, 10);
      const current = Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
      let next = Math.max(current + 1, now());
      if (!Number.isSafeInteger(next)) next = now();
      // CRITICAL fix, part 1: write atomically (unique temp name + rename,
      // reusing config.mjs's own writeFileAtomic rather than a second
      // implementation). fs.writeFileSync opens O_TRUNC, which is neither
      // crash-atomic nor safe against a concurrent reader — a reader could
      // observe a half-written value (a torn read) mid-write, which the old
      // code above would then treat as a fresh unreadable/garbage state and
      // reset from. rename() is atomic for readers: they see the whole old
      // file or the whole new one, never a partial one.
      writeFileAtomic(seqPath, String(next), { mode: 0o600 });
      return next;
    });
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

  async function sendEventOnce(body, signatureB64) {
    const res = await fetchImpl(`${base}/v1/node-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-relay-signature": signatureB64 },
      body,
    });
    const parsedBody = await res.json().catch(() => null);
    // IMPORTANT: a 202 {duplicate:true} — along with a 401 bad_signature or
    // a 404 unknown_node — all look like a successful await at the
    // {status,body} level. `accepted` is the one field callers can actually
    // check to tell "the cloud pushed this" from "the cloud silently
    // dropped this", without this ever throwing (push stays best-effort).
    //
    // MINOR (task-11 review follow-up): a 202 whose body fails to parse as
    // JSON left parsedBody null, and `!null?.duplicate` is `true` — a
    // malformed-but-202 response read as accepted, indistinguishable from a
    // genuine accept. Requiring parsedBody to actually be a (non-null)
    // object before trusting its `duplicate` field makes an unparseable 202
    // body read as not-accepted (the honest "unknown" answer) instead.
    const bodyIsObject = parsedBody !== null && typeof parsedBody === "object";
    return { status: res.status, body: parsedBody, accepted: res.status === 202 && bodyIsObject && !parsedBody.duplicate };
  }

  // MINOR 3: the seq is consumed once, at body-build time, in postEvent
  // below — never here. A retry calls this with the SAME already-built body
  // and signature, so a transient network failure can be retried without
  // the cloud ever seeing two different seqs (and therefore two pushes) for
  // one logical event. Bounded attempts, no backoff: this is fire-and-forget
  // push, not a loop that can hang the caller.
  async function sendEventWithRetry(body, signatureB64) {
    let lastError;
    for (let attempt = 1; attempt <= POST_EVENT_MAX_ATTEMPTS; attempt++) {
      try {
        return await sendEventOnce(body, signatureB64);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  // IMPORTANT: nextSeq() is synchronous, so seq ALLOCATION already happens
  // in call order within one process. But the actual network sends used to
  // race independently — three concurrent calls could arrive at the cloud
  // as seqs [102, 103, 101], and the cloud drops 101 as a duplicate of
  // whatever it saw after 102/103, silently. Delivery is serialized through
  // one promise chain per client so wire order matches call order. A
  // rejected send must not jam the chain for events queued after it.
  let sendChain = Promise.resolve();

  function postEvent(type, { jobId = null } = {}) {
    const body = Buffer.from(JSON.stringify({ v: 1, nodeId, jobId, type, ts: now(), seq: nextSeq() }), "utf8");
    const signature = crypto.sign(null, body, privateKey).toString("base64url");
    const result = sendChain.then(() => sendEventWithRetry(body, signature));
    sendChain = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  return { nodeId, pollHandoffs, postEvent };
}

export { createCloudClient, nodeRequestSigningInput };
