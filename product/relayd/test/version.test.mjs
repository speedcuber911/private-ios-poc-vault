import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.CODEX_DATA_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), "relayd-version-data-"));

const { version, commit, builtAt, readBuildIdentity, UNKNOWN_VERSION } = await import("../src/version.mjs");

function tmpDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `relayd-version-${label}-`));
}

// ---------------------------------------------------------------------------
// The one non-negotiable property. `version` is read by /healthz (which
// answers before authorize() and must not be able to fail), by `relayd
// status` and by update.mjs's downgrade refusal. A node that cannot name its
// own version is invisible to the fleet — which is the exact problem the
// 2026-09-21 release-subscription spec exists to close — and an EMPTY version
// is worse than a wrong one, because it compares as unparseable and would
// refuse every update forever.
test("version.mjs always yields a non-empty version, whatever is or is not on disk", () => {
  assert.equal(typeof version, "string");
  assert.ok(version.length > 0, "the module-level version must never be empty");
  assert.ok(commit === null || /^[0-9a-f]{7,64}$/.test(commit));
  assert.ok(builtAt === null || !Number.isNaN(Date.parse(builtAt)));

  // Nothing at all: no build-info.json, no package.json, no .git.
  const bare = tmpDir("bare");
  const identity = readBuildIdentity({ appDir: bare });
  assert.equal(identity.version, UNKNOWN_VERSION);
  assert.equal(identity.commit, null);
  assert.equal(identity.builtAt, null);
  assert.ok(identity.version.length > 0);

  // A path that does not exist is not an error either — the whole module is
  // documented as never throwing.
  const missing = readBuildIdentity({ appDir: path.join(bare, "does", "not", "exist") });
  assert.equal(missing.version, UNKNOWN_VERSION);
});

test("a packaged build-info.json is the authoritative identity", () => {
  const dir = tmpDir("packaged");
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "relayd", version: "0.1.0" }));
  fs.writeFileSync(
    path.join(dir, "build-info.json"),
    JSON.stringify({ version: "0.4.2", commit: "ABCDEF1234567890abcdef1234567890abcdef12", builtAt: "2026-09-21T10:00:00Z" }),
  );

  const identity = readBuildIdentity({ appDir: dir });
  assert.equal(identity.version, "0.4.2", "build-info must win over package.json's hand-edited version");
  assert.equal(identity.commit, "abcdef1234567890abcdef1234567890abcdef12");
  assert.equal(identity.builtAt, "2026-09-21T10:00:00Z");
  assert.equal(identity.source, "build-info");
});

// Everything about the fallback chain matters: a half-written or hand-mangled
// build-info.json must degrade to the next source rather than take the version
// down with it.
test("an unusable build-info.json degrades to package.json instead of failing", () => {
  const cases = [
    ["not JSON at all", "{{{"],
    ["JSON but not an object", "[1,2,3]"],
    ["no version field", JSON.stringify({ commit: "abc1234" })],
    ["empty version", JSON.stringify({ version: "   " })],
    ["version with a path separator", JSON.stringify({ version: "../0.9.9" })],
    ["version with a newline", JSON.stringify({ version: "0.9.9\nrm -rf" })],
  ];
  for (const [label, contents] of cases) {
    const dir = tmpDir("degrade");
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "relayd", version: "0.1.0" }));
    fs.writeFileSync(path.join(dir, "build-info.json"), contents);
    const identity = readBuildIdentity({ appDir: dir });
    assert.equal(identity.version, "0.1.0", `${label}: must fall through to package.json`);
    assert.equal(identity.source, "package.json");
  }
});

test("an explicit build-info path wins, and asking about another tree does not answer about this one", () => {
  const dir = tmpDir("explicit");
  const sidecar = path.join(dir, "elsewhere.json");
  fs.writeFileSync(sidecar, JSON.stringify({ version: "9.9.9" }));
  assert.equal(readBuildIdentity({ appDir: dir, buildInfoFile: sidecar }).version, "9.9.9");

  // RELAYD_BUILD_INFO_FILE describes THIS process. Asked about a staged tree,
  // readBuildIdentity must answer about that tree — otherwise the update
  // engine would read the running node's version back out of the artifact it
  // is about to install, and every artifact would appear to carry the right
  // version.
  const staged = tmpDir("staged");
  fs.writeFileSync(path.join(staged, "package.json"), JSON.stringify({ version: "0.3.0" }));
  const previous = process.env.RELAYD_BUILD_INFO_FILE;
  process.env.RELAYD_BUILD_INFO_FILE = sidecar;
  try {
    assert.equal(readBuildIdentity({ appDir: staged }).version, "0.3.0");
  } finally {
    if (previous === undefined) delete process.env.RELAYD_BUILD_INFO_FILE;
    else process.env.RELAYD_BUILD_INFO_FILE = previous;
  }
});

// The git SHA is a convenience for a working checkout, so it is read out of
// .git by hand. It must never be the reason this module fails: a `.git` that
// is a file (a linked worktree), a ref that has been packed away, and a
// nonsense HEAD all have to resolve to a commit or to null.
test("the git SHA fallback survives a packed ref, a worktree .git file, and a nonsense HEAD", () => {
  const repo = tmpDir("git");
  const gitDir = path.join(repo, ".git");
  fs.mkdirSync(gitDir);
  fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ version: "0.1.0" }));

  const sha = "1234567890abcdef1234567890abcdef12345678";
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDir, "packed-refs"), `# pack-refs with: peeled\n${sha} refs/heads/main\n`);
  assert.equal(readBuildIdentity({ appDir: repo }).commit, sha, "a packed ref must resolve");

  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${sha}\n`);
  assert.equal(readBuildIdentity({ appDir: repo }).commit, sha, "a loose ref must resolve");

  fs.writeFileSync(path.join(gitDir, "HEAD"), "this is not a ref\n");
  assert.equal(readBuildIdentity({ appDir: repo }).commit, null, "a nonsense HEAD is null, not a throw");
  assert.equal(readBuildIdentity({ appDir: repo }).version, "0.1.0");

  // A linked worktree: .git is a FILE pointing at the real git directory.
  const worktree = tmpDir("worktree");
  fs.writeFileSync(path.join(worktree, "package.json"), JSON.stringify({ version: "0.1.0" }));
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  assert.equal(readBuildIdentity({ appDir: worktree }).commit, sha);
});

// UNKNOWN_VERSION is not an arbitrary placeholder: update.mjs orders
// prereleases below the release they qualify, so a node that fell all the way
// through the chain still compares as older than any real release and can be
// rescued by an announcement rather than being frozen out of updates.
test("UNKNOWN_VERSION parses and orders below every real release", async () => {
  const { parseVersion, compareVersions } = await import("../src/update.mjs");
  assert.ok(parseVersion(UNKNOWN_VERSION), "UNKNOWN_VERSION must be orderable, not unparseable");
  assert.equal(compareVersions("0.0.1", UNKNOWN_VERSION), 1);
  assert.equal(compareVersions("0.1.0", UNKNOWN_VERSION), 1);
  assert.equal(compareVersions(UNKNOWN_VERSION, "0.0.0"), -1);
});
