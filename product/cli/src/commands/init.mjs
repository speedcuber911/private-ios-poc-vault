// relay init — register this repository with the control plane and pin the
// fingerprint of the node key that handoff blobs will be sealed to. The pin
// lives inside the repo's real git dir (resolved via `git rev-parse
// --git-dir`, so this also works from a linked worktree, where `.git` at the
// worktree root is a file, not a directory), which git never commits.
import fs from "node:fs";
import path from "node:path";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo, git } from "../repo.mjs";
import { fingerprint } from "./login.mjs";

async function resolveGitDir(root) {
  const gitDir = (await git(root, ["rev-parse", "--git-dir"])).trim();
  return path.resolve(root, gitDir);
}

async function cmdInit(args = [], deps = {}) {
  const { home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, log = console.log } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");

  const repo = await requireGitHubRepo({ cwd });
  const api = createCloudApi({
    baseUrl,
    sessionToken: credentials.sessionToken,
    refreshToken: credentials.refreshToken,
    home,
    fetchImpl,
  });
  const registered = await api.registerRepo(repo.fullName);
  if (registered.status !== 201) throw new Error(`repo_registration_failed_${registered.status}`);

  const gitDir = await resolveGitDir(repo.root);
  const pinPath = path.join(gitDir, "relay", "node.json");
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
