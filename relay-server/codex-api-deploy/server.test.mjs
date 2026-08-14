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

function cleanTestProcessEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      !/^(?:AWS_|AZURE_|BEDROCK_|BUN_|CLAUDE_|CODEX_|CURSOR_|NPM_CONFIG_|npm_config_)/.test(name),
    ),
  );
}

async function isolatedRunnerEnv() {
  const runHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-home-"));
  return {
    CODEX_RUN_HOME: runHome,
    CODEX_HOME: path.join(runHome, ".codex"),
    CLAUDE_HOME: path.join(runHome, ".claude"),
    NPM_CONFIG_CACHE: path.join(runHome, ".npm-cache"),
    BUN_INSTALL_CACHE_DIR: path.join(runHome, ".bun-cache"),
  };
}

async function startServer(env) {
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...cleanTestProcessEnv(),
      ...(await isolatedRunnerEnv()),
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      RELAYD_CODEX_TRANSPORT: "exec",
      CLAUDE_CODE_USE_BEDROCK: "",
      CLAUDE_AWS_PROFILE: "sigiq",
      CLAUDE_AWS_REGION: "",
      CLAUDE_DEFAULT_MODEL: "",
      CLAUDE_SONNET_MODEL: "",
      AWS_REGION: "",
      AWS_DEFAULT_REGION: "",
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

async function startServerExpectExit(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: {
      ...cleanTestProcessEnv(),
      ...(await isolatedRunnerEnv()),
      CODEX_API_HOST: "127.0.0.1",
      CODEX_API_PORT: String(port),
      CODEX_REQUIRE_MTLS: "false",
      CODEX_DATA_DIR: await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-data-")),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return { ...exit, stdout, stderr };
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

async function readSse(response) {
  const events = [];
  let text = "";
  for await (const rawChunk of response.body) {
    text += Buffer.from(rawChunk).toString("utf8");
  }
  for (const block of text.split(/\r?\n\r?\n/)) {
    if (!block.trim()) continue;
    let currentEvent = "";
    let currentData = "";
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) currentEvent = line.slice(6).trim();
      if (line.startsWith("data:")) currentData += line.slice(5).trim();
    }
    if (currentEvent) {
      events.push({ event: currentEvent, data: JSON.parse(currentData || "{}") });
    }
  }
  return events;
}

async function startFakeAzureOpenAI() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n');
      res.write('data: {"choices":[{"delta":{"content":" from Azure"}}]}\n\n');
      res.end("data: [DONE]\n\n");
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

function awsEventStreamMessage(payload) {
  const payloadBuffer = Buffer.from(JSON.stringify(payload), "utf8");
  const totalLength = 12 + payloadBuffer.length + 4;
  const buffer = Buffer.alloc(totalLength);
  buffer.writeUInt32BE(totalLength, 0);
  buffer.writeUInt32BE(0, 4);
  buffer.writeUInt32BE(0, 8);
  payloadBuffer.copy(buffer, 12);
  buffer.writeUInt32BE(0, totalLength - 4);
  return buffer;
}

async function startFakeBedrockRuntime() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/vnd.amazon.eventstream" });
      res.write(awsEventStreamMessage({ contentBlockDelta: { delta: { text: "Hello" } } }));
      res.write(awsEventStreamMessage({ contentBlockDelta: { delta: { text: " from Bedrock" } } }));
      res.write(awsEventStreamMessage({ metadata: { usage: { inputTokens: 4, outputTokens: 6 } } }));
      res.end(awsEventStreamMessage({ messageStop: { stopReason: "end_turn" } }));
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
      "printf 'claude aws region:%s\\n' \"${AWS_REGION:-}\"",
      "printf 'claude aws access:%s\\n' \"${AWS_ACCESS_KEY_ID:-}\"",
      "printf 'claude cwd:%s\\n' \"$(pwd -P)\"",
      "printf 'claude prompt:%s\\n' \"$prompt\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeClaude;
}

async function makeFakeCursor(tmpDir, sessionId) {
  const fakeCursor = path.join(tmpDir, "fake-cursor-agent");
  const argsPath = path.join(tmpDir, "fake-cursor-args.txt");
  await fs.writeFile(
    fakeCursor,
    [
      "#!/bin/sh",
      `: > '${argsPath}'`,
      `for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> '${argsPath}'; done`,
      "cat >/dev/null",
      `printf '%s\\n' '${JSON.stringify({ type: "result", subtype: "success", result: "cursor answer", session_id: sessionId })}'`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { fakeCursor, argsPath };
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

async function makeEmptySuccessClaude(tmpDir) {
  const fakeClaude = path.join(tmpDir, "fake-claude-empty-success");
  await fs.writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      "printf '\\n'",
      "exit 0",
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

    const blockedModels = await fetch(`${server.baseUrl}/v1/codex/models`);
    assert.equal(blockedModels.status, 401);

    const allowed = await fetch(`${server.baseUrl}/v1/codex/health`, {
      headers: {
        "X-SSL-Client-Verify": "SUCCESS",
        "X-SSL-Client-S-DN": "CN=allowed",
      },
    });
    assert.equal(allowed.status, 200);

    const allowedModels = await fetch(`${server.baseUrl}/v1/codex/models`, {
      headers: {
        "X-SSL-Client-Verify": "SUCCESS",
        "X-SSL-Client-S-DN": "CN=allowed",
      },
    });
    assert.equal(allowedModels.status, 200);
  } finally {
    await server.stop();
  }
});

test("refuses to start when Claude Bedrock profile is not SigiQ", async () => {
  const result = await startServerExpectExit({
    CLAUDE_AWS_PROFILE: "personal",
  });

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /CLAUDE_AWS_PROFILE=sigiq/);
});

test("starts without an AWS profile for direct subscription runners", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify([{ id: "codex-cli", label: "Codex CLI", provider: "codex", modes: ["task"] }]),
    CLAUDE_AWS_PROFILE: "",
  });
  try {
    const response = await fetch(`${server.baseUrl}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    await server.stop();
  }
});

test("serves protected model catalog from server-side config", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const catalog = [
    {
      id: "gpt-4o",
      label: "GPT-4o (Azure)",
      provider: "azure",
      modes: ["chat"],
      azureDeployment: "gpt-4o",
      defaultOptions: { temperature: 0.25, maxTokens: 1234 },
    },
    {
      id: "codex-cli",
      label: "Codex CLI",
      provider: "codex",
      modes: ["task"],
    },
  ];
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify(catalog),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.models, catalog);
  } finally {
    await server.stop();
  }
});

test("keeps OpenCode routing secrets out of the public model catalog", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const apiKeyFile = path.join(tmpDir, "azure.key");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(apiKeyFile, "super-secret-key");
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify([
      {
        id: "azure-padhai/kimi-k2.6",
        label: "kimi-k2.6 (Azure Padhai)",
        provider: "azure",
        modes: ["chat"],
        azureDeployment: "kimi-k2.6",
        azureBaseURL: "https://padhai.example.com/openai/v1",
        azureApiKeyFile: apiKeyFile,
      },
    ]),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/models`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.models, [
      {
        id: "azure-padhai/kimi-k2.6",
        label: "kimi-k2.6 (Azure Padhai)",
        provider: "azure",
        modes: ["chat"],
        azureDeployment: "kimi-k2.6",
      },
    ]);
  } finally {
    await server.stop();
  }
});

