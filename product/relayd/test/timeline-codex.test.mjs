import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TIMELINE_CAPS, createTimelineWriter, readTimeline } from "../src/timeline.mjs";
import {
  createCodexNotificationMapper,
  createCodexTranscriptCollector,
  displayCommand,
  readableName,
  writeTimelineEvents,
} from "../src/timeline-codex.mjs";

// Fixtures are real captures from codex-cli 0.159.2 (`codex app-server --stdio`
// and the rollouts those two sessions wrote), with ids and paths replaced.
const fixtures = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures");
function fixture(name) {
  return fs.readFileSync(path.join(fixtures, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
}

// Folds events the way a reader does: steps merge field by field, deltas
// append, a later `output` replaces, text appends per block id.
function reduce(events) {
  const order = [];
  const steps = new Map();
  const texts = new Map();
  let usage = null;
  for (const event of events) {
    if (event.type === "text") {
      if (!texts.has(event.id)) { texts.set(event.id, ""); order.push(`text:${event.id}`); }
      texts.set(event.id, texts.get(event.id) + event.delta);
    } else if (event.type === "step") {
      const { type: _type, ...fields } = event;
      if (!steps.has(event.id)) { steps.set(event.id, {}); order.push(`step:${event.id}`); }
      Object.assign(steps.get(event.id), fields);
    } else if (event.type === "step.delta") {
      const step = steps.get(event.id);
      assert.ok(step, `delta for unknown step ${event.id}`);
      step.output = (step.output || "") + event.output;
    } else if (event.type === "usage") {
      usage = event;
    }
  }
  return { order, steps, texts, usage };
}

function replay(entries, decide = () => "accept") {
  const mapper = createCodexNotificationMapper();
  const events = [];
  for (const entry of entries) {
    if (entry.kind === "request") {
      const requested = mapper.approvalRequested(entry);
      events.push(...requested.events, ...mapper.approvalResolved(requested.id, decide(entry)));
    } else {
      events.push(...mapper.push(entry));
    }
  }
  return events;
}

const at = { startedAtMs: 1791271900000, completedAtMs: 1791271901500 };
const started = (item) => ({ method: "item/started", params: { item, threadId: "th", turnId: "tu", startedAtMs: at.startedAtMs } });
const completed = (item) => ({ method: "item/completed", params: { item, threadId: "th", turnId: "tu", completedAtMs: at.completedAtMs } });

test("a real run maps to prose, a listing, a read and an edit, in order", () => {
  const events = replay(fixture("codex-appserver-edit.ndjson"));
  const { order, steps, texts, usage } = reduce(events);
  assert.deepEqual(order.map((entry) => entry.split(":")[0]), ["text", "step", "step", "step", "text"]);

  const [first, second, edit] = [...steps.values()];
  assert.deepEqual(
    { kind: first.kind, title: first.title, status: first.status, exitCode: first.exitCode, output: first.output, input: first.input },
    {
      // Codex parsed this as one `ls`, so it is a listing of the working directory.
      kind: "search", title: "Search", status: "done", exitCode: 0, output: "hello-relay\nnotes.txt\n",
      input: { command: "echo hello-relay && ls", cwd: "/work/scratch" },
    },
  );
  assert.equal(first.summary, "scratch");
  assert.equal(first.startedAt, "2026-10-06T07:31:48.249Z");
  assert.equal(first.endedAt, "2026-10-06T07:31:48.250Z");
  assert.deepEqual(
    { kind: second.kind, title: second.title, summary: second.summary, input: second.input, exitCode: second.exitCode },
    { kind: "read", title: "Read", summary: "notes.txt", input: { path: "/work/scratch/notes.txt", command: "cat notes.txt", cwd: "/work/scratch" }, exitCode: 0 },
  );
  assert.equal(second.output, "status: draft\nowner: relay\n");
  assert.deepEqual(
    { kind: edit.kind, title: edit.title, summary: edit.summary, status: edit.status, input: edit.input },
    {
      kind: "edit", title: "Edit", summary: "notes.txt", status: "done",
      input: { path: "/work/scratch/notes.txt", diff: "@@ -1,2 +1,2 @@\n-status: draft\n+status: final\n owner: relay\n" },
    },
  );

  // Prose never contains command output, and each message is its own block.
  const prose = [...texts.values()];
  assert.equal(prose.length, 2);
  assert.match(prose[0], /^I’ll run the command/);
  assert.match(prose[1], /^I ran `echo hello-relay && ls`/);
  assert.ok(prose.every((text) => !text.includes("owner: relay")));

  // Usage is this turn's requests summed, reported once.
  assert.equal(events.filter((event) => event.type === "usage").length, 1);
  assert.deepEqual(usage, {
    type: "usage", inputTokens: 95889, outputTokens: 239, cachedInputTokens: 84352, reasoningOutputTokens: 0, totalTokens: 96128,
  });
});

test("a real run with approvals: reasoning, live output, a decline and a failure", () => {
  const entries = fixture("codex-appserver-approvals.ndjson");
  const events = replay(entries, (request) => (/denied/.test(JSON.stringify(request.params)) ? "decline" : "accept"));
  const { order, steps, texts } = reduce(events);
  assert.deepEqual(
    order.map((entry) => entry.split(":")[0]),
    ["text", "step", "step", "text", "step", "text", "step", "text"],
  );
  const [thinking, loop, denied, failing] = [...steps.values()];
  assert.deepEqual({ kind: thinking.kind, title: thinking.title, status: thinking.status }, { kind: "reasoning", title: "Thinking", status: "done" });
  assert.equal(loop.output, "tick 1\ntick 2\ntick 3\n");
  assert.equal(loop.exitCode, 0);
  assert.deepEqual({ status: denied.status, error: denied.error, command: denied.input.command }, { status: "cancelled", error: "Declined", command: "touch denied.txt" });
  assert.equal(denied.exitCode, undefined);
  assert.deepEqual({ status: failing.status, exitCode: failing.exitCode }, { status: "failed", exitCode: 1 });
  assert.equal(texts.size, 4);

  // Codex announces the item before it asks, so the step is already running
  // when the runner blocks, and live output arrives as deltas before the end.
  const loopId = [...steps.keys()][1];
  const kinds = events.filter((event) => event.id === loopId).map((event) => `${event.type}:${event.status || ""}`);
  assert.deepEqual(kinds, ["step:running", "step.delta:", "step.delta:", "step:done"]);
  // The decline closes the step once; Codex's own `declined` completion adds nothing.
  const deniedId = [...steps.keys()][2];
  assert.deepEqual(events.filter((event) => event.id === deniedId).map((event) => event.status), ["running", "cancelled"]);
});

test("a decline reported only by Codex still cancels the step", () => {
  const mapper = createCodexNotificationMapper();
  const item = { type: "commandExecution", id: "c1", command: "/bin/zsh -lc 'rm -rf build'", cwd: "/w", status: "inProgress", commandActions: [] };
  mapper.push(started(item));
  const [closed] = mapper.push(completed({ ...item, status: "declined", exitCode: null, aggregatedOutput: null }));
  assert.equal(closed.status, "cancelled");
  assert.equal(closed.error, "Declined");
  assert.equal("exitCode" in closed, false);
});

test("an approval with no announced item creates the step, and accepting leaves it running", () => {
  const mapper = createCodexNotificationMapper();
  const requested = mapper.approvalRequested({
    method: "item/commandExecution/requestApproval",
    params: { itemId: "item-1", command: "npm test", cwd: "/w" },
  });
  assert.equal(requested.id, "item-1");
  assert.equal(requested.events.length, 1);
  assert.deepEqual(
    { ...requested.events[0], startedAt: undefined },
    { type: "step", id: "item-1", kind: "command", title: "Bash", summary: "npm test", status: "running", startedAt: undefined, input: { command: "npm test", cwd: "/w" } },
  );
  assert.deepEqual(mapper.approvalResolved("item-1", "acceptForSession"), []);
  assert.deepEqual(mapper.approvalResolved("item-1", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["npm"] } }), []);
  const [cancelled] = mapper.approvalResolved("item-1", "cancel");
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(mapper.approvalResolved("item-1", "decline"), []);

  const file = mapper.approvalRequested({ method: "item/fileChange/requestApproval", params: { itemId: "f1", reason: "Write outside the workspace" } });
  assert.equal(file.events[0].kind, "edit");
  // The item arriving afterwards fills in the paths rather than opening a second step.
  const [filled] = mapper.push(started({ type: "fileChange", id: "f1", status: "inProgress", changes: [{ path: "/w/a.txt", kind: { type: "add" }, diff: "hello\n" }] }));
  assert.deepEqual(filled, { type: "step", id: "f1", kind: "write", title: "Write", summary: "a.txt", input: { path: "/w/a.txt", diff: "+hello\n" } });
});

