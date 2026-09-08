// Entrypoint: env-configured server + periodic sweeps.

import { loadConfig, webOriginsRequireHttps } from "./config.js";
import { createApp } from "./server.js";
import { createHttp2Transport, createNoopTransport, apnsConfigured } from "./apns.js";

const config = loadConfig();

if (!config.sessionSecret || config.sessionSecret.length < 32) {
  console.error("SESSION_SECRET missing or shorter than 32 chars; refusing to start.");
  process.exit(1);
}
if (!config.betterAuthSecret || config.betterAuthSecret.length < 32) {
  console.error("BETTER_AUTH_SECRET missing or shorter than 32 chars; refusing to start.");
  process.exit(1);
}
if (config.appleClientIds.length === 0) {
  console.warn("APPLE_CLIENT_IDS unset — Sign in with Apple will reject all tokens.");
}
if (!config.adminToken) console.warn("ADMIN_TOKEN unset — /v1/admin/* disabled.");
if (config.adminEmails.length === 0) {
  console.warn("RELAY_ADMIN_EMAILS unset — no env-pinned admin.");
}
if (!config.brokerToken) console.warn("BROKER_TOKEN unset — /v1/tunnel/* disabled.");

// Browser grants are a half-configuration trap: GRANT_GATEWAY_URL in a
// response with no private key to sign it looks configured and fails at
// request time. These two are the whole of the cloud's half — they are exactly
// what POST /v1/nodes/:id/browser-grants needs — so the guard covers exactly
// them. Names only, never values.
const grantMissing = [
  ["BROWSER_GRANT_PRIVATE_KEY", config.browserGrantPrivateKey],
  ["GRANT_GATEWAY_URL", config.grantGatewayUrl],
]
  .filter(([, value]) => !value)
  .map(([name]) => name);
if (grantMissing.length === 1) {
  console.error(
    `browser grants are half-configured; missing ${grantMissing[0]}. ` +
      "Set BROWSER_GRANT_PRIVATE_KEY and GRANT_GATEWAY_URL together, " +
      "or unset both to disable grants.",
  );
  process.exit(1);
}

// The verifying half is NOT the control plane's to hold. enroll.json — written
// by the provisioner, which no longer exists — was the only thing that ever
// delivered it, so a BYO node now reads the public key from its own
// RELAYD_GRANT_PUBLIC_KEY. Set here it is inert, so say so rather than ignore
// it silently: the operator who set it believes grants are wired up.
if (config.browserGrantPublicKey) {
  console.warn(
    "BROWSER_GRANT_PUBLIC_KEY is set but the control plane never uses it — " +
      "nothing delivers it to a node any more. Set RELAYD_GRANT_PUBLIC_KEY in " +
      "the node's own environment instead, and unset this.",
  );
}

if (webOriginsRequireHttps(config)) {
  console.error(
    "RELAY_WEB_ORIGINS is set but BETTER_AUTH_URL is not https; refusing to start. " +
      "Set BETTER_AUTH_URL to the public https API origin, or unset RELAY_WEB_ORIGINS.",
  );
  process.exit(1);
}

const apnsTransport = apnsConfigured(config)
  ? createHttp2Transport()
  : createNoopTransport((msg) => console.warn(msg));
if (!apnsConfigured(config)) {
  console.warn("APNs credentials unset — pushes will be skipped, ingest still works.");
}

const app = createApp({ config, apnsTransport });
await app.auth.ready;

if (!app.auth.appleConfigured) {
  console.warn(
    "APPLE_CLIENT_IDS or APPLE_CLIENT_SECRET unset — Better Auth Apple sign-in is disabled.",
  );
}

const SWEEP_INTERVAL_MS = 60 * 1000;
const sweeper = setInterval(() => {
  try {
    app.runSweeps();
  } catch (err) {
    console.error(`sweep failed: ${err?.message}`);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref();

app.server.listen(config.port, config.host, () => {
  console.log(`relay-cloud listening on ${config.host}:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
