// Persistent managed worktree API for Relay (/v1/codex/worktrees).
//
// Security invariants:
// - Every requested path / projectPath is validated with resolveBrowsePath(..., { kind: "dir" })
//   and stays strictly inside workspaceBrowseRoot.
// - Managed worktrees are created only under <mainRepoRoot>/.relay/worktrees/<slug>,
//   with the exact pre-mutation symlink containment proof used in worktree.mjs
//   (verify nearest existing ancestor is inside repoRoot and no component of
//   .relay/worktrees is a symlink, create parents one level at a time, and
//   re-verify realpath after creation).
// - Deletion refuses the main checkout and refuses anything outside
//   <mainRepoRoot>/.relay/worktrees/. Dirty worktrees return 409 unless force: true.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { pathWithinRoot, realpathOrResolve, workspaceBrowseRoot } from "./config.mjs";
import { cleanApiText } from "./util.mjs";
import { resolvedPathWithinRoot } from "./workspaces.mjs";
import {
  assertJsonObject,
  assertNotTimedOut,
  findGitRoot,
  hasGitHead,
  httpError,
  refExists,
  requireGitRoot,
  resolveTargetDir,
  runGit,
  summarizeWorkingTreeStats,
  validateBranchName,
} from "./git-api.mjs";

const WORKTREE_CMD_TIMEOUT_MS = 60_000;

function insideRoot(target, root) {
  return pathWithinRoot(realpathOrResolve(target), realpathOrResolve(root));
}

// Containment proof for the <repoReal>/.relay/worktrees/<slug> chain, evaluated
// BEFORE any filesystem mutation. Mirrors worktree.mjs's containmentRefusal:
// returns null when the chain is provably contained, otherwise a refusal reason.
function containmentRefusal(worktreeDir, repoReal, workspaceRoot = workspaceBrowseRoot) {
  const relative = path.relative(repoReal, worktreeDir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    return "worktree path is not under the repository";
  }

  let nearestExisting = repoReal;
  let current = repoReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink()) return `${segment} exists and is a symlink`;
    if (!stat.isDirectory()) return `${segment} exists and is not a directory`;
    nearestExisting = current;
  }

  if (!insideRoot(nearestExisting, repoReal) || !insideRoot(nearestExisting, workspaceRoot)) {
    return "nearest existing ancestor resolves outside the jail";
  }
  return null;
}

// Creates each missing component one level at a time (never mkdir recursive),
// re-verifying with lstat after every step so a swapped symlink is never followed.
function mkdirContained(dir, repoReal) {
  const relative = path.relative(repoReal, dir);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw httpError(400, "worktree parent is outside the repository");
  }
  let current = repoReal;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
      throw httpError(400, `refusing to write through ${segment}`);
    }
  }
}

// Add `.relay/worktrees/` to the repo's local `.git/info/exclude` (never touches
// tracked `.gitignore`) so persistent worktrees do not mark the main checkout dirty.
function ensureRelayWorktreesExcluded(mainRepoRoot) {
  try {
    const gitDir = path.join(mainRepoRoot, ".git");
    const gitStat = fs.lstatSync(gitDir, { throwIfNoEntry: false });
    if (!gitStat || gitStat.isSymbolicLink() || !gitStat.isDirectory()) return;

    const infoDir = path.join(gitDir, "info");
    const infoStat = fs.lstatSync(infoDir, { throwIfNoEntry: false });
    if (!infoStat) {
      fs.mkdirSync(infoDir);
    } else if (infoStat.isSymbolicLink() || !infoStat.isDirectory()) {
      return;
    }

    const excludePath = path.join(infoDir, "exclude");
    const excludeStat = fs.lstatSync(excludePath, { throwIfNoEntry: false });
    if (excludeStat && (excludeStat.isSymbolicLink() || !excludeStat.isFile())) return;

    const existing = excludeStat ? fs.readFileSync(excludePath, "utf8") : "";
    const lines = existing.split(/\r?\n/).map((line) => line.trim());
    if (lines.includes(".relay/worktrees/") || lines.includes(".relay/worktrees") || lines.includes(".relay/") || lines.includes(".relay")) {
      return;
    }
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.appendFileSync(excludePath, `${prefix}.relay/worktrees/\n`, "utf8");
  } catch {
    // Best-effort only; never fail worktree creation on a read-only exclude file.
  }
}

