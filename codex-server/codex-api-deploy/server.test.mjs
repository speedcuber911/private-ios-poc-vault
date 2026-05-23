import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
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

async function pathExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
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

async function waitForJob(baseUrl, jobId) {
  let job;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const response = await fetch(`${baseUrl}/v1/codex/jobs/${jobId}`);
    assert.equal(response.status, 200);
    job = await response.json();
    if (["succeeded", "failed", "cancelled", "timeout"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`job ${jobId} did not finish`);
}

async function startFakeAzureSpeech() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString("latin1"),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          durationMilliseconds: 1200,
          combinedPhrases: [{ text: "Run the smoke test from the phone." }],
          phrases: [
            {
              offsetMilliseconds: 0,
              durationMilliseconds: 1200,
              text: "Run the smoke test from the phone.",
              locale: "en-US",
              confidence: 0.98,
            },
          ],
        }),
      );
    });
  });

  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    endpoint: `http://127.0.0.1:${port}`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function startFakeCodexApi() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(req.method === "POST" ? 202 : 200, { "content-type": "application/json" });
      if (req.url === "/v1/codex/workspaces") {
        res.end(JSON.stringify({ workspaces: [{ id: "scratch", name: "Scratch" }] }));
        return;
      }
      res.end(JSON.stringify({ ok: true, url: req.url, body: body ? JSON.parse(body) : null }));
    });
  });

  const port = await freePort();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
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

async function makeAnswerCodex(tmpDir, answer) {
  const fakeCodex = path.join(tmpDir, "fake-codex-answer");
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
      "cat >/dev/null",
      "if [ -n \"$out\" ]; then cat > \"$out\" <<'ANSWER_EOF'",
      answer,
      "ANSWER_EOF",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function makeSkill(root, dirname, { name = dirname, description = "Use when testing dynamic skills.", body = "Follow this test skill." } = {}) {
  const skillDir = path.join(root, dirname);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      `# ${name}`,
      "",
      body,
      "",
    ].join("\n"),
  );
}

async function makeCacheWritingCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "fake-codex-cache");
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
      "mkdir -p \"$HOME/.npm/_cacache\" \"$HOME/.npm/_npx/tool\" \"$HOME/.npm/_logs\" \"$HOME/.bun/install/cache\" \"$NPM_CONFIG_CACHE\" \"$BUN_INSTALL_CACHE_DIR\" \"$CODEX_HOME/.tmp/plugin\"",
      "printf cache > \"$HOME/.npm/_cacache/blob\"",
      "printf npx > \"$HOME/.npm/_npx/tool/blob\"",
      "printf log > \"$HOME/.npm/_logs/debug.log\"",
      "printf bun > \"$HOME/.bun/install/cache/blob\"",
      "printf cache > \"$NPM_CONFIG_CACHE/blob\"",
      "printf bun > \"$BUN_INSTALL_CACHE_DIR/blob\"",
      "printf tmp > \"$CODEX_HOME/.tmp/plugin/blob\"",
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

async function makeArgEchoClaude(tmpDir) {
  const fakeClaude = path.join(tmpDir, "fake-claude-args");
  await fs.writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "prompt=$(cat)",
      "printf 'claude args:'",
      "for arg in \"$@\"; do printf ' [%s]' \"$arg\"; done",
      "printf '\\n'",
      "printf 'claude aws profile:%s\\n' \"$AWS_PROFILE\"",
      "printf 'claude aws access:%s\\n' \"${AWS_ACCESS_KEY_ID:-}\"",
      "printf 'claude cwd:%s\\n' \"$(pwd -P)\"",
      "printf 'claude prompt:%s\\n' \"$prompt\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeClaude;
}

async function makeFailingStdoutClaude(tmpDir) {
  const fakeClaude = path.join(tmpDir, "fake-claude-failing-stdout");
  await fs.writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "printf 'selected model failed on bedrock\\n'",
      "exit 1",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeClaude;
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

async function writeSessionTranscriptFile(codexHome, sessionId, cwd, { contextPrompt, userPrompt, assistantAnswer }) {
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
        content: [{ type: "input_text", text: contextPrompt ?? userPrompt }],
      },
    },
    ...(contextPrompt
      ? [
          {
            type: "response_item",
            timestamp: "2026-05-20T00:00:01.500Z",
            payload: {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: userPrompt }],
            },
          },
        ]
      : []),
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