test("streams Azure chat over SSE and exposes persisted chat thread history", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const azure = await startFakeAzureOpenAI();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify([
      {
        id: "gpt-4o",
        label: "GPT-4o (Azure)",
        provider: "azure",
        modes: ["chat"],
        azureDeployment: "gpt-4o",
      },
    ]),
    AZURE_OPENAI_ENDPOINT: azure.endpoint,
    AZURE_OPENAI_API_KEY: "azure-test-key",
    AZURE_OPENAI_API_VERSION: "2025-01-01-preview",
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        messages: [{ role: "user", content: "say hello" }],
        options: { temperature: 0.2, maxTokens: 64 },
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const events = await readSse(response);
    assert.deepEqual(events.map((entry) => entry.event), ["meta", "delta", "delta", "done"]);
    assert.match(events[0].data.threadId, /^[a-f0-9-]{36}$/);
    assert.equal(events[0].data.provider, "azure");
    assert.equal(events[1].data.text, "Hello");
    assert.equal(events[2].data.text, " from Azure");

    assert.equal(azure.requests.length, 1);
    assert.match(azure.requests[0].url, /^\/openai\/deployments\/gpt-4o\/chat\/completions\?api-version=2025-01-01-preview$/);
    assert.equal(azure.requests[0].headers["api-key"], "azure-test-key");
    assert.deepEqual(JSON.parse(azure.requests[0].body).messages, [{ role: "user", content: "say hello" }]);

    const threads = await fetch(`${server.baseUrl}/v1/codex/threads?provider=azure&limit=5`);
    assert.equal(threads.status, 200);
    const threadBody = await threads.json();
    assert.equal(threadBody.threads.length, 1);
    assert.equal(threadBody.threads[0].mode, "chat");
    assert.equal(threadBody.threads[0].provider, "azure");
    assert.equal(threadBody.threads[0].lastPrompt, "say hello");
    assert.equal(threadBody.threads[0].lastResult, "Hello from Azure");

    const detail = await fetch(`${server.baseUrl}/v1/codex/threads/${events[0].data.threadId}?provider=azure`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.thread.mode, "chat");
    assert.deepEqual(
      detailBody.messages.map((message) => ({ role: message.role, text: message.text })),
      [
        { role: "user", text: "say hello" },
        { role: "assistant", text: "Hello from Azure" },
      ],
    );

    const followUpResponse = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        threadId: events[0].data.threadId,
        messages: [
          { role: "user", content: "say hello" },
          { role: "assistant", content: "Hello from Azure" },
          { role: "user", content: "say it again" },
        ],
      }),
    });
    assert.equal(followUpResponse.status, 200);
    await readSse(followUpResponse);
    assert.deepEqual(JSON.parse(azure.requests[1].body).messages, [
      { role: "user", content: "say hello" },
      { role: "assistant", content: "Hello from Azure" },
      { role: "user", content: "say it again" },
    ]);

    const followUpDetail = await fetch(`${server.baseUrl}/v1/codex/threads/${events[0].data.threadId}?provider=azure`);
    assert.equal(followUpDetail.status, 200);
    const followUpDetailBody = await followUpDetail.json();
    assert.deepEqual(
      followUpDetailBody.messages.map((message) => ({ role: message.role, text: message.text })),
      [
        { role: "user", text: "say hello" },
        { role: "assistant", text: "Hello from Azure" },
        { role: "user", text: "say it again" },
        { role: "assistant", text: "Hello from Azure" },
      ],
    );
  } finally {
    await azure.stop();
    await server.stop();
  }
});

test("streams direct Codex subscription chat and persists its thread", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const fakeCodex = await makeAnswerCodex(tmpDir, "Hello from Codex subscription");
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: fakeCodex,
    CODEX_MODEL_CATALOG: JSON.stringify([
      {
        id: "codex-gpt-5.6-sol",
        label: "Codex · GPT-5.6 Sol",
        provider: "codex",
        modes: ["chat", "task"],
        taskModel: "gpt-5.6-sol",
      },
    ]),
    CLAUDE_AWS_PROFILE: "",
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "codex",
        model: "codex-gpt-5.6-sol",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    assert.equal(response.status, 200);
    const events = await readSse(response);
    assert.deepEqual(events.map((entry) => entry.event), ["meta", "delta", "done"]);
    assert.equal(events[0].data.provider, "codex");
    assert.equal(events[1].data.text, "Hello from Codex subscription");

    const threads = await fetch(`${server.baseUrl}/v1/codex/threads?provider=codex&limit=5`);
    assert.equal(threads.status, 200);
    const threadBody = await threads.json();
    assert.equal(threadBody.threads.length, 1);
    assert.equal(threadBody.threads[0].mode, "chat");
    assert.equal(threadBody.threads[0].provider, "codex");
  } finally {
    await server.stop();
  }
});

test("streams OpenCode Azure-compatible catalog entries with per-model key files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const apiKeyFile = path.join(tmpDir, "azure.key");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(apiKeyFile, "opencode-azure-key\n");
  const azure = await startFakeAzureOpenAI();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify([
      {
        id: "azure-padhai/kimi-k2.6",
        label: "kimi-k2.6 (Azure Padhai)",
        provider: "azure",
        modes: ["chat"],
        azureDeployment: "kimi-k2.6",
        azureBaseURL: azure.endpoint,
        azureApiKeyFile: apiKeyFile,
      },
    ]),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "azure-padhai/kimi-k2.6",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    assert.equal(response.status, 200);
    const events = await readSse(response);
    assert.deepEqual(events.map((entry) => entry.event), ["meta", "delta", "delta", "done"]);
    assert.equal(azure.requests.length, 1);
    assert.equal(azure.requests[0].url, "/chat/completions");
    assert.equal(azure.requests[0].headers.authorization, "Bearer opencode-azure-key");
    assert.equal(azure.requests[0].headers["api-key"], undefined);
    const upstreamBody = JSON.parse(azure.requests[0].body);
    assert.equal(upstreamBody.model, "kimi-k2.6");
    assert.deepEqual(upstreamBody.messages, [{ role: "user", content: "say hello" }]);
  } finally {
    await azure.stop();
    await server.stop();
  }
});

