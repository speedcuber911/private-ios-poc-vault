// Tests for Persistent Worktree Management API (/v1/codex/worktrees).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relayd-worktree-api-")));
const browse = path.join(tmp, "workspaces");
const outside = path.join(tmp, "outside");
const plain = path.join(browse, "plain");
const seedRepo = path.join(browse, "seed");
fs.mkdirSync(browse, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.mkdirSync(plain, { recursive: true });
fs.mkdirSync(seedRepo, { recursive: true });
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });

process.env.CODEX_DATA_DIR = path.join(tmp, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = browse;
process.env.CODEX_REQUIRE_MTLS = "false";
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "seed", name: "Seed", path: seedRepo }]);

const { routeRequest } = await import("../src/server.mjs");
const { sendError } = await import("../src/util.mjs");

let server;
let baseUrl;

function startHttpServer() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      routeRequest(req, res).catch((error) => {
        const status = Number.isInteger(error?.status) ? error.status : 500;
        sendError(res, status, error?.message || "internal error");
      });
    });
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      resolve({ server: s, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function api(method, urlPath, body) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${urlPath}`, init);
  const json = await res.json();
  return { status: res.status, json };
}

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Dev",
      GIT_AUTHOR_EMAIL: "dev@example.com",
      GIT_COMMITTER_NAME: "Test Dev",
      GIT_COMMITTER_EMAIL: "dev@example.com",
    },
  }).trim();
}

function makeRepo(name) {
  const dir = path.join(browse, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
  return dir;
}

test.before(async () => {
  const started = await startHttpServer();
  server = started.server;
  baseUrl = started.baseUrl;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("list worktrees handles non-git dirs, filters out-of-jail worktrees, and enriches managed/dirty stats", async () => {
  const nonGit = await api("GET", `/v1/codex/worktrees?path=${encodeURIComponent(plain)}`);
  assert.equal(nonGit.status, 200);
  assert.deepEqual(nonGit.json, { repoRoot: null, worktrees: [] });

  const repo = makeRepo("list-repo");
  // Manually add a non-managed worktree INSIDE the jail and one OUTSIDE the jail.
  const externalInJail = path.join(browse, "manual-wt");
  const externalOutOfJail = path.join(outside, "escaped-wt");
  git(repo, "worktree", "add", "-b", "manual-in", externalInJail);
  git(repo, "worktree", "add", "-b", "manual-out", externalOutOfJail);

  // Create a managed worktree via the API.
  const created = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo,
    name: "feature-one",
    branch: "feat/one",
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, {
    worktree: {
      path: path.join(repo, ".relay", "worktrees", "feature-one"),
      name: "feature-one",
      branch: "feat/one",
      isMain: false,
      isManaged: true,
    },
  });

  // Make managed worktree dirty with normal file + read-denied .env file.
  fs.writeFileSync(path.join(created.json.worktree.path, "README.md"), "# demo\nline two\nline three\n");
  fs.writeFileSync(path.join(created.json.worktree.path, ".env"), "SECRET=1\nSECRET2=2\n");

  const listed = await api("GET", `/v1/codex/worktrees?path=${encodeURIComponent(repo)}`);
  assert.equal(listed.status, 200);
  assert.equal(listed.json.repoRoot, repo);

  const byPath = new Map(listed.json.worktrees.map((wt) => [wt.path, wt]));
  assert.equal(byPath.has(externalOutOfJail), false, "worktree outside browse root must be filtered out");
  assert.equal(byPath.has(repo), true);
  assert.equal(byPath.has(externalInJail), true);
  assert.equal(byPath.has(created.json.worktree.path), true);

  const mainWt = byPath.get(repo);
  assert.equal(mainWt.isMain, true);
  assert.equal(mainWt.isManaged, false);
  assert.equal(mainWt.branch, "main");
  assert.equal(mainWt.dirty, false);

  const manualWt = byPath.get(externalInJail);
  assert.equal(manualWt.isMain, false);
  assert.equal(manualWt.isManaged, false);
  assert.equal(manualWt.branch, "manual-in");

  const managedWt = byPath.get(created.json.worktree.path);
  assert.equal(managedWt.isMain, false);
  assert.equal(managedWt.isManaged, true);
  assert.equal(managedWt.branch, "feat/one");
  assert.equal(managedWt.dirty, true);
  assert.equal(managedWt.added, 2); // .env lines NOT counted
  assert.equal(managedWt.deleted, 0);
});

test("POST /worktrees supports branch-off uniqueness, baseBranch, checkout existing branch, and linked-wt projectPath", async () => {
  const repo = makeRepo("create-repo");
  const mainSha = git(repo, "rev-parse", "HEAD");

  // Create another branch with an extra commit, then return to main.
  git(repo, "checkout", "-b", "release-base");
  fs.writeFileSync(path.join(repo, "release.txt"), "v1\n");
  git(repo, "add", "release.txt");
  git(repo, "commit", "-m", "release commit");
  const releaseSha = git(repo, "rev-parse", "HEAD");
  git(repo, "checkout", "main");

  // Create an existing branch to test action=checkout.
  git(repo, "branch", "existing-topic");

  // 1) Branch off release-base explicitly.
  const wt1 = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo,
    branch: "topic",
    baseBranch: "release-base",
    action: "branch-off",
  });
  assert.equal(wt1.status, 201);
  assert.equal(wt1.json.worktree.branch, "topic");
  assert.equal(git(wt1.json.worktree.path, "rev-parse", "HEAD"), releaseSha);

  // 2) Branch off with same desired branch allocates unique branch name & slug.
  const wt2 = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo,
    branch: "topic",
  });
  assert.equal(wt2.status, 201);
  assert.equal(wt2.json.worktree.branch, "topic-2");
  assert.equal(wt2.json.worktree.name, "topic-2");
  assert.equal(git(wt2.json.worktree.path, "rev-parse", "HEAD"), mainSha);

  // 3) Action=checkout checks out existing-topic cleanly.
  const wt3 = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo,
    branch: "existing-topic",
    action: "checkout",
  });
  assert.equal(wt3.status, 201);
  assert.equal(wt3.json.worktree.branch, "existing-topic");
  assert.equal(wt3.json.worktree.isManaged, true);

  // Checking out a branch already checked out returns 409.
  const dupCheckout = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo,
    branch: "existing-topic",
    action: "checkout",
  });
  assert.equal(dupCheckout.status, 409);

  // Checking out a nonexistent branch returns 404.
  const missingBranch = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo,
    branch: "does-not-exist",
    action: "checkout",
  });
  assert.equal(missingBranch.status, 404);

  // 4) Passing a linked worktree as projectPath still places new worktree under mainRepoRoot/.relay/worktrees/.
  const wtFromLinked = await api("POST", "/v1/codex/worktrees", {
    projectPath: wt1.json.worktree.path,
    name: "from-linked",
  });
  assert.equal(wtFromLinked.status, 201);
  assert.equal(wtFromLinked.json.worktree.path, path.join(repo, ".relay", "worktrees", "from-linked"));
});

test("pre-mutation symlink containment proof blocks .relay, .relay/worktrees, and slug symlink escapes with zero mutations", async () => {
  // 1) Pre-planted .relay symlink
  const repo1 = makeRepo("sym-relay");
  const trap1 = fs.mkdtempSync(path.join(outside, "trap-relay-"));
  fs.symlinkSync(trap1, path.join(repo1, ".relay"), "dir");

  const res1 = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo1,
    name: "escape1",
    branch: "escape-branch-1",
  });
  assert.equal(res1.status, 400);
  assert.deepEqual(fs.readdirSync(trap1), [], "nothing may be written outside the jail");
  assert.equal(git(repo1, "branch", "--list", "escape-branch-1"), "", "no branch may be created on refusal");

  // 2) Pre-planted .relay/worktrees symlink
  const repo2 = makeRepo("sym-worktrees");
  const trap2 = fs.mkdtempSync(path.join(outside, "trap-wt-"));
  fs.mkdirSync(path.join(repo2, ".relay"));
  fs.symlinkSync(trap2, path.join(repo2, ".relay", "worktrees"), "dir");

  const res2 = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo2,
    name: "escape2",
    branch: "escape-branch-2",
  });
  assert.equal(res2.status, 400);
  assert.deepEqual(fs.readdirSync(trap2), [], "nothing may be written outside the jail");
  assert.equal(git(repo2, "branch", "--list", "escape-branch-2"), "", "no branch may be created on refusal");

  // 3) Pre-planted .relay/worktrees/<slug> symlink
  const repo3 = makeRepo("sym-slug");
  const trap3 = fs.mkdtempSync(path.join(outside, "trap-slug-"));
  fs.mkdirSync(path.join(repo3, ".relay", "worktrees"), { recursive: true });
  fs.symlinkSync(trap3, path.join(repo3, ".relay", "worktrees", "escape3"), "dir");

  const res3 = await api("POST", "/v1/codex/worktrees", {
    projectPath: repo3,
    name: "escape3",
    branch: "escape-branch-3",
  });
  assert.equal(res3.status, 400);
  assert.deepEqual(fs.readdirSync(trap3), [], "nothing may be written outside the jail");
  assert.equal(git(repo3, "branch", "--list", "escape-branch-3"), "", "no branch may be created on refusal");

  // 4) projectPath outside browse root refused
  const outsideRepo = path.join(outside, "outside-repo");
  fs.mkdirSync(outsideRepo, { recursive: true });
  git(outsideRepo, "-c", "init.defaultBranch=main", "init");
  const res4 = await api("POST", "/v1/codex/worktrees", { projectPath: outsideRepo });
  assert.equal(res4.status, 400);
});

test("DELETE /worktrees and POST /worktrees/remove enforce managed-only boundary and dirty 409 check", async () => {
  const repo = makeRepo("delete-repo");

  // Create two managed worktrees + one non-managed worktree + one plain dir inside .relay/worktrees.
  const wtClean = (
    await api("POST", "/v1/codex/worktrees", { projectPath: repo, name: "clean-wt" })
  ).json.worktree;
  const wtDirty = (
    await api("POST", "/v1/codex/worktrees", { projectPath: repo, name: "dirty-wt" })
  ).json.worktree;
  const nonManagedWt = path.join(browse, "non-managed-delete-wt");
  git(repo, "worktree", "add", "-b", "non-managed-del", nonManagedWt);

  const plainUnderManaged = path.join(repo, ".relay", "worktrees", "plain-dir");
  fs.mkdirSync(plainUnderManaged, { recursive: true });
  const subDirInWt = path.join(wtClean.path, "nested");
  fs.mkdirSync(subDirInWt, { recursive: true });

  // 1) Refuses main checkout (403)
  const delMain = await api("DELETE", "/v1/codex/worktrees", { path: repo, force: true });
  assert.equal(delMain.status, 403);
  assert.equal(fs.existsSync(repo), true);

  // 2) Refuses non-managed worktree outside .relay/worktrees (403)
  const delNonManaged = await api("DELETE", "/v1/codex/worktrees", { path: nonManagedWt, force: true });
  assert.equal(delNonManaged.status, 403);
  assert.equal(fs.existsSync(nonManagedWt), true);

  // 3) Refuses plain unregistered directory inside .relay/worktrees (403)
  const delPlain = await api("DELETE", "/v1/codex/worktrees", { path: plainUnderManaged, force: true });
  assert.equal(delPlain.status, 403);
  assert.equal(fs.existsSync(plainUnderManaged), true);

  // 4) Refuses subdirectory inside managed worktree (403)
  const delSub = await api("DELETE", "/v1/codex/worktrees", { path: subDirInWt, force: true });
  assert.equal(delSub.status, 403);
  assert.equal(fs.existsSync(subDirInWt), true);

  // 5) Refuses path outside browse root (400)
  const delOut = await api("DELETE", "/v1/codex/worktrees", { path: outside, force: true });
  assert.equal(delOut.status, 400);

  // 6) Clean managed worktree removed via DELETE /v1/codex/worktrees
  fs.rmdirSync(subDirInWt);
  const removedClean = await api("DELETE", "/v1/codex/worktrees", { path: wtClean.path });
  assert.equal(removedClean.status, 200);
  assert.deepEqual(removedClean.json, { ok: true, removed: wtClean.path });
  assert.equal(fs.existsSync(wtClean.path), false);

  // 7) Dirty managed worktree refused with 409 unless force: true
  fs.writeFileSync(path.join(wtDirty.path, "uncommitted.txt"), "dirty\n");
  const blockedDirty = await api("POST", "/v1/codex/worktrees/remove", { path: wtDirty.path });
  assert.equal(blockedDirty.status, 409);
  assert.equal(fs.existsSync(wtDirty.path), true);

  // 8) Force removal via POST /v1/codex/worktrees/remove succeeds
  const forcedDirty = await api("POST", "/v1/codex/worktrees/remove", { path: wtDirty.path, force: true });
  assert.equal(forcedDirty.status, 200);
  assert.deepEqual(forcedDirty.json, { ok: true, removed: wtDirty.path });
  assert.equal(fs.existsSync(wtDirty.path), false);

  // Verify pruned from worktree list.
  const after = await api("GET", `/v1/codex/worktrees?path=${encodeURIComponent(repo)}`);
  assert.equal(after.status, 200);
  assert.equal(after.json.worktrees.some((wt) => wt.path === wtClean.path || wt.path === wtDirty.path), false);
});
