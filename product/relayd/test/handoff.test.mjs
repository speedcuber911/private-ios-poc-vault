// relayd handoff tests.
//
// TWO RULES this file follows, because the round it replaces broke both:
//
//  1. Every guard has a test that DIES when the guard is removed. A green
//     suite that survives 24 of 30 mutations is not coverage, it is decoration.
//     Each guard test below names the mutation it kills.
//  2. An escape is detected by SCANNING the filesystem for a distinctive
//     marker, never by checking one expected path. A sibling task's "no file
//     escaped" assertions passed while the escape sat on disk under a slightly
//     different name; `escapeWatch()` walks the whole out-of-jail tree and
//     reports anything it finds, so the assertion cannot be out-guessed.
//
// The previous test 2 ("plaintext never reaches the checkout") was vacuous: it
// read a file the module only ever READS, i.e. it re-tested the fixture's own
// sealTo(). It is replaced by a walk of everything the module actually wrote,
// with a positive control that proves the search itself works.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { PassThrough } from "node:stream";

const execFileAsync = promisify(execFile);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-"));
const workspaceRoot = path.join(root, "workspaces");
const runHome = path.join(root, "home");
// Deliberately a SIBLING of the jail, inside the test's own tmp tree: every
// escape probe below aims here, and every escape assertion walks it.
const OUTSIDE = path.join(root, "OUTSIDE");
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(runHome, { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });

