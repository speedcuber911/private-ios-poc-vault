import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createClaudeStreamMapper,
  createClaudeTranscriptCollector,
  describeClaudeTool,
  legacyStepLine,
} from "../src/timeline-claude.mjs";
import { TIMELINE_CAPS } from "../src/timeline.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, "fixtures", name);

// The stream fixtures are recordings of Claude Code 2.1.280 run with
// `--print --output-format stream-json --verbose --include-partial-messages`,
// trimmed (bulky bookkeeping fields and rate-limit lines dropped) and sanitised
// (home directory, working directory and session id replaced; tool-input JSON
// deltas re-cut so no path straddles a chunk). Line order is as recorded.
function readJsonLines(file) {
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function mapAll(lines, { partial = true } = {}) {
  const mapper = createClaudeStreamMapper({ now: () => "2026-10-06T07:00:00.000Z" });
  const events = [];
  for (const line of lines) {
    if (!partial && line.type === "stream_event") continue;
    events.push(...mapper.push(line));
  }
  return { mapper, events };
}

// What a reader ends up holding: the block sequence (prose, then runs of
// top-level steps) and every step's merged fields. This is the reduction the
// spec describes under 1.2.
function reduce(events) {
  const steps = new Map();
  const blocks = [];
  let usage = null;
  for (const event of events) {
    if (event.type === "text") {
      const last = blocks.at(-1);
      if (last?.type === "prose" && last.id === event.id) last.text += event.delta;
      else blocks.push({ type: "prose", id: event.id, text: event.delta });
    } else if (event.type === "step") {
      const { type: _type, ...fields } = event;
      if (!steps.has(event.id)) {
        steps.set(event.id, { children: [] });
        if (fields.parent) {
          steps.get(fields.parent).children.push(event.id);
        } else {
          const last = blocks.at(-1);
          if (last?.type === "steps") last.ids.push(event.id);
          else blocks.push({ type: "steps", ids: [event.id] });
        }
      }
      Object.assign(steps.get(event.id), fields);
    } else if (event.type === "step.delta") {
      const step = steps.get(event.id);
      step.output = (step.output || "") + event.output;
    } else if (event.type === "usage") {
      usage = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    }
  }
  return { blocks, steps, usage };
}

function assistant(content, extra = {}) {
  return { type: "assistant", message: { id: `msg_${Math.random()}`, role: "assistant", content }, parent_tool_use_id: null, ...extra };
}

function toolResult(id, content, extra = {}, lineExtra = {}) {
  return {
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...extra }] },
    parent_tool_use_id: null,
    ...lineExtra,
  };
}