function parseWorktreeListPorcelain(stdout) {
  const entries = [];
  let current = null;

  const finish = () => {
    if (current && current.worktree) {
      entries.push(current);
    }
    current = null;
  };

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line === "") {
      finish();
      continue;
    }
    if (line.startsWith("worktree ")) {
      finish();
      current = {
        worktree: line.slice("worktree ".length),
        head: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length).trim() || null;
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref || null;
    } else if (line === "detached") {
      current.detached = true;
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "locked" || line.startsWith("locked ")) {
      current.locked = true;
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  finish();
  return entries;
}

function realDirOrNull(candidate) {
  try {
    const real = fs.realpathSync(candidate);
    const stat = fs.statSync(real);
    return stat.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

// Returns true ONLY when `wtReal` is a real directory inside
// `<mainRepoRoot>/.relay/worktrees/` and neither `.relay`, `worktrees`, nor
// the worktree directory itself is a symlink.
function isManagedWorktreePath(wtReal, mainRepoRoot) {
  if (!mainRepoRoot || !wtReal || wtReal === mainRepoRoot) return false;
  const relayDir = path.join(mainRepoRoot, ".relay");
  const relayStat = fs.lstatSync(relayDir, { throwIfNoEntry: false });
  if (!relayStat || relayStat.isSymbolicLink() || !relayStat.isDirectory()) return false;

  const worktreesDir = path.join(relayDir, "worktrees");
  const wtDirStat = fs.lstatSync(worktreesDir, { throwIfNoEntry: false });
  if (!wtDirStat || wtDirStat.isSymbolicLink() || !wtDirStat.isDirectory()) return false;

  let managedRoot;
  try {
    managedRoot = fs.realpathSync(worktreesDir);
  } catch {
    return false;
  }
  if (!pathWithinRoot(managedRoot, mainRepoRoot) || !resolvedPathWithinRoot(managedRoot)) return false;

  const rel = path.relative(managedRoot, wtReal);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return false;
  }

  const targetLstat = fs.lstatSync(path.join(managedRoot, rel), { throwIfNoEntry: false });
  if (!targetLstat || targetLstat.isSymbolicLink() || !targetLstat.isDirectory()) return false;

  return true;
}

async function readWorktreeList(repoRoot) {
  const res = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  assertNotTimedOut(res);
  if (!res.ok) {
    const detail = cleanApiText(res.stderr || res.stdout || "git worktree list failed").trim();
    throw httpError(400, detail || "git worktree list failed");
  }
  const entries = parseWorktreeListPorcelain(res.stdout);
  const mainEntry = entries[0] || null;
  const mainReal = mainEntry ? realDirOrNull(mainEntry.worktree) : null;
  const mainRepoRoot = mainReal && resolvedPathWithinRoot(mainReal) ? mainReal : null;
  return { entries, mainRepoRoot };
}

function slugifyWorktreeName(value) {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/--+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 64);
  if (!slug || slug === "." || slug === "..") return null;
  return slug;
}

async function resolveUniqueBranchName(repoRoot, desiredBranch) {
  if (!(await refExists(repoRoot, `refs/heads/${desiredBranch}`))) {
    return desiredBranch;
  }
  for (let suffix = 2; suffix <= 99; suffix++) {
    const candidate = `${desiredBranch}-${suffix}`;
    if (!(await refExists(repoRoot, `refs/heads/${candidate}`))) {
      return candidate;
    }
  }
  for (let attempt = 0; attempt < 16; attempt++) {
    const candidate = `${desiredBranch}-${crypto.randomBytes(3).toString("hex")}`;
    if (!(await refExists(repoRoot, `refs/heads/${candidate}`))) {
      return candidate;
    }
  }
  throw httpError(409, "could not allocate a unique branch name");
}

