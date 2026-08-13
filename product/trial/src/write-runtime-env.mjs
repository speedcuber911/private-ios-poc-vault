#!/usr/bin/env node
// Writes ${CODEX_DATA_DIR}/runtime.env from enroll.json for trial boot.
// Invoked by start.sh — keep quoting identical to the previous inline writer
// so values cannot break out of the shell. Never print secrets or keys.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function pushIfPresent(out, name, value) {
  if (value) out.push(name + "=" + shellQuote(value));
}

export function writeRuntimeEnv({ enrollPath, outPath, nodeIdPath }) {
  const cfg = JSON.parse(fs.readFileSync(enrollPath, "utf8"));
  const out = [];
  pushIfPresent(out, "RELAYD_CLOUD_URL", cfg.cloudUrl);
  pushIfPresent(out, "RELAYD_TUNNEL_HOST", cfg.tunnelHost);
  pushIfPresent(out, "RELAYD_TUNNEL_PORT", cfg.tunnelPort);
  pushIfPresent(out, "RELAYD_TUNNEL_SUFFIX", cfg.tunnelSuffix);
  if (typeof cfg.grantPublicKey === "string" && cfg.grantPublicKey) {
    out.push("RELAYD_GRANT_PUBLIC_KEY=" + shellQuote(cfg.grantPublicKey));
  }
  if (nodeIdPath) {
    try {
      const nodeId = fs.readFileSync(nodeIdPath, "utf8").trim();
      if (nodeId) out.push("RELAYD_NODE_ID=" + shellQuote(nodeId));
    } catch {
      // Enroll may have failed; existing boot rules already apply.
    }
  }
  fs.writeFileSync(outPath, out.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(outPath, 0o600);
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);

if (isMain) {
  writeRuntimeEnv({
    enrollPath: process.argv[2],
    outPath: process.argv[3],
    nodeIdPath: process.argv[4],
  });
}
