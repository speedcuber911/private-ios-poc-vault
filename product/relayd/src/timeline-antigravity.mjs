// relayd timeline-antigravity.mjs — turns Google Antigravity CLI (`agy`)
// `--output-format stream-json` events into canonical Relay timeline events.
import path from "node:path";

import { TIMELINE_CAPS, clipText } from "./timeline.mjs";
import { isResumableSessionId } from "./sessionid.mjs";

const BUILTIN_KINDS = Object.freeze({
  run_command: "command",
  view_file: "read",
  read_file: "read",
  replace_file_content: "edit",
  multi_replace_file_content: "edit",
  edit_file: "edit",
  sed_file: "edit",
  write_to_file: "write",
  write_file: "write",
  grep_search: "search",
  find_by_name: "search",
  list_dir: "search",
  search_web: "fetch",
  read_url_content: "fetch",
  open_browser_url: "fetch",
  invoke_subagent: "agent",
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

function readRange(params) {
  const start = Number.isInteger(params.StartLine)
    ? params.StartLine
    : Number.isInteger(params.start_line)
      ? params.start_line
      : Number.isInteger(params.offset)
        ? params.offset
        : null;
  const end = Number.isInteger(params.EndLine)
    ? params.EndLine
    : Number.isInteger(params.end_line)
      ? params.end_line
      : null;
  const limit = Number.isInteger(params.limit) ? params.limit : null;
  if (start !== null && end !== null) return `${start}-${end}`;
  if (start !== null && limit !== null) return `${start}-${start + limit - 1}`;
  if (start !== null) return `${start}-`;
  if (limit !== null) return `1-${limit}`;
  return "";
}

function normalizeSessionId(value) {
  const trimmed = str(value).trim();
  if (!trimmed) return "";
  const lower = trimmed.toLowerCase();
  return isResumableSessionId(lower) ? lower : trimmed;
}

// Static description of an Antigravity tool call from its name and parameters.
// Returns { kind, title, summary?, input, agent? }.
export function describeAntigravityTool(name, rawParams, { cwd = "" } = {}) {
  const toolName = str(name) || "tool";
  const params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams) ? rawParams : {};
  const kind = BUILTIN_KINDS[toolName] || "tool";

  switch (kind) {
    case "command": {
      const command = str(params.CommandLine) || str(params.command) || str(params.cmd);
      const description = str(params.toolSummary) || str(params.description);
      const effectiveCwd = str(params.Cwd) || str(params.cwd) || cwd;
      return {
        kind,
        title: readableToolName(toolName) || "Run Command",
        summary: description || firstLine(command) || undefined,
        input: compact({
          command,
          description,
          cwd: effectiveCwd,
          background: params.IsDaemon === true ? true : undefined,
        }),
      };
    }
    case "read": {
      const file = str(params.Path) || str(params.AbsolutePath) || str(params.file_path) || str(params.path);
      return {
        kind,
        title: readableToolName(toolName) || "Read File",
        summary: baseName(file) || undefined,
        input: compact({ path: file, range: readRange(params) }),
      };
    }
    case "edit": {
      const file = str(params.Path) || str(params.TargetFile) || str(params.file_path) || str(params.path);
      let diff = "";
      if (Array.isArray(params.ReplacementChunks)) {
        diff = params.ReplacementChunks
          .filter((chunk) => chunk && typeof chunk === "object")
          .map((chunk) => editDiff(chunk.TargetContent, chunk.ReplacementContent))
          .filter(Boolean)
          .join("\n");
      } else if (params.Target !== undefined || params.Replacement !== undefined) {
        diff = editDiff(params.Target, params.Replacement);
      } else if (params.TargetContent !== undefined || params.ReplacementContent !== undefined) {
        diff = editDiff(params.TargetContent, params.ReplacementContent);
      } else if (params.old_string !== undefined || params.new_string !== undefined) {
        diff = editDiff(params.old_string, params.new_string);
      }
      return {
        kind,
        title: readableToolName(toolName) || "Edit File",
        summary: baseName(file) || undefined,
        input: compact({ path: file, diff }),
      };
    }
    case "write": {
      const file = str(params.Path) || str(params.TargetFile) || str(params.file_path) || str(params.path);
      const content = params.Content ?? params.CodeContent ?? params.content;
      return {
        kind,
        title: readableToolName(toolName) || "Write File",
        summary: baseName(file) || undefined,
        input: compact({ path: file, diff: prefixLines(str(content), "+") }),
      };
    }
    case "search": {
      const pattern = str(params.Query) || str(params.Pattern) || str(params.pattern) || str(params.query);
      const where = str(params.SearchPath)
        || str(params.SearchDirectory)
        || str(params.DirectoryPath)
        || str(params.Path)
        || str(params.path);
      return {
        kind,
        title: readableToolName(toolName) || "Search",
        summary: pattern || baseName(where) || undefined,
        input: compact({ pattern, path: where }),
      };
    }
    case "fetch": {
      const url = str(params.Url) || str(params.URL) || str(params.url);
      const query = str(params.query) || str(params.Query);
      return {
        kind,
        title: readableToolName(toolName) || "Fetch",
        summary: urlHost(url) || query || url || undefined,
        input: compact({ url, query }),
      };
    }
    case "agent": {
      const role = str(params.Role) || str(params.role);
      const typeName = str(params.TypeName) || str(params.subagent_type);
      const prompt = str(params.Prompt) || str(params.prompt);
      const description = role || str(params.description);
      return {
        kind,
        title: "Agent",
        summary: description || firstLine(prompt) || undefined,
        input: compact({ description, prompt, agentType: typeName }),
        agent: compact({ name: role || str(params.name), role: typeName }),
      };
    }
    default:
      return {
        kind: "tool",
        title: readableToolName(toolName) || toolName,
        summary: str(params.toolSummary) || str(params.description) || str(params.query) || str(params.subject) || undefined,
        input: compact({ name: toolName, json: safeJson(params) }),
      };
  }
}

export function legacyAntigravityStepLine(step) {
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

function subagentInfoPatch(subagentInfo, fallbackStatus) {
  const list = Array.isArray(subagentInfo?.subagents) ? subagentInfo.subagents : [];
  if (list.length === 0) return null;
  const first = list[0];
  if (!first || typeof first !== "object") return null;
  const rawStatus = str(first.status || first.state).toLowerCase();
  const status = rawStatus === "done" || rawStatus === "completed" || rawStatus === "succeeded"
    ? "done"
    : rawStatus === "failed" || rawStatus === "error"
      ? "failed"
      : rawStatus === "active" || rawStatus === "running" || rawStatus === "working"
        ? "working"
        : fallbackStatus;
  return compact({
    id: str(first.conversation_id) || str(first.id),
    name: str(first.name) || str(first.role),
    role: str(first.type) || str(first.role),
    status,
  });
}

function describeToolCompletion(tool, toolInfo, subagentInfo) {
  const errorValue = toolInfo?.error;
  const failed = Boolean(errorValue);
  const errorMessage = typeof errorValue === "string"
    ? errorValue
    : str(errorValue?.message) || str(errorValue?.type);
  const rawOutput = typeof toolInfo?.output === "string"
    ? toolInfo.output
    : toolInfo?.output !== undefined && toolInfo?.output !== null
      ? safeJson(toolInfo.output)
      : "";
  const fields = { status: failed ? "failed" : "done" };

  if (tool.kind === "command") {
    const exitMatch = /Command exited with code (\d+)/i.exec(rawOutput);
    if (exitMatch) fields.exitCode = Number(exitMatch[1]);
    else if (!failed) fields.exitCode = 0;
    if (failed) {
      fields.error = clipText(firstLine(errorMessage || rawOutput), TIMELINE_CAPS.summary).text || "Command failed";
    }
    if (rawOutput && rawOutput.trim() !== fields.error) fields.output = rawOutput;
    return fields;
  }

  if (tool.kind === "agent") {
    const patch = subagentInfoPatch(subagentInfo, failed ? "failed" : "done");
    const agent = { ...(tool.agent || {}), ...(patch || {}), status: patch?.status || (failed ? "failed" : "done") };
    if (Object.keys(agent).length > 0) fields.agent = agent;
    if (rawOutput) fields.output = rawOutput;
    if (failed) fields.error = clipText(firstLine(errorMessage || rawOutput), TIMELINE_CAPS.summary).text || "Agent failed";
    return fields;
  }

  if (failed) {
    fields.error = clipText(firstLine(errorMessage || rawOutput), TIMELINE_CAPS.summary).text || "Tool failed";
  }
  if (tool.kind === "search" || tool.kind === "fetch" || tool.kind === "tool") {
    if (rawOutput) fields.output = rawOutput;
  }
  return fields;
}

export function createAntigravityStreamMapper({ now = () => new Date().toISOString() } = {}) {
  const counters = { s: 0, a: 0, t: 0, r: 0 };
  // step_index string -> { id, kind, title, name, input, described, closed, agent }
  const steps = new Map();
  let cwd = "";
  let sessionId = "";
  let textId = "";
  let stepSinceText = true;
  let lastText = "";
  let sawText = false;
  let result = null;

  const nextId = (prefix) => `${prefix}${(counters[prefix] += 1)}`;

  function textEvent(delta) {
    if (!delta) return [];
    if (stepSinceText || !textId) {
      textId = nextId("t");
      stepSinceText = false;
      lastText = "";
    }
    sawText = true;
    lastText += delta;
    return [{ type: "text", id: textId, delta }];
  }

  function onInit(line) {
    const init = line.init && typeof line.init === "object" ? line.init : {};
    const convId = normalizeSessionId(line.conversation_id || init.conversation_id);
    if (convId) sessionId = convId;
    if (str(init.cwd)) cwd = str(init.cwd);
    return [];
  }

  function onStepUpdate(line) {
    const update = line.step_update && typeof line.step_update === "object" ? line.step_update : {};
    const convId = normalizeSessionId(update.conversation_id || line.conversation_id);
    if (convId) sessionId = convId;

    const stepType = str(update.step_type);
    const state = str(update.state).toUpperCase();
    const at = now();

    if (stepType === "user_input" || stepType === "checkpoint") {
      return [];
    }

    if (stepType === "agent_response") {
      const delta = str(update.text_delta);
      return delta ? textEvent(delta) : [];
    }

    if (stepType === "tool") {
      const toolInfo = update.tool_info && typeof update.tool_info === "object" ? update.tool_info : {};
      const toolName = str(toolInfo.name) || str(update.tool_name) || "tool";
      const params = toolInfo.parameters && typeof toolInfo.parameters === "object" && !Array.isArray(toolInfo.parameters)
        ? toolInfo.parameters
        : {};
      const hasParams = Object.keys(params).length > 0;
      const key = update.step_index !== undefined && update.step_index !== null ? String(update.step_index) : null;
      const isDone = state === "DONE" || state === "ERROR" || state === "FAILED";

      let tool = key !== null ? steps.get(key) : null;
      const detail = describeAntigravityTool(toolName, params, { cwd });
      const out = [];

      if (!tool) {
        const id = nextId(detail.kind === "agent" ? "a" : "s");
        tool = {
          id,
          kind: detail.kind,
          title: detail.title,
          name: toolName,
          input: hasParams ? detail.input : null,
          described: hasParams,
          closed: false,
          agent: detail.agent ? { ...detail.agent } : (detail.kind === "agent" ? {} : null),
        };
        if (key !== null) steps.set(key, tool);
        stepSinceText = true;

        const patch = detail.kind === "agent" ? subagentInfoPatch(update.subagent_info, "working") : null;
        if (patch) tool.agent = { ...(tool.agent || {}), ...patch };

        const event = compact({
          type: "step",
          id: tool.id,
          kind: detail.kind,
          title: detail.title,
          summary: detail.summary,
          status: "running",
          startedAt: at,
        });
        if (hasParams) event.input = detail.input;
        if (tool.agent && Object.keys(tool.agent).length > 0) event.agent = { ...tool.agent };

        if (isDone) {
          tool.closed = true;
          const completion = describeToolCompletion(tool, toolInfo, update.subagent_info);
          if (completion.agent) tool.agent = completion.agent;
          Object.assign(event, completion, { endedAt: at });
        }
        out.push(event);
        return out;
      }

      if (tool.closed) return [];

      if (isDone) {
        tool.closed = true;
        const completion = describeToolCompletion(tool, toolInfo, update.subagent_info);
        if (completion.agent) tool.agent = completion.agent;
        const event = { type: "step", id: tool.id, ...completion, endedAt: at };
        if (!tool.described && hasParams) {
          tool.input = detail.input;
          tool.described = true;
          if (detail.summary) event.summary = detail.summary;
          event.input = detail.input;
        }
        out.push(event);
        return out;
      }

      // Active update for an already-opened tool.
      const patch = {};
      if (!tool.described && hasParams) {
        tool.input = detail.input;
        tool.described = true;
        if (detail.summary) patch.summary = detail.summary;
        patch.input = detail.input;
      }
      if (tool.kind === "agent" && update.subagent_info) {
        const agentPatch = subagentInfoPatch(update.subagent_info, "working");
        if (agentPatch) {
          tool.agent = { ...(tool.agent || {}), ...agentPatch };
          patch.agent = { ...tool.agent };
        }
      }
      if (Object.keys(patch).length > 0) {
        out.push({ type: "step", id: tool.id, ...patch });
      }
      return out;
    }

    return [];
  }

  function onResult(line) {
    const res = line.result && typeof line.result === "object" ? line.result : {};
    const convId = normalizeSessionId(res.conversation_id || line.conversation_id);
    if (convId) sessionId = convId;

    const status = str(res.status).toUpperCase();
    const errorText = str(res.error);
    const responseText = str(res.response);
    const isError = (status !== "" && status !== "SUCCESS") || (Boolean(errorText) && status !== "SUCCESS");
    const text = isError ? (errorText || responseText) : responseText;

    result = {
      isError,
      status: status || (isError ? "ERROR" : "SUCCESS"),
      text,
      sessionId,
    };

    const out = [];
    if (!sawText && !isError && responseText) {
      out.push(...textEvent(responseText));
    }

    const usage = res.usage && typeof res.usage === "object" ? res.usage : null;
    if (usage) {
      const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
      const rawInput = count(usage.input_tokens);
      const cacheRead = count(usage.cache_read_tokens);
      const output = count(usage.output_tokens);
      const thinking = count(usage.thinking_tokens);
      const total = Number.isFinite(usage.total_tokens) ? usage.total_tokens : null;
      const inputTokens = total !== null && rawInput + output + thinking === total
        ? rawInput
        : rawInput + cacheRead;
      const outputTokens = output + thinking;
      if (inputTokens > 0 || outputTokens > 0 || Number.isFinite(usage.input_tokens) || Number.isFinite(usage.output_tokens)) {
        out.push({
          type: "usage",
          inputTokens,
          outputTokens,
        });
      }
    }
    return out;
  }

  return {
    push(line) {
      if (!line || typeof line !== "object") return [];
      switch (line.event) {
        case "init": return onInit(line);
        case "step_update": return onStepUpdate(line);
        case "result": return onResult(line);
        default: return [];
      }
    },
    finalAnswer() {
      return result && !result.isError ? result.text : "";
    },
    outcome() {
      return result;
    },
    lastProse() {
      return lastText;
    },
    sessionId() {
      return sessionId;
    },
  };
}