async function writePersistedJob({
  dataDir,
  workspaceDir,
  id,
  stdout,
  stderr,
  result,
  provider = "codex",
  workspaceId = "scratch",
  workspaceName = "Scratch",
  sessionId = null,
}) {
  const jobsDir = path.join(dataDir, "jobs");
  const logsDir = path.join(dataDir, "logs");
  await fs.mkdir(jobsDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  const job = {
    id,
    status: "succeeded",
    provider,
    workspaceId,
    workspaceName,
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
    sessionId,
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

test("transcribes uploaded phone audio through configured Azure Speech endpoint", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const azure = await startFakeAzureSpeech();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    AZURE_SPEECH_ENDPOINT: azure.endpoint,
    AZURE_SPEECH_API_KEY: "test-key",
    AZURE_SPEECH_TRANSCRIPTION_MODEL: "mai-transcribe-1",
    AZURE_SPEECH_LOCALES: "en",
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/transcriptions`, {
      method: "POST",
      headers: {
        "content-type": "audio/wav",
        "x-audio-filename": "phone-prompt.wav",
      },
      body: Buffer.from("RIFFfake-phone-audio", "utf8"),
    });
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.text, "Run the smoke test from the phone.");
    assert.equal(body.provider, "azure-speech");
    assert.equal(body.model, "mai-transcribe-1");
    assert.equal(azure.requests.length, 1);
    assert.equal(azure.requests[0].method, "POST");
    assert.match(azure.requests[0].url, /^\/speechtotext\/transcriptions:transcribe\?api-version=2025-10-15$/);
    assert.equal(azure.requests[0].headers["ocp-apim-subscription-key"], "test-key");
    assert.match(azure.requests[0].headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.match(azure.requests[0].body, /name="audio"; filename="phone-prompt.wav"/);
    assert.match(azure.requests[0].body, /"model":"mai-transcribe-1"/);
  } finally {
    await server.stop();
    await azure.stop();
  }
});

test("transcription endpoint returns unavailable until Azure Speech is configured", async () => {
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
    const response = await fetch(`${server.baseUrl}/v1/codex/transcriptions`, {
      method: "POST",
      headers: { "content-type": "audio/wav" },
      body: Buffer.from("RIFFfake-phone-audio", "utf8"),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /Azure Speech is not configured/);
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
    contextPrompt: "# AGENTS.md instructions for /srv/codex-workspaces/poc-vault\n<INSTRUCTIONS>POC Vault</INSTRUCTIONS>\n<environment_context><cwd>/srv/codex-workspaces/poc-vault</cwd></environment_context>",
    userPrompt: "Use these Codex skills for this task: human-code-review.\n\nAudit the vault deployment shape",
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

test("returns bounded thread detail with transcript messages and job previews", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(tmpDir, "codex-home");
  const sessionId = "019e46a5-0000-7000-8000-000000000001";
  const jobId = "019e46a5-0000-7000-8000-000000000002";
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeSessionTranscriptFile(codexHome, sessionId, workspaceDir, {
    contextPrompt: "# AGENTS.md instructions for /srv/codex-workspaces/poc-vault\n<INSTRUCTIONS>POC Vault</INSTRUCTIONS>\n<environment_context><cwd>/srv/codex-workspaces/poc-vault</cwd></environment_context>",
    userPrompt: "Use these Codex skills for this task: human-code-review.\n\nReview this iPhone-created thread",
    assistantAnswer: "The thread completed and wrote a concise answer.",
  });
  await writePersistedJob({
    dataDir,
    workspaceDir,
    id: jobId,
    stdout: "job stdout tail",
    stderr: "",
    result: "job answer",
  });

  const persistedJobPath = path.join(dataDir, "jobs", `${jobId}.json`);
  const persistedJob = JSON.parse(await fs.readFile(persistedJobPath, "utf8"));
  persistedJob.sessionId = sessionId;
  persistedJob.prompt = "Review this iPhone-created thread";
  await fs.writeFile(persistedJobPath, `${JSON.stringify(persistedJob, null, 2)}\n`);

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/threads/${sessionId}`);
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.thread.id, sessionId);
    assert.equal(body.thread.workspaceId, "scratch");
    assert.equal(body.thread.jobCount, 1);
    assert.deepEqual(
      body.messages.map((message) => [message.role, message.text]),
      [
        ["user", "Review this iPhone-created thread"],
        ["assistant", "The thread completed and wrote a concise answer."],
      ],
    );
    assert.equal(body.jobs.length, 1);
    assert.equal(body.jobs[0].id, jobId);
    assert.equal(body.jobs[0].sessionId, sessionId);
    assert.equal(body.jobs[0].logsIncluded, "compact");
    assert.equal(body.jobs[0].resultPreview, "job answer");
  } finally {
    await server.stop();
  }
});

