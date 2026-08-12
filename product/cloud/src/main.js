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

// A half-configured trial feature fails silently and plausibly instead of
// loudly, which is the worst of both worlds:
//   - without ENROLL_BASE_URL the sandbox is handed `http://127.0.0.1:<port>`
//     and tries to enrol against ITSELF;
//   - without TUNNEL_SUFFIX every trial's `sni` is null, so the phone gets no
//     node URL and quietly falls back to whatever personal install it already
//     had, talking to the wrong machine entirely.
// Both look configured and produce a broken trial. Refuse to start instead.
// Only checked when E2B_API_URL is set, so the deliberate dark launch (every
// trial variable unset) still boots cleanly. Names only — never values.
if (config.e2b.apiUrl) {
  const missing = [
    ["E2B_API_KEY", config.e2b.apiKey],
    ["TRIAL_TEMPLATE_ID", config.e2b.templateId],
    ["ENROLL_BASE_URL", config.enrollBaseUrl],
    ["TUNNEL_HOST", config.tunnel.host],
    ["TUNNEL_SUFFIX", config.tunnel.suffix],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    console.error(
      `E2B_API_URL is set but ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing; ` +
        "refusing to start with a half-configured trial feature. " +
        "Unset E2B_API_URL to disable trials entirely.",
    );
    process.exit(1);
  }
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