test("streams Bedrock chat with SigiQ profile credentials despite ambient AWS env", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const credentialsFile = path.join(tmpDir, "credentials");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    credentialsFile,
    [
      "[sigiq]",
      "aws_access_key_id=AKIASIGIQTEST",
      "aws_secret_access_key=sigiq-secret-test",
      "aws_session_token=sigiq-session-token",
      "",
      "[personal]",
      "aws_access_key_id=AKIAPERSONAL",
      "aws_secret_access_key=personal-secret",
      "",
    ].join("\n"),
  );
  const bedrock = await startFakeBedrockRuntime();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify([
      {
        id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        label: "Claude 3.5 Sonnet (Bedrock)",
        provider: "bedrock",
        modes: ["chat"],
      },
    ]),
    BEDROCK_RUNTIME_ENDPOINT: bedrock.endpoint,
    BEDROCK_REGION: "us-east-1",
    AWS_SHARED_CREDENTIALS_FILE: credentialsFile,
    AWS_PROFILE: "personal",
    AWS_ACCESS_KEY_ID: "AKIAAMBIENT",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "bedrock",
        model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    assert.equal(response.status, 200);
    const events = await readSse(response);
    assert.deepEqual(events.map((entry) => entry.event), ["meta", "delta", "delta", "usage", "done"]);
    assert.equal(events[1].data.text, "Hello");
    assert.equal(events[2].data.text, " from Bedrock");

    assert.equal(bedrock.requests.length, 1);
    assert.match(bedrock.requests[0].url, /^\/model\/anthropic\.claude-3-5-sonnet-20241022-v2%3A0\/converse-stream$/);
    assert.match(bedrock.requests[0].headers.authorization, /Credential=AKIASIGIQTEST\//);
    assert.doesNotMatch(bedrock.requests[0].headers.authorization, /AKIAAMBIENT|AKIAPERSONAL/);
    assert.equal(bedrock.requests[0].headers["x-amz-security-token"], "sigiq-session-token");
  } finally {
    await bedrock.stop();
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

test("deletes a workspace-scoped Codex thread transcript and persisted jobs", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(tmpDir, "codex-home");
  const sessionId = "019e46a6-0000-7000-8000-000000000001";
  const jobId = "019e46a6-0000-7000-8000-000000000002";
  await fs.mkdir(workspaceDir, { recursive: true });
  await writeSessionFile(codexHome, sessionId, workspaceDir);
  await writePersistedJob({
    dataDir,
    workspaceDir,
    id: jobId,
    stdout: "job stdout tail",
    stderr: "job stderr tail",
    result: "job answer",
    sessionId,
  });

  const sessionFile = path.join(
    codexHome,
    "sessions",
    "2026",
    "05",
    "20",
    `rollout-2026-05-20T00-00-00-${sessionId}.jsonl`,
  );
  const jobFile = path.join(dataDir, "jobs", `${jobId}.json`);
  const stdoutFile = path.join(dataDir, "logs", `${jobId}.stdout.log`);
  const stderrFile = path.join(dataDir, "logs", `${jobId}.stderr.log`);
  const resultFile = path.join(dataDir, "logs", `${jobId}.answer.md`);

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/threads/${sessionId}?workspaceId=scratch`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      deleted: true,
      threadId: sessionId,
      workspaceId: "scratch",
      deletedJobs: 1,
      deletedSessionFile: true,
    });

    const detail = await fetch(`${server.baseUrl}/v1/codex/threads/${sessionId}`);
    assert.equal(detail.status, 404);
    const deletedJob = await fetch(`${server.baseUrl}/v1/codex/jobs/${jobId}`);
    assert.equal(deletedJob.status, 404);

    await assert.rejects(fs.access(sessionFile));
    await assert.rejects(fs.access(jobFile));
    await assert.rejects(fs.access(stdoutFile));
    await assert.rejects(fs.access(stderrFile));
    await assert.rejects(fs.access(resultFile));
  } finally {
    await server.stop();
  }
});

test("does not read or delete a thread through the wrong workspace filter", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const otherWorkspaceDir = path.join(tmpDir, "other");
  const dataDir = path.join(tmpDir, "data");
  const codexHome = path.join(tmpDir, "codex-home");
  const sessionId = "019e46a7-0000-7000-8000-000000000001";
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(otherWorkspaceDir, { recursive: true });
  await writeSessionFile(codexHome, sessionId, workspaceDir);
  const sessionFile = path.join(
    codexHome,
    "sessions",
    "2026",
    "05",
    "20",
    `rollout-2026-05-20T00-00-00-${sessionId}.jsonl`,
  );

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_HOME: codexHome,
    CODEX_WORKSPACES: JSON.stringify([
      { id: "scratch", name: "Scratch", path: workspaceDir },
      { id: "other", name: "Other", path: otherWorkspaceDir },
    ]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const wrongDetail = await fetch(`${server.baseUrl}/v1/codex/threads/${sessionId}?workspaceId=other`);
    assert.equal(wrongDetail.status, 404);
    assert.match((await wrongDetail.json()).error, /thread not found/);

    const correctDetail = await fetch(`${server.baseUrl}/v1/codex/threads/${sessionId}?workspaceId=scratch`);
    assert.equal(correctDetail.status, 200);

    const response = await fetch(`${server.baseUrl}/v1/codex/threads/${sessionId}?workspaceId=other`, {
      method: "DELETE",
    });
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /thread not found/);
    await fs.access(sessionFile);
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
  await fs.mkdir(path.join(tmpDir, ".claude", "commands"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, ".claude", "commands", "project-review.md"),
    "---\ndescription: Review this project's current changes.\n---\nReview the current diff carefully.\n",
    "utf8",
  );
  await fs.mkdir(path.join(tmpDir, ".claude", "commands", "team"), { recursive: true });
  await fs.writeFile(
    path.join(tmpDir, ".claude", "commands", "team", "release.md"),
    "---\ndescription: Prepare this project's release.\n---\nPrepare the release carefully.\n",
    "utf8",
  );

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_RUN_HOME: path.join(tmpDir, "run-home"),
    CODEX_HOME: codexHome,
    CLAUDE_HOME: claudeHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: tmpDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CLAUDE_BIN: await makeArgEchoClaude(tmpDir),
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

    const projectCommands = await fetch(`${server.baseUrl}/v1/codex/skills?provider=claude&workspaceId=scratch`);
    assert.equal(projectCommands.status, 200);
    const projectBody = await projectCommands.json();
    assert.deepEqual(projectBody.skills.map((skill) => skill.id), ["command:project-review", "command:team:release", "claude-debug"]);
    assert.equal(projectBody.skills[0].name, "project-review");
    assert.equal(projectBody.skills[0].kind, "command");
    assert.equal(projectBody.skills[0].description, "Review this project's current changes.");

    const selectedCommand = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "claude",
        prompt: "Do the review",
        skills: ["command:project-review"],
      }),
    });
    assert.equal(selectedCommand.status, 202);
    const selectedJob = await selectedCommand.json();
    assert.deepEqual(selectedJob.skills, ["command:project-review"]);
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

test("rejects a signed-out Codex provider before queuing a job", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-auth-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const signedOutCodex = path.join(tmpDir, "signed-out-codex");
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.writeFile(
    signedOutCodex,
    [
      "#!/bin/sh",
      "if [ \"$1\" = \"--version\" ]; then echo \"fake-codex 9.9.9\"; exit 0; fi",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then echo \"Not logged in\" >&2; exit 1; fi",
      "echo \"job unexpectedly started\" >&2",
      "exit 9",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: signedOutCodex,
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "codex", prompt: "hello" }),
    });
    assert.equal(create.status, 503);
    assert.match((await create.json()).error, /Codex is not connected.*relay sync-auth/);

    const jobs = await (await fetch(`${server.baseUrl}/v1/codex/jobs`)).json();
    assert.deepEqual(jobs.jobs, []);
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

test("passes configured AWS region to Claude jobs", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: "ap-south-1",
    AWS_DEFAULT_REGION: "ap-south-1",
    CLAUDE_BIN: await makeArgEchoClaude(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "claude",
        prompt: "bedrock sonnet",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.model, "sonnet");

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.match(job.stdout, /--model\] \[sonnet\]/);
    assert.match(job.stdout, /claude aws region:ap-south-1/);
  } finally {
    await server.stop();
  }
});

test("keeps Claude jobs on the SigiQ AWS profile when the process AWS profile differs", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    AWS_PROFILE: "personal",
    CLAUDE_BIN: await makeArgEchoClaude(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "claude",
        prompt: "use sigiq bedrock",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.match(job.stdout, /claude aws profile:sigiq/);
    assert.doesNotMatch(job.stdout, /claude aws profile:personal/);
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
    assert.match(job.stdout, /claude args: .*\[--print\]/);
    assert.match(job.stdout, /\[--model\] \[sonnet\]/);
    assert.match(job.stdout, /\[--permission-mode\] \[plan\]/);
    assert.match(job.stdout, /\[--permission-prompt-tool\] \[mcp__relay_approvals__approve\]/);
    assert.match(job.stdout, new RegExp(`\\[--session-id\\] \\[${created.sessionId}\\]`));
    assert.doesNotMatch(job.stdout, /--dangerously-skip-permissions/);
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

test("marks empty successful Claude output as a failed job", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CLAUDE_BIN: await makeEmptySuccessClaude(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "claude",
        prompt: "write a plan",
        model: "sonnet",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "failed");
    assert.equal(job.result, "");
    assert.equal(job.error, "Claude exited successfully without producing output.");
    assert.equal(job.stdout, "\n");
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

test("runs Cursor Agent jobs and persists the returned session id", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const sessionId = "019e46b1-0000-7000-8000-000000000099";
  await fs.mkdir(workspaceDir, { recursive: true });
  const cursor = await makeFakeCursor(tmpDir, sessionId);
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_BIN: cursor.fakeCursor,
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "cursor",
        prompt: "check cursor",
        model: "auto",
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.provider, "cursor");

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result, "cursor answer");
    assert.equal(job.sessionId, sessionId);

    const args = (await fs.readFile(cursor.argsPath, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(0, 7), ["-p", "--force", "--trust", "--workspace", await fs.realpath(workspaceDir), "--output-format", "json"]);
    assert.ok(args.includes("--model"));
    assert.ok(args.includes("auto"));
    assert.equal(args.at(-1), "check cursor");
  } finally {
    await server.stop();
  }
});

test("lists jail files with dirs-first ordering, dotfiles, metadata, and pagination", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  await fs.mkdir(path.join(vaultDir, "docs"), { recursive: true });
  await fs.mkdir(path.join(vaultDir, ".git"), { recursive: true });
  await fs.writeFile(path.join(vaultDir, "readme.md"), "hello relay\n");
  await fs.writeFile(path.join(vaultDir, ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(vaultDir, "notes.txt"), "notes\n");

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "poc-vault", name: "POC Vault", path: vaultDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, "poc-vault");
    assert.equal(body.absolutePath, await fs.realpath(vaultDir));
    assert.equal(body.parentPath, await fs.realpath(browseRoot));
    assert.equal(body.workspace.id, "poc-vault");
    assert.equal(body.workspace.name, "POC Vault");
    assert.equal(body.offset, 0);
    assert.equal(body.total, 5);
    assert.equal(body.truncated, false);

    // Directories first, then files sorted by name; dotfiles (including .git) listed.
    assert.deepEqual(
      body.entries.map((entry) => [entry.name, entry.kind]),
      [
        [".git", "dir"],
        ["docs", "dir"],
        [".env", "file"],
        ["notes.txt", "file"],
        ["readme.md", "file"],
      ],
    );

    const docs = body.entries.find((entry) => entry.name === "docs");
    assert.equal(docs.workspaceId, "dir-poc-vault-docs");
    assert.equal(docs.workspaceName, "POC Vault / docs");
    assert.equal(docs.hasGit, false);
    assert.equal(docs.isRegistered, false);
    assert.match(docs.modifiedAt, /^\d{4}-\d{2}-\d{2}T/);

    const env = body.entries.find((entry) => entry.name === ".env");
    assert.equal(env.readDenied, true);
    assert.equal(env.isText, true);
    assert.equal(env.size, 9);

    const readme = body.entries.find((entry) => entry.name === "readme.md");
    assert.equal(readme.readDenied, false);
    assert.equal(readme.mime, "text/markdown; charset=utf-8");
    assert.equal(readme.isText, true);
    assert.equal(readme.size, 12);
    assert.equal(readme.path, "poc-vault/readme.md");

    // Pagination is explicit: offset/limit/total/truncated, no silent caps.
    const page = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault&offset=1&limit=2`);
    assert.equal(page.status, 200);
    const pageBody = await page.json();
    assert.equal(pageBody.offset, 1);
    assert.equal(pageBody.limit, 2);
    assert.equal(pageBody.total, 5);
    assert.equal(pageBody.truncated, true);
    assert.deepEqual(
      pageBody.entries.map((entry) => entry.name),
      body.entries.slice(1, 3).map((entry) => entry.name),
    );

    const badOffset = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault&offset=-1`);
    assert.equal(badOffset.status, 400);
    const badLimit = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault&limit=zero`);
    assert.equal(badLimit.status, 400);

    const rootList = await fetch(`${server.baseUrl}/v1/codex/fs/list`);
    assert.equal(rootList.status, 200);
    const rootBody = await rootList.json();
    assert.equal(rootBody.path, "");
    assert.equal(rootBody.parentPath, null);
    assert.equal(rootBody.workspace, null);
    assert.deepEqual(rootBody.entries.map((entry) => entry.name), ["poc-vault"]);
  } finally {
    await server.stop();
  }
});