// A Claude Code run that does what the spec's canonical example describes.
const canonicalRun = [
  { type: "system", subtype: "init", cwd: "/work/app", session_id: "11111111-1111-4111-8111-111111111111" },
  assistant([{ type: "thinking", thinking: "The rounding bug is probably in the tax line.", signature: "sig" }]),
  assistant([{ type: "text", text: "I'll look at the pricing module and run its tests." }]),
  assistant([{ type: "tool_use", id: "tu_read", name: "Read", input: { file_path: "/work/app/src/pricing.ts" } }]),
  toolResult("tu_read", "1\texport function roundPrice…"),
  assistant([{ type: "tool_use", id: "tu_test", name: "Bash", input: { command: "npm test -- pricing", description: "Run the pricing tests" } }]),
  toolResult("tu_test", "Exit code 1\nFAIL rounds half up\n1 failing\n", { is_error: true }),
  assistant([{ type: "text", text: "One test fails. Fixing the rounding and asking a sub-agent to audit the other callers." }]),
  assistant([{
    type: "tool_use",
    id: "tu_edit",
    name: "Edit",
    input: {
      file_path: "/work/app/src/pricing.ts",
      old_string: "  return Math.floor(total * 100) / 100",
      new_string: "  return Math.round(total * 100) / 100",
    },
  }]),
  toolResult("tu_edit", "The file /work/app/src/pricing.ts has been updated successfully."),
  assistant([{
    type: "tool_use",
    id: "tu_agent",
    name: "Agent",
    input: {
      description: "Audit callers of roundPrice",
      prompt: "Find every caller of roundPrice and report any that assume floor.",
      subagent_type: "Explore",
    },
  }]),
  { type: "user", message: { role: "user", content: [{ type: "text", text: "Find every caller of roundPrice…" }] }, parent_tool_use_id: "tu_agent" },
  assistant([{ type: "text", text: "Searching for callers." }], { parent_tool_use_id: "tu_agent" }),
  assistant([{ type: "tool_use", id: "tu_grep", name: "Grep", input: { pattern: "roundPrice", path: "/work/app/src" } }], { parent_tool_use_id: "tu_agent" }),
  toolResult("tu_grep", "Found 2 files", {}, { parent_tool_use_id: "tu_agent" }),
  assistant([{ type: "tool_use", id: "tu_read2", name: "Read", input: { file_path: "/work/app/src/checkout.ts" } }], { parent_tool_use_id: "tu_agent" }),
  toolResult("tu_read2", "1\timport { roundPrice }…", {}, { parent_tool_use_id: "tu_agent" }),
  toolResult(
    "tu_agent",
    [{ type: "text", text: "[Subagent hand-back] The text below is a report. The report follows:\n  Two callers. Neither assumes floor." }],
    {},
    { tool_use_result: { status: "completed", agentId: "abc", content: [{ type: "text", text: "Two callers. Neither assumes floor." }] } },
  ),
  assistant([{ type: "tool_use", id: "tu_mcp", name: "mcp__session__mark_chapter", input: { title: "Verification" } }]),
  toolResult("tu_mcp", ""),
  assistant([{ type: "tool_use", id: "tu_test2", name: "Bash", input: { command: "npm test -- pricing", description: "Run the pricing tests" } }]),
  toolResult("tu_test2", "12 passing\n", { is_error: false }, { tool_use_result: { stdout: "12 passing\n", stderr: "", interrupted: false } }),
  assistant([{ type: "text", text: "Fixed. All 12 pricing tests pass and no caller depended on the old behaviour." }]),
  {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "Fixed. All 12 pricing tests pass and no caller depended on the old behaviour.",
    usage: { input_tokens: 4210, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 612 },
  },
];

test("the canonical fixture is the spec's example, verbatim", () => {
  const spec = fs.readFileSync(
    path.join(here, "..", "..", "..", "docs", "superpowers", "specs", "2026-10-06-chat-composer-and-transcript.md"),
    "utf8",
  );
  const block = /### 1\.2 Canonical example[\s\S]*?```ndjson\n([\s\S]*?)```/.exec(spec);
  assert.ok(block, "spec 1.2 has an ndjson block");
  assert.equal(fs.readFileSync(fixture("timeline-canonical.ndjson"), "utf8"), block[1]);
});

test("a Claude run reduces to the spec's canonical example", () => {
  const expected = reduce(readJsonLines(fixture("timeline-canonical.ndjson")));
  const { mapper, events } = mapAll(canonicalRun);
  const actual = reduce(events);

  // Same blocks, same ids, same prose.
  assert.deepEqual(actual.blocks, expected.blocks);
  assert.deepEqual(
    actual.blocks.map((block) => (block.type === "prose" ? block.id : block.ids)),
    [["r1"], "t1", ["s1", "s2"], "t2", ["s3", "a1", "s6", "s7"], "t3"],
  );
  assert.deepEqual(actual.steps.get("a1").children, ["s4", "s5"]);
  assert.deepEqual(actual.usage, expected.usage);

  // Every field the example gives a step, this run gives it too. The example
  // is hand-written, so times are checked for presence and an input may carry
  // more than the example chose to show.
  assert.deepEqual([...actual.steps.keys()], [...expected.steps.keys()]);
  for (const [id, want] of expected.steps) {
    const got = actual.steps.get(id);
    for (const [field, value] of Object.entries(want)) {
      if (field === "startedAt" || field === "endedAt") {
        assert.equal(typeof got[field], "string", `${id}.${field}`);
      } else if (field === "input") {
        for (const [key, inner] of Object.entries(value)) assert.deepEqual(got.input[key], inner, `${id}.input.${key}`);
      } else {
        assert.deepEqual(got[field], value, `${id}.${field}`);
      }
    }
    // A search's matches are extra detail the example leaves out; nothing
    // else may appear that the example does not have.
    for (const field of ["error", "exitCode", "parent"]) {
      if (!(field in want)) assert.equal(got[field], undefined, `${id}.${field} should be absent`);
    }
  }
  assert.equal(mapper.finalAnswer(), "Fixed. All 12 pricing tests pass and no caller depended on the old behaviour.");
});

