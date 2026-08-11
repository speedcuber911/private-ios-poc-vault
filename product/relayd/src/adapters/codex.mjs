// relayd adapters/codex.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { dangerousMode } from "../config.mjs";

function buildCodexArgs(job) {
  if (job.resumeSessionId) return buildCodexResumeArgs(job);

  // W2-MODULES: worktree handoff runs the job inside job.worktree.path when
  // enabled; identical to job.workspacePath otherwise.
  const args = ["exec", "-C", job.worktree?.path || job.workspacePath, "--skip-git-repo-check", "--ignore-rules"];
  if (dangerousMode) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", "workspace-write", "-a", "never");
  }
  if (job.model) args.push("-m", job.model);
  if (job.reasoningEffort) args.push("-c", `model_reasoning_effort="${job.reasoningEffort}"`);
  args.push("-o", job.resultPath);
  args.push("-");
  return args;
}


function buildCodexResumeArgs(job) {
  const args = ["exec", "resume", "--skip-git-repo-check", "--ignore-rules"];
  if (dangerousMode) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }
  if (job.model) args.push("-m", job.model);
  if (job.reasoningEffort) args.push("-c", `model_reasoning_effort="${job.reasoningEffort}"`);
  args.push("-o", job.resultPath);
  args.push(job.resumeSessionId, "-");
  return args;
}


export {
  buildCodexArgs,
  buildCodexResumeArgs,
};
