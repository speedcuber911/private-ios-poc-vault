import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-data-"));
// syncauth.mjs now reaches the rendezvous, so it pulls in pairing.mjs (the
// node's canonical authToken/macKey/tag derivations) and, through it, the
// daemon's module graph. Same preamble test/handoff.test.mjs uses, for the
// same reason: workspaces.mjs mkdirs its configured roots at import time, and
// the default root (/srv/codex-workspaces) does not exist on a dev machine.
{
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-ws-"));
  process.env.CODEX_WORKSPACE_BROWSE_ROOT ||= workspaceRoot;
  process.env.CODEX_WORKSPACES ||= JSON.stringify([
    { id: "welcome", name: "Welcome", path: path.join(workspaceRoot, "welcome") },
  ]);
  process.env.CODEX_RUN_HOME ||= path.join(workspaceRoot, "home");
}

const {
  installCredentialBundle, saveMacSessions, readMacSessions,
  collectRendezvousBlob, installFromNotice,
} = await import("../src/syncauth.mjs");
const { auditPath } = await import("../src/config.mjs");
const { initIdentity, identityPaths, readEncPublicKeyB64 } = await import("../src/identity.mjs");
const { sealTo, generateEncKeyPair } = await import("../src/seal.mjs");
const { pairingAuthToken, pairingMacKey, blobTag, DEVICE_SLOT } = await import("../src/pairing.mjs");

// Reads audit.jsonl entries appended since `sinceLength` (the file's own
// byte length at some earlier point, from readAuditLength()) and parses
// each as JSON — the same before/after-length pattern test/handoff.test.mjs
// and test/pairing.test.mjs already use to isolate one action's audit lines
// from everything else appended to the same shared log by other tests.
function readAuditLength() {
  try {
    return fs.readFileSync(auditPath, "utf8").length;
  } catch {
    return 0;
  }
}
function readAuditSince(sinceLength) {
  let text = "";
  try {
    text = fs.readFileSync(auditPath, "utf8");
  } catch {
    return [];
  }
  return text.slice(sinceLength).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-"));
  return {
    runHome: path.join(root, "home"),
    codexHome: path.join(root, "codex"),
    kimiHome: path.join(root, "kimi"),
    dataDir: root,
  };
}

// Recursively scans every regular file under `rootDir` and returns the full
// paths of every one whose contents include `marker`. Used instead of
// checking one exact expected path, per the lesson that an exploit can write
// a slightly different name than a narrower assertion happens to check —
// `rootDir` should be a directory that encloses every plausible destination
// (both the legitimate one and any escape route), so the caller can assert
// on the exact SET of matches rather than a single yes/no.
function findFilesContainingMarker(rootDir, marker) {
  const matches = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        stack.push(full);
      } else if (entry.isFile()) {
        try {
          if (fs.readFileSync(full, "utf8").includes(marker)) matches.push(full);
        } catch {
          /* unreadable/binary — not where a credential would land as text */
        }
      }
    }
  }
  return matches;
}

function treeContainsMarker(rootDir, marker) {
  return findFilesContainingMarker(rootDir, marker).length > 0;
}

// Any staging/temp file left behind after a successful write is a bug in the
// create-and-rename shape (it should always be renamed away or cleaned up on
// failure). Scans by content of the name, not by one exact path.
function findTmpLeftovers(rootDir) {
  const found = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(full);
      else if (entry.name.includes(".tmp")) found.push(full);
    }
  }
  return found;
}

test("a full bundle installs every credential 0600 in the runner home", () => {
  const { runHome, codexHome, kimiHome } = homes();
  const result = installCredentialBundle({
    v: 1, kind: "sync-auth",
    github: { token: "ghp_example" },
    claude: { credentials: '{"token":"claude"}' },
    codex: { auth: '{"token":"codex"}' },
    kimi: {
      credentials: '{"refresh_token":"kimi"}',
      config: 'default_model = "kimi-code/k3"\n',
    },
  }, { runHome, codexHome, kimiHome });

  assert.deepEqual(result.installed.sort(), ["claude", "codex", "github", "kimi"]);
  assert.deepEqual(result.skipped, []);

  const gitCredentials = path.join(runHome, ".git-credentials");
  assert.equal(fs.readFileSync(gitCredentials, "utf8").trim(), "https://x-access-token:ghp_example@github.com");
  assert.equal(fs.statSync(gitCredentials).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(runHome, ".claude", ".credentials.json")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), '{"token":"codex"}');
  assert.equal(fs.readFileSync(path.join(kimiHome, "credentials", "kimi-code.json"), "utf8"), '{"refresh_token":"kimi"}');
  assert.equal(fs.readFileSync(path.join(kimiHome, "config.toml"), "utf8"), 'default_model = "kimi-code/k3"\n');
  assert.equal(fs.statSync(path.join(kimiHome, "credentials", "kimi-code.json")).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(kimiHome, "config.toml")).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(path.join(runHome, ".gitconfig"), "utf8"), /helper = store/);
});