test("a recorded stream maps to prose, steps and a nested sub-agent", () => {
  const lines = readJsonLines(fixture("claude-stream-agent.jsonl"));
  const { mapper, events } = mapAll(lines);
  const state = reduce(events);

  assert.deepEqual(
    state.blocks.map((block) => (block.type === "prose" ? block.id : block.ids)),
    [["r1"], "t1", ["s1", "s2", "r2", "a1"], "t2"],
  );
  assert.equal(state.blocks[1].text, "I'll run the command, read the checklist, and then delegate the facts.txt lookup.");
  assert.equal(state.blocks[3].text, mapper.finalAnswer());
  assert.match(mapper.finalAnswer(), /codename as "ember"\.$/);
  assert.equal(mapper.sessionId(), "00000000-0000-4000-8000-000000000001");

  // Prose streams: the first block arrived in more than one delta.
  assert.ok(events.filter((event) => event.type === "text" && event.id === "t1").length > 1);

  const bash = state.steps.get("s1");
  assert.equal(bash.kind, "command");
  assert.equal(bash.title, "Bash");
  assert.equal(bash.summary, "Echo probe string");
  assert.deepEqual(bash.input, { command: "echo relay-timeline-probe", description: "Echo probe string", cwd: "/work/demo" });
  assert.equal(bash.status, "done");
  assert.equal(bash.exitCode, 0);
  assert.equal(bash.output, "relay-timeline-probe");

  const read = state.steps.get("s2");
  assert.deepEqual([read.kind, read.summary, read.status], ["read", "checklist.txt", "done"]);
  assert.equal(read.output, undefined);

  const agent = state.steps.get("a1");
  assert.equal(agent.kind, "agent");
  assert.equal(agent.title, "Agent");
  assert.equal(agent.summary, "Look up codename in facts.txt");
  assert.equal(agent.input.agentType, "Explore");
  assert.match(agent.input.prompt, /facts\.txt/);
  assert.equal(agent.status, "done");
  assert.equal(agent.output, "The codename is **ember**.");
  assert.deepEqual(agent.children, ["s3"]);

  const child = state.steps.get("s3");
  assert.equal(child.parent, "a1");
  assert.deepEqual([child.kind, child.summary, child.status], ["read", "facts.txt", "done"]);

  // A step opens as soon as its block starts, before its input is known.
  const firstBash = events.find((event) => event.type === "step" && event.id === "s1");
  assert.deepEqual(Object.keys(firstBash).sort(), ["id", "kind", "startedAt", "status", "title", "type"]);
  assert.equal(firstBash.status, "running");

  // The sub-agent's own prose never reaches the timeline.
  assert.equal(events.some((event) => event.type === "text" && /The codename is/.test(event.delta)), false);
  assert.deepEqual(state.usage, { inputTokens: 112112, outputTokens: 548 });
});

test("the mapper gives the same result without partial stream events", () => {
  for (const name of ["claude-stream-agent.jsonl", "claude-stream-edit.jsonl"]) {
    const lines = readJsonLines(fixture(name));
    const withPartials = reduce(mapAll(lines).events);
    const without = reduce(mapAll(lines, { partial: false }).events);
    assert.deepEqual(without.blocks, withPartials.blocks, name);
    assert.deepEqual([...without.steps.keys()], [...withPartials.steps.keys()], name);
    for (const [id, step] of withPartials.steps) {
      const { startedAt: _a, endedAt: _b, ...want } = step;
      const { startedAt: _c, endedAt: _d, ...got } = without.steps.get(id);
      assert.deepEqual(got, want, `${name} ${id}`);
    }
  }
});

