// Node-side machine power: a long-lived wake secret, the token handed to
// paired phones, IMDS/env instance discovery, and registration with the
// control plane. The secret never leaves this machine; the phone stores the
// derived token and presents it to poc-ec2 to start/stop the box.

import crypto from "node:crypto";
import fs from "node:fs";

import {
  cloudUrl,
  powerEnabled,
  powerInstanceId,
  powerRegion,
  powerEnrollToken,
} from "./config.mjs";
import { identityPaths, readNodeId } from "./identity.mjs";

const WAKE_LABEL = "relay-wake-token-v1";
const INSTANCE_ID_RE = /^i-[0-9a-f]{8,17}$/;
const IMDS = "http://169.254.169.254";
const IMDS_TIMEOUT_MS = 400;

function ensureWakeSecret(baseDir) {
  const paths = identityPaths(baseDir);
  fs.mkdirSync(paths.baseDir, { recursive: true, mode: 0o700 });
  const file = paths.wakeSecretPath;
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch {
    // first mint
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return secret;
}

export function wakeToken(baseDir) {
  const secret = ensureWakeSecret(baseDir);
  return crypto.createHmac("sha256", Buffer.from(secret, "hex")).update(WAKE_LABEL).digest("hex");
}

export function wakeTokenHash(baseDir) {
  return crypto.createHash("sha256").update(wakeToken(baseDir), "utf8").digest("hex");
}

async function fetchText(fetchImpl, url, init) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), IMDS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: ac.signal });
    if (!res.ok) return "";
    return (await res.text()).trim();
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}

async function discoverFromImds(fetchImpl) {
  const token = await fetchText(fetchImpl, `${IMDS}/latest/api/token`, {
    method: "PUT",
    headers: { "x-aws-ec2-metadata-token-ttl-seconds": "60" },
  });
  if (!token) return null;
  const headers = { "x-aws-ec2-metadata-token": token };
  const instanceId = (await fetchText(fetchImpl, `${IMDS}/latest/meta-data/instance-id`, { headers })).toLowerCase();
  const region = (await fetchText(fetchImpl, `${IMDS}/latest/meta-data/placement/region`, { headers })).toLowerCase();
  if (!INSTANCE_ID_RE.test(instanceId)) return null;
  return { instanceId, region: region || powerRegion };
}

export async function discoverPowerTarget({
  fetchImpl = fetch,
  enabled = powerEnabled,
  instanceId = powerInstanceId,
  region = powerRegion,
} = {}) {
  if (!enabled) return null;
  const explicit = String(instanceId || "").trim().toLowerCase();
  if (explicit) {
    if (!INSTANCE_ID_RE.test(explicit)) return null;
    return { instanceId: explicit, region: region || powerRegion };
  }
  const discovered = await discoverFromImds(fetchImpl);
  if (!discovered) return null;
  return { instanceId: discovered.instanceId, region: discovered.region || region || powerRegion };
}

export async function registerPowerWithCloud(cloud, { fetchImpl = fetch, baseDir } = {}) {
  if (!cloudUrl || !cloud) return { skipped: "no_cloud" };
  const target = await discoverPowerTarget({ fetchImpl });
  if (!target) return { skipped: "no_instance" };
  await cloud.registerPower({
    instanceId: target.instanceId,
    region: target.region,
    wakeTokenHash: wakeTokenHash(baseDir),
    enrollToken: powerEnrollToken,
  });
  return { instanceId: target.instanceId, region: target.region, nodeId: readNodeId(baseDir ? identityPaths(baseDir) : identityPaths()) };
}

export function powerCredential(baseDir) {
  return {
    v: 1,
    nodeId: readNodeId(baseDir ? identityPaths(baseDir) : identityPaths()),
    wakeToken: wakeToken(baseDir),
  };
}

export { WAKE_LABEL, INSTANCE_ID_RE };
