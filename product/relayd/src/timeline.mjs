// relayd timeline.mjs — the per-job timeline: an append-only NDJSON record of
// what an agent wrote and what it did, in order. One JSON object per line; an
// event's sequence number is its 1-based line number.
//
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 1.
// Runners write through createTimelineWriter(); the daemon reads with readTimeline().
import fs from "node:fs";

export const TIMELINE_CAPS = Object.freeze({
  summary: 200,
  inputField: 8 * 1024,
  output: 32 * 1024,
  historyOutput: 4 * 1024,
});

export const STEP_KINDS = Object.freeze([
  "command", "read", "edit", "write", "search", "fetch", "tool", "agent", "reasoning", "todo",
]);

const CAPPED_INPUT_FIELDS = ["command", "prompt", "diff", "json"];

// Keeps the head and the tail: the start of a build log says what ran, the end
// says how it went, and the middle is the part nobody reads on a phone.
export function clipText(value, max) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (text.length <= max) return { text, truncated: false };
  const marker = "\n…\n";
  const head = Math.ceil((max - marker.length) * 0.6);
  const tail = Math.max(0, max - marker.length - head);
  return { text: text.slice(0, head) + marker + (tail ? text.slice(-tail) : ""), truncated: true };
}

function clipSummary(value) {
  const line = String(value ?? "").replace(/\s+/g, " ").trim();
  if (line.length <= TIMELINE_CAPS.summary) return line;
  return `${line.slice(0, TIMELINE_CAPS.summary - 1)}…`;
}

function clipInput(input) {
  if (!input || typeof input !== "object") return input;
  const next = { ...input };
  for (const field of CAPPED_INPUT_FIELDS) {
    if (typeof next[field] === "string") next[field] = clipText(next[field], TIMELINE_CAPS.inputField).text;
  }
  return next;
}

// A writer with no path is a no-op, so a runner started by an older daemon (or
// by a test that does not care) never has to branch on whether timelines exist.
export function createTimelineWriter({ file = process.env.RELAY_TIMELINE_PATH || "" } = {}) {
  let fd = null;
  if (file) {
    try {
      fd = fs.openSync(file, "a");
    } catch {
      fd = null;
    }
  }
  // Characters of output already sent per step, deltas included, so the cap
  // holds however the output arrives.
  const outputSent = new Map();
  const truncated = new Set();

  function write(event) {
    if (fd === null) return;
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`);
    } catch {
      // A full disk must not take the job down with it; the legacy log channels
      // still carry the run.
    }
  }

  return {
    enabled: fd !== null,

    text(id, delta) {
      if (!delta) return;
      write({ type: "text", id, delta });
    },

    // Create or update a step. Pass only the fields that changed.
    step(fields) {
      if (!fields || !fields.id) return;
      const event = { type: "step", ...fields };
      if (event.summary !== undefined) event.summary = clipSummary(event.summary);
      if (event.input !== undefined) event.input = clipInput(event.input);
      if (typeof event.output === "string") {
        const clipped = clipText(event.output, TIMELINE_CAPS.output);
        event.output = clipped.text;
        if (clipped.truncated) event.outputTruncated = true;
        outputSent.set(event.id, event.output.length);
      } else if (event.status && event.status !== "running" && truncated.has(event.id)) {
        event.outputTruncated = true;
      }
      write(event);
    },

    stepDelta(id, output) {
      if (!id || !output) return;
      const sent = outputSent.get(id) || 0;
      const room = TIMELINE_CAPS.output - sent;
      if (room <= 0) {
        truncated.add(id);
        return;
      }
      const chunk = output.length > room ? output.slice(0, room) : output;
      if (chunk.length < output.length) truncated.add(id);
      outputSent.set(id, sent + chunk.length);
      write({ type: "step.delta", id, output: chunk });
    },

    usage(fields) {
      if (!fields || typeof fields !== "object") return;
      write({ type: "usage", ...fields });
    },

    close() {
      if (fd === null) return;
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
      fd = null;
    },
  };
}

// Reads events after `since` (a count of events already held). A torn last
// line, which a reader can see while the writer is mid-append, is left for the
// next read rather than reported as an event.
export function readTimeline(file, { since = 0, maxEvents = 2000, maxBytes = 1024 * 1024 } = {}) {
  let raw = "";
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { events: [], next: 0, total: 0 };
  }
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  const lines = complete ? complete.slice(0, -1).split("\n") : [];
  const start = Math.max(0, Math.min(Number.isFinite(since) ? Math.trunc(since) : 0, lines.length));
  const events = [];
  let bytes = 0;
  let next = start;
  for (let index = start; index < lines.length && events.length < maxEvents; index += 1) {
    const line = lines[index];
    bytes += line.length + 1;
    if (events.length > 0 && bytes > maxBytes) break;
    next = index + 1;
    try {
      events.push({ seq: index + 1, event: JSON.parse(line) });
    } catch {
      // A line that is not JSON keeps its sequence number and is skipped, so
      // cursors stay line numbers.
    }
  }
  return { events, next, total: lines.length };
}

export function countTimelineEvents(file) {
  return readTimeline(file, { since: 0, maxEvents: 0 }).total;
}