test("a recorded stream maps edits, writes, searches, to-dos and a refused command", () => {
  const { events } = mapAll(readJsonLines(fixture("claude-stream-edit.jsonl")));
  const state = reduce(events);
  const byTitle = (title) => [...state.steps.values()].filter((step) => step.title === title);

  const [search] = byTitle("ToolSearch");
  assert.equal(search.kind, "tool");
  assert.deepEqual(search.input, { name: "ToolSearch", json: '{"query":"select:TaskCreate","max_results":3}' });

  const todos = byTitle("TaskCreate");
  assert.equal(todos.length, 2);
  assert.equal(todos[0].kind, "todo");
  assert.deepEqual(todos[0].input, { items: [{ text: 'Probe filesystem and search for "rate"', status: "pending" }] });

  const [bash] = byTitle("Bash");
  assert.equal(bash.status, "failed");
  assert.match(bash.error, /was blocked/);
  assert.equal(bash.exitCode, undefined);

  const [grep] = byTitle("Grep");
  assert.deepEqual([grep.kind, grep.summary, grep.output], ["search", "rate", "Found 1 file\nconfig.js"]);

  const [edit] = byTitle("Edit");
  assert.equal(edit.kind, "edit");
  assert.equal(edit.summary, "config.js");
  assert.equal(edit.input.path, "/work/demo/config.js");
  // The result's patch, with its context line, replaces the first guess.
  assert.equal(
    edit.input.diff,
    '@@ -1,2 +1,2 @@\n-export const rate = 0.18;\n+export const rate = 0.2;\n export const name = "relay";',
  );
  const firstEditInput = events.find((event) => event.type === "step" && event.id === edit.id && event.input);
  assert.equal(firstEditInput.input.diff, "-export const rate = 0.18;\n+export const rate = 0.2;");

  const [write] = byTitle("Write");
  assert.equal(write.kind, "write");
  assert.equal(write.summary, "notes.md");
  assert.match(write.input.diff, /^\+Rate updated from 0\.18 to 0\.2\.\n\+/);

  for (const step of state.steps.values()) assert.notEqual(step.status, "running");
});

test("tool names map to kinds, titles and summaries", () => {
  const kind = (name, input = {}) => describeClaudeTool(name, input).kind;
  assert.equal(kind("Bash"), "command");
  assert.equal(kind("Read"), "read");
  for (const name of ["Edit", "MultiEdit", "NotebookEdit"]) assert.equal(kind(name), "edit");
  assert.equal(kind("Write"), "write");
  for (const name of ["Grep", "Glob", "LS"]) assert.equal(kind(name), "search");
  for (const name of ["WebFetch", "WebSearch"]) assert.equal(kind(name), "fetch");
  for (const name of ["Task", "Agent"]) assert.equal(kind(name), "agent");
  assert.equal(kind("TodoWrite"), "todo");
  assert.equal(kind("SomethingNew"), "tool");

  assert.equal(describeClaudeTool("Bash", { command: "npm ci\nnpm test" }).summary, "npm ci");
  assert.equal(describeClaudeTool("Bash", { command: "sleep 100", run_in_background: true }).input.background, true);
  assert.deepEqual(describeClaudeTool("Read", { file_path: "/a/b.ts", offset: 10, limit: 20 }).input, { path: "/a/b.ts", range: "10-29" });
  assert.equal(describeClaudeTool("WebFetch", { url: "https://example.com/docs/page" }).summary, "example.com");
  assert.equal(describeClaudeTool("WebSearch", { query: "node readline" }).summary, "node readline");
  assert.equal(describeClaudeTool("Task", { description: "Audit", prompt: "Look" }).title, "Agent");

  const mcp = describeClaudeTool("mcp__ccd_session__mark_chapter", { title: "Verification" });
  assert.deepEqual(mcp, {
    kind: "tool",
    title: "Mark Chapter",
    summary: undefined,
    input: { name: "mark_chapter", server: "ccd_session", json: '{"title":"Verification"}' },
  });

  const todo = describeClaudeTool("TodoWrite", {
    todos: [
      { content: "Write tests", status: "completed", activeForm: "Writing tests" },
      { content: "Ship", status: "in_progress", activeForm: "Shipping" },
    ],
  });
  assert.deepEqual(todo.input.items, [{ text: "Write tests", status: "completed" }, { text: "Ship", status: "in_progress" }]);

  assert.equal(legacyStepLine({ kind: "command", input: { command: "npm test" } }), "Running npm test");
  assert.equal(legacyStepLine({ kind: "read", input: { path: "a.ts" } }), "Reading a.ts");
  assert.equal(legacyStepLine({ kind: "edit", input: { path: "a.ts" } }), "Editing a.ts");
  assert.equal(legacyStepLine({ kind: "search", input: { pattern: "roundPrice" } }), "Searching roundPrice");
  assert.equal(legacyStepLine({ kind: "reasoning" }), "");
});

test("an error result is not a final answer", () => {
  const mapper = createClaudeStreamMapper();
  mapper.push({ type: "result", subtype: "error_during_execution", is_error: true, result: "Credit balance is too low" });
  assert.equal(mapper.finalAnswer(), "");
  assert.deepEqual(mapper.outcome(), {
    isError: true,
    subtype: "error_during_execution",
    text: "Credit balance is too low",
    sessionId: "",
  });
});

