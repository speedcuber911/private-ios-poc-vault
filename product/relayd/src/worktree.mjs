// relayd worktree.mjs — W2-MODULES: handoff v0 (06-tech-execution §W2).
//
// When RELAYD_WORKTREE_MODE=true and a job's workspace is a git repository,
// the job runs inside `git worktree add` on branch relay/<job-id-prefix>.
// On job success the branch is pushed to the first remote when one exists
// (NEVER force). The worktree is pruned on job cleanup; the branch survives
// so the pushed work stays referenced.
//
// Jail guard: worktrees are created inside the workspace itself
// (<workspace>/.relay/worktrees/<prefix>). Containment is proven BEFORE any
// filesystem mutation — the nearest existing ancestor of the worktree path
// must resolve inside the workspace, and no existing component of the
// .relay/worktrees chain may be a symlink — so a pre-planted symlink cannot
// make relayd mkdir, check out a repo, or create a branch outside the jail.
// The realized worktree is re-verified afterwards as defense in depth.
// Worktree mode can never move a job's cwd outside the jail.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseBooleanEnv, workspaceBrowseRoot, realpathOrResolve } from "./config.mjs";
import { appendAudit } from "./audit.mjs";

const worktreeMode = parseBooleanEnv("RELAYD_WORKTREE_MODE", false);

const gitBin = process.env.RELAYD_GIT_BIN || "git";

// Identity used for the autocommit so `git commit` never fails on a runner
// without global git config. Placeholder identity, no real address.
const gitIdentityArgs = ["-c", "user.name=relayd", "-c", "user.email=relayd@localhost"];

function runGit(cwd, args, { allowFailure = false } = {}) {
  try {
    return {
      ok: true,
      stdout: execFileSync(gitBin, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 }),
    };
  } catch (error) {
    if (!allowFailure) throw error;
    return { ok: false, stdout: "", error: error.stderr?.toString?.() || error.message || String(error) };
  }
}

function insideRoot(target, root) {
  const relative = path.relative(realpathOrResolve(root), realpathOrResolve(target));
  return Boolean(relative !== "" ? !relative.startsWith("..") && !path.isAbsolute(relative) : true);
}

function worktreeBranch(jobId) {
  return `relay/${String(jobId).replace(/[^a-f0-9-]/gi, "").slice(0, 8)}`;
}

// Containment proof for the <workspace>/.relay/worktrees/<prefix> chain,
// evaluated BEFORE any filesystem mutation. Returns null when the chain is
// provably contained, otherwise a short refusal reason.
//
// Workspace contents are agent-writable, so a prior job can pre-plant
// <workspace>/.relay (or .relay/worktrees) as a symlink aimed outside the
// jail. Both `mkdir -p` and `git worktree add` follow such a link, so checking
// containment only after the worktree exists is too late: the directories,
// the checkout and the relay/<prefix> branch have already been created outside
// the jail by then.
function containmentRefusal(worktreeDir, workspaceReal, workspaceRoot) {
  const relative = path.relative(workspaceReal, worktreeDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "worktree path is not under the workspace";
  }

  // Descend the chain until a component is missing; the last component that
  // exists is the nearest existing ancestor of the worktree directory.
  let nearestExisting = workspaceReal;
  let current = workspaceReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break; // this component and everything below it is yet to exist
    // An already-existing component that is a symlink is refused outright:
    // relayd never writes through a link it did not create itself.
    if (stat.isSymbolicLink()) return `${segment} exists and is a symlink`;
    if (!stat.isDirectory()) return `${segment} exists and is not a directory`;
    nearestExisting = current;
  }

  // The nearest EXISTING ancestor is the only path the upcoming mkdir/git can
  // be anchored to, so its realpath must land inside the workspace (and hence
  // inside the browse root). realpath collapses any link the walk missed.
  if (!insideRoot(nearestExisting, workspaceReal) || !insideRoot(nearestExisting, workspaceRoot)) {
    return "nearest existing ancestor resolves outside the jail";
  }
  return null;
}

// Creates each missing component one level at a time. Deliberately NOT
// `mkdirSync(..., {recursive: true})`, which silently traverses symlinked
// components; every level is re-verified after creation so a link swapped in
// mid-walk is caught instead of followed.
function mkdirContained(dir, workspaceReal) {
  let current = workspaceReal;
  for (const segment of path.relative(workspaceReal, dir).split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`refusing to write through ${segment}`);
    }
  }
}

