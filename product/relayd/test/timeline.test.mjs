import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  TIMELINE_CAPS,
  clipText,
  countTimelineEvents,
  createTimelineWriter,
  readTimeline,
} from "../src/timeline.mjs";

function scratchFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-timeline-"));
  return path.join(dir, "job.timeline.ndjson");
}

test("a writer with no path is a no-op", () => {
  const writer = createTimelineWriter({ file: "" });
  assert.equal(writer.enabled, false);
  writer.text("t1", "hello");
  writer.step({ id: "s1", kind: "command", status: "running" });
  writer.close();
});

test("events are numbered by line and read back from a cursor", () => {
  const file = scratchFile();
  const writer = createTimelineWriter({ file });
  writer.text("t1", "Looking at ");
  writer.text("t1", "pricing.");
  writer.step({ id: "s1", kind: "command", title: "Bash", status: "running", input: { command: "npm test" } });
  writer.stepDelta("s1", "12 passing\n");
  writer.step({ id: "s1", status: "done", exitCode: 0 });
  writer.usage({ inputTokens: 10, outputTokens: 2 });
  writer.close();

  const all = readTimeline(file);
  assert.deepEqual(all.events.map((entry) => entry.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(all.events.map((entry) => entry.event.type), ["text", "text", "step", "step.delta", "step", "usage"]);
  assert.equal(all.next, 6);
  assert.equal(all.total, 6);
  assert.equal(countTimelineEvents(file), 6);

  const tail = readTimeline(file, { since: 4 });
  assert.deepEqual(tail.events.map((entry) => entry.seq), [5, 6]);
  assert.equal(readTimeline(file, { since: 6 }).events.length, 0);
  assert.equal(readTimeline(file, { since: 99 }).next, 6);
});

test("empty text deltas are not written", () => {
  const file = scratchFile();
  const writer = createTimelineWriter({ file });
  writer.text("t1", "");
  writer.stepDelta("s1", "");
  writer.close();
  assert.equal(countTimelineEvents(file), 0);
});

test("a torn final line is left for the next read", () => {
  const file = scratchFile();
  fs.writeFileSync(file, '{"type":"text","id":"t1","delta":"a"}\n{"type":"text","id":"t1","del');
  const first = readTimeline(file);
  assert.equal(first.events.length, 1);
  assert.equal(first.next, 1);
  fs.appendFileSync(file, 'ta":"b"}\n');
  const second = readTimeline(file, { since: first.next });
  assert.deepEqual(second.events.map((entry) => entry.event.delta), ["b"]);
});

test("paging stops at the event limit and resumes from next", () => {
  const file = scratchFile();
  const writer = createTimelineWriter({ file });
  for (let index = 0; index < 5; index += 1) writer.text("t1", `chunk ${index} `);
  writer.close();
  const page = readTimeline(file, { maxEvents: 2 });
  assert.equal(page.events.length, 2);
  assert.equal(page.next, 2);
  assert.equal(readTimeline(file, { since: page.next, maxEvents: 2 }).next, 4);
});

test("step output is capped across deltas and the final step says so", () => {
  const file = scratchFile();
  const writer = createTimelineWriter({ file });
  writer.step({ id: "s1", kind: "command", status: "running" });
  const chunk = "x".repeat(20 * 1024);
  writer.stepDelta("s1", chunk);
  writer.stepDelta("s1", chunk);
  writer.stepDelta("s1", chunk);
  writer.step({ id: "s1", status: "done", exitCode: 0 });
  writer.close();

  const events = readTimeline(file).events.map((entry) => entry.event);
  const sent = events.filter((event) => event.type === "step.delta").reduce((sum, event) => sum + event.output.length, 0);
  assert.equal(sent, TIMELINE_CAPS.output);
  assert.equal(events.at(-1).outputTruncated, true);
});

test("clipText keeps the head and the tail", () => {
  const clipped = clipText(`START${"-".repeat(5000)}END`, 100);
  assert.equal(clipped.truncated, true);
  assert.equal(clipped.text.length, 100);
  assert.ok(clipped.text.startsWith("START"));
  assert.ok(clipped.text.endsWith("END"));
  assert.deepEqual(clipText("short", 100), { text: "short", truncated: false });
});

test("summaries are one line and inputs are capped", () => {
  const file = scratchFile();
  const writer = createTimelineWriter({ file });
  writer.step({
    id: "s1",
    kind: "command",
    status: "running",
    summary: `  build\n the   app ${"y".repeat(400)}`,
    input: { command: "z".repeat(20 * 1024), cwd: "/work" },
  });
  writer.close();
  const event = readTimeline(file).events[0].event;
  assert.ok(event.summary.startsWith("build the app "));
  assert.equal(event.summary.length, TIMELINE_CAPS.summary);
  assert.equal(event.input.command.length, TIMELINE_CAPS.inputField);
  assert.equal(event.input.cwd, "/work");
});