function resolveContainedWorktreeTarget(mainRepoRoot, baseSlug) {
  const managedBase = path.join(mainRepoRoot, ".relay", "worktrees");

  // First check the base slug itself so a pre-planted symlink on `.relay`,
  // `.relay/worktrees`, OR `.relay/worktrees/<baseSlug>` is refused immediately.
  const initialDir = path.join(managedBase, baseSlug);
  const initialRefusal = containmentRefusal(initialDir, mainRepoRoot, workspaceBrowseRoot);
  if (initialRefusal) {
    throw httpError(400, `jail containment: ${initialRefusal}`);
  }

  if (!fs.lstatSync(initialDir, { throwIfNoEntry: false })) {
    return { slug: baseSlug, worktreeDir: initialDir };
  }

  for (let suffix = 2; suffix <= 99; suffix++) {
    const slug = `${baseSlug}-${suffix}`;
    const candidateDir = path.join(managedBase, slug);
    const refusal = containmentRefusal(candidateDir, mainRepoRoot, workspaceBrowseRoot);
    if (refusal) {
      throw httpError(400, `jail containment: ${refusal}`);
    }
    if (!fs.lstatSync(candidateDir, { throwIfNoEntry: false })) {
      return { slug, worktreeDir: candidateDir };
    }
  }

  const fallbackSlug = `${baseSlug}-${crypto.randomBytes(3).toString("hex")}`;
  const fallbackDir = path.join(managedBase, fallbackSlug);
  const refusal = containmentRefusal(fallbackDir, mainRepoRoot, workspaceBrowseRoot);
  if (refusal) {
    throw httpError(400, `jail containment: ${refusal}`);
  }
  if (fs.lstatSync(fallbackDir, { throwIfNoEntry: false })) {
    throw httpError(409, "worktree directory already exists");
  }
  return { slug: fallbackSlug, worktreeDir: fallbackDir };
}

async function resolveBaseCommitRef(mainRepoRoot, rawBaseBranch) {
  if (rawBaseBranch === undefined || rawBaseBranch === null || rawBaseBranch === "") {
    return "HEAD";
  }
  if (typeof rawBaseBranch !== "string" || !rawBaseBranch.trim()) {
    throw httpError(400, "baseBranch must be a non-empty string");
  }
  const base = rawBaseBranch.trim();
  if (/[\0\r\n]/.test(base) || base.startsWith("-")) {
    throw httpError(400, "invalid baseBranch");
  }
  if (await refExists(mainRepoRoot, `refs/heads/${base}`)) {
    return `refs/heads/${base}`;
  }
  if (await refExists(mainRepoRoot, `refs/remotes/origin/${base}`)) {
    return `refs/remotes/origin/${base}`;
  }
  const verify = await runGit(mainRepoRoot, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  assertNotTimedOut(verify);
  if (verify.ok && verify.stdout.trim()) {
    return verify.stdout.trim();
  }
  throw httpError(400, `baseBranch not found: ${base}`);
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

// GET /v1/codex/worktrees?path=<abs-dir>
async function listWorktrees(searchParams) {
  const targetDir = resolveTargetDir(searchParams.get("path"), "path");
  const repoRoot = findGitRoot(targetDir);
  if (!repoRoot) {
    return { repoRoot: null, worktrees: [] };
  }

  const { entries, mainRepoRoot } = await readWorktreeList(repoRoot);
  const visible = [];

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.bare) continue;
    const wtReal = realDirOrNull(entry.worktree);
    if (!wtReal || !resolvedPathWithinRoot(wtReal)) continue;
    const isMain = index === 0;
    const isManaged = !isMain && Boolean(mainRepoRoot) && isManagedWorktreePath(wtReal, mainRepoRoot);
    visible.push({
      path: wtReal,
      name: path.basename(wtReal),
      head: entry.head,
      branch: entry.branch,
      isMain,
      isManaged,
    });
  }

  const enriched = await Promise.all(
    visible.map(async (wt) => {
      const stats = await summarizeWorkingTreeStats(wt.path);
      return {
        ...wt,
        dirty: stats.dirty,
        added: stats.added,
        deleted: stats.deleted,
      };
    }),
  );

  return {
    repoRoot: mainRepoRoot,
    worktrees: enriched,
  };
}

