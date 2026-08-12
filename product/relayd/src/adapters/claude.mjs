// relayd adapters/claude.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { dangerousMode } from "../config.mjs";

function buildClaudeArgs(job) {
  const args = ["--print"];
  if (dangerousMode) args.push("--dangerously-skip-permissions");
  if (job.model) args.push("--model", job.model);
  if (job.permissionMode) args.push("--permission-mode", job.permissionMode);
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
