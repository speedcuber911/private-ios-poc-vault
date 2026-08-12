// relayd cloudclient.mjs — the node's outbound half of the control-plane link.
//
// Three operations, all authenticated with the node's ed25519 identity key:
// a long-poll that collects pending handoffs AND credential-sync notices, a
// signed ack that confirms delivery of everything that poll handed out, and a
// signed event post that the cloud fans out to APNs. The cloud sees names and
// event types only — never repository content, never transcripts, and never a
// credential: a notice names a rendezvous slot whose payload is sealed to this
// node's X25519 key.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { identityPaths, readNodeId } from "./identity.mjs";
import { writeFileAtomic, withFileLock } from "./config.mjs";

const NODE_REQUEST_LABEL = "relay-node-req-v1";

// Bounded, small, and deliberately does not touch node identity or key
// material in its error path — every thrown message here is a static token.
const POST_EVENT_MAX_ATTEMPTS = 3;

// task-11: the cloud (commit 8bffba2) now leases a handoff on poll instead
// of marking it delivered the instant it writes the response — a
// partitioned node (no FIN, socket looks alive) used to have its handoff
// marked delivered into a dead peer and lost for good, contradicting the
// design's own promise that handoffs are rows, not messages. POST
// /v1/node/handoffs/ack is the only path to `delivered`. Bounded, best-effort,
// same shape as POST_EVENT_MAX_ATTEMPTS — no backoff loop that can hang the
// poll cycle. An id/lease pair that never confirms is not a bug: the lease
// simply expires and the row is redelivered on a later poll, which
// importHandoff (handoff.mjs) already handles as a cheap no-op via its own
// idempotent-on-id contract.
const HANDOFF_ACK_MAX_ATTEMPTS = 3;
const HANDOFF_ACK_PATH = "/v1/node/handoffs/ack";

function nodeRequestSigningInput({ method, pathWithQuery, ts, nodeId }) {
  return Buffer.from(`${NODE_REQUEST_LABEL}\n${method.toUpperCase()}\n${pathWithQuery}\n${nodeId}\n${ts}`, "utf8");
}

// Cloud commit 59ae640: POST /v1/node/handoffs/:id/fail (product/cloud/src/
// server.js) accepts exactly these five HANDOFF_FAILURE_REASONS codes and
// 400s anything else — a closed vocabulary, not a sanitiser, because the
// cloud is content-free by design and a free-text reason from the node is
// exactly the leak that allow-list exists to prevent. relayd's own
// PUBLIC_REASONS (handoff.mjs) has 33 finer-grained codes; this table is the
// one place that coarsens them down to the cloud's five, so it is
// authoritative, not merely a convenience mirror of some other source.
const RELAYD_TO_CLOUD_FAILURE_REASON = {
  clone_failed: "clone_failed",

  no_encryption_key: "decrypt_failed",
  seal_bad_magic: "decrypt_failed",
  seal_truncated: "decrypt_failed",
  seal_decrypt_failed: "decrypt_failed",

  invalid_handoff_id: "manifest_invalid",
  invalid_repo: "manifest_invalid",
  invalid_branch: "manifest_invalid",
  manifest_missing: "manifest_invalid",
  manifest_unreadable: "manifest_invalid",
  manifest_too_large: "manifest_invalid",
  manifest_invalid: "manifest_invalid",
  manifest_id_mismatch: "manifest_invalid",
  unsupported_manifest_version: "manifest_invalid",
  blob_outside_checkout: "manifest_invalid",
  blob_too_large: "manifest_invalid",
  blob_unreadable: "manifest_invalid",

  jail_root_unusable: "workspace_failed",
  checkout_create_failed: "workspace_failed",
  checkout_publish_failed: "workspace_failed",
  checkout_escaped_jail: "workspace_failed",
  checkout_missing: "workspace_failed",
  session_staging_failed: "workspace_failed",
  workspace_registration_failed: "workspace_failed",
  store_write_failed: "workspace_failed",
};

// The default matters more than the table: everything not listed above —
// internal_error itself, the push-back codes, the jobs-engine job_* codes, a
// code relayd coins later that this table has never seen, a non-string,
// null, undefined, or "" — becomes internal_error rather than being sent
// raw or skipped. Sending a raw unmapped code gets a 400 from the cloud's
// allow-list; skipping the report leaves the handoff `delivered` forever.
// Either way the terminal state is lost, which is the exact failure this
// function exists to close.
function mapFailureReason(relaydCode) {
  if (typeof relaydCode !== "string") return "internal_error";
  return RELAYD_TO_CLOUD_FAILURE_REASON[relaydCode] ?? "internal_error";
}

