// Relay Cloud HTTP surface (node:http, no frameworks).
//
// Auth tiers, in order of privilege scope:
//   - session bearer (HS256 JWT)     → account-scoped control-plane actions
//   - pairing authToken (X-Pairing-Auth) → one rendezvous session only
//   - ed25519 body signature         → node event ingest only
//   - ADMIN_TOKEN / BROKER_TOKEN bearer → ops endpoints (never the data path)
//
// None of these ever authorize file reads or job submission on a node; the
// node data path is mTLS-only and does not transit this server.
//
// The pairing authToken is NOT the pairing secret: it is
// sha256("relay-pair-auth-v1" || 0x00 || secret), derived by the two peers.
// The cloud never receives the secret, so it can never derive the MAC key that
// authenticates relayed blobs — see pairing.js for the full rationale.

import { createServer } from "node:http";
import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { createDb } from "./db.js";
import { createRegistry } from "./registry.js";
import { createAuth, createAppleJwksFetcher } from "./auth.js";
import { createRelayBetterAuth } from "./better-auth.js";
import { createPairing } from "./pairing.js";
import { createNotify, parseNodePubkey } from "./notify.js";
import { createApnsClient, createNoopTransport } from "./apns.js";
import { createProvisioner } from "./provisioner.js";
import { verifyNodeRequest, createReplayGuard } from "./nodeauth.js";

const NODE_KINDS = new Set(["byo", "managed"]);

// Bounds how many polls from ONE node can be parked at once on
// GET /v1/node/handoffs. A client that connects, signs a valid request, and
// immediately disconnects still costs a Set entry, a timer, and a live
// req/res pair until something releases it; uncapped, a flood of such
// clients pins unbounded resources for up to handoffPollMaxWaitSec each. See
// Task 8 review, I-2.
export const HANDOFF_MAX_WAITERS_PER_NODE = 8;

