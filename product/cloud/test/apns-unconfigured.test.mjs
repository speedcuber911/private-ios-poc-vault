// createApnsClient with incomplete credentials.
//
// The file-level contract in src/apns.js says "send() NEVER throws". It did.
// `headers` interpolates providerToken(), and that happens before the
// try/catch that guards the transport — so with no signing key,
// createPrivateKey("") threw OpenSSL's "DECODER routines::unsupported" out of
// send() and past every caller guard.
//
// This was not theoretical. Production logged, from one process:
//   07:55:25  APNs credentials unset — pushes will be skipped, ingest still works.
//   08:59:35  apns send threw: error:1E08010C:DECODER routines::unsupported
// The boot line chose the noop transport and believed pushes were safely
// disabled; the first real push proved they were not. The noop transport can
// never help here, because the JWT is minted before the transport is consulted.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { createApnsClient, APNS_OUTCOME } from "../src/apns.js";

function configWith(apns) {
  return {
    apns: {
      keyId: "",
      teamId: "",
      bundleId: "",
      signingKeyPem: "",
      host: "api.sandbox.push.apple.com",
      requestTimeoutMs: 1000,
      ...apns,
    },
  };
}

const SEND = {
  deviceToken: "a".repeat(64),
  kind: "mutable",
  category: "RELAY_HANDOFF_READY",
  payload: { id: "h1" },
};

// A throwaway P-256 key, generated per run. Only proves the configured path
// still works; it is not a credential and never leaves this process.
function testSigningKeyPem() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return privateKey.export({ type: "pkcs8", format: "pem" });
}

// The exact production shape: team/bundle/host set by hand, key material never
// minted. This is the case that threw.
test("no signing key: send resolves SKIPPED instead of throwing", async () => {
  let transportCalls = 0;
  const client = createApnsClient({
    config: configWith({ teamId: "QRXV2V66Y6", bundleId: "com.example.app" }),
    transport: async () => {
      transportCalls += 1;
      return { status: 200, headers: {}, body: "" };
    },
  });

  const result = await client.send(SEND);

  assert.deepEqual(result, { outcome: APNS_OUTCOME.SKIPPED, status: 0, reason: null });
  assert.equal(transportCalls, 0, "an unconfigured client must not reach the transport at all");
});

// Each field alone is enough to make the client unusable, and every one of
// them reached createPrivateKey before this guard existed.
for (const [label, apns] of [
  ["nothing set at all", {}],
  ["key id missing", { teamId: "T", bundleId: "B", signingKeyPem: "pem" }],
  ["team id missing", { keyId: "K", bundleId: "B", signingKeyPem: "pem" }],
  ["bundle id missing", { keyId: "K", teamId: "T", signingKeyPem: "pem" }],
]) {
  test(`incomplete credentials (${label}) skip rather than throw`, async () => {
    const client = createApnsClient({
      config: configWith(apns),
      transport: async () => {
        throw new Error("transport must not be reached");
      },
    });
    const result = await client.send(SEND);
    assert.equal(result.outcome, APNS_OUTCOME.SKIPPED);
    assert.equal(result.status, 0);
  });
}

// The guard must not disable a deployment that IS configured.
test("fully configured: send mints a token and reaches the transport", async () => {
  const seen = [];
  const client = createApnsClient({
    config: configWith({
      keyId: "ABC1234567",
      teamId: "QRXV2V66Y6",
      bundleId: "com.example.app",
      signingKeyPem: testSigningKeyPem(),
    }),
    transport: async (req) => {
      seen.push(req);
      return { status: 200, headers: {}, body: "" };
    },
  });

  const result = await client.send(SEND);

  assert.equal(result.outcome, APNS_OUTCOME.DELIVERED);
  assert.equal(seen.length, 1);
  assert.match(seen[0].headers.authorization, /^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  assert.equal(seen[0].headers["apns-topic"], "com.example.app");
});