test("absent members are reported as skipped rather than silently ignored", () => {
  const { runHome, codexHome } = homes();
  const result = installCredentialBundle({ v: 1, kind: "sync-auth", github: { token: "ghp_only" } },
    { runHome, codexHome });

  assert.deepEqual(result.installed, ["github"]);
  assert.deepEqual(result.skipped.sort(), ["claude", "codex", "kimi"]);
  assert.equal(fs.existsSync(path.join(runHome, ".claude", ".credentials.json")), false);
});

test("a bundle of the wrong kind or version is refused", () => {
  const { runHome, codexHome } = homes();
  assert.throws(() => installCredentialBundle({ v: 2, kind: "sync-auth" }, { runHome, codexHome }),
    /unsupported_bundle_version/);
  assert.throws(() => installCredentialBundle({ v: 1, kind: "session-index" }, { runHome, codexHome }),
    /unexpected_bundle_kind/);
});

test("the session index round-trips and holds no transcripts", () => {
  const { dataDir } = homes();
  saveMacSessions({
    v: 1, kind: "session-index", machine: "MacBook-Pro", updatedAt: "2026-08-11T10:00:00.000Z",
    sessions: [{ id: "s1", harness: "claude", title: "Fix auth", repo: "me/relay", lastActive: "2026-08-11T09:00:00.000Z" }],
  }, { dataDir });

  const index = readMacSessions({ dataDir });
  assert.equal(index.machine, "MacBook-Pro");
  assert.equal(index.sessions[0].title, "Fix auth");
  assert.deepEqual(Object.keys(index.sessions[0]).sort(), ["harness", "id", "lastActive", "repo", "title"]);
});

test("reading an index that was never written returns null", () => {
  assert.equal(readMacSessions({ dataDir: homes().dataDir }), null);
});

// --- Critical: a pre-planted HARD LINK at a credential destination must ---
// --- never be written through. O_NOFOLLOW rejects a symlink at the leaf ---
// --- but is powerless against a hard link, because a hard link is not a ---
// --- link at the path level at all — it is a second name for the same  ---
// --- inode. The only robust defense is to never open the existing leaf ---
// --- name for writing at all.                                          ---
test("a pre-planted hard link at .git-credentials is never written through", () => {
  const { runHome, codexHome } = homes();
  fs.mkdirSync(runHome, { recursive: true, mode: 0o700 });

  const marker = "PRISTINE_OUTSIDE_FILE_MARKER_do_not_touch";
  const outsideCanary = path.join(path.dirname(runHome), "outside-canary.txt");
  fs.writeFileSync(outsideCanary, marker);
  fs.chmodSync(outsideCanary, 0o644);
  const beforeIno = fs.statSync(outsideCanary).ino;

  // Pre-plant the hard link at the exact destination path this module writes
  // github credentials to.
  fs.linkSync(outsideCanary, path.join(runHome, ".git-credentials"));
  assert.equal(fs.statSync(path.join(runHome, ".git-credentials")).ino, beforeIno, "setup: same inode");

  const auditSince = readAuditLength();
  const attackToken = "ghp_hardlink_attack_token_MARKER";
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", github: { token: attackToken } },
    { runHome, codexHome },
  );

  // task-15 review follow-up (Recommendation 2): replacing a poisoned leaf
  // is the right call for the write itself, but it must not be entirely
  // silent — an operator watching the audit log needs to know a hard link
  // sat at a credential destination and was replaced, without the log ever
  // carrying the credential itself.
  const auditEntries = readAuditSince(auditSince);
  const replaced = auditEntries.filter((entry) => entry.event === "credential_destination_replaced");
  assert.equal(replaced.length, 1, `expected exactly one audit line, got ${JSON.stringify(auditEntries)}`);
  assert.equal(replaced[0].priorKind, "hardlink");
  assert.equal(replaced[0].path, path.join(fs.realpathSync(runHome), ".git-credentials"));
  assert.ok(!JSON.stringify(replaced[0]).includes(attackToken), "audit line must never carry credential content");

  // The outside file must be byte-for-byte untouched: no token, no truncation.
  assert.equal(fs.readFileSync(outsideCanary, "utf8"), marker);
  assert.equal(fs.statSync(outsideCanary).mode & 0o777, 0o644, "outside file mode must be untouched");

  // The attack token must land in EXACTLY the legitimate destination and
  // nowhere else in the whole scratch tree — glob the whole tree and assert
  // the exact set of matches, not one exact expected path.
  const matches = findFilesContainingMarker(path.dirname(runHome), attackToken);
  assert.deepEqual(matches, [path.join(runHome, ".git-credentials")]);

  // The real destination must now be a FRESH inode the module itself
  // created, with the correct content and the correct mode — proving the
  // hard link's directory entry was replaced, not written through.
  const afterStat = fs.statSync(path.join(runHome, ".git-credentials"));
  assert.notEqual(afterStat.ino, beforeIno, "the hard link must be severed, not written through");
  assert.equal(afterStat.mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(path.join(runHome, ".git-credentials"), "utf8").trim(),
    `https://x-access-token:${attackToken}@github.com`,
  );
  assert.deepEqual(result.installed, ["github"]);

  assert.deepEqual(findTmpLeftovers(runHome), []);
});