test("file changes: an added file is a write, several files share one step", () => {
  const mapper = createCodexNotificationMapper();
  const [write] = mapper.push(started({ type: "fileChange", id: "w1", status: "inProgress", changes: [{ path: "/w/new.md", kind: { type: "add" }, diff: "one\ntwo\n" }] }));
  assert.deepEqual({ kind: write.kind, title: write.title, diff: write.input.diff }, { kind: "write", title: "Write", diff: "+one\n+two\n" });

  const [multi] = mapper.push(started({
    type: "fileChange", id: "m1", status: "inProgress",
    changes: [
      { path: "/w/a.js", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-a\n+b\n" },
      { path: "/w/old.js", kind: { type: "delete" }, diff: "gone\n" },
    ],
  }));
  assert.equal(multi.kind, "edit");
  assert.equal(multi.summary, "a.js, old.js");
  assert.equal(multi.input.path, "/w/a.js");
  assert.equal(multi.input.diff, "--- /w/a.js\n+++ /w/a.js\n@@ -1 +1 @@\n-a\n+b\n\n--- /w/old.js\n+++ /w/old.js\n-gone\n");

  // A patch that grows while it streams updates the step it belongs to.
  const [updated] = mapper.push({ method: "item/fileChange/patchUpdated", params: { itemId: "w1", changes: [{ path: "/w/new.md", kind: { type: "add" }, diff: "one\ntwo\nthree\n" }] } });
  assert.equal(updated.input.diff, "+one\n+two\n+three\n");
  const [failed] = mapper.push(completed({ type: "fileChange", id: "m1", status: "failed", changes: [] }));
  assert.equal(failed.status, "failed");
});

test("web searches, MCP calls, plans, agents and unknown items all become steps", () => {
  const mapper = createCodexNotificationMapper();

  // A search's query is only known when it completes.
  const [searchOpen] = mapper.push(started({ type: "webSearch", id: "ws1", query: "", action: null }));
  assert.deepEqual({ kind: searchOpen.kind, title: searchOpen.title, summary: searchOpen.summary }, { kind: "fetch", title: "Web Search", summary: "the web" });
  const [searchDone] = mapper.push(completed({ type: "webSearch", id: "ws1", query: "relay timeline", action: { type: "search", query: "relay timeline" } }));
  assert.deepEqual({ status: searchDone.status, summary: searchDone.summary, input: searchDone.input }, { status: "done", summary: "relay timeline", input: { query: "relay timeline" } });
  const [page] = mapper.push(completed({ type: "webSearch", id: "ws2", query: "", action: { type: "openPage", url: "https://example.com/docs/a" } }));
  assert.deepEqual({ title: page.title, summary: page.summary, input: page.input }, { title: "Web Page", summary: "example.com", input: { url: "https://example.com/docs/a" } });

  const call = { type: "mcpToolCall", id: "m1", server: "session", tool: "mark_chapter", arguments: { title: "Verification" }, status: "inProgress" };
  const [toolOpen] = mapper.push(started(call));
  assert.deepEqual(
    { kind: toolOpen.kind, title: toolOpen.title, summary: toolOpen.summary, input: toolOpen.input },
    { kind: "tool", title: "Mark Chapter", summary: "Verification", input: { name: "mark_chapter", server: "session", json: "{\"title\":\"Verification\"}" } },
  );
  const [progress] = mapper.push({ method: "item/mcpToolCall/progress", params: { itemId: "m1", message: "working" } });
  assert.deepEqual(progress, { type: "step.delta", id: "m1", output: "working\n" });
  const [toolDone] = mapper.push(completed({ ...call, status: "completed", result: { content: [{ type: "text", text: "ok" }, { type: "image" }] } }));
  assert.deepEqual({ status: toolDone.status, output: toolDone.output }, { status: "done", output: "ok\n[image]" });
  const [toolFailed] = mapper.push(completed({ ...call, id: "m2", status: "failed", error: { message: "server gone" }, result: null }));
  assert.deepEqual({ status: toolFailed.status, error: toolFailed.error }, { status: "failed", error: "server gone" });
  const [toolError] = mapper.push(completed({ ...call, id: "m3", status: "completed", result: { content: [{ type: "text", text: "nope" }], isError: true } }));
  assert.equal(toolError.status, "failed");

  const [plan] = mapper.push({
    method: "turn/plan/updated",
    params: { threadId: "th", turnId: "tu", explanation: null, plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }, { step: "Test", status: "pending" }] },
  });
  assert.deepEqual(
    { id: plan.id, kind: plan.kind, title: plan.title, summary: plan.summary, status: plan.status, input: plan.input },
    {
      id: "plan-tu-1", kind: "todo", title: "Plan", summary: "Fix", status: "done",
      input: { items: [{ text: "Read", status: "completed" }, { text: "Fix", status: "in_progress" }, { text: "Test", status: "pending" }] },
    },
  );
  assert.equal(mapper.push({ method: "turn/plan/updated", params: { turnId: "tu", plan: [{ step: "Read", status: "completed" }] } })[0].id, "plan-tu-2");

  const [agent] = mapper.push(started({ type: "collabAgentToolCall", id: "a1", tool: "spawnAgent", prompt: "Audit callers\nof roundPrice", status: "inProgress", receiverThreadIds: [], agentsStates: {}, senderThreadId: "th" }));
  assert.deepEqual(
    { kind: agent.kind, title: agent.title, summary: agent.summary, input: agent.input },
    { kind: "agent", title: "Agent", summary: "Audit callers", input: { description: "Audit callers", prompt: "Audit callers\nof roundPrice" } },
  );
  const [wait] = mapper.push(started({ type: "collabAgentToolCall", id: "a2", tool: "wait", status: "inProgress", receiverThreadIds: ["sub"], agentsStates: {}, senderThreadId: "th" }));
  assert.deepEqual({ kind: wait.kind, title: wait.title, server: wait.input.server }, { kind: "tool", title: "Wait", server: "collaboration" });

  // Nothing is silently dropped: an item type this code has never heard of.
  const [unknown] = mapper.push(started({ type: "holoDeck", id: "u1", status: "inProgress", program: "Dixon Hill" }));
  assert.deepEqual(
    { kind: unknown.kind, title: unknown.title, status: unknown.status, input: unknown.input },
    { kind: "tool", title: "Holo Deck", status: "running", input: { name: "holoDeck", json: "{\"program\":\"Dixon Hill\"}" } },
  );
  assert.equal(mapper.push(completed({ type: "holoDeck", id: "u1", status: "failed" }))[0].status, "failed");
  const [compaction] = mapper.push(completed({ type: "contextCompaction", id: "cc1" }));
  assert.deepEqual({ title: compaction.title, status: compaction.status }, { title: "Context Compaction", status: "done" });
  const [image] = mapper.push(completed({ type: "imageView", id: "i1", path: "/w/shot.png" }));
  assert.deepEqual({ kind: image.kind, summary: image.summary, input: image.input }, { kind: "read", summary: "shot.png", input: { path: "/w/shot.png" } });
});