function createCloudClient({
  cloudUrl,
  baseDir = undefined,
  fetchImpl = fetch,
  now = () => Date.now(),
  // Invoked once per credential-sync notice the poll hands back (see
  // dispatchNotices). Optional: a node wired without one simply
  // acknowledges notices and does nothing with them, which is what an older
  // daemon build would do anyway.
  onNotice = null,
} = {}) {
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

  // Confirms delivery of one poll response's worth of handoffs. This means
  // "these bytes reached this node over a live connection" — exactly what
  // the transport layer knows and the handoff-import loop does not, which
  // is why the ack lives here rather than in handoff.mjs. Not gated on
  // anything the caller does with the descriptors afterward: gating the ack
  // on import succeeding would resurrect the lost-handoff bug this whole
  // mechanism exists to close, just in a new shape.
  async function ackHandoffsOnce(payload) {
    const res = await fetchImpl(`${base}${HANDOFF_ACK_PATH}`, {
      method: "POST",
      headers: { ...signedHeaders("POST", HANDOFF_ACK_PATH), "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    // The response body (`{ acked: [...] }`) is not consulted: an id/lease
    // pair missing from `acked` just means that lease had already expired
    // or was never valid, which is non-fatal and self-heals via redelivery.
    // Still drained so the connection isn't left with an unread body.
    await res.json().catch(() => null);
    return res.status === 200;
  }

  // One ack request per poll response, covering both lists. `acks` and
  // `notices` are separate fields on the wire because the cloud confirms them
  // against two different tables, but they share this one round trip: the
  // whole point of putting notices on the existing long-poll was not to
  // double the connections a node holds.
  async function ackDelivery({ acks, noticeAcks }) {
    if (acks.length === 0 && noticeAcks.length === 0) return;
    const payload = {};
    if (acks.length > 0) payload.acks = acks;
    if (noticeAcks.length > 0) payload.notices = noticeAcks;
    for (let attempt = 1; attempt <= HANDOFF_ACK_MAX_ATTEMPTS; attempt++) {
      try {
        if (await ackHandoffsOnce(payload)) return;
      } catch {
        // Transport failure. Best-effort and bounded: never throw out of
        // pollHandoffs, and never lose the handoffs it already parsed — a
        // failed ack costs at most one redundant redelivery next cycle,
        // via the cloud's own lease expiry, never data loss. A notice is
        // redelivered on the same terms, and installing one twice is a
        // rewrite of the same credential files, not a second effect.
      }
    }
  }

  async function reportHandoffFailureOnce(handoffId, cloudReason) {
    const pathWithQuery = `/v1/node/handoffs/${handoffId}/fail`;
    const res = await fetchImpl(`${base}${pathWithQuery}`, {
      method: "POST",
      headers: { ...signedHeaders("POST", pathWithQuery), "content-type": "application/json" },
      body: JSON.stringify({ reason: cloudReason }),
    });
    // The response body (`{handoff:{...}}` on success) is not consulted,
    // same as ackHandoffsOnce: the status code alone decides the outcome
    // here. Still drained so the connection isn't left with an unread body.
    await res.json().catch(() => null);
    return res.status;
  }

  // Deliberately different from ackDelivery/ackHandoffsOnce above, which
  // this is otherwise modeled on: the ack has no permanent-failure response
  // to distinguish, so it retries any non-200 unconditionally. This route
  // does — `400 invalid_reason` and `404 unknown_handoff` are terminal
  // outcomes of this exact (handoffId, reason) pair, not transient
  // conditions, and retrying one burns the replay guard's budget for a
  // request that cannot succeed. Only a thrown transport error or a 5xx is
  // worth another attempt, bounded by the same ceiling the ack uses. Never
  // throws: the caller (part B, dispatched separately) is already on a
  // failure path, and an exception here would replace a reported failure
  // with an unreported crash.
  async function reportHandoffFailure(handoffId, reason) {
    const cloudReason = mapFailureReason(reason);
    for (let attempt = 1; attempt <= HANDOFF_ACK_MAX_ATTEMPTS; attempt++) {
      try {
        const status = await reportHandoffFailureOnce(handoffId, cloudReason);
        if (status === 200) return true;
        if (status >= 400 && status < 500) return false;
        // Anything else (5xx, or a malformed status this code has not seen)
        // falls through to the next bounded attempt.
      } catch {
        // Transport failure: bounded by the loop, same as ackDelivery.
      }
    }
    return false;
  }

  function ackableFrom(entries) {
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry && typeof entry.id === "string" && typeof entry.lease === "string")
      .map((entry) => ({ id: entry.id, lease: entry.lease }));
  }

  // A notice is only actionable with all four fields; a partial one is
  // skipped rather than half-processed or acked into oblivion, so the cloud
  // redelivers it if it was a transport truncation and nothing pretends a
  // malformed row was handled.
  function actionableNotices(entries) {
    return (Array.isArray(entries) ? entries : []).filter((entry) =>
      entry && typeof entry.id === "string" && typeof entry.lease === "string" &&
      typeof entry.pairingId === "string" && typeof entry.secret === "string");
  }

  // Dispatch is deliberately AFTER the ack and never gates it: the ack means
  // "these bytes reached this node", which is exactly what the transport
  // layer knows and what the cloud's lease is waiting to hear. Gating it on
  // the install succeeding would resurrect the lost-delivery bug the lease
  // exists to close. The handler reports its own outcome (audit line +
  // credentials.installed/failed event); a handler that throws must not take
  // down the poll cycle or the handoffs parsed alongside it.
  async function dispatchNotices(notices) {
    if (!onNotice) return;
    for (const notice of notices) {
      try {
        await onNotice(notice);
      } catch {
        /* the handler owns reporting its own failure; the loop goes on */
      }
    }
  }

  async function pollHandoffs(waitSec) {
    const pathWithQuery = `/v1/node/handoffs?wait=${Number(waitSec) || 0}`;
    const res = await fetchImpl(`${base}${pathWithQuery}`, {
      method: "GET",
      headers: signedHeaders("GET", pathWithQuery),
    });
    if (res.status !== 200) throw new Error(`cloud_poll_${res.status}`);
    const json = await res.json();
    const handoffs = Array.isArray(json?.handoffs) ? json.handoffs : [];
    const notices = actionableNotices(json?.notices);
    // res.json() resolving is itself the evidence that matters — proof the
    // bytes crossed a live connection — so ack right here, before returning
    // descriptors to the caller, and before anything is done with them.
    await ackDelivery({ acks: ackableFrom(handoffs), noticeAcks: ackableFrom(notices) });
    await dispatchNotices(notices);
    // Unchanged on purpose: handoff.mjs's import loop consumes this return
    // value and knows nothing about notices.
    return handoffs;
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

  return { nodeId, pollHandoffs, postEvent, reportHandoffFailure };
}

export { createCloudClient, nodeRequestSigningInput, mapFailureReason };
