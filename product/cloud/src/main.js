// Entrypoint: env-configured server + periodic sweeps.

import { loadConfig } from "./config.js";
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
if (!config.brokerToken) console.warn("BROKER_TOKEN unset — /v1/tunnel/* disabled.");

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