test("Codex's parse of a command picks the step kind, and an empty search is not a failure", () => {
  const mapper = createCodexNotificationMapper();
  const run = (id, script, commandActions, end) => {
    const item = { type: "commandExecution", id, command: `/bin/zsh -lc '${script}'`, cwd: "/w/app", status: "inProgress", commandActions };
    const [opened] = mapper.push(started(item));
    const [closed] = mapper.push(completed({ ...item, ...end }));
    return { ...opened, ...closed };
  };
  const ok = { status: "completed", exitCode: 0 };

  const read = run("k1", "sed -n 1,40p src/pricing.ts", [{ type: "read", command: "sed -n 1,40p src/pricing.ts", name: "pricing.ts", path: "/w/app/src/pricing.ts" }], { ...ok, aggregatedOutput: "export {}\n" });
  assert.deepEqual(
    { kind: read.kind, title: read.title, summary: read.summary, input: read.input, status: read.status, output: read.output },
    { kind: "read", title: "Read", summary: "pricing.ts", input: { path: "/w/app/src/pricing.ts", command: "sed -n 1,40p src/pricing.ts", cwd: "/w/app" }, status: "done", output: "export {}\n" },
  );

  const search = run("k2", "rg roundPrice src", [{ type: "search", command: "rg roundPrice src", query: "roundPrice", path: "src" }], { ...ok, aggregatedOutput: "src/a.ts:1:roundPrice\n" });
  assert.deepEqual(
    { kind: search.kind, title: search.title, summary: search.summary, input: search.input, output: search.output },
    { kind: "search", title: "Search", summary: "roundPrice", input: { pattern: "roundPrice", path: "src", command: "rg roundPrice src", cwd: "/w/app" }, output: "src/a.ts:1:roundPrice\n" },
  );
  const pathless = run("k3", "rg TODO", [{ type: "search", command: "rg TODO", query: "TODO", path: null }], { ...ok, aggregatedOutput: "" });
  assert.deepEqual(pathless.input, { pattern: "TODO", command: "rg TODO", cwd: "/w/app" });

  const listing = run("k4", "ls src", [{ type: "listFiles", command: "ls src", path: "src" }], { ...ok, aggregatedOutput: "a.ts\n" });
  assert.deepEqual({ kind: listing.kind, title: listing.title, summary: listing.summary, input: listing.input }, { kind: "search", title: "Search", summary: "src", input: { path: "src", command: "ls src", cwd: "/w/app" } });
  const here = run("k5", "ls", [{ type: "listFiles", command: "ls", path: null }], { ...ok, aggregatedOutput: "a\n" });
  assert.deepEqual({ kind: here.kind, summary: here.summary }, { kind: "search", summary: "app" });

  // More than one action, or one Codex could not classify, stays a command.
  const two = run("k6", "cat a && rg b", [{ type: "read", command: "cat a", name: "a", path: "/w/app/a" }, { type: "search", command: "rg b", query: "b", path: null }], ok);
  assert.deepEqual({ kind: two.kind, title: two.title, summary: two.summary }, { kind: "command", title: "Bash", summary: "cat a && rg b" });
  const unknown = run("k7", "npm test", [{ type: "unknown", command: "npm test" }], ok);
  assert.equal(unknown.kind, "command");
  assert.equal(run("k8", "npm test", [], ok).kind, "command");

  // No matches: exit 1 and nothing printed. Done, with the exit code kept.
  const none = run("k9", "rg nothing", [{ type: "search", command: "rg nothing", query: "nothing", path: null }], { status: "failed", exitCode: 1, aggregatedOutput: null });
  assert.deepEqual({ status: none.status, exitCode: none.exitCode }, { status: "done", exitCode: 1 });
  const emptyListing = run("k10", "rg --files -g x", [{ type: "listFiles", command: "rg --files -g x", path: null }], { status: "failed", exitCode: 1, aggregatedOutput: "" });
  assert.deepEqual({ status: emptyListing.status, exitCode: emptyListing.exitCode }, { status: "done", exitCode: 1 });
  // Real failures stay failed: a higher exit code, or anything printed.
  const broken = run("k11", "rg '('", [{ type: "search", command: "rg '('", query: "(", path: null }], { status: "failed", exitCode: 2, aggregatedOutput: null });
  assert.deepEqual({ status: broken.status, exitCode: broken.exitCode }, { status: "failed", exitCode: 2 });
  const noisy = run("k12", "grep x missing", [{ type: "search", command: "grep x missing", query: "x", path: "missing" }], { status: "failed", exitCode: 1, aggregatedOutput: "grep: missing: No such file\n" });
  assert.equal(noisy.status, "failed");
  // The rule is for searches only: a read or a command that exits 1 failed.
  const badRead = run("k13", "cat gone", [{ type: "read", command: "cat gone", name: "gone", path: "/w/app/gone" }], { status: "failed", exitCode: 1, aggregatedOutput: null });
  assert.deepEqual({ kind: badRead.kind, status: badRead.status }, { kind: "read", status: "failed" });
  const badCommand = run("k14", "false", [{ type: "unknown", command: "false" }], { status: "failed", exitCode: 1, aggregatedOutput: null });
  assert.equal(badCommand.status, "failed");
});

