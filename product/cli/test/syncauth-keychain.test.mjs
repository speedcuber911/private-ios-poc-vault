// collectCredentialBundle finding Claude Code's login on macOS.
//
// Claude Code keeps its credentials in the macOS login Keychain (service
// "Claude Code-credentials"); ~/.claude/.credentials.json is the LINUX
// location and does not exist on a Mac. sync-auth read only the file, so on
// the platform most operators run it from, it reported "No Claude Code login
// found on this machine" while Claude Code was signed in and running — and the
// sandbox came up with no Anthropic credential, which is what "the models
// didn't go through" looked like from the phone.
//
// Every test here fakes execFileImpl. Nothing in this file reads a real
// keychain or a real credential.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { collectCredentialBundle } from "../src/commands/syncauth.mjs";

// The shape Claude Code actually stores: an opaque JSON document. The values
// are invented.
const KEYCHAIN_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "fake-access-token",
    refreshToken: "fake-refresh-token",
    expiresAt: 1786604187296,
    scopes: ["user:inference"],
  },
});

function emptyHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "relay-syncauth-"));
}

// `security` is the only command that should ever be asked for the keychain,
// and `gh` must keep working alongside it.
function fakeExec({ keychain = null, ghToken = null } = {}) {
  const calls = [];
  return {
    calls,
    async execFileImpl(cmd, args) {
      calls.push([cmd, ...args]);
      if (cmd === "gh") {
        if (ghToken === null) throw new Error("not logged in");
        return { stdout: `${ghToken}\n`, stderr: "" };
      }
      if (cmd === "security") {
        if (keychain === null) throw new Error("SecKeychainSearchCopyNext: not found");
        return { stdout: `${keychain}\n`, stderr: "" };
      }
      throw new Error(`unexpected command: ${cmd}`);
    },
  };
}

test("darwin: a Claude login in the Keychain is collected", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: KEYCHAIN_JSON });

  const { bundle, skipped } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "darwin",
  });

  assert.equal(bundle.claude?.credentials, KEYCHAIN_JSON,
    "the blob must be copied through byte-for-byte, not re-serialised");
  assert.ok(!skipped.includes("claude"), "claude must not be reported as skipped");
});

// -g would additionally write the secret to stderr, where it lands in terminal
// transcripts and CI logs. -w prints only the secret, to stdout.
test("darwin: the keychain is read with -w, never -g", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: KEYCHAIN_JSON });

  await collectCredentialBundle({ home, execFileImpl: exec.execFileImpl, platform: "darwin" });

  const call = exec.calls.find((c) => c[0] === "security");
  assert.ok(call, "security must have been consulted on darwin");
  assert.deepEqual(call, ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  assert.ok(!call.includes("-g"), "-g leaks the secret to stderr");
});

test("linux: the keychain is never consulted", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: KEYCHAIN_JSON });

  const { bundle, skipped } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "linux",
  });

  assert.ok(!exec.calls.some((c) => c[0] === "security"), "security is a macOS-only tool");
  assert.equal(bundle.claude, undefined);
  assert.ok(skipped.includes("claude"));
});

test("the file wins over the keychain when both exist", async () => {
  const home = emptyHome();
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  const fromFile = JSON.stringify({ claudeAiOauth: { accessToken: "from-the-file" } });
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), fromFile);
  const exec = fakeExec({ keychain: KEYCHAIN_JSON });

  const { bundle } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "darwin",
  });

  assert.equal(bundle.claude.credentials, fromFile);
  assert.ok(!exec.calls.some((c) => c[0] === "security"),
    "an explicit file means the keychain need not be touched at all");
});

test("no keychain item: claude is reported skipped, not faked", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: null });

  const { bundle, skipped } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "darwin",
  });

  assert.equal(bundle.claude, undefined);
  assert.ok(skipped.includes("claude"));
});

// A corrupt blob installed verbatim would break Claude Code on the sandbox in
// a way nobody would trace back to sync-auth.
test("a non-JSON keychain blob is refused rather than shipped", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: "this is not json" });

  const { bundle, skipped } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "darwin",
  });

  assert.equal(bundle.claude, undefined);
  assert.ok(skipped.includes("claude"));
});

test("an empty keychain blob is refused", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: "   " });

  const { bundle, skipped } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "darwin",
  });

  assert.equal(bundle.claude, undefined);
  assert.ok(skipped.includes("claude"));
});

// A keychain failure must not take the GitHub token down with it.
test("github still syncs when the keychain has nothing", async () => {
  const home = emptyHome();
  const exec = fakeExec({ keychain: null, ghToken: "gho_faketoken" });

  const { bundle } = await collectCredentialBundle({
    home, execFileImpl: exec.execFileImpl, platform: "darwin",
  });

  assert.equal(bundle.github.token, "gho_faketoken");
});