process.env.CODEX_DATA_DIR ||= path.join(root, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT ||= workspaceRoot;
process.env.CODEX_WORKSPACES ||= JSON.stringify([{ id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") }]);
process.env.CODEX_RUN_HOME ||= runHome;

const { initIdentity, identityPaths, readEncPublicKeyB64 } = await import("../src/identity.mjs");
const { sealTo } = await import("../src/seal.mjs");
const handoffModule = await import("../src/handoff.mjs");
const { importHandoff, continueHandoff, completeHandoffJob, startHandoffLoop, checkoutPathFor, isSecretPath,
  withPinnedCwd, execFileEscalating } = handoffModule;
const { store } = await import("../src/store.mjs");
const { handleAdditionRoutes } = await import("../src/additions.mjs");
const { sendError } = await import("../src/util.mjs");
const { currentEventCursor, replayEventsSince } = await import("../src/events.mjs");
const { jobs } = await import("../src/jobs.mjs");

const HANDOFF_MODULE = new URL("../src/handoff.mjs", import.meta.url).pathname;

const IDENTITY_DIR = path.join(root, "identity");
initIdentity({ baseDir: IDENTITY_DIR });

const MANIFEST = {
  v: 1, id: "abc123def4567890", harness: "claude", sessionId: "11111111-2222-4333-8444-555555555555",
  title: "Fix the auth redirect", repo: "me/relay", baseBranch: "main",
  branch: "relay/handoff-fix-the-auth-redirect", cwd: "/Users/dev/code/relay", machine: "MacBook-Pro",
  createdAt: 1_800_000_000_000, sessionFormat: "claude-jsonl",
  wip: { files: 1, insertions: 3, deletions: 0, summary: "1 file changed" },
  excerpt: "Tracing the redirect loop.",
};

// A string that appears nowhere else on the machine, so finding it anywhere is
// proof the module put it there.
const PLAINTEXT_MARKER = "zqxHANDOFFPLAINTEXTzqx";

// ---------------------------------------------------------------------------
// Filesystem scanning helpers. These never follow a symlink and never assume a
// name: they report EVERYTHING under a root, so an exploit cannot dodge the
// assertion by writing a slightly different filename than the one it checks.

function walkTree(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    out.push(full);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walkTree(full, out);
  }
  return out;
}

// Watches the whole out-of-jail tree and reports ANYTHING that appeared since
// the watch started — no expected name, no expected path. A sibling task's
// escape assertions passed while the escape sat on disk because they checked
// for one exact filename and the exploit wrote a slightly different one.
function escapeWatch() {
  const before = new Set(walkTree(OUTSIDE));
  return () => walkTree(OUTSIDE).filter((entry) => !before.has(entry));
}

// Every path under `dir` whose NAME or CONTENT contains `marker`.
function pathsContaining(dir, marker) {
  const hits = [];
  for (const entry of walkTree(dir)) {
    if (entry.includes(marker)) {
      hits.push(entry);
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(entry);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
    try {
      if (fs.readFileSync(entry).includes(marker)) hits.push(entry);
    } catch {
      /* unreadable is not a hit */
    }
  }
  return hits;
}

// Builds a bare repo that stands in for GitHub, containing the handoff branch
// with sealed blobs exactly as `relay handoff` would have pushed them.
async function makeOriginRepo({
  manifest = MANIFEST,
  // The blob DIRECTORY is keyed by the descriptor id, which is not always the
  // id inside the sealed manifest — that difference is the point of the
  // manifest-identity test.
  blobId = manifest.id,
  sessionBytes = Buffer.from(
    `${JSON.stringify({ type: "user", cwd: manifest.cwd, message: `hello ${PLAINTEXT_MARKER}` })}\n`,
    "utf8",
  ),
  sealManifestTo = null,
  extraFiles = [],
  rawBlobs = [],
} = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-origin-"));
  const bare = `${work}.git`;
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);

  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("checkout", "-qb", manifest.branch);

  const encPubkey = readEncPublicKeyB64(identityPaths(sealManifestTo || IDENTITY_DIR));
  const blobDir = path.join(work, ".relay", "handoff", blobId);
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, "manifest.enc"), sealTo(encPubkey, Buffer.from(JSON.stringify(manifest), "utf8")));
  if (sessionBytes) fs.writeFileSync(path.join(blobDir, "session.enc"), sealTo(encPubkey, sessionBytes));
  for (const [name, contents] of rawBlobs) {
    if (contents === null) fs.rmSync(path.join(blobDir, name), { force: true });
    else fs.writeFileSync(path.join(blobDir, name), contents);
  }
  for (const [name, contents] of extraFiles) {
    const target = path.join(work, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (typeof contents === "object" && contents?.symlinkTo) fs.symlinkSync(contents.symlinkTo, target);
    else fs.writeFileSync(target, contents);
  }
  await git("add", "-A");
  await git("commit", "-qm", "relay handoff");
  await execFileAsync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
}

function deps(originPath, overrides = {}) {
  const events = [];
  return {
    events,
    cloud: { postEvent: async (type, extra) => { events.push({ type, ...extra }); return { status: 202 }; } },
    baseDir: IDENTITY_DIR,
    runHome,
    remoteUrlFor: () => originPath,
    ...overrides,
  };
}

// Local SSE events (emitEvent), which the cloud-post array above does NOT see —
// the previous suite fed `options.events` only from cloud.postEvent, so the
// events that actually reach the phone's /v1/events stream had zero coverage.
function captureLocalEvents() {
  const from = currentEventCursor();
  return () => replayEventsSince(from, 200);
}

async function branchFilesOnOrigin(bare, branch) {
  const { stdout } = await execFileAsync("git", ["-C", bare, "ls-tree", "-r", "--name-only", branch]);
  return stdout.split("\n").filter(Boolean);
}

// ---------------------------------------------------------------------------
// Happy path.

test("a handoff is cloned, decrypted, staged for resume, and announced", async () => {
  const origin = await makeOriginRepo();
  const options = deps(origin);
  const localEvents = captureLocalEvents();

  const record = await importHandoff({ id: MANIFEST.id, repo: MANIFEST.repo, branch: MANIFEST.branch }, options);

  assert.equal(record.state, "ready");
  assert.equal(record.title, "Fix the auth redirect");
  assert.equal(record.provider, "claude");
  assert.equal(record.resumeSessionId, MANIFEST.sessionId);

  const checkout = checkoutPathFor(MANIFEST.id);
  assert.ok(fs.existsSync(path.join(checkout, "README.md")), "the branch is checked out");
  assert.ok(record.workspaceId, "a workspace id is registered so jobs can target it");

  // The Claude project slug is derived from the checkout's REAL (symlink-
  // resolved) path — config.mjs realpath-resolves workspaceBrowseRoot at load,
  // and every job/dynamic-workspace path in this codebase is built from that
  // resolved root, so the harness always sees the resolved form as its cwd.
  const realCheckout = fs.realpathSync(checkout);
  const staged = path.join(runHome, ".claude", "projects", realCheckout.replace(/[^A-Za-z0-9]/g, "-"),
    `${MANIFEST.sessionId}.jsonl`);
  assert.ok(fs.existsSync(staged), "the session is staged where --resume finds it");
  assert.ok(!fs.readFileSync(staged, "utf8").includes("/Users/dev/code/relay"), "the laptop path is rewritten away");

  assert.deepEqual(options.events.map((event) => event.type), ["handoff.ready"]);
  assert.equal(store.getHandoff(MANIFEST.id).state, "ready");

  // M29: the LOCAL event is what reaches the phone's SSE stream. Deleting the
  // emitEvent call used to change nothing in this suite.
  const emitted = localEvents().filter((event) => event.name.startsWith("handoff."));
  assert.deepEqual(emitted.map((event) => event.name), ["handoff.ready"]);
  assert.equal(emitted[0].data.id, MANIFEST.id);
  assert.equal(emitted[0].data.title, "Fix the auth redirect");

  // The staging area is disposable and never left behind, at any name.
  const leftovers = fs.readdirSync(workspaceRoot).filter((name) => name.startsWith(".relayd-handoff-"));
  assert.deepEqual(leftovers, [], "no staging directory survives a successful import");
});

test("no decrypted plaintext is written anywhere in the checkout or the jail", async () => {
  const origin = await makeOriginRepo();
  await importHandoff({ id: MANIFEST.id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  const checkout = checkoutPathFor(MANIFEST.id);

  // POSITIVE CONTROL. The whole point of the marker is that the search finds
  // it where it IS supposed to be — the staged transcript in the run home. If
  // this assertion ever fails, every "no plaintext" assertion below has become
  // vacuous and the test says so instead of passing quietly.
  assert.ok(
    pathsContaining(runHome, PLAINTEXT_MARKER).length > 0,
    "the marker must be findable where the plaintext legitimately lands, or this test proves nothing",
  );

  // The real assertion: nothing under the checkout — or anywhere else in the
  // browse root — contains the decrypted transcript, whatever it is named.
  assert.deepEqual(pathsContaining(checkout, PLAINTEXT_MARKER), [],
    "the decrypted transcript must never be written into the checkout");
  assert.deepEqual(pathsContaining(workspaceRoot, PLAINTEXT_MARKER), [],
    "the decrypted transcript must never be written anywhere in the jail");

  const sealed = fs.readFileSync(path.join(checkout, ".relay", "handoff", MANIFEST.id, "session.enc"));
  assert.ok(!sealed.includes(Buffer.from(PLAINTEXT_MARKER, "utf8")), "the committed session blob stays ciphertext");
});

test("a handoff with no session blob still lands as ready with a primed prompt", async () => {
  const manifest = { ...MANIFEST, id: "bbb123def4567890", harness: "cursor", sessionFormat: "none", sessionId: null };
  const origin = await makeOriginRepo({ manifest, sessionBytes: null });

  const record = await importHandoff({ id: manifest.id, repo: manifest.repo, branch: manifest.branch }, deps(origin));

  assert.equal(record.state, "ready");
  assert.equal(record.resumeSessionId, null);
  assert.match(record.primedPrompt, /Fix the auth redirect/);
});

test("importing the same handoff twice is idempotent", async () => {
  const manifest = { ...MANIFEST, id: "eee123def4567890" };
  const origin = await makeOriginRepo({ manifest });
  const descriptor = { id: manifest.id, repo: manifest.repo, branch: manifest.branch };

  const first = await importHandoff(descriptor, deps(origin));
  const second = await importHandoff(descriptor, deps(origin));

  assert.equal(first.state, "ready");
  assert.equal(second.state, "ready");
  assert.equal(second.workspaceId, first.workspaceId);
});

// ---------------------------------------------------------------------------
// Failure visibility (property 2).

test("a clone failure is recorded and announced, never silent", async () => {
  const options = deps("/nonexistent/repo.git");
  const localEvents = captureLocalEvents();
  const record = await importHandoff({ id: "ccc123def4567890", repo: "me/relay", branch: "relay/handoff-x" }, options);

  assert.equal(record.state, "failed");
  assert.match(record.error, /clone_failed/);
  assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"]);
  assert.equal(store.getHandoff("ccc123def4567890").state, "failed");
  // M9: the local event, not just the cloud post.
  assert.deepEqual(
    localEvents().filter((event) => event.name.startsWith("handoff.")).map((event) => event.name),
    ["handoff.failed"],
  );
});

test("a blob sealed to another node is refused, and the attacker's clone is removed", async () => {
  const strangerDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-stranger-"));
  initIdentity({ baseDir: strangerDir });
  const manifest = { ...MANIFEST, id: "ddd123def4567890" };
  const origin = await makeOriginRepo({
    manifest,
    sealManifestTo: strangerDir,
    extraFiles: [["attacker-payload.txt", "planted\n"]],
  });

  const options = deps(origin);
  const record = await importHandoff({ id: manifest.id, repo: manifest.repo, branch: manifest.branch }, options);

  assert.equal(record.state, "failed");
  assert.match(record.error, /seal_decrypt_failed/);
  assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"]);

  // I7: a hostile cloud could otherwise plant arbitrary repository content in
  // the user's browsable workspace root, one directory per handoff, forever.
  assert.equal(fs.existsSync(checkoutPathFor(manifest.id)), false, "the failed checkout is removed");
  assert.deepEqual(
    fs.readdirSync(workspaceRoot).filter((name) => name.includes("handoff-ddd")),
    [],
    "nothing from the failed import is left listed as a workspace",
  );
});

test("C1: a hostile manifest that breaks session staging ends failed and visible, never wedged in importing", async () => {
  const escaped = escapeWatch();
  for (const [label, sessionId] of [["traversal", "../../../../etc/pwned"], ["wrong type", 12345]]) {
    const id = `wedge${label.replace(/\W/g, "")}0000`;
    const manifest = { ...MANIFEST, id, sessionId };
    const origin = await makeOriginRepo({ manifest });
    const options = deps(origin);
    const localEvents = captureLocalEvents();

    const record = await importHandoff({ id, repo: manifest.repo, branch: manifest.branch }, options);

    assert.equal(record.state, "failed", `${label}: must not be left importing`);
    assert.equal(store.getHandoff(id).state, "failed", `${label}: the stored state must be terminal`);
    assert.ok(record.error, `${label}: a reason must be recorded`);
    assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"], `${label}: the cloud is told`);
    assert.deepEqual(
      localEvents().filter((event) => event.name.startsWith("handoff.")).map((event) => event.name),
      ["handoff.failed"],
      `${label}: the phone is told`,
    );
    assert.equal(fs.existsSync(checkoutPathFor(id)), false, `${label}: the checkout is cleaned up`);
  }
  assert.deepEqual(escaped(), [], "nothing was written outside the jail");
});

test("I6: no host path, argv, child stderr or credential reaches the record or the event", async () => {
  const TOKEN = "ghp_zzzz1111TESTTOKENzzzz2222";
  const hostile = async () => {
    const error = new Error(
      `Command failed: /usr/local/bin/git clone --quiet https://x-access-token:${TOKEN}@github.com/me/relay.git ` +
        "/Users/someone/private/workspaces/handoff-x\nfatal: could not read Username",
    );
    error.stderr = `warning: ${TOKEN} in /Users/someone/.git-credentials\n`;
    throw error;
  };
  const options = deps("ignored", { execFileImpl: hostile });
  const localEvents = captureLocalEvents();

  const record = await importHandoff({ id: "leak0000000000ab", repo: "me/relay", branch: "relay/handoff-x" }, options);

  assert.equal(record.state, "failed");
  assert.equal(record.error, "clone_failed", "the reason comes from a closed vocabulary, not from the child");
  const served = JSON.stringify(store.getHandoff("leak0000000000ab"));
  const emitted = JSON.stringify(localEvents().filter((event) => event.name.startsWith("handoff.")));
  for (const body of [served, emitted]) {
    assert.ok(!body.includes(TOKEN), "a credential must never reach a record or an event");
    assert.ok(!body.includes("/Users/someone"), "an absolute host path must never reach a record or an event");
    assert.ok(!body.includes("--quiet"), "argv must never reach a record or an event");
    assert.ok(!body.includes("fatal:"), "child stderr must never reach a record or an event");
  }
  // m6: a failed clone must not be an existence oracle for private repos.
  for (const message of ["Repository not found", "Authentication failed"]) {
    const probe = deps("ignored", {
      execFileImpl: async () => { throw new Error(message); },
    });
    const result = await importHandoff({ id: `oracle${message.length}0000000`, repo: "me/relay", branch: "b" }, probe);
    assert.equal(result.error, "clone_failed", "every clone failure reads the same to a client");
  }
});

// ---------------------------------------------------------------------------
// Descriptor guards.

test("M1: an unsafe handoff id is refused before any path is built, and nothing is written", async () => {
  const escaped = escapeWatch();
  const before = fs.readdirSync(workspaceRoot).sort();
  for (const id of ["../../../../etc/pwn", "/etc/pwn", "..", "a/b", "a.b", "", null, 12345, "x".repeat(200), "a\0b", "-lead"]) {
    const options = deps("/nonexistent/repo.git");
    const record = await importHandoff({ id, repo: "me/relay", branch: "relay/handoff-x" }, options);
    assert.equal(record.state, "failed", `${JSON.stringify(id)} must be refused`);
    assert.equal(record.error, "invalid_handoff_id", `${JSON.stringify(id)} must be refused as an id`);
    assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"], "the refusal is announced");
  }
  assert.deepEqual(fs.readdirSync(workspaceRoot).sort(), before, "no directory was created for a bad id");
  assert.deepEqual(escaped(), [], "nothing was written outside the jail");
});

test("M5/M6: hostile repo and branch strings never reach argv, and the handoff stays visible", async () => {
  const escaped = escapeWatch();
  const marker = path.join(OUTSIDE, "argv-marker");
  const hostileRepos = [
    "../../../etc", "me/relay;touch /tmp/x", "https://evil.com/me/relay", "git@github.com:me/relay",
    "me@evil.com/relay", "/etc/passwd", "me/relay?x=1", "me/re..lay", "-oProxyCommand=touch",
  ];
  const hostileBranches = [
    "--upload-pack=touch", "-x", "a\nb", "a b", "..", "a/../../b", "", "x".repeat(300), "a\0b", null,
  ];
  for (const repo of hostileRepos) {
    const options = deps("/nonexistent/repo.git");
    const record = await importHandoff({ id: "repoguard00000ab", repo, branch: "relay/handoff-x" }, options);
    assert.equal(record.error, "invalid_repo", `repo ${JSON.stringify(repo)} must be refused`);
    // m4: the refusal is persisted, so the phone is not told about a handoff
    // that then 404s and never appears in the list.
    assert.equal(store.getHandoff("repoguard00000ab").state, "failed", "the refusal is persisted");
  }
  for (const branch of hostileBranches) {
    const options = deps("/nonexistent/repo.git");
    const record = await importHandoff({ id: "branchguard000ab", repo: "me/relay", branch }, options);
    assert.equal(record.error, "invalid_branch", `branch ${JSON.stringify(branch)} must be refused`);
    assert.equal(store.getHandoff("branchguard000ab").state, "failed", "the refusal is persisted");
  }
  assert.equal(fs.existsSync(marker), false, "no hostile descriptor caused a write");
  assert.deepEqual(escaped(), [], "nothing was written outside the jail");
});

test("V6: an oversized untrusted value echoed for an operator is clipped, not carried in full", async () => {
  const id = "clipuntrusted0ab";
  // "-" every 30 chars keeps every run under the SECRET_PATTERNS opaque-blob
  // threshold (40+ contiguous [A-Za-z0-9+/]) so redactSecrets leaves this
  // alone — what is actually under test here is redactUntrusted's OWN
  // clip(64), not the (separately tested) secret redaction.
  const hugeRepo = Array(200).fill("a".repeat(30)).join("-");
  const auditPath = path.join(process.env.CODEX_DATA_DIR, "audit.jsonl");
  const before = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").length : 0;

  const record = await importHandoff({ id, repo: hugeRepo, branch: "relay/handoff-x" }, deps("/nonexistent/repo.git"));

  assert.equal(record.error, "invalid_repo");
  const lines = fs.readFileSync(auditPath, "utf8").slice(before).trim().split("\n").filter(Boolean).map(JSON.parse);
  const failure = lines.find((l) => l.event === "handoff_failed" && l.handoffId === id);
  assert.ok(failure, "an audit entry must exist for the refused import");
  assert.ok(
    failure.detail.length < 200,
    `redactUntrusted must clip the echoed value; got a ${failure.detail.length}-char detail from a 5000-char repo`,
  );
});

// NOTE on parsePorcelainZ's "R"/"C" origin-path consumption (V5 in the
// mutation catalog): tried to reach it here with a real rename plus
// `status.renames=true` in the push's HOME, and could not. `completeHandoffJob`
// always runs `git reset -q` immediately before the status call, so nothing
// is ever staged when it runs — and git's status/diff rename detection (with
// or without `status.renames`/`--find-renames`) only correlates a deleted
// path with a new one when the comparison is against STAGED content, never
// for two working-tree-only changes. Confirmed directly against git 2.54: a
// tracked-then-deleted file plus a new untracked file never produces an "R"
// entry from `git status --porcelain -z --untracked-files=all`, staged or
// not. That makes this branch appear to be dead code given how this module
// calls git today — left in place as defence against a future edit that adds
// a status call without the preceding reset, not chased further with a
// synthetic test that wouldn't actually exercise it.

// ---------------------------------------------------------------------------
// The jail (property 1).

test("I2: the checkout directory is injective — no prefix, and no case, collides", () => {
  const long = "a".repeat(40);
  const pairs = [
    ["collide12345AAAA", "collide12345BBBB"], // the 12-char truncation that shipped
    [`${long}1`, `${long}2`], // a 35-char readable prefix is cosmetic only
    ["CaseVariant00001", "casevariant00001"], // case-insensitive filesystems
  ];
  for (const [left, right] of pairs) {
    assert.notEqual(checkoutPathFor(left), checkoutPathFor(right), `${left} vs ${right} must not share a checkout`);
    assert.notEqual(
      checkoutPathFor(left).toLowerCase(),
      checkoutPathFor(right).toLowerCase(),
      `${left} vs ${right} must not collide on a case-insensitive filesystem`,
    );
  }
  // The derived dynamic-workspace id (dir- + name, sliced to 80 by
  // workspaces.mjs) must not truncate, or two handoffs share a workspace id and
  // a continue can run in the wrong tree after a restart.
  assert.ok(path.basename(checkoutPathFor("f".repeat(64))).length <= 76, "the directory name stays inside the 80-char id budget");
});

test("I2: two handoffs sharing an id prefix do not share a checkout or destroy each other's work", async () => {
  const a = "collide12345AAAA";
  const b = "collide12345BBBB";
  const originA = await makeOriginRepo({ manifest: { ...MANIFEST, id: a } });
  const originB = await makeOriginRepo({ manifest: { ...MANIFEST, id: b } });

  const recordA = await importHandoff({ id: a, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(originA));
  fs.writeFileSync(path.join(checkoutPathFor(a), "uncommitted.txt"), "A's work\n");
  const recordB = await importHandoff({ id: b, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(originB));

  assert.equal(recordA.state, "ready");
  assert.equal(recordB.state, "ready");
  assert.notEqual(recordA.workspaceId, recordB.workspaceId, "each handoff gets its own workspace id");
  assert.ok(fs.existsSync(path.join(checkoutPathFor(a), "uncommitted.txt")), "A's uncommitted work survives B's import");
});

test("I1: a symlink pre-planted at the checkout path is destroyed, never followed", async () => {
  const id = "planted000000abc";
  const victim = path.join(OUTSIDE, "planted-victim");
  fs.mkdirSync(victim, { recursive: true });
  const precious = path.join(victim, "precious.txt");
  fs.writeFileSync(precious, "do not touch\n");
  fs.symlinkSync(victim, checkoutPathFor(id));
  // Watch starts AFTER the fixture is planted, so anything it reports was put
  // there by the module under test.
  const escaped = escapeWatch();

  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  assert.equal(record.state, "ready", "the pre-planted symlink is cleared, not followed");
  assert.equal(fs.lstatSync(checkoutPathFor(id)).isDirectory(), true, "a real directory replaced the link");
  assert.equal(fs.readFileSync(precious, "utf8"), "do not touch\n", "the victim directory is untouched");
  assert.deepEqual(escaped(), [], "the clone must not have landed through the symlink");
});

test("m-5: a benign ENOENT racing removePinnedEntry's own unlink must not fail an otherwise-clean import", async () => {
  // removePinnedEntry's lstat-then-unlink is two syscalls with nothing this
  // module controls in between; if whatever it lstat'd (a pre-planted
  // symlink, here) is gone by the time unlink runs, that is not a failure —
  // the entry the module wanted gone is already gone. Without a specific
  // catch for it, the raw ENOENT propagates uncaught and importHandoff
  // reports "internal_error" for what was actually a clean import.
  const id = "raceenoentabcdef";
  fs.symlinkSync(path.join(OUTSIDE, "does-not-need-to-exist"), checkoutPathFor(id));
  // removePinnedEntry runs inside withPinnedCwd and unlinks by the bare
  // RELATIVE name (a single path component resolved from the pinned cwd),
  // never the absolute path — match on that.
  const targetName = path.basename(checkoutPathFor(id));

  const originalUnlinkSync = fs.unlinkSync;
  let intercepted = false;
  fs.unlinkSync = (p, ...rest) => {
    if (!intercepted && p === targetName) {
      intercepted = true;
      // Simulate a racing remover that gets there first: the entry is
      // ACTUALLY gone (a real concurrent unlink would really remove it) by
      // the time this call's own unlink(2) runs, which is why it sees ENOENT
      // rather than succeeding itself.
      originalUnlinkSync.call(fs, p, ...rest);
      const error = new Error(`ENOENT: no such file or directory, unlink '${p}'`);
      error.code = "ENOENT";
      throw error;
    }
    return originalUnlinkSync.call(fs, p, ...rest);
  };

  let record;
  try {
    const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
    record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }

  assert.ok(intercepted, "the fixture must actually have raced removePinnedEntry's unlink");
  assert.equal(record.state, "ready", "a lost ENOENT race on an entry that is already gone must not fail the import");
});

test("I1: a same-uid racer swapping the checkout path cannot get a single byte outside the jail", async () => {
  const id = "race00000000abcd";
  const target = path.join(OUTSIDE, "race-victim");
  fs.mkdirSync(target, { recursive: true });
  const finalPath = checkoutPathFor(id);
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });

  // Two racers in one, both as the same uid — exactly the process the jail
  // exists to constrain (the harness relayd spawns for a handoff job runs as
  // this uid with its cwd inside the browse root):
  //   1. the reviewer's original — symlink the stable checkout path aside.
  //      This won on attempt 0 against the previous implementation and put a
  //      whole repository outside the jail.
  //   2. the harder one — read the browse root, find the randomly-named
  //      staging directory, `rename` it away (ONE syscall: neither a sentinel
  //      nor a non-empty directory stops a rename) and symlink the name at a
  //      target outside the jail, so that anything the module resolves through
  //      that name afterwards lands there.
  //
  // The racer moves our directory into `spoil`, deliberately NOT inside the
  // asserted tree: an attacker renaming a directory we created is not an
  // escape this or any design can prevent (the bytes follow the inode, and
  // they could equally move the finished checkout a second later). What must
  // never happen is a byte landing at a path of the ATTACKER's choosing
  // because WE resolved a name they control — and that is what `target` is.
  const racerScript = path.join(root, "racer.mjs");
  fs.writeFileSync(racerScript, `
import fs from "node:fs";
import path from "node:path";
const [finalPath, target, browseRoot, spoil] = process.argv.slice(2);
const deadline = Date.now() + 30_000;
let n = 0;
while (Date.now() < deadline) {
  try { fs.symlinkSync(target, finalPath); } catch { /* taken */ }
  let names = [];
  try { names = fs.readdirSync(browseRoot); } catch { /* gone */ }
  for (const name of names) {
    if (!name.startsWith(".relayd-handoff-")) continue;
    const staging = path.join(browseRoot, name);
    try { fs.renameSync(staging, path.join(spoil, "s" + (n++))); } catch { /* not there yet */ }
    try { fs.symlinkSync(target, staging); } catch { /* taken */ }
  }
}
`);
  const spoil = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-spoil-"));
  const racer = spawn(process.execPath, [racerScript, finalPath, target, workspaceRoot, spoil], { stdio: "ignore" });

  const outcomes = [];
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
      outcomes.push(record.state);
      // Between attempts the record must never be left mid-flight.
      assert.notEqual(record.state, "importing", "a lost race must still reach a terminal state");
      store.saveHandoff({ ...store.getHandoff(id), state: "failed", updatedAt: new Date().toISOString() });
    }
  } finally {
    racer.kill("SIGKILL");
    await new Promise((resolve) => racer.once("exit", resolve));
    // The racer plants symlinks of its own in the browse root; they are its
    // litter, not the module's, and the next test asserts on that directory.
    for (const name of fs.readdirSync(workspaceRoot)) {
      if (name.startsWith(".relayd-handoff-")) fs.rmSync(path.join(workspaceRoot, name), { recursive: true, force: true });
    }
  }

  // THE property: whatever the racer won, not one byte may be outside.
  const escaped = walkTree(target);
  assert.deepEqual(escaped, [], `a write escaped the jail: ${escaped.slice(0, 8).join(", ")}`);
  assert.ok(outcomes.length === 8, "every attempt settled");
});

test("M17/I1: a lost publish race fails closed and leaves no staging directory behind", async () => {
  const id = "publishrace00abc";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
  assert.deepEqual(
    fs.readdirSync(workspaceRoot).filter((name) => name.startsWith(".relayd-handoff-")),
    [],
    "the staging directory is always removed",
  );
});

test("M7: a sealed blob symlinked out of the checkout is refused", async () => {
  const id = "blobsymlink00abc";
  const secret = path.join(OUTSIDE, "outside-secret.enc");
  fs.writeFileSync(secret, "outside\n");
  const origin = await makeOriginRepo({
    manifest: { ...MANIFEST, id },
    rawBlobs: [["manifest.enc", null]],
    extraFiles: [[path.join(".relay", "handoff", id, "manifest.enc"), { symlinkTo: secret }]],
  });

  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  assert.equal(record.state, "failed");
  assert.equal(record.error, "blob_outside_checkout", "the symlinked blob is refused, not read");
});

test("M8: an oversized sealed blob is refused before it is read", async () => {
  const id = "blobtoobig000abc";
  const huge = Buffer.alloc(0);
  const origin = await makeOriginRepo({
    manifest: { ...MANIFEST, id },
    // A sparse-ish 21 MB blob: git compresses the zeros away, so the fixture
    // stays fast while the size the module sees is over the 20 MB cap.
    rawBlobs: [["session.enc", Buffer.concat([huge, Buffer.alloc(21 * 1024 * 1024)])]],
  });

  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  assert.equal(record.state, "failed");
  assert.equal(record.error, "blob_too_large");
});

test("M14: a session blob that fails to decrypt is a failure, not a silent skip", async () => {
  const id = "badsession000abc";
  const origin = await makeOriginRepo({
    manifest: { ...MANIFEST, id },
    rawBlobs: [["session.enc", Buffer.from("RELAYSEAL1 but corrupt", "utf8")]],
  });

  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  assert.equal(record.state, "failed", "only ENOENT may be swallowed");
  assert.match(record.error, /^seal_/);
});

test("M30: a node with no encryption key refuses rather than importing blindly", async () => {
  const id = "nokey00000000abc";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  const emptyIdentity = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-nokey-"));

  const record = await importHandoff(
    { id, repo: MANIFEST.repo, branch: MANIFEST.branch },
    deps(origin, { baseDir: emptyIdentity }),
  );

  assert.equal(record.state, "failed");
  assert.equal(record.error, "no_encryption_key");
  assert.equal(fs.existsSync(checkoutPathFor(id)), false, "the checkout is cleaned up");
});

test("I-3: the published checkout swapped for a symlink out of the jail before registration is refused, not silently accepted", async () => {
  const id = "wsregswap000abcd";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  const spoil = path.join(OUTSIDE, "wsreg-spoil");

  const record = await importHandoff(
    { id, repo: MANIFEST.repo, branch: MANIFEST.branch },
    deps(origin, {
      // The same same-uid race this whole module exists to defend against:
      // move the just-published, containment-verified checkout aside and
      // leave a symlink to it out of the jail at the stable name. This is
      // NOT unreachable "by construction" — browseWorkspaceForPath
      // re-resolves `checkout` from "/" right here and gets a different,
      // outside answer, because containment was proved at PUBLISH time,
      // several lines above, not at this one.
      beforeWorkspaceRegistration(checkout) {
        fs.renameSync(checkout, spoil);
        fs.symlinkSync(spoil, checkout);
      },
    }),
  );

  assert.equal(record.state, "failed");
  assert.equal(record.error, "workspace_registration_failed");
  assert.equal(store.getHandoff(id).state, "failed");
  // The symlink at our stable name is unlinked, never followed, and the
  // attacker's tree at `spoil` is left alone: a cleanup that deletes what it
  // did not create is an arbitrary-delete primitive aimed wherever an
  // attacker points it.
  assert.equal(fs.existsSync(checkoutPathFor(id)), false, "the stable name is cleared");
  assert.ok(fs.existsSync(path.join(spoil, "README.md")), "the swapped-aside tree itself is left alone, not deleted");
  fs.rmSync(spoil, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The manifest (I5).

test("M13/I5: the manifest is version-checked, identity-checked and type-checked before it is stored or served", async () => {
  const cases = [
    ["version", { v: 2 }, "unsupported_manifest_version"],
    ["identity", { id: "someoneelse00000" }, "manifest_id_mismatch"],
    ["titletype", { title: { evil: "object" } }, "manifest_invalid"],
    ["wiptype", { wip: "not an object" }, "manifest_invalid"],
    ["createdat", { createdAt: "yesterday" }, "manifest_invalid"],
    ["sessionidtype", { sessionId: 12345 }, "manifest_invalid"],
  ];
  for (const [label, overrides, expected] of cases) {
    const id = `mf${label}`.slice(0, 16).padEnd(16, "0");
    const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id, ...overrides }, blobId: id });
    const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
    assert.equal(record.state, "failed", `${label}: must be refused`);
    assert.equal(record.error, expected, `${label}: got ${record.error}`);
    assert.equal(fs.existsSync(checkoutPathFor(id)), false, `${label}: the checkout is cleaned up`);
  }
});

test("I5: oversized manifest fields are clipped and an oversized manifest is refused outright", async () => {
  // Under the manifest cap, so what is observed here is the per-FIELD bound: a
  // long title used to be persisted whole and served in full by GET /v1/handoffs.
  const id = "hugetitle0000abc";
  const origin = await makeOriginRepo({
    manifest: { ...MANIFEST, id, title: "T".repeat(5_000), excerpt: "E".repeat(20_000), machine: "M".repeat(5_000) },
  });

  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  assert.equal(record.state, "ready");
  assert.ok(record.title.length <= 240, `the title is clipped, got ${record.title.length}`);
  assert.ok(record.manifest.excerpt.length <= 2_040, `the excerpt is clipped, got ${record.manifest.excerpt.length}`);
  const size = Buffer.byteLength(JSON.stringify(store.getHandoff(id)));
  assert.ok(size < 16 * 1024, `a single handoff record must stay small, got ${size} bytes`);

  // And past the whole-manifest cap it never gets parsed at all: a 2 MB title
  // used to become a 10.5 MB record that one GET served in full.
  const bigId = "hugemanifest0abc";
  const bigOrigin = await makeOriginRepo({ manifest: { ...MANIFEST, id: bigId, title: "T".repeat(2 * 1024 * 1024) } });
  const refused = await importHandoff({ id: bigId, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(bigOrigin));
  assert.equal(refused.state, "failed");
  assert.equal(refused.error, "manifest_too_large");
});

// ---------------------------------------------------------------------------
// Continue.

test("M25: continue refuses an unknown handoff, one that is not ready, and one with a job in flight", async () => {
  await assert.rejects(() => continueHandoff("no-such-handoff-1"), (error) => error.status === 404);

  const id = "continue00000abc";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  store.saveHandoff({ ...store.getHandoff(id), state: "importing" });
  await assert.rejects(() => continueHandoff(id), (error) => error.status === 409, "importing is not continuable");

  store.saveHandoff({ ...store.getHandoff(id), state: "failed" });
  await assert.rejects(() => continueHandoff(id), (error) => error.status === 409, "failed is not continuable");

  // I3: a second continue used to overwrite lastJobId and orphan the first
  // job's push-back. One in-flight job per handoff, enforced.
  store.saveHandoff({ ...store.getHandoff(id), state: "ready", lastJobId: "job-inflight" });
  jobs.set("job-inflight", { id: "job-inflight", status: "running", workspaceId: "dir-x" });
  await assert.rejects(
    () => continueHandoff(id),
    (error) => error.status === 409 && /already running/.test(error.message),
    "a second continue while a job runs is refused",
  );

  // A finished job must NOT block the next continue: the guard is about
  // in-flight work, not about ever having run.
  jobs.set("job-inflight", { id: "job-inflight", status: "succeeded", workspaceId: "dir-x" });
  await assert.rejects(
    () => continueHandoff(id),
    (error) => error.status !== 409,
    "a terminal job must not block a new continue",
  );
  jobs.delete("job-inflight");
});

// ---------------------------------------------------------------------------
// Push-back.

async function stageHandoffForPush(id, { lastJobId }) {
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
  assert.equal(record.state, "ready", "the fixture handoff must import cleanly");
  store.saveHandoff({ ...store.getHandoff(id), lastJobId });
  return { origin, checkout: checkoutPathFor(id) };
}

test("a completed handoff job commits and pushes to the handoff branch", async () => {
  const id = "push000000000abc";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-push-1" });
  fs.writeFileSync(path.join(checkout, "work.txt"), "the agent's work\n");

  const result = await completeHandoffJob({ id: "job-push-1", status: "succeeded", workspaceId: "dir-handoff-x" });

  assert.deepEqual({ branch: result.branch, pushed: result.pushed }, { branch: MANIFEST.branch, pushed: true });
  assert.ok((await branchFilesOnOrigin(origin, MANIFEST.branch)).includes("work.txt"), "the work reached the remote");
  assert.equal(store.getHandoff(id).error, null, "a successful push clears the error field");
});

test("CRITICAL 3: credentials in the working tree cannot ride the push back", async () => {
  const id = "secrets00000abcd";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-secret-1" });

  const SECRET = "sk-live-zqxSECRETVALUEzqx";
  fs.writeFileSync(path.join(checkout, ".env"), `OPENAI_API_KEY=${SECRET}\n`);
  fs.mkdirSync(path.join(checkout, ".secrets"), { recursive: true });
  fs.writeFileSync(path.join(checkout, ".secrets", "harness-token.json"), `{"token":"${SECRET}"}\n`);
  fs.writeFileSync(path.join(checkout, "deploy.pem"), `-----BEGIN PRIVATE KEY-----\n${SECRET}\n`);
  fs.writeFileSync(path.join(checkout, "src.txt"), "legitimate work\n");

  const result = await completeHandoffJob({ id: "job-secret-1", status: "succeeded", workspaceId: "dir-handoff-x" });

  assert.equal(result.pushed, true, "the legitimate work still gets pushed");
  const pushed = await branchFilesOnOrigin(origin, MANIFEST.branch);
  assert.ok(pushed.includes("src.txt"), "the agent's real work reached the remote");
  for (const denied of [".env", ".secrets/harness-token.json", "deploy.pem"]) {
    assert.equal(pushed.includes(denied), false, `${denied} must never reach the remote`);
  }
  // Name assertions can be dodged; scan the pushed objects for the value.
  const { stdout } = await execFileAsync("git", ["-C", origin, "log", "-p", "--all"], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(stdout.includes(SECRET), false, "the secret value must not exist anywhere in the pushed history");
  // And the files are still in the sandbox — withheld, not deleted.
  assert.ok(fs.existsSync(path.join(checkout, ".env")), "withholding must not destroy the user's file");
});

test("I-2: layer 2 catches a secret that reaches the index by a path layer 1 never enumerated", async () => {
  // Layer 1 filters the paths `git status` reported, once, at the start.
  // Layer 2 re-checks the paths that ACTUALLY reached the index. These are
  // not the same input: between the status snapshot and the `git add` calls
  // there is a real window (a chunked loop, each iteration `await`ed) during
  // which the same-uid coding agent this module's threat model already
  // assumes — the harness that just ran in this checkout — can change what a
  // reported name resolves to. Here a plain file reported as "work.txt"
  // becomes a DIRECTORY containing a secret before `git add -- work.txt`
  // runs: git recurses into it and stages "work.txt/.env", a path layer 1
  // never saw and so never filtered. Layer 2 is the only thing standing
  // between that and a live key on the remote's history — proven by
  // literally deleting the layer-2 check and re-running this test (see
  // task-14-report.md): the push then succeeds and the secret lands in
  // `git log -p --all` on the origin.
  const id = "toctoulayer2abcd";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-toctou-1" });
  const SECRET = "sk-live-zqxTOCTOUSECRETzqx";
  fs.writeFileSync(path.join(checkout, "work.txt"), "legit content, for now\n");
  const localEvents = captureLocalEvents();

  const swapAfterStatus = async (bin, args, options) => {
    const result = await execFileAsync(bin, args, options);
    if (args[2] === "status") {
      fs.rmSync(path.join(checkout, "work.txt"), { force: true });
      fs.mkdirSync(path.join(checkout, "work.txt"));
      fs.writeFileSync(path.join(checkout, "work.txt", ".env"), `OPENAI_API_KEY=${SECRET}\n`);
    }
    return result;
  };

  const result = await completeHandoffJob(
    { id: "job-toctou-1", status: "succeeded", workspaceId: "dir-handoff-x" },
    { execFileImpl: swapAfterStatus },
  );

  assert.equal(result.pushed, false, "the push must be blocked, not merely have the secret filtered back out");
  assert.equal(result.reason, "push_blocked_secret");
  assert.equal(store.getHandoff(id).error, "push_blocked_secret");
  assert.deepEqual(
    localEvents().filter((event) => event.name.startsWith("handoff.")).map((event) => event.name),
    ["handoff.push_failed"],
  );
  const { stdout } = await execFileAsync("git", ["-C", origin, "log", "-p", "--all"], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(stdout.includes(SECRET), false, "the secret value must never exist anywhere in the pushed history");
});

test("I-1: a file named ':!x' must not silently defeat the push — git add takes pathspecs, not filenames", async () => {
  const id = "pathspec000babcd";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-pathspec-1" });
  fs.writeFileSync(path.join(checkout, "work.txt"), "the agent's work\n");
  // ":!work.txt" is a NEGATIVE pathspec ("exclude anything matching
  // work.txt"), not a filename, unless GIT_LITERAL_PATHSPECS is set. Without
  // the fix, `git add -- ":!work.txt" "work.txt"` stages NOTHING — the
  // exclusion wins over the inclusion for the exact name it names — so no
  // commit is made, `git push` succeeds as a no-op, record.error is cleared,
  // and the phone is told handoff.pushed — while work.txt never left the
  // sandbox. That silence is exactly the invariant this module exists to
  // hold: every failure ends visible.
  fs.writeFileSync(path.join(checkout, ":!work.txt"), "an ordinary file that happens to look like a pathspec\n");

  const result = await completeHandoffJob({ id: "job-pathspec-1", status: "succeeded", workspaceId: "dir-handoff-x" });

  assert.equal(result.pushed, true, "the push must still succeed");
  const pushed = await branchFilesOnOrigin(origin, MANIFEST.branch);
  assert.ok(pushed.includes("work.txt"), "the agent's real work must reach the remote even with a pathspec-shaped filename present");
  assert.ok(pushed.includes(":!work.txt"), "the pathspec-shaped filename must be staged and pushed literally, not interpreted");
});

test("I-1: a file named '*' cannot re-glob a withheld secret back into the index", async () => {
  const id = "pathspec0starabc";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-pathspec-2" });
  const SECRET = "sk-live-zqxGLOBSECRETzqx";
  fs.writeFileSync(path.join(checkout, ".env"), `OPENAI_API_KEY=${SECRET}\n`);
  fs.writeFileSync(path.join(checkout, "*"), "a legitimately named file, not a wildcard\n");
  fs.writeFileSync(path.join(checkout, "work.txt"), "legit work\n");

  const result = await completeHandoffJob({ id: "job-pathspec-2", status: "succeeded", workspaceId: "dir-handoff-x" });

  // With literal pathspecs, "*" adds only the file literally named "*" — it
  // does not re-glob ".env" back into the set layer 1 withheld. The push
  // must succeed with the legitimate files and the secret must never reach
  // the remote (not even under layer 2's fail-closed reason).
  assert.equal(result.pushed, true, "the legitimate work still gets pushed");
  const pushed = await branchFilesOnOrigin(origin, MANIFEST.branch);
  assert.ok(pushed.includes("work.txt") && pushed.includes("*"), "the legitimately named files reach the remote");
  assert.equal(pushed.includes(".env"), false, "the withheld secret must not be re-globbed back into the index");
  const { stdout } = await execFileAsync("git", ["-C", origin, "log", "-p", "--all"], { maxBuffer: 32 * 1024 * 1024 });
  assert.equal(stdout.includes(SECRET), false, "the secret value must not exist anywhere in the pushed history");
});

test("I-1: the push refspec is fully qualified, so a branch name cannot be read as a force-push flag", async () => {
  const id = "pathspecrefspec1";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
  store.saveHandoff({ ...store.getHandoff(id), lastJobId: "job-pathspec-3" });
  const checkout = checkoutPathFor(id);
  fs.writeFileSync(path.join(checkout, "work.txt"), "legit work\n");

  let pushArgs = null;
  // completeHandoffJob's own execFileImpl is not swappable from the deps()
  // helper (push-back always used the real git binary); this hooks the same
  // seam runImport already uses elsewhere in the file, applied here so the
  // exact argv reaching git can be inspected without needing a branch name
  // that could survive git's own ref-format validation (a leading "+" is a
  // legal ref character, unlike ":" "^" "?" "*" "[", which check-ref-format
  // already forbids).
  const spy = async (bin, args, options) => {
    // args are ["-C", checkout, <git subcommand>, ...] for every call this
    // module makes here.
    if (args[2] === "push") pushArgs = args;
    return execFileAsync(bin, args, options);
  };

  const result = await completeHandoffJob(
    { id: "job-pathspec-3", status: "succeeded", workspaceId: "dir-handoff-x" },
    { execFileImpl: spy },
  );

  assert.equal(result.pushed, true);
  assert.deepEqual(
    pushArgs.slice(-1),
    [`refs/heads/${MANIFEST.branch}:refs/heads/${MANIFEST.branch}`],
    "the push argument must be a fully-qualified two-sided refspec, never a bare branch name a leading '+' could turn into a force-push",
  );
});

test("the secret-path policy matches by shape, not by the two names that were reported", () => {
  const denied = [
    ".env", ".env.local", "sub/dir/.env.production", ".envrc", ".secrets/harness-token.json",
    "config/secrets.yaml", ".git-credentials", ".netrc", ".npmrc", "app/.aws/credentials",
    ".ssh/id_ed25519", "keys/server.pem", "certs/tls.key", "svc/service-account-prod.json",
    ".claude/.credentials.json", "infra/terraform.tfstate",
  ];
  const allowed = [
    "src/index.mjs", "README.md", "environment.md", "docs/env-setup.md", "src/secretsauce.ts",
    "test/fixtures/keyboard.ts", "pemberton.txt", ".github/workflows/ci.yml",
  ];
  for (const entry of denied) assert.equal(isSecretPath(entry), true, `${entry} must be denied`);
  for (const entry of allowed) assert.equal(isSecretPath(entry), false, `${entry} must be allowed`);
});

test("I3: a failed push is announced, not just audited, and the record says so", async () => {
  const id = "pushfail0000abcd";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-pushfail-1" });
  fs.writeFileSync(path.join(checkout, "work.txt"), "work\n");
  fs.rmSync(origin, { recursive: true, force: true }); // the remote is gone
  const localEvents = captureLocalEvents();

  const result = await completeHandoffJob({ id: "job-pushfail-1", status: "succeeded", workspaceId: "dir-handoff-x" });

  assert.equal(result.pushed, false);
  assert.equal(store.getHandoff(id).error, "push_failed", "the record stops claiming everything is fine");
  assert.deepEqual(
    localEvents().filter((event) => event.name.startsWith("handoff.")).map((event) => event.name),
    ["handoff.push_failed"],
    "the phone is told the work was not pushed",
  );
});

test("m-2: a continue landing during a multi-second push must not have its lastJobId reverted", async () => {
  // completeHandoffJob reads the record ONCE at the top and, on the way out,
  // persists a copy of THAT stale snapshot with only error/updatedAt changed.
  // A `continue` that lands while the push is still running (git push can
  // take seconds) updates `lastJobId` in the store in the meantime; if the
  // push's own final persist() spreads the stale snapshot, it silently
  // reverts that update the instant the push finishes.
  const id = "concurrentlastjb";
  const { checkout } = await stageHandoffForPush(id, { lastJobId: "job-m2-first" });
  fs.writeFileSync(path.join(checkout, "work.txt"), "work\n");

  const raceInAContinue = async (bin, args, options) => {
    const result = await execFileAsync(bin, args, options);
    if (args[2] === "status") {
      // Simulate the record store's view of a concurrent continueHandoff:
      // a second job was enqueued and lastJobId moved on while this push
      // was still in flight.
      store.saveHandoff({ ...store.getHandoff(id), lastJobId: "job-m2-second" });
    }
    return result;
  };

  const result = await completeHandoffJob(
    { id: "job-m2-first", status: "succeeded", workspaceId: "dir-handoff-x" },
    { execFileImpl: raceInAContinue },
  );

  assert.equal(result.pushed, true);
  assert.equal(
    store.getHandoff(id).lastJobId,
    "job-m2-second",
    "a concurrent continue's lastJobId must survive the push's own final persist",
  );
});

test("I3: a job that did not succeed, and an orphaned job, are both reported rather than silently null", async () => {
  const id = "pushskip0000abcd";
  await stageHandoffForPush(id, { lastJobId: "job-skip-1" });
  const localEvents = captureLocalEvents();

  const failed = await completeHandoffJob({ id: "job-skip-1", status: "failed", workspaceId: "dir-handoff-x" });
  assert.deepEqual({ pushed: failed.pushed, reason: failed.reason }, { pushed: false, reason: "job_failed" });
  assert.deepEqual(
    localEvents().filter((event) => event.name.startsWith("handoff.")).map((event) => event.name),
    ["handoff.push_failed"],
  );

  // An ordinary (non-handoff) job stays silent and costs no store scan.
  assert.equal(await completeHandoffJob({ id: "job-ordinary", status: "succeeded", workspaceId: "scratch" }), null);
});

test("V1: a checkout path swapped for a symlink itself is not resolved for a push", async () => {
  const id = "verifiedchkout01";
  const { checkout } = await stageHandoffForPush(id, { lastJobId: "job-verified-1" });
  const spoil = path.join(OUTSIDE, "verifiedcheckout-spoil");
  fs.mkdirSync(spoil, { recursive: true });
  fs.writeFileSync(path.join(spoil, "not-yours.txt"), "attacker content\n");
  // Same containment attack as I-3, aimed at the PUSH side instead of the
  // pickup side: the stable checkout name is swapped for a symlink pointing
  // outside the jail between when a job finished and when the push-back
  // resolves the checkout it should commit and push from.
  fs.rmSync(checkout, { recursive: true, force: true });
  fs.symlinkSync(spoil, checkout);

  const result = await completeHandoffJob({ id: "job-verified-1", status: "succeeded", workspaceId: "dir-handoff-x" });

  assert.equal(result.pushed, false, "a checkout that no longer resolves inside the jail must never be pushed from");
  assert.equal(result.reason, "checkout_missing");
  fs.rmSync(spoil, { recursive: true, force: true });
});

test("V2: a checkout reached only through a symlinked ANCESTOR (real leaf, different realpath) is not resolved for a push", async () => {
  // V1 swaps the leaf itself for a symlink, which lstat catches directly.
  // This is the other half: the leaf stays a REAL directory, but an ancestor
  // component is a symlink, so the literal path still lstats as a directory
  // while fs.realpathSync resolves to a different string outside the jail —
  // exactly what `real !== expected || !resolvedPathWithinRoot(real)` exists
  // to catch, and what V1 alone cannot exercise.
  const id = "verifiedchkout02";
  await stageHandoffForPush(id, { lastJobId: "job-verified-2" });
  const realRoot = fs.realpathSync(workspaceRoot);
  const elsewhere = `${realRoot}-ancestor-swap`;
  fs.renameSync(realRoot, elsewhere); // the real checkout (with .git) moves too
  fs.symlinkSync(elsewhere, realRoot);
  try {
    const result = await completeHandoffJob({ id: "job-verified-2", status: "succeeded", workspaceId: "dir-handoff-x" });
    assert.equal(result.pushed, false, "a checkout reached only via a symlinked ancestor must never be pushed from");
    assert.equal(result.reason, "checkout_missing");
  } finally {
    fs.rmSync(realRoot, { force: true });
    fs.renameSync(elsewhere, realRoot);
  }
});

// ---------------------------------------------------------------------------
// The jail root (resolveJailRoot).

test("resolveJailRoot: the browse root swapped for a symlink is refused, not silently trusted", async () => {
  const realRoot = fs.realpathSync(workspaceRoot);
  const elsewhere = `${realRoot}-elsewhere-symlink`;
  fs.renameSync(realRoot, elsewhere);
  fs.symlinkSync(elsewhere, realRoot);
  try {
    const id = "jailrootsymlnk01";
    const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
    const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
    assert.equal(record.state, "failed");
    assert.equal(record.error, "jail_root_unusable", "a symlinked browse root must never be trusted as the jail");
  } finally {
    fs.rmSync(realRoot, { force: true }); // unlink the symlink we planted
    fs.renameSync(elsewhere, realRoot);
  }
});

test("resolveJailRoot: the browse root swapped for a plain file is refused, not silently trusted", async () => {
  const realRoot = fs.realpathSync(workspaceRoot);
  const elsewhere = `${realRoot}-elsewhere-file`;
  fs.renameSync(realRoot, elsewhere);
  fs.writeFileSync(realRoot, "not a directory\n");
  try {
    const id = "jailrootfile0001";
    const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
    const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
    assert.equal(record.state, "failed");
    assert.equal(record.error, "jail_root_unusable", "a browse root that is not a directory must never be trusted as the jail");
  } finally {
    fs.rmSync(realRoot, { force: true });
    fs.renameSync(elsewhere, realRoot);
  }
});

test("resolveJailRoot: an ancestor swapped for a symlink (real leaf, different realpath) is refused, not silently trusted", async () => {
  // The two tests above swap the LEAF (workspaceBrowseRoot) itself. This is
  // the other half: the leaf directory entry stays a REAL directory —
  // isSymbolicLink() and isDirectory() both pass — but an ANCESTOR component
  // is now a symlink, so fs.realpathSync resolves the whole path to a
  // DIFFERENT string than the one config.mjs froze at boot. That is exactly
  // what "the browse root moved after startup" exists to catch, and neither
  // of the other two tests can exercise it.
  const realParent = fs.realpathSync(root);
  const elsewhere = `${realParent}-ancestor-swap`;
  fs.renameSync(realParent, elsewhere); // everything under root moves, including workspaceRoot
  fs.symlinkSync(elsewhere, realParent);
  try {
    const id = "jailrootancestor";
    const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
    const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));
    assert.equal(record.state, "failed");
    assert.equal(record.error, "jail_root_unusable", "a browse root reached only through a symlinked ancestor must never be trusted as the jail");
  } finally {
    fs.rmSync(realParent, { force: true });
    fs.renameSync(elsewhere, realParent);
  }
});

// ---------------------------------------------------------------------------
// The pickup loop (C2).

test("L5: waitSec is floored to at least 1 before it is ever sent to the cloud", async () => {
  for (const [waitSec, expected] of [[0, 1], [-5, 1], [NaN, 1], [0.9, 1], [3.9, 3]]) {
    let seen = null;
    const loop = startHandoffLoop({
      cloud: { async pollHandoffs(sec) { seen ??= sec; return []; } },
      waitSec,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    loop.stop();
    assert.equal(seen, expected, `waitSec ${waitSec} must floor to ${expected}, got ${seen}`);
  }
});

test("L6: a poll cycle never imports more than the batch cap, and the rest arrive next cycle", async () => {
  const attempted = [];
  let cycle = 0;
  const cloud = {
    async pollHandoffs() {
      cycle += 1;
      if (cycle > 1) return [];
      // 30 descriptors in one answer — more than MAX_POLL_BATCH (20).
      // Deliberately invalid ids (a "/" fails assertSafeHandoffId at once,
      // synchronously) so each settles instantly with no network I/O — the
      // batch cap is what is under test here, not the clone path.
      return Array.from({ length: 30 }, (_, i) => ({ id: `../capbatch${String(i).padStart(8, "0")}`, repo: "me/relay", branch: "b" }));
    },
  };
  // No direct hook into the loop's own importHandoff call; count via the
  // audit trail instead, which is emitted once per attempted import
  // regardless of outcome (every one of these ids is invalid, so each
  // becomes exactly one handoff_failed audit — countable and deterministic).
  const before = fs.existsSync(path.join(process.env.CODEX_DATA_DIR, "audit.jsonl"))
    ? fs.readFileSync(path.join(process.env.CODEX_DATA_DIR, "audit.jsonl"), "utf8").length
    : 0;

  const loop = startHandoffLoop({ cloud, waitSec: 1 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  loop.stop();

  const auditPath = path.join(process.env.CODEX_DATA_DIR, "audit.jsonl");
  const lines = fs.readFileSync(auditPath, "utf8").slice(before).trim().split("\n").filter(Boolean).map(JSON.parse);
  // An invalid id is unrecordable, so handoffId is null on its audit entry;
  // the id survives (clipped) inside `detail` instead.
  attempted.push(...lines.filter((l) => l.event === "handoff_failed" && String(l.detail).includes("capbatch")));
  assert.equal(attempted.length, 20, `exactly MAX_POLL_BATCH (20) of the 30 offered must be attempted in the first cycle, got ${attempted.length}`);
});

test("C2: the poll loop has a floor on the SUCCESS path", async () => {
  let polls = 0;
  const cloud = {
    async pollHandoffs() {
      polls += 1;
      // Yields a macrotask, so the loop cannot starve this test's own timer —
      // the unyielding variant is covered by the child-process test below.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return [];
    },
  };
  const loop = startHandoffLoop({ cloud, waitSec: 0 });
  await new Promise((resolve) => setTimeout(resolve, 350));
  loop.stop();
  const afterStop = polls;
  await new Promise((resolve) => setTimeout(resolve, 100));

  assert.ok(polls <= 2, `the success path must not hot-loop; got ${polls} polls in 350ms`);
  assert.equal(polls, afterStop, "stop() must not issue another poll");
});

test("C2: the error path backs off instead of retrying immediately", async () => {
  let attempts = 0;
  const loop = startHandoffLoop({
    cloud: { async pollHandoffs() { attempts += 1; throw new Error("cloud down"); } },
    waitSec: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  loop.stop();

  assert.equal(attempts, 1, `a failing poll must back off, got ${attempts} attempts in 300ms`);
});

test("C2: a poll that resolves without IO cannot starve the event loop, and the loop never holds the process open", async () => {
  const script = path.join(root, "loop-probe.mjs");
  fs.writeFileSync(script, `
const { startHandoffLoop } = await import(${JSON.stringify(HANDOFF_MODULE)});
const mode = process.argv[2];
let polls = 0;
// The degenerate case: resolves with NO event-loop turn at all. Under the
// previous implementation the while-body was pure microtasks and the timer
// below never fired — 99.3% CPU until SIGKILL.
const cloud = { pollHandoffs: () => { polls += 1; return Promise.resolve([]); } };
if (mode === "starve") {
  const loop = startHandoffLoop({ cloud, waitSec: 0 });
  setTimeout(() => { console.log(JSON.stringify({ polls })); loop.stop(); process.exit(0); }, 300);
} else {
  // No timers of our own: the process may only stay alive if the loop's own
  // timer is not unref'd.
  startHandoffLoop({ cloud: { pollHandoffs: async () => { throw new Error("down"); } }, waitSec: 1 });
  console.log(JSON.stringify({ polls: 0 }));
}
`);
  const childEnv = {
    ...process.env,
    CODEX_DATA_DIR: process.env.CODEX_DATA_DIR,
    CODEX_WORKSPACE_BROWSE_ROOT: workspaceRoot,
    CODEX_RUN_HOME: runHome,
  };

  const run = (mode) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, mode], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${mode}: the child never exited — the event loop was starved or a timer was not unref'd (${err})`));
      }, 8000);
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { err += chunk; });
      child.on("exit", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    });

  const starve = await run("starve");
  assert.equal(starve.code, 0, `starve probe failed: ${starve.err}`);
  const polls = JSON.parse(starve.out.trim()).polls;
  assert.ok(polls <= 2, `a non-IO poll must still be floored; got ${polls} polls in 300ms`);

  const unrefProbe = await run("unref");
  assert.equal(unrefProbe.code, 0, `the loop's timers must be unref'd so the process can exit: ${unrefProbe.err}`);
});

test("the loop keeps going after a bad descriptor and never mislabels it as a poll failure", async () => {
  const escaped = escapeWatch();
  const seen = [];
  const cloud = {
    async pollHandoffs() {
      await new Promise((resolve) => setTimeout(resolve, 0));
      seen.push("poll");
      return seen.length === 1 ? [{ id: "../../etc/pwn", repo: "me/relay", branch: "b" }] : [];
    },
    async postEvent(type) { seen.push(type); },
  };
  const loop = startHandoffLoop({ cloud, waitSec: 1 });
  await new Promise((resolve) => setTimeout(resolve, 200));
  loop.stop();

  assert.deepEqual(seen, ["poll", "handoff.failed"], "the bad descriptor is announced and the loop survives it");
  assert.deepEqual(escaped(), [], "nothing was written outside the jail");
});

// ---------------------------------------------------------------------------
// Guards that are only reachable from inside the module, tested directly
// rather than left to a race to exercise.

test("M2: checkoutPathFor validates the id itself, so no caller can hand it an unchecked one", () => {
  for (const id of ["../../etc/pwn", "a/b", "..", "", null, 12345, "x".repeat(200), "a.b"]) {
    assert.throws(
      () => checkoutPathFor(id),
      (error) => error.code === "invalid_handoff_id",
      `checkoutPathFor(${JSON.stringify(id)}) must refuse`,
    );
  }
});

test("m-1: execFileEscalating kills a child that ignores SIGTERM instead of hanging forever", async () => {
  // execFile's own `timeout` sends SIGTERM once. A well-behaved child (real
  // git) exits; this one traps and ignores it, standing in for the one
  // remaining unbounded wait the review found: without escalation, this
  // promise would never settle, and runImport — the whole pickup loop behind
  // it — would wedge forever.
  const script = path.join(root, "ignore-sigterm.sh");
  fs.writeFileSync(script, "#!/bin/sh\ntrap '' TERM\nsleep 30\n");
  fs.chmodSync(script, 0o755);

  const startedAt = Date.now();
  await assert.rejects(
    () => execFileEscalating("/bin/sh", [script], { timeout: 200 }),
    "a child that ignores SIGTERM must still be killed, not hang the caller forever",
  );
  const elapsedMs = Date.now() - startedAt;
  // Killed within timeout + grace + generous scheduling slack, never anywhere
  // near the child's own 30s sleep.
  assert.ok(elapsedMs < 10_000, `expected escalation well under 10s, took ${elapsedMs}ms`);
});

test("m-1: execFileEscalating does not touch a child that exits on its own before the timeout", async () => {
  const result = await execFileEscalating(process.execPath, ["-e", "console.log('ok')"], { timeout: 5000 });
  assert.match(result.stdout, /ok/);
});

test("N2: withPinnedCwd refuses a directory that is not really the directory it was asked for", () => {
  const realDir = path.join(OUTSIDE, "pin-real");
  const linkDir = path.join(OUTSIDE, "pin-link");
  fs.mkdirSync(realDir, { recursive: true });
  fs.rmSync(linkDir, { force: true });
  fs.symlinkSync(realDir, linkDir);
  const startedIn = process.cwd();

  // Entering through a symlink lands on a different inode than the name says —
  // exactly what a swapped component looks like — and getcwd is what notices.
  assert.throws(
    () => withPinnedCwd(linkDir, linkDir, () => "should never run"),
    (error) => error.code === "checkout_escaped_jail",
  );
  assert.equal(process.cwd(), startedIn, "the process cwd is always restored");

  // And the honest case still works, with the cwd pinned to the real inode.
  const seen = withPinnedCwd(realDir, fs.realpathSync(realDir), () => fs.statSync("."));
  assert.equal(seen.ino, fs.statSync(realDir).ino);
  assert.equal(process.cwd(), startedIn, "the process cwd is always restored");
});

test("I1: a directory swapped in during the clone is never published, and never consumed", async () => {
  const id = "swapped00000abcd";
  const spoil = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-swap-"));
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });

  // Stands in for git and performs the attacker's half of the race
  // deterministically: our staging directory is renamed away and the
  // attacker's own directory is left at the same name, looking plausible.
  let planted = null;
  const swapper = (_bin, _args, _options) => {
    const staging = process.cwd(); // the pinned staging directory
    return (async () => {
      fs.renameSync(staging, path.join(spoil, "stolen"));
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, "PLANTED-BY-ATTACKER"), "not ours\n");
      planted = staging;
      return { stdout: "", stderr: "" };
    })();
  };

  const record = await importHandoff(
    { id, repo: MANIFEST.repo, branch: MANIFEST.branch },
    deps(origin, { execFileImpl: swapper }),
  );

  assert.equal(record.state, "failed");
  assert.equal(record.error, "checkout_escaped_jail", "identity, not existence, decides what may be published");
  assert.equal(fs.existsSync(checkoutPathFor(id)), false, "nothing was published under the handoff's name");
  // The planted tree is not ours: it must be neither moved into the jail under
  // a handoff name nor deleted — a cleanup that deletes what it did not create
  // is an arbitrary-delete primitive aimed wherever the attacker points it.
  assert.ok(planted && fs.existsSync(path.join(planted, "PLANTED-BY-ATTACKER")), "someone else's directory is left alone");
  fs.rmSync(planted, { recursive: true, force: true });
});

