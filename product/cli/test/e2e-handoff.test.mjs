// End-to-end: `relay handoff` on a laptop-shaped repo, then relayd importing it
// on a sandbox-shaped machine. Nothing is mocked between the two halves — the
// CLI seals, relayd decrypts, and a fake harness proves the resume actually
// runs.
//
// WHY THIS FILE EXISTS. Every other test in this project fakes the other half:
// the CLI's tests stub `fetch` and never let relayd near the bytes, and
// relayd's tests build their own fixture ciphertext with relayd's own
// `sealTo`. Neither can see a contract drift between the two halves, because
// neither has both halves in the room. Here the manifest is built and sealed
// by `product/cli/src/*`, travels through a real `git push` to a real bare
// repository, and is opened and parsed by `product/relayd/src/*`. The only
// values shared between the two sides are the ones that genuinely cross the
// wire: the node's X25519 public key, and the {repo, branch, handoffId,
// nodeId} descriptor the control plane relays.
//
// THE FIVE CLAIMS, one test each. Each was verified to be able to FAIL by
// deliberately breaking the thing it checks and re-running (see
// `.superpowers/sdd/handoff/task-21-report.md`):
//
//   1. The manifest the CLI seals is the manifest relayd opens — every field
//      relayd reads, compared field-by-field against values this test derives
//      independently, never by calling the CLI's own buildManifest().
//   2. The transcript arrives byte-exact and is staged where Claude Code's own
//      --resume looks, with the laptop cwd rewritten to the sandbox worktree.
//   3. Nothing on the pushed branch is plaintext. EVERY object in the pushed
//      repository is scanned for a marker that exists only in the transcript,
//      with a positive control on the same bytes so the scan cannot be vacuous.
//   4. The user's working tree, index and HEAD are untouched by the whole flow.
//   5. A fake harness is really resumed with the right session id, and its
//      output streams back as an ordinary job.
//
// KNOWN RED — delete this paragraph when the product bug is fixed, not the
// assertion. Claim 5 currently FAILS with `session not found in runner
// CODEX_HOME` (jobs.mjs createJob -> threads.mjs findThreadResumeMeta). A
// freshly-imported Claude handoff stages its transcript at
// `<runHome>/.claude/projects/<slug>/<id>.jsonl`, but the resume validation
// only recognises a session that already has a job in this process or a Codex
// rollout under `<codexHome>/sessions`, so `Continue` on a Claude handoff —
// the feature's primary action — is rejected 100% of the time. Verified to be
// exactly this and nothing else: neutralising that one check in a throwaway
// copy of relayd turns this file green 6/6 with no other change. This is the
// contract drift the file exists to catch; do NOT weaken claim 5 to make the
// suite green.
//
// TWO TRAPS THIS FILE AVOIDS ON PURPOSE.
//
//   - No fixed sleeps. Every wait is `waitFor`: a predicate polled to a bounded
//     deadline, which fails with a message naming what never happened.
//   - `node:test`'s per-test `timeout` does NOT kill a hung async loop; it
//     marks the test cancelled and lets the work run on, orphaning child
//     processes. So there is a process-level watchdog below, and a final test
//     that asserts nothing was left running.
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.join(here, "..");
const relaydRoot = path.join(here, "..", "..", "relayd");
const relaydSrc = (name) => pathToFileURL(path.join(relaydRoot, "src", name)).href;

// ---------------------------------------------------------------------------
// Fixture constants. Every credential-shaped value here is an obvious
// placeholder; nothing real is ever written, printed or asserted on.

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE = "TestBook";
const CLOUD_BASE_URL = "https://cloud.test";
const CREATED_AT = 1_800_000_000_000;
const PLACEHOLDER_SESSION_TOKEN = "placeholder-session-token";
const PLACEHOLDER_ACCOUNT_ID = "placeholder-account";
const NODE_ID = "node-1";

