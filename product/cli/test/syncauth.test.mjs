import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdSyncAuth, collectCredentialBundle, authTokenFor } = await import("../src/commands/syncauth.mjs");
const { writeCredentials } = await import("../src/creds.mjs");
const { generateEncKeyPair, openSealed } = await import("../src/seal.mjs");
const { claudeProjectSlug } = await import("../src/sessions.mjs");

function homeWithCreds(node) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-"));
  writeCredentials({ sessionToken: "sess", accountId: "acct", nodeId: "node-1", nodeEncPubkey: node.publicKeyB64 }, { home });
  return home;
}

function recordingCloud() {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(url).pathname;
      calls.push({ pathname, headers: options.headers || {}, raw: options.body, body: typeof options.body === "string" ? JSON.parse(options.body) : null });
      if (pathname === "/v1/pairing/sessions") {
        return { status: 201, json: async () => ({ pairingId: "11111111-1111-4111-8111-111111111111", expiresAt: 1 }) };
      }
      return { status: 204, json: async () => null };
    },
  };
}

test("credentials are collected, sealed to the node, and delivered over the rendezvous", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"token":"claude-token"}');
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"codex-token"}');

  const cloud = recordingCloud();
  const lines = [];

  const result = await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
    execFileImpl: async () => ({ stdout: "ghp_from_gh_cli\n" }),
  });

  assert.deepEqual(result.installed.sort(), ["claude", "codex", "github"]);

  const blobCall = cloud.calls.find((call) => call.pathname.endsWith("/device-blob"));
  const bundle = JSON.parse(openSealed(node.privateKeyPem, Buffer.from(blobCall.raw)).toString("utf8"));
  assert.equal(bundle.kind, "sync-auth");
  assert.equal(bundle.github.token, "ghp_from_gh_cli");
  assert.equal(bundle.claude.credentials, '{"token":"claude-token"}');

  const sessionCall = cloud.calls.find((call) => call.pathname === "/v1/pairing/sessions");
  assert.equal(sessionCall.body.kind, "sync-auth");
  assert.match(sessionCall.body.authToken, /^[A-Za-z0-9_-]{43}$/, "the rendezvous sees a derived token, not the secret");
  assert.ok(!lines.join("\n").includes("ghp_from_gh_cli"), "no credential is ever printed");
  assert.ok(!lines.join("\n").includes("claude-token"));
});

test("missing credentials are reported honestly rather than faked", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const cloud = recordingCloud();
  const lines = [];

  const result = await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
    execFileImpl: async () => { throw new Error("gh not installed"); },
  });

  assert.deepEqual(result.installed, []);
  assert.deepEqual(result.skipped.sort(), ["claude", "codex", "github"]);
  assert.match(lines.join("\n"), /cursor/i, "cursor's on-box login requirement is stated");
});

test("authTokenFor is deterministic per secret and never returns the secret", () => {
  assert.equal(authTokenFor("known-secret"), authTokenFor("known-secret"));
  assert.notEqual(authTokenFor("a"), authTokenFor("b"));
  assert.ok(!authTokenFor("known-secret").includes("known-secret"));
});

// The brief promises "Both `relay sync-auth` and `relay handoff` refresh
// [the session index]", but nothing asserted that cmdSyncAuth's own refresh
// actually runs — it previously only executed by accident, because the
// ambient host checkout this suite happens to run inside has a github.com
// origin. Pin it explicitly via an injected repo lookup, using a throwaway
// repo directory that has nothing to do with whatever repo the suite is
// invoked from, so the assertion holds in any environment (CI, a tarball
// checkout, a detached worktree with no github origin, etc).
test("cmdSyncAuth refreshes the session index through an injected repo lookup, independent of the host repo", async () => {
  const node = generateEncKeyPair();
  const home = homeWithCreds(node);
  const repoRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-syncauth-repo-")));
  const sessionFile = path.join(home, ".claude", "projects", claudeProjectSlug(repoRoot), "s1.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "user", message: { content: "fix the auth bug" } })}\n`);

  const cloud = recordingCloud();
  const lines = [];
  let repoLookupCalledWith = null;

  const result = await cmdSyncAuth([], {
    home, baseUrl: "https://cloud.test", fetchImpl: cloud.fetchImpl, log: (line) => lines.push(line),
    execFileImpl: async () => { throw new Error("no gh"); },
    requireGitHubRepoImpl: async (opts) => {
      repoLookupCalledWith = opts;
      return { root: repoRoot, fullName: "acme/relay" };
    },
  });

  assert.ok(repoLookupCalledWith, "cmdSyncAuth must consult the injected repo lookup, not skip straight to the catch");

  const sessionIndexCall = cloud.calls.find((call) => call.pathname === "/v1/pairing/sessions" && call.body?.kind === "session-index");
  assert.ok(sessionIndexCall, "cmdSyncAuth must publish a session-index rendezvous session, not only sync-auth");
  assert.match(sessionIndexCall.body.authToken, /^[A-Za-z0-9_-]{43}$/, "the rendezvous sees a derived token, not the secret, for the session-index publish too");

  const deviceBlobCalls = cloud.calls.filter((call) => call.pathname.endsWith("/device-blob"));
  assert.equal(deviceBlobCalls.length, 2, "one sealed blob for sync-auth, one for the session index");

  assert.match(lines.join("\n"), /Shared 1 local session/, "the refresh's own session count must be reported");
  assert.deepEqual(result.installed, [], "unrelated to whether any credential was installed");
});

test("collectCredentialBundle never includes an empty member", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-bundle-"));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), '{"token":"only-codex"}');

  const { bundle, skipped } = await collectCredentialBundle({ home, execFileImpl: async () => { throw new Error("no gh"); } });

  assert.equal(bundle.codex.auth, '{"token":"only-codex"}');
  assert.equal(bundle.github, undefined);
  assert.equal(bundle.claude, undefined);
  assert.deepEqual(skipped.sort(), ["claude", "github"]);
});

// Not reachable through the real execFileAsync (Node's promisified execFile
// always resolves { stdout, stderr } with both keys present on a clean
// exit), but a credential-shaped string that is not a credential is exactly
// the kind of thing that ends up written to disk and silently failing
// later, so a malformed execFileImpl must never fabricate one.
test("collectCredentialBundle never fabricates a token from a malformed execFileImpl result", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-bundle-malformed-"));

  const { bundle, skipped } = await collectCredentialBundle({ home, execFileImpl: async () => ({}) });

  assert.equal(bundle.github, undefined, "a missing stdout must never be coerced into the literal string 'undefined'");
  assert.ok(skipped.includes("github"));
});
