// Relay Cloud configuration. All values come from the environment; nothing is
// read from disk here. No secrets are ever echoed back in logs or responses.

import { normalizeEmail } from "./registry.js";

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
    // Trailing slashes are stripped: both of these are compared against an
    // Origin header, which never carries one, and both feed the CORS echo and
    // the CSRF origin allowlist. A stray slash in the env would otherwise
    // reject every write from the very origin it was meant to permit.
    // CSRF also compares Origin to originOnly(betterAuthBaseURL) so a path on
    // BETTER_AUTH_URL (https://api.x.com/auth) cannot make the API origin
    // forbidden. Do not set BETTER_AUTH_URL to a path-bearing URL anyway:
    // Better Auth uses it as baseURL, not merely as an origin.
    betterAuthBaseURL: stripTrailingSlash(
      env.BETTER_AUTH_URL ||
        `http://${env.HOST || "127.0.0.1"}:${intFrom(env.PORT, 8790)}`,
    ),
    trustedWebOrigins: (env.RELAY_WEB_ORIGINS || "")
      .split(",")
      .map((s) => stripTrailingSlash(s.trim()))
      .filter(Boolean),

    // Sign in with Apple. Comma-separated audience allowlist (bundle ids /
    // services ids registered with Apple).
    appleIssuer: env.APPLE_ISSUER || "https://appleid.apple.com",
    appleClientIds: (env.APPLE_CLIENT_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    appleClientSecret: env.APPLE_CLIENT_SECRET || "",
    appleJwksUrl: env.APPLE_JWKS_URL || "https://appleid.apple.com/auth/keys",

    // Relay Hosted uses monthly and yearly durations in one auto-renewable
    // subscription group. The product ids and numeric App Store app id are
    // public identifiers; keeping them configurable still makes local/test
    // deployments explicit.
    appStore: {
      bundleId: env.APP_STORE_BUNDLE_ID || "com.parikshit.pocvault",
      appAppleId: intFrom(env.APP_STORE_APP_APPLE_ID, 6800257362),
      monthlyProductId:
        env.APP_STORE_HOSTED_MONTHLY_PRODUCT_ID ||
        "com.parikshit.pocvault.hosted.monthly",
      yearlyProductId:
        env.APP_STORE_HOSTED_YEARLY_PRODUCT_ID ||
        "com.parikshit.pocvault.hosted.yearly",
      enableOnlineChecks: env.APP_STORE_ONLINE_CHECKS !== "0",
    },

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
    // Per-IP twin of the ceiling above. The global cap alone bounds the
    // table but not who fills it: one caller holding DEVICE_CODE_MAX_LIVE
    // codes denies every OTHER caller a code for the rest of the TTL window.
    // A per-IP limit needs a trustworthy client-IP signal, and this
    // deployment has one: deploy/relay-cloud.nginx.conf.template sets
    // `X-Real-IP $remote_addr`, and the app binds 127.0.0.1 (see `host`
    // above), so nginx is the only possible peer and the header cannot be
    // spoofed by the caller. Sized well above legitimate simultaneous use
    // from one IP (a shared office/VPN egress with many engineers mid-login
    // at once) while keeping any single IP far short of the global ceiling —
    // the point is to raise the number of distinct source IPs an attacker
    // needs, not to rate-limit ordinary users.
    deviceCodeMaxLivePerIp: intFrom(env.DEVICE_CODE_MAX_LIVE_PER_IP, 50),

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
    // Better Auth admin plugin pinning. Comma-separated emails, compared after
    // normalizeEmail. A matching session is an admin even if set-role demoted
    // the stored role; Relay never hard-codes a production address here.
    adminEmails: (env.RELAY_ADMIN_EMAILS || "")
      .split(",")
      .map((s) => normalizeEmail(s))
      .filter(Boolean),

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

    tunnel: {
      host: env.TUNNEL_HOST || "",
      port: intFrom(env.TUNNEL_PORT, 80),
      suffix: env.TUNNEL_SUFFIX || "",
    },

    // Browser activity grants. Ed25519 only — there is no HMAC
    // BROWSER_GRANT_SECRET. Private key stays on the control-plane host; the
    // 32-byte public half is what a node is configured with so it can verify
    // a grant. Unset means POST /v1/nodes/:id/browser-grants returns 503.
    browserGrantPrivateKey: env.BROWSER_GRANT_PRIVATE_KEY || "",
    browserGrantPublicKey: env.BROWSER_GRANT_PUBLIC_KEY || "",
    grantGatewayUrl: env.GRANT_GATEWAY_URL || "",

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

    // Visibility timeout for a handed-out-but-not-yet-confirmed handoff. A
    // poll response reaching res.end()'s write() is not proof it reached the
    // node — a partitioned peer observes no FIN and the socket looks alive
    // for the whole poll — so GET /v1/node/handoffs LEASES a row rather than
    // delivering it, and POST /v1/node/handoffs/ack is the only path to
    // `delivered`. An unconfirmed lease expires and the row becomes
    // claimable again: recoverable by construction, not by trying to detect
    // a dead peer (which cannot be done in general). See Task 8 review,
    // Finding 1 / IMPORTANT 1. Kept short: relayd acks immediately after
    // successfully parsing the poll response (proof the bytes crossed a live
    // connection), so the normal case never comes close to this window —
    // it only bounds how long a genuinely partitioned handoff stays stuck.
    handoffLeaseSec: Math.max(1, intFrom(env.HANDOFF_LEASE_SEC, 30)),

    // relayd treats this as a short, renewable authorization lease for its
    // account's data path. Disconnect wakes the long-poll immediately; the
    // lease also bounds stale access when the node cannot reach the cloud.
    computerAccessLeaseSec: Math.min(
      120,
      Math.max(10, intFrom(env.COMPUTER_ACCESS_LEASE_SEC, 45)),
    ),
  };
}

// Same shape as the grant half-config check in main.js: a live web console
// with RELAY_WEB_ORIGINS needs an https BETTER_AUTH_URL so SameSite=None
// cookies can be Secure. Checked at process start, not inside createApp, so
// in-process tests may still use http://127.0.0.1.
export function webOriginsRequireHttps(config) {
  return (
    Array.isArray(config.trustedWebOrigins) &&
    config.trustedWebOrigins.length > 0 &&
    !String(config.betterAuthBaseURL || "").startsWith("https://")
  );
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function intFrom(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
