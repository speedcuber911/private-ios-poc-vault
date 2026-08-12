import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { requireGitHubRepo, parseGitHubRemote, currentBranch, workingTreeSummary, MAX_UNTRACKED_FILES_COUNTED } = await import("../src/repo.mjs");

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

// Minor m5: the (?::\d+)? port group was only ever added to the ssh://
// alternative, so a legitimate remote using an explicit https port was
// refused outright — a false negative, not a security gap.
test("parseGitHubRemote accepts an explicit https port, matching the ssh:// alternative", () => {
  assert.equal(parseGitHubRemote("https://github.com:443/Me/Relay.git"), "Me/Relay");
  assert.equal(parseGitHubRemote("http://github.com:8080/Me/Relay.git"), "Me/Relay");
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

// Minor m1: on macOS/Linux git these three shapes all resolve to a *local*
// path (verified with `git ls-remote`), but on Windows/Cygwin git,
// "//host/share" is a UNC network path — so RELAY_ALLOW_LOCAL_REMOTE (a
// test-only bypass) accepting them as "local/..." is platform-dependent in a
// way a local-only bypass should never be. A real absolute local path never
// legitimately starts with two or more slashes, so they are rejected
// outright rather than accepted as local.
test("RELAY_ALLOW_LOCAL_REMOTE rejects double-leading-slash shapes that are a UNC network path on some platforms", async () => {
  process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";
  try {
    for (const origin of [
      "//host/share/repo.git",
      "///host/share/repo.git",
      "file://///host/share/repo.git",
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

// Important I2: workingTreeSummary is entirely async around real `git`
// subprocesses, so a hang inside it is a blocked subprocess the event loop is
// legitimately waiting on — node:test's own `timeout` option cannot save us
// (it marks the test cancelled while the orphaned git process keeps
// blocking forever; the same trap documented for the synchronous case in
// sessions.test.mjs). The only reliable way to bound a genuine hang is to run
// the call in a child process and let spawnSync's own `timeout` SIGKILL it
// from outside.
function runWorkingTreeSummaryInChild(root, { timeout = 4000 } = {}) {
  const repoPath = new URL("../src/repo.mjs", import.meta.url).pathname;
  const script = [
    `import { workingTreeSummary } from ${JSON.stringify(repoPath)};`,
    `const summary = await workingTreeSummary({ root: ${JSON.stringify(root)} });`,
    `process.stdout.write(JSON.stringify(summary));`,
  ].join("\n");
  // Written outside `root` deliberately: the probe script must not itself
  // become a new untracked entry that workingTreeSummary has to reason about.
  const scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-repo-probe-"));
  const scriptPath = path.join(scriptDir, "probe.mjs");
  fs.writeFileSync(scriptPath, script);
  return spawnSync(process.execPath, [scriptPath], { timeout, killSignal: "SIGKILL", encoding: "utf8" });
}

// Important I2: `git status` filters bare FIFOs and bare sockets out of its
// `??` list (verified empirically), but it still reports a *symlink* whose
// target is a FIFO, a socket, or a device — and `git diff --no-index` then
// follows that symlink and blocks on the FIFO with no writer, forever, with
// no way to interrupt it from JS once the subprocess is spawned. All six
// hostile shapes the reviewer asked for are exercised here in one repo: a
// symlink to a FIFO, a bare FIFO, a socket, a symlink to a device
// (mknod-ing a real device node needs root, so a symlink to /dev/null
// stands in, matching how the review itself tested this), a dangling
// symlink, and a two-node symlink loop.
test("workingTreeSummary never hangs on a hostile untracked entry (I2)", async (t) => {
  const dir = await makeRepo();

  const fifoPath = path.join(dir, "real_fifo");
  const mkfifo = spawnSync("mkfifo", [fifoPath]);
  assert.equal(mkfifo.status, 0, "test setup requires mkfifo to succeed on this platform");
  fs.symlinkSync(fifoPath, path.join(dir, "fifolink"));
  fs.symlinkSync("/nonexistent-target-relay-i2", path.join(dir, "danglink"));
  fs.symlinkSync("loopB", path.join(dir, "loopA"));
  fs.symlinkSync("loopA", path.join(dir, "loopB"));
  fs.symlinkSync("/dev/null", path.join(dir, "devlink"));
  fs.writeFileSync(path.join(dir, "plain.txt"), "a\nb\nc\n");

  const sockPath = path.join(dir, "real.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });
  t.after(() => new Promise((resolve) => server.close(() => resolve())));

  const result = runWorkingTreeSummaryInChild(dir);

  assert.equal(result.signal, null,
    `workingTreeSummary hung and had to be killed (signal=${result.signal}); a hostile untracked entry must be ` +
    `skipped before it is ever opened or diffed. stderr: ${result.stderr}`);
  assert.equal(result.status, 0, `probe exited abnormally: ${result.stderr}`);

  const summary = JSON.parse(result.stdout);
  assert.equal(summary.files, 6, "danglink, devlink, fifolink, loopA, loopB, plain.txt — the bare fifo/socket never reach the ?? list at all");
  assert.equal(summary.insertions, 3, "only plain.txt's 3 lines are counted; every hostile entry contributes 0, not a hang");
});

// Important I3: forking one `git diff --no-index` per untracked file measured
// at ~5.2ms each, serially — 26s at 5,000 files, minutes on an untracked
// `node_modules`, all before `relay handoff` (the shut-the-laptop command)
// does anything at all. This pins the actual process count via execFileImpl
// (a real measurement of what gets spawned, the same technique already used
// elsewhere in this suite to pin the push-argv count), so a regression that
// reintroduces one subprocess per file is caught even if it happens to still
// return the right numbers.
test("workingTreeSummary makes a bounded number of git invocations regardless of untracked file count (I3)", async () => {
  const dir = await makeRepo();
  const fileCount = 200;
  for (let i = 0; i < fileCount; i += 1) {
    fs.writeFileSync(path.join(dir, `untracked-${i}.txt`), "x\n".repeat((i % 5) + 1));
  }

  let invocations = 0;
  const execFileImpl = (...callArgs) => {
    invocations += 1;
    return execFileAsync(...callArgs);
  };

  const summary = await workingTreeSummary({ root: dir, execFileImpl });

  assert.equal(summary.files, fileCount);
  assert.equal(invocations, 2,
    `expected exactly 2 git invocations (status + diff --numstat) regardless of untracked file count, got ${invocations} for ${fileCount} files`);
});

// Important I3, measured rather than reasoned about: a real wall-clock timer
// against a real (uninstrumented) run. At ~5.2ms/subprocess, 500 untracked
// files forking one git process each would already cost ~2.6s on their own,
// before git status/diff overhead — comfortably over the 1s bound below. An
// in-process, bounded-buffer line count should finish in a small number of
// milliseconds regardless of file count.
test("workingTreeSummary stays fast with many untracked files (I3, measured)", async () => {
  const dir = await makeRepo();
  const fileCount = 500;
  for (let i = 0; i < fileCount; i += 1) {
    fs.writeFileSync(path.join(dir, `bulk-${i}.txt`), "x\n".repeat(10));
  }

  const start = Date.now();
  const summary = await workingTreeSummary({ root: dir });
  const elapsedMs = Date.now() - start;

  assert.equal(summary.files, fileCount);
  assert.equal(summary.insertions, fileCount * 10);
  assert.ok(elapsedMs < 1000,
    `workingTreeSummary took ${elapsedMs}ms for ${fileCount} untracked files — expected well under the ` +
    `~2600ms a one-git-process-per-file design would already cost on forking alone`);
});

// Important I3: truncation must be visible, not a silent undercount. Past
// MAX_UNTRACKED_FILES_COUNTED, files still count toward `files`, but their
// line counts stop being added — the earlier fix round for this same summary
// was already found undercounting C-quoted filenames, so silently dropping
// numbers here would repeat exactly that mistake.
test("past the untracked-file cap, the summary says it truncated instead of silently undercounting (I3)", async () => {
  const dir = await makeRepo();
  const overCap = MAX_UNTRACKED_FILES_COUNTED + 5;
  for (let i = 0; i < overCap; i += 1) {
    fs.writeFileSync(path.join(dir, `many-${i}.txt`), "one line\n");
  }

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.files, overCap, "every untracked file is still counted toward the file total");
  assert.equal(summary.truncated, true, "the result says it was truncated");
  assert.match(summary.summary, /capped at/i, "the human-readable summary says so too, not just a hidden field");
  assert.ok(summary.insertions <= MAX_UNTRACKED_FILES_COUNTED,
    "insertions stop growing past the cap rather than opening every one of the 2000+ files");
});

// Under the cap, nothing is truncated — the common case must not carry a
// spurious warning.
test("under the untracked-file cap, the summary is not marked truncated", async () => {
  const dir = await makeRepo();
  fs.writeFileSync(path.join(dir, "one.txt"), "line\n");

  const summary = await workingTreeSummary({ root: dir });

  assert.equal(summary.truncated, false);
  assert.ok(!/capped at/i.test(summary.summary));
});
