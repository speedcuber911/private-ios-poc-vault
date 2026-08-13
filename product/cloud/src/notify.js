// Notify: ingest minimal signed node events and fan out to the account's
// devices via APNs. Events carry ids and event types — no titles, no prompts,
// no file paths, no workspace names, no job output. The signature is a
// detached ed25519 signature over the exact raw request body bytes, verified
// against the node's registered pubkey. Retention is days, not months.
//
// ── WIRE FORMAT (relayd → cloud) ─────────────────────────────────────────
// This is the contract the relayd client must be written against.
//
//   POST /v1/node-events
//   X-Relay-Signature: base64url(ed25519 detached signature over the exact
//                                raw request body bytes, node identity key)
//   Content-Type: application/json
//   Body (≤ NODE_EVENT_MAX_BYTES, 16 KiB):
//     {
//       "v":      1,                       // protocol version, must be 1
//       "nodeId": "<node-id>",             // this node's registered id
//       "seq":    1754700000123,           // see below
//       "type":   "job.needs_input",       // one of KNOWN_TYPES
//       "jobId":  "<job-id>",              // optional; null/absent allowed
//       "ts":     1754700000123            // epoch ms, integer
//     }
//
// seq — a per-node, strictly increasing integer in [1, 2^53). It is the
//   replay/idempotency key and it MUST be inside the signed body, because a
//   value outside it could be rewritten by anyone who captured the request.
//   The cloud keeps a per-node high-water mark and accepts an event only when
//   seq is strictly greater than it; anything else is a duplicate and is
//   answered 202 with {duplicate:true} and no push. That makes the node's own
//   at-least-once retry safe (retrying the same seq is a no-op) and makes a
//   captured request worthless to an attacker.
//
//   RECOMMENDED derivation, which relayd should use:
//       seq = max(lastSeq + 1, Date.now())
//   It is monotonic, needs no coordination, produces no collisions, and — the
//   part that matters — survives a daemon restart that lost its counter,
//   because wall-clock ms is already ahead of every seq ever sent. A plain
//   counter is also legal, but relayd must then persist it durably: a counter
//   that resets to 1 will have every subsequent event silently dropped as a
//   duplicate. Events MUST be posted in increasing seq order; a seq that is
//   not greater than the last accepted one is dropped, not queued.
//
// ts — epoch milliseconds, a safe integer, and within
//   [now - TS_MAX_AGE_MS, now + TS_MAX_SKEW_MS] of the cloud's clock. Outside
//   that window the event is rejected (400 ts_out_of_window) rather than
//   stored, so a node with a broken clock cannot write rows that either never
//   expire or expire instantly. The stored value is min(ts, now) for the same
//   reason. A node whose clock is wrong should fix its clock; the cloud will
//   not silently pretend a year-old event is current.
//
// jobId / nodeId — opaque ids matching EVENT_ID_RE. The charset excludes
//   whitespace and punctuation on purpose: an id is the only free-form string
//   in this format that reaches the device, so it must not be able to carry a
//   sentence.
//
// Unknown top-level fields are ignored: never stored, never forwarded. The
// push payload is constructed field by field from the validated values above,
// so the content-free guarantee does not depend on the node behaving.
//
// Responses: 202 {ok,kind,queued} accepted · 202 {ok,duplicate,queued:0}
// already seen · 400 invalid_json | unsupported_version | invalid_event |
// ts_out_of_window · 401 bad_signature · 404 unknown_node.

import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { apnsCollapseId, APNS_OUTCOME } from "./apns.js";

// Event types that produce a user-visible (mutable) push whose banner the
// Notification Service Extension rewrites after fetching content from the
// node over the tunnel. Everything else is a silent background sync push.
const MUTABLE_TYPES = new Set([
  "job.needs_input",
  "job.completed",
  "job.failed",
  "handoff.ready",
  "handoff.failed",
  // A credential sync that did not land has to be seen: without a push, the
  // user goes on believing their sandbox is authenticated and only finds out
  // when a job fails to fetch their repo. The success side stays silent
  // (background sync) — `relay sync-auth` already reported it at the
  // terminal.
  "credentials.failed",
]);

const KNOWN_TYPES = new Set([
  "job.state",
  "job.needs_input",
  "job.silence",
  "job.completed",
  "job.failed",
  "node.health",
  "handoff.ready",
  "handoff.failed",
  "credentials.installed",
  "credentials.failed",
]);