test("reasoning streams as deltas, keeps parts apart and never mixes summary with raw text", () => {
  const mapper = createCodexNotificationMapper();
  const events = [
    ...mapper.push(started({ type: "reasoning", id: "r1", summary: [], content: [] })),
    ...mapper.push({ method: "item/reasoning/summaryPartAdded", params: { itemId: "r1", summaryIndex: 0 } }),
    ...mapper.push({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex: 0, delta: "**Reading** the" } }),
    ...mapper.push({ method: "item/reasoning/textDelta", params: { itemId: "r1", contentIndex: 0, delta: "RAW" } }),
    ...mapper.push({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex: 0, delta: " tax line." } }),
    ...mapper.push({ method: "item/reasoning/summaryPartAdded", params: { itemId: "r1", summaryIndex: 1 } }),
    ...mapper.push({ method: "item/reasoning/summaryTextDelta", params: { itemId: "r1", summaryIndex: 1, delta: "Then test." } }),
  ];
  const live = reduce(events).steps.get("r1");
  assert.deepEqual({ kind: live.kind, title: live.title, status: live.status, output: live.output }, { kind: "reasoning", title: "Thinking", status: "running", output: "**Reading** the tax line.\n\nThen test." });
  const [done] = mapper.push(completed({ type: "reasoning", id: "r1", summary: ["**Reading** the tax line.", "Then test."], content: [] }));
  assert.deepEqual({ status: done.status, output: done.output }, { status: "done", output: "**Reading** the tax line.\n\nThen test." });
});

test("text block ids follow the message item and change after every step", () => {
  const mapper = createCodexNotificationMapper();
  const delta = (itemId, text) => mapper.push({ method: "item/agentMessage/delta", params: itemId ? { itemId, delta: text } : { delta: text } });
  const command = { type: "commandExecution", id: "c1", command: "ls", cwd: "/w", status: "inProgress", commandActions: [] };

  assert.deepEqual(delta("msg_a", "One "), [{ type: "text", id: "msg_a", delta: "One " }]);
  assert.deepEqual(delta("msg_a", "two."), [{ type: "text", id: "msg_a", delta: "two." }]);
  // The same message resuming after a step is a new block.
  mapper.push(started(command));
  assert.equal(delta("msg_a", "Three.")[0].id, "msg_a.2");
  // The completed message adds nothing when its deltas already streamed.
  assert.deepEqual(mapper.push(completed({ type: "agentMessage", id: "msg_a", text: "One two.Three." })), []);
  // A server that sends no item id still gets stable, changing block ids.
  assert.equal(delta("", "a")[0].id, "t1");
  assert.equal(delta("", "b")[0].id, "t1");
  mapper.push(completed({ ...command, status: "completed", exitCode: 0, aggregatedOutput: "x\n" }));
  assert.equal(delta("", "c")[0].id, "t2");
  // A message that never streamed is recorded whole when it completes.
  assert.deepEqual(mapper.push(completed({ type: "agentMessage", id: "msg_b", text: "Whole answer." })), [{ type: "text", id: "msg_b", delta: "Whole answer." }]);
  assert.deepEqual(mapper.push(completed({ type: "exitedReviewMode", id: "rev", review: "Looks right." })), [{ type: "text", id: "rev", delta: "Looks right." }]);
  assert.deepEqual(mapper.push(started({ type: "userMessage", id: "u", content: [] })), []);
});

