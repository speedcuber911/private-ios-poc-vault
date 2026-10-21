import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createActivityTracker, ACTIVITY_HOLD_MS, latestCodexActivity } from "../src/activity.mjs";

test("an open app and a quiet active run hold the machine, then genuinely idle use expires", () => {
  let now = 1000;
  const activity = createActivityTracker({ now: () => now });
  assert.equal(activity.keepAwakeUntil(), null);
  activity.interacted();
  assert.equal(activity.keepAwakeUntil(), now + ACTIVITY_HOLD_MS);
  now += ACTIVITY_HOLD_MS + 1;
  assert.equal(activity.keepAwakeUntil(), null);
  assert.equal(activity.keepAwakeUntil({ busy: true }), now + ACTIVITY_HOLD_MS);
  now += 1000;
  assert.equal(activity.keepAwakeUntil(), now - 1000 + ACTIVITY_HOLD_MS);
});

test("a resumed old Codex rollout counts as activity without idle scans renewing the hold", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-native-activity-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions/2026/01/01");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout.jsonl");
  fs.writeFileSync(file, "contents are never parsed");
  let now = Date.parse("2026-10-21T00:01:00Z");
  fs.utimesSync(file, now / 1000, (now - 60_000) / 1000);
  const activity = createActivityTracker({ now: () => now });
  activity.interacted(latestCodexActivity(home, { now: () => now }));
  assert.equal(activity.keepAwakeUntil(), now - 60_000 + ACTIVITY_HOLD_MS);
  now += ACTIVITY_HOLD_MS;
  activity.interacted(latestCodexActivity(home, { now: () => now }));
  assert.equal(activity.keepAwakeUntil(), null);
});
