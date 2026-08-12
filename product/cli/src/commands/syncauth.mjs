// relay sync-auth — put the operator's own logins on their sandbox.
//
// Credentials ride the pairing rendezvous sealed to the node's key: the control
// plane relays opaque bytes and GitHub never sees them at all (a token in git
// history cannot be un-published). Nothing here prints a credential.
//
// Derivations below are re-implemented from the documented protocol (the
// comment header of product/cloud/src/pairing.js and relayd's
// product/relayd/src/pairing.mjs) rather than imported from either, so this
// file is an independent third source of truth for authTokenFor/blobTagFor —
// a shared bug in a shared helper would otherwise be invisible to every test
// that exercises it.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { sealTo } from "../seal.mjs";
import { discoverSessions } from "../sessions.mjs";

const execFileAsync = promisify(execFile);
const AUTH_LABEL = "relay-pair-auth-v1";
const MAC_LABEL = "relay-pair-mac-v1";
const DEVICE_SLOT = "device-blob";

function generateSecret() {
  return crypto.randomBytes(24).toString("base64url");
}

function authTokenFor(secret) {
  return crypto.createHash("sha256")
    .update(Buffer.concat([Buffer.from(AUTH_LABEL, "utf8"), Buffer.from([0]), Buffer.from(String(secret), "utf8")]))
    .digest("base64url");
}

function macKeyFor(secret) {
  return crypto.createHmac("sha256", Buffer.from(String(secret), "utf8")).update(MAC_LABEL).digest();
}

function blobTagFor(macKey, slot, blob) {
  return crypto.createHmac("sha256", macKey)
    .update(Buffer.concat([Buffer.from(slot, "utf8"), Buffer.from([0]), blob]))
    .digest("base64");
}

function readIfPresent(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

// Never fakes a success: a harness with no portable credential on this
// machine is reported by name in `skipped`, not silently omitted. Cursor has
// no portable credential at all (v0), so it is never even attempted here —
// cmdSyncAuth states its on-box login requirement unconditionally instead.
async function collectCredentialBundle({ home = os.homedir(), execFileImpl = execFileAsync } = {}) {
  const bundle = { v: 1, kind: "sync-auth" };
  const skipped = [];

  let githubToken = null;
  try {
    const { stdout } = await execFileImpl("gh", ["auth", "token"]);
    githubToken = String(stdout).trim() || null;
  } catch {
    githubToken = null;
  }
  if (githubToken) bundle.github = { token: githubToken };
  else skipped.push("github");

  const claude = readIfPresent(path.join(home, ".claude", ".credentials.json"));
  if (claude) bundle.claude = { credentials: claude };
  else skipped.push("claude");

  const codex = readIfPresent(path.join(home, ".codex", "auth.json"));
  if (codex) bundle.codex = { auth: codex };
  else skipped.push("codex");

  return { bundle, skipped };
}

// Originates a fresh pairing secret on this side, seals payload to the node's
// key, and delivers it through the rendezvous device slot. The cloud sees
// only authTokenFor(secret) and the sealed ciphertext plus its MAC tag — never
// the secret, the derived macKey, or the plaintext.
async function deliverSealedBundle({ api, nodeEncPubkey, kind, payload }) {
  const secret = generateSecret();
  const authToken = authTokenFor(secret);
  const created = await api.createPairingSession(authToken, kind);
  if (created.status !== 201) throw new Error(`rendezvous_create_failed_${created.status}`);

  const sealed = sealTo(nodeEncPubkey, Buffer.from(JSON.stringify(payload), "utf8"));
  const tag = blobTagFor(macKeyFor(secret), DEVICE_SLOT, sealed);
  const put = await api.putDeviceBlob(created.json.pairingId, authToken, tag, sealed);
  if (put.status !== 204) throw new Error(`rendezvous_put_failed_${put.status}`);
  return created.json.pairingId;
}

async function publishSessionIndex({ repoFullName, root, home, api, nodeEncPubkey, machine }) {
  const sessions = discoverSessions({ cwd: root, home }).slice(0, 50).map((session) => ({
    id: session.id, harness: session.harness, title: session.title,
    repo: repoFullName, lastActive: session.lastActive,
  }));
  await deliverSealedBundle({
    api, nodeEncPubkey, kind: "session-index",
    payload: { v: 1, kind: "session-index", machine, updatedAt: new Date().toISOString(), sessions },
  });
  return sessions.length;
}

async function cmdSyncAuth(args = [], deps = {}) {
  const {
    home = undefined, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch, log = console.log,
    execFileImpl = execFileAsync, machine = os.hostname(),
  } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");
  if (!credentials.nodeEncPubkey) throw new Error("no_machine_pinned: run relay login after creating a machine");

  const { bundle, skipped } = await collectCredentialBundle({ home: home || os.homedir(), execFileImpl });
  const installed = ["github", "claude", "codex"].filter((name) => bundle[name]);

  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const pairingId = await deliverSealedBundle({ api, nodeEncPubkey: credentials.nodeEncPubkey, kind: "sync-auth", payload: bundle });

  // Best-effort, and skipped outside a repo: a stale index must never fail a
  // credential sync that otherwise succeeded.
  try {
    const { requireGitHubRepo } = await import("../repo.mjs");
    const repo = await requireGitHubRepo({ cwd: deps.cwd || process.cwd() });
    const count = await publishSessionIndex({
      repoFullName: repo.fullName, root: fs.realpathSync(repo.root), home: home || os.homedir(),
      api, nodeEncPubkey: credentials.nodeEncPubkey, machine,
    });
    if (count > 0) log(`  Shared ${count} local session${count === 1 ? "" : "s"} with your machine.`);
  } catch {
    // Not in a repo, or the index could not be delivered. Credentials still landed.
  }

  log("");
  for (const name of installed) log(`  Sent ${name} login to your machine.`);
  for (const name of skipped) {
    if (name === "github") log("  No GitHub token found — run `gh auth login`, or create a fine-grained PAT scoped to your repo.");
    if (name === "claude") log("  No Claude Code login found on this machine.");
    if (name === "codex") log("  No Codex login found on this machine.");
  }
  log("  Cursor has no portable login — sign in to Cursor on the machine itself.");
  log("");

  return { installed, skipped, pairingId };
}

export { cmdSyncAuth, collectCredentialBundle, publishSessionIndex, authTokenFor, macKeyFor, blobTagFor, generateSecret };
