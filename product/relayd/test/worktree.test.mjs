// W2-MODULES worktree tests: handoff v0 against a temp git repo fixture with
// a local bare "remote", plus the jail guard and a full-server integration
// run with RELAYD_WORKTREE_MODE=true.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { freePort, waitForJob, waitForServer, watchChild } from "./helpers/wait.mjs";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-worktree-test-"));
const jailRoot = path.join(tmpRoot, "ws");
fs.mkdirSync(path.join(jailRoot, "scratch"), { recursive: true });
process.env.CODEX_DATA_DIR = path.join(tmpRoot, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = jailRoot;
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "scratch", name: "Scratch", path: path.join(jailRoot, "scratch") },
]);
process.env.CODEX_REQUIRE_MTLS = "false";

const { prepareWorktree, completeWorktree, worktreeBranch } = await import("../src/worktree.mjs");

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

// Creates a git workspace inside the jail with one commit, plus an optional
// bare remote wired up as origin.
function makeRepo(name, { withRemote = true } = {}) {
  const workspace = path.join(jailRoot, name);
  fs.mkdirSync(workspace, { recursive: true });
  git(workspace, "-c", "init.defaultBranch=main", "init");
  git(workspace, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--allow-empty", "-m", "initial");
  let remote = null;
  if (withRemote) {
    remote = path.join(tmpRoot, `${name}-remote.git`);
    execFileSync("git", ["init", "--bare", remote], { encoding: "utf8" });
    git(workspace, "remote", "add", "origin", remote);
    git(workspace, "push", "origin", "main");
  }
  return { workspace, remote };
}

function fakeJob(workspace) {
  return { id: crypto.randomUUID(), status: "running", workspacePath: workspace };
}

test("prepare + succeed: work is committed, branch pushed to the remote, worktree pruned", () => {
  const { workspace, remote } = makeRepo("repo-push");
  const job = fakeJob(workspace);
  const worktree = prepareWorktree(job, { workspaceRoot: jailRoot });
  assert.ok(worktree, "worktree should be created");
  assert.equal(worktree.branch, worktreeBranch(job.id));
  assert.ok(
    fs.realpathSync(worktree.path).startsWith(fs.realpathSync(workspace) + path.sep),
    "worktree stays inside the workspace",
  );
  assert.ok(fs.existsSync(path.join(worktree.path, ".git")));

  // The "agent" writes into the worktree cwd.
  fs.writeFileSync(path.join(worktree.path, "agent-output.txt"), "made by relay\n");

  job.status = "succeeded";
  const outcome = completeWorktree(job);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.pushed, true);
  assert.equal(job.worktreePushed, true);
  assert.equal(job.worktree, undefined);

  // Branch exists on the bare remote and contains the file.
  const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname:short)"], { encoding: "utf8" });
  assert.ok(refs.includes(worktree.branch), `remote refs: ${refs}`);
  const shown = execFileSync(
    "git",
    ["--git-dir", remote, "show", `${worktree.branch}:agent-output.txt`],
    { encoding: "utf8" },
  );
  assert.equal(shown, "made by relay\n");

  // Pruned locally; branch still exists locally.
  assert.equal(fs.existsSync(worktree.path), false);
  assert.ok(git(workspace, "branch", "--list", worktree.branch).includes(worktree.branch));
});

test("failed jobs are pruned without pushing", () => {
  const { workspace, remote } = makeRepo("repo-fail");
  const job = fakeJob(workspace);
  const worktree = prepareWorktree(job, { workspaceRoot: jailRoot });
  fs.writeFileSync(path.join(worktree.path, "junk.txt"), "junk\n");
  job.status = "failed";
  const outcome = completeWorktree(job);
  assert.equal(outcome.pushed, false);
  const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname:short)"], { encoding: "utf8" });
  assert.ok(!refs.includes("relay/"), `unexpected relay ref pushed: ${refs}`);
  assert.equal(fs.existsSync(worktree.path), false);
});

