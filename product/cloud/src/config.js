// Relay Cloud configuration. All values come from the environment; nothing is
// read from disk here. No secrets are ever echoed back in logs or responses.

export function loadConfig(env = process.env) {
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
      ttlSec: intFrom(env.TRIAL_TTL_SEC, 7 * 24 * 3600),
      graceSec: intFrom(env.TRIAL_GRACE_SEC, 3 * 24 * 3600),
      maxActive: intFrom(env.TRIAL_MAX_ACTIVE, 20),
      sandboxTimeoutMs: intFrom(env.TRIAL_SANDBOX_TIMEOUT_MS, 3600 * 1000),
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
  };
}

function intFrom(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