// POST /v1/codex/worktrees
// Body: { projectPath, name?, branch?, baseBranch?, action?: "branch-off"|"checkout" }
async function createWorktree(body) {
  assertJsonObject(body);
  const rawProjectPath = body.projectPath !== undefined ? body.projectPath : body.path;
  const repoRoot = requireGitRoot(rawProjectPath, "projectPath");

  const { entries, mainRepoRoot } = await readWorktreeList(repoRoot);
  if (!mainRepoRoot) {
    throw httpError(400, "repository root must stay inside the workspace root");
  }

  const hasHead = await hasGitHead(mainRepoRoot);
  if (!hasHead) {
    throw httpError(400, "repository has no commits yet");
  }

  const action = body.action === undefined || body.action === null || body.action === ""
    ? "branch-off"
    : String(body.action).trim().toLowerCase();
  if (action !== "branch-off" && action !== "checkout") {
    throw httpError(400, "action must be branch-off or checkout");
  }

  let requestedSlug = null;
  if (body.name !== undefined && body.name !== null && body.name !== "") {
    if (typeof body.name !== "string") {
      throw httpError(400, "name must be a string");
    }
    requestedSlug = slugifyWorktreeName(body.name);
    if (!requestedSlug) {
      throw httpError(400, "name is invalid");
    }
  }

  let finalBranch;
  let gitArgs;
  let baseSlug;

  if (action === "checkout") {
    finalBranch = await validateBranchName(mainRepoRoot, body.branch, "branch");
    const isLocal = await refExists(mainRepoRoot, `refs/heads/${finalBranch}`);
    const isRemoteOrigin = !isLocal && (await refExists(mainRepoRoot, `refs/remotes/origin/${finalBranch}`));
    if (!isLocal && !isRemoteOrigin) {
      throw httpError(404, `branch not found: ${finalBranch}`);
    }

    const alreadyCheckedOut = entries.some((entry) => !entry.bare && entry.branch === finalBranch);
    if (alreadyCheckedOut) {
      throw httpError(409, `branch ${finalBranch} is already checked out in another worktree`);
    }

    baseSlug = requestedSlug || slugifyWorktreeName(finalBranch) || `wt-${crypto.randomBytes(4).toString("hex")}`;
    const target = resolveContainedWorktreeTarget(mainRepoRoot, baseSlug);
    gitArgs = isLocal
      ? ["worktree", "add", target.worktreeDir, finalBranch]
      : ["worktree", "add", "--track", "-b", finalBranch, target.worktreeDir, `refs/remotes/origin/${finalBranch}`];

    return await executeWorktreeCreation(mainRepoRoot, target, finalBranch, gitArgs);
  }

  // action === "branch-off"
  let desiredBranch;
  if (body.branch !== undefined && body.branch !== null && body.branch !== "") {
    desiredBranch = await validateBranchName(mainRepoRoot, body.branch, "branch");
  } else if (requestedSlug) {
    desiredBranch = await validateBranchName(mainRepoRoot, requestedSlug, "name");
  } else {
    desiredBranch = `wt-${crypto.randomBytes(4).toString("hex")}`;
  }

  const baseRef = await resolveBaseCommitRef(mainRepoRoot, body.baseBranch);
  finalBranch = await resolveUniqueBranchName(mainRepoRoot, desiredBranch);
  baseSlug = requestedSlug || slugifyWorktreeName(finalBranch) || `wt-${crypto.randomBytes(4).toString("hex")}`;

  // Pre-mutation containment check MUST run before touching disk or creating
  // any branch/worktree so a pre-planted symlink never causes any mutation.
  const target = resolveContainedWorktreeTarget(mainRepoRoot, baseSlug);
  gitArgs = ["worktree", "add", "-b", finalBranch, target.worktreeDir, baseRef];

  return await executeWorktreeCreation(mainRepoRoot, target, finalBranch, gitArgs);
}

