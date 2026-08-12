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

const NODE_KINDS = new Set(["byo", "managed"]);

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
      });
      if (outcome === "invalid_auth_token") {
        return sendJson(res, 400, { error: "auth_token_required" });
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
      const encPubkey = strOrNull(body?.encPubkey);
      if (encPubkey !== null && Buffer.from(encPubkey, "base64").length !== 32) {
        return sendJson(res, 400, { error: "invalid_enc_pubkey" });
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
      } catch {
        registry.updateTrial(trial.id, { state: "failed", enrollTokenHash: null });
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

  return { server, registry, auth, pairing, notify, runSweeps, sweepTrials, db, config, provisioner };
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