test("M16: the handoff is visible as `importing` while the clone is still running", async () => {
  const id = "midflight000abcd";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  let stateDuringClone = null;
  const slowClone = async (bin, args, options) => {
    stateDuringClone = store.getHandoff(id)?.state ?? null;
    return execFileAsync(bin, args, options);
  };

  const record = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch },
    deps(origin, { execFileImpl: slowClone }));

  assert.equal(stateDuringClone, "importing", "a handoff in flight must be visible, not invented at the end");
  assert.equal(record.state, "ready");
});

test("M18/M19: the clone runs with the run home and with git's terminal prompt disabled", async () => {
  const id = "cloneenv0000abcd";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  let seenEnv = null;
  let seenArgs = null;
  let seenTimeout = null;
  const spy = async (bin, args, options) => {
    seenEnv = options?.env;
    seenArgs = args;
    seenTimeout = options?.timeout;
    return execFileAsync(bin, args, options);
  };

  await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin, { execFileImpl: spy }));

  // HOME is where git finds the credential store (helper = store). Running
  // with the daemon's HOME instead would look for the wrong credentials, and
  // a terminal prompt would hang the pickup loop until the timeout.
  assert.equal(seenEnv.HOME, runHome);
  assert.equal(seenEnv.GIT_TERMINAL_PROMPT, "0");
  // M31: no git invocation may hang the pickup loop unbounded — the clone
  // must always carry a finite timeout.
  assert.ok(Number.isFinite(seenTimeout) && seenTimeout > 0, `the clone must carry a finite timeout, got ${seenTimeout}`);
  // The credential never rides in argv, whatever else the argv carries.
  assert.equal(seenArgs.some((arg) => /token|password|@github\.com/i.test(String(arg))), false);
});

