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
import { readFileSync } from "node:fs";
import { timingSafeEqual, randomBytes, createHash, randomUUID } from "node:crypto";
import { signEd25519 } from "./jwt.js";
import { serializeSignedCookie } from "better-call";
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
const BROWSER_GRANT_TTL_SEC = 900;
const BROWSER_GRANT_SCOPE = ["jobs.read", "threads.read", "events.read"];

// Reads the wildcard certificate handed to every trial node, or {} when none
// is configured. Read per provision rather than cached at boot so a certbot
// renewal is picked up without restarting the control plane — the files are
// symlinks into letsencrypt's archive and are replaced, not rewritten.
//
// Returns {} on any read failure instead of throwing: a node that self-signs
// still works, where a failed provision leaves the user with nothing.
function nodeTlsMaterial(config) {
  const { certFile, keyFile } = config.nodeTls ?? {};
  if (!certFile || !keyFile) return {};
  try {
    return {
      tlsCert: readFileSync(certFile, "utf8"),
      tlsKey: readFileSync(keyFile, "utf8"),
    };
  } catch (error) {
    // Path and error code only; never the key.
    console.error(`node TLS material unreadable at ${certFile}: ${error.code || "unknown"} — node will self-sign`);
    return {};
  }
}

// Bounds how many polls from ONE node can be parked at once on
// GET /v1/node/handoffs. A client that connects, signs a valid request, and
// immediately disconnects still costs a Set entry, a timer, and a live
// req/res pair until something releases it; uncapped, a flood of such
// clients pins unbounded resources for up to handoffPollMaxWaitSec each. See
// Task 8 review, I-2.
export const HANDOFF_MAX_WAITERS_PER_NODE = 8;

// Bounds a single POST /v1/node/handoffs/ack batch. listPendingHandoffs never
// hands out more than 50 rows in one poll response, so no legitimate ack
// batch can ever need to name more ids than that.
const HANDOFF_ACK_MAX_BATCH = 50;

// Bounds how many undelivered credential-sync notices one node can hold.
// The per-(account, kind) rendezvous quota does not bound this on its own:
// pairing sessions expire and are swept, so a caller could mint five, wait
// out the TTL, and mint five more, forever, while the notices they announced
// pile up against a node that is offline. Rendezvous secrets are not
// something to accumulate without a ceiling.
export const SYNC_NOTICE_MAX_PENDING = 20;

// Rendezvous kinds a credential-sync notice may name. `pair` is deliberately
// absent: device pairing is redeemed on the node's own pairing listener with
// a secret the user carries out of band, and must never become something the
// control plane can hand to a node over this channel.
const SYNC_NOTICE_KINDS = new Set(["sync-auth", "session-index"]);

// Shape of a rendezvous secret, matching what the CLI mints
// (base64url of 24 random bytes) and what pairing.js's AUTH_TOKEN_RE accepts
// for the token derived from it.
const SYNC_NOTICE_SECRET_RE = /^[A-Za-z0-9_-]{22,128}$/;