// Core implementation with explicit root/enabled so tests can drive it
// without a live server. Mutates job.worktree = {path, branch} on success.
function prepareWorktree(job, { workspaceRoot = workspaceBrowseRoot, enabled = true } = {}) {
  if (!enabled) return null;
  if (!job || typeof job.id !== "string" || typeof job.workspacePath !== "string") return null;

  const workspaceReal = realpathOrResolve(job.workspacePath);
  // Jail guard #1: the workspace itself must live inside the browse root.
  if (!insideRoot(workspaceReal, workspaceRoot)) {
    appendAudit("worktree_prepare_skipped", job, { reason: "workspace outside jail" });
    return null;
  }
  // Only git repositories get a worktree; everything else runs as before.
  if (!fs.existsSync(path.join(workspaceReal, ".git"))) return null;

  const branch = worktreeBranch(job.id);
  const worktreeDir = path.join(workspaceReal, ".relay", "worktrees", branch.slice("relay/".length));

  // Jail guard #2: prove containment BEFORE the first mutation. Nothing is
  // created — no directory, no checkout, no relay/<prefix> branch — unless the
  // .relay/worktrees chain is known to stay inside the jail.
  const refusal = containmentRefusal(worktreeDir, workspaceReal, workspaceRoot);
  if (refusal) {
    appendAudit("worktree_prepare_skipped", job, { reason: `jail containment: ${refusal}` });
    return null;
  }

  try {
    mkdirContained(path.dirname(worktreeDir), workspaceReal);
    runGit(workspaceReal, ["worktree", "add", "-b", branch, worktreeDir]);
  } catch (error) {
    appendAudit("worktree_prepare_failed", job, { error: error.stderr?.toString?.() || error.message || String(error) });
    return null;
  }

  // Jail guard #3: defense in depth. The realized worktree must still resolve
  // inside the root, catching anything the pre-mutation walk could not see.
  if (!insideRoot(worktreeDir, workspaceRoot)) {
    runGit(workspaceReal, ["worktree", "remove", "--force", worktreeDir], { allowFailure: true });
    appendAudit("worktree_prepare_skipped", job, { reason: "worktree escaped jail" });
    return null;
  }

  job.worktree = { path: worktreeDir, branch };
  return job.worktree;
}

// Push on success (never force), then prune the worktree. Keeps the branch.
function completeWorktree(job) {
  const worktree = job?.worktree;
  if (!worktree) return null;
  const workspaceReal = realpathOrResolve(job.workspacePath);
  const outcome = { branch: worktree.branch, committed: false, pushed: false };

  try {
    if (job.status === "succeeded") {
      const status = runGit(worktree.path, ["status", "--porcelain"], { allowFailure: true });
      if (status.ok && status.stdout.trim()) {
        const commit = runGit(worktree.path, [
          ...gitIdentityArgs,
          "commit",
          "-a",
          "-m",
          `relay: job ${job.id}`,
        ], { allowFailure: true });
        if (!commit.ok) {
          // Untracked files need an explicit add first.
          runGit(worktree.path, ["add", "-A"], { allowFailure: true });
          const retry = runGit(worktree.path, [...gitIdentityArgs, "commit", "-m", `relay: job ${job.id}`], { allowFailure: true });
          outcome.committed = retry.ok;
        } else {
          outcome.committed = true;
        }
      }

      const remotes = runGit(worktree.path, ["remote"], { allowFailure: true });
      const remote = remotes.ok ? remotes.stdout.split("\n").map((line) => line.trim()).filter(Boolean)[0] : null;
      if (remote) {
        // NEVER --force: a rejected push is recorded, not overridden.
        const push = runGit(worktree.path, ["push", remote, worktree.branch], { allowFailure: true });
        outcome.pushed = push.ok;
        if (!push.ok) {
          appendAudit("worktree_push_failed", job, { branch: worktree.branch, error: push.error });
        } else {
          appendAudit("worktree_pushed", job, { branch: worktree.branch, remote });
        }
      }
    }
  } finally {
    const removed = runGit(workspaceReal, ["worktree", "remove", "--force", worktree.path], { allowFailure: true });
    if (!removed.ok) {
      appendAudit("worktree_prune_failed", job, { error: removed.error });
      runGit(workspaceReal, ["worktree", "prune"], { allowFailure: true });
    }
    delete job.worktree;
    job.worktreeBranch = worktree.branch;
    job.worktreePushed = outcome.pushed;
  }
  return outcome;
}

// Hooks used by jobs.mjs — no-ops unless RELAYD_WORKTREE_MODE=true.

function prepareJobWorkdir(job) {
  if (!worktreeMode) return null;
  return prepareWorktree(job, { workspaceRoot: workspaceBrowseRoot, enabled: true });
}

async function completeJobWorktree(job) {
  if (!job?.worktree) return null;
  return completeWorktree(job);
}

export {
  worktreeMode,
  worktreeBranch,
  prepareWorktree,
  completeWorktree,
  prepareJobWorkdir,
  completeJobWorktree,
};