export function createApp({
  config,
  db = createDb(config.dbPath),
  jwksFetcher = createAppleJwksFetcher(config.appleJwksUrl),
  mailTransport = { send: async () => {} },
  apnsTransport = createNoopTransport(),
  now = () => Date.now(),
  provisioner = createProvisioner(config),
} = {}) {
  const registry = createRegistry(db, { now });
  const legacyAuth = createAuth({ registry, config, jwksFetcher, mailTransport, now });
  const betterAuth = createRelayBetterAuth({
    db,
    registry,
    config,
    // Deleting the account drops the trial_nodes row, after which nothing can
    // map the account back to its microVM — so the sandbox has to go first.
    // releaseSandbox never throws, so a dead Cube host degrades to a recorded
    // orphan instead of an account that cannot be deleted.
    beforeAccountDelete: (accountId) =>
      releaseSandbox(registry.getTrialByAccount(accountId), "account_deleted"),
  });
  const auth = {
    ...legacyAuth,
    betterAuth: betterAuth.auth,
    ready: betterAuth.ready,
    appleConfigured: betterAuth.appleConfigured,
    async authenticate(req) {
      return legacyAuth.authenticate(req) || (await betterAuth.authenticate(req));
    },
  };
  const pairing = createPairing({ registry, config, now });
  const apns = createApnsClient({ config, transport: apnsTransport, now });
  const notify = createNotify({ registry, apns, config, now });

  // Destroys a trial's sandbox, or records it for reconciliation when it
  // cannot be destroyed right now (no provisioner configured, or the Cube host
  // refused/timed out). Never throws: every caller — account deletion and the
  // reaper — has control-plane work that MUST still happen even when the
  // sandbox half fails, and an unreachable host must never be able to make an
  // account undeletable or stall a sweep pass.
  async function releaseSandbox(trial, reason) {
    if (!trial?.sandboxId) return;
    if (provisioner) {
      try {
        await provisioner.killSandbox(trial.sandboxId);
        registry.clearSandboxOrphan(trial.sandboxId);
        return;
      } catch (err) {
        console.error(`sandbox destroy failed (${reason}): ${err?.message}`);
      }
    }
    registry.recordSandboxOrphan({
      sandboxId: trial.sandboxId,
      trialId: trial.id,
      accountId: trial.accountId,
      reason,
    });
  }

  // Second chance at sandboxes an earlier pass could not destroy. Cheap and
  // bounded; a no-op while the trial feature is switched off, which is exactly
  // when the backlog accumulates.
  async function reconcileSandboxOrphans() {
    if (!provisioner) return;
    for (const orphan of registry.listSandboxOrphans()) {
      try {
        await provisioner.killSandbox(orphan.sandboxId);
        registry.clearSandboxOrphan(orphan.sandboxId);
      } catch (err) {
        console.error(`orphan reconcile failed: ${err?.message}`);
      }
    }
  }

  // Guard against overlapping passes. runSweeps fires this without awaiting on
  // a 60 s timer, so a pass slowed by an unresponsive provisioner would
  // otherwise be re-entered by the next tick and double-issue pause/kill/
  // deleteNode against the same rows.
  let trialSweepInFlight = false;

  // Waiters for GET /v1/node/handoffs, keyed by node id. Lives inside
  // createApp (not module-global) so each app instance — and therefore each
  // test — owns its own waiters instead of leaking state across instances.
  //
  // Each entry is `{ settle, timer }`. Keeping `timer` alongside `settle`
  // (rather than firing-and-forgetting it) lets a disconnecting client be
  // released immediately instead of pinning the waiter until the wait
  // deadline (I-2), and keeps the Timeout object inspectable from tests
  // (`Timeout#hasRef()`) without spawning a child process to observe
  // process-exit timing.
  const handoffWaiters = new Map();

  // A per-app-instance replay guard for the node long-poll: see I-3. Kept
  // per instance, like handoffWaiters, so tests don't leak claimed
  // (nodeId, ts, signature) triples across app instances.
  const handoffReplayGuard = createReplayGuard();

  function wakeHandoffWaiters(nodeId) {
    const waiters = handoffWaiters.get(nodeId);
    if (!waiters) return;
    handoffWaiters.delete(nodeId);
    for (const entry of waiters) entry.settle();
  }

  // `req` is the parked long-poll's own request; a "close" on it — the
  // client disconnecting, a proxy dropping the connection, anything short of
  // a normal response — releases the waiter immediately rather than pinning
  // its timer/Set entry/req/res for the rest of `timeoutMs` (I-2). The
  // route handler is responsible for checking `req.destroyed` after this
  // resolves and skipping the delivery flip when it is set (C-1) — this
  // function only manages the wait itself.
  //
  // A node already at HANDOFF_MAX_WAITERS_PER_NODE parked polls does not
  // park a new one at all; it resolves immediately so the caller falls
  // through to an ordinary (typically empty) response instead of holding a
  // socket it has no budget for (I-2).
  function waitForHandoff(nodeId, timeoutMs, req) {
    return new Promise((resolve) => {
      let waiters = handoffWaiters.get(nodeId);
      if (waiters && waiters.size >= HANDOFF_MAX_WAITERS_PER_NODE) {
        resolve();
        return;
      }
      if (!waiters) {
        waiters = new Set();
        handoffWaiters.set(nodeId, waiters);
      }

      const entry = {
        timer: null,
        settle() {
          clearTimeout(entry.timer);
          req.removeListener("close", onClose);
          waiters.delete(entry);
          // The empty Set left behind by a natural timeout is never removed
          // by anything else — dropping it here is what keeps
          // handoffWaiters from growing without bound over the process
          // lifetime as trial nodes churn (I-1).
          if (waiters.size === 0) handoffWaiters.delete(nodeId);
          resolve();
        },
      };
      const onClose = () => entry.settle();
      entry.timer = setTimeout(() => entry.settle(), timeoutMs);
      entry.timer.unref?.();
      req.on("close", onClose);
      waiters.add(entry);
    });
  }

  async function sweepTrials() {
    if (trialSweepInFlight) return;
    trialSweepInFlight = true;
    try {
      // Lifecycle enforcement is deliberately NOT gated on the provisioner.
      // `E2B_API_URL` is the kill switch for CREATING trials (POST
      // /v1/trial-nodes still 404s without it); if unsetting it also switched
      // off the reaper, every trial already in the wild would stop expiring —
      // node rows staying live and users keeping access indefinitely, which is
      // the opposite of what reaching for a kill switch means. Expiring access
      // is pure control-plane work and always runs. Only the sandbox-destroying
      // half needs the provisioner, and what it cannot destroy is recorded as
      // an orphan rather than silently forgotten.
      //
      // Each row is isolated: one trial's failure must not abort the pass and
      // strand every trial behind it.
      for (const trial of registry.listTrialsDue(now())) {
        try {
          if (trial.sandboxId && provisioner) {
            try { await provisioner.pauseSandbox(trial.sandboxId); } catch {}
          }
          // Access expires whether or not the machine could be paused. The row
          // keeps its sandbox id, so the grace-point destroy can still find it.
          registry.updateTrial(trial.id, { state: "expired", enrollTokenHash: null });
        } catch (err) {
          console.error(`trial expire failed for ${trial.id}: ${err?.message}`);
        }
      }

      for (const trial of registry.listTrialsPastGrace(now(), config.trial.graceSec * 1000)) {
        try {
          await releaseSandbox(trial, "trial_past_grace");
          if (trial.nodeId) registry.deleteNode(trial.accountId, trial.nodeId);
          registry.updateTrial(trial.id, { state: "destroyed" });
        } catch (err) {
          console.error(`trial destroy failed for ${trial.id}: ${err?.message}`);
        }
      }

      await reconcileSandboxOrphans();
    } finally {
      trialSweepInFlight = false;
    }
  }

  function runSweeps() {
    pairing.sweep();
    notify.sweep();
    registry.sweepDeviceCodes(now());
    sweepTrials().catch((err) => console.error(`trial sweep failed: ${err?.message}`));
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak internals (or any token material) into responses/logs.
      console.error(`unhandled: ${req.method} ${req.url}: ${err?.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    const method = req.method;
    const seg = path.split("/").filter(Boolean);

    // ── health ──────────────────────────────────────────────────────────
    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    // ── auth ────────────────────────────────────────────────────────────
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      await auth.ready;
      return betterAuth.handler(req, res);
    }

    // Legacy endpoints remain during the native-client migration.
    if (method === "POST" && path === "/v1/auth/apple") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      if (!body || typeof body.identityToken !== "string") {
        return sendJson(res, 400, { error: "identityToken_required" });
      }
      const session = await auth.appleSignIn(body.identityToken);
      if (!session) return sendJson(res, 401, { error: "invalid_identity_token" });
      return sendJson(res, 200, session);
    }

    if (method === "POST" && path === "/v1/auth/refresh") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const session = auth.refresh(body?.refreshToken);
      if (!session) return sendJson(res, 401, { error: "invalid_refresh_token" });
      return sendJson(res, 200, session);
    }

    if (method === "POST" && path === "/v1/auth/magic-link/request") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const result = await auth.requestMagicLink(body?.email);
      if (!result.ok) return sendJson(res, 400, { error: "invalid_email" });
      // 202 regardless of account existence — no enumeration.
      return sendJson(res, 202, { ok: true });
    }

    if (method === "POST" && path === "/v1/auth/magic-link/confirm") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const session = auth.confirmMagicLink(body?.token);
      if (!session) return sendJson(res, 401, { error: "invalid_or_expired_link" });
      return sendJson(res, 200, session);
    }

    // ── device-code login (CLI, no browser) ─────────────────────────────
    //
    // Unauthenticated by construction — the CLI has no session yet, which is
    // the entire point of the flow. /device/approve, which mints the
    // session, lives below the session-auth boundary because only a
    // signed-in human may approve a pending code.
    if (method === "POST" && path === "/v1/auth/device/start") {
      const deviceCode = randomBytes(32).toString("base64url");
      const record = registry.createDeviceCode({
        deviceCodeHash: sha256Hex(deviceCode),
        userCode: mintUserCode(),
        expiresAt: now() + config.deviceCodeTtlSec * 1000,
      });
      return sendJson(res, 201, {
        deviceCode,
        userCode: record.userCode,
        verificationUri: config.deviceLoginUrl,
        interval: config.deviceCodePollIntervalSec,
        expiresIn: config.deviceCodeTtlSec,
      });
    }

    if (method === "POST" && path === "/v1/auth/device/token") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const record = registry.getDeviceCodeByHash(sha256Hex(strOrNull(body?.deviceCode) || ""));
      if (!record || record.consumedAt !== null) return sendJson(res, 400, { error: "invalid_grant" });
      if (record.expiresAt <= now()) return sendJson(res, 400, { error: "expired_token" });
      if (record.accountId === null) return sendJson(res, 400, { error: "authorization_pending" });
      if (!registry.consumeDeviceCode(record.id)) return sendJson(res, 400, { error: "invalid_grant" });
      const account = registry.getAccount(record.accountId);
      if (!account) return sendJson(res, 400, { error: "invalid_grant" });
      return sendJson(res, 200, auth.issueSession(account));
    }

    // ── waitlist (public) ───────────────────────────────────────────────
    if (method === "POST" && path === "/v1/waitlist") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const email = String(body?.email || "").trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return sendJson(res, 400, { error: "invalid_email" });
      }
      registry.addToWaitlist(email);
      return sendJson(res, 202, { ok: true });
    }

    // ── node event ingest (signature-authed) ────────────────────────────
    if (method === "POST" && path === "/v1/node-events") {
      const raw = await readRaw(req, config.nodeEventMaxBytes);
      if (raw === null) return sendJson(res, 413, { error: "body_too_large" });
      const result = await notify.ingest(raw, req.headers["x-relay-signature"]);
      return sendJson(res, result.status, result.body);
    }

    // ── pairing rendezvous (protocol v2) ────────────────────────────────
    //
    // The caller supplies the derived authToken; the cloud never generates a
    // pairing secret and returns nothing secret. Blob tags ride in
    // X-Pairing-Tag and are stored/returned verbatim — the cloud cannot check
    // them and must not pretend to.
    if (method === "POST" && path === "/v1/pairing/sessions") {
      const account = await auth.authenticate(req);
      if (!account) return sendJson(res, 401, { error: "unauthorized" });
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const outcome = pairing.createSession({
        accountId: account.id,
        authToken: typeof body?.authToken === "string" ? body.authToken : null,
        kind: body?.kind ?? "pair",
      });
      if (outcome === "invalid_auth_token") {
        return sendJson(res, 400, { error: "auth_token_required" });
      }
      if (outcome === "invalid_kind") {
        return sendJson(res, 400, { error: "invalid_kind" });
      }
      if (outcome === "too_many_sessions") {
        return sendJson(res, 429, { error: "too_many_pairing_sessions" });
      }
      return sendJson(res, 201, outcome);
    }

    if (
      seg.length === 5 &&
      seg[0] === "v1" &&
      seg[1] === "pairing" &&
      seg[2] === "sessions" &&
      (seg[4] === "node-blob" || seg[4] === "device-blob")
    ) {
      const id = seg[3];
      const slot = seg[4] === "node-blob" ? "node" : "device";
      const authToken = String(
        req.headers["x-pairing-auth"] || req.headers["x-pairing-secret"] || "",
      );
      if (method === "POST") {
        const raw = await readRaw(req, config.pairingBlobMaxBytes);
        if (raw === null) return sendJson(res, 413, { error: "blob_too_large" });
        const tag = String(req.headers["x-pairing-tag"] || "");
        const outcome = pairing.putBlob(id, authToken, slot, raw, tag);
        if (outcome === "ok") return sendJson(res, 204, null);
        if (outcome === "too_large") return sendJson(res, 413, { error: "blob_too_large" });
        if (outcome === "bad_slot") return sendJson(res, 400, { error: "invalid_blob" });
        if (outcome === "conflict") return sendJson(res, 409, { error: "slot_already_written" });
        return sendJson(res, 401, { error: "unauthorized" });
      }
      if (method === "GET") {
        const outcome = pairing.getBlob(id, authToken, slot);
        if (outcome === "unauthorized") return sendJson(res, 401, { error: "unauthorized" });
        if (outcome === "bad_slot") return sendJson(res, 400, { error: "invalid_blob" });
        if (outcome === "empty") return sendJson(res, 404, { error: "not_posted_yet" });
        return sendBytes(res, 200, outcome.blob, { "x-pairing-tag": outcome.tag });
      }
    }

    // ── tunnel-registry hook (broker-authed) ────────────────────────────
    if (
      method === "GET" &&
      seg.length === 4 &&
      seg[0] === "v1" &&
      seg[1] === "tunnel" &&
      seg[2] === "nodes"
    ) {
      if (!bearerMatches(req, config.brokerToken)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      const node = registry.getNode(seg[3]);
      if (!node) return sendJson(res, 404, { error: "unknown_node" });
      return sendJson(res, 200, {
        nodeId: node.id,
        accountId: node.accountId,
        kind: node.kind,
        pubkey: node.pubkey,
      });
    }

    // ── trial enroll (single-use token from the sandbox bootstrap) ─────────
    if (method === "POST" && path === "/v1/trial-nodes/enroll") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const token = typeof body?.token === "string" ? body.token : "";
      const trial = token ? registry.getTrialByTokenHash(sha256Hex(token)) : null;
      if (!trial || trial.state !== "creating") {
        return sendJson(res, 401, { error: "invalid_enroll_token" });
      }
      const nodeId = typeof body?.nodeId === "string" ? body.nodeId : "";
      if (!/^node-[0-9a-f]{16}$/.test(nodeId)) {
        return sendJson(res, 400, { error: "invalid_node_id" });
      }
      if (!parseNodePubkey(body?.pubkey)) {
        return sendJson(res, 400, { error: "invalid_pubkey" });
      }
      // Present-but-wrong-typed must 400, never silently normalize to "no
      // key" — a client bug (number/object/array/JSON null) would otherwise
      // enroll a node with no encryption key at all, permanently unable to
      // receive a sealed handoff, with nothing to explain why.
      if (body?.encPubkey !== undefined && typeof body.encPubkey !== "string") {
        return sendJson(res, 400, { error: "invalid_enc_pubkey" });
      }
      const encPubkey = strOrNull(body?.encPubkey);
      // Canonical base64 only — the exact rule product/relayd/src/seal.mjs's
      // sealTo() enforces (decode, then require the bytes to re-encode back
      // to the identical string). Node's base64 decoder is lenient: it
      // accepts base64url characters, ignores embedded whitespace, and skips
      // other junk spliced into the string, so a length-only check here would
      // let a key through that seal.mjs later refuses to use. Rejecting the
      // same malformed key at enroll — where the error is diagnosable —
      // instead of at handoff time — where it would surface as an opaque
      // decrypt failure on the user's phone — is the entire point of this
      // check. Kept byte-for-byte identical to seal.mjs's rule because this
      // key crosses a process boundary and the two sides must agree exactly.
      if (encPubkey !== null) {
        const raw = Buffer.from(encPubkey, "base64");
        if (raw.length !== 32 || raw.toString("base64") !== encPubkey) {
          return sendJson(res, 400, { error: "invalid_enc_pubkey" });
        }
      }
      if (registry.getNode(nodeId)) {
        return sendJson(res, 409, { error: "node_exists" });
      }
      registry.createNode(trial.accountId, {
        id: nodeId, kind: "trial", name: "Trial machine",
        pubkey: String(body.pubkey), encPubkey, version: strOrNull(body?.version),
      });
      registry.updateTrial(trial.id, { state: "ready", nodeId, enrollTokenHash: null });
      return sendJson(res, 200, { ok: true, sni: config.tunnel.suffix ? `${nodeId}${config.tunnel.suffix}` : nodeId });
    }

    // ── admin (ops-authed) ──────────────────────────────────────────────
    if (method === "GET" && path === "/v1/admin/nodes") {
      if (!bearerMatches(req, config.adminToken)) {
        return sendJson(res, 401, { error: "unauthorized" });
      }
      return sendJson(res, 200, {
        nodes: registry.adminListNodes().map((n) => ({
          id: n.id,
          accountId: n.accountId,
          kind: n.kind,
          name: n.name,
          version: n.version,
          lastSeen: n.lastSeen,
          createdAt: n.createdAt,
        })),
      });
    }

    // ── node handoff long-poll (signature-authed) ───────────────────────
    //
    // A node holds this open waiting for the next `relay handoff` ping meant
    // for it. Signature-authed rather than session-authed: the node has no
    // session, only its ed25519 identity — the same shape as the other
    // node-signed GETs in nodeauth.js.
    if (method === "GET" && path === "/v1/node/handoffs") {
      const pathWithQuery = `${path}${url.search}`;
      const verified = verifyNodeRequest(req, pathWithQuery, { registry, now, replayGuard: handoffReplayGuard });
      if (verified.error) return sendJson(res, 401, { error: "unauthorized" });

      const nodeId = verified.node.id;
      const requested = Number.parseInt(url.searchParams.get("wait") || "0", 10);
      const waitSec = Number.isSafeInteger(requested)
        ? Math.max(0, Math.min(requested, config.handoffPollMaxWaitSec))
        : 0;
      if (waitSec > 0 && registry.countPendingHandoffs(nodeId) === 0) {
        await waitForHandoff(nodeId, waitSec * 1000, req);
      }
      // A client that vanished — mid-wait, at the per-node cap, or in the
      // instant between the wait resolving and this line — must never have a
      // handoff flipped to `delivered` on its behalf: the bytes would go
      // nowhere and the row would be gone for good, with no log line and no
      // recovery but a brand-new handoff id. Leaving it `pending` here is
      // what makes "the node catches up on reconnect" — the design's own
      // failure-mode promise — actually true. See Task 8 review, C-1.
      if (req.destroyed) return;

      const pending = registry.listPendingHandoffs(nodeId);
      for (const handoff of pending) {
        registry.updateHandoff(handoff.id, { state: "delivered", deliveredAt: now() });
      }
      registry.touchNode(nodeId);
      return sendJson(res, 200, {
        handoffs: pending.map(({ id, repo, branch }) => ({ id, repo, branch })),
      });
    }

    // ── session-authed registry endpoints ───────────────────────────────
    const account = await auth.authenticate(req);
    if (!account) return sendJson(res, 401, { error: "unauthorized" });

    if (method === "POST" && path === "/v1/auth/device/approve") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const userCode = normalizeUserCode(body?.userCode);
      const record = userCode ? registry.getDeviceCodeByUserCode(userCode) : null;
      if (!record || record.consumedAt !== null || record.expiresAt <= now()) {
        return sendJson(res, 404, { error: "unknown_user_code" });
      }
      registry.approveDeviceCode(record.id, account.id);
      return sendJson(res, 200, { ok: true });
    }

    if (method === "GET" && path === "/v1/account") {
      return sendJson(res, 200, {
        account: { id: account.id, email: account.email },
        entitlements: registry.listEntitlements(account.id),
      });
    }

    if (path === "/v1/devices" && method === "POST") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      if (!body) return sendJson(res, 400, { error: "invalid_json" });
      const device = registry.createDevice(account.id, {
        apnsToken: strOrNull(body.apnsToken),
        platform: strOrNull(body.platform),
        name: strOrNull(body.name),
        certSerials: Array.isArray(body.certSerials)
          ? body.certSerials.map(String)
          : [],
      });
      return sendJson(res, 201, { device });
    }

    if (path === "/v1/devices" && method === "GET") {
      return sendJson(res, 200, { devices: registry.listDevices(account.id) });
    }

    if (seg.length === 3 && seg[0] === "v1" && seg[1] === "devices") {
      const id = seg[2];
      if (method === "PATCH") {
        const body = await readJson(req, config.jsonBodyMaxBytes);
        if (!body) return sendJson(res, 400, { error: "invalid_json" });
        const patch = {};
        if ("apnsToken" in body) patch.apnsToken = strOrNull(body.apnsToken);
        if ("platform" in body) patch.platform = strOrNull(body.platform);
        if ("name" in body) patch.name = strOrNull(body.name);
        if ("certSerials" in body) {
          patch.certSerials = Array.isArray(body.certSerials)
            ? body.certSerials.map(String)
            : [];
        }
        const device = registry.updateDevice(account.id, id, patch);
        if (!device) return sendJson(res, 404, { error: "unknown_device" });
        return sendJson(res, 200, { device });
      }
      if (method === "DELETE") {
        registry.deleteDevice(account.id, id);
        return sendJson(res, 204, null);
      }
    }

    if (path === "/v1/nodes" && method === "POST") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      if (!body) return sendJson(res, 400, { error: "invalid_json" });
      const kind = String(body.kind || "");
      if (!NODE_KINDS.has(kind)) {
        return sendJson(res, 400, { error: "kind_must_be_byo_or_managed" });
      }
      if (!parseNodePubkey(body.pubkey)) {
        return sendJson(res, 400, { error: "invalid_pubkey" });
      }
      // Entitlement gate. Trial nodes are excluded from the count: the trial
      // machine is granted by the cloud (the enroll route creates it bypassing
      // this gate entirely), so counting it against `nodes.max` would 403 every
      // trial user who tries to register their own box — the exact upgrade path
      // the trial is meant to lead to.
      const max = Number.parseInt(
        registry.getEntitlement(account.id, "nodes.max") ?? "0",
        10,
      );
      if (registry.countNodes(account.id, { includeTrial: false }) >= max) {
        return sendJson(res, 403, {
          error: "entitlement_limit",
          feature: "nodes.max",
          limit: max,
        });
      }
      const node = registry.createNode(account.id, {
        kind,
        name: strOrNull(body.name),
        pubkey: String(body.pubkey),
        version: strOrNull(body.version),
      });
      return sendJson(res, 201, { node });
    }

    if (path === "/v1/nodes" && method === "GET") {
      return sendJson(res, 200, { nodes: registry.listNodes(account.id) });
    }

    if (seg.length === 3 && seg[0] === "v1" && seg[1] === "nodes") {
      const node = registry.getNode(seg[2]);
      if (!node || node.accountId !== account.id) {
        return sendJson(res, 404, { error: "unknown_node" });
      }
      if (method === "GET") return sendJson(res, 200, { node });
      if (method === "DELETE") {
        registry.deleteNode(account.id, node.id);
        return sendJson(res, 204, null);
      }
    }

    if (method === "POST" && path === "/v1/repos") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const fullName = normalizeRepoFullName(body?.fullName);
      if (!fullName) return sendJson(res, 400, { error: "invalid_repo" });
      return sendJson(res, 201, { repo: registry.upsertRepo(account.id, fullName) });
    }

    if (method === "GET" && path === "/v1/repos") {
      return sendJson(res, 200, { repos: registry.listRepos(account.id) });
    }

    // ── handoffs (session-authed: create + list) ────────────────────────
    //
    // The ping is deliberately content-free — only names (handoffId, repo,
    // branch, nodeId) are accepted and stored. No transcript, no manifest,
    // nothing that would make the cloud a party to the conversation.
    if (method === "POST" && path === "/v1/handoffs") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const handoffId = strOrNull(body?.handoffId);
      const repo = normalizeRepoFullName(body?.repo);
      const branch = strOrNull(body?.branch);
      const nodeId = strOrNull(body?.nodeId);
      if (!handoffId || !/^[a-f0-9]{16,64}$/.test(handoffId) || !repo ||
          !isValidHandoffBranch(branch) || !nodeId) {
        return sendJson(res, 400, { error: "invalid_handoff" });
      }
      if (!registry.getRepo(account.id, repo)) return sendJson(res, 404, { error: "unknown_repo" });
      const node = registry.getNode(nodeId);
      if (!node || node.accountId !== account.id) return sendJson(res, 404, { error: "unknown_node" });

      const existing = registry.getHandoff(handoffId);
      if (existing) {
        if (existing.accountId !== account.id) return sendJson(res, 400, { error: "invalid_handoff" });
        return sendJson(res, 201, { handoff: publicHandoff(existing) });
      }
      const created = registry.createHandoff({ id: handoffId, accountId: account.id, nodeId, repo, branch });
      wakeHandoffWaiters(nodeId);
      return sendJson(res, 201, { handoff: publicHandoff(created) });
    }

    if (method === "GET" && path === "/v1/handoffs") {
      const repo = normalizeRepoFullName(url.searchParams.get("repo"));
      if (!repo) return sendJson(res, 400, { error: "invalid_repo" });
      return sendJson(res, 200, {
        handoffs: registry.listHandoffsForRepo(account.id, repo, 50).map(publicHandoff),
      });
    }

    if (path === "/v1/trial-nodes" && method === "POST") {
      if (!provisioner) return sendJson(res, 404, { error: "trial_unavailable" });
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const pairingId = typeof body?.pairingId === "string" ? body.pairingId : "";
      const pairingSecret = typeof body?.pairingSecret === "string" ? body.pairingSecret : "";
      if (!/^[0-9a-f-]{36}$/.test(pairingId) || !/^[A-Za-z0-9_-]{22,128}$/.test(pairingSecret)) {
        return sendJson(res, 400, { error: "pairing_required" });
      }
      // One trial per account is abuse control over actual provisioned
      // machines: a provision that never produced a machine (state
      // "failed") must not permanently burn the account's only trial, so
      // only that state is retryable — every other state is legitimately
      // spent and still 409s.
      const existingTrial = registry.getTrialByAccount(account.id);
      if (existingTrial && existingTrial.state !== "failed") {
        return sendJson(res, 409, { error: "trial_already_used" });
      }
      if (registry.countActiveTrials() >= config.trial.maxActive) {
        return sendJson(res, 503, { error: "trial_capacity" });
      }
      const enrollToken = randomBytes(32).toString("base64url");
      const expiresAt = now() + config.trial.ttlSec * 1000;
      // trial_nodes.account_id is UNIQUE, so a retry reuses the failed row
      // in place rather than inserting a second one.
      const trial = existingTrial
        ? registry.updateTrial(existingTrial.id, {
            state: "creating",
            nodeId: null,
            sandboxId: null,
            enrollTokenHash: sha256Hex(enrollToken),
            expiresAt,
          })
        : registry.createTrialNode({
            accountId: account.id,
            enrollTokenHash: sha256Hex(enrollToken),
            expiresAt,
          });
      try {
        const created = await provisioner.createSandbox({
          envVars: {
            // main.js refuses to start when E2B_API_URL is set without
            // ENROLL_BASE_URL, so in production this fallback is unreachable.
            // It exists for the in-process test app, where the sandbox is a
            // mock and host:port is the right answer.
            RELAYD_ENROLL_URL: config.enrollBaseUrl || `http://${config.host}:${config.port}`,
            RELAYD_ENROLL_TOKEN: enrollToken,
            RELAYD_ENROLL_PAIRING_ID: pairingId,
            RELAYD_ENROLL_PAIRING_SECRET: pairingSecret,
            RELAYD_TUNNEL_HOST: config.tunnel.host,
            RELAYD_TUNNEL_PORT: String(config.tunnel.port),
            RELAYD_TUNNEL_SUFFIX: config.tunnel.suffix,
          },
          metadata: { trialId: trial.id },
        });
        // A create that yields no usable id is a hard failure, not something to
        // record as nothing: updateTrial's `!== undefined` filter would skip an
        // undefined sandboxId silently, and the reaper only acts on trials that
        // have one — so the machine would run untouched until its platform
        // timeout. `metadata.trialId` is set on the sandbox, so a
        // Cube-list-vs-`trial_nodes` reconciliation sweep is the backstop for
        // the remaining window between create returning and this write.
        const sandboxId = typeof created?.sandboxId === "string" ? created.sandboxId : "";
        if (!sandboxId) throw new Error("provisioner_missing_sandbox_id");
        registry.updateTrial(trial.id, { sandboxId });

        // The envVars above are NOT how the sandbox is configured. Cube
        // restores every sandbox from a snapshot of the template's running
        // machine, so its init process is already up with a frozen
        // environment and never observes them; they are kept only because a
        // directly-booted node (and the in-process test mock) still reads
        // them. The real delivery is this file, written into the running
        // sandbox through envd, which the boot script is waiting for.
        //
        // It is written AFTER sandboxId is recorded, so a crash in between
        // leaves a reapable trial rather than an unreferenced machine.
        await provisioner.writeSandboxFile(
          sandboxId,
          "/var/lib/relayd/enroll.json",
          JSON.stringify({
            cloudUrl: config.enrollBaseUrl || `http://${config.host}:${config.port}`,
            token: enrollToken,
            pairingId,
            pairingSecret,
            tunnelHost: config.tunnel.host,
            tunnelPort: String(config.tunnel.port),
            tunnelSuffix: config.tunnel.suffix,
          }),
        );
      } catch {
        // A failure AFTER the sandbox exists (config delivery is the likely
        // one) would otherwise strand it: the reaper's due-list covers only
        // `creating` and `ready`, so a `failed` row still holding a sandbox id
        // is never revisited and the machine runs to its platform timeout.
        // Destroy it best-effort and clear the id, so the row that remains
        // describes nothing rather than something unreachable.
        const stranded = registry.getTrialById(trial.id)?.sandboxId;
        if (stranded) {
          try {
            await provisioner.killSandbox(stranded);
          } catch {
            // Nothing further to try here; metadata.trialId is set on the
            // sandbox so reconciliation can still find it.
          }
        }
        registry.updateTrial(trial.id, { state: "failed", enrollTokenHash: null, sandboxId: null });
        return sendJson(res, 502, { error: "provision_failed" });
      }
      return sendJson(res, 201, { trial: publicTrial(registry.getTrialById(trial.id), config, registry) });
    }

    if (path === "/v1/trial-nodes/current" && method === "GET") {
      const trial = registry.getTrialByAccount(account.id);
      if (!trial) return sendJson(res, 404, { error: "no_trial" });
      return sendJson(res, 200, { trial: publicTrial(trial, config, registry) });
    }

    if (path === "/v1/trial-nodes/current" && method === "DELETE") {
      const trial = registry.getTrialByAccount(account.id);
      if (!trial) return sendJson(res, 404, { error: "no_trial" });
      await releaseSandbox(trial, "user_deleted_trial");
      if (trial.nodeId) registry.deleteNode(account.id, trial.nodeId);
      registry.updateTrial(trial.id, { state: "destroyed", enrollTokenHash: null });
      return sendJson(res, 204, null);
    }

    return sendJson(res, 404, { error: "not_found" });
  }

  // handoffWaiters is exposed for test observability only (leak/cap/release
  // assertions — see the Task 8 review, I-1/I-2) — not a public API.
  return {
    server, registry, auth, pairing, notify, runSweeps, sweepTrials, db, config, provisioner,
    handoffWaiters,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  if (status === 204 || payload === null) {
    res.writeHead(status === 204 ? 204 : status, baseHeaders());
    return res.end();
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...baseHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendBytes(res, status, buf, extraHeaders = {}) {
  res.writeHead(status, {
    ...baseHeaders(),
    "content-type": "application/octet-stream",
    "content-length": buf.length,
    ...extraHeaders,
  });
  res.end(buf);
}

function baseHeaders() {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  };
}

// Reads at most maxBytes; returns Buffer, or null when the cap is exceeded.
// On overflow the rest of the body is drained and discarded so the client
// still receives a clean 413 instead of a connection reset.
function readRaw(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return; // draining
      total += chunk.length;
      if (total > maxBytes) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(overflow ? null : Buffer.concat(chunks));
    });
    req.on("error", (err) => reject(err));
  });
}

