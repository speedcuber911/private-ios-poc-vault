import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relayd-job-controls-"));
const workspace = path.join(dir, "workspace");
const skillFile = path.join(dir, "SKILL.md");
fs.mkdirSync(workspace, { recursive: true });
fs.writeFileSync(skillFile, "# Review\n\nUse the review checklist once.\n");

process.env.CODEX_DATA_DIR = path.join(dir, "data");
process.env.CODEX_RUN_HOME = path.join(dir, "home");
process.env.CODEX_HOME = path.join(dir, "home", ".codex");
process.env.CODEX_WORKSPACE_BROWSE_ROOT = dir;
process.env.CODEX_WORKSPACES = JSON.stringify([{ id: "scratch", name: "Scratch", path: workspace }]);
process.env.RELAYD_CODEX_TRANSPORT = "app-server";

const { buildJobPrompt, buildJobEnv } = await import("../src/jobs.mjs");

test("Codex app-server receives each selected skill once as a structured input", () => {
  const skill = { id: "review", name: "review", file: skillFile, kind: "skill" };
  const prompt = buildJobPrompt("Review the change.", "codex", [skill], []);
  assert.equal(prompt, "Review the change.");

  const env = buildJobEnv({
    id: "job-1",
    provider: "codex",
    workspacePath: workspace,
    resultPath: path.join(dir, "answer.md"),
    approvalPolicy: "on-request",
    skillInputs: [{ name: skill.name, path: skill.file, kind: skill.kind }],
  });
  assert.deepEqual(JSON.parse(env.RELAY_CODEX_SKILL_INPUTS), [
    { name: "review", path: skillFile, kind: "skill" },
  ]);
});

test("Claude keeps provider skills in its prompt and never receives Codex skill inputs", () => {
  const skill = { id: "review", name: "review", file: skillFile, kind: "skill" };
  const prompt = buildJobPrompt("Review the change.", "claude", [skill], []);
  assert.equal(prompt.match(/Use the review checklist once\./g)?.length, 1);

  const env = buildJobEnv({
    id: "job-2",
    provider: "claude",
    workspacePath: workspace,
    resultPath: path.join(dir, "answer.md"),
    permissionMode: "manual",
    skillInputs: [{ name: skill.name, path: skill.file, kind: skill.kind }],
  });
  assert.deepEqual(JSON.parse(env.RELAY_CODEX_SKILL_INPUTS), []);
});