test("no remote: commit happens, push does not, prune still works", () => {
  const { workspace } = makeRepo("repo-noremote", { withRemote: false });
  const job = fakeJob(workspace);
  const worktree = prepareWorktree(job, { workspaceRoot: jailRoot });
  fs.writeFileSync(path.join(worktree.path, "local-only.txt"), "x\n");
  job.status = "succeeded";
  const outcome = completeWorktree(job);
  assert.equal(outcome.committed, true);
  assert.equal(outcome.pushed, false);
  assert.equal(fs.existsSync(worktree.path), false);
});

test("jail guard: a workspace outside the browse root never gets a worktree", () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-outside-"));
  git(outside, "-c", "init.defaultBranch=main", "init");
  git(outside, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--allow-empty", "-m", "initial");
  const job = fakeJob(outside);
  assert.equal(prepareWorktree(job, { workspaceRoot: jailRoot }), null);
  assert.equal(job.worktree, undefined);
});

// The attack the pre-mutation containment guard exists to stop. Workspace
// contents are agent-writable, so a prior job can pre-plant <workspace>/.relay
// (or .relay/worktrees) as a symlink aimed outside the jail. Both `mkdir -p`
// and `git worktree add` follow such a link, so unless containment is proven
// BEFORE any mutation, relayd creates directories and checks the repo out at
// the outside path — and leaves a relay/* branch behind — before noticing.
function assertNoEscape(workspace, outside, before) {
  assert.deepEqual(
    fs.readdirSync(outside).sort(),
    before,
    "nothing may be created outside the jail",
  );
  // `git worktree remove --force` deletes the checked-out directory, so the
  // surviving branch is the durable evidence that git ran at the outside path.
  const branches = git(workspace, "branch", "--list", "relay/*");
  assert.equal(branches, "", `no relay/* branch may be created; got: ${branches}`);
}

test("jail guard: a pre-planted .relay symlink pointing outside the jail is refused before any write", () => {
  const { workspace } = makeRepo("repo-symlink-relay", { withRemote: false });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-escape-relay-"));
  fs.symlinkSync(outside, path.join(workspace, ".relay"), "dir");
  const before = fs.readdirSync(outside).sort();
  assert.deepEqual(before, [], "fixture starts empty");

  const job = fakeJob(workspace);
  assert.equal(prepareWorktree(job, { workspaceRoot: jailRoot }), null);
  assert.equal(job.worktree, undefined);
  assertNoEscape(workspace, outside, before);
});

test("jail guard: a pre-planted .relay/worktrees symlink (nearest existing ancestor) is refused before any write", () => {
  const { workspace } = makeRepo("repo-symlink-worktrees", { withRemote: false });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-escape-worktrees-"));
  // .relay is a real directory and only the level below it is the trap, so the
  // nearest EXISTING ancestor of the worktree dir is the symlink itself.
  fs.mkdirSync(path.join(workspace, ".relay"));
  fs.symlinkSync(outside, path.join(workspace, ".relay", "worktrees"), "dir");
  const before = fs.readdirSync(outside).sort();
  assert.deepEqual(before, [], "fixture starts empty");

  const job = fakeJob(workspace);
  assert.equal(prepareWorktree(job, { workspaceRoot: jailRoot }), null);
  assert.equal(job.worktree, undefined);
  assertNoEscape(workspace, outside, before);
});

test("a pre-existing real .relay/worktrees directory is still accepted", () => {
  const { workspace } = makeRepo("repo-real-relay", { withRemote: false });
  fs.mkdirSync(path.join(workspace, ".relay", "worktrees"), { recursive: true });
  const job = fakeJob(workspace);
  const worktree = prepareWorktree(job, { workspaceRoot: jailRoot });
  assert.ok(worktree, "a real .relay/worktrees chain must not be refused");
  assert.ok(fs.realpathSync(worktree.path).startsWith(fs.realpathSync(workspace) + path.sep));
  job.status = "failed";
  completeWorktree(job);
});

