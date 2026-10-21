import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Claude publishes these records for its live session picker. A file alone
// is not a lock: old records survive restarts, and operating systems reuse PIDs.
export function processMatchesSession(record, { procRoot = "/proc", platform = process.platform } = {}) {
  if (!Number.isSafeInteger(record.pid) || record.pid <= 0) return false;
  try {
    process.kill(record.pid, 0);
    if (platform === "linux" && typeof record.procStart === "string") {
      const stat = fs.readFileSync(path.join(procRoot, String(record.pid), "stat"), "utf8");
      const start = stat.slice(stat.lastIndexOf(") ") + 2).split(" ")[19];
      if (start !== record.procStart) return false;
      if (record.pidDomain?.startsWith("linux:")) {
        const boot = fs.readFileSync(path.join(procRoot, "sys/kernel/random/boot_id"), "utf8").trim().replaceAll("-", "");
        if (!record.pidDomain.startsWith(`linux:${boot}:`)) return false;
      }
      return true;
    }
    const start = Date.parse(execFileSync("ps", ["-p", String(record.pid), "-o", "lstart="], {
      encoding: "utf8", timeout: 500, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C" },
    }).trim());
    return Number.isFinite(start) && Number.isFinite(record.startedAt) && Math.abs(start - record.startedAt) < 5000;
  } catch {
    return false;
  }
}

export function liveClaudeSessions(runHome, { processMatches = processMatchesSession } = {}) {
  const root = path.join(runHome, ".claude", "sessions");
  let entries;
  try { entries = fs.readdirSync(root); } catch { return []; }
  const result = [];
  for (const entry of entries) {
    if (!/^\d+\.json$/.test(entry)) continue;
    try {
      const record = JSON.parse(fs.readFileSync(path.join(root, entry), "utf8"));
      if (typeof record.sessionId !== "string" || !processMatches(record)) continue;
      result.push(record);
    } catch { /* A registry record may be replaced while it is read. */ }
  }
  return result;
}

export function assertClaudeSessionAvailable(sessionId, runHome) {
  const owner = liveClaudeSessions(runHome).find((record) => record.sessionId === sessionId);
  if (!owner) return;
  const surface = owner.entrypoint === "claude-desktop" ? "Claude Desktop" : "another Claude Code session";
  throw Object.assign(new Error(`This conversation is still open in ${surface}. Close it there before continuing in Relay. Your draft has been kept.`), {
    status: 409, code: "session_in_use",
  });
}

export function claudeSessionControl(sessionId, runHome) {
  const owner = liveClaudeSessions(runHome).find((record) => record.sessionId === sessionId);
  if (!owner) return null;
  const remoteId = typeof owner.bridgeSessionId === "string" && /^session_[A-Za-z0-9_-]+$/.test(owner.bridgeSessionId)
    ? owner.bridgeSessionId : null;
  return {
    owner: owner.entrypoint === "claude-desktop" ? "Claude Desktop" : "Claude Code",
    remoteControlURL: remoteId ? `https://claude.ai/code/${remoteId}` : null,
  };
}