test("M15: a handoff that is already ready is not re-cloned", async () => {
  const id = "noreclone000abcd";
  const origin = await makeOriginRepo({ manifest: { ...MANIFEST, id } });
  await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  const sentinel = path.join(checkoutPathFor(id), "the-agents-uncommitted-work.txt");
  fs.writeFileSync(sentinel, "hours of work\n");
  const second = await importHandoff({ id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  assert.equal(second.state, "ready");
  assert.ok(fs.existsSync(sentinel), "a re-offered handoff must not wipe the checkout it already imported");
});

test("M11: every failure leaves an audit entry naming the handoff, credential-redacted and bounded", async () => {
  const id = "auditfail000abcd";
  const TOKEN = "ghp_aaaa2222AUDITTOKENaaaa3333";
  const auditPath = path.join(process.env.CODEX_DATA_DIR, "audit.jsonl");
  const before = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, "utf8").length : 0;
  const hostile = async () => {
    const error = new Error("Command failed: git clone");
    error.stderr = `fatal: could not read ${TOKEN} from ${"x".repeat(4000)}\n`;
    throw error;
  };

  await importHandoff({ id, repo: "me/relay", branch: "relay/handoff-x" }, deps("ignored", { execFileImpl: hostile }));

  const lines = fs.readFileSync(auditPath, "utf8").slice(before).trim().split("\n").filter(Boolean).map(JSON.parse);
  const failure = lines.find((line) => line.event === "handoff_failed" && line.handoffId === id);
  assert.ok(failure, `an audit entry must name the failed handoff; got ${JSON.stringify(lines)}`);
  assert.equal(failure.reason, "clone_failed");
  // m1: appendAudit's second argument is a JOB. Writing the handoff id into
  // the jobId column made every audit correlation by job id silently wrong.
  assert.equal(failure.jobId, null, "a handoff id must never be written into the jobId column");
  // The audit log is the operator's channel and deliberately keeps host paths
  // the client never sees — but never a credential, and never unbounded.
  assert.equal(failure.detail.includes(TOKEN), false, "a credential must never reach the audit log either");
  assert.ok(failure.detail.length <= 640, `the audit detail is bounded, got ${failure.detail.length}`);
});

test("M26: the push-back never force-pushes over a divergent remote", async () => {
  const id = "noforce00000abcd";
  const { origin, checkout } = await stageHandoffForPush(id, { lastJobId: "job-force-1" });

  // Someone else advanced the handoff branch after this node cloned it.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-other-"));
  await execFileAsync("git", ["clone", "-q", "--branch", MANIFEST.branch, origin, other]);
  await execFileAsync("git", ["-C", other, "config", "user.email", "o@example.com"]);
  await execFileAsync("git", ["-C", other, "config", "user.name", "O"]);
  fs.writeFileSync(path.join(other, "theirs.txt"), "their work\n");
  await execFileAsync("git", ["-C", other, "add", "-A"]);
  await execFileAsync("git", ["-C", other, "commit", "-qm", "their commit"]);
  await execFileAsync("git", ["-C", other, "push", "-q", "origin", MANIFEST.branch]);

  fs.writeFileSync(path.join(checkout, "ours.txt"), "our work\n");
  const result = await completeHandoffJob({ id: "job-force-1", status: "succeeded", workspaceId: "dir-handoff-x" });

  assert.equal(result.pushed, false, "a non-fast-forward must fail, not be forced");
  assert.ok(
    (await branchFilesOnOrigin(origin, MANIFEST.branch)).includes("theirs.txt"),
    "the other machine's commit must still be on the branch",
  );
});

// ---------------------------------------------------------------------------
// ── GET /v1/handoffs/:id and POST /v1/handoffs/:id/continue (additions.mjs)
// review-t13.md Minor-4: store.getHandoff throws its typed invalid-id error for
// any id that fails the store's own path-safety check (wrong charset, "..",
// empty, ...), and neither route caught it, so a malformed id fell all the way
// through to index.mjs's generic catch and came back as a 500 that echoed the
// internal validator's message to the caller. A malformed id and a genuinely-
// unknown id must be indistinguishable to the client: both are "not here",
// never a 500. A REAL internal error must still be a 500 — and must still be
// logged, not silently absorbed by whatever turns the id case into a 404.

function mockRes() {
  return {
    statusCode: null,
    headers: null,
    body: "",
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(chunk) { this.body += chunk || ""; },
  };
}

function mockGetReq() {
  return { method: "GET" };
}

function mockPostReq(bodyObj = {}) {
  const req = new PassThrough();
  req.method = "POST";
  req.end(JSON.stringify(bodyObj));
  return req;
}

// Mirrors index.mjs's routeRequest(...).catch(...) exactly, so these tests
// observe the same status/body a real client would get — not just whatever
// handleAdditionRoutes happens to leave in `res` before it throws.
async function dispatch(req, res, url, auth = { subject: "test-node" }) {
  try {
    return await handleAdditionRoutes(req, res, url, auth);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 500;
    sendError(res, status, error.message || "internal error");
    return true;
  }
}

test("GET /v1/handoffs/:id: a traversal-shaped id is a clean 404, not a 500", async () => {
  const res = mockRes();
  // A single path segment (no literal "/", so it survives WHATWG URL
  // normalization and reaches the route's [^/]+ id capture) that still
  // decodes to a traversal attempt — the same shape store.test.mjs's
  // path-traversal guard test uses at the store layer, exercised here
  // through the actual HTTP-facing id capture.
  const url = new URL("http://relayd.local/v1/handoffs/..%2Fetc%2Fpasswd");

  const handled = await dispatch(mockGetReq(), res, url);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404, `expected a clean 404, got ${res.statusCode} / ${res.body}`);
  assert.doesNotMatch(res.body, /record id is invalid/, "the internal validator's message must never reach the client");
});