test("a pre-planted hard link at .claude/.credentials.json is never written through", () => {
  const { runHome, codexHome } = homes();
  fs.mkdirSync(path.join(runHome, ".claude"), { recursive: true, mode: 0o700 });

  const marker = "PRISTINE_CLAUDE_CANARY_MARKER";
  const outsideCanary = path.join(path.dirname(runHome), "claude-outside-canary.json");
  fs.writeFileSync(outsideCanary, marker);
  fs.chmodSync(outsideCanary, 0o644);
  const beforeIno = fs.statSync(outsideCanary).ino;
  fs.linkSync(outsideCanary, path.join(runHome, ".claude", ".credentials.json"));

  const attackSecret = '{"token":"claude_hardlink_attack_MARKER"}';
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", claude: { credentials: attackSecret } },
    { runHome, codexHome },
  );

  assert.equal(fs.readFileSync(outsideCanary, "utf8"), marker);
  assert.equal(fs.statSync(outsideCanary).mode & 0o777, 0o644);
  const claudeMatches = findFilesContainingMarker(path.dirname(runHome), "claude_hardlink_attack_MARKER");
  assert.deepEqual(claudeMatches, [path.join(runHome, ".claude", ".credentials.json")]);

  const afterStat = fs.statSync(path.join(runHome, ".claude", ".credentials.json"));
  assert.notEqual(afterStat.ino, beforeIno);
  assert.equal(afterStat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(runHome, ".claude", ".credentials.json"), "utf8"), attackSecret);
  assert.deepEqual(result.installed, ["claude"]);
});

test("a pre-planted hard link at codex auth.json is never written through", () => {
  const { runHome, codexHome } = homes();
  fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });

  const marker = "PRISTINE_CODEX_CANARY_MARKER";
  const outsideCanary = path.join(path.dirname(codexHome), "codex-outside-canary.json");
  fs.writeFileSync(outsideCanary, marker);
  fs.chmodSync(outsideCanary, 0o644);
  const beforeIno = fs.statSync(outsideCanary).ino;
  fs.linkSync(outsideCanary, path.join(codexHome, "auth.json"));

  const attackSecret = '{"token":"codex_hardlink_attack_MARKER"}';
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", codex: { auth: attackSecret } },
    { runHome, codexHome },
  );

  assert.equal(fs.readFileSync(outsideCanary, "utf8"), marker);
  assert.equal(fs.statSync(outsideCanary).mode & 0o777, 0o644);
  const codexMatches = findFilesContainingMarker(path.dirname(codexHome), "codex_hardlink_attack_MARKER");
  assert.deepEqual(codexMatches, [path.join(codexHome, "auth.json")]);

  const afterStat = fs.statSync(path.join(codexHome, "auth.json"));
  assert.notEqual(afterStat.ino, beforeIno);
  assert.equal(afterStat.mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), attackSecret);
  assert.deepEqual(result.installed, ["codex"]);
});

