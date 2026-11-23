// Tests for Paseo-grade Git inspection & action routes (/v1/codex/git/*).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relayd-git-api-")));
const browse = path.join(tmp, "workspaces");
const outside = path.join(tmp, "outside");
const repo = path.join(browse, "project");
const plain = path.join(browse, "plain");
fs.mkdirSync(repo, { recursive: true });
fs.mkdirSync(plain, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });

process.env.CODEX_DATA_DIR = path.join(tmp, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = browse;
process.env.CODEX_REQUIRE_MTLS = "false";
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "project", name: "Project", path: repo }]);
process.env.RELAYD_GH_BIN = path.join(tmp, "missing-gh-binary");

const { routeRequest } = await import("../src/server.mjs");
const { sendError } = await import("../src/util.mjs");
const { clearPrCache } = await import("../src/git-api.mjs");

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

function initRepo(dir, { withRemote = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "user.name", "Test Dev");
  git(dir, "config", "user.email", "dev@example.com");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "app.ts"), "line1\nline2\nline3\nline4\n");
  fs.writeFileSync(path.join(dir, "old.txt"), "rename me\nsecond line\n");
  fs.writeFileSync(path.join(dir, "remove-me.txt"), "bye1\nbye2\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "Initial commit");

  let remoteDir = null;
  if (withRemote) {
    remoteDir = path.join(tmp, `${path.basename(dir)}-remote.git`);
    execFileSync("git", ["init", "--bare", remoteDir], { encoding: "utf8" });
    git(dir, "remote", "add", "origin", remoteDir);
    git(dir, "push", "-u", "origin", "main");
    git(dir, "remote", "set-head", "origin", "main");
  }
  return { remoteDir };
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

test("non-git directory and jail boundary enforcement", async () => {
  const nonGit = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(plain)}`);
  assert.equal(nonGit.status, 200);
  assert.deepEqual(nonGit.json, {
    isGitRepo: false,
    repoRoot: null,
    branch: null,
    baseBranch: null,
    ahead: 0,
    behind: 0,
    dirty: false,
    added: 0,
    deleted: 0,
    files: [],
    pr: null,
  });

  const nonGitDiff = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(plain)}`);
  assert.equal(nonGitDiff.status, 400);

  // Outside directory refused with 400.
  const escaped = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(outside)}`);
  assert.equal(escaped.status, 400);

  // Symlink inside jail pointing outside jail refused with 400.
  const escapeLink = path.join(browse, "escape-link");
  fs.symlinkSync(outside, escapeLink, "dir");
  const viaLink = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(escapeLink)}`);
  assert.equal(viaLink.status, 400);

  // Missing path parameter refused with 400.
  const missing = await api("GET", "/v1/codex/git/status");
  assert.equal(missing.status, 400);
});

