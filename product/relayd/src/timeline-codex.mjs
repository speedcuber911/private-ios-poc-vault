// relayd timeline-codex.mjs — turns Codex's items into timeline events.
// Two sources share one mapping: app-server notifications from a running job,
// and the session rollout on disk (thread history).
//
// Contract: docs/superpowers/specs/2026-10-06-chat-composer-and-transcript.md, Part 1.
//
// Shapes are taken from `codex app-server generate-json-schema` and from real
// captures on codex-cli 0.159.2 (test/fixtures/codex-appserver-*.ndjson and
// codex-rollout.ndjson). Item types the captures did not exercise (MCP, web
// search, plans, collab agents) follow the schema only.
import { TIMELINE_CAPS, clipText } from "./timeline.mjs";

// ---------------------------------------------------------------------------
// Shared: one description of a Codex item, whichever source it came from.

const SHELL_WRAPPER = /^(?:\S*\/)?(?:bash|zsh|sh|dash|fish)\s+-l?c\s+([\s\S]+)$/;
const SHELL_NAMES = /^(?:\S*\/)?(?:bash|zsh|sh|dash|fish)$/;

// Decodes one shell word ('…', "…", \x and bare runs, concatenated). Returns
// null when the text is more than one word, so a command we cannot read with
// certainty is shown as Codex reported it rather than guessed at.
function shellUnquote(text) {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      out += text.slice(index + 1, end);
      index = end + 1;
    } else if (char === '"') {
      index += 1;
      let closed = false;
      while (index < text.length) {
        const inner = text[index];
        if (inner === '"') { closed = true; index += 1; break; }
        if (inner === "\\" && index + 1 < text.length && '"\\$`'.includes(text[index + 1])) {
          out += text[index + 1];
          index += 2;
        } else {
          out += inner;
          index += 1;
        }
      }
      if (!closed) return null;
    } else if (char === "\\" && index + 1 < text.length) {
      out += text[index + 1];
      index += 2;
    } else if (/\s/.test(char)) {
      return null;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

// Codex runs everything as `/bin/zsh -lc '<script>'`. The phone shows the script.
export function displayCommand(command) {
  if (Array.isArray(command)) {
    const parts = command.map((part) => String(part ?? ""));
    if (parts.length === 3 && SHELL_NAMES.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts[2];
    return parts.join(" ");
  }
  const text = String(command ?? "").trim();
  const match = SHELL_WRAPPER.exec(text);
  if (!match) return text;
  const inner = shellUnquote(match[1].trim());
  return inner === null || inner === "" ? text : inner;
}

function baseName(value) {
  const text = String(value ?? "").replace(/\/+$/, "");
  return text.slice(text.lastIndexOf("/") + 1) || text;
}

function stripFileScheme(value) {
  return typeof value === "string" ? value.replace(/^file:\/\//, "") : value;
}

function firstLine(value) {
  return String(value ?? "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

export function readableName(value) {
  const words = String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_\-./:]+/)
    .filter(Boolean);
  if (words.length === 0) return "Tool";
  return words.map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
}

function jsonText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function isoTime(value) {
  if (typeof value === "string" && value) return value;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function stepStatus(value, fallback) {
  switch (value) {
    case "inProgress":
    case "in_progress":
    case "running":
      return "running";
    case "completed":
    case "done":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "declined":
    case "interrupted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    default:
      return fallback;
  }
}

// Codex runs everything through a shell, but it also parses each command. When
// it read the command as exactly one read, search or listing, the step takes
// that kind, so a run reads "Read 2 files, ran a search" and not "Ran 3 commands".
function commandAction(actions, cwd) {
  if (!Array.isArray(actions) || actions.length !== 1) return null;
  const action = actions[0] || {};
  if (action.type === "read") {
    const file = nonEmpty(action.path) ? action.path : nonEmpty(action.name) ? action.name : "";
    return { kind: "read", title: "Read", summary: action.name || baseName(file) || "a file", input: file ? { path: file } : {} };
  }
  if (action.type === "search") {
    const input = {};
    if (nonEmpty(action.query)) input.pattern = action.query;
    if (nonEmpty(action.path)) input.path = action.path;
    return { kind: "search", title: "Search", summary: action.query || action.path || "files", input };
  }
  if (action.type === "listFiles") {
    const directory = nonEmpty(action.path) ? action.path : "";
    return { kind: "search", title: "Search", summary: directory || baseName(cwd) || "files", input: directory ? { path: directory } : {} };
  }
  return null;
}

function changeDiff(change) {
  const kind = change?.kind?.type || "update";
  const body = typeof change?.diff === "string" ? change.diff : "";
  if (!body) return "";
  // An added or deleted file can arrive as bare content; render it as a diff.
  if (kind !== "update" && !/^(@@|[+-]|diff )/m.test(body)) {
    const sign = kind === "delete" ? "-" : "+";
    return body.replace(/\n$/, "").split("\n").map((line) => sign + line).join("\n") + "\n";
  }
  return body;
}

function describeFileChange(item) {
  const changes = (Array.isArray(item.changes) ? item.changes : []).filter((change) => change && change.path);
  const allAdded = changes.length > 0 && changes.every((change) => change.kind?.type === "add");
  const names = changes.map((change) => baseName(change.path));
  const shown = names.slice(0, 6).join(", ") + (names.length > 6 ? ` +${names.length - 6} more` : "");
  const input = {};
  if (changes.length > 0) input.path = changes[0].path;
  const diffs = changes.map((change) => {
    const diff = changeDiff(change);
    if (!diff) return "";
    if (changes.length === 1) return diff;
    const target = change.kind?.move_path || change.path;
    return `--- ${change.path}\n+++ ${target}\n${diff}`;
  }).filter(Boolean);
  if (diffs.length > 0) input.diff = diffs.join(diffs.length > 1 ? "\n" : "");
  return {
    kind: allAdded ? "write" : "edit",
    title: allAdded ? "Write" : "Edit",
    summary: shown || "Workspace files",
    input,
    status: stepStatus(item.status),
    error: item.status === "declined" ? "Declined" : undefined,
  };
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function describeWebSearch(item) {
  const action = item.action || {};
  const queries = Array.isArray(action.queries) ? action.queries.filter(nonEmpty) : [];
  const query = [item.query, action.query, queries[0], action.pattern].find(nonEmpty) || "";
  const url = nonEmpty(action.url) ? action.url : "";
  const input = {};
  if (query) input.query = query;
  if (url) input.url = url;
  const opening = action.type === "openPage" || action.type === "open_page"
    || action.type === "findInPage" || action.type === "find_in_page";
  return {
    kind: "fetch",
    title: opening ? "Web Page" : "Web Search",
    summary: (opening ? hostOf(url) || url : "") || query || hostOf(url) || "the web",
    input,
  };
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    if (typeof part.text === "string") return part.text;
    return part.type ? `[${part.type}]` : "";
  }).filter(Boolean).join("\n");
}

function argumentSummary(args) {
  if (!args || typeof args !== "object") return "";
  for (const key of ["title", "description", "query", "url", "path", "command", "name"]) {
    if (nonEmpty(args[key])) return firstLine(args[key]);
  }
  return "";
}

function describeToolCall({ name, server, args, status, output, error }) {
  const input = { name: String(name || "tool") };
  if (server) input.server = String(server);
  const json = jsonText(args);
  if (json && json !== "{}") input.json = json;
  return {
    kind: "tool",
    title: readableName(name),
    summary: argumentSummary(args) || (server ? String(server) : ""),
    input,
    status,
    output,
    error,
  };
}

function todoStatus(value) {
  if (value === "inProgress" || value === "in_progress") return "in_progress";
  if (value === "completed" || value === "done") return "completed";
  return "pending";
}

function describePlan(plan, explanation) {
  const items = (Array.isArray(plan) ? plan : [])
    .filter((entry) => entry && nonEmpty(entry.step))
    .map((entry) => ({ text: entry.step, status: todoStatus(entry.status) }));
  const done = items.filter((entry) => entry.status === "completed").length;
  const active = items.find((entry) => entry.status === "in_progress");
  return {
    kind: "todo",
    title: "Plan",
    summary: active ? active.text : nonEmpty(explanation) ? firstLine(explanation) : `${done} of ${items.length} done`,
    input: { items },
    status: "done",
  };
}

const COLLAB_SPAWN = new Set(["spawnAgent", "spawn_agent"]);

// The full description of an item in app-server (camelCase) shape. `status`,
// `exitCode`, `output` and `error` are only meaningful once the item completed.
// Returns null for items that are not steps (messages).
export function describeCodexItem(item) {
  if (!item || typeof item !== "object" || !nonEmpty(item.type)) return null;
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
    case "hookPrompt":
    case "exitedReviewMode":
      return null;
    case "commandExecution": {
      const command = displayCommand(item.command);
      const action = commandAction(item.commandActions, item.cwd);
      const input = { ...(action ? action.input : {}), command };
      if (nonEmpty(item.cwd)) input.cwd = item.cwd;
      const exitCode = Number.isInteger(item.exitCode) ? item.exitCode : undefined;
      const output = typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined;
      let status = stepStatus(item.status);
      // rg and grep exit 1 for "no matches". That is an answer, not a failure.
      if (action?.kind === "search" && status === "failed" && exitCode === 1 && !output) status = "done";
      return {
        kind: action ? action.kind : "command",
        title: action ? action.title : "Bash",
        summary: action ? action.summary : firstLine(command) || "command",
        input,
        status,
        exitCode,
        output,
        error: item.status === "declined" ? "Declined" : undefined,
      };
    }
    case "fileChange":
      return describeFileChange(item);
    case "webSearch":
      return describeWebSearch(item);
    case "mcpToolCall": {
      const failed = item.status === "failed" || item.result?.isError === true || Boolean(item.error);
      const output = contentText(item.result?.content) || jsonText(item.result?.structuredContent);
      return describeToolCall({
        name: item.tool,
        server: item.server,
        args: item.arguments,
        status: failed ? "failed" : stepStatus(item.status),
        output: output || undefined,
        error: nonEmpty(item.error?.message) ? item.error.message : undefined,
      });
    }
    case "dynamicToolCall":
      return describeToolCall({
        name: item.tool,
        server: item.namespace,
        args: item.arguments,
        status: item.success === false ? "failed" : stepStatus(item.status),
        output: contentText(item.contentItems) || undefined,
      });
    case "collabAgentToolCall": {
      if (COLLAB_SPAWN.has(item.tool)) {
        const input = {};
        if (nonEmpty(item.prompt)) {
          input.description = firstLine(item.prompt);
          input.prompt = item.prompt;
        }
        if (nonEmpty(item.model)) input.agentType = item.model;
        return {
          kind: "agent",
          title: "Agent",
          summary: firstLine(item.prompt) || "Sub-agent",
          input,
          status: stepStatus(item.status),
        };
      }
      const args = {};
      if (nonEmpty(item.prompt)) args.prompt = item.prompt;
      if (Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.length) args.receiverThreadIds = item.receiverThreadIds;
      return describeToolCall({ name: item.tool, server: "collaboration", args, status: stepStatus(item.status) });
    }
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.filter(nonEmpty) : [];
      const content = Array.isArray(item.content) ? item.content.filter(nonEmpty) : [];
      const text = (summary.length ? summary : content).join("\n\n");
      return { kind: "reasoning", title: "Thinking", output: text || undefined };
    }
    case "plan":
      return { kind: "todo", title: "Plan", summary: firstLine(item.text), output: nonEmpty(item.text) ? item.text : undefined };
    case "imageView":
      return { kind: "read", title: "View Image", summary: baseName(item.path), input: nonEmpty(item.path) ? { path: item.path } : {} };
    case "functionCallOutput":
      return describeToolCall({ name: item.name, server: item.namespace, args: null, output: contentText(item.output) || undefined });
    case "enteredReviewMode":
      return { kind: "tool", title: "Review", summary: firstLine(item.review), input: { name: "review" } };
    case "imageGeneration":
      return {
        kind: "tool",
        title: "Image Generation",
        summary: firstLine(item.revisedPrompt),
        input: { name: "imageGeneration" },
        status: item.failure ? "failed" : stepStatus(item.status),
      };
    default: {
      // Anything Codex adds later still shows up as a step, never as silence.
      const { id: _id, type, status, ...rest } = item;
      const described = describeToolCall({ name: type || "item", args: rest, status: stepStatus(status) });
      if (nonEmpty(item.kind)) described.summary = [item.kind, item.agentPath].filter(nonEmpty).join(" ");
      return described;
    }
  }
}

function pruned(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") continue;
    if (key === "input" && typeof value === "object" && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Live. Feed every app-server notification ({ method, params }) in order; each
// call returns the timeline events (spec 1.1 shapes) that notification produces.
//
// Beyond push(), the runner reports the two things only it knows about:
// approvalRequested() when it blocks on a server request, and
// approvalResolved() with the phone's decision.
export function createCodexNotificationMapper({ now = () => Date.now() } = {}) {
  const steps = new Map(); // id -> { closed, sent: { summary, input }, source }
  const streamedText = new Set(); // agentMessage item ids that streamed deltas
  const usedTextIds = new Set();
  const threadParents = new Map(); // sub-agent thread id -> agent step id
  let primaryThread = "";
  let block = null; // { key, id }
  let stepSinceText = false;
  let anonymousText = 0;
  let planCount = 0;
  let approvalCount = 0;
  let usage = null;
  let lastUsageTotal = null;

  function stamp(ms) {
    return isoTime(ms) || new Date(now()).toISOString();
  }

  function stepEvent(fields) {
    stepSinceText = true;
    return { type: "step", ...pruned(fields) };
  }

  function open(id, described, { startedAtMs, parent } = {}) {
    const input = described.input && Object.keys(described.input).length ? described.input : undefined;
    steps.set(id, {
      closed: false,
      kind: described.kind,
      sent: { summary: described.summary || "", input: jsonText(input) },
      source: "",
    });
    return stepEvent({
      id,
      parent,
      kind: described.kind,
      title: described.title,
      summary: described.summary,
      status: "running",
      startedAt: stamp(startedAtMs),
      input,
    });
  }

  // Closing fields, plus any summary or input that only became known at the end
  // (a web search's query, a patch's final diff).
  function close(id, described, { completedAtMs, fallbackStatus = "done" } = {}) {
    const state = steps.get(id);
    const input = described.input && Object.keys(described.input).length ? described.input : undefined;
    const fields = {
      id,
      status: described.status && described.status !== "running" ? described.status : fallbackStatus,
      endedAt: stamp(completedAtMs),
      exitCode: described.exitCode,
      output: described.output,
      error: described.error,
    };
    if (state) {
      if (described.summary && described.summary !== state.sent.summary) fields.summary = described.summary;
      if (input && jsonText(input) !== state.sent.input) fields.input = input;
      state.closed = true;
    }
    return stepEvent(fields);
  }

  function textEvents(itemId, delta) {
    if (!nonEmpty(delta)) return [];
    const key = itemId || "";
    if (!block || stepSinceText || block.key !== key) {
      let id = key || `t${++anonymousText}`;
      for (let suffix = 2; usedTextIds.has(id); suffix += 1) id = `${key || `t${anonymousText}`}.${suffix}`;
      usedTextIds.add(id);
      block = { key, id };
      stepSinceText = false;
    }
    streamedText.add(key);
    return [{ type: "text", id: block.id, delta }];
  }

  function parentFor(params) {
    const thread = params.threadId;
    if (!thread || !primaryThread || thread === primaryThread) return undefined;
    return threadParents.get(thread);
  }

  function isForeign(params) {
    return Boolean(params.threadId && primaryThread && params.threadId !== primaryThread);
  }

  function itemStarted(params) {
    const item = params.item || {};
    const described = describeCodexItem(item);
    if (!described || !item.id) return [];
    const state = steps.get(item.id);
    if (state) {
      // Already open (an approval arrived first): fill in what the item adds.
      if (state.closed) return [];
      const input = described.input && Object.keys(described.input).length ? described.input : undefined;
      const fields = { id: item.id };
      if (described.kind !== state.kind) {
        fields.kind = described.kind;
        fields.title = described.title;
        state.kind = described.kind;
      }
      if (described.summary && described.summary !== state.sent.summary) fields.summary = described.summary;
      if (input && jsonText(input) !== state.sent.input) fields.input = input;
      if (Object.keys(fields).length === 1) return [];
      state.sent = { summary: described.summary || state.sent.summary, input: input ? jsonText(input) : state.sent.input };
      return [stepEvent(fields)];
    }
    return [open(item.id, described, { startedAtMs: params.startedAtMs, parent: parentFor(params) })];
  }

  function itemCompleted(params) {
    const item = params.item || {};
    if (item.type === "agentMessage" || item.type === "exitedReviewMode") {
      if (isForeign(params)) return [];
      const text = item.type === "agentMessage" ? item.text : item.review;
      // A server that did not stream this message still gets its prose recorded.
      if (streamedText.has(item.id || "")) return [];
      return textEvents(item.id, text);
    }
    const described = describeCodexItem(item);
    if (!described) return [];
    const id = item.id || `item-${steps.size + 1}`;
    const state = steps.get(id);
    if (state?.closed) return [];
    if (item.type === "collabAgentToolCall" && COLLAB_SPAWN.has(item.tool)) {
      for (const thread of Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : []) threadParents.set(thread, id);
    }
    if (state) return [close(id, described, { completedAtMs: params.completedAtMs })];
    // Completed without a start (out of order, or a server that only reports
    // the end): one event carries the whole step.
    const endedMs = Number(params.completedAtMs) || now();
    const startedMs = Number.isFinite(item.durationMs) ? endedMs - item.durationMs : endedMs;
    steps.set(id, { closed: true, sent: { summary: "", input: "" }, source: "" });
    return [stepEvent({
      id,
      parent: parentFor(params),
      kind: described.kind,
      title: described.title,
      summary: described.summary,
      status: described.status && described.status !== "running" ? described.status : "done",
      startedAt: stamp(startedMs),
      endedAt: stamp(endedMs),
      input: described.input,
      exitCode: described.exitCode,
      output: described.output,
      error: described.error,
    })];
  }

  // A delta for a step we never saw start still lands somewhere visible.
  function ensureStep(id, described, params) {
    if (steps.has(id)) return [];
    return [open(id, described, { parent: parentFor(params) })];
  }

  function stepDelta(id, described, params, output, source) {
    if (!id || !nonEmpty(output)) return [];
    const events = ensureStep(id, described, params);
    const state = steps.get(id);
    if (state.closed) return events;
    // Reasoning can stream as a summary and as raw text; mixing the two would
    // interleave them, so the first stream seen owns the step.
    if (source) {
      if (state.source && state.source !== source) return events;
      state.source = source;
    }
    stepSinceText = true;
    events.push({ type: "step.delta", id, output });
    return events;
  }

  function addUsage(params) {
    if (isForeign(params)) return;
    const tokens = params.tokenUsage || {};
    const last = tokens.last;
    if (!last || typeof last !== "object") return;
    // `total` is cumulative for the thread, which on a resumed thread includes
    // earlier jobs. Each update's `last` is one model request of this turn.
    const total = tokens.total?.totalTokens;
    if (total !== undefined && total === lastUsageTotal) return;
    lastUsageTotal = total;
    usage = usage || { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
    for (const key of Object.keys(usage)) usage[key] += Number.isFinite(last[key]) ? last[key] : 0;
  }

  return {
    push(notification) {
      const method = String(notification?.method || "");
      const params = notification?.params && typeof notification.params === "object" ? notification.params : {};
      if (method === "turn/started") {
        if (!primaryThread && params.threadId) primaryThread = params.threadId;
        return [];
      }
      if (!primaryThread && params.threadId && method.startsWith("item/")) primaryThread = params.threadId;

      switch (method) {
        case "item/started":
          return itemStarted(params);
        case "item/completed":
          return itemCompleted(params);
        case "item/agentMessage/delta":
          return isForeign(params) ? [] : textEvents(params.itemId, params.delta);
        case "item/commandExecution/outputDelta":
          return stepDelta(params.itemId, { kind: "command", title: "Bash" }, params, params.delta);
        case "item/fileChange/outputDelta":
          return stepDelta(params.itemId, { kind: "edit", title: "Edit" }, params, params.delta);
        case "item/mcpToolCall/progress":
          return stepDelta(params.itemId, { kind: "tool", title: "Tool" }, params, nonEmpty(params.message) ? `${params.message}\n` : "");
        case "item/plan/delta":
          return stepDelta(params.itemId, { kind: "todo", title: "Plan" }, params, params.delta);
        case "item/reasoning/summaryTextDelta":
          return stepDelta(params.itemId, { kind: "reasoning", title: "Thinking" }, params, params.delta, "summary");
        case "item/reasoning/textDelta":
          return stepDelta(params.itemId, { kind: "reasoning", title: "Thinking" }, params, params.delta, "raw");
        case "item/reasoning/summaryPartAdded":
          // Parts are separate thoughts; keep them apart in the running text.
          return params.summaryIndex > 0
            ? stepDelta(params.itemId, { kind: "reasoning", title: "Thinking" }, params, "\n\n", "summary")
            : [];
        case "item/fileChange/patchUpdated": {
          const state = steps.get(params.itemId);
          if (!state || state.closed) return [];
          const described = describeFileChange({ changes: params.changes });
          const input = jsonText(described.input);
          if (input === state.sent.input) return [];
          state.sent = { summary: described.summary, input };
          return [stepEvent({ id: params.itemId, summary: described.summary, input: described.input })];
        }
        case "turn/plan/updated": {
          if (isForeign(params)) return [];
          const described = describePlan(params.plan, params.explanation);
          if (described.input.items.length === 0) return [];
          const at = stamp();
          planCount += 1;
          return [stepEvent({ id: `plan-${params.turnId || "turn"}-${planCount}`, ...described, startedAt: at, endedAt: at })];
        }
        case "thread/tokenUsage/updated":
          addUsage(params);
          return [];
        case "turn/completed": {
          if (isForeign(params) || !usage) return [];
          const event = { type: "usage", ...usage };
          usage = null;
          return [event];
        }
        default:
          return [];
      }
    },

    // The runner is about to block on an approval. Codex normally announces the
    // item first, so this is usually a no-op; when it has not, the step is
    // created here so the phone has something to attach the question to.
    approvalRequested({ method, params } = {}) {
      const request = params && typeof params === "object" ? params : {};
      const id = request.itemId || `approval-${++approvalCount}`;
      if (steps.has(id)) return { id, events: [] };
      const fileChange = String(method || "").includes("fileChange");
      const network = request.networkApprovalContext;
      let described;
      if (fileChange) {
        described = { kind: "edit", title: "Edit", summary: nonEmpty(request.reason) ? firstLine(request.reason) : "File changes" };
      } else {
        const command = request.command ? displayCommand(request.command) : "";
        const input = {};
        if (command) input.command = command;
        if (nonEmpty(request.cwd)) input.cwd = request.cwd;
        const host = network && typeof network === "object"
          ? [network.protocol, network.host, network.port].filter((part) => part !== null && part !== undefined && part !== "").join(" ")
          : "";
        described = { kind: "command", title: "Bash", summary: firstLine(command) || (host ? `Network access: ${host}` : "command"), input };
      }
      return { id, events: [open(id, described, { startedAtMs: request.startedAtMs, parent: parentFor(request) })] };
    },

    // Accepted approvals leave the step running; Codex closes it. Anything else
    // (decline, cancel, a timeout) closes it as cancelled.
    approvalResolved(id, decision) {
      const accepted = typeof decision === "string"
        ? decision.startsWith("accept")
        : Boolean(decision && typeof decision === "object" && Object.keys(decision).some((key) => key.startsWith("accept")));
      const state = steps.get(id);
      if (accepted || !state || state.closed) return [];
      state.closed = true;
      return [stepEvent({ id, status: "cancelled", endedAt: stamp(), error: "Declined" })];
    },
  };
}

// Writes mapper events through a createTimelineWriter() writer, which owns the caps.
export function writeTimelineEvents(writer, events) {
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== "object") continue;
    const { type, ...fields } = event;
    if (type === "text") writer.text(fields.id, fields.delta);
    else if (type === "step") writer.step(fields);
    else if (type === "step.delta") writer.stepDelta(fields.id, fields.output);
    else if (type === "usage") writer.usage(fields);
  }
}

// ---------------------------------------------------------------------------
// History. Feed every parsed rollout line in file order; take() returns the
// complete `step` objects seen since the previous take() and clears them.
//
// A rollout records the same action up to three times, depending on the CLI
// version that wrote it: the model's call (`response_item` function_call /
// custom_tool_call / local_shell_call / web_search_call), its output, and the
// executed item (`event_msg` item_completed, which carries exit codes and
// diffs). The executed item wins; a call is only turned into a step when no
// item covered it.

const SNAKE_ACTION = { list_files: "listFiles", open_page: "openPage", find_in_page: "findInPage" };

function lowerFirst(value) {
  const text = String(value || "");
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function camelAction(action) {
  if (!action || typeof action !== "object") return action;
  return { ...action, type: SNAKE_ACTION[action.type] || action.type, command: action.command ?? action.cmd };
}

// Rollout items are the app-server items in PascalCase with snake_case fields.
function normalizeRolloutItem(item) {
  const type = item.type === "Extension" && item.kind === "web.search" ? "webSearch" : lowerFirst(item.type);
  switch (type) {
    case "commandExecution":
      return {
        type,
        id: item.id,
        command: item.command,
        cwd: stripFileScheme(item.cwd),
        commandActions: Array.isArray(item.parsed_cmd) ? item.parsed_cmd.map(camelAction) : [],
        status: item.status,
        exitCode: item.exit_code,
        aggregatedOutput: item.aggregated_output ?? item.formatted_output,
      };
    case "fileChange": {
      const changes = item.changes && typeof item.changes === "object" && !Array.isArray(item.changes)
        ? Object.entries(item.changes).map(([file, change]) => ({
            path: file,
            kind: { type: change?.type || "update", move_path: change?.move_path ?? null },
            diff: change?.unified_diff ?? change?.content ?? "",
          }))
        : item.changes;
      return { type, id: item.id, changes, status: item.status };
    }
    case "reasoning":
      return { type, id: item.id, summary: item.summary_text, content: item.raw_content };
    case "webSearch":
      return { type, id: item.id, query: item.query, action: camelAction(item.action) };
    case "imageView":
      return { type, id: item.id, path: stripFileScheme(item.path) };
    default:
      return { ...item, type };
  }
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { input: value };
  }
}

function mcpServerOf(namespace) {
  const text = String(namespace || "");
  const match = /^mcp__(.+?)(?:__.*)?$/.exec(text);
  return match ? match[1] : text;
}

const COMMAND_CALLS = new Set(["exec_command", "shell", "shell_command", "local_shell", "container.exec", "unified_exec"]);
// The script a code-mode `exec` call runs is JavaScript; a lone exec_command in
// it is a shell command and reads better as one.
const CODE_MODE_COMMAND = /exec_command\(\s*\{\s*"?cmd"?\s*:\s*("(?:[^"\\]|\\.)*")/;

function patchPaths(patch) {
  const paths = [];
  const matcher = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  for (let match = matcher.exec(patch); match; match = matcher.exec(patch)) paths.push({ kind: match[1], path: match[2].trim() });
  return paths;
}

function describeCall(call) {
  const args = call.args;
  const name = call.name;
  if (call.type === "local_shell_call" || COMMAND_CALLS.has(name)) {
    const raw = call.action?.command ?? args.cmd ?? args.command ?? args.script ?? "";
    const command = displayCommand(raw);
    const input = { command };
    const cwd = call.action?.working_directory ?? args.workdir ?? args.cwd;
    if (nonEmpty(cwd)) input.cwd = cwd;
    return { kind: "command", title: "Bash", summary: firstLine(command) || "command", input };
  }
  if (name === "apply_patch") {
    const patch = nonEmpty(call.input) ? call.input : args.input || args.patch || "";
    const paths = patchPaths(patch);
    const added = paths.length > 0 && paths.every((entry) => entry.kind === "Add");
    const input = {};
    if (paths.length) input.path = paths[0].path;
    if (patch) input.diff = patch;
    return {
      kind: added ? "write" : "edit",
      title: added ? "Write" : "Edit",
      summary: paths.map((entry) => baseName(entry.path)).slice(0, 6).join(", ") || "Workspace files",
      input,
    };
  }
  if (name === "exec" && call.type === "custom_tool_call") {
    const match = CODE_MODE_COMMAND.exec(call.input || "");
    if (match) {
      try {
        const command = JSON.parse(match[1]);
        return { kind: "command", title: "Bash", summary: firstLine(command) || "command", input: { command } };
      } catch {
        // Fall through to the generic script step.
      }
    }
    return { kind: "tool", title: "Script", summary: firstLine(call.input), input: { name: "exec", json: call.input || "" } };
  }
  if (name === "update_plan") return describePlan(args.plan, args.explanation);
  if (name === "spawn_agent") {
    const prompt = [args.message, args.prompt, args.task].find(nonEmpty) || "";
    const description = [args.task_name, args.description, args.name].find(nonEmpty) || firstLine(prompt);
    const input = {};
    if (description) input.description = description;
    if (prompt) input.prompt = prompt;
    const agentType = [args.agent_type, args.agent, args.model].find(nonEmpty);
    if (agentType) input.agentType = agentType;
    return { kind: "agent", title: "Agent", summary: description || "Sub-agent", input };
  }
  if (name === "view_image") {
    return { kind: "read", title: "View Image", summary: baseName(args.path), input: nonEmpty(args.path) ? { path: args.path } : {} };
  }
  if (call.type === "tool_search_call") return describeToolCall({ name: "tool_search", args });
  return describeToolCall({ name, server: mcpServerOf(call.namespace), args });
}

// What a call returned, and whether it worked, across the output dialects:
// plain text, `{output, metadata:{exit_code}}` JSON, the unified-exec
// "Process exited with code N\nOutput:\n…" block, and code-mode's
// "Script completed|failed" preamble.
function readCallOutput(payload) {
  const result = {};
  let text = "";
  const raw = payload.output;
  if (Array.isArray(raw)) {
    const parts = raw.map((part) => (typeof part === "string" ? part : part?.text ?? "")).filter((part) => typeof part === "string");
    if (/^Script (completed|failed)/.test(parts[0] || "")) {
      if (/^Script failed/.test(parts[0])) result.status = "failed";
      text = parts.slice(1).join("\n");
      // A script that only ran a command prints that command's result object.
      if (parts.length === 2 && parts[1].startsWith("{")) {
        try {
          const parsed = JSON.parse(parts[1]);
          if (typeof parsed.output === "string") text = parsed.output;
          if (Number.isInteger(parsed.exit_code)) result.exitCode = parsed.exit_code;
        } catch {
          // Arbitrary script output.
        }
      }
    } else {
      text = parts.join("\n");
    }
  } else if (raw && typeof raw === "object") {
    text = contentText(raw.content) || (typeof raw.content === "string" ? raw.content : "");
    if (raw.success === false) result.status = "failed";
  } else if (typeof raw === "string") {
    text = raw;
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.output === "string") text = parsed.output;
        if (Number.isInteger(parsed.metadata?.exit_code)) result.exitCode = parsed.metadata.exit_code;
      } catch {
        // Not JSON after all.
      }
    }
  }
  const exited = /^Process exited with code (-?\d+)$/m.exec(text);
  if (exited) result.exitCode = Number(exited[1]);
  const marker = text.indexOf("\nOutput:\n");
  if (marker >= 0 && /^(Chunk ID|Wall time|Exit code|Process )/m.test(text.slice(0, marker + 1))) {
    const code = /^Exit code: (-?\d+)$/m.exec(text.slice(0, marker + 1));
    if (code) result.exitCode = Number(code[1]);
    text = text.slice(marker + "\nOutput:\n".length);
  }
  if (payload.success === false) result.status = "failed";
  result.output = text;
  return result;
}

