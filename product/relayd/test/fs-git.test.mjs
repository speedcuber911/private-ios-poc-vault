// Branch and working-tree line counts for the phone file viewer.
// The counts have to move as the work tree changes, without ever returning
// paths or diff bodies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relayd-fs-git-")));
const browse = path.join(tmp, "workspaces");
const repo = path.join(browse, "app");
const plain = path.join(browse, "plain");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(plain, { recursive: true });
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });

process.env.CODEX_DATA_DIR = path.join(tmp, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = browse;
process.env.CODEX_REQUIRE_MTLS = "false";
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "app", name: "App", path: repo }]);

const { fsGitStatus } = await import("../src/fsgit.mjs");

function git(args) {
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@localhost",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@localhost",
    },
  });
}

function params(relativePath) {
  return new URLSearchParams({ path: relativePath });
}

test("file counts follow the working tree, and a non-repo stays quiet", async () => {
  git(["-c", "init.defaultBranch=main", "init"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(repo, "main.swift"), "one\ntwo\nthree\n");
  git(["add", "main.swift"]);
  git(["commit", "-m", "initial"]);
  git(["checkout", "-b", "feature/status"]);

  const clean = await fsGitStatus(params("app/main.swift"));
  assert.equal(clean.git, true);
  assert.equal(clean.branch, "feature/status");
  assert.equal(clean.detached, false);
  assert.equal(clean.added, 0);
  assert.equal(clean.deleted, 0);
  assert.equal(clean.binary, false);
  assert.equal(typeof clean.modifiedAt, "string");
  assert.equal(clean.size, Buffer.byteLength("one\ntwo\nthree\n"));

  fs.writeFileSync(path.join(repo, "main.swift"), "one\ntwo\nthree\nfour\n");
  const added = await fsGitStatus(params("app/main.swift"));
  assert.equal(added.added, 1);
  assert.equal(added.deleted, 0);
  assert.deepEqual(added.addedLines, [[4, 4]]);
  assert.deepEqual(added.removedAt, []);
  assert.notEqual(added.modifiedAt, clean.modifiedAt);

  fs.writeFileSync(path.join(repo, "main.swift"), "one\nfour\n");
  const edited = await fsGitStatus(params("app/main.swift"));
  assert.equal(edited.added, 1);
  assert.equal(edited.deleted, 2);

  fs.writeFileSync(path.join(repo, "new.swift"), "alpha\nbeta\n");
  const untracked = await fsGitStatus(params("app/new.swift"));
  assert.equal(untracked.added, 2);
  assert.equal(untracked.deleted, 0);
  assert.deepEqual(untracked.addedLines, [[1, 2]]);
  assert.equal(untracked.branch, "feature/status");

  const folder = await fsGitStatus(params("app"));
  assert.equal(folder.branch, "feature/status");
  assert.equal(folder.added, edited.added + untracked.added);
  assert.equal(folder.deleted, edited.deleted);
  assert.equal(folder.size, undefined);
  assert.equal(folder.modifiedAt, undefined);

  fs.writeFileSync(path.join(repo, "main.swift"), "one\nthree\n");
  const removed = await fsGitStatus(params("app/main.swift"));
  assert.equal(removed.added, 0);
  assert.equal(removed.deleted, 1);
  assert.deepEqual(removed.removedAt, [1]);
  assert.deepEqual(removed.addedLines, []);

  fs.writeFileSync(path.join(plain, "note.txt"), "hello\n");
  const outside = await fsGitStatus(params("plain/note.txt"));
  assert.equal(outside.git, false);
  assert.equal(outside.size, Buffer.byteLength("hello\n"));
  assert.equal(typeof outside.modifiedAt, "string");
});

test("secret files and jail escapes are refused", async () => {
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
  await assert.rejects(fsGitStatus(params("app/.env")), (error) => error.status === 403);
  await assert.rejects(fsGitStatus(params("../outside.txt")), (error) => error.status === 400);
});

test.after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});