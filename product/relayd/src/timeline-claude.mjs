// relayd timeline-claude.mjs — turns Claude Code's messages into timeline events.
// Two sources share one mapping: the live `--output-format stream-json` stream of
// a running job, and the session transcript on disk (thread history).
//
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 1.
//
// The shapes handled here were recorded from Claude Code 2.1.280 (see
// test/fixtures/claude-stream-*.jsonl). What that recording established:
//   - with --include-partial-messages, top-level content arrives twice: as
//     `stream_event` deltas, then as one complete `assistant` line per content
//     block, which lands BEFORE that block's `content_block_stop`;
//   - a sub-agent's work arrives only as complete `assistant`/`user` lines whose
//     `parent_tool_use_id` is the Agent tool's id, never as stream events;
//   - `thinking` blocks carry a signature and usually no text;
//   - a tool's result is a `user` line holding a `tool_result` block, with the
//     harness's structured copy beside it (`tool_use_result` live,
//     `toolUseResult` in the transcript);
//   - the sub-agent tool is named `Agent` (older builds: `Task`), and the to-do
//     tool is `TaskCreate`/`TaskUpdate` (older builds: `TodoWrite`).
import path from "node:path";

import { TIMELINE_CAPS, clipText } from "./timeline.mjs";

const BUILTIN_KINDS = Object.freeze({
  Bash: "command",
  Read: "read",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Write: "write",
  Grep: "search",
  Glob: "search",
  LS: "search",
  WebFetch: "fetch",
  WebSearch: "fetch",
  Task: "agent",
  Agent: "agent",
  TodoWrite: "todo",
  TaskCreate: "todo",
  TaskUpdate: "todo",
});

function str(value) {
  return typeof value === "string" ? value : "";
}

function firstLine(value) {
  return str(value).split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function baseName(value) {
  const clean = str(value).replace(/[\\/]+$/, "");
  return clean ? path.basename(clean) : "";
}

function prefixLines(text, prefix) {
  if (!text) return "";
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  return body.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function editDiff(oldText, newText) {
  return [prefixLines(str(oldText), "-"), prefixLines(str(newText), "+")].filter(Boolean).join("\n");
}

// "mark_chapter" and "mark-chapter" both read "Mark Chapter".
function readableToolName(name) {
  return str(name)
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function urlHost(value) {
  try {
    return new URL(str(value)).host;
  } catch {
    return "";
  }
}

function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value === undefined || value === null || value === "") continue;
    out[key] = value;
  }
  return out;
}

