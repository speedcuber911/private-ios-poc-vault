import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { requireGitHubRepo, parseGitHubRemote, currentBranch, workingTreeSummary } = await import("../src/repo.mjs");

async function makeRepo({ origin = "https://github.com/Me/Relay.git" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-repo-"));
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  if (origin) await git("remote", "add", "origin", origin);
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  return dir;
}

test("parseGitHubRemote understands every remote form GitHub hands out", () => {
  for (const url of [
    "https://github.com/Me/Relay.git", "https://github.com/Me/Relay",
    "git@github.com:Me/Relay.git", "ssh://git@github.com/Me/Relay.git",
  ]) {
    assert.equal(parseGitHubRemote(url), "me/relay", `failed for ${url}`);
  }
  assert.equal(parseGitHubRemote("https://gitlab.com/me/relay.git"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("a github-backed repo resolves to its root, full name, and branch", async () => {
  const dir = await makeRepo();
  const nested = path.join(dir, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });

  const repo = await requireGitHubRepo({ cwd: nested });

  assert.equal(repo.fullName, "me/relay");
  assert.equal(repo.branch, "main");
  assert.equal(fs.realpathSync(repo.root), fs.realpathSync(dir), "the repo root is found from a nested cwd");
});

test("a non-repo, a remoteless repo, and a non-github remote are each refused distinctly", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-plain-"));
  await assert.rejects(() => requireGitHubRepo({ cwd: plain }), /not_a_git_repo/);

  const noRemote = await makeRepo({ origin: null });
  await assert.rejects(() => requireGitHubRepo({ cwd: noRemote }), /no_origin_remote/);

  const gitlab = await makeRepo({ origin: "https://gitlab.com/me/relay.git" });
  await assert.rejects(() => requireGitHubRepo({ cwd: gitlab }), /origin_not_github/);
});

test("RELAY_ALLOW_LOCAL_REMOTE is the only bypass for the github guard", async () => {
  const local = await makeRepo({ origin: "/tmp/some-bare-repo.git" });
  await assert.rejects(() => requireGitHubRepo({ cwd: local }), /origin_not_github/);

  process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";
  try {
    const repo = await requireGitHubRepo({ cwd: local });
    assert.equal(repo.fullName, "local/some-bare-repo");
  } finally {
    delete process.env.RELAY_ALLOW_LOCAL_REMOTE;
  }
});

test("workingTreeSummary counts tracked edits and untracked files", async () => {
  const dir = await makeRepo();
  fs.appendFileSync(path.join(dir, "README.md"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "new.txt"), "fresh\n");

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.files, 2);
  assert.ok(summary.insertions >= 2);
  assert.match(summary.summary, /2 files? changed/);
  assert.equal(await currentBranch({ root: dir }), "main");
});

test("a clean tree summarises as no changes", async () => {
  const dir = await makeRepo();
  const summary = await workingTreeSummary({ root: dir });
  assert.equal(summary.files, 0);
  assert.equal(summary.summary, "no uncommitted changes");
});