// Appears in exactly one place in the whole fixture — the transcript body — so
// finding it anywhere in the pushed repository proves plaintext leaked, and
// finding it after unsealing proves the transcript really crossed the wire.
const TRANSCRIPT_MARKER = "zqxE2ETRANSCRIPTMARKERzqx";
// Sits inside the session TITLE — the field the branch name used to be slugged
// from. Deliberately lowercase alphanumeric so it survives slugification
// UNCHANGED: an earlier version of claim 3 scanned for the literal prompt
// ("finish the auth refactor") and a re-slugged branch name
// ("...-finish-the-auth-refactor") sailed straight past it. Verified by
// mutation: re-adding the slug to the branch name now fails claim 3.
const TITLE_MARKER = "zqxtitlemarkerzqx";
const SESSION_TITLE = `finish the auth refactor ${TITLE_MARKER}`;
// The user's own uncommitted work. This one IS plaintext on the branch by
// design (§9 of the design spec: the repo content is the user's already), so it
// is the positive control that proves the plaintext scan can find things.
const WIP_BODY = "half-finished refactor\n";

// Bounded waits. `node --test` cancels a test on its own timeout but leaves the
// work running, so the real backstop is this process-level watchdog.
const HARD_DEADLINE_MS = Number(process.env.RELAY_E2E_DEADLINE_MS || 180_000);
const WAIT_TIMEOUT_MS = 30_000;

const watchdog = setTimeout(() => {
  // Nothing in-process can interrupt a blocked SYNCHRONOUS call; this covers
  // the async case (a wedged poll, a child that never exits) and makes the
  // failure loud and childless instead of a silent orphan.
  process.stderr.write(`e2e-handoff: hard deadline of ${HARD_DEADLINE_MS}ms exceeded; exiting\n`);
  process.exit(97);
}, HARD_DEADLINE_MS);
watchdog.unref?.();

// ---------------------------------------------------------------------------
// Sandbox + laptop layout, and the environment relayd freezes at import time.
//
// relayd reads CODEX_* out of the environment ONCE, when config.mjs is first
// imported, and realpaths the browse root then — so every directory has to
// exist and every variable has to be set before the first relayd import below.

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-e2e-")));
const laptopHome = path.join(root, "laptop-home");
const work = path.join(root, "repo");
const bare = path.join(root, "origin.git");
const sandboxRoot = path.join(root, "sandbox");
const workspaceRoot = path.join(sandboxRoot, "workspaces");
const runHome = path.join(sandboxRoot, "home");
const identityDir = path.join(sandboxRoot, "identity");
const harnessLog = path.join(root, "harness-invocation.json");
const fakeClaude = path.join(root, "fake-claude");

for (const dir of [laptopHome, workspaceRoot, path.join(workspaceRoot, "welcome"), runHome]) {
  fs.mkdirSync(dir, { recursive: true });
}

// Private TMPDIR for the whole run. `relay handoff` builds its commit against a
// throwaway index inside `fs.mkdtemp(os.tmpdir(), "relay-handoff-index-")`, and
// claim 4 asserts that directory is cleaned up — but `node --test test/*` runs
// the sibling handoff test file concurrently in another process, whose own
// transient index directory shows up in the shared /tmp and failed that
// assertion. `os.tmpdir()` re-reads TMPDIR on every call, so pointing it at our
// own tree makes the check observe only what THIS flow created.
const privateTmp = path.join(root, "tmp");
fs.mkdirSync(privateTmp, { recursive: true });
process.env.TMPDIR = privateTmp;

// A harness that records exactly how it was invoked. It is a real executable
// spawned by the real jobs engine — the point is to prove the resume argv, the
// cwd and the HOME the harness would actually see, not to simulate them.
fs.writeFileSync(
  fakeClaude,
  `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(process.env.RELAY_E2E_HARNESS_LOG, JSON.stringify({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    home: process.env.HOME,
    pid: process.pid,
    prompt: Buffer.concat(chunks).toString("utf8"),
  }));
  process.stdout.write("RESUMED-OK\\n");
});
`,
  { mode: 0o755 },
);