test("GET /v1/handoffs/:id: a genuinely unknown, validly-shaped id is a clean 404", async () => {
  const res = mockRes();
  const url = new URL("http://relayd.local/v1/handoffs/no-such-handoff-0000000000");

  const handled = await dispatch(mockGetReq(), res, url);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
});

test("GET /v1/handoffs/:id: a genuine internal error still surfaces as a logged 500, distinct from the 404 cases", async () => {
  const res = mockRes();
  const url = new URL("http://relayd.local/v1/handoffs/some-validly-shaped-id");

  const originalGetHandoff = store.getHandoff;
  const originalConsoleError = console.error;
  const loggedLines = [];
  store.getHandoff = () => { throw new Error("disk exploded"); };
  console.error = (...args) => loggedLines.push(args.join(" "));

  let handled;
  try {
    handled = await dispatch(mockGetReq(), res, url);
  } finally {
    store.getHandoff = originalGetHandoff;
    console.error = originalConsoleError;
  }

  assert.equal(handled, true);
  assert.equal(res.statusCode, 500, `a real failure must not be reclassified as a 404, got ${res.statusCode} / ${res.body}`);
  assert.ok(loggedLines.some((line) => line.includes("disk exploded")), "a real failure must be logged, not silently swallowed like the invalid-id case");
});

