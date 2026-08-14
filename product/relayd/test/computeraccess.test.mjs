import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { createComputerAccessGate } from "../src/computeraccess.mjs";

test("a managed node fails closed, persists revocation, and expires allow leases", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-computer-access-"));
  const statePath = path.join(dir, "state.json");
  const clock = { t: 1_800_000_000_000 };

  const gate = createComputerAccessGate({ required: true, statePath, now: () => clock.t });
  assert.deepEqual(gate.authorize(), {
    ok: false,
    status: 503,
    error: "computer access could not be verified",
  });

  gate.applyLease({ allowed: false, leaseSec: 45 });
  assert.deepEqual(gate.authorize(), {
    ok: false,
    status: 403,
    error: "computer is disconnected",
  });

  const restarted = createComputerAccessGate({ required: true, statePath, now: () => clock.t });
  assert.equal(restarted.authorize().status, 403, "revocation survives a daemon restart");

  restarted.applyLease({ allowed: true, leaseSec: 45 });
  assert.deepEqual(restarted.authorize(), { ok: true });
  clock.t += 45_001;
  assert.equal(restarted.authorize().status, 503, "stale allow access is bounded by the lease");
});

test("device-token authorization enforces the cloud computer-access lease", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-computer-auth-"));
  const token = "phone-device-token";
  const tokenHashPath = path.join(dir, "device-token.hash");
  fs.writeFileSync(tokenHashPath, `${crypto.createHash("sha256").update(token).digest("hex")}\n`, { mode: 0o600 });

  const serverUrl = new URL("../src/server.mjs", import.meta.url).href;
  const gateUrl = new URL("../src/computeraccess.mjs", import.meta.url).href;
  const script = [
    "const gate = await import(process.env.RELAY_TEST_GATE_URL);",
    "const server = await import(process.env.RELAY_TEST_SERVER_URL);",
    "const req = { headers: { authorization: `Bearer ${process.env.RELAY_TEST_DEVICE_TOKEN}` } };",
    "const before = server.authorize(req);",
    "gate.computerAccessGate.applyLease({ allowed: false, leaseSec: 45 });",
    "const revoked = server.authorize(req);",
    "gate.computerAccessGate.applyLease({ allowed: true, leaseSec: 45 });",
    "const restored = server.authorize(req);",
    "process.stdout.write(JSON.stringify({ before, revoked, restored }));",
  ].join("\n");

  const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_DATA_DIR: dir,
      CODEX_WORKSPACE_ROOT: dir,
      CODEX_WORKSPACE_BROWSE_ROOT: dir,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: path.join(dir, "scratch") }]),
      CODEX_REQUIRE_MTLS: "true",
      RELAYD_CLOUD_URL: "https://relay.example",
      RELAYD_DEVICE_TOKEN_HASH_FILE: tokenHashPath,
      RELAY_TEST_DEVICE_TOKEN: token,
      RELAY_TEST_GATE_URL: gateUrl,
      RELAY_TEST_SERVER_URL: serverUrl,
    },
  }));

  assert.equal(result.before.status, 503);
  assert.equal(result.revoked.status, 403);
  assert.deepEqual(result.restored, { ok: true, subject: "trial-device" });
});
