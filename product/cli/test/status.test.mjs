import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const { cmdStatus } = await import("../src/commands/status.mjs");
const { writeCredentials } = await import("../src/creds.mjs");

process.env.RELAY_ALLOW_LOCAL_REMOTE = "1";

async function repoAndHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-status-"));
  const git = (...args) => execFileAsync("git", ["-C", dir, ...args]);
  await execFileAsync("git", ["init", "-q", "-b", "main", dir]);
  await git("config", "user.email", "t@example.com");
  await git("config", "user.name", "T");
  await git("remote", "add", "origin", "https://github.com/Me/Relay.git");
  fs.writeFileSync(path.join(dir, "README.md"), "# hi\n");
  await git("add", "-A");
  await git("commit", "-qm", "initial");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-cli-status-home-"));
  writeCredentials({ sessionToken: "sess", nodeId: "node-1", nodeEncPubkey: "k" }, { home });
  return { dir, home };
}

test("status lists this repo's handoffs newest first with their state", async () => {
  const { dir, home } = await repoAndHome();
  const lines = [];

  await cmdStatus([], {
    home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async () => ({ status: 200, json: async () => ({ handoffs: [
      { id: "a1", branch: "relay/handoff-newer-aaa111", state: "ready", createdAt: 2, reason: null },
      { id: "a2", branch: "relay/handoff-older-bbb222", state: "failed", createdAt: 1, reason: "clone_failed" },
    ] }) }),
  });

  const output = lines.join("\n");
  assert.match(output, /relay\/handoff-newer-aaa111/);
  assert.match(output, /ready/);
  assert.match(output, /clone_failed/, "a failure reason is surfaced, not hidden");
  assert.ok(output.indexOf("newer") < output.indexOf("older"), "newest first");
});

test("a failed handoff needing credentials tells the user what to run", async () => {
  const { dir, home } = await repoAndHome();
  const lines = [];

  await cmdStatus([], {
    home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async () => ({ status: 200, json: async () => ({ handoffs: [
      { id: "a1", branch: "relay/handoff-x-aaa111", state: "failed", createdAt: 1, reason: "clone_failed: authentication required" },
    ] }) }),
  });

  assert.match(lines.join("\n"), /relay sync-auth/);
});

test("no handoffs yet reads as an empty state, not an error", async () => {
  const { dir, home } = await repoAndHome();
  const lines = [];
  await cmdStatus([], { home, cwd: dir, baseUrl: "https://cloud.test", log: (line) => lines.push(line),
    fetchImpl: async () => ({ status: 200, json: async () => ({ handoffs: [] }) }) });
  assert.match(lines.join("\n"), /no handoffs yet/i);
});