test("out-of-order and unknown notifications are absorbed", () => {
  const mapper = createCodexNotificationMapper();
  // Output before the item was announced: the step is created to hold it.
  const early = mapper.push({ method: "item/commandExecution/outputDelta", params: { itemId: "c9", delta: "early\n" } });
  assert.deepEqual(early.map((event) => event.type), ["step", "step.delta"]);
  assert.deepEqual({ id: early[0].id, kind: early[0].kind, status: early[0].status }, { id: "c9", kind: "command", status: "running" });
  // The late start fills in the command instead of opening a second step.
  const [late] = mapper.push(started({ type: "commandExecution", id: "c9", command: "/bin/bash -lc \"echo early\"", cwd: "/w", status: "inProgress", commandActions: [] }));
  assert.deepEqual(late, { type: "step", id: "c9", summary: "echo early", input: { command: "echo early", cwd: "/w" } });

  // Completed with no start: one event carries the whole step, timed from its duration.
  const [whole] = mapper.push(completed({ type: "commandExecution", id: "c10", command: ["/bin/zsh", "-lc", "false"], cwd: "/w", status: "failed", exitCode: 1, aggregatedOutput: null, durationMs: 500, commandActions: [] }));
  assert.deepEqual(whole, {
    type: "step", id: "c10", kind: "command", title: "Bash", summary: "false", status: "failed",
    startedAt: "2026-10-06T07:31:41.000Z", endedAt: "2026-10-06T07:31:41.500Z", input: { command: "false", cwd: "/w" }, exitCode: 1,
  });
  // A second completion, and a delta after the end, change nothing.
  assert.deepEqual(mapper.push(completed({ type: "commandExecution", id: "c10", command: "false", status: "completed", exitCode: 0 })), []);
  assert.deepEqual(mapper.push({ method: "item/commandExecution/outputDelta", params: { itemId: "c10", delta: "late" } }), []);

  for (const notification of [
    { method: "mcpServer/startupStatus/updated", params: { name: "x", status: "ready" } },
    { method: "thread/status/changed", params: { threadId: "th", status: { type: "idle" } } },
    { method: "item/somethingNew/delta", params: { itemId: "c9", delta: "?" } },
    { method: "turn/completed", params: { turn: { status: "completed" } } },
    { method: "item/started" },
    { method: "item/completed", params: { item: null } },
    {},
    null,
  ]) {
    assert.deepEqual(mapper.push(notification), []);
  }
});

test("a sub-agent thread's prose is not emitted and its steps hang off the agent step", () => {
  const mapper = createCodexNotificationMapper();
  mapper.push({ method: "turn/started", params: { threadId: "main", turn: { id: "t1" } } });
  mapper.push({ method: "item/started", params: { threadId: "main", item: { type: "collabAgentToolCall", id: "a1", tool: "spawnAgent", prompt: "Audit", status: "inProgress", receiverThreadIds: [] } } });
  mapper.push({ method: "item/completed", params: { threadId: "main", item: { type: "collabAgentToolCall", id: "a1", tool: "spawnAgent", prompt: "Audit", status: "completed", receiverThreadIds: ["sub"] } } });
  assert.deepEqual(mapper.push({ method: "item/agentMessage/delta", params: { threadId: "sub", itemId: "m", delta: "child prose" } }), []);
  const [child] = mapper.push({ method: "item/started", params: { threadId: "sub", item: { type: "commandExecution", id: "c1", command: "rg roundPrice", cwd: "/w", status: "inProgress", commandActions: [] } } });
  assert.equal(child.parent, "a1");
  mapper.push({ method: "thread/tokenUsage/updated", params: { threadId: "sub", tokenUsage: { total: { totalTokens: 9 }, last: { totalTokens: 9, inputTokens: 8, outputTokens: 1 } } } });
  assert.deepEqual(mapper.push({ method: "turn/completed", params: { threadId: "sub", turn: { status: "completed" } } }), []);
  mapper.push({ method: "thread/tokenUsage/updated", params: { threadId: "main", tokenUsage: { total: { totalTokens: 12 }, last: { totalTokens: 12, inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, reasoningOutputTokens: 1 } } } });
  // A repeated update for the same request is not counted twice.
  mapper.push({ method: "thread/tokenUsage/updated", params: { threadId: "main", tokenUsage: { total: { totalTokens: 12 }, last: { totalTokens: 12, inputTokens: 10, outputTokens: 2 } } } });
  assert.deepEqual(mapper.push({ method: "turn/completed", params: { threadId: "main", turn: { status: "completed" } } }), [
    { type: "usage", inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, reasoningOutputTokens: 1, totalTokens: 12 },
  ]);
});

test("mapper events written through the timeline writer keep the output cap", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "relay-timeline-codex-")), "job.timeline.ndjson");
  const writer = createTimelineWriter({ file });
  const mapper = createCodexNotificationMapper();
  const item = { type: "commandExecution", id: "big", command: "/bin/zsh -lc 'yes'", cwd: "/w", status: "inProgress", commandActions: [] };
  writeTimelineEvents(writer, mapper.push(started(item)));
  writeTimelineEvents(writer, mapper.push({ method: "item/agentMessage/delta", params: { itemId: "m1", delta: "Done." } }));
  writeTimelineEvents(writer, mapper.push(completed({ ...item, status: "completed", exitCode: 0, aggregatedOutput: "y\n".repeat(TIMELINE_CAPS.output) })));
  writeTimelineEvents(writer, [{ type: "usage", inputTokens: 1, outputTokens: 2 }, null, { type: "mystery" }]);
  writer.close();
  const events = readTimeline(file).events.map((entry) => entry.event);
  assert.deepEqual(events.map((event) => event.type), ["step", "text", "step", "usage"]);
  assert.equal(events[2].outputTruncated, true);
  assert.ok(events[2].output.length <= TIMELINE_CAPS.output);
  assert.deepEqual(events[1], { type: "text", id: "m1", delta: "Done." });
});

test("the shell wrapper Codex adds is removed for display, and only when it is unambiguous", () => {
  assert.equal(displayCommand("/bin/zsh -lc 'echo hello-relay && ls'"), "echo hello-relay && ls");
  assert.equal(displayCommand("/bin/zsh -lc false"), "false");
  assert.equal(displayCommand("bash -lc \"echo \\\"hi\\\" $HOME\""), "echo \"hi\" $HOME");
  assert.equal(displayCommand("/bin/sh -c 'it'\\''s fine'"), "it's fine");
  assert.equal(displayCommand(["/bin/zsh", "-lc", "git status"]), "git status");
  assert.equal(displayCommand(["git", "status"]), "git status");
  assert.equal(displayCommand("npm test -- pricing"), "npm test -- pricing");
  // Two words after -lc is not something this reads with certainty.
  assert.equal(displayCommand("/bin/zsh -lc echo hi"), "/bin/zsh -lc echo hi");
  assert.equal(displayCommand("/bin/zsh -lc 'unterminated"), "/bin/zsh -lc 'unterminated");
  assert.equal(readableName("mark_chapter"), "Mark Chapter");
  assert.equal(readableName("contextCompaction"), "Context Compaction");
  assert.equal(readableName(""), "Tool");
});