test("rejects files API traversal, absolute escapes, symlink escapes, and non-files", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  const outsideDir = path.join(tmpDir, "outside");
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "secret.txt"), "outside secret\n");
  await fs.writeFile(path.join(vaultDir, "inside.txt"), "inside\n");
  await fs.symlink(outsideDir, path.join(vaultDir, "escape-dir"));
  await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(vaultDir, "escape-file"));

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "poc-vault", name: "POC Vault", path: vaultDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const traversalList = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=..%2Foutside`);
    assert.equal(traversalList.status, 400);

    const absoluteList = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=${encodeURIComponent(outsideDir)}`);
    assert.equal(absoluteList.status, 400);

    const traversalFile = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=..%2Foutside%2Fsecret.txt`);
    assert.equal(traversalFile.status, 400);
    assert.match((await traversalFile.json()).error, /workspace root/i);

    const absoluteFile = await fetch(
      `${server.baseUrl}/v1/codex/fs/file?path=${encodeURIComponent(path.join(outsideDir, "secret.txt"))}`,
    );
    assert.equal(absoluteFile.status, 400);

    const symlinkFile = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fescape-file`);
    assert.equal(symlinkFile.status, 400);
    assert.match((await symlinkFile.json()).error, /workspace root/i);

    const symlinkList = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault%2Fescape-dir`);
    assert.equal(symlinkList.status, 400);

    // Escaping symlinks are excluded from listings entirely.
    const listing = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault`);
    assert.equal(listing.status, 200);
    assert.deepEqual((await listing.json()).entries.map((entry) => entry.name), ["inside.txt"]);

    const directory = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault`);
    assert.equal(directory.status, 400);
    assert.match((await directory.json()).error, /regular file/i);

    const missing = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fnope.txt`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test("denies HTTP reads for secret-pattern files while still listing them", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.writeFile(path.join(vaultDir, ".env"), "SECRET=1\n");
  await fs.writeFile(path.join(vaultDir, ".env.production"), "SECRET=2\n");
  await fs.writeFile(path.join(vaultDir, "server.key"), "not-a-real-key\n");
  await fs.writeFile(path.join(vaultDir, "identity.p12"), "not-a-real-bundle\n");
  await fs.writeFile(path.join(vaultDir, ".netrc"), "machine example login x\n");
  await fs.writeFile(path.join(vaultDir, "credentials"), "not-real\n");
  await fs.writeFile(path.join(vaultDir, "app.txt"), "readable\n");

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "poc-vault", name: "POC Vault", path: vaultDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    for (const denied of [".env", ".env.production", "server.key", "identity.p12", ".netrc", "credentials"]) {
      const response = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2F${encodeURIComponent(denied)}`);
      assert.equal(response.status, 403, `${denied} should be read-denied`);
      assert.match((await response.json()).error, /denylist/i);
    }

    const allowed = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fapp.txt`);
    assert.equal(allowed.status, 200);
    assert.equal(await allowed.text(), "readable\n");

    const listing = await fetch(`${server.baseUrl}/v1/codex/fs/list?path=poc-vault`);
    const entries = (await listing.json()).entries;
    const deniedNames = entries.filter((entry) => entry.readDenied).map((entry) => entry.name).sort();
    assert.deepEqual(deniedNames, [".env", ".env.production", ".netrc", "credentials", "identity.p12", "server.key"]);
  } finally {
    await server.stop();
  }
});

test("honors a custom CODEX_FS_READ_DENYLIST", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.writeFile(path.join(vaultDir, "secret-notes.txt"), "hidden\n");
  await fs.writeFile(path.join(vaultDir, ".env"), "SECRET=1\n");

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "poc-vault", name: "POC Vault", path: vaultDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CODEX_FS_READ_DENYLIST: "secret-*",
  });
  try {
    const denied = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fsecret-notes.txt`);
    assert.equal(denied.status, 403);

    // The custom list replaces the default patterns entirely.
    const env = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2F.env`);
    assert.equal(env.status, 200);
  } finally {
    await server.stop();
  }
});

