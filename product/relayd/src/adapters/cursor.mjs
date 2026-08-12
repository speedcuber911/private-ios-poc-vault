// relayd adapters/cursor.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isSafeJobId, cleanApiText } from "../util.mjs";

function buildCursorArgs(job) {
  const args = ["-p", "--force", "--trust", "--workspace", job.worktree?.path || job.workspacePath, "--output-format", "json"];
  if (job.model) args.push("--model", job.model);
  if (job.resumeSessionId) args.push("--resume", job.resumeSessionId);
  args.push(job.codexPrompt || job.prompt);
  return args;
}


function parseCursorResult(value) {
  try {
    const parsed = JSON.parse(cleanApiText(value).trim());
    if (!parsed || parsed.type !== "result" || parsed.subtype !== "success") return null;
    return {
      result: typeof parsed.result === "string" ? parsed.result : "",
      sessionId: typeof parsed.session_id === "string" && isSafeJobId(parsed.session_id) ? parsed.session_id : null,
    };
  } catch {
    return null;
  }
}


export {
  buildCursorArgs,
  parseCursorResult,
};
