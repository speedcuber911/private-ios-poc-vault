// relay handoff — the shut-the-laptop moment.
//
// The branch carries the work; two blobs sealed to the node's key carry the
// manifest and the transcript. GitHub therefore stores ciphertext for anything
// conversational, and the control plane is told only names.
//
// The handoff commit is built entirely with plumbing against a throwaway
// index file (GIT_INDEX_FILE) — read-tree, add, hash-object, write-tree,
// commit-tree, update-ref. The user's real working tree, real index, and HEAD
// are never written to, so there is nothing to restore: the checkout the user
// left before running this command is the checkout they are in when it
// returns, because it was never touched in the first place.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

import { createCloudApi, DEFAULT_BASE_URL } from "../cloud.mjs";
import { readCredentials } from "../creds.mjs";
import { requireGitHubRepo, workingTreeSummary, git } from "../repo.mjs";
import { discoverSessions, readSessionBytes, sessionExcerpt } from "../sessions.mjs";
import { sealTo } from "../seal.mjs";

const MAX_SESSION_BYTES = 20 * 1024 * 1024;
const BLOB_PATH_PREFIX = ".relay/handoff";

function flagValue(args, name) {
  const index = args.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (index === -1) return null;
  const arg = args[index];
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1] || null;
}

function handoffBranchName(title, handoffId) {
  const slug = String(title || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40)
    .replace(/-+$/, "");
  return `relay/handoff-${slug || "session"}-${handoffId.slice(0, 6)}`;
}

function buildManifest({ repo, session, wip, excerpt, handoffId, branch, machine, now }) {
  return {
    v: 1,
    id: handoffId,
    harness: session?.harness || "cursor",
    sessionId: session?.id || null,
    sessionFormat: session?.format || "none",
    title: session?.title || `Work on ${repo.fullName}`,
    repo: repo.fullName,
    baseBranch: repo.branch,
    branch,
    cwd: repo.root,
    machine,
    createdAt: now,
    wip,
    excerpt,
  };
}