test("serves the Codex thread web UI from the authenticated API namespace", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: path.join(tmpDir, "codex-home"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/ui`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), /^text\/html/);
    const html = await response.text();
    assert.match(html, /data-codex-thread-ui="true"/);
    assert.match(html, /\/v1\/codex\/threads/);
  } finally {
    await server.stop();
  }
});

test("proxies authenticated Codex routes to a configured remote API for local browser use", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const upstream = await startFakeCodexApi();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: path.join(tmpDir, "codex-home"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CODEX_PROXY_BASE_URL: upstream.baseUrl,
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/workspaces`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { workspaces: [{ id: "scratch", name: "Scratch" }] });
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].url, "/v1/codex/workspaces");

    const ui = await fetch(`${server.baseUrl}/v1/codex/ui`);
    assert.equal(ui.status, 200);
    assert.equal(upstream.requests.length, 1);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "poc-vault",
        prompt: "continue this thread",
        resumeSessionId: "019e46a5-0000-7000-8000-000000000001",
      }),
    });
    assert.equal(create.status, 202);
    assert.equal(upstream.requests.length, 2);
    assert.equal(upstream.requests[1].method, "POST");
    assert.equal(upstream.requests[1].url, "/v1/codex/jobs");
    assert.deepEqual(JSON.parse(upstream.requests[1].body), {
      workspaceId: "poc-vault",
      prompt: "continue this thread",
      resumeSessionId: "019e46a5-0000-7000-8000-000000000001",
    });
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test("lists provider-specific skills discovered from runner homes", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const codexHome = path.join(tmpDir, "codex-home");
  const claudeHome = path.join(tmpDir, "claude-home");
  await makeSkill(path.join(codexHome, "skills"), "codex-review", {
    description: "Use when Codex should review a change.",
    body: "Codex review process.",
  });
  await makeSkill(path.join(codexHome, "superpowers", "skills"), "brainstorming", {
    description: "Use when exploring product direction before coding.",
    body: "Brainstorm first.",
  });
  await makeSkill(path.join(claudeHome, "skills"), "claude-debug", {
    description: "Use when Claude should debug a failure.",
    body: "Claude debug process.",
  });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_RUN_HOME: path.join(tmpDir, "run-home"),
    CODEX_HOME: codexHome,
    CLAUDE_HOME: claudeHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: tmpDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });

  try {
    const codexSkills = await fetch(`${server.baseUrl}/v1/codex/skills?provider=codex`);
    assert.equal(codexSkills.status, 200);
    const codexBody = await codexSkills.json();
    assert.deepEqual(codexBody.skills.map((skill) => skill.id), ["codex-review", "superpowers:brainstorming"]);
    assert.equal(codexBody.skills[0].provider, "codex");
    assert.equal(codexBody.skills[0].description, "Use when Codex should review a change.");
    assert.equal(codexBody.skills[0].path, undefined);

    const claudeSkills = await fetch(`${server.baseUrl}/v1/codex/skills?provider=claude`);
    assert.equal(claudeSkills.status, 200);
    const claudeBody = await claudeSkills.json();
    assert.deepEqual(claudeBody.skills.map((skill) => skill.id), ["claude-debug"]);
    assert.equal(claudeBody.skills[0].provider, "claude");
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

test("browses and selects only directories inside the workspace root", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const sigiqDir = path.join(browseRoot, "sigiq");
  const aiTutorDir = path.join(sigiqDir, "ai-tutor");
  const hiddenDir = path.join(sigiqDir, ".hidden");
  const outsideDir = path.join(tmpDir, "outside");
  await fs.mkdir(path.join(aiTutorDir, ".git"), { recursive: true });
  await fs.mkdir(path.join(aiTutorDir, "backend", "api"), { recursive: true });
  await fs.mkdir(hiddenDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.symlink(outsideDir, path.join(sigiqDir, "outside-link"));

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "sigiq", name: "SigiQ", path: sigiqDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const rootResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs`);
    assert.equal(rootResponse.status, 200);
    const rootBody = await rootResponse.json();
    assert.equal(rootBody.relativePath, "");
    assert.deepEqual(rootBody.entries.map((entry) => entry.name), ["sigiq"]);
    assert.equal(rootBody.entries[0].workspaceId, "sigiq");
    assert.equal(rootBody.entries[0].isRegistered, true);

    const sigiqResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs?path=sigiq`);
    assert.equal(sigiqResponse.status, 200);
    const sigiqBody = await sigiqResponse.json();
    assert.equal(sigiqBody.relativePath, "sigiq");
    assert.equal(sigiqBody.parentPath, await fs.realpath(browseRoot));
    assert.deepEqual(sigiqBody.entries.map((entry) => entry.name), ["ai-tutor"]);
    assert.equal(sigiqBody.entries[0].hasGit, true);
    assert.equal(sigiqBody.entries[0].workspaceId, "dir-sigiq-ai-tutor");

    const searchResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs?path=sigiq&q=tutor`);
    assert.equal(searchResponse.status, 200);
    const searchBody = await searchResponse.json();
    assert.deepEqual(searchBody.entries.map((entry) => entry.relativePath), ["sigiq/ai-tutor"]);

    const rootSearchResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs?q=ai-tutor`);
    assert.equal(rootSearchResponse.status, 200);
    const rootSearchBody = await rootSearchResponse.json();
    assert.deepEqual(rootSearchBody.entries.map((entry) => entry.relativePath), ["sigiq/ai-tutor"]);

    const createWorkspaceResponse = await fetch(`${server.baseUrl}/v1/codex/workspaces/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentPath: "sigiq", name: "new-workspace" }),
    });
    assert.equal(createWorkspaceResponse.status, 201);
    const createdWorkspace = await createWorkspaceResponse.json();
    assert.equal(createdWorkspace.id, "dir-sigiq-new-workspace");
    assert.equal(createdWorkspace.name, "SigiQ / new-workspace");
    assert.equal(createdWorkspace.path, await fs.realpath(path.join(sigiqDir, "new-workspace")));

    const createdListResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs?path=sigiq`);
    assert.equal(createdListResponse.status, 200);
    const createdListBody = await createdListResponse.json();
    assert(createdListBody.entries.some((entry) => entry.workspaceId === "dir-sigiq-new-workspace"));

    const badCreateResponse = await fetch(`${server.baseUrl}/v1/codex/workspaces/create`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parentPath: "sigiq", name: "../escape" }),
    });
    assert.equal(badCreateResponse.status, 400);

    const selectResponse = await fetch(`${server.baseUrl}/v1/codex/workspaces/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "sigiq/ai-tutor" }),
    });
    assert.equal(selectResponse.status, 200);
    const realAiTutorDir = await fs.realpath(aiTutorDir);
    assert.deepEqual(await selectResponse.json(), {
      id: "dir-sigiq-ai-tutor",
      name: "SigiQ / ai-tutor",
      path: realAiTutorDir,
    });

    const escapeResponse = await fetch(`${server.baseUrl}/v1/codex/workspaces/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(sigiqDir, "outside-link") }),
    });
    assert.equal(escapeResponse.status, 400);
    assert.match((await escapeResponse.json()).error, /workspace root/i);
  } finally {
    await server.stop();
  }
});

