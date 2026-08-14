// relayd adapters/claude.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const permissionServer = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "claude-permission-mcp.mjs");

function buildClaudeArgs(job) {
  const args = ["--print"];
  if (job.model) args.push("--model", job.model);
  args.push("--permission-mode", job.permissionMode || "manual");
  args.push("--mcp-config", JSON.stringify({
    mcpServers: {
      relay_approvals: {
        command: process.execPath,
        args: [permissionServer],
      },
    },
  }));
  args.push("--strict-mcp-config", "--permission-prompt-tool", "mcp__relay_approvals__approve");
  if (job.resumeSessionId) {
    args.push("--resume", job.resumeSessionId);
  } else {
    args.push("--session-id", job.sessionId);
  }
  return args;
}


export {
  buildClaudeArgs,
};