test("serves bounded file reads with HEAD, ranges, 206/416, caps, and safe dispositions", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  await fs.mkdir(vaultDir, { recursive: true });
  const smallContent = "small file body\n";
  const midContent = "x".repeat(1500) + "y".repeat(500);
  await fs.writeFile(path.join(vaultDir, "small.txt"), smallContent);
  await fs.writeFile(path.join(vaultDir, "mid.txt"), midContent);
  await fs.writeFile(path.join(vaultDir, "huge.txt"), "z".repeat(5000));
  await fs.writeFile(path.join(vaultDir, "page.html"), "<html><body>hi</body></html>");
  await fs.writeFile(path.join(vaultDir, "vector.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
  await fs.writeFile(path.join(vaultDir, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "poc-vault", name: "POC Vault", path: vaultDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CODEX_FS_MAX_READ_BYTES: "1024",
    CODEX_FS_MAX_FILE_BYTES: "4096",
  });
  try {
    const small = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fsmall.txt`);
    assert.equal(small.status, 200);
    assert.equal(small.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(small.headers.get("cache-control"), "no-store");
    assert.equal(small.headers.get("x-content-type-options"), "nosniff");
    assert.equal(small.headers.get("accept-ranges"), "bytes");
    assert.match(small.headers.get("content-disposition"), /^inline; filename="small.txt"$/);
    assert.equal(await small.text(), smallContent);

    const head = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fsmall.txt`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(smallContent.length));
    assert.equal(await head.text(), "");

    // Files above the read bound return the first bounded window as 206.
    const mid = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fmid.txt`);
    assert.equal(mid.status, 206);
    assert.equal(mid.headers.get("content-range"), "bytes 0-1023/2000");
    assert.equal(await mid.text(), midContent.slice(0, 1024));

    const midRange = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fmid.txt`, {
      headers: { range: "bytes=1024-1999" },
    });
    assert.equal(midRange.status, 206);
    assert.equal(midRange.headers.get("content-range"), "bytes 1024-1999/2000");
    assert.equal(await midRange.text(), midContent.slice(1024, 2000));

    const suffixRange = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fmid.txt`, {
      headers: { range: "bytes=-100" },
    });
    assert.equal(suffixRange.status, 206);
    assert.equal(suffixRange.headers.get("content-range"), "bytes 1900-1999/2000");
    assert.equal(await suffixRange.text(), midContent.slice(1900));

    const badRange = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fmid.txt`, {
      headers: { range: "bytes=5000-" },
    });
    assert.equal(badRange.status, 416);
    assert.equal(badRange.headers.get("content-range"), "bytes */2000");

    const malformedRange = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fmid.txt`, {
      headers: { range: "bytes=abc" },
    });
    assert.equal(malformedRange.status, 416);

    const headRange = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fmid.txt`, {
      method: "HEAD",
      headers: { range: "bytes=0-99" },
    });
    assert.equal(headRange.status, 206);
    assert.equal(headRange.headers.get("content-range"), "bytes 0-99/2000");
    assert.equal(await headRange.text(), "");

    // Files above the absolute cap are refused even for ranges.
    const huge = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fhuge.txt`);
    assert.equal(huge.status, 413);
    const hugeRange = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fhuge.txt`, {
      headers: { range: "bytes=0-10" },
    });
    assert.equal(hugeRange.status, 413);

    // Active content downloads by default and previews only when asked.
    const html = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fpage.html`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get("content-disposition"), /^attachment/);
    const svg = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fvector.svg`);
    assert.match(svg.headers.get("content-disposition"), /^attachment/);

    const preview = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fpage.html&preview=1`);
    assert.equal(preview.status, 200);
    assert.match(preview.headers.get("content-type"), /^text\/html/);
    const previewHtml = await preview.text();
    assert.match(previewHtml, /data-codex-artifact-preview="true"/);
    assert.match(previewHtml, /srcdoc=/);

    const badPreview = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fsmall.txt&preview=1`);
    assert.equal(badPreview.status, 400);

    const png = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fpic.png`);
    assert.equal(png.headers.get("content-type"), "image/png");
    assert.match(png.headers.get("content-disposition"), /^inline/);
    const forced = await fetch(`${server.baseUrl}/v1/codex/fs/file?path=poc-vault%2Fpic.png&download=1`);
    assert.match(forced.headers.get("content-disposition"), /^attachment/);
  } finally {
    await server.stop();
  }
});

test("keeps the legacy workspace-dirs response shape byte-identical (golden)", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const sigiqDir = path.join(browseRoot, "sigiq");
  const aiTutorDir = path.join(sigiqDir, "ai-tutor");
  await fs.mkdir(path.join(aiTutorDir, ".git"), { recursive: true });
  await fs.writeFile(path.join(sigiqDir, "loose-file.txt"), "files never appear in workspace-dirs\n");
  await fs.mkdir(path.join(sigiqDir, ".hidden"), { recursive: true });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "sigiq", name: "SigiQ", path: sigiqDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
  });
  try {
    const realRoot = await fs.realpath(browseRoot);
    const realSigiq = await fs.realpath(sigiqDir);
    const realAiTutor = await fs.realpath(aiTutorDir);

    const rootResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs`);
    assert.equal(rootResponse.status, 200);
    assert.deepEqual(await rootResponse.json(), {
      rootPath: realRoot,
      currentPath: realRoot,
      relativePath: "",
      parentPath: null,
      selectedWorkspace: null,
      entries: [
        {
          name: "sigiq",
          path: realSigiq,
          relativePath: "sigiq",
          workspaceId: "sigiq",
          workspaceName: "SigiQ",
          hasGit: false,
          isRegistered: true,
        },
      ],
    });

    const childResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs?path=sigiq`);
    assert.equal(childResponse.status, 200);
    assert.deepEqual(await childResponse.json(), {
      rootPath: realRoot,
      currentPath: realSigiq,
      relativePath: "sigiq",
      parentPath: realRoot,
      selectedWorkspace: { id: "sigiq", name: "SigiQ", path: realSigiq },
      entries: [
        {
          name: "ai-tutor",
          path: realAiTutor,
          relativePath: "sigiq/ai-tutor",
          workspaceId: "dir-sigiq-ai-tutor",
          workspaceName: "SigiQ / ai-tutor",
          hasGit: true,
          isRegistered: false,
        },
      ],
    });

    const searchResponse = await fetch(`${server.baseUrl}/v1/codex/workspace-dirs?q=ai-tutor`);
    assert.equal(searchResponse.status, 200);
    assert.deepEqual((await searchResponse.json()).entries.map((entry) => entry.relativePath), ["sigiq/ai-tutor"]);
  } finally {
    await server.stop();
  }
});

async function makeCwdEchoCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "fake-codex-cwd");
  const argsPath = path.join(tmpDir, "fake-codex-cwd-args.txt");
  const promptPath = path.join(tmpDir, "fake-codex-cwd-prompt.txt");
  await fs.writeFile(
    fakeCodex,
    [
      "#!/bin/sh",
      `: > '${argsPath}'`,
      `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argsPath}'; done`,
      "out=''",
      "cdir=''",
      "prev=''",
      "for arg in \"$@\"; do",
      "  if [ \"$prev\" = '-o' ]; then out=\"$arg\"; fi",
      "  if [ \"$prev\" = '-C' ]; then cdir=\"$arg\"; fi",
      "  prev=\"$arg\"",
      "done",
      `cat > '${promptPath}'`,
      "if [ -n \"$out\" ]; then printf 'cwd=%s cdir=%s' \"$(pwd -P)\" \"$cdir\" > \"$out\"; fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return { fakeCodex, argsPath, promptPath };
}

test("scopes chat threads to workspaces with inheritance and mismatch rejection", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  const scratchDir = path.join(browseRoot, "scratch");
  const codexHome = path.join(tmpDir, "codex-home");
  const taskSessionId = "019e46c0-0000-7000-8000-000000000001";
  await fs.mkdir(vaultDir, { recursive: true });
  await fs.mkdir(scratchDir, { recursive: true });
  const azure = await startFakeAzureOpenAI();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_HOME: codexHome,
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([
      { id: "poc-vault", name: "POC Vault", path: vaultDir },
      { id: "scratch", name: "Scratch", path: scratchDir },
    ]),
    CODEX_BIN: await makeSessionWritingCodex(tmpDir, taskSessionId),
    CODEX_MODEL_CATALOG: JSON.stringify([
      { id: "gpt-4o", label: "GPT-4o (Azure)", provider: "azure", modes: ["chat"], azureDeployment: "gpt-4o" },
      { id: "codex-cli", label: "Codex CLI", provider: "codex", modes: ["task"] },
    ]),
    AZURE_OPENAI_ENDPOINT: azure.endpoint,
    AZURE_OPENAI_API_KEY: "azure-test-key",
  });
  try {
    const unknown = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        workspaceId: "not-a-workspace",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /workspaceId is not registered/);

    // A task thread in the same workspace, finished before the chat starts.
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "poc-vault", prompt: "task first", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    await waitForJob(server.baseUrl, (await create.json()).id);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const chat = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        workspaceId: "poc-vault",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    assert.equal(chat.status, 200);
    const events = await readSse(chat);
    assert.equal(events[0].event, "meta");
    assert.equal(events[0].data.workspaceId, "poc-vault");
    const chatThreadId = events[0].data.threadId;

    // Scoped listing merges task and chat threads, newest first.
    const scoped = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=poc-vault&limit=10`);
    assert.equal(scoped.status, 200);
    const scopedThreads = (await scoped.json()).threads;
    assert.deepEqual(
      scopedThreads.map((thread) => [thread.id, thread.mode]),
      [
        [chatThreadId, "chat"],
        [taskSessionId, "task"],
      ],
    );
    assert.equal(scopedThreads[0].workspaceId, "poc-vault");
    assert.equal(scopedThreads[0].workspaceName, "POC Vault");
    assert.equal(scopedThreads[0].provider, "azure");

    // Provider filters still apply inside a workspace filter.
    const azureOnly = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=poc-vault&provider=azure`);
    assert.deepEqual((await azureOnly.json()).threads.map((thread) => thread.id), [chatThreadId]);
    const codexOnly = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=poc-vault&provider=codex`);
    assert.deepEqual((await codexOnly.json()).threads.map((thread) => thread.id), [taskSessionId]);

    // Continuation may omit workspaceId and inherits the stored workspace.
    const continuation = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        threadId: chatThreadId,
        messages: [
          { role: "user", content: "say hello" },
          { role: "assistant", content: "Hello from Azure" },
          { role: "user", content: "again" },
        ],
      }),
    });
    assert.equal(continuation.status, 200);
    const continuationEvents = await readSse(continuation);
    assert.equal(continuationEvents[0].data.workspaceId, "poc-vault");

    const detail = await fetch(`${server.baseUrl}/v1/codex/threads/${chatThreadId}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.json();
    assert.equal(detailBody.thread.workspaceId, "poc-vault");
    assert.equal(detailBody.thread.workspaceName, "POC Vault");

    const scopedDetail = await fetch(
      `${server.baseUrl}/v1/codex/threads/${chatThreadId}?workspaceId=poc-vault`,
    );
    assert.equal(scopedDetail.status, 200);

    const wrongWorkspaceDetail = await fetch(
      `${server.baseUrl}/v1/codex/threads/${chatThreadId}?workspaceId=scratch`,
    );
    assert.equal(wrongWorkspaceDetail.status, 404);
    assert.match((await wrongWorkspaceDetail.json()).error, /thread not found/);

    // A conflicting workspaceId on continuation fails.
    const conflict = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        threadId: chatThreadId,
        workspaceId: "scratch",
        messages: [{ role: "user", content: "wrong workspace" }],
      }),
    });
    assert.equal(conflict.status, 400);
    assert.match((await conflict.json()).error, /does not match/i);
  } finally {
    await azure.stop();
    await server.stop();
  }
});

