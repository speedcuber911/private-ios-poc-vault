// Shared test scaffolding: in-memory app, fake Apple JWKS + minted identity
// tokens, recording mail/APNs transports, ed25519 node identities, and a
// controllable clock.

import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { createDb } from "../src/db.js";
import { b64urlJson } from "../src/jwt.js";

export const TEST_APPLE_CLIENT_ID = "com.relay.test";
export const TEST_ADMIN_TOKEN = "test-admin-token-0123456789abcdef";
export const TEST_BROKER_TOKEN = "test-broker-token-0123456789abcdef";

// ── fake Apple identity provider ──────────────────────────────────────────
export function makeAppleIdp({ kid = "test-key-1" } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig" };
  const jwks = { keys: [jwk] };

  function mintIdentityToken({
    sub = "apple-sub-1",
    email = "user@example.com",
    aud = TEST_APPLE_CLIENT_ID,
    iss = "https://appleid.apple.com",
    expSec = Math.floor(Date.now() / 1000) + 300,
    headerKid = kid,
  } = {}) {
    const header = b64urlJson({ alg: "RS256", kid: headerKid, typ: "JWT" });
    const payload = b64urlJson({ iss, aud, sub, email, exp: expSec, iat: expSec - 600 });
    const sig = cryptoSign(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      privateKey,
    ).toString("base64url");
    return `${header}.${payload}.${sig}`;
  }

  return { jwks, mintIdentityToken, jwksFetcher: async () => jwks };
}

// ── recording transports ──────────────────────────────────────────────────
export function makeMailTransport() {
  const sent = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

export function makeApnsTransport() {
  const requests = [];
  // Default is Apple accepting the push. `respondWith` makes it answer
  // something else for every subsequent send — needed to exercise the outcome
  // classifier (BadDeviceToken, 410, auth failures) without a live APNs.
  let reply = { status: 200, headers: {}, body: "" };
  const transport = async ({ host, path, headers, body }) => {
    requests.push({ host, path, headers, body: JSON.parse(body) });
    return reply;
  };
  transport.requests = requests;
  transport.respondWith = ({ status, body = "", headers = {} }) => {
    reply = { status, headers, body };
  };
  return transport;
}

// ── ed25519 node identity ─────────────────────────────────────────────────
export function makeNodeIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubkeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  function signBody(buf) {
    return cryptoSign(null, buf, privateKey).toString("base64url");
  }
  return { pubkeyPem, privateKey, signBody };
}

// APNs provider signing key for the real client shape (P-256, PEM).
function makeApnsSigningKey() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
}

// ── app harness ───────────────────────────────────────────────────────────
// `db` and `now` may be supplied to stand a SECOND app over the same database
// and clock — how the trial kill-switch test rebuilds the service with the
// trial config removed without losing the rows the first one wrote.
export async function startTestApp(overrides = {}) {
  const clock = overrides.clock ?? { t: Date.now() };
  const now = overrides.now ?? (() => clock.t);

  const config = loadConfig({
    SESSION_SECRET: "test-session-secret-must-be-long-enough-000",
    APPLE_CLIENT_IDS: TEST_APPLE_CLIENT_ID,
    ADMIN_TOKEN: TEST_ADMIN_TOKEN,
    BROKER_TOKEN: TEST_BROKER_TOKEN,
    APNS_KEY_ID: "TESTKEYID1",
    APNS_TEAM_ID: "TESTTEAM01",
    APNS_BUNDLE_ID: "com.relay.test.app",
    APNS_SIGNING_KEY_P8: makeApnsSigningKey(),
    ...overrides.env,
  });

  const idp = overrides.idp ?? makeAppleIdp();
  const mail = overrides.mailTransport ?? makeMailTransport();
  const apnsTransport = overrides.apnsTransport ?? makeApnsTransport();

  const app = createApp({
    config,
    db: overrides.db ?? createDb(":memory:"),
    jwksFetcher: idp.jwksFetcher,
    mailTransport: mail,
    apnsTransport,
    now,
    provisioner: overrides.provisioner,
    ...(overrides.log ? { log: overrides.log } : {}),
  });

  await app.auth.ready;

  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const { port } = app.server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    app,
    baseUrl,
    clock,
    idp,
    mail,
    apnsTransport,
    config,
    close: () => new Promise((resolve) => app.server.close(resolve)),
  };
}

// ── tiny HTTP client ──────────────────────────────────────────────────────
export async function api(baseUrl, method, path, { body, headers = {}, raw, signal } = {}) {
  const init = { method, headers: { ...headers } };
  if (signal) init.signal = signal;
  if (raw !== undefined) {
    init.body = raw;
    init.headers["content-type"] ||= "application/octet-stream";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const res = await fetch(`${baseUrl}${path}`, init);
  const buf = Buffer.from(await res.arrayBuffer());
  let json = null;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json") && buf.length > 0) {
    json = JSON.parse(buf.toString("utf8"));
  }
  return { status: res.status, json, buf, headers: res.headers };
}

// Convenience: sign in via Apple and return { sessionToken, refreshToken, accountId }.
// Pass { sub, email } to mint a distinct identity (e.g. a second account in
// the same test) — both default inside makeAppleIdp().mintIdentityToken.
export async function signIn(t, { sub, email } = {}) {
  const token = t.idp.mintIdentityToken({ sub, email });
  const res = await api(t.baseUrl, "POST", "/v1/auth/apple", {
    body: { identityToken: token },
  });
  if (res.status !== 200) throw new Error(`signIn failed: ${res.status}`);
  return res.json;
}

export function authed(sessionToken, extra = {}) {
  return { headers: { authorization: `Bearer ${sessionToken}`, ...extra } };
}
