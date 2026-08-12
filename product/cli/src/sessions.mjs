// Find the local agent sessions that belong to this repository.
//
// Claude Code keys its transcripts by a slugified absolute cwd; Codex records
// the cwd inside the rollout. Cursor keeps no portable session file, so it is
// absent here by design and the handoff falls back to summary-priming rather
// than pretending a resume is possible.
//
// TWO RULES EVERY DISCOVERY PATH HERE OBEYS, because breaking either one broke
// the feature outright and neither was checked on both harnesses:
//
//   1. A session is only offered if the session ITSELF records the cwd we are
//      handing off. Directory layout is a hint, never proof: `claudeProjectSlug`
//      maps every non-alphanumeric byte to `-`, so `~/dev/my-repo`, `my_repo`,
//      `my.repo` and `my repo` all share ONE project directory. Trusting the
//      slug alone handed off a neighbouring project's transcript, leaked the
//      laptop path into the sandbox (relayd's rewrite is keyed on the manifest
//      cwd, which then did not match), and made Continue 400.
//   2. A session is only offered if its id is one relayd can actually resume —
//      `RESUMABLE_SESSION_ID_RE` below, the same contract relayd's
//      `src/sessionid.mjs` enforces on the other side of the wire. Offering an
//      id outside it is worse than offering nothing: the handoff succeeds, the
//      transcript is staged, and then Continue is rejected forever. Falling
//      back to the summary-primed path instead actually works.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_SCAN_FILES = 500;
const BOUNDED_READ_BYTES = 256 * 1024;

// Kept byte-identical to `RESUMABLE_SESSION_ID_RE` in
// `product/relayd/src/sessionid.mjs`. The two packages share no runtime code by
// design (the CLI ships on a laptop, relayd on a node), so the agreement is
// pinned by a test that imports BOTH and compares them across a table of
// values — see "the CLI and relayd agree, byte for byte, on what a resumable
// session id is" in test/sessions.test.mjs. Do not edit one copy alone.
const RESUMABLE_SESSION_ID_RE = /^[a-f0-9-]{36}$/;

function isResumableSessionId(value) {
  return typeof value === "string" && RESUMABLE_SESSION_ID_RE.test(value);
}

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

// The two harnesses write a turn differently, and this used to know only one
// of them: Claude Code writes `{type:"user", message:{content}}`, while a Codex
// rollout writes `{type:"response_item", payload:{type:"message", role,
// content:[{text}]}}`. Reading only the Claude shape gave every Codex handoff
// the fallback title and an empty excerpt.
function messageContentOf(record) {
  const payload = record?.payload;
  if (payload && typeof payload === "object" && payload.type === "message") return payload.content;
  return record?.message?.content ?? record?.message ?? record?.text;
}

function roleOf(record) {
  if (record?.type === "user" || record?.type === "assistant") return record.type;
  const payload = record?.payload;
  if (payload && typeof payload === "object" && payload.type === "message") {
    return payload.role === "user" || payload.role === "assistant" ? payload.role : null;
  }
  return null;
}

// Both harnesses record turns with role "user" that the user never typed: the
// caveat that precedes local command output, the slash-command wrappers, system
// reminders, hook output, Codex's injected context blocks. Reading the first
// "user" record literally is how a real handoff ended up titled
//   Handed off: <local-command-caveat>Caveat: The messages below were generated…
// and how the same text reached the excerpt the phone renders on its card.
const SYNTHETIC_TAGS = [
  "local-command-caveat",
  "local-command-stdout",
  "local-command-stderr",
  "command-name",
  "command-message",
  "command-args",
  "system-reminder",
  "user-prompt-submit-hook",
  "environment_context",
  "user_instructions",
];
const SYNTHETIC_BLOCK_RE = new RegExp(`<(${SYNTHETIC_TAGS.join("|")})>[\\s\\S]*?</\\1>`, "gi");
const SYNTHETIC_OPEN_RE = new RegExp(`<(?:${SYNTHETIC_TAGS.join("|")})>`, "i");
const SYNTHETIC_STRAY_RE = new RegExp(`</?(?:${SYNTHETIC_TAGS.join("|")})>`, "gi");