test("keeps legacy null-workspace chats global-only and preserves scoped deletion", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const vaultDir = path.join(browseRoot, "poc-vault");
  await fs.mkdir(vaultDir, { recursive: true });
  const azure = await startFakeAzureOpenAI();
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([{ id: "poc-vault", name: "POC Vault", path: vaultDir }]),
    CODEX_MODEL_CATALOG: JSON.stringify([
      { id: "gpt-4o", label: "GPT-4o (Azure)", provider: "azure", modes: ["chat"], azureDeployment: "gpt-4o" },
    ]),
    AZURE_OPENAI_ENDPOINT: azure.endpoint,
    AZURE_OPENAI_API_KEY: "azure-test-key",
  });
  try {
    const legacyChat = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        messages: [{ role: "user", content: "global chat" }],
      }),
    });
    const legacyThreadId = (await readSse(legacyChat))[0].data.threadId;

    const scopedChat = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "azure",
        model: "gpt-4o",
        workspaceId: "poc-vault",
        messages: [{ role: "user", content: "scoped chat" }],
      }),
    });
    const scopedThreadId = (await readSse(scopedChat))[0].data.threadId;

    const globalList = await fetch(`${server.baseUrl}/v1/codex/threads?limit=10`);
    const globalIds = (await globalList.json()).threads.map((thread) => thread.id).sort();
    assert.deepEqual(globalIds, [legacyThreadId, scopedThreadId].sort());

    const legacyEntry = (await (await fetch(`${server.baseUrl}/v1/codex/threads?limit=10`)).json()).threads.find(
      (thread) => thread.id === legacyThreadId,
    );
    assert.equal(legacyEntry.workspaceId, null);
    assert.equal(legacyEntry.workspaceName, "Chat");

    const scopedList = await fetch(`${server.baseUrl}/v1/codex/threads?workspaceId=poc-vault&limit=10`);
    assert.deepEqual((await scopedList.json()).threads.map((thread) => thread.id), [scopedThreadId]);

    // Scoped deletion cannot touch a legacy global chat.
    const scopedDeleteLegacy = await fetch(
      `${server.baseUrl}/v1/codex/threads/${legacyThreadId}?workspaceId=poc-vault`,
      { method: "DELETE" },
    );
    assert.equal(scopedDeleteLegacy.status, 404);

    // Scoped deletion removes the workspace chat and reports the workspace.
    const scopedDelete = await fetch(
      `${server.baseUrl}/v1/codex/threads/${scopedThreadId}?workspaceId=poc-vault`,
      { method: "DELETE" },
    );
    assert.equal(scopedDelete.status, 200);
    const scopedDeleteBody = await scopedDelete.json();
    assert.equal(scopedDeleteBody.deleted, true);
    assert.equal(scopedDeleteBody.workspaceId, "poc-vault");
    assert.equal(scopedDeleteBody.deletedChatThread, true);

    // Legacy chats delete through the global path, unchanged.
    const globalDelete = await fetch(`${server.baseUrl}/v1/codex/threads/${legacyThreadId}`, { method: "DELETE" });
    assert.equal(globalDelete.status, 200);
    assert.equal((await globalDelete.json()).workspaceId, null);

    const finalList = await fetch(`${server.baseUrl}/v1/codex/threads?limit=10`);
    assert.deepEqual((await finalList.json()).threads, []);
  } finally {
    await azure.stop();
    await server.stop();
  }
});