test("status reports branch, baseBranch, ahead/behind, file statuses, counts, and filters read-denied files", async () => {
  const r = path.join(browse, "status-repo");
  initRepo(r, { withRemote: true });

  // Create feature branch with 2 commits ahead of main.
  git(r, "checkout", "-b", "feat/inspect");
  fs.writeFileSync(path.join(r, "src", "feature.ts"), "export const a = 1;\n");
  git(r, "add", "src/feature.ts");
  git(r, "commit", "-m", "Add feature module");

  fs.writeFileSync(path.join(r, "src", "feature.ts"), "export const a = 1;\nexport const b = 2;\n");
  git(r, "add", "src/feature.ts");
  git(r, "commit", "-m", "Extend feature module");

  // Working tree edits:
  // 1) modified unstaged
  fs.writeFileSync(path.join(r, "src", "app.ts"), "line1\nline2-edited\nline3\nline4\nline5\n");
  // 2) staged added
  fs.writeFileSync(path.join(r, "src", "staged.ts"), "s1\ns2\ns3\n");
  git(r, "add", "src/staged.ts");
  // 3) deleted tracked
  fs.unlinkSync(path.join(r, "remove-me.txt"));
  // 4) staged rename
  git(r, "mv", "old.txt", "renamed.txt");
  // 5) untracked text file
  fs.writeFileSync(path.join(r, "notes.md"), "alpha\nbeta\ngamma\n");
  // 6) untracked binary file
  fs.writeFileSync(path.join(r, "logo.bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  // 7) read-denied secret files (untracked AND staged) MUST be filtered out!
  fs.writeFileSync(path.join(r, ".env"), "API_SECRET=supersecret\n");
  fs.writeFileSync(path.join(r, ".env.local"), "LOCAL_SECRET=hidden\n");
  fs.mkdirSync(path.join(r, "certs"), { recursive: true });
  fs.writeFileSync(path.join(r, "certs", "server.key"), "PRIVATE KEY\nLINE2\n");
  git(r, "add", "certs/server.key");

  // Query via subdirectory to verify repoRoot resolution stays inside jail.
  const res = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(path.join(r, "src"))}`);
  assert.equal(res.status, 200);
  const data = res.json;
  assert.equal(data.isGitRepo, true);
  assert.equal(data.repoRoot, r);
  assert.equal(data.branch, "feat/inspect");
  assert.equal(data.baseBranch, "main");
  assert.equal(data.ahead, 2);
  assert.equal(data.behind, 0);
  assert.equal(data.dirty, true);
  assert.equal(data.pr, null);

  const byPath = new Map(data.files.map((f) => [f.path, f]));
  assert.equal(byPath.has(".env"), false, ".env must be filtered out");
  assert.equal(byPath.has(".env.local"), false, ".env.local must be filtered out");
  assert.equal(byPath.has("certs/server.key"), false, "*.key must be filtered out");

  assert.deepEqual(byPath.get("src/app.ts"), {
    path: "src/app.ts",
    oldPath: null,
    status: "modified",
    staged: false,
    unstaged: true,
    added: 2,
    deleted: 1,
    binary: false,
  });
  assert.deepEqual(byPath.get("src/staged.ts"), {
    path: "src/staged.ts",
    oldPath: null,
    status: "added",
    staged: true,
    unstaged: false,
    added: 3,
    deleted: 0,
    binary: false,
  });
  assert.deepEqual(byPath.get("remove-me.txt"), {
    path: "remove-me.txt",
    oldPath: null,
    status: "deleted",
    staged: false,
    unstaged: true,
    added: 0,
    deleted: 2,
    binary: false,
  });
  assert.deepEqual(byPath.get("renamed.txt"), {
    path: "renamed.txt",
    oldPath: "old.txt",
    status: "renamed",
    staged: true,
    unstaged: false,
    added: 0,
    deleted: 0,
    binary: false,
  });
  assert.deepEqual(byPath.get("notes.md"), {
    path: "notes.md",
    oldPath: null,
    status: "untracked",
    staged: false,
    unstaged: true,
    added: 3,
    deleted: 0,
    binary: false,
  });
  assert.deepEqual(byPath.get("logo.bin"), {
    path: "logo.bin",
    oldPath: null,
    status: "untracked",
    staged: false,
    unstaged: true,
    added: 0,
    deleted: 0,
    binary: true,
  });

  // Totals match only visible (non-denied) files.
  assert.equal(data.added, 2 + 3 + 3);
  assert.equal(data.deleted, 1 + 2);
});

test("status parses optional PR metadata from gh and caches for 30s", async () => {
  const r = path.join(browse, "pr-repo");
  initRepo(r);
  git(r, "checkout", "-b", "feat/pr-check");

  const counterFile = path.join(tmp, "gh-calls.txt");
  const fakeGh = path.join(tmp, "fake-gh");
  fs.writeFileSync(
    fakeGh,
    `#!/bin/sh
echo x >> "${counterFile}"
cat <<'EOF'
{"number":42,"title":"Add git panel","state":"OPEN","url":"https://github.com/org/repo/pull/42","headRefName":"feat/pr-check","statusCheckRollup":[{"status":"COMPLETED","conclusion":"SUCCESS"},{"status":"IN_PROGRESS","conclusion":null}]}
EOF
`,
    { mode: 0o755 },
  );

  const prevGh = process.env.RELAYD_GH_BIN;
  process.env.RELAYD_GH_BIN = fakeGh;
  clearPrCache();
  try {
    const first = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(r)}`);
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.pr, {
      number: 42,
      title: "Add git panel",
      state: "OPEN",
      url: "https://github.com/org/repo/pull/42",
      headBranch: "feat/pr-check",
      checksStatus: "pending",
    });

    // Second call hits 30s cache without invoking gh again.
    const second = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(r)}`);
    assert.equal(second.status, 200);
    assert.equal(second.json.pr.number, 42);
    const invocations = fs.readFileSync(counterFile, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(invocations.length, 1);
  } finally {
    process.env.RELAYD_GH_BIN = prevGh;
    clearPrCache();
  }
});

test("diff supports uncommitted, committed, all modes, file filter, synthetic untracked, denylist, and tricky lines", async () => {
  const r = path.join(browse, "diff-repo");
  initRepo(r);

  git(r, "checkout", "-b", "feat/diff-test");
  // Committed change on feature branch:
  fs.writeFileSync(path.join(r, "src", "committed.ts"), "export const v = 1;\n");
  fs.writeFileSync(path.join(r, "src", "app.ts"), "line1\nline2\nline3\nline4\ncommitted-line\n");
  git(r, "add", "-A");
  git(r, "commit", "-m", "Branch commit");

  // Uncommitted edits (including lines starting with `--- ` and `+++ ` inside content!):
  fs.writeFileSync(
    path.join(r, "src", "app.ts"),
    "line1\n-- dash\n+++ plusplus\nline3\nline4\ncommitted-line\nuncommitted-line\n",
  );
  // Untracked text file
  fs.writeFileSync(path.join(r, "fresh.txt"), "hello\nworld\n");
  // Untracked binary file (skipped in synthetic diff)
  fs.writeFileSync(path.join(r, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]));
  // Untracked read-denied file (skipped)
  fs.writeFileSync(path.join(r, ".env"), "SECRET=123\n");

  // 1) mode=uncommitted (default)
  const uncomm = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}`);
  assert.equal(uncomm.status, 200);
  assert.equal(uncomm.json.mode, "uncommitted");
  assert.equal(uncomm.json.branch, "feat/diff-test");
  assert.equal(uncomm.json.baseBranch, "main");
  assert.equal(uncomm.json.truncated, false);

  const uFiles = new Map(uncomm.json.files.map((f) => [f.path, f]));
  assert.equal(uFiles.has(".env"), false);
  assert.equal(uFiles.has("img.png"), false);
  assert.equal(uFiles.has("src/committed.ts"), false);

  const appDiff = uFiles.get("src/app.ts");
  assert.ok(appDiff);
  assert.equal(appDiff.status, "modified");
  assert.equal(appDiff.added, 3);
  assert.equal(appDiff.deleted, 1);
  assert.ok(appDiff.hunks.length >= 1);
  const addedTexts = appDiff.hunks.flatMap((h) => h.lines.filter((l) => l.kind === "add").map((l) => l.text));
  assert.ok(addedTexts.includes("-- dash"));
  assert.ok(addedTexts.includes("+++ plusplus"));
  assert.ok(addedTexts.includes("uncommitted-line"));

  const freshDiff = uFiles.get("fresh.txt");
  assert.ok(freshDiff);
  assert.equal(freshDiff.status, "untracked");
  assert.equal(freshDiff.added, 2);
  assert.equal(freshDiff.deleted, 0);
  assert.equal(freshDiff.hunks.length, 1);
  assert.deepEqual(freshDiff.hunks[0].lines, [
    { kind: "add", oldLine: null, newLine: 1, text: "hello" },
    { kind: "add", oldLine: null, newLine: 2, text: "world" },
  ]);

  // 2) mode=committed
  const comm = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}&mode=committed`);
  assert.equal(comm.status, 200);
  assert.equal(comm.json.mode, "committed");
  const cPaths = comm.json.files.map((f) => f.path).sort();
  assert.deepEqual(cPaths, ["src/app.ts", "src/committed.ts"]);

  // 3) mode=all
  const all = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}&mode=all`);
  assert.equal(all.status, 200);
  assert.equal(all.json.mode, "all");
  const aPaths = all.json.files.map((f) => f.path).sort();
  assert.deepEqual(aPaths, ["fresh.txt", "src/app.ts", "src/committed.ts"]);

  // 4) Single file filter + security refusals
  const oneFile = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}&file=fresh.txt`);
  assert.equal(oneFile.status, 200);
  assert.deepEqual(oneFile.json.files.map((f) => f.path), ["fresh.txt"]);

  const deniedFile = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}&file=.env`);
  assert.equal(deniedFile.status, 403);

  const escapeFile = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}&file=../outside.txt`);
  assert.equal(escapeFile.status, 400);

  const badMode = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}&mode=invalid`);
  assert.equal(badMode.status, 400);
});

