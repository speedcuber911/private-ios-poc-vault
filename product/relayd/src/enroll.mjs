// relayd enroll — non-interactive bootstrap for cloud-provisioned (trial)
// nodes. Creates the node identity if missing and registers the identity
// public key with the control plane using a single-use enroll token. The
// token authenticates exactly one registration and is burned server-side.

import fs from "node:fs";
import { initIdentity, identityPaths, readNodeId } from "./identity.mjs";

export async function enrollWithCloud({ cloudUrl, token, version = null, baseDir = undefined, fetchImpl = fetch }) {
  if (!cloudUrl) throw new Error("enroll requires a cloud URL");
  if (!token) throw new Error("enroll requires an enroll token");

  initIdentity(baseDir ? { baseDir } : {});
  const paths = identityPaths(baseDir || undefined);
  const nodeId = readNodeId(paths);
  const pubkey = fs.readFileSync(paths.identityPubPath, "utf8");

  const res = await fetchImpl(`${cloudUrl.replace(/\/+$/, "")}/v1/trial-nodes/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, nodeId, pubkey, version }),
  });
  if (res.status !== 200) throw new Error(`enroll_failed_${res.status}`);
  const json = await res.json();
  return { nodeId, sni: json.sni };
}