// --- Pin: a pre-planted SYMLINK at a credential leaf must not write ---
// --- through to the symlink's target either. ---
test("a pre-planted symlink at .git-credentials is never written through", () => {
  const { runHome, codexHome } = homes();
  fs.mkdirSync(runHome, { recursive: true, mode: 0o700 });

  const marker = "PRISTINE_SYMLINK_TARGET_MARKER";
  const outsideTarget = path.join(path.dirname(runHome), "symlink-target.txt");
  fs.writeFileSync(outsideTarget, marker);
  fs.symlinkSync(outsideTarget, path.join(runHome, ".git-credentials"));

  const auditSince = readAuditLength();
  const attackToken = "ghp_symlink_attack_token_MARKER";
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", github: { token: attackToken } },
    { runHome, codexHome },
  );

  // task-15 review follow-up (Recommendation 2): same audit signal as the
  // hard-link case, for the symlink case the review specifically asked
  // about ("a deliberately-placed operator symlink ... would now vanish
  // with zero trace").
  const auditEntries = readAuditSince(auditSince);
  const replaced = auditEntries.filter((entry) => entry.event === "credential_destination_replaced");
  assert.equal(replaced.length, 1, `expected exactly one audit line, got ${JSON.stringify(auditEntries)}`);
  assert.equal(replaced[0].priorKind, "symlink");
  assert.equal(replaced[0].path, path.join(fs.realpathSync(runHome), ".git-credentials"));

  // The symlink's target must be untouched, and the attack token must land
  // in EXACTLY the legitimate destination, nowhere else in the tree.
  assert.equal(fs.readFileSync(outsideTarget, "utf8"), marker);
  const matches = findFilesContainingMarker(path.dirname(runHome), attackToken);
  assert.deepEqual(matches, [path.join(runHome, ".git-credentials")]);

  // The leaf itself must no longer be a symlink, and must hold the token
  // with the correct mode.
  assert.equal(fs.lstatSync(path.join(runHome, ".git-credentials")).isSymbolicLink(), false);
  assert.equal(fs.statSync(path.join(runHome, ".git-credentials")).mode & 0o777, 0o600);
  assert.equal(
    fs.readFileSync(path.join(runHome, ".git-credentials"), "utf8").trim(),
    `https://x-access-token:${attackToken}@github.com`,
  );
  assert.deepEqual(result.installed, ["github"]);
});

// --- Pin: the routine case (no prior entry, or re-syncing over a plain ---
// --- file this module already wrote) stays silent — only a symlink or ---
// --- hard link at the destination is audit-worthy, per the review's own ---
// --- framing ("not acceptable that it is *entirely* silent", not "must ---
// --- log every write"). A credential sync can happen often; logging the ---
// --- routine case every time would bury the signal that actually matters. ---
test("re-syncing credentials over a plain file (no prior symlink/hard link) does not audit-log", () => {
  const { runHome, codexHome } = homes();
  installCredentialBundle({ v: 1, kind: "sync-auth", github: { token: "ghp_first" } }, { runHome, codexHome });

  const auditSince = readAuditLength();
  installCredentialBundle({ v: 1, kind: "sync-auth", github: { token: "ghp_second" } }, { runHome, codexHome });
  const auditEntries = readAuditSince(auditSince).filter((entry) => entry.event === "credential_destination_replaced");
  assert.deepEqual(auditEntries, []);

  assert.equal(
    fs.readFileSync(path.join(runHome, ".git-credentials"), "utf8").trim(),
    "https://x-access-token:ghp_second@github.com",
  );
});

// --- Pin: a symlinked ancestor directory must be refused, not followed. ---
test("a symlinked ancestor directory is refused rather than followed outside the root", () => {
  const { runHome, codexHome } = homes();
  fs.mkdirSync(runHome, { recursive: true, mode: 0o700 });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-outside-"));

  // runHome/.claude is itself a symlink pointing outside the runner home.
  fs.symlinkSync(outsideDir, path.join(runHome, ".claude"));

  const marker = "SHOULD_NEVER_LEAVE_THE_ROOT_MARKER";
  assert.throws(
    () => installCredentialBundle(
      { v: 1, kind: "sync-auth", claude: { credentials: marker } },
      { runHome, codexHome },
    ),
    /credential_path_escapes_root/,
  );

  assert.equal(treeContainsMarker(outsideDir, marker), false);
});

// --- Pin: a wrong-typed field must be skipped, never stringified into a ---
// --- credential file (`[object Object]` is still a broken credential, ---
// --- and worse, might coerce into something a shell or client trusts). ---
test("a wrong-typed github token is skipped, never coerced into a credential file", () => {
  const { runHome, codexHome } = homes();
  const marker = "WRONG_TYPE_TOKEN_MARKER";
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", github: { token: { evil: marker } } },
    { runHome, codexHome },
  );

  assert.ok(result.skipped.includes("github"));
  assert.ok(!result.installed.includes("github"));
  assert.equal(fs.existsSync(path.join(runHome, ".git-credentials")), false);
  assert.equal(treeContainsMarker(runHome, marker), false);
  assert.equal(treeContainsMarker(runHome, "[object Object]"), false);
});

// --- Pin: saveMacSessions caps stored sessions even when the bundle carries more. ---
test("saveMacSessions caps stored sessions at 200 even when the bundle carries more", () => {
  const { dataDir } = homes();
  const sessions = Array.from({ length: 250 }, (_, i) => ({
    id: `s${i}`, harness: "claude", title: `t${i}`, repo: "r", lastActive: "l",
  }));
  saveMacSessions({ v: 1, kind: "session-index", machine: "M", updatedAt: "t", sessions }, { dataDir });

  const index = readMacSessions({ dataDir });
  assert.equal(index.sessions.length, 200);
});