test("runs jobs and aggregates threads from a selected directory workspace", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const sigiqDir = path.join(browseRoot, "sigiq");
  const aiTutorDir = path.join(sigiqDir, "ai-tutor");
  const codexHome = path.join(tmpDir, "codex-home");
  const sessionId = "019e54ab-0000-7000-8000-000000000001";
  await fs.mkdir(aiTutorDir, { recursive: true });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: codexHome,
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "sigiq", name: "SigiQ", path: sigiqDir }]),
    CODEX_BIN: await makeSessionWritingCodex(tmpDir, sessionId),
  });
  try {
    const selected = await fetch(`${server.baseUrl}/v1/codex/workspaces/select`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: "sigiq/ai-tutor" }),
    });
    assert.equal(selected.status, 200);
    const workspace = await selected.json();
    assert.equal(workspace.id, "dir-sigiq-ai-tutor");

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: workspace.id, prompt: "run from child workspace", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.workspaceId, "dir-sigiq-ai-tutor");

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.workspaceId, "dir-sigiq-ai-tutor");
    assert.equal(job.workspaceName, "SigiQ / ai-tutor");
    assert.match(job.stdout, /session stdout: run from child workspace/);

    const parentCreate = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "sigiq", prompt: "run from parent workspace", timeoutMs: 5000 }),
    });
    assert.equal(parentCreate.status, 202);
    const parentJob = await waitForJob(server.baseUrl, (await parentCreate.json()).id);
    assert.equal(parentJob.status, "succeeded");
    assert.equal(parentJob.workspaceId, "sigiq");

    const scopedJobs = await fetch(`${server.baseUrl}/v1/codex/jobs?workspaceId=dir-sigiq-ai-tutor`);
    assert.equal(scopedJobs.status, 200);
    const scopedJobsBody = await scopedJobs.json();
    assert.deepEqual(scopedJobsBody.jobs.map((item) => item.workspaceId), ["dir-sigiq-ai-tutor"]);

    const threads = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=dir-sigiq-ai-tutor`);
    assert.equal(threads.status, 200);
    const threadBody = await threads.json();
    assert.deepEqual(threadBody.threads.map((thread) => thread.workspaceId), ["dir-sigiq-ai-tutor"]);
    assert.deepEqual(threadBody.threads.map((thread) => thread.workspaceName), ["SigiQ / ai-tutor"]);
  } finally {
    await server.stop();
  }
});

test("extracts response code artifacts and serves raw downloads and sandboxed previews", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const answer = [
    "Here is a tiny static app.",
    "",
    "```html index.html",
    "<main class=\"card\"><h1>Hello artifact</h1><button id=\"go\">Go</button></main>",
    "```",
    "",
    "```css styles.css",
    ".card { color: rebeccapurple; }",
    "```",
    "",
    "```js filename=app.js",
    "document.getElementById('go').textContent = 'Ready';",
    "```",
    "",
  ].join("\n");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeAnswerCodex(tmpDir, answer),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "build a static app", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.deepEqual(created.artifacts, []);

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.artifacts.length, 4);
    assert.deepEqual(
      job.artifacts.map((artifact) => [artifact.kind, artifact.filename, artifact.language]),
      [
        ["staticPreview", "index.html", "html"],
        ["code", "styles.css", "css"],
        ["code", "app.js", "js"],
        ["staticPreview", "preview.html", "html"],
      ],
    );
    assert.equal(job.artifacts[0].rawURL, `/v1/codex/jobs/${created.id}/artifacts/artifact-001/raw`);
    assert.equal(job.artifacts[0].previewURL, `/v1/codex/jobs/${created.id}/artifacts/artifact-001/preview`);
    assert.equal(job.artifacts[3].previewURL, `/v1/codex/jobs/${created.id}/artifacts/artifact-004/preview`);

    const raw = await fetch(`${server.baseUrl}${job.artifacts[0].rawURL}`);
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-disposition"), 'attachment; filename="index.html"');
    assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    assert.match(await raw.text(), /Hello artifact/);

    const preview = await fetch(`${server.baseUrl}${job.artifacts[3].previewURL}`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type"), /^text\/html/);
    const wrapper = await preview.text();
    assert.match(wrapper, /sandbox="allow-scripts"/);
    assert.match(wrapper, /srcdoc=/);
    assert.match(wrapper, /Hello artifact/);
    assert.match(wrapper, /rebeccapurple/);
    assert.match(wrapper, /getElementById/);

    const persisted = JSON.parse(await fs.readFile(path.join(dataDir, "jobs", `${created.id}.json`), "utf8"));
    assert.equal(persisted.artifacts.length, 4);
    assert.equal(persisted.artifacts[0].path.includes(path.join(dataDir, "artifacts", created.id)), true);
  } finally {
    await server.stop();
  }
});

