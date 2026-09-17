import os from "node:os";

import {
  DEVICE_SLOT,
  NODE_SLOT,
  blobTag,
  deviceToken,
  macKey,
  parsePairingLink,
  requestJsonPinned,
  spkiPin,
  verifyBlobTag,
  writeDirectConfig,
} from "../direct.mjs";

async function cmdConnect(args = [], deps = {}) {
  const {
    home = os.homedir(),
    log = console.log,
    requestPinned = requestJsonPinned,
    hostname = os.hostname(),
    platform = process.platform,
  } = deps;
  const unknown = args.filter((arg) => arg.startsWith("--"));
  if (unknown.length > 0) throw new Error(`unknown_option: ${unknown[0]}`);
  if (args.length !== 1) throw new Error("usage: relay connect '<Link from relayd pair>'");

  const invite = parsePairingLink(args[0]);
  const key = macKey(invite.secret);
  const deviceBlob = Buffer.from(JSON.stringify({
    mint: "p12",
    deviceName: `Relay CLI on ${hostname}`,
    platform,
  }), "utf8");
  const response = await requestPinned(invite.pairUrl, invite.pin, {
    v: 2,
    code: invite.secret,
    blob: deviceBlob.toString("base64"),
    tag: blobTag(key, DEVICE_SLOT, deviceBlob),
  });
  if (response.status !== 201 || !response.json?.blob || !response.json?.tag) {
    throw new Error(`direct_pair_failed_${response.status || "network"}: ${response.json?.error || "pairing failed"}`);
  }

  const nodeBlob = Buffer.from(response.json.blob, "base64");
  if (!verifyBlobTag(key, NODE_SLOT, nodeBlob, response.json.tag)) {
    throw new Error("direct_pair_response_auth_failed");
  }
  let node;
  try { node = JSON.parse(nodeBlob.toString("utf8")); } catch { throw new Error("direct_pair_response_invalid"); }
  if (
    !node ||
    node.nodeId !== invite.nodeId ||
    typeof node.caPem !== "string" ||
    typeof node.apiBaseUrl !== "string" ||
    spkiPin(node.caPem) !== invite.pin
  ) {
    throw new Error("direct_pair_identity_mismatch");
  }
  const advertisedApi = new URL(invite.apiBaseUrl);
  const deliveredApi = new URL(node.apiBaseUrl);
  if (advertisedApi.origin !== deliveredApi.origin) throw new Error("direct_pair_api_mismatch");

  writeDirectConfig({
    nodeId: node.nodeId,
    nodeName: node.nodeName || invite.nodeName || node.nodeId,
    apiBaseUrl: node.apiBaseUrl,
    deviceToken: deviceToken(invite.secret),
    caPem: node.caPem,
    deviceId: node.deviceId || null,
    connectedAt: new Date().toISOString(),
    workspaceMappings: {},
  }, { home });

  log(`  Connected: ${node.nodeName || invite.nodeName || node.nodeId}`);
  log(`  Machine:   ${node.apiBaseUrl}`);
  if (node.verificationCode) log(`  Confirm:   ${node.verificationCode}`);
  log("");
  log("  Repository sessions can now sync directly with `relay sync-sessions`.");
  return { nodeId: node.nodeId, apiBaseUrl: node.apiBaseUrl, verificationCode: node.verificationCode || null };
}

export { cmdConnect };
