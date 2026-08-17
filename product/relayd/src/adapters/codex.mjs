// relayd adapters/codex.mjs — extracted verbatim from relay-server/codex-api-deploy/server.mjs (W2-CORE, behavior-preserving).
import http from "node:http";
import https from "node:https";
import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function buildCodexArgs(job) {
  if (job.resumeSessionId) return buildCodexResumeArgs(job);
  // Approval and sandbox are top-level Codex flags. Keeping them before
  // `exec` also makes them valid for the narrower `exec resume` parser.
  const args = [
    "-a", job.approvalPolicy || "on-request",
    "--sandbox", "workspace-write",
    "exec", "-C", job.worktree?.path || job.workspacePath,
    "--skip-git-repo-check", "--ignore-rules",
  ];
  if (job.model) args.push("-m", job.model);
  if (job.reasoningEffort) args.push("-c", `model_reasoning_effort="${job.reasoningEffort}"`);
  args.push("-o", job.resultPath, "-");
  return args;
}


function buildCodexResumeArgs(job) {
  const args = [
    "-a", job.approvalPolicy || "on-request",
    "--sandbox", "workspace-write",
    "exec", "resume", "--skip-git-repo-check", "--ignore-rules",
  ];
  if (job.model) args.push("-m", job.model);
  if (job.reasoningEffort) args.push("-c", `model_reasoning_effort="${job.reasoningEffort}"`);
  args.push("-o", job.resultPath, job.resumeSessionId, "-");
  return args;
}


export {
  buildCodexArgs,
  buildCodexResumeArgs,
};