// ---------------------------------------------------------------------------
// History

function collect(entries) {
  const collector = createCodexTranscriptCollector();
  const groups = [];
  for (const entry of entries) {
    collector.push(entry);
    // The thread reader takes at every message it returns.
    if (entry.type === "response_item" && entry.payload?.type === "message") groups.push(collector.take());
  }
  return { groups, trailing: collector.take(), collector };
}

const line = (type, payload, timestamp = "2026-10-06T07:00:00.000Z") => ({ timestamp, type, payload });

test("a real rollout yields each action once, grouped before the message that followed it", () => {
  const { groups, trailing } = collect(fixture("codex-rollout-edit.ndjson"));
  assert.deepEqual(groups.map((steps) => steps.length), [0, 3]);
  assert.deepEqual(trailing, []);
  const [first, second, edit] = groups[1];
  assert.deepEqual(
    { kind: first.kind, title: first.title, status: first.status, exitCode: first.exitCode, output: first.output, input: first.input },
    { kind: "search", title: "Search", status: "done", exitCode: 0, output: "hello-relay\nnotes.txt\n", input: { command: "echo hello-relay && ls", cwd: "/work/scratch" } },
  );
  assert.equal(first.startedAt, "2026-10-06T07:31:48.249Z");
  assert.deepEqual(
    { kind: second.kind, title: second.title, summary: second.summary, input: second.input, output: second.output },
    { kind: "read", title: "Read", summary: "notes.txt", input: { path: "notes.txt", command: "cat notes.txt", cwd: "/work/scratch" }, output: "status: draft\nowner: relay\n" },
  );
  assert.deepEqual(
    { kind: edit.kind, summary: edit.summary, status: edit.status, input: edit.input },
    { kind: "edit", summary: "notes.txt", status: "done", input: { path: "/work/scratch/notes.txt", diff: "@@ -1,2 +1,2 @@\n-status: draft\n+status: final\n owner: relay\n" } },
  );
  for (const step of groups[1]) assert.equal("type" in step, false);
});

test("a real rollout with a declined command and a failed one", () => {
  const { groups, trailing } = collect(fixture("codex-rollout-approvals.ndjson"));
  assert.deepEqual(trailing, []);
  const steps = groups.flat();
  assert.deepEqual(steps.map((step) => `${step.kind}:${step.status}`), ["tool:done", "command:done", "command:cancelled", "command:failed"]);
  // A script that ran no command has no executed item, so the script itself is the step.
  assert.equal(steps[0].title, "Script");
  assert.equal(steps[0].output, "update_plan is not available.");
  assert.equal(steps[1].output, "tick 1\ntick 2\ntick 3\n");
  // Codex writes no executed item for a declined command; the call is all there is.
  assert.deepEqual({ command: steps[2].input.command, error: steps[2].error, output: steps[2].output }, { command: "touch denied.txt", error: "Declined", output: undefined });
  assert.deepEqual({ exitCode: steps[3].exitCode, command: steps[3].input.command }, { exitCode: 1, command: "false" });
  // The empty reasoning item in this rollout is not a step.
  assert.ok(steps.every((step) => step.kind !== "reasoning"));
});

test("history takes the step kind from parsed_cmd, and an empty search is not a failure", () => {
  const executed = (id, script, parsed_cmd, end) => line("event_msg", {
    type: "item_completed",
    item: { type: "CommandExecution", id, command: ["/bin/zsh", "-lc", script], cwd: "file:///w/app", parsed_cmd, status: "completed", exit_code: 0, aggregated_output: "", ...end },
    started_at_ms: 1791271900000,
    completed_at_ms: 1791271901500,
  });
  const { trailing } = collect([
    executed("h1", "cat src/pricing.ts", [{ type: "read", cmd: "cat src/pricing.ts", name: "pricing.ts", path: "src/pricing.ts" }], { aggregated_output: "export {}\n" }),
    executed("h2", "rg roundPrice src", [{ type: "search", cmd: "rg roundPrice src", query: "roundPrice", path: "src" }], { aggregated_output: "src/a.ts:1\n" }),
    executed("h3", "ls src", [{ type: "list_files", cmd: "ls src", path: "src" }], { aggregated_output: "a.ts\n" }),
    executed("h4", "cat a && rg b", [{ type: "read", cmd: "cat a", name: "a", path: "a" }, { type: "search", cmd: "rg b", query: "b", path: null }], {}),
    executed("h5", "rg nothing", [{ type: "search", cmd: "rg nothing", query: "nothing", path: null }], { status: "failed", exit_code: 1 }),
    executed("h6", "rg '('", [{ type: "search", cmd: "rg '('", query: "(", path: null }], { status: "failed", exit_code: 2 }),
    executed("h7", "grep x missing", [{ type: "search", cmd: "grep x missing", query: "x", path: "missing" }], { status: "failed", exit_code: 1, aggregated_output: "grep: missing: No such file\n" }),
    executed("h8", "false", [{ type: "unknown", cmd: "false" }], { status: "failed", exit_code: 1 }),
  ]);
  const [read, search, listing, two, none, broken, noisy, plain] = trailing;
  assert.deepEqual(
    { kind: read.kind, title: read.title, summary: read.summary, input: read.input, output: read.output },
    { kind: "read", title: "Read", summary: "pricing.ts", input: { path: "src/pricing.ts", command: "cat src/pricing.ts", cwd: "/w/app" }, output: "export {}\n" },
  );
  assert.deepEqual(
    { kind: search.kind, title: search.title, summary: search.summary, input: search.input },
    { kind: "search", title: "Search", summary: "roundPrice", input: { pattern: "roundPrice", path: "src", command: "rg roundPrice src", cwd: "/w/app" } },
  );
  assert.deepEqual({ kind: listing.kind, summary: listing.summary, path: listing.input.path }, { kind: "search", summary: "src", path: "src" });
  assert.deepEqual({ kind: two.kind, title: two.title }, { kind: "command", title: "Bash" });
  assert.deepEqual({ kind: none.kind, status: none.status, exitCode: none.exitCode }, { kind: "search", status: "done", exitCode: 1 });
  assert.deepEqual({ status: broken.status, exitCode: broken.exitCode }, { status: "failed", exitCode: 2 });
  assert.deepEqual({ status: noisy.status, exitCode: noisy.exitCode }, { status: "failed", exitCode: 1 });
  assert.deepEqual({ kind: plain.kind, status: plain.status, exitCode: plain.exitCode }, { kind: "command", status: "failed", exitCode: 1 });
});

