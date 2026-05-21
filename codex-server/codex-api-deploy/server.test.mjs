import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

async function freePort() {
  const server = (await import("node:net")).createServer();
  return await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForServer(baseUrl) {
  const deadline = Date.now() + 5000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError || new Error("server did not become ready");
}

async function startServer(env) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...process.env,
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForServer(baseUrl);
  return {
    baseUrl,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

async function makeFakeCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "fake-codex");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "out=''",
      "prev=''",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = '-o' ]; then out=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "prompt=$(cat)",
      "echo \"fake stdout: $prompt\"",
      "echo \"fake stderr\" >&2",
      "if [ -n \"$out\" ]; then printf 'clean answer: %s\\n' \"$prompt\" > \"$out\"; fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function makeArgEchoCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "fake-codex-args");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "prompt=$(cat)",
      "printf 'args:'",
      "for arg in \"$@\"; do printf ' [%s]' \"$arg\"; done",
      "printf '\\n'",
      "printf 'prompt:%s\\n' \"$prompt\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function makeSessionWritingCodex(tmpDir, sessionId) {
  const fakeCodex = path.join(tmpDir, "fake-codex-session");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      "out=''",
      "prev=''",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = '-o' ]; then out=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      "prompt=$(cat)",
      "session_dir=\"$CODEX_HOME/sessions/2026/05/21\"",
      "mkdir -p \"$session_dir\"",
      "session_file=\"$session_dir/rollout-2026-05-21T00-00-00-" + sessionId + ".jsonl\"",
      "printf '%s\\n' \"{\\\"type\\\":\\\"session_meta\\\",\\\"timestamp\\\":\\\"2026-05-21T00:00:00.000Z\\\",\\\"payload\\\":{\\\"id\\\":\\\"" + sessionId + "\\\",\\\"cwd\\\":\\\"$(pwd -P)\\\"}}\" > \"$session_file\"",
      "echo \"session stdout: $prompt\"",
      "if [ -n \"$out\" ]; then printf 'session answer: %s\\n' \"$prompt\" > \"$out\"; fi",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function writeSessionFile(codexHome, sessionId, cwd) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "20");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionDir, `rollout-2026-05-20T00-00-00-${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "session_meta",
      timestamp: "2026-05-20T00:00:00.000Z",
      payload: { id: sessionId, cwd },
    })}\n`,
  );
}