export function createApp({
  config,
  db = createDb(config.dbPath),
  jwksFetcher = createAppleJwksFetcher(config.appleJwksUrl),
  mailTransport = { send: async () => {} },
  apnsTransport = createNoopTransport(),
  now = () => Date.now(),
  provisioner = createProvisioner(config),
  // Operator warnings from the push pipeline. Injectable so a test can assert
  // that a whole-account APNs refusal actually SAYS so — the fanout summary and
  // the bad-token alert are the only signal an operator gets, and both were
  // silently wrong or absent during the 2026-08-13 token-deletion incident.
  log = (msg) => console.warn(msg),
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
    // Shared with the legacy /v1/auth/apple route, so both paths accept
    // exactly the same tokens and there is one Apple verifier to reason about.
    verifyAppleIdToken: legacyAuth.verifyAppleIdentityToken,
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
  const notify = createNotify({ registry, apns, config, now, log });

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

  // Web device-code redemption: Better Auth 1.6.26 has no auth.api.createSession.
  // Password sign-ups already share the registry id (ensureRelayAccount).
  // Apple-only accounts have a registry row and no `user` row — create one
  // with that same id so the phone QR lands on the existing account, not a
  // second empty one. Cookie name is better-auth.session_token.
  async function mintBetterAuthSessionCookie(account) {
    try {
      const ctx = await auth.betterAuth.$context;
      let user = await ctx.internalAdapter.findUserById(account.id);
      if (!user) {
        const email = typeof account.email === "string" && account.email.includes("@")
          ? account.email
          : null;
        if (!email) return null;
        user = await ctx.internalAdapter.createUser({
          id: account.id,
          email,
          name: email.split("@")[0],
          emailVerified: true,
        });
      }
      if (!user) return null;
      const session = await ctx.internalAdapter.createSession(account.id);
      if (!session?.token) return null;
      return serializeSignedCookie(
        ctx.authCookies.sessionToken.name,
        session.token,
        ctx.secret,
        {
          ...ctx.authCookies.sessionToken.attributes,
          maxAge: ctx.sessionConfig.expiresIn,
        },
      );
    } catch {
      return null;
    }
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

  // Per-account sliding window for POST /v1/auth/device/inspect. Mirrors the
  // spirit of the per-IP live-code ceiling on /device/start, but inspect is
  // session-authed so the bucket key is accountId (an unauthenticated caller
  // never reaches this counter). 30/min is enough for a human tapping retry
  // and far below what an enumeration sweep would need.
  const DEVICE_INSPECT_RATE_LIMIT = 30;
  const DEVICE_INSPECT_RATE_WINDOW_MS = 60_000;
  const deviceInspectHits = new Map(); // accountId -> number[] of timestamps

  function allowDeviceInspect(accountId, nowMs) {
    let hits = deviceInspectHits.get(accountId) || [];
    hits = hits.filter((ts) => nowMs - ts < DEVICE_INSPECT_RATE_WINDOW_MS);
    if (hits.length >= DEVICE_INSPECT_RATE_LIMIT) {
      deviceInspectHits.set(accountId, hits);
      return false;
    }
    hits.push(nowMs);
    deviceInspectHits.set(accountId, hits);
    return true;
  }

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
    registry.sweepSyncNotices(now());
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

    // Cross-origin SPA (`RELAY_WEB_ORIGINS`) sends credentials: include.
    // OPTIONS must be answered before the session-auth boundary or preflight
    // is 401 and the browser never issues the real request.
    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...baseHeaders(),
        ...corsHeaders(originOf(req), config.trustedWebOrigins),
        "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, accept",
        "access-control-max-age": "600",
      });
      return res.end();
    }
    attachCors(req, res, config.trustedWebOrigins);

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
      // Reclaim first, then check the ceilings: expired and redeemed rows are
      // not live capacity, and reclaiming here (rather than only on the 60 s
      // sweep tick) is what stops a burst that has already aged out from
      // pinning the gate shut. The DELETE rides idx_device_codes_expires.
      registry.sweepDeviceCodes(now());
      if (registry.countLiveDeviceCodes(now()) >= config.deviceCodeMaxLive) {
        return sendJson(res, 429, { error: "slow_down" });
      }
      // Per-IP ceiling, checked in addition to (not instead of) the global
      // one above: the global cap alone bounds the table but not who fills
      // it, and one caller holding DEVICE_CODE_MAX_LIVE codes used to deny
      // every other caller a code for the rest of the TTL window. `clientIp`
      // is null when no trusted signal is available (see clientIpOf), which
      // counts against nothing rather than failing closed for every
      // signal-less caller — the global ceiling remains the backstop.
      const clientIp = clientIpOf(req);
      if (clientIp && registry.countLiveDeviceCodesForIp(clientIp, now()) >= config.deviceCodeMaxLivePerIp) {
        return sendJson(res, 429, { error: "slow_down" });
      }
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const machineName = sanitizeMachineName(body?.machineName);
      const platform = normalizeDevicePlatform(body?.platform);
      const deviceCode = randomBytes(32).toString("base64url");
      // A user_code collision is a UNIQUE constraint violation that would
      // otherwise reach the top-level handler as 500 {"error":"internal"}.
      // Vanishingly unlikely, but retrying removes the class.
      let record;
      for (let attempt = 1; ; attempt++) {
        try {
          record = registry.createDeviceCode({
            deviceCodeHash: sha256Hex(deviceCode),
            userCode: mintUserCode(),
            expiresAt: now() + config.deviceCodeTtlSec * 1000,
            clientIp,
            machineName,
            platform,
            client: body?.client === "web" ? "web" : "cli",
          });
          break;
        } catch (err) {
          if (attempt >= 5) throw err;
        }
      }
      // verificationUriComplete puts the user code in the URL hash fragment
      // so a future real page (or system-camera / universal-link scan) never
      // ships the code to server access logs. The redeeming secret
      // (deviceCode) is NEVER included here — only the approval handle.
      return sendJson(res, 201, {
        deviceCode,
        userCode: record.userCode,
        verificationUri: config.deviceLoginUrl,
        verificationUriComplete: `${config.deviceLoginUrl}#code=${record.userCode}`,
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
      if (record.client === "web") {
        const account = registry.getAccount(record.accountId);
        if (!account) return sendJson(res, 400, { error: "invalid_grant" });
        const cookie = await mintBetterAuthSessionCookie(account);
        if (!cookie) return sendJson(res, 400, { error: "web_session_unavailable" });
        const consumed = registry.consumeDeviceCode(record.id);
        if (!consumed) return sendJson(res, 400, { error: "invalid_grant" });
        return sendJson(res, 200, { accountId: account.id }, { "set-cookie": cookie });
      }
      const connected = registry.connectCliComputer(record.id);
      if (!connected) return sendJson(res, 400, { error: "invalid_grant" });
      const account = registry.getAccount(connected.record.accountId);
      if (!account) return sendJson(res, 400, { error: "invalid_grant" });
      return sendJson(res, 200, auth.issueSession(account, { cliLinkId: connected.link.id }));
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
      // Parked only when there is nothing of EITHER kind to hand over: a
      // notice waiting behind an empty handoff list must not sit out the full
      // wait window before the node hears about it.
      if (
        waitSec > 0 &&
        registry.countPendingHandoffs(nodeId) === 0 &&
        registry.countPendingSyncNotices(nodeId) === 0
      ) {
        await waitForHandoff(nodeId, waitSec * 1000, req);
      }
      // A cheap fast path for a connection ALREADY OBSERVED closed — skip the
      // DB round trip rather than lease work nobody can ever confirm. This is
      // no longer what makes a vanished client safe, though: a partitioned
      // peer (no FIN observed, socket looks alive for the whole poll) sails
      // straight past this check exactly as it always did. What makes THAT
      // case safe is that the response below is a LEASE, not a delivery —
      // see leaseHandoffs/confirmHandoffDelivery/reclaimExpiredLeases in
      // registry.js. An unconfirmed lease expires and the row becomes
      // claimable again, which is what makes "the node catches up on
      // reconnect" — the design's own failure-mode promise — actually true
      // under a silent partition, not only under an observed disconnect.
      // See Task 8 review, Finding 1 / IMPORTANT 1.
      if (req.destroyed) return;

      const pending = registry.listPendingHandoffs(nodeId);
      const leased = registry.leaseHandoffs(pending.map((h) => h.id), nodeId, config.handoffLeaseSec * 1000);
      // Credential-sync notices ride the same response, the same lease and
      // the same ack rather than a second long-poll: one held connection per
      // node, one disconnect/waiter-leak/replay/lease mechanism to reason
      // about. This is the one place the rendezvous secret is handed onward,
      // and it is node-authenticated (ed25519 request signature) — never
      // reachable with a session bearer.
      const pendingNotices = registry.listPendingSyncNotices(nodeId);
      const leasedNotices = registry.leaseSyncNotices(
        pendingNotices.map((notice) => notice.id), nodeId, config.handoffLeaseSec * 1000,
      );
      registry.touchNode(nodeId);
      return sendJson(res, 200, {
        handoffs: leased.map(({ id, repo, branch, leaseToken }) => ({ id, repo, branch, lease: leaseToken })),
        notices: leasedNotices.map(({ id, pairingId, secret, leaseToken }) => ({
          id, pairingId, secret, lease: leaseToken,
        })),
      });
    }

    // ── node handoff delivery ack (signature-authed) ─────────────────────
    //
    // Confirms that a leased handoff's poll response actually reached the
    // node — the only path to `delivered`. relayd calls this immediately
    // after successfully parsing a poll response, before handing the
    // descriptors to the import loop: `res.json()` resolving is itself
    // evidence the bytes crossed a live connection, which is exactly what a
    // partitioned socket cannot produce. An ack that is never sent — crash,
    // partition, anything — just lets the lease expire; the row becomes
    // claimable again and is redelivered on a later poll. See Task 8 review,
    // Finding 1 / IMPORTANT 1, and the relayd contract note in
    // task-8-report.md.
    if (method === "POST" && path === "/v1/node/handoffs/ack") {
      const pathWithQuery = `${path}${url.search}`;
      const verified = verifyNodeRequest(req, pathWithQuery, { registry, now, replayGuard: handoffReplayGuard });
      if (verified.error) return sendJson(res, 401, { error: "unauthorized" });

      const body = await readJson(req, config.jsonBodyMaxBytes);
      const acksRaw = Array.isArray(body?.acks) ? body.acks : [];
      const noticeAcksRaw = Array.isArray(body?.notices) ? body.notices : [];
      // Both lists are bounded by the poll's own per-response caps: no
      // legitimate batch can name more ids than a single poll handed out. An
      // ack naming NOTHING at all stays a 400 — it can only be a bug or a
      // probe, never a real confirmation.
      if (acksRaw.length + noticeAcksRaw.length === 0) {
        return sendJson(res, 400, { error: "invalid_ack" });
      }
      if (acksRaw.length > HANDOFF_ACK_MAX_BATCH || noticeAcksRaw.length > HANDOFF_ACK_MAX_BATCH) {
        return sendJson(res, 400, { error: "invalid_ack" });
      }
      const acks = [];
      for (const entry of acksRaw) {
        const id = strOrNull(entry?.id);
        const lease = strOrNull(entry?.lease);
        if (!id || !HANDOFF_ID_RE.test(id) || !lease) {
          return sendJson(res, 400, { error: "invalid_ack" });
        }
        acks.push({ id, lease });
      }
      // Notice ids are randomUUID()s, not the hex handoff ids, so they get
      // their own shape check rather than being forced through the handoff
      // one.
      const noticeAcks = [];
      for (const entry of noticeAcksRaw) {
        const id = strOrNull(entry?.id);
        const lease = strOrNull(entry?.lease);
        if (!id || id.length > 64 || !lease) {
          return sendJson(res, 400, { error: "invalid_ack" });
        }
        noticeAcks.push({ id, lease });
      }
      const confirmed = registry.confirmHandoffDelivery(verified.node.id, acks);
      const noticesAcked = registry.confirmSyncNoticeDelivery(verified.node.id, noticeAcks);
      return sendJson(res, 200, { acked: confirmed, noticesAcked });
    }

    // ── node handoff failure report (signature-authed) ──────────────────
    //
    // The node's own terminal-failure signal. Before this route existed the
    // handoffs table had exactly three states (pending/leased/delivered),
    // `reason` was always NULL, and `relay status`'s failure branch — and
    // design §10's whole "every failure ends visible" promise — had no
    // implementation path: relayd genuinely emits `handoff.failed` with a
    // reason, but nothing carried it to this row. This is that path.
    //
    // Node-authed and replay-guarded exactly like the poll and the ack
    // above — reporting a failure is a state-mutating write, not a read, so
    // it gets no exemption from the T7-I3 default. `reason` is checked
    // against HANDOFF_FAILURE_REASONS (a closed vocabulary) rather than
    // stored verbatim: the cloud is content-free by design, and a free-text
    // reason from the node is exactly the shape of leak `record.error`
    // escaping relayd's own PUBLIC_REASONS allow-list already showed is
    // possible — this route refuses anything outside the five known codes
    // instead of trusting the caller to have sanitised it.
    if (
      method === "POST" && seg.length === 5 &&
      seg[0] === "v1" && seg[1] === "node" && seg[2] === "handoffs" && seg[4] === "fail"
    ) {
      const id = seg[3];
      const pathWithQuery = `${path}${url.search}`;
      const verified = verifyNodeRequest(req, pathWithQuery, { registry, now, replayGuard: handoffReplayGuard });
      if (verified.error) return sendJson(res, 401, { error: "unauthorized" });
      if (!HANDOFF_ID_RE.test(id)) return sendJson(res, 400, { error: "invalid_handoff" });

      const body = await readJson(req, config.jsonBodyMaxBytes);
      const reason = strOrNull(body?.reason);
      if (!reason || !HANDOFF_FAILURE_REASONS.has(reason)) {
        return sendJson(res, 400, { error: "invalid_reason" });
      }

      // Same 404 whether the id is unknown or simply belongs to another
      // node — a node has no business learning which is true of an id it
      // does not own.
      const handoff = registry.getHandoff(id);
      if (!handoff || handoff.nodeId !== verified.node.id) {
        return sendJson(res, 404, { error: "unknown_handoff" });
      }
      registry.failHandoff(verified.node.id, id, reason);
      return sendJson(res, 200, { handoff: publicHandoff(registry.getHandoff(id)) });
    }

    // The success twin of the fail route above. Same auth, same replay guard,
    // same 404-either-way rule; no body, because success has nothing to
    // report but itself — which is also why there is no vocabulary to police
    // here. Without it `delivered` was the end of the line for a successful
    // handoff, and it means only "the node took it", so `relay status` could
    // not distinguish a finished import from a hung one.
    if (
      method === "POST" && seg.length === 5 &&
      seg[0] === "v1" && seg[1] === "node" && seg[2] === "handoffs" && seg[4] === "ready"
    ) {
      const id = seg[3];
      const pathWithQuery = `${path}${url.search}`;
      const verified = verifyNodeRequest(req, pathWithQuery, { registry, now, replayGuard: handoffReplayGuard });
      if (verified.error) return sendJson(res, 401, { error: "unauthorized" });
      if (!HANDOFF_ID_RE.test(id)) return sendJson(res, 400, { error: "invalid_handoff" });

      const handoff = registry.getHandoff(id);
      if (!handoff || handoff.nodeId !== verified.node.id) {
        return sendJson(res, 404, { error: "unknown_handoff" });
      }
      registry.readyHandoff(verified.node.id, id);
      return sendJson(res, 200, { handoff: publicHandoff(registry.getHandoff(id)) });
    }

    // ── session-authed registry endpoints ───────────────────────────────
    const account = await auth.authenticate(req);
    if (!account) return sendJson(res, 401, { error: "unauthorized" });

    if (path === "/v1/auth/device/link" && method === "GET") {
      return sendJson(res, 200, {
        computer: publicCliComputer(registry.getCliComputerLink(account.id)),
      });
    }

    if (path === "/v1/auth/device/link" && method === "DELETE") {
      const disconnected = registry.disconnectCliComputer(account.id);
      return sendJson(res, 200, {
        ok: true,
        disconnected: publicCliComputer(disconnected),
      });
    }

    if (method === "POST" && path === "/v1/auth/device/inspect") {
      // Read-only twin of /device/approve: returns the CLI-reported machine
      // name so the phone can show a confirm sheet before approving. Same
      // anti-enumeration posture as approve — unknown, expired, and already-
      // approved all return the identical 404. Always performs the user-code
      // lookup (no short-circuit that would skip the hash/index read on a
      // malformed code) so timing does not separate failure classes.
      // Occupied-slot 409 is after classification: web codes must succeed
      // while a CLI computer is already linked.
      if (!allowDeviceInspect(account.id, now())) {
        return sendJson(res, 429, { error: "rate_limited" });
      }
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const userCode = normalizeUserCode(body?.userCode);
      const record = registry.getDeviceCodeByUserCode(userCode);
      if (
        !record
        || record.consumedAt !== null
        || record.expiresAt <= now()
        || record.accountId !== null
      ) {
        return sendJson(res, 404, { error: "unknown_user_code" });
      }
      if (record.client !== "web" && registry.getCliComputerLink(account.id)) {
        return sendJson(res, 409, { error: "computer_already_linked" });
      }
      return sendJson(res, 200, {
        machineName: record.machineName,
        platform: record.platform,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        client: record.client,
      });
    }

    if (method === "POST" && path === "/v1/auth/device/approve") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const userCode = normalizeUserCode(body?.userCode);
      const record = userCode ? registry.getDeviceCodeByUserCode(userCode) : null;
      if (!record || record.consumedAt !== null || record.expiresAt <= now()) {
        return sendJson(res, 404, { error: "unknown_user_code" });
      }
      if (record.client === "web") {
        const approved = registry.approveDeviceCodeForWebSession(record.id, account.id);
        if (approved.status !== "approved") {
          return sendJson(res, 404, { error: "unknown_user_code" });
        }
        return sendJson(res, 200, { ok: true });
      }
      if (registry.getCliComputerLink(account.id)) {
        return sendJson(res, 409, { error: "computer_already_linked" });
      }
      // The registry reserves the account's unique computer row and approves
      // the code in one transaction. A stale UI or two simultaneous approval
      // requests therefore cannot create a second linked computer.
      const approved = registry.approveDeviceCodeForCliLink(record.id, account.id);
      if (approved.status === "link_exists") {
        return sendJson(res, 409, { error: "computer_already_linked" });
      }
      if (approved.status !== "approved") {
        return sendJson(res, 404, { error: "unknown_user_code" });
      }
      return sendJson(res, 200, { ok: true, computer: publicCliComputer(approved.link) });
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
        // Which APNs environment this build's token belongs to. Anything
        // outside the two Apple values is stored as NULL rather than rejected:
        // an app that cannot determine its own environment must still be able
        // to register, and NULL falls back to the configured host.
        apnsEnvironment: cleanApnsEnvironment(body.apnsEnvironment),
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
        if ("apnsEnvironment" in body) patch.apnsEnvironment = cleanApnsEnvironment(body.apnsEnvironment);
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

    if (
      method === "POST" &&
      seg.length === 4 &&
      seg[0] === "v1" &&
      seg[1] === "nodes" &&
      seg[3] === "browser-grants"
    ) {
      // Same 404 whether the id is unknown or belongs to another account —
      // a browser session has no business learning which is true.
      const node = registry.getNode(seg[2]);
      if (!node || node.accountId !== account.id) {
        return sendJson(res, 404, { error: "not_found" });
      }
      if (!config.browserGrantPrivateKey || !config.grantGatewayUrl) {
        return sendJson(res, 503, { error: "grants_unavailable" });
      }
      const iat = Math.floor(now() / 1000);
      const grant = signEd25519(
        {
          sub: account.id,
          node: node.id,
          scope: BROWSER_GRANT_SCOPE,
          iat,
          exp: iat + BROWSER_GRANT_TTL_SEC,
          jti: randomUUID(),
        },
        config.browserGrantPrivateKey,
      );
      return sendJson(res, 201, {
        grant,
        expiresIn: BROWSER_GRANT_TTL_SEC,
        gatewayUrl: config.grantGatewayUrl,
      });
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
      if (!handoffId || !HANDOFF_ID_RE.test(handoffId) || !repo ||
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

    // ── credential-sync notices (session-authed: create only) ───────────
    //
    // `relay sync-auth` seals the user's own credentials to the node's X25519
    // key and PUTs them into a rendezvous slot. Nothing lets the node discover
    // that slot on its own, so the CLI announces it here and the node picks it
    // up over the node-authenticated long-poll above.
    //
    // The body names a rendezvous the caller already created, so the secret
    // here is one the caller minted and the cloud is merely relaying. What
    // the cloud can do with it is bounded: authorize the slot, and therefore
    // drop or refuse to relay the blob. What it cannot do is read a
    // credential — the payload in that slot is sealed to the node's key. See
    // the sync_notices comment in db.js.
    if (method === "POST" && path === "/v1/sync-auth/notices") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      const pairingId = strOrNull(body?.pairingId);
      const nodeId = strOrNull(body?.nodeId);
      const secret = strOrNull(body?.secret);
      if (!pairingId || !nodeId || !secret || !SYNC_NOTICE_SECRET_RE.test(secret)) {
        return sendJson(res, 400, { error: "invalid_notice" });
      }
      const node = registry.getNode(nodeId);
      if (!node || node.accountId !== account.id) return sendJson(res, 404, { error: "unknown_node" });
      // The rendezvous must be this account's, and of a kind that is actually
      // collected this way. One 404 for every refusal: nothing here tells a
      // caller whether a pairing id belongs to someone else or never existed.
      const session = registry.getPairingSession(pairingId);
      if (!session || session.accountId !== account.id || !SYNC_NOTICE_KINDS.has(session.kind)) {
        return sendJson(res, 404, { error: "unknown_pairing_session" });
      }
      // Idempotent on the rendezvous, exactly like POST /v1/handoffs is on
      // handoffId: re-announcing one slot must not queue a second collection.
      const existing = registry.getSyncNoticeByPairingId(pairingId);
      if (existing) {
        if (existing.accountId !== account.id) return sendJson(res, 404, { error: "unknown_pairing_session" });
        return sendJson(res, 201, { notice: publicSyncNotice(existing) });
      }
      if (registry.countPendingSyncNotices(nodeId) >= SYNC_NOTICE_MAX_PENDING) {
        return sendJson(res, 429, { error: "too_many_sync_notices" });
      }
      const created = registry.createSyncNotice({
        accountId: account.id, nodeId, pairingId, secret, expiresAt: session.expiresAt,
      });
      wakeHandoffWaiters(nodeId);
      return sendJson(res, 201, { notice: publicSyncNotice(created) });
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
            // A certificate the phone's system trust store already accepts,
            // for this node's name under the wildcard. Without it the node
            // signs its own, the app has to override server trust, and iOS
            // then refuses to perform client-certificate authentication at
            // all — so mTLS cannot complete. Absent (no wildcard configured),
            // the node falls back to self-signing and nothing else changes.
            ...nodeTlsMaterial(config),
            // Public half of the browser-grant key. Omitted when unset so
            // existing phones and nodes that do not speak grants keep working.
            ...(config.browserGrantPublicKey
              ? { grantPublicKey: config.browserGrantPublicKey }
              : {}),
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

function sendJson(res, status, payload, extraHeaders = {}) {
  if (status === 204 || payload === null) {
    res.writeHead(status === 204 ? 204 : status, { ...baseHeaders(), ...extraHeaders });
    return res.end();
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...baseHeaders(),
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...extraHeaders,
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

function originOf(req) {
  const value = req.headers.origin;
  return typeof value === "string" ? value : "";
}

// Exact-origin allowlist from config.trustedWebOrigins (RELAY_WEB_ORIGINS).
// Never "*": credentialed fetches require a specific origin plus
// Access-Control-Allow-Credentials.
function corsHeaders(origin, origins) {
  if (!origin || !Array.isArray(origins) || !origins.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
  };
}

function mergeCorsInto(headers, extra) {
  if (!extra || Object.keys(extra).length === 0) return headers;
  if (Array.isArray(headers)) {
    const out = headers ? [...headers] : [];
    for (const [key, value] of Object.entries(extra)) out.push([key, value]);
    return out;
  }
  const current = headers && typeof headers === "object" ? headers : {};
  const existingVary = current.vary || current.Vary;
  const vary = extra.vary && existingVary && !String(existingVary).includes("Origin")
    ? `${existingVary}, ${extra.vary}`
    : extra.vary || existingVary;
  return { ...current, ...extra, ...(vary ? { vary } : {}) };
}

function attachCors(req, res, origins) {
  const extra = corsHeaders(originOf(req), origins);
  if (Object.keys(extra).length === 0) return;
  const orig = res.writeHead;
  res.writeHead = function patchedWriteHead(statusCode, arg2, arg3) {
    if (typeof arg2 === "object" && arg2 !== null) {
      return orig.call(this, statusCode, mergeCorsInto(arg2, extra));
    }
    if (typeof arg3 === "object" && arg3 !== null) {
      return orig.call(this, statusCode, arg2, mergeCorsInto(arg3, extra));
    }
    if (typeof arg2 === "string") {
      return orig.call(this, statusCode, arg2, extra);
    }
    return orig.call(this, statusCode, extra);
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

// The trusted client IP for rate-limiting decisions. nginx's
// `proxy_set_header X-Real-IP $remote_addr` (deploy/relay-cloud.nginx.conf.template)
// REPLACES whatever this header held on the inbound connection with the
// proxy's own view of $remote_addr — a caller cannot forge it on its way
// through nginx — and the app binds 127.0.0.1 (config.host), so nginx is the
// only process that can ever reach this server. Deliberately does NOT fall
// back to the raw socket address: a direct-to-app caller with no header
// (tests, local dev without nginx in front, or a misconfigured proxy) has no
// trustworthy per-IP signal at all — the raw socket peer is nginx itself,
// not the real client — so this returns null and callers must treat that as
// "no signal", not as a shared substitute identity.
function clientIpOf(req) {
  const header = req.headers["x-real-ip"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

// Shape a handoff id must have everywhere it crosses this server: minted by
// the CLI as 16 hex characters, accepted here up to 64 so a future longer id
// is not a breaking change. One constant, three call sites (create, ack,
// fail-report) — previously two copies of the same literal.
// Apple names exactly two APNs environments. A device reports its own so each
// push goes to the host that token is valid for; anything else becomes NULL,
// which means "unknown" and falls back to the configured APNS_HOST.
const APNS_ENVIRONMENTS = new Set(["development", "production"]);

function cleanApnsEnvironment(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().toLowerCase();
  return APNS_ENVIRONMENTS.has(cleaned) ? cleaned : null;
}

const HANDOFF_ID_RE = /^[a-f0-9]{16,64}$/;

// The CLOSED vocabulary `reason` may hold once a handoff reaches `failed`.
// The cloud is content-free by design — it may learn NAMES (repo, branch,
// ids, event types) but never transcript or credential content — and a
// node-supplied reason is the one place a free-text string could otherwise
// ride into an account's own JSON forever. So this is an allow-list, not a
// sanitiser: a reason relayd sends that is not one of these five strings is
// refused at the door (400 invalid_reason) rather than stored, coerced, or
// clipped. See the relayd-contract note this list is paired with — relayd's
// own PUBLIC_REASONS (handoff.mjs) has ~25 fine-grained codes; relayd must
// fold each of them into exactly one of these five before reporting, the
// same coarsening its own `clone_failed` already does deliberately (a failed
// clone never says WHY, because "not found" vs "no access" is a private-repo
// existence oracle against the user's credential).
//
//   clone_failed      — repo could not be fetched: missing/expired GitHub
//                        credential, or no access. Matches the CLI's
//                        existing `/auth|credential|clone_failed/i` check in
//                        status.mjs, so this reason alone already triggers
//                        the "run relay sync-auth" hint with no CLI change.
//   decrypt_failed     — the sealed manifest/session could not be opened
//                        (missing key, bad magic, truncated, decrypt error).
//   manifest_invalid   — the manifest itself was missing, oversized,
//                        malformed, or named a blob outside the checkout.
//   workspace_failed   — checkout/workspace registration/local-store error
//                        on the node, unrelated to the content above.
//   internal_error      — catch-all: anything relayd cannot place in the
//                        four buckets above still needs a terminal state.
const HANDOFF_FAILURE_REASONS = new Set([
  "clone_failed",
  "decrypt_failed",
  "manifest_invalid",
  "workspace_failed",
  "internal_error",
]);

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

function publicCliComputer(link) {
  if (!link) return null;
  return {
    id: link.id,
    machineName: link.machineName,
    platform: link.platform,
    status: link.connectedAt === null ? "connecting" : "connected",
    connectedAt: link.connectedAt,
    createdAt: link.createdAt,
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

// Drops the rendezvous secret and the lease token. A session-authed caller
// already knows the secret (it minted it) but has no business being handed it
// back by the cloud, and the lease belongs to the node's poll alone — the
// same reasoning publicHandoff applies to accountId and lease_token.
function publicSyncNotice(notice) {
  return {
    id: notice.id,
    nodeId: notice.nodeId,
    pairingId: notice.pairingId,
    state: notice.state,
    createdAt: notice.createdAt,
    expiresAt: notice.expiresAt,
  };
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

// No vowels, so no code ever spells a word. The 0/O and 1/I pairs are gone,
// which removes the two worst misreads — but S/5, Z/2, B/8 and G/6 remain and
// are still confusable in most terminal fonts, so this alphabet reduces
// retypes rather than eliminating them. A misread costs a 404 and a retype,
// never a wrong approval.
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ23456789";

// Rejection sampling, not `% 28`: 256 % 28 = 4, so a plain modulo would hand
// the first four characters a 10/256 chance against 9/256 for the rest. The
// entropy cost of the bias is 0.0065 bits over the whole 8-character code, so
// this is hygiene rather than a fix — but an auth code should be exactly
// uniform, and the loop is three lines.
const USER_CODE_MAX_UNBIASED = 256 - (256 % USER_CODE_ALPHABET.length);

// `randomBytesImpl` is injectable (defaulting to the real `randomBytes`)
// purely so a test can script a deterministic byte sequence and prove the
// rejection-sampling guard actually filters out-of-range bytes rather than
// folding them in via a plain modulo — a statistical test of the real,
// unmocked entropy source would be either flaky or too weak to catch a
// 1.14x bias against a 28^8 space, exactly the kind of test this project
// keeps finding and fixing. Every real call site relies solely on the
// default.
export function mintUserCode(randomBytesImpl = randomBytes) {
  let code = "";
  while (code.length < 8) {
    for (const byte of randomBytesImpl(8)) {
      if (byte >= USER_CODE_MAX_UNBIASED) continue;
      code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
      if (code.length === 8) break;
    }
  }
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

// CLI-reported hostname shown on the phone confirm sheet. Strip control
// characters (and anything else outside printable-ish Unicode whitespace +
// text), trim, and cap length so a hostile start cannot pad the confirm UI.
function sanitizeMachineName(value) {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim().slice(0, 64);
  return cleaned.length > 0 ? cleaned : null;
}

// Closed set matching what the CLI sends after mapping process.platform.
// Omitted / empty stays null (shown as unknown on the phone); anything else
// unrecognized — including raw "darwin" — collapses to "other". The CLI is
// responsible for the darwin→macos mapping before the request leaves the box.
function normalizeDevicePlatform(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "macos" || raw === "linux" || raw === "windows" || raw === "other" || raw === "web") return raw;
  return "other";
}