async function readJson(req, maxBytes) {
  const raw = await readRaw(req, maxBytes);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw.toString("utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function bearerMatches(req, expectedToken) {
  if (!expectedToken) return false; // unset token ⇒ endpoint disabled
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return false;
  const got = Buffer.from(header.slice(7));
  const want = Buffer.from(expectedToken);
  return got.length === want.length && timingSafeEqual(got, want);
}

function strOrNull(v) {
  return typeof v === "string" && v.length > 0 ? v : null;
}

const REPO_FULL_NAME_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

function normalizeRepoFullName(value) {
  const trimmed = String(value || "").trim();
  if (!REPO_FULL_NAME_RE.test(trimmed)) return null;
  return trimmed.toLowerCase();
}

// What a git ref may actually hold, restricted to Relay's own namespace.
// Charset alone is not enough — "../../etc/passwd" is built entirely from
// characters in [A-Za-z0-9._-/] — so the extra checks below mirror
// `git check-ref-format`'s structural rules: no ".." component anywhere, no
// "@{", no component starting with "." or ending in ".lock", and the whole
// ref cannot end with ".". branch crosses a trust boundary here: relayd
// feeds it to `git` and to worktree path construction on a node, and the
// cloud is the one choke point where an illegal value can be refused before
// it gets there. A value that fails this check could never be a real git
// branch, so rejecting it costs nothing legitimate.
//
// A NUL byte anywhere fails the charset test outright (it is not in the
// allowed class), which matters because node:sqlite — like most C string
// storage — silently truncates a TEXT value at the first NUL: without this,
// the string that passed validation would not be the string that got
// stored. See Task 8 review, I-4.
const HANDOFF_BRANCH_PREFIX = "relay/handoff-";
const HANDOFF_BRANCH_RE = /^relay\/handoff-[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

function isValidHandoffBranch(branch) {
  if (typeof branch !== "string") return false;
  if (branch.length <= HANDOFF_BRANCH_PREFIX.length || branch.length > 200) return false;
  if (!HANDOFF_BRANCH_RE.test(branch)) return false;
  if (branch.includes("..") || branch.includes("@{")) return false;
  if (branch.endsWith(".")) return false;
  if (branch.split("/").some((segment) => segment.startsWith(".") || segment.endsWith(".lock"))) return false;
  return true;
}

function publicTrial(trial, config, registry) {
  const node = trial.nodeId ? registry.getNode(trial.nodeId) : null;
  return {
    id: trial.id,
    state: trial.state,
    nodeId: trial.nodeId,
    nodeEncPubkey: node?.encPubkey ?? null,
    sni: trial.nodeId && config.tunnel.suffix ? `${trial.nodeId}${config.tunnel.suffix}` : null,
    createdAt: trial.createdAt,
    expiresAt: trial.expiresAt,
  };
}

// Drops accountId — a response must never leak the internal id, only the
// names the whole handoff feature is built to carry.
function publicHandoff(handoff) {
  return {
    id: handoff.id,
    nodeId: handoff.nodeId,
    repo: handoff.repo,
    branch: handoff.branch,
    state: handoff.state,
    reason: handoff.reason,
    createdAt: handoff.createdAt,
    updatedAt: handoff.updatedAt,
    deliveredAt: handoff.deliveredAt,
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// No vowels — no accidental words; no 0/O/1/I — no misreads over a phone or
// a squinted-at terminal.
const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

function mintUserCode() {
  const bytes = randomBytes(8);
  let code = "";
  for (const byte of bytes) code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

// Matching is case-insensitive and ignores the dash: accept whatever the
// user typed, normalize it to the canonical ABCD-EFGH shape stored in the
// registry.
function normalizeUserCode(value) {
  const cleaned = String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return null;
  return `${cleaned.slice(0, 4)}-${cleaned.slice(4)}`;
}