async function writeSessionTranscriptFile(codexHome, sessionId, cwd, { userPrompt, assistantAnswer }) {
  const sessionDir = path.join(codexHome, "sessions", "2026", "05", "20");
  await fs.mkdir(sessionDir, { recursive: true });
  const lines = [
    {
      type: "session_meta",
      timestamp: "2026-05-20T00:00:00.000Z",
      payload: { id: sessionId, cwd },
    },
    {
      type: "response_item",
      timestamp: "2026-05-20T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: userPrompt }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-05-20T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantAnswer }],
      },
    },
  ];
  await fs.writeFile(
    path.join(sessionDir, `rollout-2026-05-20T00-00-00-${sessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
  );
}

async function writePersistedJob({ dataDir, workspaceDir, id, stdout, stderr, result }) {
  const jobsDir = path.join(dataDir, "jobs");
  const logsDir = path.join(dataDir, "logs");
  await fs.mkdir(jobsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  const job = {
    id,
    status: "succeeded",
    workspaceId: "scratch",
    workspaceName: "Scratch",
    workspacePath: workspaceDir,
    prompt: "make a very loud thing",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:01.000Z",
    startedAt: "2026-05-21T00:00:00.000Z",
    finishedAt: "2026-05-21T00:00:01.000Z",
    durationMs: 1000,
    exitCode: 0,
    timedOut: false,
    stdoutPath: path.join(logsDir, `${id}.stdout.log`),
    stderrPath: path.join(logsDir, `${id}.stderr.log`),
    resultPath: path.join(logsDir, `${id}.answer.md`),
    result,
    error: null,
    certSubject: null,
    timeoutMs: 5000,
    model: null,
    reasoningEffort: null,
    resumeSessionId: null,
  };

  await fs.writeFile(job.stdoutPath, stdout);
  await fs.writeFile(job.stderrPath, stderr);
  await fs.writeFile(job.resultPath, result);
  await fs.writeFile(path.join(jobsDir, `${id}.json`), `${JSON.stringify(job, null, 2)}\n`);
}

test("mTLS allowlist gates API routes while healthz remains public", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "true",
    CODEX_ALLOWED_CERT_SUBJECTS: "CN=allowed",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const publicHealth = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(publicHealth.status, 200);

    const blocked = await fetch(`${server.baseUrl}/v1/codex/health`);
    assert.equal(blocked.status, 401);

    const allowed = await fetch(`${server.baseUrl}/v1/codex/health`, {
      headers: {
        "X-SSL-Client-Verify": "SUCCESS",
        "X-SSL-Client-S-DN": "CN=allowed",
      },
    });
    assert.equal(allowed.status, 200);
  } finally {
    await server.stop();
  }
});

test("lists EC2-native Codex threads with safe latest-job summaries", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(tmpDir, "codex-home");
  const sessionId = "019e46a3-0000-7000-8000-000000000001";
  const emptySessionId = "019e46a3-0000-7000-8000-000000000002";
  const jobId = "019e46a3-0000-7000-8000-000000000003";
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeSessionFile(codexHome, sessionId, workspaceDir);
  await writeSessionFile(codexHome, emptySessionId, workspaceDir);
  await writePersistedJob({
    dataDir,
    workspaceDir,
    id: jobId,
    stdout: "raw stdout should stay out of thread summaries",
    stderr: "raw stderr should stay out of thread summaries",
    result: "thread answer",
  });

  const jobPath = path.join(dataDir, "jobs", `${jobId}.json`);
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  job.sessionId = sessionId;
  job.prompt = "continue this thread";
  await fs.writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=scratch&limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.deepEqual(body.threads.map((thread) => thread.id).sort(), [emptySessionId, sessionId].sort());
    const activeThread = body.threads.find((thread) => thread.id === sessionId);
    assert.equal(activeThread.workspaceId, "scratch");
    assert.equal(activeThread.workspaceName, "Scratch");
    assert.equal(activeThread.hasSessionFile, true);
    assert.equal(activeThread.jobCount, 1);
    assert.equal(activeThread.activeJobCount, 0);
    assert.equal(activeThread.lastJobId, jobId);
    assert.equal(activeThread.lastJobStatus, "succeeded");
    assert.equal(activeThread.lastPrompt, "continue this thread");
    assert.equal(activeThread.lastResult, "thread answer");
    assert.equal("stdout" in activeThread, false);
    assert.equal("stderr" in activeThread, false);

    const emptyThread = body.threads.find((thread) => thread.id === emptySessionId);
    assert.equal(emptyThread.jobCount, 0);
    assert.equal(emptyThread.lastJobId, null);
  } finally {
    await server.stop();
  }
});

test("backfills readable thread summaries from session transcripts and flags smoke tests", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(tmpDir, "codex-home");
  const transcriptSessionId = "019e46a4-0000-7000-8000-000000000001";
  const smokeSessionId = "019e46a4-0000-7000-8000-000000000002";
  const smokeJobId = "019e46a4-0000-7000-8000-000000000003";
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeSessionTranscriptFile(codexHome, transcriptSessionId, workspaceDir, {
    userPrompt: "Audit the vault deployment shape",
    assistantAnswer: "The deployment uses mTLS and registered workspaces.",
  });
  await writeSessionFile(codexHome, smokeSessionId, workspaceDir);
  await writePersistedJob({
    dataDir,
    workspaceDir,
    id: smokeJobId,
    stdout: "ok",
    stderr: "",
    result: "codex-async-ok",
  });

  const jobPath = path.join(dataDir, "jobs", `${smokeJobId}.json`);
  const job = JSON.parse(await fs.readFile(jobPath, "utf8"));
  job.sessionId = smokeSessionId;
  job.prompt = "Reply with exactly codex-async-ok and nothing else.";
  await fs.writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`);

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=scratch&limit=10`);
    assert.equal(response.status, 200);
    const threads = (await response.json()).threads;

    const transcriptThread = threads.find((thread) => thread.id === transcriptSessionId);
    assert.equal(transcriptThread.lastPrompt, "Audit the vault deployment shape");
    assert.equal(transcriptThread.lastResult, "The deployment uses mTLS and registered workspaces.");
    assert.equal(transcriptThread.isSmokeTest, false);

    const smokeThread = threads.find((thread) => thread.id === smokeSessionId);
    assert.equal(smokeThread.isSmokeTest, true);
  } finally {
    await server.stop();
  }
});

test("resumes only sessions that belong to the selected workspace", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const codexHome = path.join(tmpDir, "codex-home");
  await fs.mkdir(workspaceDir, { recursive: true });
  const allowedSessionId = "019e469d-72cb-7ac2-a1d6-47b63a524b93";
  const blockedSessionId = "019e469e-337f-7210-a07a-108c7e6c2a93";
  await writeSessionFile(codexHome, allowedSessionId, workspaceDir);
  await writeSessionFile(codexHome, blockedSessionId, path.join(tmpDir, "other-workspace"));

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeArgEchoCodex(tmpDir),
  });
  try {
    const blocked = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "blocked", resumeSessionId: blockedSessionId }),
    });
    assert.equal(blocked.status, 400);
    assert.match((await blocked.json()).error, /does not belong to workspace/);

    const missing = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        prompt: "missing",
        resumeSessionId: "019e469f-0000-7000-8000-000000000000",
      }),
    });
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /session not found/);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        prompt: "hello again",
        model: "gpt-5.5",
        reasoningEffort: "high",
        resumeSessionId: allowedSessionId,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.resumeSessionId, allowedSessionId);
    assert.equal(created.sessionId, allowedSessionId);

    let job;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}`);
      assert.equal(response.status, 200);
      job = await response.json();
      if (job.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, "succeeded");
    assert.equal(job.sessionId, allowedSessionId);
    assert.match(job.stdout, new RegExp(`args: \\[exec\\] \\[resume\\].*\\[-m\\] \\[gpt-5.5\\].*\\[-c\\] \\[model_reasoning_effort="high"\\].*\\[-o\\].*\\[${allowedSessionId}\\] \\[-\\]`));
    assert.match(job.stdout, /prompt:hello again/);
  } finally {
    await server.stop();
  }
});

