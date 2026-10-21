import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { liveClaudeSessions, processMatchesSession } from "../src/native-session-owner.mjs";

test("a reused PID or a registry record from a previous boot cannot lock a conversation", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-owner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, String(process.pid)), { recursive: true });
  fs.mkdirSync(path.join(root, "sys/kernel/random"), { recursive: true });
  const fields = Array(25).fill("0");
  fields[0] = "S";
  fields[19] = "123456";
  fs.writeFileSync(path.join(root, String(process.pid), "stat"), `${process.pid} (claude (worker)) ${fields.join(" ")}`);
  fs.writeFileSync(path.join(root, "sys/kernel/random/boot_id"), "aabb-ccdd\n");
  const options = { procRoot: root, platform: "linux" };
  const record = { pid: process.pid, procStart: "123456", pidDomain: "linux:aabbccdd:pid:[1]" };
  assert.equal(processMatchesSession(record, options), true);
  assert.equal(processMatchesSession({ ...record, procStart: "999" }, options), false);
  assert.equal(processMatchesSession({ ...record, pidDomain: "linux:previousboot:pid:[1]" }, options), false);
  assert.equal(processMatchesSession({ ...record, pid: -1 }, options), false);
});

test("registry scans ignore torn, dead and unrelated files", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-owner-home-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".claude/sessions");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "1.json"), JSON.stringify({ pid: 1, sessionId: "live" }));
  fs.writeFileSync(path.join(root, "2.json"), JSON.stringify({ pid: 2, sessionId: "dead" }));
  fs.writeFileSync(path.join(root, "3.json"), "{");
  fs.writeFileSync(path.join(root, "other.json"), JSON.stringify({ pid: 1, sessionId: "ignore" }));
  assert.deepEqual(liveClaudeSessions(home, { processMatches: (record) => record.pid === 1 }).map((r) => r.sessionId), ["live"]);
  assert.deepEqual(liveClaudeSessions(path.join(home, "absent")), []);
});
