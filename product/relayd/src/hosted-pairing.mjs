// Hosted-device recovery worker. Only enabled for device-token hosted nodes,
// never for BYO pairing. Cloud authenticates ownership; the node alone opens
// the encrypted request and checks its node/session/expiry binding.
import crypto from "node:crypto";
import { openSealed } from "./seal.mjs";
import { identityPaths, readNodeId, readEncPrivateKeyPem, isRevokedSerial } from "./identity.mjs";
import { hostedDeviceStore } from "./hosted-device-store.mjs";
import { prepareTrialPairing, postPreparedTrialPairing } from "./trialpair.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TTL = 900_000;

export function createHostedPairingWorker({
  cloudUrl, baseDir, hashFile = process.env.RELAYD_DEVICE_TOKEN_HASH_FILE,
  now = Date.now, fetchImpl = fetch, deviceStore = hostedDeviceStore(hashFile),
  prepare = prepareTrialPairing, post = postPreparedTrialPairing,
} = {}) {
  if (!hashFile || !deviceStore) return null;
  const paths = identityPaths(baseDir);
  const nodeId = readNodeId(paths);
  const privateKey = readEncPrivateKeyPem(paths);
  if (!nodeId || !privateKey || !cloudUrl) return null;

  return async function recover(request) {
    if (!request || typeof request.pairingId !== "string" || !UUID.test(request.pairingId) ||
        typeof request.sealedSecret !== "string" || request.sealedSecret.length > 4096 ||
        !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= now() || request.expiresAt > now() + MAX_TTL) {
      throw new Error("hosted_pairing_invalid");
    }
    const sealed = Buffer.from(request.sealedSecret, "base64");
    if (sealed.toString("base64") !== request.sealedSecret) throw new Error("hosted_pairing_invalid");
    let payload;
    try { payload = JSON.parse(openSealed(privateKey, sealed).toString("utf8")); }
    catch { throw new Error("hosted_pairing_invalid"); }
    if (!payload || payload.v !== 1 || payload.nodeId !== nodeId || payload.pairingId !== request.pairingId ||
        payload.expiresAt !== request.expiresAt || typeof payload.secret !== "string" ||
        !/^[A-Za-z0-9_-]{22,128}$/.test(payload.secret)) throw new Error("hosted_pairing_invalid");
    const fingerprint = crypto.createHash("sha256").update(sealed).digest("hex");
    deviceStore.reclaimRevoked(isRevokedSerial);
    const claim = deviceStore.claim(request.pairingId, fingerprint, request.expiresAt);
    if (!claim) return false;
    if (claim.active) return true;
    try {
      const options = { cloudUrl, pairingId: request.pairingId, secret: payload.secret, baseDir, fetchImpl, timeoutMs: 10_000 };
      let prepared = claim.prepared;
      if (!prepared) {
        prepared = await prepare(options);
        deviceStore.savePrepared(request.pairingId, claim.owner, prepared);
      }
      // Exact encrypted response retries are accepted for hosted-device slots.
      // No credential is activated until the upload succeeded, and cloud
      // withholds it from the phone until the signed ready acknowledgement.
      await post({ ...options, prepared });
      deviceStore.activate(request.pairingId, claim.owner);
      return true;
    } finally {
      deviceStore.release(request.pairingId, claim.owner);
    }
  };
}