test("lists only sessions inside registered workspaces", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const codexHome = path.join(tmpDir, "codex-home");
  await fs.mkdir(workspaceDir, { recursive: true });
  const allowedSessionId = "019e46a0-0000-7000-8000-000000000001";
  const blockedSessionId = "019e46a0-0000-7000-8000-000000000002";
  await writeSessionFile(codexHome, allowedSessionId, workspaceDir);
  await writeSessionFile(codexHome, blockedSessionId, path.join(tmpDir, "other-workspace"));

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const all = await fetch(`${server.baseUrl}/v1/codex/sessions?limit=10`);
    assert.equal(all.status, 200);
    const allBody = await all.json();
    assert.deepEqual(allBody.sessions.map((session) => session.id), [allowedSessionId]);
    assert.equal(allBody.sessions[0].workspaceId, "scratch");
    assert.equal(allBody.sessions[0].workspaceName, "Scratch");
    assert.equal(allBody.sessions[0].cwd, workspaceDir);
    assert.equal("summary" in allBody.sessions[0], false);

    const filtered = await fetch(`${server.baseUrl}/v1/codex/sessions?workspaceId=scratch`);
    assert.equal(filtered.status, 200);
    assert.deepEqual((await filtered.json()).sessions.map((session) => session.id), [allowedSessionId]);
  } finally {
    await server.stop();
  }
});