test("diff enforces line cap and marks truncated: true", async () => {
  const r = path.join(browse, "huge-diff-repo");
  initRepo(r);
  const bigLines = Array.from({ length: 9000 }, (_, i) => `line-${i + 1}`).join("\n") + "\n";
  fs.writeFileSync(path.join(r, "src", "app.ts"), bigLines);

  const res = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}`);
  assert.equal(res.status, 200);
  assert.equal(res.json.truncated, true);
  const totalLines = res.json.files.reduce(
    (sum, f) => sum + f.hunks.reduce((hs, h) => hs + h.lines.length, 0),
    0,
  );
  assert.ok(totalLines <= 8000, `expected <= 8000 diff lines, got ${totalLines}`);
});

test("commits and commit-diff return history, root commit diff, and reject invalid/missing SHAs", async () => {
  const r = path.join(browse, "commits-repo");
  initRepo(r);
  const rootSha = git(r, "rev-parse", "HEAD");

  fs.writeFileSync(path.join(r, "src", "app.ts"), "line1\nupdated\nline3\nline4\n");
  fs.writeFileSync(path.join(r, ".env"), "COMMITTED_SECRET=nope\n");
  git(r, "add", "-A");
  git(r, "commit", "-m", "Second commit with secret");
  const secondSha = git(r, "rev-parse", "HEAD");

  const list = await api("GET", `/v1/codex/git/commits?path=${encodeURIComponent(r)}&limit=10`);
  assert.equal(list.status, 200);
  assert.equal(list.json.branch, "main");
  assert.equal(list.json.commits.length, 2);
  assert.equal(list.json.commits[0].sha, secondSha);
  assert.equal(list.json.commits[0].subject, "Second commit with secret");
  assert.equal(list.json.commits[0].author, "Test Dev");
  assert.ok(!Number.isNaN(Date.parse(list.json.commits[0].committedAt)));

  // Commit diff filters out committed .env secret!
  const diff2 = await api("GET", `/v1/codex/git/commit-diff?path=${encodeURIComponent(r)}&sha=${secondSha.slice(0, 8)}`);
  assert.equal(diff2.status, 200);
  assert.equal(diff2.json.mode, "commit");
  assert.equal(diff2.json.sha, secondSha);
  assert.deepEqual(diff2.json.files.map((f) => f.path), ["src/app.ts"]);

  // Root commit diff works via --root.
  const diffRoot = await api("GET", `/v1/codex/git/commit-diff?path=${encodeURIComponent(r)}&sha=${rootSha}`);
  assert.equal(diffRoot.status, 200);
  assert.ok(diffRoot.json.files.some((f) => f.path === "src/app.ts" && f.status === "added"));

  // Bad SHA -> 400; nonexistent hex SHA -> 404.
  assert.equal((await api("GET", `/v1/codex/git/commit-diff?path=${encodeURIComponent(r)}&sha=not-hex`)).status, 400);
  assert.equal((await api("GET", `/v1/codex/git/commit-diff?path=${encodeURIComponent(r)}&sha=abc`)).status, 400);
  assert.equal((await api("GET", `/v1/codex/git/commit-diff?path=${encodeURIComponent(r)}&sha=--flag`)).status, 400);
  assert.equal((await api("GET", `/v1/codex/git/commit-diff?path=${encodeURIComponent(r)}&sha=deadbeef`)).status, 404);
});

test("branches and checkout validate branch names safely and switch/create branches", async () => {
  const r = path.join(browse, "branches-repo");
  initRepo(r, { withRemote: true });

  const created = await api("POST", "/v1/codex/git/checkout", {
    path: r,
    branch: "feat/new-branch",
    create: true,
  });
  assert.equal(created.status, 200);
  assert.deepEqual(created.json, { ok: true, branch: "feat/new-branch" });

  // Creating an already-existing branch fails with 409.
  const dup = await api("POST", "/v1/codex/git/checkout", {
    path: r,
    branch: "feat/new-branch",
    create: true,
  });
  assert.equal(dup.status, 409);

  const list = await api("GET", `/v1/codex/git/branches?path=${encodeURIComponent(r)}`);
  assert.equal(list.status, 200);
  assert.equal(list.json.current, "feat/new-branch");
  assert.equal(list.json.baseBranch, "main");
  const currentEntry = list.json.branches.find((b) => b.name === "feat/new-branch");
  assert.deepEqual(currentEntry, {
    name: "feat/new-branch",
    isCurrent: true,
    isRemote: false,
    upstream: null,
  });
  const remoteMain = list.json.branches.find((b) => b.name === "origin/main");
  assert.equal(remoteMain?.isRemote, true);
  // Symbolic origin/HEAD should not appear as a branch.
  assert.equal(list.json.branches.some((b) => b.name === "origin/HEAD"), false);

  // Switch back to main.
  const switched = await api("POST", "/v1/codex/git/checkout", { path: r, branch: "main" });
  assert.equal(switched.status, 200);
  assert.deepEqual(switched.json, { ok: true, branch: "main" });

  // Reject unsafe branch names (leading dash, invalid ref format).
  for (const bad of ["-b", "--detach", "bad..name", "bad name", "HEAD", "@"]) {
    const res = await api("POST", "/v1/codex/git/checkout", { path: r, branch: bad, create: true });
    assert.equal(res.status, 400, `expected 400 for branch ${bad}, got ${res.status}`);
  }
});

test("discard restores tracked/staged files, removes untracked files, and refuses read-denied or escaping paths", async () => {
  const r = path.join(browse, "discard-repo");
  initRepo(r);

  // Tracked modified + tracked deleted + staged new + untracked + secret
  fs.writeFileSync(path.join(r, "src", "app.ts"), "dirty change\n");
  fs.unlinkSync(path.join(r, "remove-me.txt"));
  fs.writeFileSync(path.join(r, "staged-new.txt"), "temp staged\n");
  git(r, "add", "staged-new.txt");
  fs.writeFileSync(path.join(r, "scratch.txt"), "untracked temp\n");
  fs.writeFileSync(path.join(r, ".env"), "KEEP_ME=1\n");

  // Refuses read-denied file with 403 AND does not touch valid files in the same batch!
  const deniedBatch = await api("POST", "/v1/codex/git/discard", {
    path: r,
    files: ["scratch.txt", ".env"],
  });
  assert.equal(deniedBatch.status, 403);
  assert.equal(fs.existsSync(path.join(r, "scratch.txt")), true);
  assert.equal(fs.existsSync(path.join(r, ".env")), true);

  // Refuses traversal, absolute paths, and .git metadata with 400.
  for (const bad of ["../outside.txt", "/etc/passwd", ".git/config", "src/../../outside.txt"]) {
    const res = await api("POST", "/v1/codex/git/discard", { path: r, files: [bad] });
    assert.equal(res.status, 400, `expected 400 for discard path ${bad}, got ${res.status}`);
  }

  // Symlink parent escape refused with 400.
  fs.symlinkSync(outside, path.join(r, "linkdir"), "dir");
  fs.writeFileSync(path.join(outside, "victim.txt"), "do not delete\n");
  const symEscape = await api("POST", "/v1/codex/git/discard", { path: r, files: ["linkdir/victim.txt"] });
  assert.equal(symEscape.status, 400);
  assert.equal(fs.existsSync(path.join(outside, "victim.txt")), true);

  // Valid discard batch succeeds.
  const ok = await api("POST", "/v1/codex/git/discard", {
    path: r,
    files: ["src/app.ts", "remove-me.txt", "staged-new.txt", "scratch.txt"],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, {
    ok: true,
    discarded: ["src/app.ts", "remove-me.txt", "staged-new.txt", "scratch.txt"],
  });
  assert.equal(fs.readFileSync(path.join(r, "src", "app.ts"), "utf8"), "line1\nline2\nline3\nline4\n");
  assert.equal(fs.existsSync(path.join(r, "remove-me.txt")), true);
  assert.equal(fs.existsSync(path.join(r, "staged-new.txt")), false);
  assert.equal(fs.existsSync(path.join(r, "scratch.txt")), false);
});

test("commit stages all, respects fallback identity, supports stageAll=false, and pushes when requested", async () => {
  const r = path.join(browse, "commit-repo");
  const { remoteDir } = initRepo(r, { withRemote: true });

  // Rejects empty message or nothing to commit.
  assert.equal((await api("POST", "/v1/codex/git/commit", { path: r, message: "   " })).status, 400);
  assert.equal((await api("POST", "/v1/codex/git/commit", { path: r, message: "empty" })).status, 400);

  // Unset local user.name/email and test stageAll=false vs stageAll=true + push=true.
  fs.writeFileSync(path.join(r, "a-staged.txt"), "staged only\n");
  fs.writeFileSync(path.join(r, "b-unstaged.txt"), "not staged yet\n");
  git(r, "add", "a-staged.txt");

  const partial = await api("POST", "/v1/codex/git/commit", {
    path: r,
    message: "Commit staged only",
    stageAll: false,
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.json.ok, true);
  assert.equal(partial.json.branch, "main");
  assert.equal(partial.json.pushed, false);
  assert.match(partial.json.sha, /^[a-f0-9]{40}$/);
  assert.equal(partial.json.shortSha.length >= 7, true);

  // b-unstaged.txt should still be untracked.
  assert.equal(git(r, "status", "--porcelain"), "?? b-unstaged.txt");

  // Now commit with default stageAll=true and push=true.
  const pushed = await api("POST", "/v1/codex/git/commit", {
    path: r,
    message: "Commit all and push",
    push: true,
  });
  assert.equal(pushed.status, 200);
  assert.equal(pushed.json.ok, true);
  assert.equal(pushed.json.pushed, true);
  assert.equal(pushed.json.branch, "main");

  // Verify the bare remote received the commit.
  const remoteHead = execFileSync("git", ["--git-dir", remoteDir, "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();
  assert.equal(remoteHead, pushed.json.sha);
});

test("handles unborn repo, fallback git identity, rename-from-secret filtering, and untracked symlink isolation", async () => {
  const r = path.join(browse, "edge-repo");
  fs.mkdirSync(r, { recursive: true });
  git(r, "-c", "init.defaultBranch=main", "init");
  git(r, "config", "core.autocrlf", "false");
  git(r, "config", "commit.gpgsign", "false");

  // Unborn repo with staged + untracked + outside symlink
  fs.writeFileSync(path.join(r, "hello.txt"), "first\nsecond\n");
  fs.writeFileSync(path.join(r, "untracked.txt"), "third\n");
  fs.writeFileSync(path.join(outside, "top-secret.txt"), "DO_NOT_LEAK_THIS_LINE\n");
  fs.symlinkSync(path.join(outside, "top-secret.txt"), path.join(r, "escape-link.txt"));
  git(r, "add", "hello.txt");

  const unbornStatus = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(r)}`);
  assert.equal(unbornStatus.status, 200);
  assert.equal(unbornStatus.json.isGitRepo, true);
  assert.equal(unbornStatus.json.branch, "main");
  assert.equal(unbornStatus.json.dirty, true);
  const linkStatus = unbornStatus.json.files.find((f) => f.path === "escape-link.txt");
  assert.equal(linkStatus?.added ?? 0, 0, "outside symlink target must not be read");

  const unbornDiff = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}`);
  assert.equal(unbornDiff.status, 200);
  const serialized = JSON.stringify(unbornDiff.json);
  assert.equal(serialized.includes("DO_NOT_LEAK_THIS_LINE"), false, "outside symlink contents must never leak");
  assert.equal(unbornDiff.json.files.some((f) => f.path === "hello.txt" && f.added === 2), true);
  assert.equal(unbornDiff.json.files.some((f) => f.path === "untracked.txt" && f.added === 1), true);

  // Direct file diff request on symlink pointing outside repo must be refused (400).
  const directSymlinkDiff = await api(
    "GET",
    `/v1/codex/git/diff?path=${encodeURIComponent(r)}&file=escape-link.txt`,
  );
  assert.equal(directSymlinkDiff.status, 400);

  const unbornCommits = await api("GET", `/v1/codex/git/commits?path=${encodeURIComponent(r)}`);
  assert.equal(unbornCommits.status, 200);
  assert.deepEqual(unbornCommits.json, { branch: "main", commits: [] });

  // Remove the symlink, then test fallback git identity when no global/local user.name or user.email exists.
  fs.unlinkSync(path.join(r, "escape-link.txt"));
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevNoSys = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const firstCommit = await api("POST", "/v1/codex/git/commit", {
      path: r,
      message: "Initial commit via fallback identity",
    });
    assert.equal(firstCommit.status, 200);
    assert.equal(firstCommit.json.ok, true);
    const author = git(r, "log", "-1", "--format=%an <%ae>");
    assert.equal(author, "Relay <relay@localhost>");
  } finally {
    if (prevGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGlobal;
    if (prevNoSys === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = prevNoSys;
  }

  // Renaming a read-denied file (.env -> public.txt) must be filtered out of both status and diff.
  fs.writeFileSync(path.join(r, ".env"), "SECRET_TOKEN=abc123\n");
  git(r, "add", ".env");
  git(r, "commit", "-m", "commit env");
  git(r, "mv", ".env", "public.txt");

  const renamedStatus = await api("GET", `/v1/codex/git/status?path=${encodeURIComponent(r)}`);
  assert.equal(renamedStatus.status, 200);
  assert.equal(renamedStatus.json.files.some((f) => f.path === "public.txt" || f.oldPath === ".env"), false);

  const renamedDiff = await api("GET", `/v1/codex/git/diff?path=${encodeURIComponent(r)}`);
  assert.equal(renamedDiff.status, 200);
  assert.equal(JSON.stringify(renamedDiff.json).includes("SECRET_TOKEN"), false);
  assert.equal(renamedDiff.json.files.some((f) => f.path === "public.txt" || f.oldPath === ".env"), false);
});

