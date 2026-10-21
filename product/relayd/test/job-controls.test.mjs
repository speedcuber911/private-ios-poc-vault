import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import http from "node:http";

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
process.env.CODEX_REQUIRE_MTLS = "true";
process.env.CODEX_ALLOWED_CERT_SUBJECTS = "CN=iphone";

const { buildJobPrompt, buildJobEnv, runtimeCacheTargets, submitJobInput, jobs, activeChildren, jobPath, loadPersistedJobs } = await import("../src/jobs.mjs");

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

test("job env prepares a private Codex arg0 temp dir for idle prune", () => {
  const env = buildJobEnv({
    id: "job-arg0",
    provider: "codex",
    workspacePath: workspace,
    resultPath: path.join(dir, "answer-arg0.md"),
  });
  const arg0 = path.join(process.env.CODEX_HOME, "tmp", "arg0");
  assert.equal(fs.existsSync(arg0), true);
  assert.equal(fs.statSync(arg0).mode & 0o777, 0o700);
  assert.equal(env.CODEX_HOME, process.env.CODEX_HOME);
  assert.equal(runtimeCacheTargets().includes(arg0), true);
});

test("job input API is authenticated, persistent, idempotent, and scoped to a live runner", async (t) => {
  const job = { id: "00000000-0000-4000-8000-000000000091", provider: "codex", status: "running", workspaceId: "scratch", workspacePath: workspace };
  const delivered = [];
  jobs.set(job.id, job);
  activeChildren.set(job.id, { child: { connected: true, send: (event, callback) => { delivered.push(event); callback(); } } });
  t.after(() => { jobs.delete(job.id); activeChildren.delete(job.id); });
  const { routeRequest } = await import("../src/server.mjs");
  const server = http.createServer((req, res) => routeRequest(req, res).catch((error) => {
    res.writeHead(error.status || 500); res.end(JSON.stringify({ error: error.message }));
  }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/v1/codex/jobs/${job.id}/messages`;
  const message = { id: "input-1", text: "Test the change", mode: "queue" };
  const post = (body, auth = true) => fetch(url, { method: "POST", headers: {
    "content-type": "application/json", ...(auth ? { "x-ssl-client-verify": "SUCCESS", "x-ssl-client-s-dn": "CN=iphone" } : {}),
  }, body: JSON.stringify(body) });
  assert.equal((await post(message, false)).status, 401);
  assert.equal((await post(message)).status, 202);
  assert.equal((await post(message)).status, 202);
  assert.equal(delivered.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(jobPath(job.id), "utf8")).inputMessages[0].text, message.text);
  assert.equal((await post({ ...message, text: "Different" })).status, 409);
  assert.equal((await post({ ...message, mode: "now" })).status, 202);
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].message.id, message.id);
  activeChildren.get(job.id).inputClosed = true;
  assert.equal((await post({ ...message, id: "too-late" })).status, 409);
  assert.equal((await post({ ...message, id: "bad", text: " " })).status, 400);
  assert.throws(() => submitJobInput({ ...job, provider: "kimi", id: "other" }, message), { status: 409 });

  loadPersistedJobs();
  assert.equal(jobs.get(job.id).status, "failed");
  assert.equal(jobs.get(job.id).inputMessages[0].status, "failed", "A daemon restart never reports undelivered input as sent");
});