test("runs Codex chat unrestricted in the selected workspace instead of scratch", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const browseRoot = path.join(tmpDir, "workspaces");
  const scratchDir = path.join(browseRoot, "scratch");
  const projectDir = path.join(browseRoot, "project-a");
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  const { fakeCodex, argsPath, promptPath } = await makeCwdEchoCodex(tmpDir);
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACE_BROWSE_ROOT: browseRoot,
    CODEX_WORKSPACES: JSON.stringify([
      { id: "scratch", name: "Scratch", path: scratchDir },
      { id: "project-a", name: "Project A", path: projectDir },
    ]),
    CODEX_BIN: fakeCodex,
    CODEX_MODEL_CATALOG: JSON.stringify([
      { id: "codex-gpt-5.6-sol", label: "Codex · GPT-5.6 Sol", provider: "codex", modes: ["chat", "task"], taskModel: "gpt-5.6-sol" },
    ]),
    CLAUDE_AWS_PROFILE: "",
  });
  try {
    const realProject = await fs.realpath(projectDir);
    const realScratch = await fs.realpath(scratchDir);

    const scoped = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "codex",
        model: "codex-gpt-5.6-sol",
        workspaceId: "project-a",
        messages: [{ role: "user", content: "where are you" }],
      }),
    });
    assert.equal(scoped.status, 200);
    const scopedEvents = await readSse(scoped);
    const scopedDelta = scopedEvents.find((event) => event.event === "delta");
    assert.equal(scopedDelta.data.text, `cwd=${realProject} cdir=${realProject}`);
    const scopedArgs = await fs.readFile(argsPath, "utf8");
    assert.match(scopedArgs, /^--dangerously-bypass-approvals-and-sandbox$/m);
    assert.doesNotMatch(scopedArgs, /^read-only$/m);
    const scopedPrompt = await fs.readFile(promptPath, "utf8");
    assert.match(scopedPrompt, /You may inspect or modify files, run commands, and use tools when helpful/);
    assert.doesNotMatch(scopedPrompt, /do not inspect or modify files/);

    const unscoped = await fetch(`${server.baseUrl}/v1/codex/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "text/event-stream" },
      body: JSON.stringify({
        provider: "codex",
        model: "codex-gpt-5.6-sol",
        messages: [{ role: "user", content: "where are you" }],
      }),
    });
    const unscopedDelta = (await readSse(unscoped)).find((event) => event.event === "delta");
    assert.equal(unscopedDelta.data.text, `cwd=${realScratch} cdir=${realScratch}`);
    const unscopedArgs = await fs.readFile(argsPath, "utf8");
    assert.match(unscopedArgs, /^--dangerously-bypass-approvals-and-sandbox$/m);
    assert.doesNotMatch(unscopedArgs, /^read-only$/m);
  } finally {
    await server.stop();
  }
});

async function makeEnvEchoCursor(tmpDir, sessionId) {
  const fakeCursor = path.join(tmpDir, "fake-cursor-env");
  await fs.writeFile(
    fakeCursor,
    [
      "#!/bin/sh",
      "cat >/dev/null",
      `printf '{"type":"result","subtype":"success","result":"aws_profile=%s aws_access=%s aws_region=%s bedrock=%s home=%s","session_id":"${sessionId}"}' "\${AWS_PROFILE:-none}" "\${AWS_ACCESS_KEY_ID:-none}" "\${AWS_REGION:-none}" "\${CLAUDE_CODE_USE_BEDROCK:-none}" "$HOME"`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCursor;
}

async function makeMalformedCursor(tmpDir) {
  const fakeCursor = path.join(tmpDir, "fake-cursor-malformed");
  await fs.writeFile(
    fakeCursor,
    ["#!/bin/sh", "cat >/dev/null", "printf 'this is not cursor json'", "exit 0", ""].join("\n"),
    { mode: 0o755 },
  );
  return fakeCursor;
}

async function makeFailingCursor(tmpDir) {
  const fakeCursor = path.join(tmpDir, "fake-cursor-failing");
  await fs.writeFile(
    fakeCursor,
    ["#!/bin/sh", "cat >/dev/null", "printf 'cursor auth expired\\n' >&2", "exit 1", ""].join("\n"),
    { mode: 0o755 },
  );
  return fakeCursor;
}

async function makeSlowCursor(tmpDir) {
  const fakeCursor = path.join(tmpDir, "fake-cursor-slow");
  await fs.writeFile(
    fakeCursor,
    ["#!/bin/sh", "exec sleep 20", ""].join("\n"),
    { mode: 0o755 },
  );
  return fakeCursor;
}

test("resumes Cursor threads with --resume and applies provider filters", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const dataDir = path.join(tmpDir, "data");
  const sessionId = "019e46b2-0000-7000-8000-000000000001";
  await fs.mkdir(workspaceDir, { recursive: true });
  await writePersistedJob({
    dataDir,
    workspaceDir,
    id: "019e46b2-0000-7000-8000-000000000002",
    stdout: "previous cursor stdout",
    stderr: "",
    result: "previous cursor result",
    provider: "cursor",
    sessionId,
  });

  const cursor = await makeFakeCursor(tmpDir, sessionId);
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: dataDir,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_BIN: cursor.fakeCursor,
  });
  try {
    // A codex resume against the cursor thread is rejected (provider lock).
    const wrongProvider = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "codex", prompt: "wrong", resumeSessionId: sessionId }),
    });
    assert.equal(wrongProvider.status, 400);

    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        workspaceId: "scratch",
        provider: "cursor",
        prompt: "continue cursor work",
        resumeSessionId: sessionId,
        timeoutMs: 5000,
      }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();
    assert.equal(created.provider, "cursor");
    assert.equal(created.sessionId, sessionId);

    const job = await waitForJob(server.baseUrl, created.id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result, "cursor answer");

    const args = (await fs.readFile(cursor.argsPath, "utf8")).trim().split("\n");
    assert.deepEqual(args.slice(0, 7), ["-p", "--force", "--trust", "--workspace", await fs.realpath(workspaceDir), "--output-format", "json"]);
    const resumeIndex = args.indexOf("--resume");
    assert.notEqual(resumeIndex, -1);
    assert.equal(args[resumeIndex + 1], sessionId);
    assert.equal(args.at(-1), "continue cursor work");
    assert.equal(args.filter((arg) => arg === "--resume").length, 1);

    // Provider filters across jobs and threads include the cursor thread.
    const cursorJobs = await fetch(`${server.baseUrl}/v1/codex/jobs?provider=cursor&limit=20`);
    const cursorJobsBody = await cursorJobs.json();
    assert.equal(cursorJobsBody.jobs.length, 2);
    assert.ok(cursorJobsBody.jobs.every((item) => item.provider === "cursor"));

    const cursorThreads = await fetch(`${server.baseUrl}/v1/codex/threads?provider=cursor&limit=20`);
    const cursorThreadBody = await cursorThreads.json();
    assert.deepEqual(cursorThreadBody.threads.map((thread) => thread.sessionId), [sessionId]);
    assert.equal(cursorThreadBody.threads[0].provider, "cursor");
    assert.equal(cursorThreadBody.threads[0].jobCount, 2);

    const codexThreads = await fetch(`${server.baseUrl}/v1/codex/threads?provider=codex&limit=20`);
    assert.deepEqual((await codexThreads.json()).threads, []);
  } finally {
    await server.stop();
  }
});

test("scrubs ambient AWS credentials from Cursor jobs like direct Claude", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  const runHome = path.join(tmpDir, "run-home");
  const sessionId = "019e46b2-0000-7000-8000-000000000011";
  await fs.mkdir(workspaceDir, { recursive: true });
  await fs.mkdir(runHome, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_RUN_HOME: runHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_BIN: await makeEnvEchoCursor(tmpDir, sessionId),
    CLAUDE_AWS_PROFILE: "",
    AWS_PROFILE: "personal",
    AWS_ACCESS_KEY_ID: "AKIAAMBIENT",
    AWS_SECRET_ACCESS_KEY: "ambient-secret",
    AWS_REGION: "ap-south-1",
    AWS_DEFAULT_REGION: "ap-south-1",
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "cursor", prompt: "env check", timeoutMs: 5000 }),
    });
    assert.equal(create.status, 202);
    const job = await waitForJob(server.baseUrl, (await create.json()).id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result, `aws_profile=none aws_access=none aws_region=none bedrock=none home=${runHome}`);
    assert.equal(job.sessionId, sessionId);
  } finally {
    await server.stop();
  }
});

test("handles malformed Cursor JSON, nonzero exits, and cancellation", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const baseEnv = {
    CODEX_REQUIRE_MTLS: "false",
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
  };

  // Malformed JSON falls back to the raw stdout text instead of dropping output.
  const malformedServer = await startServer({
    ...baseEnv,
    CODEX_DATA_DIR: path.join(tmpDir, "data-malformed"),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_BIN: await makeMalformedCursor(tmpDir),
  });
  try {
    const create = await fetch(`${malformedServer.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "cursor", prompt: "bad json", timeoutMs: 5000 }),
    });
    const job = await waitForJob(malformedServer.baseUrl, (await create.json()).id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.result, "this is not cursor json");
    assert.equal(job.sessionId, null);
  } finally {
    await malformedServer.stop();
  }

  // Nonzero exit surfaces stderr as the failure message.
  const failingServer = await startServer({
    ...baseEnv,
    CODEX_DATA_DIR: path.join(tmpDir, "data-failing"),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_BIN: await makeFailingCursor(tmpDir),
  });
  try {
    const create = await fetch(`${failingServer.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "cursor", prompt: "fail", timeoutMs: 5000 }),
    });
    const job = await waitForJob(failingServer.baseUrl, (await create.json()).id);
    assert.equal(job.status, "failed");
    assert.match(job.error, /cursor auth expired/);
    assert.equal(job.result || "", "");
  } finally {
    await failingServer.stop();
  }

  // Cancellation terminates the running Cursor child.
  const slowServer = await startServer({
    ...baseEnv,
    CODEX_DATA_DIR: path.join(tmpDir, "data-slow"),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_BIN: await makeSlowCursor(tmpDir),
  });
  try {
    const create = await fetch(`${slowServer.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", provider: "cursor", prompt: "slow", timeoutMs: 30000 }),
    });
    const created = await create.json();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const poll = await (await fetch(`${slowServer.baseUrl}/v1/codex/jobs/${created.id}`)).json();
      if (poll.status === "running") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const cancel = await fetch(`${slowServer.baseUrl}/v1/codex/jobs/${created.id}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 202);
    const job = await waitForJob(slowServer.baseUrl, created.id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.error, "job cancelled");
  } finally {
    await slowServer.stop();
  }
});

test("lists Cursor skills only from bounded cursor skill roots", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const cursorSkillDir = path.join(tmpDir, "cursor-skills");
  const runHome = path.join(tmpDir, "run-home");
  await makeSkill(cursorSkillDir, "cursor-review", {
    description: "Use when Cursor should review a change.",
    body: "Cursor review process.",
  });
  await makeSkill(path.join(runHome, ".cursor", "skills"), "cursor-home-skill", {
    description: "Use when testing the runner-home cursor root.",
    body: "Runner home skill.",
  });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_RUN_HOME: runHome,
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: tmpDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CURSOR_SKILL_DIRS: cursorSkillDir,
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/skills?provider=cursor`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.skills.map((skill) => skill.id).sort(), ["cursor-home-skill", "cursor-review"]);
    assert.ok(body.skills.every((skill) => skill.provider === "cursor"));
    assert.ok(body.skills.every((skill) => skill.path === undefined));
  } finally {
    await server.stop();
  }
});