// Low-level git runner used only for the plumbing sequence below, where we
// need a custom GIT_INDEX_FILE and (for hash-object) the ability to pipe a
// raw Buffer on stdin without it round-tripping through a JS string.
function gitPlumbing(root, args, { env = process.env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git", ["-C", root, ...args],
      { env, maxBuffer: 64 * 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr || "");
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function gitPlumbingText(root, args, opts) {
  return (await gitPlumbing(root, args, opts)).toString("utf8").trim();
}

async function refExistsLocally(root, ref) {
  try {
    await git(root, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

async function refExistsOnRemote(root, branch) {
  try {
    await git(root, ["ls-remote", "--exit-code", "origin", branch]);
    return true;
  } catch {
    return false;
  }
}

async function cmdHandoff(args = [], deps = {}) {
  const {
    home = undefined, cwd = process.cwd(), baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch,
    log = console.log, machine = os.hostname(), now = () => Date.now(),
  } = deps;

  const credentials = readCredentials({ home });
  if (!credentials?.sessionToken) throw new Error("not_logged_in: run relay login first");
  if (!credentials.nodeId || !credentials.nodeEncPubkey) {
    throw new Error("no_machine_pinned: run relay login after creating a machine in the app");
  }

  const repo = await requireGitHubRepo({ cwd });
  const realRoot = fs.realpathSync(repo.root);
  const wip = await workingTreeSummary({ root: repo.root });

  const requestedId = flagValue(args, "--session");
  const sessions = discoverSessions({ cwd: realRoot, home });
  const session = requestedId ? sessions.find((entry) => entry.id === requestedId) || null : sessions[0] || null;
  if (requestedId && !session) throw new Error(`unknown_session: no local session ${requestedId} for this repository`);
  if (!session) log("  No local session found — handing off the working tree with a summary instead.");

  const handoffId = crypto.randomBytes(8).toString("hex");
  const titleOverride = flagValue(args, "--title");
  const title = titleOverride || session?.title || `Work on ${repo.fullName}`;
  const branch = handoffBranchName(title, handoffId);
  const ref = `refs/heads/${branch}`;

  let sessionBytes = session ? readSessionBytes(session, { maxBytes: MAX_SESSION_BYTES }) : null;
  if (session && !sessionBytes) {
    log(`  Session transcript is larger than ${MAX_SESSION_BYTES / 1024 / 1024} MB — sending a summary instead.`);
  }

  const manifest = buildManifest({
    repo: { ...repo, root: realRoot }, session: sessionBytes ? session : null,
    wip, excerpt: session ? sessionExcerpt(session) : "", handoffId, branch, machine, now: now(),
  });
  if (!sessionBytes) { manifest.sessionFormat = "none"; manifest.sessionId = null; }
  manifest.title = title;

  // Structural guard: handoff blobs may only ever be reachable from a
  // relay/handoff-* ref. handoffBranchName always produces one; this makes
  // the invariant provable rather than assumed.
  if (!/^refs\/heads\/relay\/handoff-/.test(ref)) {
    throw new Error("refusing_to_write_blobs_off_handoff_branch");
  }

  // The handoff id is random and appended to the branch name, so a collision
  // is not expected — these are a defensive check, not a retry loop. Failing
  // loudly here is safer than silently overwriting or force-pushing a ref.
  if (await refExistsLocally(repo.root, ref)) {
    throw new Error(`branch_collision: ${branch} already exists locally`);
  }
  const willPush = !args.includes("--no-push");
  if (willPush && await refExistsOnRemote(repo.root, branch)) {
    throw new Error(`branch_collision: ${branch} already exists on origin`);
  }

  const tmpIndex = path.join(os.tmpdir(), `relay-handoff-index-${crypto.randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  let pushed = false;

  try {
    // Seed a throwaway index from HEAD, then stage the working tree onto it —
    // tracked modifications, deletions, and (.gitignore-respecting) untracked
    // files — without writing anything to the user's real .git/index.
    await gitPlumbing(repo.root, ["read-tree", "HEAD"], { env });
    await gitPlumbing(repo.root, ["add", "-A"], { env });

    const manifestSha = await gitPlumbingText(repo.root, ["hash-object", "-w", "--stdin"], {
      env, input: sealTo(credentials.nodeEncPubkey, Buffer.from(JSON.stringify(manifest), "utf8")),
    });
    await gitPlumbing(repo.root, ["update-index", "--add", "--cacheinfo",
      `100644,${manifestSha},${BLOB_PATH_PREFIX}/${handoffId}/manifest.enc`], { env });

    if (sessionBytes) {
      const sessionSha = await gitPlumbingText(repo.root, ["hash-object", "-w", "--stdin"], {
        env, input: sealTo(credentials.nodeEncPubkey, sessionBytes),
      });
      await gitPlumbing(repo.root, ["update-index", "--add", "--cacheinfo",
        `100644,${sessionSha},${BLOB_PATH_PREFIX}/${handoffId}/session.enc`], { env });
    }

    const treeSha = await gitPlumbingText(repo.root, ["write-tree"], { env });

    let commitSha;
    try {
      commitSha = await gitPlumbingText(repo.root,
        ["commit-tree", treeSha, "-p", "HEAD", "-m", `relay: handoff ${handoffId}`], { env });
    } catch (err) {
      const detail = `${err.stderr || ""} ${err.message || ""}`;
      if (/please tell me who you are|empty ident|unable to auto-detect email/i.test(detail)) {
        throw new Error("no_git_identity: set git user.name and user.email to hand off");
      }
      throw err;
    }

    await git(repo.root, ["update-ref", ref, commitSha]);

    if (!willPush) {
      log(`  Prepared ${branch} locally. Nothing was pushed and no notification was sent.`);
    } else {
      await git(repo.root, ["push", "-q", "origin", `${ref}:${ref}`]);
      pushed = true;
    }
  } finally {
    fs.rmSync(tmpIndex, { force: true });
  }

  if (!pushed) return { handoffId, branch, pushed: false };

  const api = createCloudApi({ baseUrl, sessionToken: credentials.sessionToken, fetchImpl });
  const ping = await api.createHandoff({ handoffId, repo: repo.fullName, branch, nodeId: credentials.nodeId });
  if (ping.status !== 201) {
    log(`  Pushed ${branch}, but the notification failed (${ping.json?.error || ping.status}).`);
    log("  Your machine will still pick it up on its next poll.");
    return { handoffId, branch, pushed: true };
  }

  // Keep the phone's "On your Mac" list current. Best-effort by design: the
  // handoff has already succeeded and must not be reported as failed here.
  try {
    const { publishSessionIndex } = await import("./syncauth.mjs");
    await publishSessionIndex({
      repoFullName: repo.fullName, root: realRoot, home: home || os.homedir(),
      api, nodeEncPubkey: credentials.nodeEncPubkey, machine,
    });
  } catch {
    // The index stays as it was; nothing about the handoff changes.
  }

  log("");
  log(`  Handed off: ${title}`);
  log(`  Branch:     ${branch}`);
  log(`  Machine:    ${credentials.nodeId}`);
  log("");
  log("  Check your phone — it should be there in a moment.");
  return { handoffId, branch, pushed: true };
}

export { cmdHandoff, buildManifest, handoffBranchName };