function safeJson(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function readRange(input) {
  const offset = Number.isInteger(input.offset) ? input.offset : null;
  const limit = Number.isInteger(input.limit) ? input.limit : null;
  if (offset !== null && limit !== null) return `${offset}-${offset + limit - 1}`;
  if (offset !== null) return `${offset}-`;
  if (limit !== null) return `1-${limit}`;
  return "";
}

function todoItems(name, input) {
  if (name === "TodoWrite") {
    return (Array.isArray(input.todos) ? input.todos : [])
      .filter((item) => item && typeof item === "object")
      .map((item) => ({ text: str(item.content) || str(item.activeForm), status: str(item.status) || "pending" }))
      .filter((item) => item.text);
  }
  const text = str(input.subject) || (input.taskId !== undefined ? `Task ${input.taskId}` : "");
  if (!text) return [];
  return [{ text, status: str(input.status) || "pending" }];
}

// The static half of a step: what a tool call is, from its name and input.
// Returns { kind, title, summary?, input }.
export function describeClaudeTool(name, rawInput, { cwd = "" } = {}) {
  const toolName = str(name) || "Tool";
  const input = rawInput && typeof rawInput === "object" && !Array.isArray(rawInput) ? rawInput : {};
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
  if (mcp) {
    return {
      kind: "tool",
      title: readableToolName(mcp[2]) || toolName,
      summary: str(input.description) || str(input.query) || str(input.subject) || undefined,
      input: compact({ name: mcp[2], server: mcp[1], json: safeJson(input) }),
    };
  }
  const kind = BUILTIN_KINDS[toolName] || "tool";
  switch (kind) {
    case "command": {
      const command = str(input.command);
      return {
        kind,
        title: toolName,
        summary: str(input.description) || firstLine(command) || undefined,
        input: compact({
          command,
          description: str(input.description),
          cwd,
          background: input.run_in_background === true ? true : undefined,
        }),
      };
    }
    case "read": {
      const file = str(input.file_path) || str(input.notebook_path) || str(input.path);
      return {
        kind,
        title: toolName,
        summary: baseName(file) || undefined,
        input: compact({ path: file, range: readRange(input) }),
      };
    }
    case "edit": {
      const file = str(input.file_path) || str(input.notebook_path);
      let diff = "";
      if (Array.isArray(input.edits)) {
        diff = input.edits
          .filter((edit) => edit && typeof edit === "object")
          .map((edit) => editDiff(edit.old_string, edit.new_string))
          .filter(Boolean)
          .join("\n");
      } else if (toolName === "NotebookEdit") {
        diff = prefixLines(str(input.new_source), "+");
      } else {
        diff = editDiff(input.old_string, input.new_string);
      }
      return { kind, title: toolName, summary: baseName(file) || undefined, input: compact({ path: file, diff }) };
    }
    case "write": {
      const file = str(input.file_path);
      return {
        kind,
        title: toolName,
        summary: baseName(file) || undefined,
        input: compact({ path: file, diff: prefixLines(str(input.content), "+") }),
      };
    }
    case "search": {
      const pattern = str(input.pattern);
      const where = str(input.path);
      return {
        kind,
        title: toolName,
        summary: pattern || baseName(where) || undefined,
        input: compact({ pattern, path: where }),
      };
    }
    case "fetch": {
      const url = str(input.url);
      const query = str(input.query);
      return {
        kind,
        title: toolName,
        summary: urlHost(url) || query || url || undefined,
        input: compact({ url, query }),
      };
    }
    case "agent": {
      return {
        kind,
        title: "Agent",
        summary: str(input.description) || firstLine(input.prompt) || undefined,
        input: compact({
          description: str(input.description),
          prompt: str(input.prompt),
          agentType: str(input.subagent_type),
        }),
      };
    }
    case "todo": {
      const items = todoItems(toolName, input);
      const active = items.find((item) => item.status === "in_progress") || items[0];
      const summary = items.length > 1 ? `${items.length} to-dos` : active?.text;
      return { kind, title: toolName, summary: summary || undefined, input: { items } };
    }
    default:
      return {
        kind: "tool",
        title: toolName,
        summary: str(input.description) || str(input.query) || str(input.subject) || undefined,
        input: compact({ name: toolName, json: safeJson(input) }),
      };
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : part && part.type === "text" ? str(part.text) : ""))
    .filter(Boolean)
    .join("\n");
}

// Claude Code frames a sub-agent's report with a provenance note and indents
// the report itself by two spaces. The phone wants the report.
function stripAgentHandBack(text) {
  const match = /^\[Subagent hand-back\][\s\S]*?The report follows:\n/.exec(text);
  if (!match) return text;
  return text.slice(match[0].length).split("\n").map((line) => line.replace(/^ {2}/, "")).join("\n");
}