function finishHistoryStep(step) {
  const out = pruned(step);
  if (typeof out.summary === "string") {
    const line = out.summary.replace(/\s+/g, " ").trim();
    out.summary = line.length > TIMELINE_CAPS.summary ? `${line.slice(0, TIMELINE_CAPS.summary - 1)}…` : line;
    if (!out.summary) delete out.summary;
  }
  if (out.input && typeof out.input === "object") {
    out.input = { ...out.input };
    for (const field of ["command", "prompt", "diff", "json"]) {
      if (typeof out.input[field] === "string") out.input[field] = clipText(out.input[field], TIMELINE_CAPS.inputField).text;
    }
  }
  if (typeof out.output === "string") {
    const clipped = clipText(out.output, TIMELINE_CAPS.historyOutput);
    out.output = clipped.text;
    if (clipped.truncated) out.outputTruncated = true;
  }
  return out;
}

export function createCodexTranscriptCollector() {
  // Slots keep file order. A slot is ready when it holds a finished step, and
  // is dropped when an executed item covered the call it was holding.
  let slots = [];
  const calls = new Map(); // call_id -> slot
  const seenIds = new Set();
  let reasoningSeen = new Set(); // per turn: reasoning text already emitted
  let fallbackId = 0;

  function addStep(step) {
    slots.push({ ready: true, step: finishHistoryStep(step) });
  }

  function resolve(slot, extra = {}) {
    if (slot.ready || slot.dropped) return;
    const call = slot.call;
    const described = describeCall(call);
    const declined = /rejected by user/i.test(extra.output || "");
    if (declined) extra = { ...extra, status: "cancelled", error: "Declined", output: undefined };
    const status = extra.status || (Number.isInteger(extra.exitCode) && extra.exitCode !== 0 && described.kind === "command" ? "failed" : "done");
    slot.step = finishHistoryStep({
      id: call.id,
      kind: described.kind,
      title: described.title,
      summary: described.summary,
      status,
      startedAt: call.startedAt,
      endedAt: extra.endedAt || call.startedAt,
      input: described.input,
      exitCode: described.kind === "command" ? extra.exitCode : undefined,
      output: extra.output,
      error: extra.error,
    });
    slot.ready = true;
    calls.delete(call.id);
  }

  function drop(slot) {
    slot.dropped = true;
    if (slot.call) calls.delete(slot.call.id);
  }

  function holdCall(payload, timestamp) {
    const id = payload.call_id || payload.id || `call-${++fallbackId}`;
    if (calls.has(id) || seenIds.has(id)) return;
    const slot = {
      ready: false,
      call: {
        id,
        type: payload.type,
        name: String(payload.name || (payload.type === "local_shell_call" ? "local_shell" : "tool")),
        namespace: payload.namespace,
        args: parseArguments(payload.arguments),
        input: typeof payload.input === "string" ? payload.input : "",
        action: payload.action,
        startedAt: isoTime(timestamp),
      },
    };
    slots.push(slot);
    calls.set(id, slot);
  }

  function endTurn() {
    // A call the turn ended without answering never ran to completion.
    for (const slot of [...calls.values()]) resolve(slot, { status: "cancelled" });
    reasoningSeen = new Set();
  }

  function reasoning(id, text, startedAt, endedAt) {
    if (!nonEmpty(text) || reasoningSeen.has(text) || (id && seenIds.has(id))) return;
    reasoningSeen.add(text);
    if (id) seenIds.add(id);
    addStep({ id: id || `reasoning-${++fallbackId}`, kind: "reasoning", title: "Thinking", status: "done", startedAt, endedAt, output: text });
  }

  function executedItem(payload, timestamp) {
    const raw = payload.item;
    if (!raw || typeof raw !== "object") return;
    // The spawn call carries the prompt; the activity pings add nothing to it.
    if (raw.type === "SubAgentActivity") return;
    const item = normalizeRolloutItem(raw);
    const described = describeCodexItem(item);
    if (!described) return;
    const endedAt = isoTime(payload.completed_at_ms) || isoTime(timestamp);
    const startedAt = isoTime(payload.started_at_ms) || endedAt;
    if (described.kind === "reasoning") {
      reasoning(item.id, described.output, startedAt, endedAt);
      return;
    }
    const id = item.id || `item-${++fallbackId}`;
    if (seenIds.has(id)) return;
    seenIds.add(id);
    // This item is the executed form of a call: by id for a direct call, and
    // by position for anything a code-mode script ran.
    const direct = calls.get(id);
    if (direct) drop(direct);
    for (const slot of [...calls.values()]) {
      if (slot.call.type === "custom_tool_call" && slot.call.name === "exec") drop(slot);
    }
    addStep({
      id,
      kind: described.kind,
      title: described.title,
      summary: described.summary,
      status: described.status && described.status !== "running" ? described.status : "done",
      startedAt,
      endedAt,
      input: described.input,
      exitCode: described.exitCode,
      output: described.output,
      error: described.error,
    });
  }

  return {
    push(entry) {
      if (!entry || typeof entry !== "object") return;
      const payload = entry.payload && typeof entry.payload === "object" ? entry.payload : null;
      if (!payload) return;
      const timestamp = entry.timestamp;
      if (entry.type === "event_msg") {
        if (payload.type === "item_completed") executedItem(payload, timestamp);
        else if (payload.type === "task_started" || payload.type === "task_complete" || payload.type === "turn_aborted") endTurn();
        return;
      }
      if (entry.type !== "response_item") return;
      switch (payload.type) {
        case "function_call":
        case "custom_tool_call":
        case "local_shell_call":
        case "tool_search_call":
          holdCall(payload, timestamp);
          return;
        case "function_call_output":
        case "custom_tool_call_output":
        case "local_shell_call_output":
        case "tool_search_output": {
          const slot = calls.get(payload.call_id);
          if (slot) resolve(slot, { ...readCallOutput(payload), endedAt: isoTime(timestamp) });
          return;
        }
        case "reasoning": {
          const text = (Array.isArray(payload.summary) ? payload.summary : [])
            .map((part) => (typeof part === "string" ? part : part?.text)).filter(nonEmpty).join("\n\n");
          reasoning(payload.id, text, isoTime(timestamp), isoTime(timestamp));
          return;
        }
        case "web_search_call": {
          const id = payload.id || `search-${++fallbackId}`;
          if (seenIds.has(id)) return;
          seenIds.add(id);
          const described = describeWebSearch({ action: camelAction(payload.action) });
          const at = isoTime(timestamp);
          addStep({ id, ...described, status: stepStatus(payload.status, "done"), startedAt: at, endedAt: at });
          return;
        }
        default:
      }
    },

    take() {
      const ready = [];
      const held = [];
      for (const slot of slots) {
        if (slot.dropped) continue;
        if (slot.ready) ready.push(slot.step);
        else held.push(slot);
      }
      slots = held;
      return ready;
    },
  };
}
