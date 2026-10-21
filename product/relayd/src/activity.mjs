import fs from "node:fs";
import path from "node:path";

// Only timing leaves the node. Prompts, paths, session ids and provider
// credentials never belong in the control plane's power-management heartbeat.
export const ACTIVITY_HOLD_MS = 60 * 60 * 1000;

export function createActivityTracker({ now = Date.now } = {}) {
  let lastInteraction = 0;
  return {
    interacted(at = now()) {
      if (typeof at === "number" && Number.isFinite(at)) lastInteraction = Math.max(lastInteraction, Math.min(at, now()));
    },
    keepAwakeUntil({ busy = false } = {}) {
      const stamp = now();
      if (busy) lastInteraction = stamp;
      return lastInteraction > 0 && lastInteraction + ACTIVITY_HOLD_MS > stamp
        ? lastInteraction + ACTIVITY_HOLD_MS : null;
    },
  };
}

// Native Codex desktop work is not a Relay child process. Its rollout writes
// count as activity too, including resumed sessions in older date folders. Only stat data
// is read; no transcript contents leave the machine or enter this probe.
export function latestCodexActivity(codexHome, { now = Date.now } = {}) {
  const stamp = now();
  let latest = 0;
  function visit(root, depth) {
    try {
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && depth > 0) {
          visit(path.join(root, entry.name), depth - 1);
          continue;
        }
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        try { latest = Math.max(latest, fs.statSync(path.join(root, entry.name)).mtimeMs); } catch { /* Removed during scan. */ }
      }
    } catch { /* Absent or removed while scanning. */ }
  }
  visit(path.join(codexHome, "sessions"), 3);
  return latest > stamp - ACTIVITY_HOLD_MS ? Math.min(latest, stamp) : null;
}

export const activityTracker = createActivityTracker();
