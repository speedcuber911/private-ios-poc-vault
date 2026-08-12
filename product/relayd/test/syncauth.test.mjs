import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-data-"));

const { installCredentialBundle, saveMacSessions, readMacSessions } = await import("../src/syncauth.mjs");

function homes() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-syncauth-"));
  return { runHome: path.join(root, "home"), codexHome: path.join(root, "codex"), dataDir: root };
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
  const { runHome, codexHome } = homes();
  const result = installCredentialBundle({
    v: 1, kind: "sync-auth",
    github: { token: "ghp_example" },
    claude: { credentials: '{"token":"claude"}' },
    codex: { auth: '{"token":"codex"}' },
  }, { runHome, codexHome });

  assert.deepEqual(result.installed.sort(), ["claude", "codex", "github"]);
  assert.deepEqual(result.skipped, []);

  const gitCredentials = path.join(runHome, ".git-credentials");
  assert.equal(fs.readFileSync(gitCredentials, "utf8").trim(), "https://x-access-token:ghp_example@github.com");
  assert.equal(fs.statSync(gitCredentials).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(runHome, ".claude", ".credentials.json")).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(codexHome, "auth.json"), "utf8"), '{"token":"codex"}');
  assert.match(fs.readFileSync(path.join(runHome, ".gitconfig"), "utf8"), /helper = store/);
});

test("absent members are reported as skipped rather than silently ignored", () => {
  const { runHome, codexHome } = homes();
  const result = installCredentialBundle({ v: 1, kind: "sync-auth", github: { token: "ghp_only" } },
    { runHome, codexHome });

  assert.deepEqual(result.installed, ["github"]);
  assert.deepEqual(result.skipped.sort(), ["claude", "codex"]);
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

  const attackToken = "ghp_hardlink_attack_token_MARKER";
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", github: { token: attackToken } },
    { runHome, codexHome },
  );

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

  const attackToken = "ghp_symlink_attack_token_MARKER";
  const result = installCredentialBundle(
    { v: 1, kind: "sync-auth", github: { token: attackToken } },
    { runHome, codexHome },
  );

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