test("keeps artifact extraction bounded and falls back from unsafe filenames", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const largeBlock = "x".repeat(1024 * 1024 + 1);
  const answer = [
    "```js ../../secret.env",
    "console.log('safe fallback');",
    "```",
    "",
    "```txt huge.txt",
    largeBlock,
    "```",
    "",
  ].join("\n");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeAnswerCodex(tmpDir, answer),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "return artifacts", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    const job = await waitForJob(server.baseUrl, created.id);

    assert.equal(job.status, "succeeded");
    assert.equal(job.artifacts.length, 1);
    assert.equal(job.artifacts[0].filename, "artifact-001.js");
    assert.equal(job.artifacts[0].bytes, "console.log('safe fallback');".length);
    assert.doesNotMatch(job.artifacts[0].rawURL, /\.\./);
  } finally {
    await server.stop();
  }
});

test("returns an empty artifact list when the response has no fenced code", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeAnswerCodex(tmpDir, "Plain answer without code fences."),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "answer plainly", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    const job = await waitForJob(server.baseUrl, created.id);

    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.artifacts, []);
  } finally {
    await server.stop();
  }
});

test("injects selected provider skills into the runner prompt and rejects unknown skills", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const codexHome = path.join(tmpDir, "codex-home");
  await fs.mkdir(workspaceDir, { recursive: true });
  await makeSkill(path.join(codexHome, "skills"), "human-code-review", {
    description: "Use when review comments should sound human.",
    body: "Rewrite review comments with a natural engineering tone.",
  });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });

  try {
    const blocked = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "audit this", skills: ["not-installed"], timeoutMs: 5000 }),
    });
    assert.equal(blocked.status, 400);
    assert.match(await blocked.text(), /skill is not available/);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        prompt: "audit this",
        skills: ["human-code-review"],
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.deepEqual(created.skills, ["human-code-review"]);

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.deepEqual(job.skills, ["human-code-review"]);
    assert.match(job.result, /Selected Codex skills/);
    assert.match(job.result, /human-code-review/);
    assert.match(job.result, /Rewrite review comments with a natural engineering tone/);
    assert.match(job.result, /User task:\naudit this/);
  } finally {
    await server.stop();
  }
});

