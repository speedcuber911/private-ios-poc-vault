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
const BOUNDED_READ_BYTES = 256 * 1024;

function claudeProjectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, "-");
}

// Resolve a recorded/observed cwd to a comparable form: absolute, no trailing
// separator, and symlink-resolved when the path still exists on disk. A
// recorded cwd from a since-deleted directory falls back to plain textual
// normalization rather than throwing.
function normalizeCwd(value) {
  if (typeof value !== "string" || value.length === 0) return value;
  let resolved = path.resolve(value);
  try {
    resolved = fs.realpathSync.native(resolved);
  } catch {
    // Path may no longer exist; textual normalization below is still valid.
  }
  if (resolved.length > 1 && resolved.endsWith(path.sep)) {
    resolved = resolved.slice(0, -path.sep.length);
  }
  return resolved;
}

// Read at most maxBytes of a file, from the start or from the end, without
// ever loading the whole thing. Used so that discovery (deriving a title) and
// excerpting (reading the newest turns) stay cheap regardless of how large a
// live session transcript has grown.
// O_NONBLOCK is defence in depth, not the primary guard: every call site
// below stats the entry and skips anything that is not a regular file
// (stat.isFile()) before ever reaching here. But an open-for-read on a FIFO
// blocks the OS thread until a writer shows up, with no way to time it out
// from JS once fs.openSync has been called — so if a FIFO ever slips through
// (a TOCTOU race, or a future call site that forgets the stat check), a
// non-blocking open turns that hang into an immediate ENXIO/EAGAIN instead,
// which the catch below already treats as "no content".
const NONBLOCK_READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);

function readBoundedChunk(filePath, { maxBytes = BOUNDED_READ_BYTES, fromEnd = false } = {}) {
  let fd;
  try {
    fd = fs.openSync(filePath, NONBLOCK_READ_FLAGS);
  } catch {
    return "";
  }
  try {
    const size = fs.fstatSync(fd).size;
    const readLength = Math.min(maxBytes, size);
    if (readLength <= 0) return "";
    const position = fromEnd ? size - readLength : 0;
    const buffer = Buffer.alloc(readLength);
    fs.readSync(fd, buffer, 0, readLength, position);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Already closed or never fully opened; nothing more to do.
    }
  }
}

function safeStat(filePath) {
  try {
    return fs.statSync(filePath, { throwIfNoEntry: false }) ?? null;
  } catch {
    // e.g. a dangling symlink, or the file vanished between listing and stat.
    return null;
  }
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

function readJsonLines(filePath, { limit = 400, maxBytes = BOUNDED_READ_BYTES, fromEnd = false } = {}) {
  const text = readBoundedChunk(filePath, { maxBytes, fromEnd });
  const allLines = text.split("\n").filter(Boolean);
  const lines = fromEnd ? allLines.slice(-limit) : allLines.slice(0, limit);
  const records = [];
  for (const line of lines) {
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partially flushed trailing line (live writer) or a line cut off at
      // the start of a bounded from-the-end read is expected; skip it.
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
  const sessions = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    const stat = safeStat(filePath);
    if (!stat) continue; // e.g. a dangling symlink; one damaged entry must not abort discovery.
    // A directory, FIFO, socket, or device can share a ".jsonl" name. Skip
    // anything that is not a regular file *before* ever opening it — opening
    // a FIFO with no writer blocks the OS thread indefinitely, which no
    // in-process timeout can recover from.
    if (!stat.isFile()) continue;
    const records = readJsonLines(filePath, { limit: 40 });
    sessions.push({
      id: name.slice(0, -".jsonl".length),
      harness: "claude",
      format: "claude-jsonl",
      title: titleFrom(records, "Claude Code session"),
      lastActive: stat.mtime.toISOString(),
      filePath,
      sizeBytes: stat.size,
    });
  }
  return sessions;
}

function discoverCodexSessions({ cwd, home }) {
  const root = path.join(home, ".codex", "sessions");
  const wantedCwd = normalizeCwd(cwd);
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
      if (visited >= MAX_SCAN_FILES) break; // Enforce the cap within a single (possibly flat) directory too.
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(entryPath); continue; }
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      visited += 1;
      const stat = safeStat(entryPath);
      // Stat (cheap, non-blocking) before ever opening the file: a FIFO or
      // other non-regular entry sharing this name must be skipped here, not
      // discovered by trying to open it and blocking forever with no writer.
      if (!stat || !stat.isFile()) continue;
      const records = readJsonLines(entryPath, { limit: 40 });
      const recordedCwd = records.find((record) => typeof record?.cwd === "string")?.cwd;
      if (normalizeCwd(recordedCwd) !== wantedCwd) continue;
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
  // Read from the tail: an excerpt wants the newest turns, and a session can
  // be far larger than we ever want to load into memory just to summarize it.
  const records = readJsonLines(session.filePath, { limit: 400, fromEnd: true });
  const texts = [];
  for (const record of records.slice(-12)) {
    const text = firstText(record?.message?.content ?? record?.message ?? record?.text).trim();
    if (text) texts.push(text);
  }
  return texts.join("\n").slice(-maxChars);
}

export { discoverSessions, readSessionBytes, sessionExcerpt, claudeProjectSlug };
