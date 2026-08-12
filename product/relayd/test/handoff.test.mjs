import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-"));
const workspaceRoot = path.join(root, "workspaces");
const runHome = path.join(root, "home");
fs.mkdirSync(workspaceRoot, { recursive: true });
fs.mkdirSync(runHome, { recursive: true });

process.env.CODEX_DATA_DIR ||= path.join(root, "data");
process.env.CODEX_WORKSPACE_BROWSE_ROOT ||= workspaceRoot;
process.env.CODEX_WORKSPACES ||= JSON.stringify([{ id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") }]);
process.env.CODEX_RUN_HOME ||= runHome;

const { initIdentity, identityPaths, readEncPublicKeyB64 } = await import("../src/identity.mjs");
const { sealTo } = await import("../src/seal.mjs");
const { importHandoff } = await import("../src/handoff.mjs");
const { store } = await import("../src/store.mjs");

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

// Builds a bare repo that stands in for GitHub, containing the handoff branch
// with sealed blobs exactly as `relay handoff` would have pushed them.
async function makeOriginRepo({ manifest = MANIFEST, sessionBytes = Buffer.from(
  `${JSON.stringify({ type: "user", cwd: manifest.cwd, message: "hello" })}\n`, "utf8") } = {}) {
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

  const encPubkey = readEncPublicKeyB64(identityPaths(IDENTITY_DIR));
  const blobDir = path.join(work, ".relay", "handoff", manifest.id);
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, "manifest.enc"), sealTo(encPubkey, Buffer.from(JSON.stringify(manifest), "utf8")));
  if (sessionBytes) fs.writeFileSync(path.join(blobDir, "session.enc"), sealTo(encPubkey, sessionBytes));
  await git("add", "-A");
  await git("commit", "-qm", "relay handoff");
  await execFileAsync("git", ["clone", "-q", "--bare", work, bare]);
  return bare;
}

function deps(originPath) {
  const events = [];
  return {
    events,
    cloud: { postEvent: async (type, extra) => { events.push({ type, ...extra }); return { status: 202 }; } },
    baseDir: IDENTITY_DIR,
    runHome,
    remoteUrlFor: () => originPath,
  };
}

test("a handoff is cloned, decrypted, staged for resume, and announced", async () => {
  const origin = await makeOriginRepo();
  const options = deps(origin);

  const record = await importHandoff({ id: MANIFEST.id, repo: MANIFEST.repo, branch: MANIFEST.branch }, options);

  assert.equal(record.state, "ready");
  assert.equal(record.title, "Fix the auth redirect");
  assert.equal(record.provider, "claude");
  assert.equal(record.resumeSessionId, MANIFEST.sessionId);

  const checkout = path.join(workspaceRoot, `handoff-${MANIFEST.id.slice(0, 12)}`);
  assert.ok(fs.existsSync(path.join(checkout, "README.md")), "the branch is checked out");
  assert.ok(record.workspaceId, "a workspace id is registered so jobs can target it");

  // The Claude project slug is derived from the checkout's REAL (symlink-
  // resolved) path — config.mjs realpath-resolves workspaceBrowseRoot at
  // load, and every job/dynamic-workspace path in this codebase is built
  // from that resolved root, so the harness always sees the resolved form as
  // its cwd. On macOS, os.tmpdir() lives under /var, itself a symlink to
  // /private/var, so the lexical `checkout` above and the real path the
  // session was actually staged under can differ in that one prefix even
  // though both name the same directory on disk.
  const realCheckout = fs.realpathSync(checkout);
  const staged = path.join(runHome, ".claude", "projects", realCheckout.replace(/[^A-Za-z0-9]/g, "-"),
    `${MANIFEST.sessionId}.jsonl`);
  assert.ok(fs.existsSync(staged), "the session is staged where --resume finds it");
  assert.ok(!fs.readFileSync(staged, "utf8").includes("/Users/dev/code/relay"), "the laptop path is rewritten away");

  assert.deepEqual(options.events.map((event) => event.type), ["handoff.ready"]);
  assert.equal(store.getHandoff(MANIFEST.id).state, "ready");
});

test("plaintext never reaches the checkout — only sealed blobs are committed", async () => {
  const origin = await makeOriginRepo();
  await importHandoff({ id: MANIFEST.id, repo: MANIFEST.repo, branch: MANIFEST.branch }, deps(origin));

  const checkout = path.join(workspaceRoot, `handoff-${MANIFEST.id.slice(0, 12)}`);
  const sealed = fs.readFileSync(path.join(checkout, ".relay", "handoff", MANIFEST.id, "session.enc"));
  assert.ok(!sealed.includes(Buffer.from("hello", "utf8")), "the committed session blob stays ciphertext");
});

test("a handoff with no session blob still lands as ready with a primed prompt", async () => {
  const manifest = { ...MANIFEST, id: "bbb123def4567890", harness: "cursor", sessionFormat: "none", sessionId: null };
  const origin = await makeOriginRepo({ manifest, sessionBytes: null });

  const record = await importHandoff({ id: manifest.id, repo: manifest.repo, branch: manifest.branch }, deps(origin));

  assert.equal(record.state, "ready");
  assert.equal(record.resumeSessionId, null);
  assert.match(record.primedPrompt, /Fix the auth redirect/);
});

test("a clone failure is recorded and announced, never silent", async () => {
  const options = deps("/nonexistent/repo.git");
  const record = await importHandoff({ id: "ccc123def4567890", repo: "me/relay", branch: "relay/handoff-x" }, options);

  assert.equal(record.state, "failed");
  assert.match(record.error, /clone_failed/);
  assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"]);
  assert.equal(store.getHandoff("ccc123def4567890").state, "failed");
});

test("a blob sealed to another node is refused", async () => {
  const strangerDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-stranger-"));
  initIdentity({ baseDir: strangerDir });
  const manifest = { ...MANIFEST, id: "ddd123def4567890" };

  // Seal to the stranger's key, then import as ourselves.
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-handoff-badseal-"));
  const bare = `${work}.git`;
  const git = (...args) => execFileAsync("git", ["-C", work, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", work]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  fs.writeFileSync(path.join(work, "README.md"), "# repo\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  await git("checkout", "-qb", manifest.branch);
  const blobDir = path.join(work, ".relay", "handoff", manifest.id);
  fs.mkdirSync(blobDir, { recursive: true });
  fs.writeFileSync(path.join(blobDir, "manifest.enc"),
    sealTo(readEncPublicKeyB64(identityPaths(strangerDir)), Buffer.from(JSON.stringify(manifest), "utf8")));
  await git("add", "-A");
  await git("commit", "-qm", "relay handoff");
  await execFileAsync("git", ["clone", "-q", "--bare", work, bare]);

  const options = deps(bare);
  const record = await importHandoff({ id: manifest.id, repo: manifest.repo, branch: manifest.branch }, options);

  assert.equal(record.state, "failed");
  assert.match(record.error, /seal_decrypt_failed/);
  assert.deepEqual(options.events.map((event) => event.type), ["handoff.failed"]);
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