const PROTOCOL_VERSION = 1;

// UUID, ULID and nanoid all fit; prose does not.
const EVENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// Clock window for `ts`. Generous enough for NTP drift and a slow retry,
// tight enough that a captured event stops being plausible quickly.
const TS_MAX_AGE_MS = 10 * 60 * 1000;
const TS_MAX_SKEW_MS = 2 * 60 * 1000;

// Fanout runs off the ingest request. A user with a handful of devices does
// not need more than this, and the bound is what stops one account's slow
// devices from occupying the whole process.
const FANOUT_CONCURRENCY = 4;

// A push pipeline that is failing on every send must say so, but must not
// write a line per device per event. First failure logs immediately, then at
// most one line per key per interval.
const ALERT_INTERVAL_MS = 60 * 1000;

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

// Points whose order divides 8. For every one of these a signature can be
// constructed with NO private key: taking the identity point A, the pair
// (R = A, S = 0) collapses the verification equation to A = A and therefore
// verifies against any message whatsoever. A node registered with such a
// pubkey is an auth boundary that returns a node for a request nobody
// signed, and a node whose key material is zeroed or corrupted to one of
// these values fails OPEN rather than closed.
//
// OpenSSL does not refuse these on import, so we refuse them here. The list
// is libsodium's ed25519_small_order() blacklist: 0, 1, the two order-8
// points, and p-1 / p / p+1. relayd's seal.mjs applies the equivalent rule to
// the X25519 half of a node's identity (a non-canonical or degenerate
// recipient key is `seal_bad_public_key`); the two key types live on the same
// node row and are set by the same enrolment paths, so a key shape rejected
// on one side must not be accepted on the other.
const ED25519_SMALL_ORDER_POINTS = [
  "0000000000000000000000000000000000000000000000000000000000000000",
  "0100000000000000000000000000000000000000000000000000000000000000",
  "26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
  "c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
  "ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
  "eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
].map((hex) => Buffer.from(hex, "hex"));

// Byte 31's high bit is the x-coordinate sign, which does not change a
// point's order — mask it before comparing, exactly as libsodium does, so the
// sign-bit variant of each encoding is refused too. Public keys are not
// secret, so a plain compare is fine here.
function isSmallOrderEd25519(raw) {
  const probe = Buffer.from(raw);
  probe[31] &= 0x7f;
  return ED25519_SMALL_ORDER_POINTS.some((point) => probe.equals(point));
}

// Accepts either an SPKI PEM ("-----BEGIN PUBLIC KEY-----…") or base64 of the
// raw 32-byte ed25519 public key. Returns a KeyObject or null.
export function parseNodePubkey(pubkey) {
  try {
    if (typeof pubkey !== "string" || !pubkey) return null;
    let key;
    if (pubkey.includes("BEGIN PUBLIC KEY")) {
      key = createPublicKey(pubkey);
      if (key.asymmetricKeyType !== "ed25519") return null;
    } else {
      const raw = Buffer.from(pubkey, "base64");
      if (raw.length !== 32) return null;
      key = createPublicKey({
        key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
        format: "der",
        type: "spki",
      });
    }
    // Re-export rather than trusting the input encoding: both branches end up
    // holding the same 32 raw bytes, and only those bytes decide the order.
    const raw = key.export({ type: "spki", format: "der" }).subarray(ED25519_SPKI_PREFIX.length);
    if (raw.length !== 32 || isSmallOrderEd25519(raw)) return null;
    return key;
  } catch {
    return null;
  }
}