test("thinking that carries text streams as reasoning deltas", () => {
  const mapper = createClaudeStreamMapper({ now: () => "T" });
  const stream = (event) => mapper.push({ type: "stream_event", event, parent_tool_use_id: null });
  const events = [
    ...stream({ type: "message_start", message: { id: "m1" } }),
    ...stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    ...stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check the " } }),
    ...stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "tax line." } }),
    ...mapper.push({ type: "assistant", message: { id: "m1", content: [{ type: "thinking", thinking: "Check the tax line." }] }, parent_tool_use_id: null }),
    ...stream({ type: "content_block_stop", index: 0 }),
  ];
  assert.deepEqual(events, [
    { type: "step", id: "r1", kind: "reasoning", title: "Thinking", status: "running", startedAt: "T" },
    { type: "step.delta", id: "r1", output: "Check the " },
    { type: "step.delta", id: "r1", output: "tax line." },
    { type: "step", id: "r1", status: "done", endedAt: "T" },
  ]);
});

function collect(dir, sessionId) {
  const readSidechain = (agentId) => {
    try {
      return readJsonLines(path.join(dir, sessionId, "subagents", `agent-${agentId}.jsonl`));
    } catch {
      return [];
    }
  };
  return createClaudeTranscriptCollector({ readSidechain });
}

test("a session transcript yields complete history steps with the sub-agent's nested", () => {
  const dir = fixture("claude-transcript");
  const sessionId = "00000000-0000-4000-8000-000000000001";
  const collector = collect(dir, sessionId);
  for (const entry of readJsonLines(path.join(dir, `${sessionId}.jsonl`))) collector.push(entry);
  const steps = collector.take({ final: true });

  assert.deepEqual(steps.map((step) => [step.kind, step.title, step.status, step.parent ? "child" : "top"]), [
    ["reasoning", "Thinking", "done", "top"],
    ["command", "Bash", "done", "top"],
    ["read", "Read", "done", "top"],
    ["reasoning", "Thinking", "done", "top"],
    ["agent", "Agent", "done", "top"],
    ["read", "Read", "done", "child"],
  ]);
  for (const step of steps) {
    assert.equal(step.type, "step");
    assert.equal(typeof step.id, "string");
    assert.equal(typeof step.startedAt, "string");
    assert.equal(typeof step.endedAt, "string");
  }
  assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);

  const [, bash, read, , agent, child] = steps;
  assert.equal(bash.summary, "Echo probe string");
  assert.equal(bash.output, "relay-timeline-probe");
  assert.equal(bash.exitCode, 0);
  assert.equal(bash.input.cwd, "/work/demo");
  assert.equal(read.summary, "checklist.txt");
  assert.equal(agent.summary, "Look up codename in facts.txt");
  assert.equal(agent.output, "The codename is **ember**.");
  assert.equal(child.parent, agent.id);
  assert.equal(child.summary, "facts.txt");

  assert.deepEqual(collector.take({ final: true }), []);
});

test("history holds a step back until its result arrives, and caps its output", () => {
  const collector = createClaudeTranscriptCollector();
  const at = "2026-10-06T07:00:00.000Z";
  collector.push({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "seq 1 100000" } }] } });
  assert.deepEqual(collector.take(), []);
  collector.push({
    type: "user",
    timestamp: at,
    message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "x".repeat(TIMELINE_CAPS.historyOutput * 3) }] },
  });
  const [step] = collector.take();
  assert.equal(step.status, "done");
  assert.equal(step.output.length, TIMELINE_CAPS.historyOutput);
  assert.equal(step.outputTruncated, true);
  assert.deepEqual(collector.take(), []);

  // A step with no result is cut short by the next prompt, and still open at
  // the end of the file otherwise.
  collector.push({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "tu2", name: "Read", input: { file_path: "a.ts" } }] } });
  collector.push({ type: "user", timestamp: at, message: { content: "carry on" } });
  assert.deepEqual(collector.take().map((item) => [item.id, item.status]), [["tu2", "cancelled"]]);
  collector.push({ type: "assistant", timestamp: at, message: { content: [{ type: "tool_use", id: "tu3", name: "Read", input: { file_path: "b.ts" } }] } });
  assert.deepEqual(collector.take(), []);
  assert.deepEqual(collector.take({ final: true }).map((item) => [item.id, item.status]), [["tu3", "running"]]);
});