process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";
process.env.RELAY_E2E_HARNESS_LOG = harnessLog;
process.env.CLAUDE_BIN = fakeClaude;
process.env.CODEX_DATA_DIR = path.join(sandboxRoot, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = workspaceRoot;
process.env.CODEX_WORKSPACES = JSON.stringify([
  { id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") },
]);
process.env.CODEX_RUN_HOME = runHome;
process.env.CODEX_HOME = path.join(runHome, ".codex");
// The push-back loop and the pickup long-poll are other tasks' territory; this
// test drives importHandoff/continueHandoff directly so nothing dials out.
process.env.RELAYD_HANDOFF_ENABLED = "false";
process.env.RELAYD_WORKTREE_MODE = "false";

process.on("exit", () => {
  if (process.env.RELAY_E2E_KEEP === "1") return;
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* the temp tree is best-effort cleanup; never mask a real failure */
  }
});

// ── the two halves, imported from their own trees, sharing no runtime state ──
const { claudeProjectSlug } = await import(pathToFileURL(path.join(cliRoot, "src", "sessions.mjs")).href);
const { writeCredentials } = await import(pathToFileURL(path.join(cliRoot, "src", "creds.mjs")).href);
const { cmdHandoff } = await import(pathToFileURL(path.join(cliRoot, "src", "commands", "handoff.mjs")).href);

const { initIdentity, identityPaths, readEncPublicKeyB64, readEncPrivateKeyPem } =
  await import(relaydSrc("identity.mjs"));
const { openSealed } = await import(relaydSrc("seal.mjs"));
const { importHandoff, continueHandoff, checkoutPathFor } = await import(relaydSrc("handoff.mjs"));
const { store } = await import(relaydSrc("store.mjs"));
const { jobs, activeChildren } = await import(relaydSrc("jobs.mjs"));
const { currentEventCursor, replayEventsSince } = await import(relaydSrc("events.mjs"));

// ---------------------------------------------------------------------------
// Helpers.

// A predicate polled to a bounded deadline. Never a fixed sleep: a fixed sleep
// is either flaky or slow, and it cannot say what it was waiting for.
async function waitFor(what, predicate, { timeoutMs = WAIT_TIMEOUT_MS, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const git = (repo, ...args) => execFileAsync("git", ["-C", repo, ...args]);

function walkFiles(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

// Everything a holder of the pushed repository can read: every git object's
// DECOMPRESSED content (blobs, trees, commits, tags — packed and loose alike),
// every ref name and subject, and every raw file in the repository directory.
// Deliberately not "the paths I expect the blobs at": a leak that lands
// somewhere else must still be caught.
async function pushedRepositoryBytes(repo) {
  const chunks = [];
  const { stdout: objects } = await execFileAsync(
    "git",
    ["-C", repo, "cat-file", "--batch-all-objects", "--batch", "--buffer"],
    { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 },
  );
  chunks.push(objects);
  const { stdout: refs } = await execFileAsync(
    "git",
    ["-C", repo, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(subject)%00%(contents)"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  chunks.push(refs);
  for (const file of walkFiles(repo)) chunks.push(fs.readFileSync(file));
  return Buffer.concat(chunks);
}

// Hashes every working-tree file by its path relative to root, ignoring .git,
// so two snapshots compare byte-for-byte without caring about mtimes.
function snapshotWorkingTree(dir) {
  const files = {};
  for (const file of walkFiles(dir)) {
    const rel = path.relative(dir, file);
    if (rel === ".git" || rel.startsWith(`.git${path.sep}`)) continue;
    files[rel] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  }
  return files;
}

async function snapshotRepo(dir) {
  const [{ stdout: porcelain }, { stdout: head }, { stdout: symbolic }, { stdout: refs }] = await Promise.all([
    git(dir, "status", "--porcelain", "-z", "--untracked-files=all"),
    git(dir, "rev-parse", "HEAD"),
    git(dir, "symbolic-ref", "HEAD"),
    git(dir, "for-each-ref", "--format=%(refname) %(objectname)"),
  ]);
  return {
    porcelain,
    head: head.trim(),
    symbolicRef: symbolic.trim(),
    refs: refs.trim().split("\n").filter(Boolean).sort(),
    // The handoff commit is built against a throwaway GIT_INDEX_FILE, so the
    // user's REAL index must come out byte-identical. Hashing it is the only
    // way to notice a plumbing call that forgot to carry the override.
    index: crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, ".git", "index"))).digest("hex"),
    files: snapshotWorkingTree(dir),
  };
}

function tmpHandoffIndexDirs() {
  try {
    return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith("relay-handoff-index-"));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The scenario, built once and shared by the five claim tests. Anything that
// throws in here is reported by the first test; the rest then fail with a
// message that says the scenario never completed rather than a cascade of
// undefined-property errors.

const state = { ready: false };

function scenario() {
  assert.ok(state.ready, `the scenario did not complete: ${state.error || "unknown reason"}`);
  return state;
}

async function buildScenario() {
  // ── sandbox side: a node identity whose public key the laptop seals to.
  initIdentity({ baseDir: identityDir });
  const nodeEncPubkey = readEncPublicKeyB64(identityPaths(identityDir));
  assert.ok(nodeEncPubkey, "the sandbox node must publish an X25519 encryption key");

  // ── laptop side: a repo with a github-shaped origin (a file:// bare repo
  //    under the RELAY_ALLOW_LOCAL_REMOTE test override), uncommitted work of
  //    two kinds, and a Claude Code session belonging to that path.
  await execFileAsync("git", ["init", "-q", "--bare", bare]);
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  await git(work, "config", "user.email", "t@example.com");
  await git(work, "config", "user.name", "T");
  await git(work, "config", "commit.gpgsign", "false");
  await git(work, "remote", "add", "origin", `file://${bare}`);
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git(work, "add", "-A");
  await git(work, "commit", "-qm", "initial");
  await git(work, "push", "-q", "origin", "main");

  // A tracked modification (+2 lines) and an untracked file (+1 line): the WIP
  // summary in the manifest is checked against both, so a change that counted
  // only one of them would show up.
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n\nnotes\n");
  fs.writeFileSync(path.join(work, "wip.txt"), WIP_BODY);

  const realWork = fs.realpathSync(work);
  const transcript =
    `${JSON.stringify({ type: "user", cwd: realWork, message: { content: SESSION_TITLE } })}\n` +
    `${JSON.stringify({
      type: "assistant",
      cwd: realWork,
      message: { content: `still editing ${realWork}/src/auth.ts, ${TRANSCRIPT_MARKER}` },
    })}\n`;
  const sessionDir = path.join(laptopHome, ".claude", "projects", claudeProjectSlug(realWork));
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(path.join(sessionDir, `${SESSION_ID}.jsonl`), transcript);

  writeCredentials(
    {
      sessionToken: PLACEHOLDER_SESSION_TOKEN,
      accountId: PLACEHOLDER_ACCOUNT_ID,
      nodeId: NODE_ID,
      nodeEncPubkey,
    },
    { home: laptopHome },
  );

  const before = await snapshotRepo(work);
  const tmpDirsBefore = new Set(tmpHandoffIndexDirs());

  // ── run the handoff, capturing the ping the control plane would have seen.
  const pings = [];
  const otherCalls = [];
  const handoff = await cmdHandoff([], {
    home: laptopHome,
    cwd: work,
    baseUrl: CLOUD_BASE_URL,
    log: () => {},
    machine: MACHINE,
    now: () => CREATED_AT,
    // Only the handoff ping matters here; the best-effort session-index
    // refresh that follows it is allowed to fail against this stub.
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname !== "/v1/handoffs") {
        otherCalls.push({ pathname, body: typeof options.body === "string" ? options.body : null });
        return { status: 500, json: async () => ({ error: "not_part_of_this_test" }) };
      }
      pings.push(JSON.parse(options.body));
      return { status: 201, json: async () => ({ handoff: { id: pings.at(-1).handoffId, state: "pending" } }) };
    },
  });

  const afterHandoff = await snapshotRepo(work);

  // ── the sandbox picks it up from the very descriptor the cloud would relay.
  // Only {id, repo, branch} crosses; nothing else from the CLI's process is
  // handed to relayd, and the blobs are read back out of the pushed repo.
  const events = [];
  const record = await importHandoff(
    { id: pings[0].handoffId, repo: pings[0].repo, branch: pings[0].branch },
    {
      cloud: {
        postEvent: async (type) => {
          events.push(type);
          return { status: 202 };
        },
      },
      baseDir: identityDir,
      runHome,
      remoteUrlFor: () => `file://${bare}`,
    },
  );

  Object.assign(state, {
    ready: true,
    nodeEncPubkey,
    realWork,
    transcript,
    handoff,
    pings,
    otherCalls,
    record,
    events,
    before,
    afterHandoff,
    tmpDirsBefore,
    checkout: record.state === "ready" ? checkoutPathFor(record.id) : null,
  });
}

// ---------------------------------------------------------------------------
// Claim 1 — the manifest the CLI seals is the manifest relayd opens.

test("claim 1: every manifest field survives a real seal/push/clone/decrypt round trip", async () => {
  try {
    await buildScenario();
  } catch (error) {
    state.error = error?.stack || String(error);
    throw error;
  }
  const s = scenario();

  assert.equal(s.record.state, "ready", `import failed: ${s.record.error}`);
  assert.deepEqual(s.events, ["handoff.ready"]);

  // The descriptor the control plane relayed carries names only, and the
  // branch is opaque — no slug of the user's prompt.
  assert.equal(s.pings.length, 1);
  assert.deepEqual(s.pings[0], {
    handoffId: s.handoff.handoffId,
    repo: "local/origin",
    branch: `relay/handoff-${s.handoff.handoffId.slice(0, 12)}`,
    nodeId: NODE_ID,
  });
  assert.match(s.handoff.branch, /^relay\/handoff-[0-9a-f]{12}$/);

  // Every field relayd's parseManifest reads, compared against values derived
  // here rather than by calling the CLI's own buildManifest. A rename, a
  // dropped field or a changed type on either side fails this outright.
  const persisted = store.getHandoff(s.record.id);
  assert.deepEqual(persisted.manifest, {
    v: 1,
    id: s.handoff.handoffId,
    harness: "claude",
    sessionId: SESSION_ID,
    sessionFormat: "claude-jsonl",
    title: SESSION_TITLE,
    repo: "local/origin",
    baseBranch: "main",
    branch: s.handoff.branch,
    cwd: s.realWork,
    machine: MACHINE,
    createdAt: CREATED_AT,
    wip: { files: 2, insertions: 3, deletions: 0, summary: "2 files changed, +3/-0" },
    excerpt: `${SESSION_TITLE}\nstill editing ${s.realWork}/src/auth.ts, ${TRANSCRIPT_MARKER}`,
  });

  // And the fields relayd derives from it for the phone and for the resume.
  assert.deepEqual(
    {
      provider: persisted.provider,
      resumeSessionId: persisted.resumeSessionId,
      primedPrompt: persisted.primedPrompt,
      title: persisted.title,
      repo: persisted.repo,
      branch: persisted.branch,
      error: persisted.error,
    },
    {
      provider: "claude",
      resumeSessionId: SESSION_ID,
      primedPrompt: null,
      title: SESSION_TITLE,
      repo: "local/origin",
      branch: s.handoff.branch,
      error: null,
    },
  );
});

// ---------------------------------------------------------------------------
// Claim 2 — the transcript arrives byte-exact, staged where --resume looks.

test("claim 2: the transcript is byte-exact on the wire and staged for --resume with the cwd rewritten", async () => {
  const s = scenario();

  // (a) Byte-exact on the wire: unseal the blob that is actually on the pushed
  //     branch with the node's private key and compare against the file the
  //     laptop had. The CLI sealed with product/cli/src/seal.mjs; this opens
  //     with product/relayd/src/seal.mjs. Nothing is shared but the key.
  const { stdout: sealed } = await execFileAsync(
    "git",
    ["-C", bare, "show", `${s.handoff.branch}:.relay/handoff/${s.handoff.handoffId}/session.enc`],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  assert.equal(sealed.subarray(0, 8).toString("latin1"), "RLYSEAL1", "the pushed blob must be a sealed envelope");
  const opened = openSealed(readEncPrivateKeyPem(identityPaths(identityDir)), sealed);
  assert.deepEqual(opened, Buffer.from(s.transcript, "utf8"), "the transcript crossed the wire byte-for-byte");

  // (b) Staged exactly where Claude Code's own resume mechanism looks: under
  //     the runner HOME, keyed by the slug of the SANDBOX worktree.
  const staged = path.join(runHome, ".claude", "projects", claudeProjectSlug(s.checkout), `${SESSION_ID}.jsonl`);
  assert.ok(fs.existsSync(staged), `the session must be staged at ${path.relative(root, staged)}`);
  const stagedText = fs.readFileSync(staged, "utf8");

  // (c) The laptop path is gone and the sandbox worktree path is in its place —
  //     and the rewrite changed NOTHING else: substituting back reproduces the
  //     original transcript byte-for-byte.
  assert.ok(!stagedText.includes(s.realWork), "the laptop path must not survive into the sandbox");
  assert.ok(stagedText.includes(s.checkout), "the cwd must be rewritten to the sandbox worktree path");
  assert.equal(
    stagedText.split(s.checkout).join(s.realWork),
    s.transcript,
    "the rewrite must touch the cwd and nothing else",
  );

  // (d) The uncommitted work crossed too — that is the other half of a handoff.
  assert.equal(fs.readFileSync(path.join(s.checkout, "wip.txt"), "utf8"), WIP_BODY);
  assert.equal(fs.readFileSync(path.join(s.checkout, "README.md"), "utf8"), "# repo\n\nnotes\n");
});

// ---------------------------------------------------------------------------
// Claim 3 — nothing on the pushed branch is plaintext.

test("claim 3: no transcript plaintext exists anywhere in the pushed repository", async () => {
  const s = scenario();
  const bytes = await pushedRepositoryBytes(bare);

  // POSITIVE CONTROL, on the very same bytes: the user's own uncommitted work
  // IS plaintext on the branch (it is theirs already — design spec §9), so if
  // the scan cannot find that, the scan is broken and the negative below means
  // nothing. This is the check that stops this test from being the "cloud
  // stores no content" test that passed with a canary sitting in a content
  // column.
  assert.ok(bytes.includes(WIP_BODY.trim()), "the plaintext scan must be able to find plaintext at all");
  assert.ok(bytes.includes("relay: handoff"), "the scan must reach commit messages too");

  // THE CLAIM: the transcript marker exists nowhere a holder of this repository
  // can read it — no blob, no tree, no commit message, no ref name, no file.
  assert.ok(
    !bytes.includes(TRANSCRIPT_MARKER),
    "the transcript marker must never appear in any pushed object, ref or file",
  );
  // Nor the prompt text that used to be slugged into the branch name. The
  // marker is searched CASE-INSENSITIVELY and is lowercase-alphanumeric on
  // purpose, so a slugged, lowercased branch name ("...-finish-the-auth-
  // refactor-zqxtitlemarkerzqx") is caught too — searching for the literal
  // phrase alone is not enough, and a mutation proved it.
  const searchable = bytes.toString("latin1").toLowerCase();
  assert.ok(!searchable.includes(TITLE_MARKER), "the session title must not reach the remote, raw or slugged");
  assert.ok(!bytes.includes("finish the auth refactor"), "the session title must not reach the remote in the clear");

  // The control plane is told names only: no field of the ping, and nothing
  // the CLI sent anywhere else, carries transcript or title text.
  const everythingSentToTheCloud = (JSON.stringify(s.pings) + JSON.stringify(s.otherCalls)).toLowerCase();
  assert.ok(!everythingSentToTheCloud.includes(TRANSCRIPT_MARKER.toLowerCase()));
  assert.ok(!everythingSentToTheCloud.includes(TITLE_MARKER));
  assert.ok(!everythingSentToTheCloud.includes("finish the auth refactor"));

  // Belt and braces on the blob paths themselves: the only .relay/handoff
  // entries on the branch are the two sealed envelopes.
  const { stdout: tracked } = await git(bare, "ls-tree", "-r", "--name-only", s.handoff.branch);
  const blobPaths = tracked.split("\n").filter((name) => name.startsWith(".relay/"));
  assert.deepEqual(blobPaths.sort(), [
    `.relay/handoff/${s.handoff.handoffId}/manifest.enc`,
    `.relay/handoff/${s.handoff.handoffId}/session.enc`,
  ]);
  for (const blobPath of blobPaths) {
    const { stdout: blob } = await execFileAsync("git", ["-C", bare, "show", `${s.handoff.branch}:${blobPath}`], {
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
    });
    assert.equal(blob.subarray(0, 8).toString("latin1"), "RLYSEAL1", `${blobPath} must be sealed`);
  }

  // And the blobs exist ONLY on the handoff branch (the design's new invariant).
  const { stdout: onMain } = await git(bare, "ls-tree", "-r", "--name-only", "main");
  assert.ok(!onMain.includes(".relay/"), "handoff blobs must exist only on relay/handoff-* branches");
});

// ---------------------------------------------------------------------------
// Claim 4 — the user's working tree, index and HEAD are untouched.

test("claim 4: the laptop's working tree, index and HEAD are untouched by the whole flow", async () => {
  const s = scenario();
  const after = await snapshotRepo(work);

  // Compared at three points: before the handoff, straight after it, and after
  // the sandbox has imported and (claim 5) resumed. A checkout, a stash, a
  // moved HEAD or a written index would show up in one of them.
  for (const [label, snapshot] of [["immediately after handoff", s.afterHandoff], ["at the end of the flow", after]]) {
    assert.equal(snapshot.head, s.before.head, `HEAD moved ${label}`);
    assert.equal(snapshot.symbolicRef, s.before.symbolicRef, `the checked-out branch changed ${label}`);
    assert.equal(snapshot.porcelain, s.before.porcelain, `the working tree status changed ${label}`);
    assert.deepEqual(snapshot.files, s.before.files, `working-tree file content changed ${label}`);
    assert.equal(snapshot.index, s.before.index, `the user's .git/index was written ${label}`);
  }

  // The only refs that may appear are the handoff branch and the
  // remote-tracking ref `git push` maintains for it — and nothing that already
  // existed may have moved. Anything else (a moved main, a rewritten
  // origin/main, a stash ref) fails here.
  const { stdout: handoffSha } = await git(work, "rev-parse", `refs/heads/${s.handoff.branch}`);
  const beforeRefs = new Set(s.before.refs);
  const added = after.refs.filter((ref) => !beforeRefs.has(ref));
  assert.deepEqual(
    added,
    [
      `refs/heads/${s.handoff.branch} ${handoffSha.trim()}`,
      `refs/remotes/origin/${s.handoff.branch} ${handoffSha.trim()}`,
    ].sort(),
    "only the handoff branch and its remote-tracking ref may be created",
  );
  const afterRefs = new Set(after.refs);
  for (const ref of s.before.refs) assert.ok(afterRefs.has(ref), `an existing ref changed or vanished: ${ref}`);

  // The handoff commit sits on top of the HEAD the user left behind — it is a
  // new commit, not a rewrite of theirs, and HEAD is still its parent.
  const { stdout: parent } = await git(work, "rev-parse", `refs/heads/${s.handoff.branch}^`);
  assert.equal(parent.trim(), s.before.head, "the handoff commit must be a child of the untouched HEAD");
  assert.notEqual(handoffSha.trim(), s.before.head);

  // No stash was created, and no throwaway index directory was left behind.
  await assert.rejects(() => git(work, "rev-parse", "--verify", "refs/stash"), "the flow must never stash");
  const leaked = tmpHandoffIndexDirs().filter((name) => !s.tmpDirsBefore.has(name));
  assert.deepEqual(leaked, [], "the throwaway GIT_INDEX_FILE directory must be removed");
});

// ---------------------------------------------------------------------------
// Claim 5 — a fake harness is really resumed, and streams back as a job.

test("claim 5: continuing the handoff resumes the fake harness with the right session id", async () => {
  const s = scenario();
  const cursor = currentEventCursor();

  const job = await continueHandoff(s.record.id, { prompt: "keep going" });
  assert.deepEqual(
    { workspaceId: job.workspaceId, provider: job.provider, resumeSessionId: job.resumeSessionId },
    { workspaceId: s.record.workspaceId, provider: "claude", resumeSessionId: SESSION_ID },
    "the resume id and the imported workspace must both reach the job",
  );
  assert.equal(store.getHandoff(s.record.id).lastJobId, job.id, "the handoff must remember its job");

  const finished = await waitFor(
    `job ${job.id} to reach a terminal state`,
    () => {
      const current = jobs.get(job.id);
      return current && ["succeeded", "failed", "cancelled", "timeout"].includes(current.status) ? current : null;
    },
  );
  assert.equal(finished.status, "succeeded", `the resume job failed: ${finished.error}`);
  assert.equal(finished.exitCode, 0);

  // The harness really ran, in the imported checkout, under the runner HOME
  // where the transcript was staged, with the harness's own resume flag.
  const invocation = JSON.parse(await waitFor("the harness to record its invocation", () =>
    (fs.existsSync(harnessLog) ? fs.readFileSync(harnessLog, "utf8") : null)));
  const resumeAt = invocation.argv.indexOf("--resume");
  assert.notEqual(resumeAt, -1, `the harness was not asked to resume: ${JSON.stringify(invocation.argv)}`);
  assert.equal(invocation.argv[resumeAt + 1], SESSION_ID, "the harness resumed the wrong session");
  assert.ok(!invocation.argv.includes("--session-id"), "a resume must not also start a fresh session");
  assert.equal(invocation.cwd, s.checkout, "the harness must run inside the imported checkout");
  assert.equal(invocation.home, runHome, "the harness must see the HOME the transcript was staged under");
  assert.equal(invocation.prompt, "keep going", "the caller's prompt must reach the harness");

  // Its output came back as an ordinary job: captured result, persisted log,
  // and job-state events on the same feed every other job uses.
  assert.equal(finished.result, "RESUMED-OK");
  assert.match(fs.readFileSync(finished.stdoutPath, "utf8"), /RESUMED-OK/);
  const names = replayEventsSince(cursor, 200)
    .filter((event) => event.data?.id === job.id)
    .map((event) => event.name);
  assert.ok(names.length > 0, "the job must publish state events like any other job");

  state.harnessPid = invocation.pid;
});

// ---------------------------------------------------------------------------
// No strays. `node --test`'s own timeout would have left them running.

test("the flow leaves no running children behind", async () => {
  clearTimeout(watchdog);
  // Bounded wait, not an instant assertion: if an earlier test bailed out
  // mid-job the child is legitimately still finishing, and reporting that as a
  // stray would be a false alarm on top of a real failure. A child that is
  // genuinely wedged never satisfies this and the wait fails, naming it.
  try {
    await waitFor("the jobs engine to go idle", () => activeChildren.size === 0);
  } finally {
    // Never leave one behind, not even while reporting one.
    for (const active of activeChildren.values()) {
      try {
        active.child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  if (state.harnessPid) {
    assert.throws(
      () => process.kill(state.harnessPid, 0),
      (error) => error.code === "ESRCH",
      `the fake harness (pid ${state.harnessPid}) is still alive`,
    );
  }
  store.close?.();
});