function patchDiff(structuredPatch) {
  if (!Array.isArray(structuredPatch) || structuredPatch.length === 0) return "";
  return structuredPatch
    .filter((hunk) => hunk && Array.isArray(hunk.lines))
    .map((hunk) => [
      `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      ...hunk.lines.map((line) => str(line)),
    ].join("\n"))
    .join("\n");
}

// The dynamic half: what a `tool_result` block says about the step it closes.
// `tool` is { kind, input } as built by describeClaudeTool; `structured` is the
// harness's structured copy of the result, when the source carries one.
// Returns the fields to merge into the step.
export function describeClaudeToolResult(tool, block, structured) {
  const failed = block?.is_error === true;
  const text = contentText(block?.content);
  const fields = { status: failed ? "failed" : "done" };
  const detail = structured && typeof structured === "object" && !Array.isArray(structured) ? structured : null;

  if (tool.kind === "command") {
    let output = text;
    const exit = failed ? /^Exit code (\d+)\n?/.exec(text) : null;
    if (exit) {
      fields.exitCode = Number(exit[1]);
      output = text.slice(exit[0].length);
    } else if (failed) {
      fields.error = clipText(firstLine(text), TIMELINE_CAPS.summary).text || "Command failed";
    } else if (tool.input?.background !== true && detail && typeof detail.stdout === "string") {
      // A foreground command that returned without is_error exited 0; Claude
      // Code reports any other exit as an error result.
      fields.exitCode = 0;
    }
    // A one-line failure is already the error; do not say it twice.
    if (output && output.trim() !== fields.error) fields.output = output;
    return fields;
  }

  if (tool.kind === "agent") {
    const report = detail && Array.isArray(detail.content) ? contentText(detail.content) : "";
    const output = report || stripAgentHandBack(text);
    if (output) fields.output = output;
    if (failed) fields.error = clipText(firstLine(text), TIMELINE_CAPS.summary).text || "Agent failed";
    return fields;
  }

  if (failed) fields.error = clipText(firstLine(text), TIMELINE_CAPS.summary).text || "Tool failed";

  if (tool.kind === "edit" || tool.kind === "write") {
    const diff = patchDiff(detail?.structuredPatch);
    if (diff) fields.input = { ...(tool.input || {}), diff };
    return fields;
  }
  if (tool.kind === "search" || tool.kind === "fetch" || tool.kind === "tool") {
    if (text) fields.output = text;
  }
  return fields;
}

// The `[relay-step]` line an old phone shows for a step, or "" for none. Same
// vocabulary the Codex runner uses.
export function legacyStepLine(step) {
  const input = step?.input || {};
  switch (step?.kind) {
    case "command": return `Running ${firstLine(input.command) || "command"}`;
    case "read": return `Reading ${input.path || "a file"}`;
    case "edit": return `Editing ${input.path || "a file"}`;
    case "write": return `Writing ${input.path || "a file"}`;
    case "search": return `Searching ${input.pattern || input.path || "the workspace"}`;
    case "fetch": return `Fetching ${input.url || input.query || "the web"}`;
    case "agent": return `Agent: ${input.description || firstLine(input.prompt) || "sub-agent"}`;
    case "todo": return "Updating to-dos";
    case "tool": return `Using ${step.title || input.name || "a tool"}`;
    default: return "";
  }
}

function isoTimestamp(value, fallback) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  return fallback();
}

// Live. Feed every parsed stream-json line in order; each call returns the
// timeline events (spec 1.1 shapes) that line produces. Works with or without
// partial `stream_event` lines.
export function createClaudeStreamMapper({ now = () => new Date().toISOString() } = {}) {
  const counters = { r: 0, s: 0, a: 0, t: 0 };
  // tool_use id -> { id, kind, input, described }
  const tools = new Map();
  // Assistant message ids whose text and thinking already arrived as deltas.
  const streamedMessages = new Set();
  // Content blocks of the message being streamed, by index.
  let blocks = new Map();
  let cwd = "";
  let sessionId = "";
  let textId = "";
  let stepSinceText = true;
  let lastText = "";
  let result = null;

  const nextId = (prefix) => `${prefix}${(counters[prefix] += 1)}`;

  function textEvent(delta) {
    if (!delta) return [];
    if (stepSinceText || !textId) {
      textId = nextId("t");
      stepSinceText = false;
      lastText = "";
    }
    lastText += delta;
    return [{ type: "text", id: textId, delta }];
  }

  function openTool(block, { parent, startedAt, described }) {
    const kind = BUILTIN_KINDS[block.name] || "tool";
    const tool = { id: nextId(kind === "agent" ? "a" : "s"), kind, name: block.name, input: null, described: false };
    tools.set(block.id, tool);
    stepSinceText = true;
    const event = { type: "step", id: tool.id };
    if (parent) event.parent = parent;
    if (described) {
      const detail = describeClaudeTool(block.name, block.input, { cwd });
      tool.kind = detail.kind;
      tool.input = detail.input;
      tool.described = true;
      Object.assign(event, compact({ kind: detail.kind, title: detail.title, summary: detail.summary }));
      event.status = "running";
      event.startedAt = startedAt;
      event.input = detail.input;
    } else {
      // The block has only just opened: the name is known, the input is not.
      const detail = describeClaudeTool(block.name, {}, { cwd });
      Object.assign(event, { kind: detail.kind, title: detail.title, status: "running", startedAt });
    }
    return event;
  }

  function describeTool(tool, input) {
    const detail = describeClaudeTool(tool.name, input, { cwd });
    tool.kind = detail.kind;
    tool.input = detail.input;
    tool.described = true;
    return compact({ type: "step", id: tool.id, summary: detail.summary, input: detail.input });
  }

  function onStreamEvent(line) {
    // Only the top-level conversation streams; a nested stream would be a
    // sub-agent's prose, which the timeline does not carry.
    if (line.parent_tool_use_id) return [];
    const event = line.event || {};
    if (event.type === "message_start") {
      blocks = new Map();
      if (event.message?.id) streamedMessages.add(event.message.id);
      return [];
    }
    if (event.type === "content_block_start") {
      const block = event.content_block || {};
      if (block.type === "text") {
        blocks.set(event.index, { type: "text" });
        return textEvent(str(block.text));
      }
      if (block.type === "thinking") {
        const id = nextId("r");
        blocks.set(event.index, { type: "thinking", id });
        stepSinceText = true;
        const out = [{ type: "step", id, kind: "reasoning", title: "Thinking", status: "running", startedAt: now() }];
        if (str(block.thinking)) out.push({ type: "step.delta", id, output: block.thinking });
        return out;
      }
      if (block.type === "tool_use" && block.id) {
        blocks.set(event.index, { type: "tool_use", toolUseId: block.id, json: "" });
        if (tools.has(block.id)) return [];
        return [openTool(block, { startedAt: now(), described: false })];
      }
      return [];
    }
    if (event.type === "content_block_delta") {
      const block = blocks.get(event.index);
      const delta = event.delta || {};
      if (!block) return [];
      if (delta.type === "text_delta" && block.type === "text") return textEvent(str(delta.text));
      if (delta.type === "thinking_delta" && block.type === "thinking" && str(delta.thinking)) {
        return [{ type: "step.delta", id: block.id, output: delta.thinking }];
      }
      if (delta.type === "input_json_delta" && block.type === "tool_use") block.json += str(delta.partial_json);
      return [];
    }
    if (event.type === "content_block_stop") {
      const block = blocks.get(event.index);
      blocks.delete(event.index);
      if (!block) return [];
      if (block.type === "thinking") return [{ type: "step", id: block.id, status: "done", endedAt: now() }];
      if (block.type === "tool_use") {
        const tool = tools.get(block.toolUseId);
        if (!tool || tool.described) return [];
        let input = {};
        try {
          input = block.json ? JSON.parse(block.json) : {};
        } catch {
          input = {};
        }
        return [describeTool(tool, input)];
      }
    }
    return [];
  }

  function onAssistant(line) {
    const message = line.message || {};
    const parentTool = line.parent_tool_use_id ? tools.get(line.parent_tool_use_id) : null;
    // A sub-agent whose Agent step we never saw has nowhere to nest.
    if (line.parent_tool_use_id && !parentTool) return [];
    const streamed = !parentTool && streamedMessages.has(message.id);
    const at = isoTimestamp(line.timestamp, now);
    const out = [];
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text") {
        if (parentTool || streamed) continue;
        out.push(...textEvent(str(block.text)));
      } else if (block.type === "thinking") {
        if (parentTool || streamed) continue;
        stepSinceText = true;
        out.push(compact({
          type: "step",
          id: nextId("r"),
          kind: "reasoning",
          title: "Thinking",
          status: "done",
          startedAt: at,
          endedAt: at,
          output: str(block.thinking),
        }));
      } else if (block.type === "tool_use" && block.id) {
        const known = tools.get(block.id);
        if (known) {
          if (!known.described) out.push(describeTool(known, block.input));
        } else {
          out.push(openTool(block, { parent: parentTool?.id, startedAt: at, described: true }));
        }
      }
    }
    return out;
  }

  function onUser(line) {
    const content = line.message?.content;
    if (!Array.isArray(content)) return [];
    const at = isoTimestamp(line.timestamp, now);
    const out = [];
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      const tool = tools.get(block.tool_use_id);
      if (!tool || tool.closed) continue;
      tool.closed = true;
      // The structured copy describes a single result; with several results in
      // one line it cannot be attributed.
      const structured = content.length === 1 ? line.tool_use_result : null;
      out.push({ type: "step", id: tool.id, ...describeClaudeToolResult(tool, block, structured), endedAt: at });
    }
    return out;
  }

  function onResult(line) {
    const errors = Array.isArray(line.errors) ? line.errors.filter((item) => typeof item === "string").join("\n") : "";
    const text = str(line.result) || errors;
    result = {
      isError: line.is_error === true,
      subtype: str(line.subtype),
      text,
      sessionId: str(line.session_id),
    };
    const usage = line.usage && typeof line.usage === "object" ? line.usage : null;
    if (!usage) return [];
    const count = (value) => (Number.isFinite(value) ? value : 0);
    return [{
      type: "usage",
      inputTokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
      outputTokens: count(usage.output_tokens),
    }];
  }

  return {
    push(line) {
      if (!line || typeof line !== "object") return [];
      switch (line.type) {
        case "system":
          if (line.subtype === "init") {
            cwd = str(line.cwd) || cwd;
            sessionId = str(line.session_id) || sessionId;
          }
          return [];
        case "stream_event": return onStreamEvent(line);
        case "assistant": return onAssistant(line);
        case "user": return onUser(line);
        case "result": return onResult(line);
        default: return [];
      }
    },
    // The final answer text from the `result` line, or "" before it arrives.
    finalAnswer() {
      return result && !result.isError ? result.text : "";
    },
    // The `result` line, reduced: { isError, subtype, text, sessionId }, or null.
    outcome() {
      return result;
    },
    // The last top-level prose block, for a stream that ended without a result.
    lastProse() {
      return lastText;
    },
    sessionId() {
      return sessionId;
    },
  };
}

function historyStep(detail, extra) {
  const step = compact({ type: "step", ...extra, kind: detail.kind, title: detail.title, summary: detail.summary });
  if (detail.input) step.input = clipHistoryInput(detail.input);
  return step;
}

function clipHistoryInput(input) {
  const next = { ...input };
  for (const field of ["command", "prompt", "diff", "json"]) {
    if (typeof next[field] === "string") next[field] = clipText(next[field], TIMELINE_CAPS.historyOutput).text;
  }
  return next;
}

function applyHistoryResult(step, fields) {
  const { output, input, ...rest } = fields;
  Object.assign(step, rest);
  if (input) step.input = clipHistoryInput(input);
  if (typeof output === "string" && output) {
    const clipped = clipText(output, TIMELINE_CAPS.historyOutput);
    step.output = clipped.text;
    if (clipped.truncated) step.outputTruncated = true;
  }
}

const MAX_AGENT_DEPTH = 3;

// History. Feed every parsed transcript line in file order; take() returns the
// complete `step` objects seen since the previous take() and clears them.
//
// A sub-agent's entries live beside the session, one file per agent, keyed by
// the `agentId` in the Agent tool's result; `readSidechain(agentId)` returns
// that file's parsed lines (or nothing). Sidechain lines pushed inline (older
// transcripts kept them in the session file) are used the same way.
//
// A step whose result has not arrived is held back, so it is reported once,
// complete. take({ final: true }) releases what is still open as `running`.
export function createClaudeTranscriptCollector({ readSidechain = () => [] } = {}) {
  let entries = [];
  const pending = new Map();
  const inlineSidechains = new Map();
  let cwd = "";
  let thoughts = 0;

  function sidechainEntries(agentId) {
    if (!agentId) return [];
    const inline = inlineSidechains.get(agentId);
    if (inline?.length) return inline;
    try {
      const loaded = readSidechain(agentId);
      return Array.isArray(loaded) ? loaded : [];
    } catch {
      return [];
    }
  }

  // The tool steps a sub-agent ran, in order, each with `parent` set. Its prose
  // and thinking are left out, as they are live.
  function childSteps(agentId, parentId, depth) {
    const open = new Map();
    const steps = [];
    for (const entry of sidechainEntries(agentId)) {
      const content = entry?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (entry.type === "assistant" && block.type === "tool_use" && block.id) {
          const detail = describeClaudeTool(block.name, block.input, { cwd: str(entry.cwd) || cwd });
          const record = {
            step: historyStep(detail, { id: block.id, parent: parentId, status: "running", startedAt: entry.timestamp }),
            detail,
            children: [],
          };
          open.set(block.id, record);
          steps.push(record);
        } else if (entry.type === "user" && block.type === "tool_result") {
          const record = open.get(block.tool_use_id);
          if (!record) continue;
          open.delete(block.tool_use_id);
          const structured = content.length === 1 ? entry.toolUseResult : null;
          applyHistoryResult(record.step, describeClaudeToolResult(record.detail, block, structured));
          if (entry.timestamp) record.step.endedAt = entry.timestamp;
          if (record.detail.kind === "agent" && depth < MAX_AGENT_DEPTH) {
            record.children = childSteps(str(structured?.agentId), record.step.id, depth + 1);
          }
        }
      }
    }
    // A sub-agent that has reported back is over; anything it left open was cut short.
    for (const record of open.values()) record.step.status = "cancelled";
    return steps.flatMap((record) => [record.step, ...record.children]);
  }

  function pushAssistant(entry) {
    const content = entry.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "thinking") {
        thoughts += 1;
        const step = compact({
          type: "step",
          id: entry.uuid ? `r-${entry.uuid}` : `r${thoughts}`,
          kind: "reasoning",
          title: "Thinking",
          status: "done",
          startedAt: entry.timestamp,
          endedAt: entry.timestamp,
        });
        applyHistoryResult(step, { output: str(block.thinking) });
        entries.push({ step, children: [], done: true });
      } else if (block.type === "tool_use" && block.id && !pending.has(block.id)) {
        const detail = describeClaudeTool(block.name, block.input, { cwd: str(entry.cwd) || cwd });
        const record = {
          step: historyStep(detail, { id: block.id, status: "running", startedAt: entry.timestamp }),
          detail,
          children: [],
          done: false,
        };
        pending.set(block.id, record);
        entries.push(record);
      }
    }
  }

  function pushUser(entry) {
    const content = entry.message?.content;
    if (typeof content === "string") {
      // A new prompt while steps are open: the turn they belonged to was cut short.
      if (entry.isMeta) return;
      for (const record of pending.values()) {
        record.step.status = "cancelled";
        record.done = true;
      }
      pending.clear();
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (!block || block.type !== "tool_result") continue;
      const record = pending.get(block.tool_use_id);
      if (!record) continue;
      pending.delete(block.tool_use_id);
      const structured = content.length === 1 ? entry.toolUseResult : null;
      applyHistoryResult(record.step, describeClaudeToolResult(record.detail, block, structured));
      if (entry.timestamp) record.step.endedAt = entry.timestamp;
      if (record.detail.kind === "agent") {
        record.children = childSteps(str(structured?.agentId), record.step.id, 1);
      }
      record.done = true;
    }
  }

  return {
    push(entry) {
      if (!entry || typeof entry !== "object") return;
      if (entry.isSidechain === true) {
        if (typeof entry.agentId === "string" && entry.agentId) {
          if (!inlineSidechains.has(entry.agentId)) inlineSidechains.set(entry.agentId, []);
          inlineSidechains.get(entry.agentId).push(entry);
        }
        return;
      }
      if (typeof entry.cwd === "string" && entry.cwd) cwd = entry.cwd;
      if (entry.type === "assistant") pushAssistant(entry);
      else if (entry.type === "user") pushUser(entry);
    },
    take({ final = false } = {}) {
      const ready = entries.filter((record) => record.done || final);
      entries = entries.filter((record) => !record.done && !final);
      if (final) pending.clear();
      return ready.flatMap((record) => [record.step, ...record.children]);
    },
  };
}
