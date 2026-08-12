import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { cmdSyncAuth, collectCredentialBundle, authTokenFor } = await import("../src/commands/syncauth.mjs");
const { writeCredentials } = await import("../src/creds.mjs");
const { generateEncKeyPair, openSealed } = await import("../src/seal.mjs");

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
