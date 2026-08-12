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
    "git://github.com/Me/Relay.git",
  ]) {
    assert.equal(parseGitHubRemote(url), "Me/Relay", `failed for ${url}`);
  }
  assert.equal(parseGitHubRemote("https://gitlab.com/me/relay.git"), null);
  assert.equal(parseGitHubRemote(""), null);
});

test("the github.com host match is case-insensitive, but the owner/repo path is not mangled", () => {
  for (const url of [
    "https://GitHub.com/Me/Relay.git",
    "HTTPS://GITHUB.COM/Me/Relay.git",
    "git@GitHub.com:Me/Relay.git",
    "ssh://git@github.com:22/Me/Relay.git",
  ]) {
    assert.equal(parseGitHubRemote(url), "Me/Relay", `failed for ${url}`);
  }
  // Host-confusion attempts must still be refused even case-insensitively.
  assert.equal(parseGitHubRemote("https://github.com.evil.com/me/r.git"), null);
  assert.equal(parseGitHubRemote("https://evil.com/github.com/me/r.git"), null);
});

test("parseGitHubRemote rejects malformed shapes instead of producing a junk fullName", () => {
  assert.equal(parseGitHubRemote("https://github.com/Me/Relay.git/"), null);
  assert.equal(parseGitHubRemote("https://github.com/Me/Relay/tree/main"), null);
});

test("a github-backed repo resolves to its root, full name, and branch", async () => {
  const dir = await makeRepo();
  const nested = path.join(dir, "src", "deep");
  fs.mkdirSync(nested, { recursive: true });

  const repo = await requireGitHubRepo({ cwd: nested });

  assert.equal(repo.fullName, "Me/Relay");
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

    const fileUrl = await makeRepo({ origin: "file:///tmp/some-bare-repo.git" });
    const fileRepo = await requireGitHubRepo({ cwd: fileUrl });
    assert.equal(fileRepo.fullName, "local/some-bare-repo");
  } finally {
    delete process.env.RELAY_ALLOW_LOCAL_REMOTE;
  }
});

// Reviewer's exact payload (review-t16-t19.md, Important I1): with the bypass
// set, every one of these must still be refused. Before the fix all six were
// silently accepted as a "local/..." repo, so `relay handoff` would push the
// user's branch and working tree to an attacker-controlled or unintended
// remote whenever the env var happened to be set (a shell profile, a CI
// image, a stale export from running this very suite).
test("RELAY_ALLOW_LOCAL_REMOTE never accepts a network remote, even one shaped like a local path", async () => {
  process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";
  try {
    for (const origin of [
      "https://evil.example.com/attacker/repo.git",
      "git@gitlab.com:me/relay.git",
      "ssh://root@10.0.0.1/srv/repo.git",
      "https://github.com.evil.com/me/r.git",
      "http://internal-mirror/repo.git",
      "ftp://example.com/repo.git",
    ]) {
      const dir = await makeRepo({ origin });
      await assert.rejects(() => requireGitHubRepo({ cwd: dir }), /origin_not_github/, `should reject ${origin}`);
    }
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

// Minor m1: `git status --porcelain` (without -z) C-quotes any path holding a
// non-ASCII or control byte, and the old code re-joined that quoted text
// straight onto the filesystem — the resulting path never existed, so the
// untracked file's line count silently dropped to 0.
test("untracked files with non-ASCII names are still counted, not silently dropped", async () => {
  const dir = await makeRepo();
  fs.writeFileSync(path.join(dir, "café.txt"), "a\nb\nc\n");
  fs.writeFileSync(path.join(dir, "plain.txt"), "x\ny\n");

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.files, 2);
  assert.equal(summary.insertions, 5, "3 lines from café.txt + 2 from plain.txt, not just plain.txt's 2");
});

// Minor m2: `git diff --numstat` (unstaged-only) misses content that has
// already been `git add`ed, and the default `git status --porcelain`
// collapses a whole new untracked directory into a single "?? dir/" entry.
test("staged edits and a new untracked directory are both counted in full", async () => {
  const dir = await makeRepo();
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);

  fs.appendFileSync(path.join(dir, "README.md"), "staged line\n");
  await git("add", "README.md");

  fs.mkdirSync(path.join(dir, "newdir"));
  for (let i = 0; i < 5; i += 1) {
    fs.writeFileSync(path.join(dir, "newdir", `f${i}.txt`), `content ${i}\n`);
  }

  const summary = await workingTreeSummary({ root: dir });

  assert.ok(summary.insertions >= 1, "the staged edit must not report +0");
  assert.equal(summary.files, 1 + 5, "README.md plus each of the 5 new files, not the directory collapsed to 1");
});

test("a staged rename is counted once, and its extra token pair does not throw off parsing", async () => {
  const dir = await makeRepo();
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  // Enough shared content to stay above git's rename-similarity threshold —
  // otherwise `git status` reports a plain delete+add instead of a rename,
  // which exercises a different code path than the one this test targets.
  fs.writeFileSync(path.join(dir, "README.md"), "line1\nline2\nline3\nline4\nline5\n");
  await git("add", "-A");
  await git("commit", "-qm", "seed content");
  await git("mv", "README.md", "RENAMED.md");
  fs.appendFileSync(path.join(dir, "RENAMED.md"), "line6\n");
  await git("add", "RENAMED.md");

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.files, 1, "the rename's paired original-path token must not be double-counted as a second file");
  assert.ok(summary.insertions >= 1, "the content added on top of the rename must be counted");
});

// Minor m3: counting an untracked file's lines must not read the whole file
// into a JS string — a large untracked file would otherwise drive a
// multi-hundred-MB heap spike on the exact "shut the laptop" path. This does
// not assert on RSS (not practical from node:test), but it does prove a
// several-MB untracked file is still counted correctly via the git-based path.
test("a large untracked file's line count is still computed correctly", async () => {
  const dir = await makeRepo();
  const lineCount = 50_000;
  fs.writeFileSync(path.join(dir, "big.txt"), "x\n".repeat(lineCount));

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.files, 1);
  assert.equal(summary.insertions, lineCount);
});

// Minor m6 (root cause of T19/m13 too): an unborn branch (zero commits) made
// `rev-parse --abbrev-ref HEAD` fail with a raw git error that `bin/relay`
// would print verbatim, including the git command line itself.
test("an unborn branch is refused with a named error, not a raw git error", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-unborn-"));
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await execFileAsync("git", ["-C", dir, "remote", "add", "origin", "https://github.com/Me/Relay.git"]);

  await assert.rejects(() => currentBranch({ root: dir }), /unborn_branch/);
  await assert.rejects(() => requireGitHubRepo({ cwd: dir }), /unborn_branch/);
});
