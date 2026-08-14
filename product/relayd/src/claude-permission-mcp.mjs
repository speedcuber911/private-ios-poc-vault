#!/usr/bin/env node
import readline from "node:readline";
import { ApprovalStore } from "./approval-store.mjs";

const jobId = requiredEnv("RELAY_JOB_ID");
const workspacePath = requiredEnv("RELAY_WORKSPACE_PATH");
const store = new ApprovalStore(requiredEnv("RELAY_APPROVAL_DIR"));
const controller = new AbortController();
const input = readline.createInterface({ input: process.stdin });

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.once(signal, () => {
    controller.abort(new Error(`received ${signal}`));
    input.close();
    process.stdin.destroy();
    setImmediate(() => process.exit(0));
  });
}

input.on("line", (line) => void handleLine(line));

async function handleLine(line) {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.method === "notifications/initialized") return;
  if (message.id === undefined) return;
  try {
    if (message.method === "initialize") {
      respond(message.id, {
        protocolVersion: message.params?.protocolVersion || "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "relay-approvals", version: "0.1.0" },
      });
      return;
    }
    if (message.method === "ping") { respond(message.id, {}); return; }
    if (message.method === "tools/list") {
      respond(message.id, { tools: [{
        name: "approve",
        description: "Ask the linked Relay phone whether Claude Code may use a tool.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: { type: "object", additionalProperties: true },
          },
          required: ["tool_name", "input"],
          additionalProperties: true,
        },
      }] });
      return;
    }
    if (message.method === "tools/call" && message.params?.name === "approve") {
      await handleApproval(message);
      return;
    }
    respondError(message.id, -32601, "method not found");
  } catch (error) {
    respondError(message.id, -32603, error.message || "internal error");
  }
}

async function handleApproval(message) {
  const args = message.params?.arguments || {};
  const toolName = String(args.tool_name || args.toolName || "Tool");
  const input = args.input && typeof args.input === "object" ? args.input : {};
  const record = store.create({
    jobId,
    provider: "claude",
    kind: claudeKind(toolName),
    title: claudeTitle(toolName),
    reason: args.reason,
    command: safeClaudePreview(toolName, input),
    cwd: typeof input.cwd === "string" ? input.cwd : workspacePath,
    toolName,
  });
  const resolution = await store.waitForDecision(record.id, { signal: controller.signal });
  const payload = resolution.decision.startsWith("accept")
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: resolution.message || "Denied from Relay." };
  respond(message.id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
}

function safeClaudePreview(toolName, input) {
  if (/bash/i.test(toolName) && typeof input.command === "string") return input.command;
  const target = input.file_path || input.path || input.pattern || input.url || input.query;
  return target === undefined ? toolName : `${toolName}: ${String(target)}`;
}
function claudeKind(toolName) {
  if (/bash/i.test(toolName)) return "command";
  if (/write|edit/i.test(toolName)) return "file_change";
  if (/web|fetch|search/i.test(toolName)) return "network";
  return "tool";
}
function claudeTitle(toolName) {
  const kind = claudeKind(toolName);
  if (kind === "command") return "Run command";
  if (kind === "file_change") return "Change workspace files";
  if (kind === "network") return "Use network tool";
  return `Use ${toolName}`;
}
function respond(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function respondError(id, code, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`); }
function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
