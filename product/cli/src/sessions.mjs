// Find the local agent sessions that belong to this repository.
//
// Claude Code keys its transcripts by a slugified absolute cwd; Codex records
// the cwd inside the rollout. Cursor keeps no portable session file, so it is
// absent here by design and the handoff falls back to summary-priming rather
// than pretending a resume is possible.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SCAN_FILES = 500;

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

function firstText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item?.text ?? item?.content ?? item);
      if (text) return text;
    }
    return "";
  }
  if (value && typeof value === "object") return firstText(value.text ?? value.content ?? "");
  return "";
}

function readJsonLines(filePath, { limit = 400 } = {}) {
  let text = "";
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).slice(0, limit);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially flushed trailing line is normal for a live session.
    }
  }
  return records;
}

function titleFrom(records, fallback) {
  for (const record of records) {
    if (record?.type !== "user") continue;
    const text = firstText(record.message?.content ?? record.message ?? record.text).trim();
    if (text) return text.split("\n")[0].slice(0, 120);
  }
  return fallback;
}

function discoverClaudeSessions({ cwd, home }) {
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(cwd));
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).slice(0, MAX_SCAN_FILES);
  } catch {
    return [];
  }
  return names.map((name) => {
    const filePath = path.join(dir, name);
    const stat = fs.statSync(filePath);
    const records = readJsonLines(filePath, { limit: 40 });
    return {
      id: name.slice(0, -".jsonl".length),
      harness: "claude",
      format: "claude-jsonl",
      title: titleFrom(records, "Claude Code session"),
      lastActive: stat.mtime.toISOString(),
      filePath,
      sizeBytes: stat.size,
    };
  });
}

function discoverCodexSessions({ cwd, home }) {
  const root = path.join(home, ".codex", "sessions");
  const found = [];
  const stack = [root];
  let visited = 0;
  while (stack.length > 0 && visited < MAX_SCAN_FILES) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(entryPath); continue; }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      visited += 1;
      const records = readJsonLines(entryPath, { limit: 40 });
      const recordedCwd = records.find((record) => typeof record?.cwd === "string")?.cwd;
      if (recordedCwd !== cwd) continue;
      const stat = fs.statSync(entryPath);
      found.push({
        id: entry.name.slice("rollout-".length, -".jsonl".length),
        harness: "codex",
        format: "codex-rollout",
        title: titleFrom(records, "Codex session"),
        lastActive: stat.mtime.toISOString(),
        filePath: entryPath,
        sizeBytes: stat.size,
      });
    }
  }
  return found;
}

function discoverSessions({ cwd, home = os.homedir() } = {}) {
  return [...discoverClaudeSessions({ cwd, home }), ...discoverCodexSessions({ cwd, home })]
    .sort((left, right) => right.lastActive.localeCompare(left.lastActive));
}

function readSessionBytes(session, { maxBytes = 20 * 1024 * 1024 } = {}) {
  if (!session?.filePath || session.sizeBytes > maxBytes) return null;
  try {
    return fs.readFileSync(session.filePath);
  } catch {
    return null;
  }
}

function sessionExcerpt(session, { maxChars = 600 } = {}) {
  if (!session?.filePath) return "";
  const records = readJsonLines(session.filePath, { limit: 400 });
  const texts = [];
  for (const record of records.slice(-12)) {
    const text = firstText(record?.message?.content ?? record?.message ?? record?.text).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n").slice(-maxChars);
}

export { discoverSessions, readSessionBytes, sessionExcerpt, claudeProjectSlug };