test("saves job attachments and includes their paths in the Codex prompt", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        prompt: "Review this phone capture",
        timeoutMs: 5000,
        attachments: [
          {
            filename: "Screen Shot 2026.png",
            contentType: "image/png",
            dataBase64: Buffer.from("fake image bytes", "utf8").toString("base64"),
          },
        ],
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.attachments.length, 1);
    assert.equal(created.attachments[0].filename, "Screen-Shot-2026.png");
    assert.equal(created.attachments[0].contentType, "image/png");
    assert.equal(created.attachments[0].bytes, 16);

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
    assert.match(job.result, /Review this phone capture/);
    assert.match(job.result, /Attached files/);
    assert.match(job.result, /Screen-Shot-2026\.png/);
    assert.equal(await fs.readFile(job.attachments[0].path, "utf8"), "fake image bytes");
    assert.equal(job.attachments[0].path.startsWith(path.join(dataDir, "attachments", created.id)), true);
  } finally {
    await server.stop();
  }
});

test("prunes runner package caches after jobs finish", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const runHome = path.join(tmpDir, "run-home");
  const codexHome = path.join(runHome, ".codex");
  await fs.mkdir(workspaceDir, { recursive: true });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_RUN_HOME: runHome,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeCacheWritingCodex(tmpDir),
  });

  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "cache cleanup", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();

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
    assert.equal(await pathExists(path.join(runHome, ".npm", "_cacache")), false);
    assert.equal(await pathExists(path.join(runHome, ".npm", "_npx")), false);
    assert.equal(await pathExists(path.join(runHome, ".npm", "_logs")), false);
    assert.equal(await pathExists(path.join(runHome, ".bun", "install", "cache")), false);
    assert.equal(await pathExists(path.join(runHome, ".npm-cache")), false);
    assert.equal(await pathExists(path.join(runHome, ".bun-cache")), false);
    assert.equal(await pathExists(path.join(codexHome, ".tmp")), false);
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
    assert.equal(listJob.stdout, "xxx-tail");
    assert.equal(listJob.stdoutPreview, "xxx-tail");
    assert.equal(listJob.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(listJob.stdoutTruncated, true);
    assert.equal(listJob.stderr, "yyy-tail");
    assert.equal(listJob.stderrBytes, Buffer.byteLength(stderr));
    assert.equal(listJob.stderrTruncated, true);
    assert.equal(listJob.result, "result-z");
    assert.equal(listJob.resultBytes, Buffer.byteLength(result));
    assert.equal(listJob.resultTruncated, true);

    const detail = await fetch(`${server.baseUrl}/v1/codex/jobs/${jobId}`);
    assert.equal(detail.status, 200);
    const detailJob = await detail.json();
    assert.equal(detailJob.logsIncluded, "preview");
    assert.equal(detailJob.stdout, "xxxxxxxxxxx-tail");
    assert.equal(detailJob.stdoutPreview, "xxxxxxxxxxx-tail");
    assert.equal(detailJob.stdoutBytes, Buffer.byteLength(stdout));
    assert.equal(detailJob.stdoutTruncated, true);
    assert.equal(detailJob.stderr, "yyyyyyyyyyy-tail");
    assert.equal(detailJob.stderrTruncated, true);
    assert.equal(detailJob.result, "result-zzzzzzzzz");
    assert.equal(detailJob.resultPreview, "result-zzzzzzzzz");
    assert.equal(detailJob.resultTruncated, true);

    const full = await fetch(`${server.baseUrl}/v1/codex/jobs/${jobId}?include=fullLogs`);
    assert.equal(full.status, 200);
    const fullJob = await full.json();
    assert.equal(fullJob.logsIncluded, "full");
    assert.equal(fullJob.stdout, stdout);
    assert.equal(fullJob.stdoutPreview, "xxxxxxxxxxx-tail");
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

test("persists providers and filters jobs, sessions, and threads by provider", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(tmpDir, "codex-home");
  const codexSessionId = "019e46b0-0000-7000-8000-000000000001";
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeSessionFile(codexHome, codexSessionId, workspaceDir);
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CLAUDE_BIN: await makeArgEchoClaude(tmpDir),
  });
  try {
    const codexCreate = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "codex default", timeoutMs: 5000 }),
    });
    assert.equal(codexCreate.status, 202);
    const codexJob = await codexCreate.json();
    assert.equal(codexJob.provider, "codex");

    const claudeCreate = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "claude", prompt: "claude work", timeoutMs: 5000 }),
    });
    assert.equal(claudeCreate.status, 202);
    const claudeJob = await claudeCreate.json();
    assert.equal(claudeJob.provider, "claude");
    assert.equal(claudeJob.model, "sonnet");
    assert.match(claudeJob.sessionId, /^[a-f0-9-]{36}$/);

    const finishedCodexJob = await waitForJob(server.baseUrl, codexJob.id);
    assert.equal(finishedCodexJob.status, "succeeded");
    assert.equal(finishedCodexJob.provider, "codex");
    const finishedClaudeJob = await waitForJob(server.baseUrl, claudeJob.id);
    assert.equal(finishedClaudeJob.status, "succeeded");
    assert.equal(finishedClaudeJob.provider, "claude");
    assert.match(finishedClaudeJob.stdout, /--model\] \[sonnet\]/);
    assert.match(finishedClaudeJob.stdout, /claude aws profile:sigiq/);

    const claudeJobs = await fetch(`${server.baseUrl}/v1/codex/jobs?provider=claude&limit=20`);
    assert.equal(claudeJobs.status, 200);
    assert.deepEqual((await claudeJobs.json()).jobs.map((job) => job.id), [claudeJob.id]);

    const codexSessions = await fetch(`${server.baseUrl}/v1/codex/sessions?provider=codex&limit=20`);
    assert.equal(codexSessions.status, 200);
    const codexSessionBody = await codexSessions.json();
    assert.deepEqual(codexSessionBody.sessions.map((session) => session.id), [codexSessionId]);
    assert.equal(codexSessionBody.sessions[0].provider, "codex");

    const claudeSessions = await fetch(`${server.baseUrl}/v1/codex/sessions?provider=claude&limit=20`);
    assert.equal(claudeSessions.status, 200);
    const claudeSessionBody = await claudeSessions.json();
    assert.deepEqual(claudeSessionBody.sessions.map((session) => session.id), [claudeJob.sessionId]);
    assert.equal(claudeSessionBody.sessions[0].provider, "claude");

    const claudeThreads = await fetch(`${server.baseUrl}/v1/codex/threads?provider=claude&limit=20`);
    assert.equal(claudeThreads.status, 200);
    const claudeThreadBody = await claudeThreads.json();
    assert.deepEqual(claudeThreadBody.threads.map((thread) => thread.sessionId), [claudeJob.sessionId]);
    assert.equal(claudeThreadBody.threads[0].provider, "claude");

    const codexThreadDetail = await fetch(`${server.baseUrl}/v1/codex/threads/${codexSessionId}?provider=codex`);
    assert.equal(codexThreadDetail.status, 200);
    assert.equal((await codexThreadDetail.json()).thread.provider, "codex");
  } finally {
    await server.stop();
  }
});

