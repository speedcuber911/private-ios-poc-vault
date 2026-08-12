import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { cmdInit } = await import("../src/commands/init.mjs");
const { writeCredentials } = await import("../src/creds.mjs");

async function repoAndHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-"));
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", "https://github.com/Me/Relay.git");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-home-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: "a".repeat(44) }, { home });
  return { dir, home };
}

test("init registers the repo and pins the node key fingerprint locally", async () => {
  const { dir, home } = await repoAndHome();
  const calls = [];
  const lines = [];

  await cmdInit([], {
    home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async (url, options) => {
      calls.push({ pathname: new URL(url).pathname, body: JSON.parse(options.body) });
      return { status: 201, json: async () => ({ repo: { id: "r1", fullName: "me/relay", createdAt: 1 } }) };
    },
  });

  assert.deepEqual(calls[0], { pathname: "/v1/repos", body: { fullName: "me/relay" } });
  const pinned = JSON.parse(fs.readFileSync(path.join(dir, ".git", "relay", "node.json"), "utf8"));
  assert.equal(pinned.nodeId, "node-1");
  assert.match(pinned.encPubkeyFingerprint, /^[a-f0-9]{16}$/);
  assert.match(lines.join("\n"), /me\/relay/);
});

test("init refuses without a login", async () => {
  const { dir } = await repoAndHome();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-nologin-"));
  await assert.rejects(() => cmdInit([], { home, cwd: dir, baseUrl: "https://cloud.test",
    fetchImpl: async () => { throw new Error("must not call the network"); }, log: () => {} }), /not_logged_in/);
});

test("init works inside a git worktree, where .git at the root is a file, not a directory", async () => {
  // In a linked worktree, `.git` at the worktree root is a text file
  // ("gitdir: ...") rather than a directory, so joining `.git/relay` and
  // mkdir'ing it throws ENOTDIR. init must resolve the real git dir instead.
  const { dir, home } = await repoAndHome();
  const worktreeDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-wt-")), "wt");
  await execFileAsync("git", ["-C", dir, "worktree", "add", "-q", "-b", "wt-branch", worktreeDir]);

  assert.ok(fs.statSync(path.join(worktreeDir, ".git")).isFile(), "sanity: .git at the worktree root is a file");

  const calls = [];
  const lines = [];

  await cmdInit([], {
    home, cwd: worktreeDir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async (url, options) => {
      calls.push({ pathname: new URL(url).pathname, body: JSON.parse(options.body) });
      return { status: 201, json: async () => ({ repo: { id: "r1", fullName: "me/relay", createdAt: 1 } }) };
    },
  });

  assert.deepEqual(calls[0], { pathname: "/v1/repos", body: { fullName: "me/relay" } });

  const { stdout: gitDirOut } = await execFileAsync("git", ["-C", worktreeDir, "rev-parse", "--git-dir"]);
  const realGitDir = path.resolve(worktreeDir, gitDirOut.trim());
  const pinned = JSON.parse(fs.readFileSync(path.join(realGitDir, "relay", "node.json"), "utf8"));
  assert.equal(pinned.nodeId, "node-1");
  assert.match(pinned.encPubkeyFingerprint, /^[a-f0-9]{16}$/);
  assert.match(lines.join("\n"), /me\/relay/);
});

test("init refuses outside a github repo", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-plain-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-init-plain-home-"));
  writeCredentials({ sessionToken: "sess", nodeId: "node-1", nodeEncPubkey: "k" }, { home });
  await assert.rejects(() => cmdInit([], { home, cwd: plain, baseUrl: "https://cloud.test",
    fetchImpl: async () => { throw new Error("must not call the network"); }, log: () => {} }), /not_a_git_repo/);
});