// Returns the human-written part of a turn, or "" when the whole turn was
// machine-generated.
function stripSyntheticMarkup(value) {
  let text = String(value ?? "").replace(SYNTHETIC_BLOCK_RE, "");
  // An unclosed opener is the common case, not an edge case — the caveat that
  // broke this arrives with no closing tag, and everything after it belongs to
  // the machine. Cutting to the end is what keeps that text out of the title;
  // stripping only the tag would leave the caveat body behind as the title.
  const unclosed = text.search(SYNTHETIC_OPEN_RE);
  if (unclosed !== -1) text = text.slice(0, unclosed);
  return text.replace(SYNTHETIC_STRAY_RE, "").trim();
}

function titleFrom(records, fallback) {
  for (const record of records) {
    if (roleOf(record) !== "user") continue;
    const text = stripSyntheticMarkup(firstText(messageContentOf(record)));
    if (text) return text.split("\n")[0].slice(0, 120);
  }
  return fallback;
}

function discoverClaudeSessions({ cwd, home }) {
  const dir = path.join(home, ".claude", "projects", claudeProjectSlug(cwd));
  const wantedCwd = normalizeCwd(cwd);
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
    // Claude Code names a transcript `<sessionId>.jsonl`, and that id is what
    // `--resume` and relayd's resume gate both take. An id outside the shared
    // contract cannot be resumed on the far side, so it is not offered here
    // (rule 2 in the header).
    const id = name.slice(0, -".jsonl".length);
    if (!isResumableSessionId(id)) continue;
    const records = readJsonLines(filePath, { limit: 40 });
    // Rule 1: the transcript must say it belongs to THIS directory. The project
    // slug is not injective, so the directory this file sits in proves nothing
    // — `/Users/dev/my-repo` and `/Users/dev/my_repo` share it. Claude Code
    // stamps `cwd` on the records themselves; the first one that has it decides,
    // exactly as the Codex path below has always done. A transcript that
    // declares no cwd at all inside the bounded read is skipped rather than
    // guessed at: the same fail-closed choice, and the wrong guess would ship a
    // stranger's transcript off the machine.
    const recordedCwd = records.find((record) => typeof record?.cwd === "string")?.cwd;
    if (recordedCwd === undefined || normalizeCwd(recordedCwd) !== wantedCwd) continue;
    sessions.push({
      id,
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

// The one line of a Codex rollout that states what the rollout IS. Every other
// component of this product models it the same way — relayd's
// `threads.readSessionMeta`, its conformance fixtures, relayd/API.md — and this
// function used to be the sole exception, reading a TOP-LEVEL `cwd` that no
// real rollout carries and deriving the id from the FILENAME
// (`rollout-<timestamp>-<uuid>.jsonl`, 56 characters) instead of from
// `payload.id`. The result was that a genuine rollout never matched at all, and
// a synthetic one produced an id relayd rejected. Both halves of that are fixed
// by reading the one shape everything else agrees on.
function readCodexSessionMeta(records) {
  for (const record of records) {
    if (record?.type !== "session_meta") continue;
    const payload = record.payload;
    if (!payload || typeof payload !== "object") continue;
    if (!isResumableSessionId(payload.id)) continue;
    if (typeof payload.cwd !== "string" || payload.cwd.length === 0) continue;
    return { id: payload.id, cwd: payload.cwd };
  }
  return null;
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
      const meta = readCodexSessionMeta(records);
      if (!meta) continue;
      if (normalizeCwd(meta.cwd) !== wantedCwd) continue;
      found.push({
        id: meta.id,
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
    // Same filter as the title, and for a stronger reason: this text is what
    // the phone renders on the handoff card, so a system-reminder or a block
    // of local command output would be shown to the user as if it were part
    // of their conversation.
    const text = stripSyntheticMarkup(firstText(messageContentOf(record)));
    if (text) texts.push(text);
  }
  return texts.join("\n").slice(-maxChars);
}

export {
  discoverSessions,
  readSessionBytes,
  sessionExcerpt,
  stripSyntheticMarkup,
  claudeProjectSlug,
  isResumableSessionId,
  RESUMABLE_SESSION_ID_RE,
};