// --- Pin: the Mac-session-index field allowlist strips transcript/apiKey/prompt ---
// --- even with an adversarial fixture that actually carries those fields. ---
test("transcript/apiKey/prompt fields on a session cannot reach the stored index", () => {
  const { dataDir } = homes();
  const marker = "SECRET_SHOULD_NOT_PERSIST_MARKER";
  saveMacSessions({
    v: 1, kind: "session-index", machine: "M", updatedAt: "t",
    sessions: [{
      id: "s1", harness: "claude", title: "t", repo: "r", lastActive: "l",
      transcript: `full transcript text ${marker}`,
      apiKey: `sk-live-${marker}`,
      prompt: `the actual user prompt ${marker}`,
    }],
  }, { dataDir });

  const index = readMacSessions({ dataDir });
  assert.deepEqual(Object.keys(index.sessions[0]).sort(), ["harness", "id", "lastActive", "repo", "title"]);

  // Scan the real file on disk, not just the parsed object in memory — a
  // stray raw write earlier in the pipeline would show up here even if the
  // in-memory object looked clean.
  assert.equal(treeContainsMarker(dataDir, marker), false);
});

// --- Pin: machine/updatedAt are bounded to plain strings too, not just the ---
// --- per-session fields — a compromised/buggy sender cannot smuggle an    ---
// --- object (e.g. {transcript, token}) through either top-level field by  ---
// --- relying on the old `bundle.machine || null` verbatim copy.          ---
test("machine and updatedAt are bounded to strings — an object planted there never reaches disk", () => {
  const { dataDir } = homes();
  const marker = "SECRET_MACHINE_FIELD_MARKER";
  saveMacSessions({
    v: 1, kind: "session-index",
    machine: { transcript: `leaked ${marker}`, token: `ghp_live_${marker}` },
    updatedAt: { anything: ["also", "unbounded", marker] },
    sessions: [{ id: "s1", harness: "claude", title: "t", repo: "r", lastActive: "l" }],
  }, { dataDir });

  const index = readMacSessions({ dataDir });
  assert.equal(index.machine, null, "an object is not a string — it is dropped to null, not copied verbatim");
  assert.equal(index.updatedAt, null);
  assert.equal(treeContainsMarker(dataDir, marker), false);
});