test("non-git workspaces are left alone", () => {
  const plain = path.join(jailRoot, "plain-dir");
  fs.mkdirSync(plain, { recursive: true });
  const job = fakeJob(plain);
  assert.equal(prepareWorktree(job, { workspaceRoot: jailRoot }), null);
});

test("disabled mode is a no-op", () => {
  const { workspace } = makeRepo("repo-disabled");
  const job = fakeJob(workspace);
  assert.equal(prepareWorktree(job, { workspaceRoot: jailRoot, enabled: false }), null);
});

test("integration: RELAYD_WORKTREE_MODE=true runs the job in a worktree and pushes on success", async () => {
  const serverEntry = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "src", "index.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-worktree-server-"));
  const jail = path.join(dir, "ws");
  const workspace = path.join(jail, "repo");
  fs.mkdirSync(workspace, { recursive: true });
  git(workspace, "-c", "init.defaultBranch=main", "init");
  git(workspace, "-c", "user.name=t", "-c", "user.email=t@localhost", "commit", "--allow-empty", "-m", "initial");
  const remote = path.join(dir, "remote.git");
  execFileSync("git", ["init", "--bare", remote]);
  git(workspace, "remote", "add", "origin", remote);
  git(workspace, "push", "origin", "main");

  // Fake codex writes the answer via -o AND drops a file in its cwd, which
  // must be the worktree, not the workspace.
  const fakeCodex = path.join(dir, "fake-codex");
  fs.writeFileSync(
    fakeCodex,
    `#!/bin/sh\nwhile [ "$#" -gt 1 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done\ncat > /dev/null\necho done > "$out"\necho "from-worktree" > cwd-artifact.txt\npwd\n`,
    { mode: 0o755 },
  );

  const homeDir = path.join(dir, "home");
  fs.mkdirSync(homeDir, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
      CODEX_RUN_HOME: homeDir,
      CODEX_DATA_DIR: path.join(dir, "data"),
      CODEX_WORKSPACE_BROWSE_ROOT: jail,
      CODEX_WORKSPACES: JSON.stringify([{ id: "repo", name: "Repo", path: workspace }]),
      CODEX_BIN: fakeCodex,
      RELAYD_CODEX_TRANSPORT: "exec",
      RELAYD_WORKTREE_MODE: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Both waits are hang detectors (60 s, test/helpers/wait.mjs) polled over
  // unpooled connections, and both report the daemon's exit code and captured
  // output on failure. Nothing here is synchronized by elapsed time.
  const watch = watchChild(child, "relayd(worktree)");
  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForServer(baseUrl, { exited: watch.exited, output: watch.output });
    const server = { baseUrl, describe: watch.describe };

    const create = await fetch(`${baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "repo", prompt: "do work" }),
    });
    assert.equal(create.status, 202);
    const { id } = await create.json();
    const job = await waitForJob(server, id);
    assert.equal(job.status, "succeeded", `job did not succeed: ${JSON.stringify(job)}; ${watch.describe()}`);
    // The job ran inside the worktree, not the workspace root.
    assert.match(job.stdout, /\.relay\/worktrees\//);

    const branch = worktreeBranch(id);
    const refs = execFileSync("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname:short)"], { encoding: "utf8" });
    assert.ok(refs.includes(branch), `expected ${branch} on remote; refs: ${refs}`);
    const shown = execFileSync("git", ["--git-dir", remote, "show", `${branch}:cwd-artifact.txt`], { encoding: "utf8" });
    assert.equal(shown, "from-worktree\n");
    // Worktree pruned; workspace untouched on main.
    assert.equal(fs.existsSync(path.join(workspace, ".relay", "worktrees", branch.slice("relay/".length))), false);
    assert.equal(fs.existsSync(path.join(workspace, "cwd-artifact.txt")), false);
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
});