// The shapes below are the older rollout dialects (codex-cli 0.142 to 0.147),
// written from the structure of real files with invented content.
test("older rollouts: function calls and their outputs become steps in call order", () => {
  const { groups, trailing } = collect([
    line("event_msg", { type: "task_started", turn_id: "t1" }),
    line("response_item", { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "**Checking** the tests" }], encrypted_content: "x" }),
    line("response_item", { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"npm test\",\"workdir\":\"/w\"}", call_id: "call_1" }, "2026-10-06T07:00:01.000Z"),
    line("response_item", { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"git status\"}", call_id: "call_2" }, "2026-10-06T07:00:01.100Z"),
    line("response_item", { type: "function_call_output", call_id: "call_2", output: "Chunk ID: ab12\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\nclean\n" }, "2026-10-06T07:00:02.000Z"),
    line("response_item", { type: "function_call_output", call_id: "call_1", output: "Chunk ID: cd34\nWall time: 3.0 seconds\nProcess exited with code 1\nOutput:\n1 failing\n" }, "2026-10-06T07:00:04.000Z"),
    line("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "One test fails." }] }),
    line("response_item", { type: "local_shell_call", call_id: "call_3", status: "completed", action: { type: "exec", command: ["bash", "-lc", "ls src"], working_directory: "/w" } }),
    line("response_item", { type: "function_call_output", call_id: "call_3", output: "{\"output\":\"a.js\\n\",\"metadata\":{\"exit_code\":0,\"duration_seconds\":0.1}}" }),
    line("response_item", { type: "function_call", name: "update_plan", arguments: "{\"plan\":[{\"step\":\"Fix rounding\",\"status\":\"in_progress\"},{\"step\":\"Rerun\",\"status\":\"pending\"}]}", call_id: "call_4" }),
    line("response_item", { type: "function_call_output", call_id: "call_4", output: "Plan updated" }),
    line("response_item", { type: "function_call", name: "spawn_agent", namespace: "collaboration", arguments: "{\"task_name\":\"audit_callers\",\"message\":\"Find every caller of roundPrice.\",\"agent_type\":\"explorer\"}", call_id: "call_5" }),
    line("event_msg", { type: "item_completed", item: { type: "SubAgentActivity", id: "call_5", kind: "started", agent_thread_id: "sub", agent_path: "/root/audit_callers" } }),
    line("response_item", { type: "function_call_output", call_id: "call_5", output: "{\"agent_path\":\"/root/audit_callers\"}" }),
    line("response_item", { type: "function_call", name: "view_image", arguments: "{\"path\":\"/w/shot.png\"}", call_id: "call_6" }),
    line("response_item", { type: "function_call_output", call_id: "call_6", output: [{ type: "input_image", image_url: "data:" }] }),
    line("response_item", { type: "function_call", name: "write_stdin", arguments: "{\"session_id\":7,\"chars\":\"q\"}", call_id: "call_7" }),
    line("response_item", { type: "function_call_output", call_id: "call_7", output: "ok" }),
  ]);
  assert.deepEqual(groups[0].map((step) => step.id), ["rs_1", "call_1", "call_2"]);
  const [thought, tests, status] = groups[0];
  assert.deepEqual({ kind: thought.kind, title: thought.title, output: thought.output }, { kind: "reasoning", title: "Thinking", output: "**Checking** the tests" });
  assert.deepEqual(
    { kind: tests.kind, status: tests.status, exitCode: tests.exitCode, output: tests.output, input: tests.input, endedAt: tests.endedAt },
    { kind: "command", status: "failed", exitCode: 1, output: "1 failing\n", input: { command: "npm test", cwd: "/w" }, endedAt: "2026-10-06T07:00:04.000Z" },
  );
  assert.deepEqual({ status: status.status, exitCode: status.exitCode, output: status.output }, { status: "done", exitCode: 0, output: "clean\n" });

  const [shell, plan, agent, image, stdin] = trailing;
  assert.deepEqual({ kind: shell.kind, input: shell.input, exitCode: shell.exitCode, output: shell.output }, { kind: "command", input: { command: "ls src", cwd: "/w" }, exitCode: 0, output: "a.js\n" });
  assert.deepEqual({ kind: plan.kind, summary: plan.summary, items: plan.input.items }, { kind: "todo", summary: "Fix rounding", items: [{ text: "Fix rounding", status: "in_progress" }, { text: "Rerun", status: "pending" }] });
  assert.deepEqual({ kind: agent.kind, title: agent.title, summary: agent.summary, input: agent.input }, {
    kind: "agent", title: "Agent", summary: "audit_callers",
    input: { description: "audit_callers", prompt: "Find every caller of roundPrice.", agentType: "explorer" },
  });
  assert.deepEqual({ kind: image.kind, title: image.title, input: image.input }, { kind: "read", title: "View Image", input: { path: "/w/shot.png" } });
  assert.deepEqual({ kind: stdin.kind, title: stdin.title, name: stdin.input.name }, { kind: "tool", title: "Write Stdin", name: "write_stdin" });
});