export function createNotify({
  registry,
  apns,
  config,
  now = () => Date.now(),
  log = (msg) => console.warn(msg),
}) {
  const stats = {
    accepted: 0,
    duplicates: 0,
    queued: 0,
    delivered: 0,
    unregistered: 0,
    authFailed: 0,
    rejected: 0,
    unavailable: 0,
    timeout: 0,
    error: 0,
    skipped: 0,
    tokensDropped: 0,
  };
  const lastAlertAt = new Map();
  const inflight = new Set();

  function alert(key, message) {
    const t = now();
    const last = lastAlertAt.get(key);
    if (last !== undefined && t - last < ALERT_INTERVAL_MS) return;
    lastAlertAt.set(key, t);
    log(message);
  }

  // rawBody: Buffer of the request body exactly as received.
  // signatureB64: base64/base64url detached ed25519 signature over rawBody.
  // Returns { status, body } for the HTTP layer. Resolves as soon as the
  // event is durably accounted for — the APNs fanout continues in the
  // background, so ingest latency does not depend on any device or on Apple.
  async function ingest(rawBody, signatureB64) {
    let event;
    try {
      event = JSON.parse(rawBody.toString("utf8"));
    } catch {
      return { status: 400, body: { error: "invalid_json" } };
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return { status: 400, body: { error: "invalid_event" } };
    }
    const { v, nodeId, jobId, type, ts, seq } = event;

    if (v !== PROTOCOL_VERSION) {
      return { status: 400, body: { error: "unsupported_version" } };
    }
    if (
      typeof nodeId !== "string" ||
      !EVENT_ID_RE.test(nodeId) ||
      typeof type !== "string" ||
      !KNOWN_TYPES.has(type) ||
      !Number.isSafeInteger(seq) ||
      seq < 1 ||
      !Number.isSafeInteger(ts) ||
      (jobId != null && (typeof jobId !== "string" || !EVENT_ID_RE.test(jobId)))
    ) {
      return { status: 400, body: { error: "invalid_event" } };
    }

    const nowMs = now();
    if (ts < nowMs - TS_MAX_AGE_MS || ts > nowMs + TS_MAX_SKEW_MS) {
      return { status: 400, body: { error: "ts_out_of_window" } };
    }

    const node = registry.getNode(nodeId);
    if (!node) return { status: 404, body: { error: "unknown_node" } };

    const key = parseNodePubkey(node.pubkey);
    if (!key) return { status: 500, body: { error: "node_key_unusable" } };

    let sig;
    try {
      sig = Buffer.from(String(signatureB64 || ""), "base64url");
    } catch {
      sig = Buffer.alloc(0);
    }
    if (sig.length === 0 || !cryptoVerify(null, rawBody, key, sig)) {
      return { status: 401, body: { error: "bad_signature" } };
    }

    const kind = MUTABLE_TYPES.has(type) ? "mutable" : "silent";

    // Everything above this line is read-only. Nothing mutates state, and in
    // particular nothing pushes, until the signature has been verified AND
    // the sequence number has been claimed — otherwise a captured request
    // replayed N times wakes the user's phone N times, and each wake dials
    // the user's own node, turning the control plane into an amplifier
    // pointed at the machine it is supposed to protect.
    if (!registry.claimNodeEventSeq(nodeId, seq)) {
      stats.duplicates += 1;
      return { status: 202, body: { ok: true, kind, duplicate: true, queued: 0 } };
    }

    // Clamped, not trusted: retention is driven off created_at, but a stored
    // ts far in the future would still poison anything that reads it later.
    const storedTs = Math.min(ts, nowMs);
    const inserted = registry.insertNodeEvent({
      nodeId,
      accountId: node.accountId,
      jobId: jobId ?? null,
      type,
      ts: storedTs,
      seq,
    });
    if (inserted === null) {
      stats.duplicates += 1;
      return { status: 202, body: { ok: true, kind, duplicate: true, queued: 0 } };
    }
    registry.touchNode(nodeId);
    stats.accepted += 1;

    const devices = registry.listPushDevices(node.accountId);
    const payload = { nodeId, jobId: jobId ?? null, type, ts: storedTs, seq };
    // Bounded to 64 bytes and scoped to the push class — see apnsCollapseId.
    const collapseId = jobId
      ? apnsCollapseId(nodeId, jobId, kind)
      : undefined;

    stats.queued += devices.length;
    track(
      fanout({
        devices,
        kind,
        category: kind === "mutable" ? categoryFor(type) : undefined,
        payload,
        collapseId,
      }),
    );

    return { status: 202, body: { ok: true, kind, queued: devices.length } };
  }

  // Bounded-concurrency fanout. Never rejects: every per-device failure is
  // classified and counted, so one dead device cannot abort the rest.
  async function fanout({ devices, kind, category, payload, collapseId }) {
    let next = 0;
    const worker = async () => {
      while (next < devices.length) {
        const device = devices[next++];
        try {
          const result = await apns.send({
            deviceToken: device.apnsToken,
            kind,
            category,
            payload,
            collapseId,
          });
          record(device, result);
        } catch (err) {
          // apns.send is documented not to throw; if it ever does, the fanout
          // still must not take the process down.
          stats.error += 1;
          alert("send_threw", `apns send threw: ${String(err?.message ?? err)}`);
        }
      }
    };
    const workers = Array.from(
      { length: Math.min(FANOUT_CONCURRENCY, devices.length) },
      worker,
    );
    const before = { ...stats };
    await Promise.all(workers);

    // One summary line per fanout, and NOT through alert(): alert() is
    // rate-limited per key, so a fanout where every device failed logs the same
    // single line as one where a single stale token failed. That is exactly how
    // this went undiagnosable in production — the log showed one "apns
    // transport error" for a 27-device fanout and nothing said whether the
    // other 26 arrived, because the stats counters were never printed anywhere.
    //
    // Counts are deltas for THIS fanout (stats is cumulative), and carry no
    // device ids or tokens — the outcome mix is the diagnostic.
    const delta = {};
    for (const key of Object.keys(stats)) {
      const moved = stats[key] - (before[key] ?? 0);
      if (moved > 0) delta[key] = moved;
    }
    const summary = Object.entries(delta)
      .filter(([key]) => key !== "queued")
      .map(([key, count]) => `${key}=${count}`)
      .join(" ");
    log(`apns fanout: devices=${devices.length} ${summary || "no outcomes recorded"}`);
  }

  function record(device, result) {
    switch (result.outcome) {
      case APNS_OUTCOME.DELIVERED:
        stats.delivered += 1;
        return;

      case APNS_OUTCOME.UNREGISTERED:
        // The only signal Apple gives that an app was uninstalled. Ignoring
        // it means retrying a dead token on every event, forever.
        stats.unregistered += 1;
        if (registry.clearApnsToken(device.id, device.apnsToken)) {
          stats.tokensDropped += 1;
        }
        return;

      case APNS_OUTCOME.AUTH_FAILED:
        // Wrong team id, rotated-out .p8, expired provider token: every push
        // for every user fails identically and nothing else will notice.
        stats.authFailed += 1;
        alert(
          "auth_failed",
          `apns AUTH FAILURE — every push is failing: status=${result.status} reason=${result.reason ?? "unknown"}`,
        );
        return;

      case APNS_OUTCOME.REJECTED:
        // 4xx that is not a token problem: bad topic, oversize payload, bad
        // collapse id. Always our bug, always total.
        stats.rejected += 1;
        alert(
          `rejected:${result.status}:${result.reason ?? "unknown"}`,
          `apns rejected push: status=${result.status} reason=${result.reason ?? "unknown"} device=${device.id}`,
        );
        return;

      case APNS_OUTCOME.UNAVAILABLE:
        stats.unavailable += 1;
        alert(
          "unavailable",
          `apns unavailable: status=${result.status} reason=${result.reason ?? "unknown"}`,
        );
        return;

      case APNS_OUTCOME.TIMEOUT:
        stats.timeout += 1;
        alert("timeout", `apns request timed out: device=${device.id}`);
        return;

      case APNS_OUTCOME.SKIPPED:
        stats.skipped += 1;
        return;

      default:
        stats.error += 1;
        alert(
          "error",
          `apns transport error: ${result.error ?? result.outcome}`,
        );
    }
  }

  function track(promise) {
    const guarded = promise.catch((err) => {
      stats.error += 1;
      alert("fanout", `apns fanout failed: ${String(err?.message ?? err)}`);
    });
    inflight.add(guarded);
    guarded.finally(() => inflight.delete(guarded));
  }

  // Awaits every fanout currently in flight. Deterministic join point for
  // tests and for a graceful shutdown; not needed on the request path.
  async function drain() {
    while (inflight.size > 0) {
      await Promise.all([...inflight]);
    }
  }

  function sweep() {
    const cutoff = now() - config.eventRetentionDays * 24 * 3600 * 1000;
    registry.sweepNodeEvents(cutoff);
  }

  return { ingest, sweep, drain, stats: () => ({ ...stats }) };
}

function categoryFor(type) {
  switch (type) {
    case "job.needs_input":
      return "RELAY_NEEDS_INPUT"; // actionable: Approve / Deny / Open
    case "job.completed":
      return "RELAY_JOB_DONE";
    case "job.failed":
      return "RELAY_JOB_FAILED";
    case "handoff.ready":
      return "RELAY_HANDOFF_READY";
    case "handoff.failed":
      return "RELAY_HANDOFF_FAILED";
    case "credentials.failed":
      return "RELAY_CREDENTIALS_FAILED";
    default:
      return "RELAY_EVENT";
  }
}