async function executeWorktreeCreation(mainRepoRoot, { slug, worktreeDir }, branch, gitArgs) {
  // Defense in depth: re-check containment immediately before mkdir + git worktree add.
  const refusal = containmentRefusal(worktreeDir, mainRepoRoot, workspaceBrowseRoot);
  if (refusal) {
    throw httpError(400, `jail containment: ${refusal}`);
  }

  mkdirContained(path.dirname(worktreeDir), mainRepoRoot);
  ensureRelayWorktreesExcluded(mainRepoRoot);

  const addRes = await runGit(mainRepoRoot, gitArgs, { timeoutMs: WORKTREE_CMD_TIMEOUT_MS });
  assertNotTimedOut(addRes);
  if (!addRes.ok) {
    const detail = cleanApiText(addRes.stderr || addRes.stdout || "git worktree add failed").trim();
    if (/already checked out|already exists/i.test(detail)) {
      throw httpError(409, detail);
    }
    throw httpError(400, detail || "git worktree add failed");
  }

  // Post-creation realpath containment re-verification (defense in depth).
  let realWorktree;
  try {
    realWorktree = fs.realpathSync(worktreeDir);
  } catch {
    realWorktree = null;
  }
  if (
    !realWorktree ||
    !pathWithinRoot(realWorktree, mainRepoRoot) ||
    !resolvedPathWithinRoot(realWorktree) ||
    !isManagedWorktreePath(realWorktree, mainRepoRoot)
  ) {
    await runGit(mainRepoRoot, ["worktree", "remove", "--force", worktreeDir], {
      timeoutMs: WORKTREE_CMD_TIMEOUT_MS,
    });
    await runGit(mainRepoRoot, ["worktree", "prune"]);
    throw httpError(400, "worktree escaped repository containment");
  }

  return {
    worktree: {
      path: realWorktree,
      name: slug,
      branch,
      isMain: false,
      isManaged: true,
    },
  };
}

// DELETE /v1/codex/worktrees  &  POST /v1/codex/worktrees/remove
// Body: { path, force?: boolean } (query params also accepted as fallback for DELETE)
async function removeWorktree(body, searchParams = null) {
  if (body !== undefined && body !== null && (typeof body !== "object" || Array.isArray(body))) {
    throw httpError(400, "request body must be a JSON object");
  }
  const rawPath = body?.path !== undefined ? body.path : searchParams?.get("path");
  const targetPath = resolveTargetDir(rawPath, "path");

  if (body?.force !== undefined && typeof body.force !== "boolean") {
    throw httpError(400, "force must be a boolean");
  }
  const force =
    body?.force === true ||
    (body?.force === undefined && ["1", "true", "yes"].includes(String(searchParams?.get("force") || "").toLowerCase()));

  const gitRoot = findGitRoot(targetPath);
  if (!gitRoot) {
    throw httpError(403, "cannot remove non-managed directory");
  }

  const { entries, mainRepoRoot } = await readWorktreeList(gitRoot);
  if (!mainRepoRoot) {
    throw httpError(403, "repository root is outside the workspace root");
  }

  // Refuse main checkout explicitly.
  if (targetPath === mainRepoRoot) {
    throw httpError(403, "cannot remove the main checkout");
  }

  // Must be a registered non-main git worktree AND strictly inside <mainRepoRoot>/.relay/worktrees/.
  const matched = entries.find((entry, idx) => idx > 0 && !entry.bare && realDirOrNull(entry.worktree) === targetPath);
  if (!matched || !isManagedWorktreePath(targetPath, mainRepoRoot)) {
    throw httpError(403, "cannot remove non-managed worktree outside .relay/worktrees");
  }

  if (!force) {
    const statusRes = await runGit(targetPath, ["status", "--porcelain=v1", "--untracked-files=all"]);
    assertNotTimedOut(statusRes);
    if (!statusRes.ok || statusRes.stdout.trim().length > 0) {
      throw httpError(409, "worktree has uncommitted changes");
    }
  }

  const removeArgs = force
    ? ["worktree", "remove", "--force", targetPath]
    : ["worktree", "remove", targetPath];
  const removeRes = await runGit(mainRepoRoot, removeArgs, { timeoutMs: WORKTREE_CMD_TIMEOUT_MS });
  assertNotTimedOut(removeRes);
  if (!removeRes.ok) {
    const detail = cleanApiText(removeRes.stderr || removeRes.stdout || "git worktree remove failed").trim();
    if (/contains modified or untracked files|dirty/i.test(detail)) {
      throw httpError(409, detail);
    }
    throw httpError(400, detail || "git worktree remove failed");
  }

  const pruneRes = await runGit(mainRepoRoot, ["worktree", "prune"]);
  assertNotTimedOut(pruneRes);

  return { ok: true, removed: targetPath };
}

export {
  containmentRefusal,
  mkdirContained,
  parseWorktreeListPorcelain,
  isManagedWorktreePath,
  listWorktrees,
  createWorktree,
  removeWorktree,
};
