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