test("creates an async job in a registered workspace and persists output", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const workspaces = await fetch(`${server.baseUrl}/v1/codex/workspaces`);
    assert.equal(workspaces.status, 200);
    assert.deepEqual((await workspaces.json()).workspaces.map((workspace) => workspace.id), ["scratch"]);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "hello from test", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.match(created.id, /^[a-f0-9-]+$/);
    assert.equal(created.workspaceId, "scratch");
    assert.match(created.status, /queued|running|succeeded/);

    let job;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}`);
      assert.equal(response.status, 200);
      job = await response.json();
      if (job.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, "succeeded");
    assert.equal(job.exitCode, 0);
    assert.equal(job.timedOut, false);
    assert.equal(job.result, "clean answer: hello from test");
    assert.match(job.stdout, /fake stdout: hello from test/);
    assert.match(job.stderr, /fake stderr/);

    const jobs = await fetch(`${server.baseUrl}/v1/codex/jobs?limit=10`);
    assert.equal(jobs.status, 200);
    assert.equal((await jobs.json()).jobs[0].id, created.id);
  } finally {
    await server.stop();
  }
});

test("job responses bound logs by default and return full logs only when requested", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  await fs.mkdir(workspaceDir, { recursive: true });
  const jobId = "019e46a1-0000-7000-8000-000000000001";
  const stdout = `stdout-${"x".repeat(40)}-tail`;
  const stderr = `stderr-${"y".repeat(40)}-tail`;
  const result = `result-${"z".repeat(40)}-tail`;
  await writePersistedJob({ dataDir, workspaceDir, id: jobId, stdout, stderr, result });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CODEX_RESPONSE_OUTPUT_BYTES: "16",
    CODEX_LIST_OUTPUT_BYTES: "8",
  });
  try {
    const list = await fetch(`${server.baseUrl}/v1/codex/jobs?limit=10`);
    assert.equal(list.status, 200);
    const listJob = (await list.json()).jobs[0];
    assert.equal(listJob.id, jobId);
    assert.equal(listJob.logsIncluded, "compact");
    assert.equal(listJob.stdout, "stdout-x");
    assert.equal(listJob.stdoutPreview, "stdout-x");
    assert.equal(listJob.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(listJob.stdoutTruncated, true);
    assert.equal(listJob.stderr, "stderr-y");
    assert.equal(listJob.stderrBytes, Buffer.byteLength(stderr));
    assert.equal(listJob.stderrTruncated, true);
    assert.equal(listJob.result, "result-z");
    assert.equal(listJob.resultBytes, Buffer.byteLength(result));
    assert.equal(listJob.resultTruncated, true);

    const detail = await fetch(`${server.baseUrl}/v1/codex/jobs/${jobId}`);
    assert.equal(detail.status, 200);
    const detailJob = await detail.json();
    assert.equal(detailJob.logsIncluded, "preview");
    assert.equal(detailJob.stdout, "stdout-xxxxxxxxx");
    assert.equal(detailJob.stdoutPreview, "stdout-xxxxxxxxx");
    assert.equal(detailJob.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(detailJob.stdoutTruncated, true);
    assert.equal(detailJob.stderr, "stderr-yyyyyyyyy");
    assert.equal(detailJob.stderrTruncated, true);
    assert.equal(detailJob.result, "result-zzzzzzzzz");
    assert.equal(detailJob.resultPreview, "result-zzzzzzzzz");
    assert.equal(detailJob.resultTruncated, true);

    const full = await fetch(`${server.baseUrl}/v1/codex/jobs/${jobId}?include=fullLogs`);
    assert.equal(full.status, 200);
    const fullJob = await full.json();
    assert.equal(fullJob.logsIncluded, "full");
    assert.equal(fullJob.stdout, stdout);
    assert.equal(fullJob.stdoutPreview, "stdout-xxxxxxxxx");
    assert.equal(fullJob.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(fullJob.stdoutTruncated, false);
    assert.equal(fullJob.stderr, stderr);
    assert.equal(fullJob.stderrTruncated, false);
    assert.equal(fullJob.result, result);
    assert.equal(fullJob.resultPreview, "result-zzzzzzzzz");
    assert.equal(fullJob.resultTruncated, false);
  } finally {
    await server.stop();
  }
});

test("persists the new Codex session id for fresh jobs when one workspace session appears", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const codexHome = path.join(tmpDir, "codex-home");
  const sessionId = "019e46a2-0000-7000-8000-000000000001";
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeSessionWritingCodex(tmpDir, sessionId),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "remember this", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.sessionId, null);

    let job;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}`);
      assert.equal(response.status, 200);
      job = await response.json();
      if (job.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, "succeeded");
    assert.equal(job.sessionId, sessionId);

    const restartedServer = await startServer({
      CODEX_REQUIRE_MTLS: "false",
      CODEX_DATA_DIR: path.join(tmpDir, "data"),
      CODEX_HOME: codexHome,
      CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
      CODEX_BIN: await makeFakeCodex(tmpDir),
    });
    try {
      const persisted = await fetch(`${restartedServer.baseUrl}/v1/codex/jobs/${created.id}`);
      assert.equal(persisted.status, 200);
      assert.equal((await persisted.json()).sessionId, sessionId);
    } finally {
      await restartedServer.stop();
    }
  } finally {
    await server.stop();
  }
});

test("passes model and reasoning effort to codex exec", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeArgEchoCodex(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        prompt: "knobs",
        model: "gpt-5.4",
        reasoningEffort: "low",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.model, "gpt-5.4");
    assert.equal(created.reasoningEffort, "low");

    let job;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const response = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}`);
      assert.equal(response.status, 200);
      job = await response.json();
      if (job.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(job.status, "succeeded");
    assert.match(job.stdout, /args: \[exec\].*\[-m\] \[gpt-5.4\].*\[-c\] \[model_reasoning_effort="low"\].*\[-o\]/);
  } finally {
    await server.stop();
  }
});
