// Relay Cloud configuration. All values come from the environment; nothing is
// read from disk here. No secrets are ever echoed back in logs or responses.

// Margin between Relay's own destroy point (ttl + grace) and the sandbox-level
// auto-kill we hand the platform. The reaper runs every 60 s, so an hour is
// ample for it to act first; in the normal case Relay destroys the sandbox and
// the platform timer never fires at all.
const SANDBOX_TIMEOUT_MARGIN_SEC = 3600;

export function loadConfig(env = process.env) {
  const trialTtlSec = intFrom(env.TRIAL_TTL_SEC, 7 * 24 * 3600);
  const trialGraceSec = intFrom(env.TRIAL_GRACE_SEC, 3 * 24 * 3600);

  return {
    port: intFrom(env.PORT, 8790),
    host: env.HOST || "127.0.0.1",
    dbPath: env.CLOUD_DB_PATH || "./relay-cloud.sqlite",

    // Session JWT (HS256). SESSION_SECRET is required to start the real
    // server (main.js enforces length); tests inject their own.
    sessionSecret: env.SESSION_SECRET || "",
    sessionTtlSec: intFrom(env.SESSION_TTL_SEC, 15 * 60),
    refreshTtlSec: intFrom(env.REFRESH_TTL_SEC, 30 * 24 * 3600),

    // Better Auth is the account/session authority for native Relay clients.
    // SESSION_SECRET remains the fallback during migration so existing
    // installations do not need two coordinated secret rotations.
    betterAuthSecret: env.BETTER_AUTH_SECRET || env.SESSION_SECRET || "",
    betterAuthBaseURL:
      env.BETTER_AUTH_URL ||
      `http://${env.HOST || "127.0.0.1"}:${intFrom(env.PORT, 8790)}`,

    // Sign in with Apple. Comma-separated audience allowlist (bundle ids /
    // services ids registered with Apple).
    appleIssuer: env.APPLE_ISSUER || "https://appleid.apple.com",
    appleClientIds: (env.APPLE_CLIENT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    appleClientSecret: env.APPLE_CLIENT_SECRET || "",
    appleJwksUrl: env.APPLE_JWKS_URL || "https://appleid.apple.com/auth/keys",

    // Magic link
    magicLinkBaseUrl: env.MAGIC_LINK_BASE_URL || "https://<domain>/auth/confirm",
    magicLinkTtlSec: intFrom(env.MAGIC_LINK_TTL_SEC, 15 * 60),

    // Device-code login (CLI, no browser)
    deviceCodeTtlSec: intFrom(env.DEVICE_CODE_TTL_SEC, 900),
    deviceCodePollIntervalSec: intFrom(env.DEVICE_CODE_POLL_INTERVAL_SEC, 5),
    deviceLoginUrl: env.DEVICE_LOGIN_URL || "https://relay.example/cli-login",
    // Ceiling on simultaneously redeemable device codes. POST
    // /v1/auth/device/start is unauthenticated by construction — the CLI has no
    // session yet — so without a cap anyone can grow the table for free and
    // every poll pays for it. Sized well above real demand: the deployed edge
    // allows ~9,000 starts per IP per code lifetime, so this is the difference
    // between a bounded table and an unbounded one, not a per-user quota.
    deviceCodeMaxLive: intFrom(env.DEVICE_CODE_MAX_LIVE, 2000),

    // Pairing rendezvous
    pairingTtlSec: intFrom(env.PAIRING_TTL_SEC, 15 * 60),
    pairingBlobMaxBytes: intFrom(env.PAIRING_BLOB_MAX_BYTES, 64 * 1024),

    // Notify
    eventRetentionDays: intFrom(env.EVENT_RETENTION_DAYS, 7),
    nodeEventMaxBytes: intFrom(env.NODE_EVENT_MAX_BYTES, 16 * 1024),

    // Control-plane ops auth (distinct from the mTLS data path — these tokens
    // never authorize file reads or job submission on any node).
    adminToken: env.ADMIN_TOKEN || "",
    brokerToken: env.BROKER_TOKEN || "",

    // APNs token auth (provider JWT, ES256). When unset, main.js wires a
    // no-op transport and pushes are recorded as skipped.
    apns: {
      keyId: env.APNS_KEY_ID || "",
      teamId: env.APNS_TEAM_ID || "",
      bundleId: env.APNS_BUNDLE_ID || "",
      signingKeyPem: env.APNS_SIGNING_KEY_P8 || "",
      host: env.APNS_HOST || "api.push.apple.com",
    },

    // Entitlement defaults granted to every new account.
    defaultMaxNodes: intFrom(env.DEFAULT_MAX_NODES, 1),

    // Trial sandboxes (Cube / E2B protocol). An empty apiUrl disables the
    // whole trial feature — routes 404 and the fork screen hides the option.
    e2b: {
      apiUrl: (env.E2B_API_URL || "").replace(/\/+$/, ""),
      apiKey: env.E2B_API_KEY || "",
      templateId: env.TRIAL_TEMPLATE_ID || "",
    },
    trial: {
      ttlSec: trialTtlSec,
      graceSec: trialGraceSec,
      maxActive: intFrom(env.TRIAL_MAX_ACTIVE, 20),

      // Sandbox-level auto-kill handed to the platform at create time, in
      // SECONDS — the unit of the E2B/Cube `timeout` field (verified against
      // the Cube source: CubeAPI forwards the field unconverted and CubeMaster
      // builds `context.WithTimeout(ctx, timeout * time.Second)`).
      //
      // DERIVED from the trial lifecycle on purpose. It used to be an
      // independent 1-hour constant, which is wrong by 168x against a 7-day
      // trial: this value is the backstop that destroys a machine whose row
      // lost track of its sandbox id, so it has to OUTLIVE Relay's own destroy
      // point (ttl + grace) rather than race it. Too short and it kills live
      // trials an hour after signup; too long and it stops being a backstop at
      // all.
      //
      // The `_SEC` suffix is load-bearing — the previous `_MS` name is what
      // let a millisecond value reach a seconds field and ask for ~41 days.
      // Clamped to a positive floor because Cube treats 0/absent as its own
      // 60-second default, which would silently cap every trial at one minute.
      sandboxTimeoutSec: Math.max(
        60,
        intFrom(
          env.TRIAL_SANDBOX_TIMEOUT_SEC,
          trialTtlSec + trialGraceSec + SANDBOX_TIMEOUT_MARGIN_SEC,
        ),
      ),

      // Wall-clock bound on every provisioner HTTP call. Node's fetch has no
      // default timeout, so without this a hung Cube host leaves
      // POST /v1/trial-nodes pending forever and — worse — stalls the reaper
      // mid-pass, silently stopping all later expiry work.
      provisionerTimeoutMs: intFrom(env.TRIAL_PROVISIONER_TIMEOUT_MS, 30_000),
    },
    tunnel: {
      host: env.TUNNEL_HOST || "",
      port: intFrom(env.TUNNEL_PORT, 80),
      suffix: env.TUNNEL_SUFFIX || "",
    },

    // Public cloud URL the trial sandbox reaches to enroll. Empty in tests,
    // where the fallback (host:port) is used instead.
    enrollBaseUrl: env.ENROLL_BASE_URL || "",

    // General request body cap for JSON endpoints.
    jsonBodyMaxBytes: intFrom(env.JSON_BODY_MAX_BYTES, 32 * 1024),

    // Cap on how long GET /v1/node/handoffs holds a long-poll open, in
    // seconds. Kept comfortably inside nginx's 300 s proxy_read_timeout
    // (deploy/relay-cloud.nginx.conf.template) and Node's 60 s default
    // headersTimeout for the next request on the connection. Hard-clamped to
    // 290 s regardless of the env value so a misconfigured operator setting
    // can never make a held request outlive the reverse proxy's own timeout
    // — see Task 8 review, M-1.
    handoffPollMaxWaitSec: Math.min(intFrom(env.HANDOFF_POLL_MAX_WAIT_SEC, 25), 290),
  };
}

function intFrom(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
