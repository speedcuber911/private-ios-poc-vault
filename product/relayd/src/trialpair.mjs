// Trial pairing (trial tier ONLY — documented delta from the zero-knowledge
// BYO flow in pairing.mjs). The phone has no CSR stack yet, so the NODE
// mints the device keypair, issues the certificate against its own CA, and
// delivers key+cert+CA as a passphrase-protected PKCS#12 through the cloud
// rendezvous. Both blobs are MAC-tagged with keys derived from the pairing
// secret; on the trial tier the cloud transports that secret to the sandbox
// (operator-hosted trust), which is exactly why BYO must never use this path.

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { pairingKeys, blobTag, verifyBlobTag, DEVICE_SLOT, NODE_SLOT } from "./pairing.mjs";
import { identityPaths, issueDeviceCert, getCaPem } from "./identity.mjs";

const execFileAsync = promisify(execFile);
const P12_LABEL = "relay-trial-p12-v1";
const DEVICE_TOKEN_LABEL = "relay-device-token-v1";

function p12Passphrase(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(P12_LABEL).digest("hex");
}

// The device's bearer token, derived from the same single-use pairing secret
// both sides already hold. Deriving rather than transmitting means the pairing
// protocol is untouched: no new field, no second blob, and nothing extra to
// intercept. The phone computes the identical value from its copy of the
// secret.
function deviceToken(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(DEVICE_TOKEN_LABEL).digest("hex");
}

// Records only the token's SHA-256, so a reader of the node's disk cannot
// authenticate as the device. Written before the node blob is posted: the
// phone can present the token the moment it has the secret, and a machine that
// rejected it in the interval would look exactly like the failure this
// replaces.
function writeDeviceTokenHash(secret) {
  const file = process.env.RELAYD_DEVICE_TOKEN_HASH_FILE;
  if (!file) return;
  const hash = crypto.createHash("sha256").update(deviceToken(secret), "utf8").digest("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${hash}\n`, { mode: 0o600 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runTrialPairing({
  cloudUrl,
  pairingId,
  secret,
  baseDir = undefined,
  fetchImpl = fetch,
  pollIntervalMs = 1000,
  timeoutMs = 120000,
  execFileImpl = execFileAsync,
}) {
  if (!cloudUrl || !pairingId || !secret) throw new Error("trial pairing requires cloudUrl, pairingId and secret");
  const base = `${cloudUrl.replace(/\/+$/, "")}/v1/pairing/sessions/${encodeURIComponent(pairingId)}`;
  const keys = pairingKeys(secret);

  // 1. Wait for the phone's device blob.
  const deadline = Date.now() + timeoutMs;
  let blob = null;
  let tag = "";
  for (;;) {
    const res = await fetchImpl(`${base}/device-blob`, { headers: { "x-pairing-auth": keys.authToken } });
    if (res.status === 200) {
      blob = Buffer.from(await res.arrayBuffer());
      tag = res.headers.get("x-pairing-tag") || "";
      break;
    }
    if (res.status !== 404) throw new Error(`trial_pair_device_blob_${res.status}`);
    if (Date.now() >= deadline) throw new Error("trial_pair_timeout");
    await sleep(pollIntervalMs);
  }
  if (!verifyBlobTag(keys.macKey, DEVICE_SLOT, blob, tag)) throw new Error("trial_pair_bad_tag");

  let parsed;
  try {
    parsed = JSON.parse(blob.toString("utf8"));
  } catch {
    throw new Error("trial_pair_bad_device_blob");
  }
  const deviceName = typeof parsed?.deviceName === "string" ? parsed.deviceName : null;
  const platform = typeof parsed?.platform === "string" ? parsed.platform : null;

  // 2. Mint the device credential. Key material stays inside tmp/ (0700)
  //    and is removed before this function returns, success or not.
  const paths = identityPaths(baseDir || undefined);
  fs.mkdirSync(paths.tmpDir, { recursive: true, mode: 0o700 });
  const stamp = crypto.randomBytes(6).toString("hex");
  const keyPath = path.join(paths.tmpDir, `trial-device-${stamp}.key.pem`);
  const csrPath = path.join(paths.tmpDir, `trial-device-${stamp}.csr.pem`);
  const certPath = path.join(paths.tmpDir, `trial-device-${stamp}.cert.pem`);
  const caPath = path.join(paths.tmpDir, `trial-device-${stamp}.ca.pem`);
  const p12Path = path.join(paths.tmpDir, `trial-device-${stamp}.p12`);
  try {
    await execFileImpl("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", keyPath]);
    fs.chmodSync(keyPath, 0o600);
    await execFileImpl("openssl", ["req", "-new", "-key", keyPath, "-subj", "/CN=trial-device", "-out", csrPath]);
    const issued = issueDeviceCert({
      csrPem: fs.readFileSync(csrPath, "utf8"),
      deviceName,
      platform,
      ...(baseDir ? { baseDir } : {}),
    });
    fs.writeFileSync(certPath, issued.certificatePem);
    fs.writeFileSync(caPath, getCaPem(baseDir || undefined));
    const passphrase = p12Passphrase(secret);
    await execFileImpl(
      "openssl",
      [
        "pkcs12", "-export",
        "-inkey", keyPath,
        "-in", certPath,
        "-certfile", caPath,
        "-name", "relay-trial-device",
        "-passout", "env:RELAY_P12_PASS",
        "-out", p12Path,
      ],
      { env: { ...process.env, RELAY_P12_PASS: passphrase } },
    );
    const p12 = fs.readFileSync(p12Path);

    writeDeviceTokenHash(secret);

    // 3. Post the node blob.
    const res = await fetchImpl(`${base}/node-blob`, {
      method: "POST",
      headers: {
        "x-pairing-auth": keys.authToken,
        "x-pairing-tag": blobTag(keys.macKey, NODE_SLOT, p12),
        "content-type": "application/octet-stream",
      },
      body: p12,
    });
    if (res.status !== 204) throw new Error(`trial_pair_post_${res.status}`);
    return { deviceId: issued.deviceId, certSerial: issued.certSerial };
  } finally {
    for (const f of [keyPath, csrPath, certPath, caPath, p12Path]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {}
    }
  }
}
