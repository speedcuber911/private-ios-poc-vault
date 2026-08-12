import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const { cmdHandoff, handoffBranchName } = await import("../src/commands/handoff.mjs");
const { writeCredentials } = await import("../src/creds.mjs");
const { generateEncKeyPair, openSealed, SEAL_MAGIC } = await import("../src/seal.mjs");
const { claudeProjectSlug } = await import("../src/sessions.mjs");

process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";

// A marker distinctive enough that it can only have come from the raw
// transcript, used to prove the pushed session.enc blob is ciphertext (I3):
// it must never appear literally in any pushed git object, and must appear
// after unsealing with the node's private key.
const TRANSCRIPT_CANARY = "CANARY-TRANSCRIPT-BODY-9f3a1";

async function scenario({ withSession = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-handoff-"));
  const work = path.join(root, "repo");
  const bare = path.join(root, "origin.git");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });

  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", bare);
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("push", "-q", "origin", "main");

  fs.writeFileSync(path.join(work, "wip.txt"), "unfinished work\n");

  if (withSession) {
    const dir = path.join(home, ".claude", "projects", claudeProjectSlug(fs.realpathSync(work)));
    fs.mkdirSync(dir, { recursive: true });
    const records = [
      { type: "user", cwd: fs.realpathSync(work), message: { content: "fix the auth redirect" } },
      { type: "assistant", message: { content: `Looking into it. ${TRANSCRIPT_CANARY}` } },
    ];
    fs.writeFileSync(path.join(dir, "11111111-1111-4111-8111-111111111111.jsonl"),
      `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }

  const node = generateEncKeyPair();
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: node.publicKeyB64 }, { home });

  // Records every call. `relay handoff` also refreshes the session index on a
  // best-effort basis, so this must tolerate non-JSON bodies and unrelated paths.
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    let body = null;
    if (typeof options.body === "string") { try { body = JSON.parse(options.body); } catch { body = null; } }
    calls.push({ pathname, body });
    if (pathname === "/v1/handoffs") {
      return { status: 201, json: async () => ({ handoff: { id: body.handoffId, state: "pending" } }) };
    }
    return { status: 500, json: async () => ({ error: "not_part_of_this_test" }) };
  };
  const handoffPings = () => calls.filter((call) => call.pathname === "/v1/handoffs");

  return { root, work, bare, home, node, calls, handoffPings, fetchImpl };
}

// Walks the working tree (never .git) and hashes every file's content by its
// path relative to root, so two snapshots can be compared for byte-for-byte
// equality without caring about mtimes or index stat-cache churn.
function snapshotFiles(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile()) continue;
      files[rel] = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
    }
  };
  walk(root);
  return files;
}

async function repoSnapshot(work) {
  const [{ stdout: porcelain }, { stdout: head }, { stdout: symbolicRef }] = await Promise.all([
    execFileAsync("git", ["-C", work, "status", "--porcelain", "-z"]),
    execFileAsync("git", ["-C", work, "rev-parse", "HEAD"]),
    execFileAsync("git", ["-C", work, "symbolic-ref", "HEAD"]),
  ]);
  return { porcelain, head: head.trim(), symbolicRef: symbolicRef.trim(), files: snapshotFiles(work) };
}

test("handoff branches, commits WIP, seals blobs, pushes, and pings", async () => {
  const s = await scenario();
  const lines = [];

  const result = await cmdHandoff([], {
    home: s.home, cwd: s.work, baseUrl: "https://cloud.test", fetchImpl: s.fetchImpl,
    log: (line) => lines.push(line), machine: "MacBook-Pro",
  });

  assert.match(result.branch, /^relay\/handoff-[a-f0-9]{12}$/);
  assert.equal(result.branch, `relay/handoff-${result.handoffId.slice(0, 12)}`);
  assert.ok(!result.branch.includes("fix"), "the branch name must not embed the prompt text");
  assert.equal(result.pushed, true);

  const { stdout: branches } = await execFileAsync("git", ["-C", s.bare, "branch", "--list"]);
  assert.match(branches, new RegExp(result.branch.replace("/", "\\/")));

  const { stdout: files } = await execFileAsync("git", ["-C", s.bare, "ls-tree", "-r", "--name-only", result.branch]);
  assert.match(files, /wip\.txt/, "uncommitted work travelled with the branch");
  assert.match(files, new RegExp(`\\.relay/handoff/${result.handoffId}/manifest\\.enc`));
  assert.match(files, new RegExp(`\\.relay/handoff/${result.handoffId}/session\\.enc`));

  const { stdout: wipContent } = await execFileAsync("git", ["-C", s.bare, "show", `${result.branch}:wip.txt`]);
  assert.equal(wipContent, "unfinished work\n", "the WIP content itself, not just the path, made it into the commit");

  assert.equal(s.handoffPings().length, 1, "exactly one ping per handoff");
  assert.deepEqual(Object.keys(s.handoffPings()[0].body).sort(), ["branch", "handoffId", "nodeId", "repo"]);
});

test("the sealed manifest is readable only by the node and describes the session", async () => {
  const s = await scenario();
  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout } = await execFileAsync("git",
    ["-C", s.bare, "show", `${result.branch}:.relay/handoff/${result.handoffId}/manifest.enc`],
    { encoding: "buffer" });
  const manifest = JSON.parse(openSealed(s.node.privateKeyPem, stdout).toString("utf8"));

  assert.equal(manifest.v, 1);
  assert.equal(manifest.harness, "claude");
  assert.equal(manifest.sessionFormat, "claude-jsonl");
  assert.equal(manifest.sessionId, "11111111-1111-4111-8111-111111111111");
  assert.equal(manifest.repo, path.basename(s.bare, ".git") ? manifest.repo : manifest.repo);
  assert.match(manifest.title, /fix the auth redirect/i);
  assert.equal(manifest.wip.files, 1);
  assert.ok(!stdout.includes(Buffer.from("fix the auth redirect", "utf8")), "the blob is ciphertext on disk");
});

test("with no local session the handoff still lands, marked session-less", async () => {
  const s = await scenario({ withSession: false });
  const lines = [];

  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: (line) => lines.push(line), machine: "MacBook-Pro" });

  const { stdout } = await execFileAsync("git",
    ["-C", s.bare, "show", `${result.branch}:.relay/handoff/${result.handoffId}/manifest.enc`], { encoding: "buffer" });
  const manifest = JSON.parse(openSealed(s.node.privateKeyPem, stdout).toString("utf8"));

  assert.equal(manifest.sessionFormat, "none");
  assert.equal(manifest.sessionId, null);
  assert.match(lines.join("\n"), /no local session/i);
});

test("the original branch and working tree are restored afterwards", async () => {
  const s = await scenario();
  await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout: branch } = await execFileAsync("git", ["-C", s.work, "rev-parse", "--abbrev-ref", "HEAD"]);
  assert.equal(branch.trim(), "main", "the user is left where they started");
  assert.equal(fs.readFileSync(path.join(s.work, "wip.txt"), "utf8"), "unfinished work\n",
    "their uncommitted work is still in the tree");
});

test("the working tree, index status, HEAD, and current branch are provably untouched", async () => {
  const s = await scenario();
  const before = await repoSnapshot(s.work);

  await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const after = await repoSnapshot(s.work);

  // Note: we deliberately do NOT compare .git/index byte-for-byte. Computing
  // the WIP summary above runs `git status`, which refreshes the index's stat
  // cache and rewrites the file with no semantic change — that would be a
  // false-positive failure. Porcelain output plus on-disk file content is the
  // property that actually matters.
  assert.equal(after.symbolicRef, before.symbolicRef, "HEAD still points at the same branch ref — no checkout ever happened");
  assert.equal(after.head, before.head, "the starting branch's commit did not move");
  assert.equal(after.porcelain.toString(), before.porcelain.toString(), "git status is byte-identical before and after");
  assert.deepEqual(after.files, before.files, "every file's content hash on disk is unchanged");
});

test("a file deleted from the working tree travels as a deletion, and the user's own deletion is left exactly as they made it", async () => {
  const s = await scenario();
  fs.rmSync(path.join(s.work, "README.md"));
  const before = await repoSnapshot(s.work);

  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout: branchFiles } = await execFileAsync("git", ["-C", s.bare, "ls-tree", "-r", "--name-only", result.branch]);
  assert.ok(!branchFiles.split("\n").includes("README.md"), "the deletion travelled with the handoff commit");

  const after = await repoSnapshot(s.work);
  assert.equal(after.symbolicRef, before.symbolicRef);
  assert.equal(after.head, before.head);
  assert.equal(after.porcelain.toString(), before.porcelain.toString(), "the user's own unstaged deletion is untouched");
  assert.deepEqual(after.files, before.files);
});

test("gitignored files never leave the machine, even sealed inside a handoff commit", async () => {
  const s = await scenario();
  fs.writeFileSync(path.join(s.work, ".gitignore"), ".env\n");
  fs.writeFileSync(path.join(s.work, ".env"), "SECRET=shh\n");

  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout: branchFiles } = await execFileAsync("git", ["-C", s.bare, "ls-tree", "-r", "--name-only", result.branch]);
  assert.ok(!branchFiles.split("\n").includes(".env"), ".env is gitignored and must never reach the pushed branch");
  assert.ok(branchFiles.split("\n").includes(".gitignore"), "the .gitignore file itself is untracked-but-not-ignored, so it does travel");
});

test("handoff refuses without a login or a pinned node key", async () => {
  const s = await scenario();
  const noKeyHome = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-handoff-nokey-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct" }, { home: noKeyHome });

  await assert.rejects(() => cmdHandoff([], { home: noKeyHome, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {} }), /no_machine_pinned/);
});

// Minor m6 (review's G3): no test previously drove `cmdHandoff` outside a
// github.com-origin repo — removing the requireGitHubRepo call from
// cmdHandoff entirely still passed the whole suite (verified behaviourally
// by the review, never by a unit test). This pins that a non-GitHub origin
// is refused before cmdHandoff touches the network at all. Deliberately does
// NOT use RELAY_ALLOW_LOCAL_REMOTE's bare-local-path form — gitlab.com is
// refused by parseGitHubRemote regardless of that env var, so this exercises
// the real guard cmdHandoff relies on in production, not the test bypass.
test("cmdHandoff refuses outside a github.com-origin repo, before touching the network (G3)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-handoff-g3-"));
  const work = path.join(root, "repo");
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", "https://gitlab.com/me/relay.git");
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");

  const node = generateEncKeyPair();
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: node.publicKeyB64 }, { home });

  let networkTouched = false;
  const fetchImpl = async () => { networkTouched = true; return { status: 500, json: async () => ({}) }; };

  await assert.rejects(() => cmdHandoff([], { home, cwd: work, baseUrl: "https://cloud.test", fetchImpl, log: () => {} }),
    /origin_not_github/);
  assert.equal(networkTouched, false, "the guard must fire before any network call");
});

test("--no-push stops before publishing and says so", async () => {
  const s = await scenario();
  const lines = [];
  const result = await cmdHandoff(["--no-push"], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: (line) => lines.push(line), machine: "MacBook-Pro" });

  assert.equal(result.pushed, false);
  assert.deepEqual(s.calls, [], "an unpublished handoff contacts the network not at all");
  const { stdout: branches } = await execFileAsync("git", ["-C", s.bare, "branch", "--list"]);
  assert.ok(!branches.includes("handoff"), "nothing reached the remote");
});

// Owner decision: the branch name must be opaque, derived only from the
// handoff id — never from the prompt/title — so that GitHub (a public repo's
// branch list is world-readable) and the control plane's handoff ping never
// learn what the user asked their agent to do. The 12-hex-char convention
// matches relayd's own checkout-directory naming (checkoutPathFor in
// product/relayd/src/handoff.mjs), so a branch and its eventual checkout
// stay recognizably the same handoff.
test("branch names are opaque (derived only from the handoff id) and bounded", () => {
  assert.equal(handoffBranchName("abc123def456"), "relay/handoff-abc123def456");
  assert.equal(handoffBranchName("abc123def4567890ff"), "relay/handoff-abc123def456", "only the first 12 chars of the id are used");
  assert.ok(handoffBranchName("x".repeat(200)).length <= 64);
  // handoffBranchName no longer takes a title/prompt at all — the only way
  // the branch can encode the id is via the handoff id.
  assert.equal(handoffBranchName.length, 1, "handoffBranchName must take only the handoff id, not a title");
});

// Important I3: the session transcript is the one blob that carries the
// whole conversation, pushed to a remote whose history is not revocable. The
// manifest already has a ciphertext assertion; session.enc had none, so a
// regression that pushed it in the clear (input: sessionBytes instead of
// input: sealTo(...)) would ship with all tests green.
test("the pushed session blob is genuinely sealed — ciphertext on the remote, exact plaintext after unsealing", async () => {
  const s = await scenario();
  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout } = await execFileAsync("git",
    ["-C", s.bare, "show", `${result.branch}:.relay/handoff/${result.handoffId}/session.enc`],
    { encoding: "buffer" });

  assert.ok(stdout.subarray(0, SEAL_MAGIC.length).equals(SEAL_MAGIC), "session.enc begins with the seal magic, not raw JSONL");
  assert.ok(!stdout.includes(Buffer.from(TRANSCRIPT_CANARY, "utf8")),
    "the plaintext transcript canary must never appear anywhere in the pushed session blob");

  const opened = openSealed(s.node.privateKeyPem, stdout);
  assert.ok(opened.includes(Buffer.from(TRANSCRIPT_CANARY, "utf8")),
    "unsealing with the node's private key recovers the exact transcript bytes, canary included");
});

// Important I4: a global constraint of the whole project ("no force-push,
// ever") enforced by nothing but the current spelling of one line. Injects
// execFileImpl to capture the real argv `relay handoff` hands to git.
test("the push is never forced — no --force/-f flag and no '+'-prefixed refspec, ever", async () => {
  const s = await scenario();
  const pushCalls = [];
  const execFileImpl = (...callArgs) => {
    const args = callArgs[1];
    if (Array.isArray(args) && args.includes("push")) pushCalls.push(args);
    return execFileAsync(...callArgs);
  };

  await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", execFileImpl });

  assert.equal(pushCalls.length, 1, "exactly one push per handoff");
  const argv = pushCalls[0];
  assert.ok(!argv.includes("--force") && !argv.includes("-f"), `push argv must never include a force flag: ${argv.join(" ")}`);
  assert.ok(!argv.some((a) => a.startsWith("+")), `push argv must never include a "+"-prefixed (force) refspec: ${argv.join(" ")}`);
});

// Minor m8: the fail-loudly collision guards (both local and remote) had no
// test — dropping either left all tests green. Forces a real collision by
// pinning the handoff id, the same method the review used.
test("a local branch-name collision fails loudly instead of silently overwriting", async () => {
  const s = await scenario();
  const handoffId = "aabbccddeeff0011";
  const first = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", handoffId });
  assert.equal(first.pushed, true);

  fs.writeFileSync(path.join(s.work, "wip2.txt"), "more work\n");
  await assert.rejects(() => cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", handoffId }),
    /branch_collision: .* already exists locally/);
});

test("a remote-only branch-name collision (local ref since removed) also fails loudly", async () => {
  const s = await scenario();
  const handoffId = "1122334455667788";
  const first = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", handoffId });
  assert.equal(first.pushed, true);

  // Remove only the local ref, so the local check passes and the remote
  // (`ls-remote`) check is the one that has to catch the collision.
  await execFileAsync("git", ["-C", s.work, "update-ref", "-d", `refs/heads/${first.branch}`]);

  fs.writeFileSync(path.join(s.work, "wip2.txt"), "more work\n");
  await assert.rejects(() => cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", handoffId }),
    /branch_collision: .* already exists on origin/);
});

// Minor m9: nothing asserted that the handoff commit descends from the
// user's HEAD — a root-commit handoff branch would push and ping happily
// while being unmergeable and undiffable against the user's history.
test("the handoff commit is not a root commit — it descends from the branch it was built from", async () => {
  const s = await scenario();
  const { stdout: headBefore } = await execFileAsync("git", ["-C", s.work, "rev-parse", "HEAD"]);

  const result = await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });

  const { stdout: parent } = await execFileAsync("git", ["-C", s.bare, "rev-parse", `${result.branch}^`]);
  assert.equal(parent.trim(), headBefore.trim(), "the handoff commit's sole parent is the commit the user was on");
});

// Minor m10: `no_git_identity` is regex-matching real git stderr, and had no
// test pinning it. Forces git's actual "empty ident" failure via explicitly
// empty GIT_AUTHOR_*/GIT_COMMITTER_* env vars — deterministic regardless of
// whatever user.name/email happens to be configured on the host running the
// suite (env vars win over config in git's identity resolution).
test("a real git 'no identity configured' failure is translated to the named error", async () => {
  const s = await scenario();
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "",
  };

  await assert.rejects(() => cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", env }), /no_git_identity/);
});

// Minor m11: cleanup of the throwaway GIT_INDEX_FILE had no test, on either
// the success or the failure path.
test("the throwaway index is cleaned up afterward, on both success and failure", async () => {
  const s = await scenario();
  const tmpBefore = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("relay-handoff-index-")));

  await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });
  const tmpAfterSuccess = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("relay-handoff-index-")));
  assert.deepEqual(tmpAfterSuccess, tmpBefore, "no leftover temp index file after a successful handoff");

  fs.writeFileSync(path.join(s.work, "wip2.txt"), "more\n");
  const env = { ...process.env, GIT_AUTHOR_NAME: "", GIT_AUTHOR_EMAIL: "", GIT_COMMITTER_NAME: "", GIT_COMMITTER_EMAIL: "" };
  await assert.rejects(() => cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro", env }), /no_git_identity/);

  const tmpAfterFailure = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("relay-handoff-index-")));
  assert.deepEqual(tmpAfterFailure, tmpBefore, "no leftover temp index file after a failed handoff either");
});

// Important I1: the code comment used to claim chmod-ing the throwaway index
// to 0600 "actually sticks" because it runs after the last git write. That is
// false — the very next call, `git write-tree`, rewrites the index via its
// own lock-then-rename (it stores the cache-tree extension) and hands it
// back at the process umask, typically 0644. Fixed step by step against real
// git and confirmed dead: the chmod is not merely narrow, it does nothing at
// all. This is deliberately not asserted here as "the file is 0600" (that
// claim is false both before and after the fix); it is asserted as the
// property that actually holds:  the index never sits as a loose,
// group/other-readable file directly in the ambient (possibly-shared, e.g.
// Linux's 1777) TMPDIR at any point during the run. It lives inside a
// dedicated 0700 directory for its whole lifetime, so the file's own mode
// stops mattering regardless of what git does to it.
//
// Note this cannot rely on macOS's TMPDIR already being 0700 per-user (the
// review's own explanation for why the leak went unnoticed) — that would
// pass "by accident" on this dev machine even without the fix. Instead it
// polls os.tmpdir() with a real timer, concurrently with a real in-flight
// handoff, and checks the *structural* location (dedicated directory vs. a
// bare file dropped straight in TMPDIR), which differs before and after the
// fix regardless of the platform's ambient TMPDIR mode.
test("the throwaway index lives inside its own private 0700 directory for its entire lifetime (I1)", async () => {
  const s = await scenario();
  // Modes are captured at observation time, not re-stat'd afterward: by the
  // time the poll loop stops, cmdHandoff's own `finally` may have already
  // removed the directory, and re-statting it then would race a real cleanup
  // (ENOENT), not prove anything false about the mode it actually had.
  const seenDirModes = new Map();
  const seenLooseFiles = new Set();
  const poll = setInterval(() => {
    let names;
    try {
      names = fs.readdirSync(os.tmpdir());
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith("relay-handoff-index-")) continue;
      const full = path.join(os.tmpdir(), name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue; // removed between readdir and stat; not a leak
      }
      if (stat.isDirectory()) seenDirModes.set(full, stat.mode & 0o777);
      else seenLooseFiles.add(full);
    }
  }, 5);

  try {
    await cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
      fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" });
  } finally {
    clearInterval(poll);
  }

  assert.equal(seenLooseFiles.size, 0,
    `the throwaway index must never be a loose file directly in TMPDIR: saw ${[...seenLooseFiles]}`);
  assert.ok(seenDirModes.size >= 1,
    "expected to observe the throwaway index's private directory at least once while the handoff was in flight");
  for (const [dir, mode] of seenDirModes) {
    assert.equal(mode, 0o700, `private index directory ${dir} must be 0700, got ${mode.toString(8)}`);
  }
});

// Minor m12: two hostile-but-realistic repo states surfaced a raw git fatal
// error instead of a named one. Neither loses data; both are unactionable as
// printed by `bin/relay`, which just prints error.message.
test("a pre-existing .relay/handoff FILE (not a directory) is refused with a named error", async () => {
  const s = await scenario();
  const git = (...gitArgs) => execFileAsync("git", ["-C", s.work, ...gitArgs]);
  fs.mkdirSync(path.join(s.work, ".relay"));
  fs.writeFileSync(path.join(s.work, ".relay", "handoff"), "not a directory\n");
  await git("add", "-A");
  await git("commit", "-qm", "pre-existing .relay/handoff file");

  await assert.rejects(() => cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" }), /handoff_path_conflict/);
});

test("an existing branch literally named 'relay' is refused with a named error, not a raw git fatal", async () => {
  const s = await scenario();
  await execFileAsync("git", ["-C", s.work, "branch", "relay"]);

  await assert.rejects(() => cmdHandoff([], { home: s.home, cwd: s.work, baseUrl: "https://cloud.test",
    fetchImpl: s.fetchImpl, log: () => {}, machine: "MacBook-Pro" }), /branch_path_conflict/);
});
