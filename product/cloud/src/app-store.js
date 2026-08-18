import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Environment, SignedDataVerifier } from "@apple/app-store-server-library";

const APP_ACCOUNT_TOKEN_DOMAIN = "relay-app-account-v1\0";
const ROOT_CERTIFICATES = [
  new URL("../certs/apple-root-ca.cer", import.meta.url),
  new URL("../certs/apple-root-ca-g2.cer", import.meta.url),
  new URL("../certs/apple-root-ca-g3.cer", import.meta.url),
];

/// StoreKit requires a UUID appAccountToken, while Better Auth account ids are
/// NanoIDs. Derive a stable, one-way UUID from the account id so Apple-signed
/// transactions can be bound to the authenticated Relay account without
/// exposing the account id to Apple or accepting a client-selected mapping.
export function appAccountTokenForAccount(accountId) {
  const bytes = createHash("sha256")
    .update(APP_ACCOUNT_TOKEN_DOMAIN)
    .update(String(accountId))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createAppStoreVerifier(config) {
  const roots = ROOT_CERTIFICATES.map((url) => readFileSync(url));
  const sandbox = new SignedDataVerifier(
    roots,
    config.appStore.enableOnlineChecks,
    Environment.SANDBOX,
    config.appStore.bundleId,
  );
  const production = new SignedDataVerifier(
    roots,
    config.appStore.enableOnlineChecks,
    Environment.PRODUCTION,
    config.appStore.bundleId,
    config.appStore.appAppleId,
  );
  const verifiers = [production, sandbox];

  async function tryBoth(method, payload) {
    let lastError;
    for (const verifier of verifiers) {
      try {
        return await verifier[method](payload);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("app_store_verification_failed");
  }

  return {
    verifyTransaction: (payload) => tryBoth("verifyAndDecodeTransaction", payload),
    verifyNotification: (payload) => tryBoth("verifyAndDecodeNotification", payload),
    verifyNotificationTransaction: (payload) => tryBoth("verifyAndDecodeTransaction", payload),
  };
}
