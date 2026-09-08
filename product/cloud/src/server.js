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
import { timingSafeEqual, randomBytes, createHash, randomUUID } from "node:crypto";
import { signEd25519 } from "./jwt.js";
import { serializeSignedCookie } from "better-call";
import { createDb } from "./db.js";
import { createRegistry } from "./registry.js";
import { createAuth, createAppleJwksFetcher } from "./auth.js";
import { createRelayBetterAuth, isRelayAdmin, readBetterAuthUser, listBetterAuthUsers } from "./better-auth.js";
import { webOriginStore } from "./web-origin.js";
import { createPairing } from "./pairing.js";
import { createNotify, parseNodePubkey } from "./notify.js";
import { createApnsClient, createNoopTransport } from "./apns.js";
import { verifyNodeRequest, createReplayGuard } from "./nodeauth.js";
import {
  appAccountTokenForAccount,
  createAppStoreVerifier,
} from "./app-store.js";

const NODE_KINDS = new Set(["byo", "managed"]);

// Validates the X25519 recipient key a handoff is sealed TO, using the exact
// rule product/relayd/src/seal.mjs's sealTo() enforces: decode, require 32
// bytes, and require the bytes to re-encode back to the identical string.
// Node's base64 decoder is lenient — it accepts base64url characters, ignores
// embedded whitespace, and skips other junk spliced into the string — so a
// length-only check here would let a key through that seal.mjs later refuses
// to use. Rejecting the same malformed key at registration, where the error is
// diagnosable, instead of at handoff time, where it surfaces as an opaque
// seal_bad_public_key on someone's phone, is the entire point.
//
// Returns the canonical string, or null when the value is unusable. `null`
// input (no key offered) is the caller's business, not this function's.
function parseNodeEncPubkey(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const raw = Buffer.from(value, "base64");
  if (raw.length !== 32 || raw.toString("base64") !== value) return null;
  return value;
}
const BROWSER_GRANT_TTL_SEC = 900;
const BROWSER_GRANT_SCOPE = ["jobs.read", "threads.read", "events.read"];
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
  appStoreVerifier = createAppStoreVerifier(config),
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

  let shuttingDown = false;

  function normalizedSubscription(transaction, { accountId, status } = {}) {
    const hostedProductIds = new Set([
      config.appStore.monthlyProductId,
      config.appStore.yearlyProductId,
    ]);
    if (
      !transaction ||
      !hostedProductIds.has(transaction.productId) ||
      typeof transaction.originalTransactionId !== "string" ||
      typeof transaction.transactionId !== "string" ||
      typeof transaction.appAccountToken !== "string" ||
      !Number.isFinite(transaction.expiresDate) ||
      !Number.isFinite(transaction.signedDate)
    ) {
      return null;
    }
    const active =
      status !== "expired" &&
      !transaction.revocationDate &&
      transaction.expiresDate > now();
    return {
      accountId,
      productId: transaction.productId,
      originalTransactionId: transaction.originalTransactionId,
      transactionId: transaction.transactionId,
      appAccountToken: transaction.appAccountToken.toLowerCase(),
      environment: String(transaction.environment || "unknown"),
      status: active ? "active" : "expired",
      expiresAt: Number(transaction.expiresDate),
      signedAt: Number(transaction.signedDate),
    };
  }

  // Records the verified subscription and nothing else. Relay no longer hands
  // out machines, so a purchase has no lifecycle to drive — the StoreKit
  // surface is kept (App Store Connect items stay valid) but is inert.
  function applyVerifiedSubscription(subscription) {
    const saved = registry.upsertAppleSubscription(subscription);
    if (saved.error) return saved;
    return {
      ok: true,
      subscription: registry.getAppleSubscriptionByAccount(subscription.accountId),
    };
  }
  const pairing = createPairing({ registry, config, now });
  const apns = createApnsClient({ config, transport: apnsTransport, now });
  const notify = createNotify({ registry, apns, config, now, log });

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
      if (!session?.token || !session?.id) return null;
      const cookie = await serializeSignedCookie(
        ctx.authCookies.sessionToken.name,
        session.token,
        ctx.secret,
        {
          ...ctx.authCookies.sessionToken.attributes,
          maxAge: ctx.sessionConfig.expiresIn,
        },
      );
      return { cookie, sessionId: session.id };
    } catch {
      return null;
    }
  }

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

  function wakeAccountNodeWaiters(accountId) {
    for (const node of registry.listNodes(accountId)) {
      wakeHandoffWaiters(node.id);
    }
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
          // lifetime as nodes churn (I-1).
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

  function runSweeps() {
    if (shuttingDown) return;
    pairing.sweep();
    notify.sweep();
    registry.sweepDeviceCodes(now());
    registry.sweepSyncNotices(now());
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      // Never leak internals (or any token material) into responses/logs.
      console.error(`unhandled: ${req.method} ${req.url}: ${err?.message}`);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    });
  });
  server.once("close", () => {
    shuttingDown = true;
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

    // The web session cookie is SameSite=None (a cross-origin SPA cannot use
    // anything else), which is precisely the browser CSRF protection the
    // bearer-only API used to get for free. Two guards stand in its place on
    // the routes this file owns. `/api/auth/*` is deliberately excluded: Better
    // Auth enforces its own trustedOrigins there, and Apple's form_post OAuth
    // callback legitimately arrives as x-www-form-urlencoded.
    if (path.startsWith("/v1/") && isStateChanging(method)) {
      const origin = originOf(req);
      // Browsers always send Origin on state-changing requests; native clients
      // (iOS, the CLI, relayd) send none and are untouched.
      if (origin && !originAllowed(origin, config)) {
        return sendJson(res, 403, { error: "forbidden_origin" });
      }
      // Defense in depth for the same attack: these three content types are
      // exactly the ones a cross-origin POST can use without a preflight, so
      // they must never reach a JSON parser.
      if (isBrowserSimpleContentType(req.headers["content-type"])) {
        return sendJson(res, 415, { error: "unsupported_media_type" });
      }
    }

    // ── health ──────────────────────────────────────────────────────────
    if (method === "GET" && path === "/healthz") {
      return sendJson(res, 200, { ok: true });
    }

    // ── auth ────────────────────────────────────────────────────────────
    if (path === "/api/auth" || path.startsWith("/api/auth/")) {
      await auth.ready;
      const origin = originOf(req);
      const store = { origin, capHit: false };
      return webOriginStore.run(store, () => {
        if (!store.origin || !(config.trustedWebOrigins || []).includes(store.origin)) {
          return betterAuth.handler(req, res);
        }
        const origWriteHead = res.writeHead;
        res.writeHead = function patchedCapWriteHead(statusCode, arg2, arg3) {
          if (webOriginStore.getStore()?.capHit) {
            const expire = "better-auth.session_token=; Max-Age=0; Path=/; HttpOnly";
            if (typeof arg2 === "object" && arg2 !== null) {
              return origWriteHead.call(this, 429, {
                ...arg2,
                "content-type": "application/json; charset=utf-8",
                "set-cookie": expire,
              }, arg3);
            }
            if (typeof arg3 === "object" && arg3 !== null) {
              return origWriteHead.call(this, 429, arg2, {
                ...arg3,
                "content-type": "application/json; charset=utf-8",
                "set-cookie": expire,
              });
            }
            return origWriteHead.call(this, 429, {
              "content-type": "application/json; charset=utf-8",
              "set-cookie": expire,
            });
          }
          return origWriteHead.call(this, statusCode, arg2, arg3);
        };
        return betterAuth.handler(req, res);
      });
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
        const reserved = registry.reserveBrowserSession({
          accountId: account.id,
          displayName: record.machineName,
          platform: record.platform,
        });
        if (reserved.status === "cap") {
          return sendJson(res, 429, { error: "too_many_browsers" });
        }
        const minted = await mintBetterAuthSessionCookie(account);
        if (!minted) {
          registry.revokeBrowserSession(account.id, reserved.id);
          return sendJson(res, 400, { error: "web_session_unavailable" });
        }
        registry.attachBrowserAuthSession(reserved.id, minted.sessionId);
        const consumed = registry.consumeDeviceCode(record.id);
        if (!consumed) {
          registry.revokeBrowserSession(account.id, reserved.id);
          return sendJson(res, 400, { error: "invalid_grant" });
        }
        return sendJson(res, 200, { accountId: account.id }, { "set-cookie": minted.cookie });
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

    // App Store Server Notifications V2 is public because Apple cannot hold a
    // Relay session. The signedPayload is the credential: both the outer
    // notification and nested transaction JWS are verified with Apple's root
    // chain before any entitlement state changes.
    if (method === "POST" && path === "/v1/subscriptions/apple/notifications") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      if (typeof body?.signedPayload !== "string") {
        return sendJson(res, 400, { error: "signed_payload_required" });
      }
      let notification;
      try {
        notification = await appStoreVerifier.verifyNotification(body.signedPayload);
      } catch {
        return sendJson(res, 400, { error: "invalid_signed_payload" });
      }
      const signedTransaction = notification?.data?.signedTransactionInfo;
      if (!signedTransaction) return sendJson(res, 200, { ok: true });

      let transaction;
      try {
        transaction = await appStoreVerifier.verifyNotificationTransaction(signedTransaction);
      } catch {
        return sendJson(res, 400, { error: "invalid_signed_transaction" });
      }
      const existing = transaction.originalTransactionId
        ? registry.getAppleSubscriptionByOriginalTransactionId(transaction.originalTransactionId)
        : null;
      // A first notification can race the app's authenticated verification.
      // Acknowledge it without inventing ownership; the app then binds the
      // same original transaction id and future notifications reconcile it.
      if (!existing) return sendJson(res, 200, { ok: true });

      const appleStatus = Number(notification?.data?.status);
      const explicitlyInactive = [2, 3, 5].includes(appleStatus) ||
        ["EXPIRED", "GRACE_PERIOD_EXPIRED", "REFUND", "REVOKE"].includes(
          String(notification?.notificationType || ""),
        );
      const subscription = normalizedSubscription(transaction, {
        accountId: existing.accountId,
        status: explicitlyInactive ? "expired" : "active",
      });
      if (!subscription) return sendJson(res, 200, { ok: true });
      applyVerifiedSubscription(subscription);
      return sendJson(res, 200, { ok: true });
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
        computerAccess: {
          allowed: !registry.isCliComputerAccessRevoked(verified.node.accountId),
          leaseSec: config.computerAccessLeaseSec,
        },
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

    function callerIsAdmin() {
      return isRelayAdmin(readBetterAuthUser(db, account.id), account, config);
    }

    if (path === "/v1/subscriptions/apple/verify" && method === "POST") {
      const body = await readJson(req, config.jsonBodyMaxBytes);
      if (typeof body?.signedTransaction !== "string") {
        return sendJson(res, 400, { error: "signed_transaction_required" });
      }
      let transaction;
      try {
        transaction = await appStoreVerifier.verifyTransaction(body.signedTransaction);
      } catch {
        return sendJson(res, 400, { error: "invalid_signed_transaction" });
      }
      const expectedToken = appAccountTokenForAccount(account.id);
      if (String(transaction?.appAccountToken || "").toLowerCase() !== expectedToken) {
        return sendJson(res, 403, { error: "subscription_account_mismatch" });
      }
      const subscription = normalizedSubscription(transaction, { accountId: account.id });
      if (!subscription) return sendJson(res, 400, { error: "invalid_subscription" });
      if (subscription.status !== "active") {
        return sendJson(res, 402, { error: "subscription_inactive" });
      }
      const result = applyVerifiedSubscription(subscription);
      if (result.error === "subscription_owned_by_another_account") {
        return sendJson(res, 409, { error: result.error });
      }
      if (result.error) return sendJson(res, 503, { error: result.error });
      return sendJson(res, 200, {
        subscription: publicSubscription(result.subscription),
      });
    }

    if (path === "/v1/subscriptions/apple/status" && method === "GET") {
      const subscription = registry.getAppleSubscriptionByAccount(account.id);
      return sendJson(res, 200, {
        subscription: subscription ? publicSubscription(subscription) : null,
      });
    }

    if (path === "/v1/admin/accounts" && method === "GET") {
      if (!callerIsAdmin()) return sendJson(res, 403, { error: "forbidden" });
      const limit = pageLimit(url.searchParams.get("limit"));
      const offset = pageOffset(url.searchParams.get("offset"));
      const accounts = listBetterAuthUsers(db, { limit, offset }).map((user) =>
        publicAdminAccount(db, registry, user.id),
      );
      return sendJson(res, 200, { accounts });
    }

    if (path === "/v1/auth/device/link" && method === "GET") {
      return sendJson(res, 200, {
        computer: publicCliComputer(registry.getCliComputerLink(account.id)),
        foldersAvailable: !registry.isCliComputerAccessRevoked(account.id),
      });
    }

    if (path === "/v1/auth/device/link" && method === "DELETE") {
      const disconnected = registry.disconnectCliComputer(account.id);
      wakeAccountNodeWaiters(account.id);
      return sendJson(res, 200, {
        ok: true,
        disconnected: publicCliComputer(disconnected),
        foldersAvailable: false,
      });
    }

    if (path === "/v1/auth/places" && method === "GET") {
      return sendJson(res, 200, {
        computer: publicCliComputer(registry.getCliComputerLink(account.id)),
        browsers: registry.listBrowserSessions(account.id),
      });
    }

    if (
      method === "DELETE"
      && seg[0] === "v1"
      && seg[1] === "auth"
      && seg[2] === "places"
      && seg[3] === "browsers"
      && seg[4]
      && !seg[5]
    ) {
      const revoked = registry.revokeBrowserSession(account.id, seg[4]);
      if (revoked.status !== "ok") {
        return sendJson(res, 404, { error: "unknown_browser" });
      }
      return sendJson(res, 200, { ok: true });
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
      wakeAccountNodeWaiters(account.id);
      return sendJson(res, 200, {
        ok: true,
        computer: publicCliComputer(approved.link),
        foldersAvailable: true,
      });
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
      // The X25519 key `relay handoff` seals to. Optional — a node registered
      // without one still works for everything that is not handoff — but a
      // PRESENT-and-malformed one is a 400, never a silent null. A silently
      // null enc_pubkey is the failure mode that hid this gap for a whole
      // release: the seal step simply has no recipient, and the break surfaces
      // far from its cause.
      let encPubkey = null;
      if (body.encPubkey !== undefined && body.encPubkey !== null) {
        encPubkey = parseNodeEncPubkey(body.encPubkey);
        if (!encPubkey) return sendJson(res, 400, { error: "invalid_enc_pubkey" });
      }
      // The node's OWN id, minted by relayd when it created its identity.
      //
      // This is not cosmetic. A node signs its cloud requests with
      // `x-relay-node: <its id>`, and nodeauth resolves that header through
      // registry.getNode() — so a node registered under an id the cloud chose
      // instead can never authenticate, and its handoff long-poll fails
      // forever. Trial enrolment used to pass the id through; when that route
      // went, nothing did, and the phone had no way to say which machine it
      // had just paired with.
      //
      // Absent is still allowed and still gets a generated id, for a caller
      // that only wants a placeholder row.
      let id;
      if (body.id !== undefined && body.id !== null) {
        id = String(body.id);
        if (!/^node-[0-9a-f]{16}$/.test(id)) {
          return sendJson(res, 400, { error: "invalid_node_id" });
        }
        // Claiming an id is first-come. Returning 409 for a foreign node and
        // for the account's own duplicate alike keeps this from being an
        // oracle for which machine ids exist.
        if (registry.getNode(id)) {
          return sendJson(res, 409, { error: "node_already_registered" });
        }
      }
      // Entitlement gate: every node this account registered counts against
      // `nodes.max`. Relay hands out no machines of its own any more, so there
      // is nothing to exclude from the count.
      const max = Number.parseInt(
        registry.getEntitlement(account.id, "nodes.max") ?? "0",
        10,
      );
      if (registry.countNodes(account.id) >= max) {
        return sendJson(res, 403, {
          error: "entitlement_limit",
          feature: "nodes.max",
          limit: max,
        });
      }
      const node = registry.createNode(account.id, {
        ...(id ? { id } : {}),
        kind,
        name: strOrNull(body.name),
        pubkey: String(body.pubkey),
        encPubkey,
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

    return sendJson(res, 404, { error: "not_found" });
  }

  // handoffWaiters is exposed for test observability only (leak/cap/release
  // assertions — see the Task 8 review, I-1/I-2) — not a public API.
  return {
    server, registry, auth, pairing, notify, runSweeps, db, config,
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

function isStateChanging(method) {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

// The API's own origin is trusted too, so a browser pointed straight at the
// control plane keeps working when no SPA origin is configured at all.
// Compare Origin to originOnly(betterAuthBaseURL): Origin is scheme+host+port
// and never carries a path, while BETTER_AUTH_URL is Better Auth's baseURL
// and might.
function originAllowed(origin, config) {
  const origins = Array.isArray(config.trustedWebOrigins) ? config.trustedWebOrigins : [];
  return origins.includes(origin) || origin === originOnly(config.betterAuthBaseURL);
}

function originOnly(value) {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}

// The CORS "simple" request content types: a cross-origin POST using one of
// these is sent without a preflight, so the allowlist never sees it.
const BROWSER_SIMPLE_CONTENT_TYPES = new Set([
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
]);

function isBrowserSimpleContentType(value) {
  if (typeof value !== "string") return false;
  const essence = value.split(";")[0].trim().toLowerCase();
  return BROWSER_SIMPLE_CONTENT_TYPES.has(essence);
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

function publicSubscription(subscription) {
  return {
    productId: subscription.productId,
    status: subscription.status,
    expiresAt: subscription.expiresAt,
  };
}

function publicAdminAccount(db, registry, accountId) {
  const user = readBetterAuthUser(db, accountId);
  const account = registry.getAccount(accountId);
  return {
    id: accountId,
    email: user?.email || account?.email || null,
    name: user?.name ?? null,
    role: user?.role || "user",
    banned: Boolean(user?.banned),
    nodes: registry.listNodes(accountId).map((node) => ({
      id: node.id,
      kind: node.kind,
      name: node.name,
      lastSeen: node.lastSeen,
      createdAt: node.createdAt,
    })),
    entitlements: registry.listEntitlements(accountId),
  };
}

function pageLimit(raw, fallback = 50, max = 100) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function pageOffset(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
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