test("runs Claude jobs with configured binary, stdin prompt, and stdout result", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const realWorkspaceDir = await fs.realpath(workspaceDir);
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CLAUDE_BIN: await makeArgEchoClaude(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "claude",
        prompt: "explain the run",
        model: "sonnet",
        reasoningEffort: "high",
        permissionMode: "plan",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.provider, "claude");
    assert.match(created.sessionId, /^[a-f0-9-]{36}$/);

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.provider, "claude");
    assert.equal(job.sessionId, created.sessionId);
    assert.equal(job.permissionMode, "plan");
    assert.equal(job.model, "sonnet");
    assert.equal(job.reasoningEffort, null);
    assert.match(job.stdout, new RegExp(`claude args: .*\\[--print\\].*\\[--dangerously-skip-permissions\\].*\\[--model\\] \\[sonnet\\].*\\[--permission-mode\\] \\[plan\\].*\\[--session-id\\] \\[${created.sessionId}\\]`));
    assert.doesNotMatch(job.stdout, /--effort/);
    assert.match(job.stdout, /claude aws profile:sigiq/);
    assert.match(job.stdout, /claude aws access:\n/);
    assert.match(job.stdout, new RegExp(`claude cwd:${realWorkspaceDir}`));
    assert.match(job.stdout, /claude prompt:explain the run/);
    assert.equal(job.result, job.stdout.trim());
  } finally {
    await server.stop();
  }
});