test("machine and updatedAt still round-trip when they are, correctly, plain strings", () => {
  const { dataDir } = homes();
  saveMacSessions({
    v: 1, kind: "session-index", machine: "MacBook-Pro", updatedAt: "2026-08-12T00:00:00.000Z",
    sessions: [],
  }, { dataDir });

  const index = readMacSessions({ dataDir });
  assert.equal(index.machine, "MacBook-Pro");
  assert.equal(index.updatedAt, "2026-08-12T00:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Wiring the two halves: a notice arrives over the node long-poll, and the
// node collects the sealed bundle, VERIFIES THE MAC, unseals it with its own
// X25519 private key, and installs it. Until this existed, the CLI put
// credentials in a rendezvous slot that nothing ever read — a sync that
// quietly did nothing, which is the single worst outcome for this feature
// because the user believes their sandbox is authenticated when it is not.
//
// Every failure below therefore has to END VISIBLY: an audit line AND an
// emitted event that names the reason and tells the user to re-run
// `relay sync-auth`. None of them may carry a credential, a secret, or a
// fragment of either.

const NOTICE_SECRET = "notice-secret-0123456789_abcdefg";

// A rendezvous the node can actually talk to: serves the device-blob slot
// exactly as product/cloud/src/server.js does (200 + x-pairing-tag, or a
// bare status for the failure cases), and records what it was asked for.
function startFakeRendezvous(respond) {
  return new Promise((resolve) => {
    const calls = [];
    const server = createServer((req, res) => {
      calls.push({ method: req.method, url: req.url, headers: req.headers });
      respond(res, calls.at(-1));
    });
    server.listen(0, "127.0.0.1", () => resolve({
      calls,
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

function serveSealed(blob, tag) {
  return (res) => {
    res.writeHead(200, { "content-type": "application/octet-stream", "x-pairing-tag": tag });
    res.end(blob);
  };
}

// A node with a real identity (ed25519 + X25519), so the seal is opened by
// the module's own readEncPrivateKeyPem path rather than by an injected stub.
function freshNodeIdentity() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-identity-"));
  initIdentity({ baseDir });
  return { baseDir, encPubkeyB64: readEncPublicKeyB64(identityPaths(baseDir)) };
}

function sealedFor(encPubkeyB64, payload, { secret = NOTICE_SECRET } = {}) {
  const blob = sealTo(encPubkeyB64, Buffer.from(JSON.stringify(payload), "utf8"));
  return { blob, tag: blobTag(pairingMacKey(secret), DEVICE_SLOT, blob) };
}

function collector() {
  const events = [];
  const pushed = [];
  return {
    events, pushed,
    emit: (name, data) => events.push({ name, data }),
    postEvent: async (type, extra) => { pushed.push({ type, extra }); return { accepted: true }; },
  };
}

const SYNC_BUNDLE = {
  v: 1, kind: "sync-auth",
  github: { token: "ghp_notice_path_MARKER" },
  claude: { credentials: '{"token":"claude_notice_MARKER"}' },
  codex: { auth: '{"token":"codex_notice_MARKER"}' },
  kimi: {
    credentials: '{"refresh_token":"kimi_notice_MARKER"}',
    config: 'default_model = "kimi-code/k3"\n',
  },
};

test("a notice makes the node collect, verify, unseal and install the sealed bundle", async () => {
  const { runHome, codexHome, kimiHome, dataDir } = homes();
  const node = freshNodeIdentity();
  const { blob, tag } = sealedFor(node.encPubkeyB64, SYNC_BUNDLE);
  const cloud = await startFakeRendezvous(serveSealed(blob, tag));
  const sink = collector();
  const auditSince = readAuditLength();

  try {
    const result = await installFromNotice(
      { pairingId: "11111111-1111-4111-8111-111111111111", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, kimiHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.kind, "sync-auth");
    assert.deepEqual(result.installed.sort(), ["claude", "codex", "github", "kimi"]);

    // The credentials actually landed, at the real modes on disk.
    const gitCredentials = path.join(runHome, ".git-credentials");
    assert.match(fs.readFileSync(gitCredentials, "utf8"), /ghp_notice_path_MARKER/);
    assert.equal(fs.statSync(gitCredentials).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(runHome, ".claude", ".credentials.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(codexHome, "auth.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(kimiHome, "credentials", "kimi-code.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(kimiHome, "config.toml")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(runHome).mode & 0o777, 0o700, "the runner home itself must be 0700");

    // The slot GET presented the DERIVED auth token, never the secret itself.
    const [call] = cloud.calls;
    assert.equal(call.url, "/v1/pairing/sessions/11111111-1111-4111-8111-111111111111/device-blob");
    assert.equal(call.headers["x-pairing-auth"], pairingAuthToken(NOTICE_SECRET));
    assert.ok(!JSON.stringify(call.headers).includes(NOTICE_SECRET), "the rendezvous secret is never sent on the wire");

    // Visible success: an audit line and an event, both by NAME only.
    const audit = readAuditSince(auditSince);
    const installedLine = audit.find((entry) => entry.event === "credential_sync_installed");
    assert.ok(installedLine, `expected a credential_sync_installed audit line, saw ${JSON.stringify(audit)}`);
    assert.deepEqual(installedLine.installed.sort(), ["claude", "codex", "github", "kimi"]);

    assert.deepEqual(sink.events.map((event) => event.name), ["credentials.installed"]);
    assert.deepEqual(sink.pushed.map((event) => event.type), ["credentials.installed"]);

    // Nothing anywhere may carry a credential or the rendezvous secret.
    const spoken = JSON.stringify({ audit, events: sink.events, pushed: sink.pushed, result });
    for (const secretish of [
      "ghp_notice_path_MARKER", "claude_notice_MARKER", "codex_notice_MARKER", "kimi_notice_MARKER", NOTICE_SECRET,
    ]) {
      assert.ok(!spoken.includes(secretish), `${secretish} must never reach an audit line, an event or a return value`);
    }
  } finally { await cloud.close(); }
});

test("a session-index notice updates the Mac session index instead of installing credentials", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  const { blob, tag } = sealedFor(node.encPubkeyB64, {
    v: 1, kind: "session-index", machine: "MacBook-Pro", updatedAt: "2026-08-12T10:00:00.000Z",
    sessions: [{ id: "s1", harness: "claude", title: "Fix auth", repo: "me/relay", lastActive: "2026-08-12T09:00:00.000Z" }],
  });
  const cloud = await startFakeRendezvous(serveSealed(blob, tag));
  const sink = collector();

  try {
    const result = await installFromNotice(
      { pairingId: "22222222-2222-4222-8222-222222222222", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.kind, "session-index");
    assert.equal(readMacSessions({ dataDir }).sessions[0].title, "Fix auth");
    assert.equal(fs.existsSync(path.join(runHome, ".git-credentials")), false,
      "a session index must never install a credential");
  } finally { await cloud.close(); }
});

test("a blob whose MAC tag does not verify is refused before the seal is ever opened", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  // Sealed correctly to this node — so the ONLY thing standing between this
  // bundle and the runner home is the MAC check.
  const { blob } = sealedFor(node.encPubkeyB64, SYNC_BUNDLE);
  const wrongTag = blobTag(pairingMacKey("a-different-secret-entirely"), DEVICE_SLOT, blob);
  const cloud = await startFakeRendezvous(serveSealed(blob, wrongTag));
  const sink = collector();
  const auditSince = readAuditLength();

  try {
    const result = await installFromNotice(
      { pairingId: "33333333-3333-4333-8333-333333333333", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "tag_mismatch");
    assert.equal(treeContainsMarker(runHome, "ghp_notice_path_MARKER"), false,
      "a substituted blob must not reach the runner home");
    assert.equal(fs.existsSync(path.join(runHome, ".git-credentials")), false);

    const audit = readAuditSince(auditSince);
    assert.ok(audit.some((entry) => entry.event === "credential_sync_failed" && entry.reason === "tag_mismatch"));
    assert.deepEqual(sink.events.map((event) => event.name), ["credentials.failed"]);
    assert.equal(sink.events[0].data.reason, "tag_mismatch");
    assert.match(sink.events[0].data.action, /relay sync-auth/);
    assert.deepEqual(sink.pushed.map((event) => event.type), ["credentials.failed"]);
  } finally { await cloud.close(); }
});

test("a tag header the cloud never sent is a mismatch, not a skipped check", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  const { blob } = sealedFor(node.encPubkeyB64, SYNC_BUNDLE);
  const cloud = await startFakeRendezvous((res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" }); // no x-pairing-tag at all
    res.end(blob);
  });
  const sink = collector();

  try {
    const result = await installFromNotice(
      { pairingId: "44444444-4444-4444-8444-444444444444", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );
    assert.equal(result.reason, "tag_mismatch");
    assert.equal(fs.existsSync(path.join(runHome, ".git-credentials")), false);
  } finally { await cloud.close(); }
});

test("an expired or missing rendezvous slot ends in a visible failure, never in silence", async () => {
  for (const [status, expected] of [[401, "rendezvous_401"], [404, "rendezvous_404"], [500, "rendezvous_500"]]) {
    const { runHome, codexHome, dataDir } = homes();
    const node = freshNodeIdentity();
    const cloud = await startFakeRendezvous((res) => { res.writeHead(status); res.end(); });
    const sink = collector();
    const auditSince = readAuditLength();

    try {
      const result = await installFromNotice(
        { pairingId: "55555555-5555-4555-8555-555555555555", secret: NOTICE_SECRET },
        {
          cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
          emit: sink.emit, postEvent: sink.postEvent,
        },
      );

      assert.equal(result.ok, false);
      assert.equal(result.reason, expected);
      const audit = readAuditSince(auditSince);
      assert.ok(
        audit.some((entry) => entry.event === "credential_sync_failed" && entry.reason === expected),
        `a ${status} from the rendezvous must be audited, not swallowed`,
      );
      assert.deepEqual(sink.events.map((event) => event.name), ["credentials.failed"]);
      assert.match(sink.events[0].data.action, /relay sync-auth/);
    } finally { await cloud.close(); }
  }
});

test("a bundle sealed to a different node fails visibly as a decrypt failure", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  const stranger = generateEncKeyPair();
  const { blob, tag } = sealedFor(stranger.publicKeyB64, SYNC_BUNDLE);
  const cloud = await startFakeRendezvous(serveSealed(blob, tag));
  const sink = collector();
  const auditSince = readAuditLength();

  try {
    const result = await installFromNotice(
      { pairingId: "66666666-6666-4666-8666-666666666666", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "decrypt_failed");
    assert.equal(fs.existsSync(path.join(runHome, ".git-credentials")), false);
    const audit = readAuditSince(auditSince);
    assert.ok(audit.some((entry) => entry.event === "credential_sync_failed" && entry.reason === "decrypt_failed"));
    // The seal's own error attaches the underlying cause; none of that may
    // ride out to an operator-visible surface.
    const spoken = JSON.stringify({ audit, events: sink.events, result });
    assert.ok(!spoken.includes("cause"), "an internal decrypt cause must not be reported outward");
  } finally { await cloud.close(); }
});

test("a node with no encryption key fails visibly rather than quietly doing nothing", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  fs.rmSync(identityPaths(node.baseDir).encKeyPath, { force: true });
  const { blob, tag } = sealedFor(node.encPubkeyB64, SYNC_BUNDLE);
  const cloud = await startFakeRendezvous(serveSealed(blob, tag));
  const sink = collector();

  try {
    const result = await installFromNotice(
      { pairingId: "77777777-7777-4777-8777-777777777777", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, "node_enc_key_missing");
    assert.deepEqual(sink.events.map((event) => event.name), ["credentials.failed"]);
  } finally { await cloud.close(); }
});

test("a bundle of an unknown kind or version is refused, visibly", async () => {
  for (const [payload, expected] of [
    [{ v: 2, kind: "sync-auth" }, "unsupported_bundle_version"],
    [{ v: 1, kind: "exfiltrate", github: { token: "ghp_x" } }, "unexpected_bundle_kind"],
    // A payload with no `v` at all fails the version check first — the order
    // installCredentialBundle has always used; what matters here is that it
    // is refused by NAME and visibly, not which of the two names it gets.
    [{ nothing: true }, "unsupported_bundle_version"],
  ]) {
    const { runHome, codexHome, dataDir } = homes();
    const node = freshNodeIdentity();
    const { blob, tag } = sealedFor(node.encPubkeyB64, payload);
    const cloud = await startFakeRendezvous(serveSealed(blob, tag));
    const sink = collector();

    try {
      const result = await installFromNotice(
        { pairingId: "88888888-8888-4888-8888-888888888888", secret: NOTICE_SECRET },
        {
          cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
          emit: sink.emit, postEvent: sink.postEvent,
        },
      );
      assert.equal(result.ok, false, `${JSON.stringify(payload)} must not install`);
      assert.equal(result.reason, expected);
      assert.deepEqual(sink.events.map((event) => event.name), ["credentials.failed"]);
    } finally { await cloud.close(); }
  }
});

test("a sealed payload that is not JSON at all is refused, visibly", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  const blob = sealTo(node.encPubkeyB64, Buffer.from("this is not json", "utf8"));
  const cloud = await startFakeRendezvous(serveSealed(blob, blobTag(pairingMacKey(NOTICE_SECRET), DEVICE_SLOT, blob)));
  const sink = collector();

  try {
    const result = await installFromNotice(
      { pairingId: "99999999-9999-4999-8999-999999999999", secret: NOTICE_SECRET },
      {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      },
    );
    assert.equal(result.reason, "bundle_unreadable");
    assert.deepEqual(sink.events.map((event) => event.name), ["credentials.failed"]);
  } finally { await cloud.close(); }
});

test("a notice that names no rendezvous at all is refused without a request", async () => {
  const { runHome, codexHome, dataDir } = homes();
  const node = freshNodeIdentity();
  const cloud = await startFakeRendezvous(serveSealed(Buffer.from("x"), "tag"));
  const sink = collector();
  try {
    for (const notice of [{}, { pairingId: "", secret: NOTICE_SECRET }, { pairingId: "p", secret: "" }, null]) {
      const result = await installFromNotice(notice, {
        cloudUrl: cloud.url, runHome, codexHome, dataDir, identityBaseDir: node.baseDir,
        emit: sink.emit, postEvent: sink.postEvent,
      });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "invalid_notice");
    }
    assert.equal(cloud.calls.length, 0, "a malformed notice must never reach the rendezvous");
  } finally { await cloud.close(); }
});

// The transport half on its own: collectRendezvousBlob must not hand back
// bytes it has not authenticated. This is the gap the previous round left —
// it returned a bare Buffer and dropped the x-pairing-tag response header, so
// the MAC half of the rendezvous protocol was never actually checked.
test("collectRendezvousBlob verifies the tag itself rather than returning unauthenticated bytes", async () => {
  const node = freshNodeIdentity();
  const { blob, tag } = sealedFor(node.encPubkeyB64, SYNC_BUNDLE);
  const macKey = pairingMacKey(NOTICE_SECRET);

  const good = await startFakeRendezvous(serveSealed(blob, tag));
  try {
    const collected = await collectRendezvousBlob({
      cloudUrl: good.url, pairingId: "p-1", authToken: pairingAuthToken(NOTICE_SECRET), macKey,
    });
    assert.ok(Buffer.isBuffer(collected));
    assert.ok(collected.equals(blob), "the verified bytes are returned unchanged");
  } finally { await good.close(); }

  const tampered = await startFakeRendezvous(serveSealed(Buffer.concat([blob, Buffer.from("!")]), tag));
  try {
    await assert.rejects(
      () => collectRendezvousBlob({
        cloudUrl: tampered.url, pairingId: "p-1", authToken: pairingAuthToken(NOTICE_SECRET), macKey,
      }),
      /rendezvous_tag_mismatch/,
      "a blob that does not match its tag must never be returned to the caller",
    );
  } finally { await tampered.close(); }
});