test("an executed item replaces the call that produced it", () => {
  const patch = "*** Begin Patch\n*** Add File: /w/new.md\n+hello\n*** End Patch";
  const { trailing } = collect([
    // apply_patch, recorded as a call, as the executed change (same id) and as an output.
    line("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "call_p", input: patch }),
    line("event_msg", { type: "item_completed", item: { type: "FileChange", id: "call_p", status: "completed", changes: { "/w/new.md": { type: "add", content: "hello\n" } } }, completed_at_ms: 1791271901500 }),
    line("response_item", { type: "custom_tool_call_output", call_id: "call_p", output: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess." }),
    // An MCP call: the item carries the result.
    line("response_item", { type: "function_call", name: "js", namespace: "mcp__node_repl", arguments: "{\"code\":\"1+1\"}", call_id: "call_m" }),
    line("event_msg", { type: "item_completed", item: { type: "McpToolCall", id: "call_m", server: "node_repl", tool: "js", arguments: { code: "1+1", title: "Add" }, status: "failed", result: { content: [{ type: "text", text: "Browser is not connected" }], isError: true } } }),
    line("response_item", { type: "function_call_output", call_id: "call_m", output: "Browser is not connected" }),
    // A web search recorded twice under one id, and reasoning recorded twice.
    line("event_msg", { type: "item_completed", item: { type: "WebSearch", id: "ws_1", query: "relay docs", action: { type: "search", query: "relay docs", queries: ["relay docs"] } } }),
    line("response_item", { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "relay docs" } }),
    line("response_item", { type: "web_search_call", id: "ws_2", status: "completed", action: { type: "open_page", url: "https://example.com/a" } }),
    line("event_msg", { type: "item_completed", item: { type: "Reasoning", id: "item-3", summary_text: ["**Deciding** next"], raw_content: [] }, completed_at_ms: 1791271901500 }),
    line("response_item", { type: "reasoning", id: "rs_9", summary: [{ type: "summary_text", text: "**Deciding** next" }] }),
    line("event_msg", { type: "item_completed", item: { type: "Extension", kind: "web.search", id: "exec-1", query: "codex", action: { type: "search", query: null, queries: ["codex"] }, results: [] } }),
    line("event_msg", { type: "item_completed", item: { type: "AgentMessage", id: "msg_1", content: [{ type: "Text", text: "hi" }] } }),
    // An apply_patch with no executed item falls back to the patch itself.
    line("response_item", { type: "custom_tool_call", name: "apply_patch", call_id: "call_q", input: "*** Begin Patch\n*** Update File: /w/a.js\n@@\n-a\n+b\n*** End Patch" }),
    line("response_item", { type: "custom_tool_call_output", call_id: "call_q", output: "Success." }),
  ]);
  assert.deepEqual(trailing.map((step) => step.id), ["call_p", "call_m", "ws_1", "ws_2", "item-3", "exec-1", "call_q"]);
  const [write, mcp, search, page, thought, extension, edit] = trailing;
  assert.deepEqual({ kind: write.kind, title: write.title, input: write.input, endedAt: write.endedAt }, { kind: "write", title: "Write", input: { path: "/w/new.md", diff: "+hello\n" }, endedAt: "2026-10-06T07:31:41.500Z" });
  assert.deepEqual(
    { kind: mcp.kind, title: mcp.title, summary: mcp.summary, status: mcp.status, output: mcp.output, server: mcp.input.server },
    { kind: "tool", title: "Js", summary: "Add", status: "failed", output: "Browser is not connected", server: "node_repl" },
  );
  assert.deepEqual({ kind: search.kind, summary: search.summary }, { kind: "fetch", summary: "relay docs" });
  assert.deepEqual({ title: page.title, summary: page.summary, input: page.input }, { title: "Web Page", summary: "example.com", input: { url: "https://example.com/a" } });
  assert.equal(thought.output, "**Deciding** next");
  assert.deepEqual({ kind: extension.kind, summary: extension.summary }, { kind: "fetch", summary: "codex" });
  assert.deepEqual({ kind: edit.kind, summary: edit.summary, path: edit.input.path }, { kind: "edit", summary: "a.js", path: "/w/a.js" });
});

test("take() clears what it returned, holds unanswered calls, and a turn's end cancels them", () => {
  const collector = createCodexTranscriptCollector();
  collector.push(line("response_item", { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"sleep 100\"}", call_id: "call_1" }));
  collector.push(line("response_item", { type: "function_call", name: "exec_command", arguments: "{\"cmd\":\"ls\"}", call_id: "call_2" }));
  collector.push(line("response_item", { type: "function_call_output", call_id: "call_2", output: "a\n" }));
  assert.deepEqual(collector.take().map((step) => step.id), ["call_2"]);
  assert.deepEqual(collector.take(), []);
  collector.push(line("event_msg", { type: "turn_aborted", reason: "interrupted" }));
  const [aborted] = collector.take();
  assert.deepEqual({ id: aborted.id, status: aborted.status, command: aborted.input.command }, { id: "call_1", status: "cancelled", command: "sleep 100" });
  // Lines that are not part of the record are ignored.
  for (const junk of [null, "text", {}, { type: "session_meta", payload: {} }, { type: "response_item", payload: { type: "function_call_output", call_id: "nobody", output: "x" } }]) collector.push(junk);
  assert.deepEqual(collector.take(), []);
});

test("history output is capped at the history limit, keeping head and tail", () => {
  const { trailing } = collect([
    line("event_msg", { type: "item_completed", item: { type: "CommandExecution", id: "exec-big", command: ["/bin/zsh", "-lc", "cat big.log"], cwd: "file:///w", parsed_cmd: [], status: "completed", aggregated_output: `HEAD\n${"x".repeat(3 * TIMELINE_CAPS.historyOutput)}\nTAIL`, exit_code: 0 }, started_at_ms: 1791271900000, completed_at_ms: 1791271901500 }),
    line("response_item", { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: `echo ${"y".repeat(3 * TIMELINE_CAPS.inputField)}` }), call_id: "call_long" }),
    line("response_item", { type: "function_call_output", call_id: "call_long", output: "ok" }),
  ]);
  const [big, long] = trailing;
  assert.equal(big.outputTruncated, true);
  assert.ok(big.output.length <= TIMELINE_CAPS.historyOutput);
  assert.ok(big.output.startsWith("HEAD\n") && big.output.endsWith("\nTAIL"));
  assert.equal(big.input.cwd, "/w");
  assert.ok(long.input.command.length <= TIMELINE_CAPS.inputField);
  assert.ok(long.summary.length <= TIMELINE_CAPS.summary);
  assert.equal(long.outputTruncated, undefined);
});