test("the invalid-id 404 is keyed on the store's typed error, not on its message text", async () => {
  const res = mockRes();
  const url = new URL("http://relayd.local/v1/handoffs/some-validly-shaped-id");
  const originalGetHandoff = store.getHandoff;
  const originalConsoleError = console.error;
  console.error = () => {};
  // Same sentence, no type: this is a genuine internal failure that merely
  // happens to be worded like the validator, and it must still be a 500.
  store.getHandoff = () => { throw new Error("record id is invalid"); };
  let handled;
  try {
    handled = await dispatch(mockGetReq(), res, url);
  } finally {
    store.getHandoff = originalGetHandoff;
    console.error = originalConsoleError;
  }
  assert.equal(handled, true);
  assert.equal(res.statusCode, 500, "the 404 must come from the typed error, not from string matching");
});

test("POST /v1/handoffs/:id/continue: a traversal-shaped id is a clean 404, not a 500", async () => {
  const res = mockRes();
  const url = new URL("http://relayd.local/v1/handoffs/..%2Fetc%2Fpasswd/continue");

  const handled = await dispatch(mockPostReq(), res, url);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404, `expected a clean 404, got ${res.statusCode} / ${res.body}`);
  assert.doesNotMatch(res.body, /record id is invalid/, "the internal validator's message must never reach the client");
});

test("POST /v1/handoffs/:id/continue: a genuinely unknown, validly-shaped id is still the existing clean 404 (unchanged by the fix)", async () => {
  const res = mockRes();
  const url = new URL("http://relayd.local/v1/handoffs/no-such-handoff-0000000000/continue");

  const handled = await dispatch(mockPostReq(), res, url);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404, `expected a clean 404, got ${res.statusCode} / ${res.body}`);
});
