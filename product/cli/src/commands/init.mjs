// relay init — register this repository with the control plane and pin the
// fingerprint of the node key that handoff blobs will be sealed to. The pin
// lives in .git/relay/, which git never commits.
import fs from "node:fs";
import path from "node:path";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo } from "../repo.mjs";
import { fingerprint } from "./login.mjs";

async function cmdInit(args = [], deps = {}) {
  const { home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, log = console.log } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");

  const repo = await requireGitHubRepo({ cwd });
  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const registered = await api.registerRepo(repo.fullName);
  if (registered.status !== 201) throw new Error(`repo_registration_failed_${registered.status}`);

  const pinPath = path.join(repo.root, ".git", "relay", "node.json");
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  fs.writeFileSync(pinPath, `${JSON.stringify({
    nodeId: credentials.nodeId,
    encPubkeyFingerprint: credentials.nodeEncPubkey ? fingerprint(credentials.nodeEncPubkey) : null,
    registeredAt: new Date().toISOString(),
  }, null, 2)}\n`, { mode: 0o600 });

  log(`  Repository: ${repo.fullName}`);
  log(`  Machine:    ${credentials.nodeId || "none pinned"}`);
  log("");
  log("  relay handoff will push a relay/handoff-* branch here and notify your phone.");
}

export { cmdInit };