test("surfaces Claude stdout as the failure message when stderr is empty", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CLAUDE_BIN: await makeFailingStdoutClaude(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "claude",
        prompt: "fail with useful output",
        model: "sonnet",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "failed");
    assert.equal(job.error, "selected model failed on bedrock");
    assert.equal(job.result, "");
    assert.match(job.stdout, /selected model failed on bedrock/);
  } finally {
    await server.stop();
  }
});

test("rejects provider and workspace mismatches when resuming a provider-locked thread", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const scratchDir = path.join(tmpDir, "scratch");
  const otherDir = path.join(tmpDir, "other");
  const dataDir = path.join(tmpDir, "data");
  const sessionId = "019e46b1-0000-7000-8000-000000000001";
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.mkdir(otherDir, { recursive: true });
  await writePersistedJob({
    dataDir,
    workspaceDir: scratchDir,
    id: "019e46b1-0000-7000-8000-000000000002",
    stdout: "previous claude stdout",
    stderr: "",
    result: "previous claude result",
    provider: "claude",
    sessionId,
  });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_WORKSPACES: JSON.stringify([
      { id: "scratch", name: "Scratch", path: scratchDir },
      { id: "other", name: "Other", path: otherDir },
    ]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CLAUDE_BIN: await makeArgEchoClaude(tmpDir),
  });
  try {
    const wrongProvider = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "codex", prompt: "codex follow-up", resumeSessionId: sessionId }),
    });
    assert.equal(wrongProvider.status, 400);
    assert.match((await wrongProvider.json()).error, /provider/i);

    const wrongWorkspace = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "other", provider: "claude", prompt: "wrong workspace", resumeSessionId: sessionId }),
    });
    assert.equal(wrongWorkspace.status, 400);
    assert.match((await wrongWorkspace.json()).error, /workspace/i);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "claude", prompt: "right follow-up", resumeSessionId: sessionId }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.provider, "claude");
    assert.equal(created.sessionId, sessionId);

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.match(job.stdout, new RegExp(`claude args: .*\\[--print\\].*\\[--resume\\] \\[${sessionId}\\]`));
    assert.doesNotMatch(job.stdout, /\[--session-id\]/);
  } finally {
    await server.stop();
  }
});