async function makeStagedCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "fake-codex-staged");
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
      "printf 'phase-one\\n'",
      "sleep 0.4",
      "printf 'phase-two\\n'",
      "printf 'phase-err\\n' >&2",
      "sleep 0.4",
      "printf 'phase-three\\n'",
      "if [ -n \"$out\" ]; then printf 'final answer' > \"$out\"; fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function makeQuickOutputCodex(tmpDir) {
  const fakeCodex = path.join(tmpDir, "fake-codex-quick");
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
      "printf 'hello world\\n'",
      "if [ -n \"$out\" ]; then printf 'resume done' > \"$out\"; fi",
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function makeSleepingCodex(tmpDir, seconds) {
  const fakeCodex = path.join(tmpDir, `fake-codex-sleep-${seconds}`);
  await fs.writeFile(
    fakeCodex,
    ["#!/bin/sh", `exec sleep ${seconds}`, ""].join("\n"),
    { mode: 0o755 },
  );
  return fakeCodex;
}

async function readRawSseText(response) {
  let text = "";
  for await (const chunk of response.body) {
    text += Buffer.from(chunk).toString("utf8");
  }
  return text;
}

async function waitForRunning(baseUrl, jobId) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await (await fetch(`${baseUrl}/v1/codex/jobs/${jobId}`)).json();
    if (job.status === "running") return job;
    if (["succeeded", "failed", "cancelled", "timeout"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`job ${jobId} did not start`);
}

test("streams live job output over SSE with replay, live follow, and done", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeStagedCodex(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "stream me", timeoutMs: 15000 }),
    });
    assert.equal(create.status, 202);
    const created = await create.json();

    // Give phase-one time to persist so the stream exercises replay and then
    // follows phases two/three live.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const stream = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream`);
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get("content-type") || "", /text\/event-stream/);

    const events = await readSse(stream);
    assert.ok(events.length >= 3);
    assert.equal(events[0].event, "status");
    assert.equal(events[0].data.id, created.id);
    assert.equal(events.at(-1).event, "done");
    assert.equal(events.at(-1).data.status, "succeeded");
    assert.equal(events.at(-1).data.result, "final answer");

    const stdoutEvents = events.filter((entry) => entry.event === "stdout");
    assert.equal(stdoutEvents.map((entry) => entry.data.text).join(""), "phase-one\nphase-two\nphase-three\n");
    // Byte offsets are real file offsets: each event starts where the
    // previous one ended.
    let expectedOffset = 0;
    for (const entry of stdoutEvents) {
      assert.equal(entry.data.offset, expectedOffset);
      expectedOffset += Buffer.byteLength(entry.data.text, "utf8");
    }

    const stderrEvents = events.filter((entry) => entry.event === "stderr");
    assert.equal(stderrEvents.map((entry) => entry.data.text).join(""), "phase-err\n");

    // Replay and live phases stay ordered before the terminal done event.
    assert.ok(events.findIndex((entry) => entry.event === "done") === events.length - 1);
  } finally {
    await server.stop();
  }
});

test("resumes job streams from byte offsets without duplicates and after termination", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeQuickOutputCodex(tmpDir),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "quick", timeoutMs: 5000 }),
    });
    const created = await create.json();
    await waitForJob(server.baseUrl, created.id);

    // Terminal jobs replay and close immediately.
    const full = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream`);
    assert.equal(full.status, 200);
    const fullEvents = await readSse(full);
    assert.equal(fullEvents[0].event, "status");
    assert.equal(fullEvents.at(-1).event, "done");
    const fullStdout = fullEvents.filter((entry) => entry.event === "stdout");
    assert.equal(fullStdout.length, 1);
    assert.deepEqual(fullStdout[0].data, { offset: 0, text: "hello world\n" });

    // Reconnecting from an offset replays only the missing suffix.
    const resumed = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?stdoutOffset=6`);
    const resumedEvents = await readSse(resumed);
    const resumedStdout = resumedEvents.filter((entry) => entry.event === "stdout");
    assert.equal(resumedStdout.length, 1);
    assert.deepEqual(resumedStdout[0].data, { offset: 6, text: "world\n" });

    // An offset at the end of the log produces no duplicate output at all.
    const caughtUp = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?stdoutOffset=12&stderrOffset=0`);
    const caughtUpEvents = await readSse(caughtUp);
    assert.deepEqual(caughtUpEvents.map((entry) => entry.event).filter((event) => event === "stdout"), []);
    assert.equal(caughtUpEvents.at(-1).event, "done");

    const badOffset = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream?stdoutOffset=-4`);
    assert.equal(badOffset.status, 400);

    const missing = await fetch(`${server.baseUrl}/v1/codex/jobs/019e0000-0000-7000-8000-000000000000/stream`);
    assert.equal(missing.status, 404);
  } finally {
    await server.stop();
  }
});

test("emits SSE heartbeats and caps concurrent job streams", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeSleepingCodex(tmpDir, 3),
    CODEX_JOB_STREAM_HEARTBEAT_MS: "100",
    CODEX_MAX_JOB_STREAMS: "1",
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "sleepy", timeoutMs: 15000 }),
    });
    const created = await create.json();
    await waitForRunning(server.baseUrl, created.id);

    const stream = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream`);
    assert.equal(stream.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream`);
    assert.equal(second.status, 503);
    assert.match((await second.json()).error, /concurrent job streams/i);

    const raw = await readRawSseText(stream);
    assert.match(raw, /: heartbeat/);
    assert.match(raw, /event: done/);

    // The slot frees up once the first stream is done.
    const third = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream`);
    assert.equal(third.status, 200);
    await readSse(third);
  } finally {
    await server.stop();
  }
});

test("closes job streams with a terminal cancelled status when jobs are cancelled", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });
  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeSleepingCodex(tmpDir, 20),
  });
  try {
    const create = await fetch(`${server.baseUrl}/v1/codex/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId: "scratch", prompt: "long haul", timeoutMs: 60000 }),
    });
    const created = await create.json();
    await waitForRunning(server.baseUrl, created.id);

    const stream = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/stream`);
    assert.equal(stream.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const cancel = await fetch(`${server.baseUrl}/v1/codex/jobs/${created.id}/cancel`, { method: "POST" });
    assert.equal(cancel.status, 202);

    const events = await readSse(stream);
    assert.equal(events[0].event, "status");
    assert.equal(events.at(-1).event, "done");
    assert.equal(events.at(-1).data.status, "cancelled");
    const statusEvents = events.filter((entry) => entry.event === "status");
    assert.ok(statusEvents.some((entry) => entry.data.error === "cancellation requested"));
  } finally {
    await server.stop();
  }
});

test("pipes text/event-stream responses through the dev proxy instead of buffering", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-api-test-"));
  const workspaceDir = path.join(tmpDir, "scratch");
  await fs.mkdir(workspaceDir, { recursive: true });

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" });
    res.write('event: status\ndata: {"status":"running"}\n\n');
    setTimeout(() => {
      res.write('event: done\ndata: {"status":"succeeded"}\n\n');
      res.end();
    }, 100);
  });
  const upstreamPort = await freePort();
  await new Promise((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(upstreamPort, "127.0.0.1", resolve);
  });

  const server = await startServer({
    CODEX_REQUIRE_MTLS: "false",
    CODEX_DATA_DIR: path.join(tmpDir, "data"),
    CODEX_WORKSPACES: JSON.stringify([{ id: "scratch", name: "Scratch", path: workspaceDir }]),
    CODEX_BIN: await makeFakeCodex(tmpDir),
    CODEX_PROXY_BASE_URL: `http://127.0.0.1:${upstreamPort}`,
  });
  try {
    const response = await fetch(`${server.baseUrl}/v1/codex/jobs/019e0000-0000-7000-8000-000000000001/stream`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /text\/event-stream/);
    const events = await readSse(response);
    assert.deepEqual(events.map((entry) => entry.event), ["status", "done"]);
    assert.equal(events[1].data.status, "succeeded");
  } finally {
    await server.stop();
    await new Promise((resolve) => upstream.close(resolve));
  }
});
